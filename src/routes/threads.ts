import { Router, type Request } from "express";
import { z } from "zod";
import prisma from "../lib/prisma";
import { authenticate } from "../middlewares/auth";
import { getIO } from "../realtime/socket";

const router = Router();
router.use(authenticate);

type AuthedRequest = Request & { user?: { id: string }; deviceId?: string };
const userRoom = (userId: string) => `user:${userId}`;

// Conversation shape emitted to clients (matches the create include below).
const conversationInclude = {
  participants: {
    include: {
      user: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
    },
  },
} as const;

// Resolve the caller's device (did token claim / x-device-id / query / body), verifying ownership.
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

const createSecretThreadSchema = z.object({
  peerUserId: z.string().min(1),
});

router.post("/secret", async (req, res) => {
  const userId = (req as AuthedRequest).user!.id;
  const parsed = createSecretThreadSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid payload" });
    return;
  }
  const peerUserId = parsed.data.peerUserId.trim();
  if (!peerUserId || peerUserId === userId) {
    res.status(400).json({ message: "Invalid peerUserId" });
    return;
  }

  const peer = await prisma.user.findUnique({
    where: { id: peerUserId },
    select: { id: true },
  });
  if (!peer) {
    res.status(404).json({ message: "Peer user not found" });
    return;
  }

  // Which of the creator's devices is opening this thread — pinned as the initiator so, after the
  // peer accepts, we key exactly ONE peer device and let the rest onboard via device-linking.
  const initiatorDeviceId = await resolveCurrentDeviceId(req);

  const minId = userId < peerUserId ? userId : peerUserId;
  const maxId = userId < peerUserId ? peerUserId : userId;
  const pairKey = `secret_thread:${minId}:${maxId}`;

  const result = await prisma.$transaction(async (tx) => {
    // Concurrency-safe idempotency: lock on normalized pair key.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${pairKey}))`;

    const candidates = await tx.conversation.findMany({
      where: {
        type: "SECRET",
        isGroup: false,
        secretStatus: { not: "CANCELLED" },
        participants: { some: { userId } },
      },
      include: { participants: true },
      orderBy: [{ lastMessageAt: "desc" }, { createdAt: "desc" }],
    });

    const existing = candidates.find((c: any) => {
      const ids = (c.participants as any[]).map((p: any) => p.userId).sort().join(",");
      return ids === [userId, peerUserId].sort().join(",");
    });
    if (existing) {
      const full = await tx.conversation.findUnique({
        where: { id: existing.id },
        include: conversationInclude,
      });
      return { thread: full ?? existing, created: false };
    }

    const thread = await tx.conversation.create({
      data: {
        type: "SECRET",
        isSecret: true,
        isGroup: false,
        // Invite model: the thread starts PENDING. The peer accepts on ONE device; only then does
        // the creator share the key. (Legacy clients that fan out on create still work — nothing
        // blocks /secret/messages/push on status — the thread just stays PENDING harmlessly.)
        secretStatus: "PENDING",
        secretTtlSeconds: null,
        secretInitiatorDeviceId: initiatorDeviceId,
        secretPeerDeviceId: null,
        createdById: userId,
        participants: { create: [{ userId }, { userId: peerUserId }] },
      } as any,
      include: conversationInclude,
    });
    return { thread, created: true };
  });

  // Notify all devices of both users — the peer's devices render the invite from the PENDING row.
  try {
    const io = getIO();
    for (const rid of [userId, peerUserId]) {
      io?.to(userRoom(rid)).emit("conversations:new", { conversationId: result.thread.id });
      io?.to(userRoom(rid)).emit("secret:thread:created", {
        threadId: result.thread.id,
        type: "SECRET",
      });
    }
  } catch {}

  res.status(result.created ? 201 : 200).json({
    threadId: result.thread.id,
    thread: result.thread,
    created: result.created,
  });
});

// The peer accepts the secret-chat invite on exactly ONE of their devices. Pins that device as the
// key recipient and flips PENDING → ACTIVE; the creator then keys only this device.
router.post("/secret/:id/accept", async (req, res) => {
  const userId = (req as AuthedRequest).user!.id;
  const conversationId = String(req.params.id || "").trim();
  if (!conversationId) {
    res.status(400).json({ message: "Invalid conversation id" });
    return;
  }

  const deviceId = await resolveCurrentDeviceId(req);
  if (!deviceId) {
    res.status(400).json({ message: "A registered device is required to accept" });
    return;
  }

  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: { participants: { select: { userId: true } } },
  });
  const c = conv as any;
  if (!conv || c.type !== "SECRET" || c.isGroup) {
    res.status(404).json({ message: "Secret thread not found" });
    return;
  }
  const isMember = (conv as any).participants.some((p: any) => p.userId === userId);
  if (!isMember) {
    res.status(403).json({ message: "Forbidden" });
    return;
  }
  // Only the PEER accepts (the creator's device already holds the key).
  if (c.createdById === userId) {
    res.status(409).json({ message: "The creator cannot accept their own invite" });
    return;
  }
  if (c.secretStatus === "CANCELLED") {
    res.status(409).json({ message: "Invite was declined" });
    return;
  }
  // Idempotent: if already accepted on THIS device, just re-emit; a different device re-accepting
  // is rejected so a second peer device can't hijack the key recipient.
  if (c.secretStatus === "ACTIVE" && c.secretPeerDeviceId && c.secretPeerDeviceId !== deviceId) {
    res.status(409).json({ message: "Already accepted on another device" });
    return;
  }

  const updated = await prisma.conversation.update({
    where: { id: conversationId },
    data: { secretStatus: "ACTIVE", secretPeerDeviceId: deviceId } as any,
    include: conversationInclude,
  });

  try {
    const io = getIO();
    const participantIds = (conv as any).participants.map((p: any) => p.userId);
    for (const rid of participantIds) {
      io?.to(userRoom(rid)).emit("secret:chat:accepted", { conversationId, peerDeviceId: deviceId });
      io?.to(userRoom(rid)).emit("conversations:updated", { conversationId, conversation: updated });
    }
  } catch {}

  res.json({ ok: true, conversationId, peerDeviceId: deviceId, thread: updated });
});

// Decline (peer) or cancel (creator) a PENDING invite → CANCELLED, hidden on all devices.
router.post("/secret/:id/decline", async (req, res) => {
  const userId = (req as AuthedRequest).user!.id;
  const conversationId = String(req.params.id || "").trim();
  if (!conversationId) {
    res.status(400).json({ message: "Invalid conversation id" });
    return;
  }

  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: { participants: { select: { userId: true } } },
  });
  const c = conv as any;
  if (!conv || c.type !== "SECRET" || c.isGroup) {
    res.status(404).json({ message: "Secret thread not found" });
    return;
  }
  const participantIds = (conv as any).participants.map((p: any) => p.userId);
  if (!participantIds.includes(userId)) {
    res.status(403).json({ message: "Forbidden" });
    return;
  }
  if (c.secretStatus === "CANCELLED") {
    res.json({ ok: true, conversationId }); // already gone — idempotent
    return;
  }

  await prisma.conversation.update({
    where: { id: conversationId },
    data: { secretStatus: "CANCELLED" } as any,
  });

  try {
    const io = getIO();
    for (const rid of participantIds) {
      io?.to(userRoom(rid)).emit("conversations:deleted", { conversationId });
    }
  } catch {}

  res.json({ ok: true, conversationId });
});

export default router;
