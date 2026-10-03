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
import { deleteS3ObjectsByKeys } from "../lib/storageDeletion";
import { resolveCurrentDeviceId } from "../lib/currentDevice";
import { enqueuePush } from "../jobs/queue";
import logger from "../config/logger";
import {
  SECRET_HEADER_INVALID_CODE,
  headerKindForLog,
  isValidSecretHeader,
  secretHeaderEnforced,
  secretHeaderProblems,
} from "../lib/secretHeader";
import { addObs, bumpSecretObs, obsKind } from "../lib/secretObserve";
import {
  SECRET_SEND_REJECTED_CODE,
  evaluateSecretSend,
  secretSendEnforced,
  type SecretSendVerdict,
} from "../lib/secretSendGuard";
import {
  getUploadOwners,
  normalizeObjectKey,
  ownerAllows,
  ownerDecision,
  secretAttachOwnerEnforced,
  secretAttachOwnerStrict,
  type OwnerDecision,
} from "../lib/uploadOwners";

const router = Router();
router.use(authenticate);

type AuthedRequest = Request & {
  user?: { id: string; username?: string; displayName?: string | null };
  deviceId?: string;
};

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

/**
 * S2 на ВХОДЕ: проверка формы заголовков (lib/secretHeader). Возвращает true, если запрос
 * надо отбить 400 (жёсткий режим и есть нарушения). В режиме SECRET_HEADER_ENFORCE=0 только
 * пишет в лог `secret-header-invalid` (счётчик по kind и имена полей, без значений).
 */
function rejectInvalidSecretHeaders(
  res: any,
  route: string,
  userId: string,
  headers: unknown[],
  obsRoute: "send" | "push",
): boolean {
  const invalid: Array<{ index: number; kind: string; problems: string[] }> = [];
  headers.forEach((h, index) => {
    const problems = secretHeaderProblems(h);
    if (problems.length) invalid.push({ index, kind: headerKindForLog(h), problems });
  });
  if (invalid.length === 0) return false;
  const enforce = secretHeaderEnforced();
  const byKind: Record<string, number> = {};
  for (const it of invalid) byKind[it.kind] = (byKind[it.kind] ?? 0) + 1;
  logger.warn(
    {
      route,
      userId,
      enforce,
      invalidCount: invalid.length,
      total: headers.length,
      byKind,
      problems: Array.from(new Set(invalid.flatMap((it) => it.problems))),
    },
    "secret-header-invalid"
  );
  void bumpSecretObs({ [`s2.invalid.${obsRoute}.${enforce ? "enforce" : "log"}`]: invalid.length });
  if (!enforce) return false;
  res.status(400).json({
    message: "Invalid secret headerJson",
    code: SECRET_HEADER_INVALID_CODE,
    invalid: invalid.slice(0, 20).map((it) => ({ index: it.index, problems: it.problems })),
  });
  return true;
}

/**
 * S2 на ВЫДАЧЕ: лог о записях неверной формы в pull/history.
 * `hidden` — правило включено, запись не отдана (`secret-header-hidden`);
 * `served` — аварийный режим SECRET_HEADER_ENFORCE=0, запись отдана как до волны 1
 * (`secret-header-invalid-served`). Правило одно на входе и на выдаче — см. secretHeaderEnforced.
 */
function logInvalidSecretRows(
  route: string,
  where: Record<string, string>,
  rows: Array<{ msgId: string; headerJson: unknown }>,
  action: "hidden" | "served",
) {
  if (!rows.length) return;
  const byKind: Record<string, number> = {};
  for (const r of rows) {
    const k = headerKindForLog(r.headerJson);
    byKind[k] = (byKind[k] ?? 0) + 1;
  }
  logger.warn(
    { route, ...where, [action]: rows.length, byKind },
    action === "hidden" ? "secret-header-hidden" : "secret-header-invalid-served"
  );
  void bumpSecretObs({ [`s2.${action}.${route === "history" ? "history" : "pull"}`]: rows.length });
}

/**
 * S3: лог и счётчики по вердиктам пачки /secret/send. Ничего не решает — решение (отбросить или
 * принять) принимает маршрут по режиму `SECRET_SEND_ENFORCE`.
 */
function reportSecretSendVerdicts(
  userId: string,
  senderDeviceId: string | null,
  verdicts: SecretSendVerdict[],
  enforce: boolean,
) {
  const counts: Record<string, number> = {};
  const byReason: Record<string, number> = {};
  const byKind: Record<string, number> = {};
  const legacyByKind: Record<string, number> = {};
  const legacyByRelation: Record<string, number> = {};
  for (const v of verdicts) {
    const kind = obsKind(v.kind);
    addObs(counts, `s3.checked.${kind}`);
    if (v.reason) {
      addObs(counts, `s3.${enforce ? "rejected" : "would_reject"}.${v.reason}.${kind}`);
      byReason[v.reason] = (byReason[v.reason] ?? 0) + 1;
      byKind[kind] = (byKind[kind] ?? 0) + 1;
    }
    if (v.legacyNoThreadId) {
      const rel = v.legacyRelation ?? "stranger";
      addObs(counts, `s3.legacy_no_threadid.${kind}.${rel}`);
      legacyByKind[kind] = (legacyByKind[kind] ?? 0) + 1;
      legacyByRelation[rel] = (legacyByRelation[rel] ?? 0) + 1;
    }
  }
  const rejected = verdicts.filter((v) => v.reason).length;
  if (rejected) {
    logger.warn(
      { userId, senderDeviceId, enforce, total: verdicts.length, rejected, byReason, byKind },
      "secret-send-reject"
    );
  }
  const legacy = verdicts.filter((v) => v.legacyNoThreadId).length;
  if (legacy) {
    logger.warn(
      { userId, senderDeviceId, total: verdicts.length, legacy, byKind: legacyByKind, byRelation: legacyByRelation },
      "secret-send-legacy-no-threadid"
    );
  }
  void bumpSecretObs(counts);
}

/** S7: лог и счётчик решения по загрузчику секретного вложения. */
function reportAttachOwner(
  route: "ref" | "push" | "delete",
  userId: string,
  threadId: string,
  decisions: OwnerDecision[],
) {
  const counts: Record<string, number> = {};
  const enforce = secretAttachOwnerEnforced();
  const strict = secretAttachOwnerStrict();
  let foreign = 0;
  let noRecord = 0;
  for (const d of decisions) {
    if (d === "other_owner") {
      foreign += 1;
      addObs(counts, `s7.${route}.${enforce ? "rejected" : "would_reject"}.other_owner`);
    } else if (d === "no_record") {
      noRecord += 1;
      addObs(counts, `s7.${route}.${strict ? "rejected" : "allowed"}.no_owner`);
    } else {
      addObs(counts, `s7.${route}.owner`);
    }
  }
  if (foreign) {
    logger.warn({ route, userId, threadId, foreign, enforce }, "secret-attach-foreign-object");
  }
  if (noRecord) {
    logger.warn({ route, userId, threadId, noRecord, strict }, "secret-attach-no-owner-record");
  }
  void bumpSecretObs(counts);
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
  const prepared = parsed.data.messages.map((msg) => {
    const expiresAt = new Date(Date.now() + ((msg.ttlSeconds ?? 3600) * 1000)).toISOString();
    const headerJson = msg.headerJson ?? { kind: "direct", v: 1 };
    return {
      toDeviceId: msg.toDeviceId.trim(),
      msgId: msg.msgId,
      createdAt: new Date(msg.createdAt),
      ciphertextBuf: bufferFromBase64(msg.ciphertext),
      ttlSeconds: msg.ttlSeconds,
      expiresAt,
      // Ровно то, что ляжет в messages_secret и в Redis-кэш и уйдёт получателю.
      storedHeader: {
        ...(headerJson ?? {}),
        ...(msg.attachment ? { attachment: msg.attachment } : {}),
        expiresAt,
      } as Record<string, unknown>,
      contentType: msg.contentType ?? "ref",
      schemaVersion: msg.schemaVersion ?? 1,
      attachment: msg.attachment,
    };
  });

  // S2: заголовок неверной формы навсегда клинит инбокс строгих клиентов (Android/iOS) —
  // такой пакет не принимаем целиком (до записи в БД, без частичного приёма).
  if (rejectInvalidSecretHeaders(res, "POST /secret/send", userId, prepared.map((m) => m.storedHeader), "send")) return;

  // S3: отправитель и получатель конверта связаны (см. lib/secretSendGuard). По умолчанию —
  // лог-режим: нарушение только пишется в лог и счётчики, конверт принимается как раньше.
  const enforceSend = secretSendEnforced();
  const verdicts = await evaluateSecretSend(
    userId,
    prepared.map((m) => ({ toDeviceId: m.toDeviceId, header: m.storedHeader }))
  );
  reportSecretSendVerdicts(userId, senderDeviceId, verdicts, enforceSend);
  const accepted = enforceSend ? prepared.filter((_, i) => !verdicts[i]!.reason) : prepared;
  const rejectedResults = enforceSend
    ? prepared
        .map((m, i) => ({ m, v: verdicts[i]! }))
        .filter(({ v }) => !!v.reason)
        .map(({ m, v }) => ({ toDeviceId: m.toDeviceId, msgId: m.msgId, inserted: false, rejected: true, reason: v.reason }))
    : [];
  // Жёсткий режим отвечает 200 и при частичном, и при полном отказе: статус /send у клиентов
  // прежний (на 4xx Android/iOS уходят в перерегистрацию устройства), а отброшенные конверты
  // помечены в results `rejected:true` + `reason` (+ code в ответе).

  await prisma.$transaction(async (tx) => {
    for (const m of accepted) {
      try {
        await tx.secretMessage.create({
          data: {
            msgId: m.msgId,
            threadId: null,
            senderUserId: userId,
            senderDeviceId,
            createdAt: m.createdAt,
            headerJson: m.storedHeader as any,
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
    accepted.map((m) => ({
      toDeviceId: m.toDeviceId,
      msgId: m.msgId,
      ...(m.ttlSeconds !== undefined ? { ttlSeconds: m.ttlSeconds } : {}),
      payload: {
        msgId: m.msgId,
        threadId: null,
        senderUserId: userId,
        senderDeviceId,
        createdAt: m.createdAt.toISOString(),
        headerJson: m.storedHeader,
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
    // No `inserted` gate: retries must re-wake the device (the pull is idempotent).
    io?.to(`device:${result.toDeviceId}`).emit("secret:notify", {
      toDeviceId: result.toDeviceId,
      msgId: result.msgId,
    });
  }

  res.json({
    delivery: "at-least-once",
    results: [...results, ...rejectedResults],
    ...(rejectedResults.length ? { code: SECRET_SEND_REJECTED_CODE, rejected: rejectedResults.length } : {}),
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
  const deadIds: string[] = [];
  const enforceHeaders = secretHeaderEnforced();
  const invalidRows: Array<{ msgId: string; headerJson: unknown }> = [];
  for (let i = 0; i < uniqueIds.length; i += 1) {
    const id = uniqueIds[i]!;
    const payload = (cached[i] as any) ?? byMsgId.get(id) ?? null;
    if (!payload) {
      // Unresolvable: payload cache expired AND no delivery row — it can never be served.
      // Left in place it clogs the head of the inbox list until fresh messages fall outside
      // the pull window (head-of-line blocking) — drop it server-side.
      deadIds.push(id);
      continue;
    }
    if (!isValidSecretHeader(payload.headerJson)) {
      invalidRows.push({ msgId: id, headerJson: payload.headerJson });
      if (enforceHeaders) {
        // S2 (H12): Android/iOS разбирают пачку одним массивом — один кривой заголовок роняет
        // всю пачку, ack невозможен, инбокс клинит навсегда. Такую запись не отдаём и снимаем
        // с инбокса этого устройства (строгим клиентам её всё равно не разобрать).
        deadIds.push(id);
        continue;
      }
      // Аварийный режим SECRET_HEADER_ENFORCE=0: вход такую запись принял (201) — значит
      // отдаём, как до волны 1. Иначе она пропала бы молча у ВСЕХ получателей.
    }
    out.push(payload);
    // Best-effort cache repopulation for DB-sourced payloads.
    if (!cached[i]) {
      void setSecretPayloadCache(redis, id, payload).catch(() => {});
    }
  }

  if (deadIds.length > 0) {
    void ackSecretInbox(redis, currentDeviceId, deadIds).catch(() => {});
  }
  logInvalidSecretRows("inbox/pull", { deviceId: currentDeviceId }, invalidRows, enforceHeaders ? "hidden" : "served");

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
  // S2: заголовок без kind (zod-дефолт `{}`) или с неверными типами клинит историю
  // Android/iOS навсегда — не принимаем.
  if (rejectInvalidSecretHeaders(res, "POST /secret/messages/push", userId, [parsed.data.headerJson], "push")) return;
  // S8 (X10): в закрытый тред сообщение по-прежнему принимаем (идемпотентность клиентов), но
  // не будим собеседника — ни secret:notify, ни пуш «Секретное сообщение». PENDING будим как раньше.
  const threadCancelled = (conv as any).secretStatus === "CANCELLED";

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
  if (!threadCancelled) {
    for (const r of results) {
      // No `inserted` gate: a sender retry after a lost HTTP response must still wake the
      // device — the notify only triggers an idempotent inbox pull.
      io?.to(`device:${r.toDeviceId}`).emit("secret:notify", { toDeviceId: r.toDeviceId, msgId: r.msgId });
    }
    // User-room fallback wake: a socket that missed its device-room join (connected before
    // device bootstrap or a token without the did claim) would otherwise learn about the
    // message only from the recipient's slow history poll. No ciphertext in the payload.
    for (const uid of participantUserIds) {
      io?.to(`user:${uid}`).emit("secret:notify", { msgId: parsed.data.msgId, threadId } as any);
    }
  }
  // Alert-пуш на выгруженные телефоны: secret:notify выше доходит только до живого сокета.
  // Ни текста, ни шифртекста в пуше нет — лишь «кто» и «в какой беседе»; за содержимым
  // клиент сходит сам (secret: true). POST /send (конверты ключей) пуша не ставит.
  // S8: в CANCELLED-тред не пушим (иначе это спам «Секретное сообщение» в закрытый чат).
  if (!threadCancelled) {
    try {
      const me = (req as AuthedRequest).user;
      let senderName = me?.displayName ?? me?.username ?? "";
      if (!senderName) {
        const sender = await prisma.user.findUnique({
          where: { id: userId },
          select: { displayName: true, username: true },
        });
        senderName = sender?.displayName ?? sender?.username ?? "пользователь";
      }
      enqueuePush(
        participantUserIds.filter((uid) => uid !== userId),
        {
          kind: "message",
          conversationId: threadId,
          messageId: parsed.data.msgId,
          senderId: userId,
          senderName,
          preview: "",
          secret: true,
        },
        `secret-${parsed.data.msgId}`,
      );
    } catch (error) {
      logger.warn({ error, threadId, msgId: parsed.data.msgId }, "secret: failed to enqueue push");
    }
  }

  // Best-effort: if message is an attachment reference, persist metadata-only ref for GC/delete workflows.
  // S7 (X1): реф заводится только на объект, загруженный самим отправителем (или без записи о
  // загрузчике — переходный режим). Сообщение доставлено в любом случае: это шифротекст, а реф —
  // лишь метаданные для GC/удаления, и через него чужой объект больше не «присвоить».
  try {
    const header = parsed.data.headerJson as any;
    const objectKey = normalizeObjectKey(String(header?.attachment?.objectKey ?? ""));
    const expiresAtRaw = typeof header?.expiresAt === "string" ? String(header.expiresAt).trim() : "";
    const expiresAt = expiresAtRaw ? new Date(expiresAtRaw) : null;
    const expiresValid = !!(expiresAt && !Number.isNaN(expiresAt.getTime()));
    const decision =
      parsed.data.contentType === "attachment" && objectKey
        ? ownerDecision(await getUploadOwners([objectKey]), objectKey, userId)
        : null;
    if (decision) reportAttachOwner("push", userId, threadId, [decision]);
    if (decision && ownerAllows(decision)) {
      await prisma.secretAttachmentRef.upsert({
        where: { threadId_objectKey: { threadId, objectKey } } as any,
        // ownerUserId НЕ перезаписываем: раньше повторная регистрация чужого ключа делала
        // регистрирующего «владельцем» рефа (правка скептика Б7).
        update: {
          deletedAt: null,
          ...(expiresValid ? { expiresAt } : {}),
        },
        create: {
          threadId,
          objectKey,
          ownerUserId: userId,
          ...(expiresValid ? { expiresAt } : {}),
        },
      });
    }
  } catch {
    // never break delivery path on metadata upsert
  }

  res.status(inserted ? 201 : 200).json({ msgId: parsed.data.msgId, deliveries: results });
});

const attachmentRefSchema = z.object({
  threadId: z.string().min(1),
  objectKey: z.string().min(1),
  expiresAt: z.string().datetime().optional(),
});

router.post(
  "/attachments/ref",
  rateLimit({ name: "secret_attachment_ref", windowMs: 60_000, max: 120 }),
  async (req, res) => {
    const userId = (req as AuthedRequest).user!.id;
    const parsed = attachmentRefSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: "Invalid attachment ref payload" });
      return;
    }
    const threadId = parsed.data.threadId.trim();
    const objectKey = normalizeObjectKey(parsed.data.objectKey);
    if (!objectKey) {
      res.status(400).json({ message: "Invalid attachment ref payload" });
      return;
    }
    const membership = await prisma.conversationParticipant.findFirst({
      where: { conversationId: threadId, userId },
      select: { conversationId: true },
    });
    if (!membership) {
      res.status(403).json({ message: "Forbidden" });
      return;
    }
    const conv = await prisma.conversation.findUnique({
      where: { id: threadId },
      select: { id: true, type: true },
    });
    if (!conv || (conv as any).type !== "SECRET") {
      res.status(409).json({ message: "Thread is not SECRET" });
      return;
    }
    // S7 (X1): регистрировать объект как секретное вложение может только загрузивший.
    const decision = ownerDecision(await getUploadOwners([objectKey]), objectKey, userId);
    reportAttachOwner("ref", userId, threadId, [decision]);
    if (!ownerAllows(decision)) {
      res.status(403).json({ message: "Only the uploader may register this object", code: "SECRET_ATTACHMENT_NOT_OWNER" });
      return;
    }
    const expiresAt = parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null;
    await prisma.secretAttachmentRef.upsert({
      where: { threadId_objectKey: { threadId, objectKey } } as any,
      // ownerUserId НЕ перезаписываем (Б7): «владелец рефа» — кто зарегистрировал первым.
      update: {
        deletedAt: null,
        ...(expiresAt ? { expiresAt } : {}),
      },
      create: {
        threadId,
        objectKey,
        ownerUserId: userId,
        ...(expiresAt ? { expiresAt } : {}),
      },
    });
    res.status(201).json({ ok: true, threadId, objectKey });
  }
);

const attachmentDeleteSchema = z
  .object({
    threadId: z.string().min(1),
    objectKeys: z.array(z.string().min(1)).max(500).optional(),
    deleteAllThread: z.boolean().optional(),
  })
  .refine((v) => !!v.deleteAllThread || !!(v.objectKeys && v.objectKeys.length > 0), {
    message: "Either objectKeys or deleteAllThread is required",
    path: ["objectKeys"],
  });

router.post(
  "/attachments/delete",
  rateLimit({ name: "secret_attachment_delete", windowMs: 60_000, max: 60 }),
  async (req, res) => {
    const userId = (req as AuthedRequest).user!.id;
    const parsed = attachmentDeleteSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: "Invalid attachment delete payload" });
      return;
    }
    const threadId = parsed.data.threadId.trim();
    const membership = await prisma.conversationParticipant.findFirst({
      where: { conversationId: threadId, userId },
      select: { conversationId: true },
    });
    if (!membership) {
      res.status(403).json({ message: "Forbidden" });
      return;
    }
    const conv = await prisma.conversation.findUnique({
      where: { id: threadId },
      select: { id: true, type: true },
    });
    if (!conv || (conv as any).type !== "SECRET") {
      res.status(409).json({ message: "Thread is not SECRET" });
      return;
    }

    const objectKeys = (parsed.data.objectKeys ?? [])
      .map((k) => normalizeObjectKey(String(k)))
      .filter(Boolean);
    const found = await prisma.secretAttachmentRef.findMany({
      where: {
        threadId,
        deletedAt: null,
        ...(parsed.data.deleteAllThread ? {} : { objectKey: { in: objectKeys } }),
      },
      select: { id: true, objectKey: true },
      take: 1000,
    });
    // S7 (X1): удалить объект может только загрузивший (решение владельца). Чужие объекты
    // (в том числе загрузки собеседника по deleteAllThread) пропускаем, а не роняем запрос.
    const owners = await getUploadOwners(found.map((r) => r.objectKey));
    const decisions = found.map((r) => ownerDecision(owners, r.objectKey, userId));
    if (decisions.length) reportAttachOwner("delete", userId, threadId, decisions);
    const refs = found.filter((_, i) => ownerAllows(decisions[i]!));
    const skippedNotOwner = found.length - refs.length;
    const now = new Date();
    if (refs.length) {
      await prisma.secretAttachmentRef.updateMany({
        where: { id: { in: refs.map((r) => r.id) } },
        data: { deletedAt: now },
      });
    }
    // Объект, на который ещё ссылается живой реф ДРУГОГО треда, не трогаем (как в S6).
    const refKeys = Array.from(new Set(refs.map((r) => r.objectKey)));
    const stillUsed = refKeys.length
      ? new Set(
          (
            await prisma.secretAttachmentRef.findMany({
              where: { objectKey: { in: refKeys }, deletedAt: null },
              select: { objectKey: true },
            })
          ).map((r) => r.objectKey)
        )
      : new Set<string>();
    const keys = refKeys.filter((k) => !stillUsed.has(k));
    const delResult = keys.length
      ? await deleteS3ObjectsByKeys(keys, { reason: "secret_attachment_delete" })
      : { ok: true, deleted: 0 };
    res.json({
      ok: true,
      threadId,
      affectedRefs: refs.length,
      ...(skippedNotOwner ? { skippedNotOwner } : {}),
      storage: delResult,
    });
  }
);

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
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  // Курсор — по СЫРОЙ странице: скрытые строки не должны сбивать пагинацию.
  const last = pageRows.at(-1);
  const nextCursor = hasMore && last ? `${last.createdAt.toISOString()}|${last.msgId}` : null;
  // S2 (H12): строку с заголовком неверной формы не отдаём — страница истории Android/iOS
  // разбирается одним массивом, одна такая строка ломала тред навсегда. В аварийном режиме
  // SECRET_HEADER_ENFORCE=0 отдаём всё (как до волны 1): вход такие строки тогда принимает.
  const enforceHeaders = secretHeaderEnforced();
  const invalidRows = pageRows.filter((m: any) => !isValidSecretHeader(m.headerJson));
  const items = enforceHeaders ? pageRows.filter((m: any) => isValidSecretHeader(m.headerJson)) : pageRows;
  logInvalidSecretRows(
    "history",
    { threadId },
    invalidRows.map((m: any) => ({ msgId: m.msgId, headerJson: m.headerJson })),
    enforceHeaders ? "hidden" : "served",
  );

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
