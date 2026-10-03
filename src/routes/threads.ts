import { Router, type Request } from "express";
import { z } from "zod";
import prisma from "../lib/prisma";
import { resolveCurrentDeviceId } from "../lib/currentDevice";
import {
  SECRET_ACCEPT_LOST_TO_DECLINE,
  acceptSecretThread,
  announceSecretThreadAccepted,
  declineSecretThread,
} from "../lib/secretThreadState";
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
// Переход атомарный (условный UPDATE, см. lib/secretThreadState): из гонки двух устройств
// выходит ровно один 200, accept после decline не воскрешает CANCELLED.
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

  const result = await acceptSecretThread({ userId, conversationId, deviceId });
  if (!result.ok) {
    res.status(result.status).json({ message: result.message, code: result.code });
    return;
  }

  // Рассылка + перепроверка ПОСЛЕ неё (гонка с decline): если тред уже отменён, участники
  // последним получают conversations:deleted, а принявший — 409, как при обычном «поздно».
  let live = true;
  try {
    live = await announceSecretThreadAccepted(getIO(), result);
  } catch {}
  if (!live) {
    res.status(409).json(SECRET_ACCEPT_LOST_TO_DECLINE);
    return;
  }

  res.json({ ok: true, conversationId, peerDeviceId: deviceId, thread: result.thread });
});

// Decline (peer) or cancel (creator) a PENDING invite → CANCELLED, hidden on all devices.
router.post("/secret/:id/decline", async (req, res) => {
  const userId = (req as AuthedRequest).user!.id;
  const conversationId = String(req.params.id || "").trim();
  if (!conversationId) {
    res.status(400).json({ message: "Invalid conversation id" });
    return;
  }

  const result = await declineSecretThread({ userId, conversationId });
  if (!result.ok) {
    res.status(result.status).json({ message: result.message, code: result.code });
    return;
  }

  if (result.changed) {
    try {
      const io = getIO();
      for (const rid of result.participantIds) {
        io?.to(userRoom(rid)).emit("conversations:deleted", { conversationId });
      }
    } catch {}
  }

  res.json({ ok: true, conversationId }); // already CANCELLED — idempotent
});

export default router;
