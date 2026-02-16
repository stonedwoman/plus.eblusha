import { Router, type Request } from "express";
import { z } from "zod";
import prisma from "../lib/prisma";
import { authenticate } from "../middlewares/auth";
import { getIO } from "../realtime/socket";

const router = Router();
router.use(authenticate);

type AuthedRequest = Request & { user?: { id: string } };
const userRoom = (userId: string) => `user:${userId}`;

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
      return { thread: existing, created: false };
    }

    const thread = await tx.conversation.create({
      data: {
        type: "SECRET",
        isSecret: true,
        isGroup: false,
        secretStatus: "ACTIVE",
        secretTtlSeconds: null,
        secretInitiatorDeviceId: null,
        secretPeerDeviceId: null,
        createdById: userId,
        participants: { create: [{ userId }, { userId: peerUserId }] },
      } as any,
      include: {
        participants: {
          include: {
            user: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
          },
        },
      },
    });
    return { thread, created: true };
  });

  // Notify all devices of both users (no accept/confirm).
  try {
    const io = getIO();
    const recipients = [userId, peerUserId];
    for (const rid of recipients) {
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

export default router;

