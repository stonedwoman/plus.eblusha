import { Router, type Request } from "express";
import { z } from "zod";
import { authenticate } from "../middlewares/auth";
import prisma from "../lib/prisma";
import { rateLimit } from "../middlewares/rateLimit";
import { getRedisClient } from "../lib/redis";
import {
  ackSecretInbox,
  enqueueSecretMessages,
  getSecretPayloads,
  pullSecretInboxIds,
  setSecretPayloadCache,
  markSecretSeen,
} from "../lib/secretInbox";
import { getIO } from "../realtime/socket";

const router = Router();
router.use(authenticate);

type AuthedRequest = Request & { user?: { id: string }; deviceId?: string };

function bufferFromBase64(b64: string): Buffer {
  // Buffer.from does not throw on invalid input; do a basic sanity check.
  const v = String(b64 ?? "").trim();
  if (!v) throw new Error("empty");
  // allow url-safe base64 variants by normalizing
  const normalized = v.replace(/-/g, "+").replace(/_/g, "/");
  const buf = Buffer.from(normalized, "base64");
  if (!buf.length) throw new Error("invalid_base64");
  return buf;
}

function base64FromBuffer(buf: Buffer): string {
  return Buffer.from(buf).toString("base64");
}

const sendSchema = z.object({
  messages: z
    .array(
      z.object({
        toDeviceId: z.string().min(1),
        msgId: z.string().uuid(),
        ciphertext: z.string().min(1),
        createdAt: z.string().datetime(),
        ttlSeconds: z.number().int().min(1).max(60 * 60 * 24 * 30).optional(),
        headerJson: z.record(z.string(), z.unknown()).optional(),
        contentType: z.enum(["text", "attachment", "ref"]).optional(),
        schemaVersion: z.number().int().min(1).max(100).optional(),
        attachment: z
          .object({
            objectKey: z.string().min(1),
            size: z.number().int().nonnegative(),
            hash: z.string().min(1),
            wrappedContentKeysByDevice: z.record(z.string(), z.string()),
          })
          .optional(),
      })
    )
    .min(1)
    .max(500),
});

async function resolveCurrentDeviceId(req: Request): Promise<string | null> {
  const r = req as AuthedRequest;
  const candidate =
    (r.deviceId?.trim() ||
      (typeof (req.headers["x-device-id"] as any) === "string" ? String(req.headers["x-device-id"]).trim() : "") ||
      (typeof (req.query as any)?.deviceId === "string" ? String((req.query as any).deviceId).trim() : "") ||
      (typeof (req.body as any)?.deviceId === "string" ? String((req.body as any).deviceId).trim() : "")) || "";
  if (!candidate) return null;
  const device = await prisma.userDevice.findUnique({
    where: { id: candidate },
    select: { id: true, userId: true, revokedAt: true },
  });
  if (!device || device.userId !== r.user?.id || device.revokedAt) return null;
  return device.id;
}

router.post("/send", rateLimit({ name: "secret_send", windowMs: 60_000, max: 300 }), async (req, res) => {
  const parsed = sendSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid secret send payload" });
    return;
  }

  const userId = (req as AuthedRequest).user!.id;
  const senderDeviceId = (req as AuthedRequest).deviceId?.trim() || null;
  const redis = await getRedisClient();

  // Durable store first (Postgres), then Redis inbox/cache as accelerator.
  const prepared = parsed.data.messages.map((msg) => ({
    toDeviceId: msg.toDeviceId.trim(),
    msgId: msg.msgId,
    createdAt: new Date(msg.createdAt),
    ciphertextBuf: bufferFromBase64(msg.ciphertext),
    ttlSeconds: msg.ttlSeconds,
    expiresAt: new Date(Date.now() + ((msg.ttlSeconds ?? 3600) * 1000)).toISOString(),
    headerJson: msg.headerJson ?? { kind: "direct", v: 1 },
    contentType: msg.contentType ?? "ref",
    schemaVersion: msg.schemaVersion ?? 1,
    attachment: msg.attachment,
  }));

  await prisma.$transaction(async (tx) => {
    for (const m of prepared) {
      try {
        await tx.secretMessage.create({
          data: {
            msgId: m.msgId,
            threadId: null,
            senderUserId: userId,
            senderDeviceId,
            createdAt: m.createdAt,
            headerJson: {
              ...(m.headerJson ?? {}),
              ...(m.attachment ? { attachment: m.attachment } : {}),
              expiresAt: m.expiresAt,
            },
            ciphertextBlob: m.ciphertextBuf,
            contentType: m.contentType,
            schemaVersion: m.schemaVersion,
            deliveries: {
              create: {
                receiverDeviceId: m.toDeviceId,
                status: "PENDING",
              },
            },
          } as any,
        });
      } catch (err: any) {
        // idempotent retries
        if (err && typeof err === "object" && String((err as any).code) === "P2002") {
          continue;
        }
        throw err;
      }
    }
  });

  const results = await enqueueSecretMessages(
    redis,
    prepared.map((m) => ({
      toDeviceId: m.toDeviceId,
      msgId: m.msgId,
      ...(m.ttlSeconds !== undefined ? { ttlSeconds: m.ttlSeconds } : {}),
      payload: {
        msgId: m.msgId,
        threadId: null,
        senderUserId: userId,
        senderDeviceId,
        createdAt: m.createdAt.toISOString(),
        headerJson: {
          ...(m.headerJson ?? {}),
          ...(m.attachment ? { attachment: m.attachment } : {}),
          expiresAt: m.expiresAt,
        },
        ciphertext: base64FromBuffer(m.ciphertextBuf),
        contentType: m.contentType,
        schemaVersion: m.schemaVersion,
        ...(m.attachment ? { attachment: m.attachment } : {}),
        expiresAt: m.expiresAt,
      },
    }))
  );

  const io = getIO();
  for (const result of results) {
    if (!result.inserted) continue;
    io?.to(`device:${result.toDeviceId}`).emit("secret:notify", {
      toDeviceId: result.toDeviceId,
      msgId: result.msgId,
    });
  }

  res.json({
    delivery: "at-least-once",
    results,
  });
});

const pullSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  deviceId: z.string().min(1).optional(),
});

async function handleInboxPull(req: Request, res: any, raw: unknown) {
  const currentDeviceId = await resolveCurrentDeviceId(req);
  if (!currentDeviceId) {
    res.status(400).json({ message: "Current device is required (token did claim)" });
    return;
  }
  const parsed = pullSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid pull payload" });
    return;
  }
  const requested = parsed.data.deviceId?.trim();
  if (requested && requested !== currentDeviceId) {
    res.status(403).json({ message: "Forbidden" });
    return;
  }

  const redis = await getRedisClient();
  const msgIds = await pullSecretInboxIds(redis, currentDeviceId, parsed.data.limit);
  if (msgIds.length === 0) {
    res.json({ deviceId: currentDeviceId, delivery: "at-least-once", messages: [] });
    return;
  }

  // Preserve inbox order but remove duplicates in a single pull response.
  const uniqueIds = Array.from(new Set(msgIds));

  const cached = await getSecretPayloads(redis, uniqueIds);
  const missingIds: string[] = [];
  for (let i = 0; i < uniqueIds.length; i += 1) {
    if (!cached[i]) missingIds.push(uniqueIds[i]!);
  }

  const fromDb =
    missingIds.length === 0
      ? []
      : await prisma.secretDelivery.findMany({
          where: {
            receiverDeviceId: currentDeviceId,
            msgId: { in: missingIds },
          },
          include: { message: true },
        });

  const byMsgId = new Map<string, any>();
  for (const d of fromDb as any[]) {
    const m = d.message;
    const expiresAt =
      m?.headerJson && typeof (m.headerJson as any).expiresAt === "string"
        ? String((m.headerJson as any).expiresAt)
        : null;
    byMsgId.set(d.msgId, {
      msgId: m.msgId,
      threadId: m.threadId,
      senderUserId: m.senderUserId,
      senderDeviceId: m.senderDeviceId,
      createdAt: m.createdAt.toISOString(),
      headerJson: m.headerJson,
      ciphertext: base64FromBuffer(m.ciphertextBlob as Buffer),
      contentType: m.contentType,
      schemaVersion: m.schemaVersion,
      ...(expiresAt ? { expiresAt } : {}),
    });
  }

  const out: any[] = [];
  for (let i = 0; i < uniqueIds.length; i += 1) {
    const id = uniqueIds[i]!;
    const payload = (cached[i] as any) ?? byMsgId.get(id) ?? null;
    if (!payload) continue;
    out.push(payload);
    // Best-effort cache repopulation for DB-sourced payloads.
    if (!cached[i]) {
      void setSecretPayloadCache(redis, id, payload).catch(() => {});
    }
  }

  res.json({
    deviceId: currentDeviceId,
    delivery: "at-least-once",
    messages: out,
  });
}

router.post("/inbox/pull", async (req, res) => {
  await handleInboxPull(req, res, req.body ?? {});
});

router.get("/inbox/pull", async (req, res) => {
  await handleInboxPull(req, res, req.query ?? {});
});

const ackSchema = z.object({
  msgIds: z.array(z.string().uuid()).min(1).max(500),
});

router.post("/inbox/ack", async (req, res) => {
  const currentDeviceId = await resolveCurrentDeviceId(req);
  if (!currentDeviceId) {
    res.status(400).json({ message: "Current device is required (token did claim)" });
    return;
  }
  const parsed = ackSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid ack payload" });
    return;
  }
  const redis = await getRedisClient();
  const acked = await ackSecretInbox(redis, currentDeviceId, parsed.data.msgIds);
  // Optional anti-replay marker (best-effort). This MUST NOT gate delivery.
  void markSecretSeen(redis, currentDeviceId, parsed.data.msgIds).catch(() => {});

  // Mark deliveries as DELIVERED (idempotent).
  try {
    const now = new Date();
    await prisma.secretDelivery.updateMany({
      where: {
        receiverDeviceId: currentDeviceId,
        msgId: { in: parsed.data.msgIds },
        status: "PENDING",
      },
      data: { status: "DELIVERED", deliveredAt: now },
    });
  } catch {}
  // Idempotent ack: re-ack of already removed msgId is a no-op (removedFromListCount can be 0).
  res.json({ deviceId: currentDeviceId, acked });
});

// POST /secret/messages/push: durable E2EE ciphertext for a SECRET thread + per-device fanout.
const pushSchema = z.object({
  threadId: z.string().min(1),
  msgId: z.string().uuid(),
  createdAt: z.string().datetime(),
  headerJson: z.record(z.string(), z.unknown()).default({}),
  ciphertext: z.string().min(1),
  contentType: z.enum(["text", "attachment", "ref"]).default("text"),
  schemaVersion: z.number().int().min(1).max(100).default(1),
  receiverDeviceIds: z.array(z.string().min(1)).min(1).max(500),
});

router.post("/messages/push", rateLimit({ name: "secret_messages_push", windowMs: 60_000, max: 300 }), async (req, res) => {
  const userId = (req as AuthedRequest).user!.id;
  const senderDeviceId = (req as AuthedRequest).deviceId?.trim() || null;
  const parsed = pushSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid push payload" });
    return;
  }
  const threadId = parsed.data.threadId.trim();
  const membership = await prisma.conversationParticipant.findFirst({
    where: { conversationId: threadId, userId },
  });
  if (!membership) {
    res.status(403).json({ message: "Forbidden" });
    return;
  }
  const conv = await prisma.conversation.findUnique({
    where: { id: threadId },
    select: { id: true, type: true, isSecret: true, secretStatus: true },
  });
  if (!conv || (conv as any).type !== "SECRET") {
    res.status(409).json({ message: "Thread is not SECRET" });
    return;
  }

  const createdAt = new Date(parsed.data.createdAt);
  const ciphertextBuf = bufferFromBase64(parsed.data.ciphertext);
  const receiverIds = Array.from(new Set(parsed.data.receiverDeviceIds.map((d) => d.trim()).filter(Boolean))).slice(0, 500);

  // Validate receiver devices belong to participants (defense-in-depth).
  const participants = await prisma.conversationParticipant.findMany({
    where: { conversationId: threadId },
    select: { userId: true },
  });
  const participantUserIds = participants.map((p) => p.userId);
  const devices = await prisma.userDevice.findMany({
    where: {
      id: { in: receiverIds },
      revokedAt: null,
      userId: { in: participantUserIds },
    },
    select: { id: true },
  });
  const allowedReceiverIds = devices.map((d) => d.id);
  if (allowedReceiverIds.length === 0) {
    res.status(400).json({ message: "No valid receiver devices" });
    return;
  }

  // Insert durable message + per-device deliveries (idempotent on msgId).
  let inserted = false;
  try {
    await prisma.secretMessage.create({
      data: {
        msgId: parsed.data.msgId,
        threadId,
        senderUserId: userId,
        senderDeviceId,
        createdAt,
        headerJson: parsed.data.headerJson,
        ciphertextBlob: ciphertextBuf,
        contentType: parsed.data.contentType,
        schemaVersion: parsed.data.schemaVersion,
      } as any,
    });
    inserted = true;
  } catch (err: any) {
    // If msgId already exists, treat as idempotent re-push.
    if (!(err && typeof err === "object" && String((err as any).code) === "P2002")) {
      throw err;
    }
  }

  // Update thread ordering metadata (best-effort; do not gate delivery).
  try {
    await prisma.conversation.update({
      where: { id: threadId },
      data: { lastMessageAt: createdAt },
    });
  } catch {}

  await prisma.secretDelivery.createMany({
    data: allowedReceiverIds.map((receiverDeviceId) => ({
      msgId: parsed.data.msgId,
      receiverDeviceId,
      status: "PENDING",
    })),
    skipDuplicates: true,
  });

  const redis = await getRedisClient();
  const payload = {
    msgId: parsed.data.msgId,
    threadId,
    senderUserId: userId,
    senderDeviceId,
    createdAt: createdAt.toISOString(),
    headerJson: parsed.data.headerJson,
    ciphertext: base64FromBuffer(ciphertextBuf),
    contentType: parsed.data.contentType,
    schemaVersion: parsed.data.schemaVersion,
  };

  const results = await enqueueSecretMessages(
    redis,
    allowedReceiverIds.map((toDeviceId) => ({
      toDeviceId,
      msgId: parsed.data.msgId,
      payload,
    }))
  );

  const io = getIO();
  for (const r of results) {
    if (!r.inserted) continue;
    io?.to(`device:${r.toDeviceId}`).emit("secret:notify", { toDeviceId: r.toDeviceId, msgId: r.msgId });
  }

  res.status(inserted ? 201 : 200).json({ msgId: parsed.data.msgId, deliveries: results });
});

// GET /secret/history?threadId=...&cursor=...&limit=...
router.get("/history", async (req, res) => {
  const userId = (req as AuthedRequest).user!.id;
  const schema = z.object({
    threadId: z.string().min(1),
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  });
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid query" });
    return;
  }
  const { threadId, cursor, limit } = parsed.data;
  const membership = await prisma.conversationParticipant.findFirst({
    where: { conversationId: threadId, userId },
  });
  if (!membership) {
    res.status(403).json({ message: "Forbidden" });
    return;
  }
  const conv = await prisma.conversation.findUnique({ where: { id: threadId }, select: { type: true } });
  if (!conv || (conv as any).type !== "SECRET") {
    res.status(409).json({ message: "Thread is not SECRET" });
    return;
  }

  // Cursor format: `${createdAtIso}|${msgId}`
  const cursorParsed = (() => {
    if (!cursor) return null;
    const [ts, id] = cursor.split("|");
    if (!ts || !id) return null;
    const t = new Date(ts);
    if (Number.isNaN(t.getTime())) return null;
    return { createdAt: t, msgId: id };
  })();

  const where: any = { threadId };
  if (cursorParsed) {
    where.OR = [
      { createdAt: { lt: cursorParsed.createdAt } },
      { createdAt: cursorParsed.createdAt, msgId: { lt: cursorParsed.msgId } },
    ];
  }

  const rows = await prisma.secretMessage.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { msgId: "desc" }],
    take: limit + 1,
  });
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items.at(-1);
  const nextCursor = hasMore && last ? `${last.createdAt.toISOString()}|${last.msgId}` : null;

  res.json({
    threadId,
    items: items.map((m: any) => ({
      msgId: m.msgId,
      threadId: m.threadId,
      senderUserId: m.senderUserId,
      senderDeviceId: m.senderDeviceId,
      createdAt: m.createdAt.toISOString(),
      headerJson: m.headerJson,
      ciphertext: base64FromBuffer(m.ciphertextBlob as Buffer),
      contentType: m.contentType,
      schemaVersion: m.schemaVersion,
    })),
    hasMore,
    nextCursor,
  });
});

export default router;
