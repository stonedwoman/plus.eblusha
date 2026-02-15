import { Router, type Request } from "express";
import { z } from "zod";
import prisma from "../lib/prisma";
import { Prisma } from "@prisma/client";
import { deleteS3ObjectsByUrls } from "../lib/storageDeletion";
import { authenticate } from "../middlewares/auth";
import { getIO } from "../realtime/socket";
import env from "../config/env";
import { extractFirstUrl } from "../lib/linkPreview";
import { enqueueLinkPreview } from "../jobs/queue";
import { rateLimit } from "../middlewares/rateLimit";

const router = Router();
const userRoom = (userId: string) => `user:${userId}`;

router.use(authenticate);

const createConversationSchema = z.object({
  participantIds: z.array(z.string().cuid()).min(1),
  title: z.string().optional(),
  isGroup: z.boolean().optional(),
  // Secret conversations are intended for 1:1 chats only
  isSecret: z.boolean().optional(),
  // Optionally pin initiator device id (must exist for the current user)
  // Device IDs can be UUID or CUID format
  initiatorDeviceId: z.union([z.string().uuid(), z.string().cuid()]).optional(),
});

type AuthedRequest = Request & { user?: { id: string } };

const intervalSchema = z.object({
  startUtcISO: z.string().datetime(),
  endUtcISO: z.string().datetime(),
});

const proposalReactionSchema = z.object({
  value: z.union([z.literal("YES"), z.literal("MAYBE"), z.literal("NO"), z.null()]),
});

function handleAvailabilityDbError(res: any, err: unknown) {
  // Common case on prod: migrations not applied yet -> table missing
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    // P2021: table does not exist (depending on adapter)
    // P2022: column does not exist
    const code = err.code;
    if (code === "P2021" || code === "P2022") {
      res.status(503).json({
        message: "Availability storage is not ready (database migration missing).",
        code: "AVAILABILITY_DB_NOT_READY",
      });
      return true;
    }
  }
  if (err instanceof Prisma.PrismaClientInitializationError) {
    res.status(503).json({ message: "Database unavailable", code: "DB_UNAVAILABLE" });
    return true;
  }
  return false;
}

router.get("/:id/availability", async (req, res) => {
  const { id } = req.params;
  const userId = (req as AuthedRequest).user!.id;

  const membership = await prisma.conversationParticipant.findFirst({
    where: { conversationId: id, userId },
  });
  if (!membership) {
    res.status(403).json({ message: "Forbidden" });
    return;
  }

  const conv = await prisma.conversation.findUnique({
    where: { id },
    include: { participants: true },
  });
  if (!conv) {
    res.status(404).json({ message: "Not found" });
    return;
  }

  const participantIds = conv.participants.map((p) => p.userId);

  let rows: Array<{ userId: string; startUtc: Date; endUtc: Date }> = [];
  try {
    rows = await prisma.conversationAvailabilityInterval.findMany({
      where: { conversationId: id, userId: { in: participantIds } },
      orderBy: [{ userId: "asc" }, { startUtc: "asc" }],
      select: { userId: true, startUtc: true, endUtc: true },
    });
  } catch (err) {
    if (handleAvailabilityDbError(res, err)) return;
    console.error("[Availability] GET failed", err);
    res.status(500).json({ message: "Internal error", code: "AVAILABILITY_INTERNAL" });
    return;
  }

  const byUserId: Record<string, { startUtcISO: string; endUtcISO: string }[]> = {};
  for (const pid of participantIds) byUserId[pid] = [];
  for (const row of rows) {
    const key = row.userId;
    const list = byUserId[key] ?? [];
    byUserId[key] = list;
    list.push({
      startUtcISO: row.startUtc.toISOString(),
      endUtcISO: row.endUtc.toISOString(),
    });
  }

  res.json({ intervalsByUserId: byUserId });
});

router.put("/:id/availability/me", async (req, res) => {
  const { id } = req.params;
  const userId = (req as AuthedRequest).user!.id;

  const membership = await prisma.conversationParticipant.findFirst({
    where: { conversationId: id, userId },
  });
  if (!membership) {
    res.status(403).json({ message: "Forbidden" });
    return;
  }

  const bodySchema = z.object({
    intervals: intervalSchema.array().max(2000),
  });
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid intervals", errors: parsed.error.issues });
    return;
  }

  const intervals = parsed.data.intervals
    .map((i) => ({
      start: new Date(i.startUtcISO),
      end: new Date(i.endUtcISO),
    }))
    .filter((i) => !Number.isNaN(i.start.getTime()) && !Number.isNaN(i.end.getTime()) && i.end > i.start);

  try {
    await prisma.$transaction([
      prisma.conversationAvailabilityInterval.deleteMany({
        where: { conversationId: id, userId },
      }),
      prisma.conversationAvailabilityInterval.createMany({
        data: intervals.map((i) => ({
          conversationId: id,
          userId,
          startUtc: i.start,
          endUtc: i.end,
        })),
        skipDuplicates: true,
      }),
    ]);
  } catch (err) {
    if (handleAvailabilityDbError(res, err)) return;
    console.error("[Availability] PUT failed", err);
    res.status(500).json({ message: "Internal error", code: "AVAILABILITY_INTERNAL" });
    return;
  }

  try {
    const io = getIO();
    // Notify both the conversation room and each participant user room (more robust for realtime)
    io?.to(id).emit("availability:updated", { conversationId: id, userId });
    const conv = await prisma.conversation.findUnique({
      where: { id },
      include: { participants: true },
    });
    const participantIds = conv?.participants.map((p) => p.userId) ?? [];
    for (const pid of participantIds) {
      io?.to(userRoom(pid)).emit("availability:updated", { conversationId: id, userId });
    }
  } catch {}

  res.json({ success: true });
});

router.get("/:id/availability/proposals", async (req, res) => {
  const { id } = req.params;
  const userId = (req as AuthedRequest).user!.id;

  const membership = await prisma.conversationParticipant.findFirst({
    where: { conversationId: id, userId },
  });
  if (!membership) {
    res.status(403).json({ message: "Forbidden" });
    return;
  }

  const now = new Date();
  try {
    const proposals = await prisma.conversationAvailabilityProposal.findMany({
      where: { conversationId: id, deletedAt: null, maxEndUtc: { gt: now } },
      orderBy: { createdAt: "desc" },
      include: {
        intervals: { orderBy: { startUtc: "asc" } },
        reactions: true,
      },
    });
    res.json({
      proposals: proposals.map((p) => ({
        id: p.id,
        conversationId: p.conversationId,
        createdById: p.createdById,
        createdAt: p.createdAt.toISOString(),
        note: p.note ?? null,
        maxEndUtcISO: p.maxEndUtc.toISOString(),
        ranges: p.intervals.map((i) => ({ startUtcISO: i.startUtc.toISOString(), endUtcISO: i.endUtc.toISOString() })),
        reactionsByUserId: Object.fromEntries(p.reactions.map((r) => [r.userId, r.value])),
      })),
    });
  } catch (err) {
    if (handleAvailabilityDbError(res, err)) return;
    console.error("[Availability] proposals GET failed", err);
    res.status(500).json({ message: "Internal error", code: "AVAILABILITY_INTERNAL" });
  }
});

router.post("/:id/availability/proposals", async (req, res) => {
  const { id } = req.params;
  const userId = (req as AuthedRequest).user!.id;

  const membership = await prisma.conversationParticipant.findFirst({
    where: { conversationId: id, userId },
  });
  if (!membership) {
    res.status(403).json({ message: "Forbidden" });
    return;
  }

  const bodySchema = z.object({
    ranges: intervalSchema.array().min(1).max(50),
    note: z.string().max(500).optional(),
  });
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid proposal", errors: parsed.error.issues });
    return;
  }

  const intervals = parsed.data.ranges
    .map((i) => ({ startUtc: new Date(i.startUtcISO), endUtc: new Date(i.endUtcISO) }))
    .filter((i) => !Number.isNaN(i.startUtc.getTime()) && !Number.isNaN(i.endUtc.getTime()) && i.endUtc > i.startUtc);

  if (intervals.length === 0) {
    res.status(400).json({ message: "Invalid ranges" });
    return;
  }

  const maxEndUtc = intervals.reduce(
    (acc, cur) => (cur.endUtc > acc ? cur.endUtc : acc),
    intervals[0]?.endUtc ?? new Date(0),
  );
  const now = new Date();
  if (maxEndUtc <= now) {
    res.status(400).json({ message: "Proposal is in the past" });
    return;
  }

  try {
    const created = await prisma.conversationAvailabilityProposal.create({
      data: {
        conversationId: id,
        createdById: userId,
        note: parsed.data.note ?? null,
        maxEndUtc,
        intervals: {
          create: intervals.map((i) => ({ startUtc: i.startUtc, endUtc: i.endUtc })),
        },
      },
      include: { intervals: true, reactions: true },
    });

    const io = getIO();
    io?.to(id).emit("availability:proposals:updated", { conversationId: id, proposalId: created.id });
    const conv = await prisma.conversation.findUnique({ where: { id }, include: { participants: true } });
    const participantIds = conv?.participants.map((p) => p.userId) ?? [];
    for (const pid of participantIds) {
      io?.to(userRoom(pid)).emit("availability:proposals:updated", { conversationId: id, proposalId: created.id });
    }

    res.status(201).json({
      proposal: {
        id: created.id,
        conversationId: created.conversationId,
        createdById: created.createdById,
        createdAt: created.createdAt.toISOString(),
        note: created.note ?? null,
        maxEndUtcISO: created.maxEndUtc.toISOString(),
        ranges: created.intervals
          .sort((a, b) => a.startUtc.getTime() - b.startUtc.getTime())
          .map((i) => ({ startUtcISO: i.startUtc.toISOString(), endUtcISO: i.endUtc.toISOString() })),
        reactionsByUserId: {},
      },
    });
  } catch (err) {
    if (handleAvailabilityDbError(res, err)) return;
    console.error("[Availability] proposals POST failed", err);
    res.status(500).json({ message: "Internal error", code: "AVAILABILITY_INTERNAL" });
  }
});

router.delete("/:id/availability/proposals/:proposalId", async (req, res) => {
  const { id, proposalId } = req.params as any;
  const userId = (req as AuthedRequest).user!.id;

  const membership = await prisma.conversationParticipant.findFirst({
    where: { conversationId: id, userId },
  });
  if (!membership) {
    res.status(403).json({ message: "Forbidden" });
    return;
  }

  try {
    const proposal = await prisma.conversationAvailabilityProposal.findUnique({
      where: { id: proposalId },
      select: { id: true, conversationId: true, createdById: true, deletedAt: true },
    });
    if (!proposal || proposal.conversationId !== id || proposal.deletedAt) {
      res.status(404).json({ message: "Not found" });
      return;
    }
    if (proposal.createdById !== userId) {
      res.status(403).json({ message: "Only creator can delete" });
      return;
    }

    await prisma.conversationAvailabilityProposal.update({
      where: { id: proposalId },
      data: { deletedAt: new Date() },
    });

    const io = getIO();
    io?.to(id).emit("availability:proposals:updated", { conversationId: id, proposalId });
    io?.to(userRoom(userId)).emit("availability:proposals:updated", { conversationId: id, proposalId });
    res.json({ success: true });
  } catch (err) {
    if (handleAvailabilityDbError(res, err)) return;
    console.error("[Availability] proposals DELETE failed", err);
    res.status(500).json({ message: "Internal error", code: "AVAILABILITY_INTERNAL" });
  }
});

router.put("/:id/availability/proposals/:proposalId/reaction", async (req, res) => {
  const { id, proposalId } = req.params as any;
  const userId = (req as AuthedRequest).user!.id;

  const membership = await prisma.conversationParticipant.findFirst({
    where: { conversationId: id, userId },
  });
  if (!membership) {
    res.status(403).json({ message: "Forbidden" });
    return;
  }

  const parsed = proposalReactionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid reaction", errors: parsed.error.issues });
    return;
  }

  try {
    const proposal = await prisma.conversationAvailabilityProposal.findUnique({
      where: { id: proposalId },
      select: { id: true, conversationId: true, deletedAt: true, maxEndUtc: true },
    });
    if (!proposal || proposal.conversationId !== id || proposal.deletedAt || proposal.maxEndUtc <= new Date()) {
      res.status(404).json({ message: "Not found" });
      return;
    }

    if (parsed.data.value === null) {
      await prisma.conversationAvailabilityProposalReaction.deleteMany({
        where: { proposalId, userId },
      });
    } else {
      await prisma.conversationAvailabilityProposalReaction.upsert({
        where: { proposalId_userId: { proposalId, userId } },
        create: { proposalId, userId, value: parsed.data.value },
        update: { value: parsed.data.value },
      });
    }

    const io = getIO();
    io?.to(id).emit("availability:proposals:updated", { conversationId: id, proposalId });
    const conv = await prisma.conversation.findUnique({ where: { id }, include: { participants: true } });
    const participantIds = conv?.participants.map((p) => p.userId) ?? [];
    for (const pid of participantIds) {
      io?.to(userRoom(pid)).emit("availability:proposals:updated", { conversationId: id, proposalId });
    }

    res.json({ success: true });
  } catch (err) {
    if (handleAvailabilityDbError(res, err)) return;
    console.error("[Availability] proposals reaction PUT failed", err);
    res.status(500).json({ message: "Internal error", code: "AVAILABILITY_INTERNAL" });
  }
});

router.get("/", async (req, res) => {
  const userId = (req as AuthedRequest).user!.id;
  // Deduplicate conversations for this user before returning list
  try {
    await deduplicateUserConversations(userId);
  } catch {}

  const conversations = await prisma.conversationParticipant.findMany({
    where: { userId },
    include: {
      conversation: {
        include: {
          participants: {
            include: {
              user: {
                select: {
                  id: true,
                  username: true,
                  displayName: true,
                  avatarUrl: true,
                  status: true,
                  lastSeenAt: true,
                },
              },
            },
          },
          messages: {
            take: 1,
            orderBy: { createdAt: "desc" },
            include: {
              sender: { select: { id: true, username: true, displayName: true } },
            },
          },
        },
      },
    },
    orderBy: { joinedAt: "desc" },
  });

  // compute unread counts per conversation for this user
  const withUnread = await Promise.all(
    conversations.map(async (cp) => {
      const unreadCount = await prisma.message.count({
        where: {
          conversationId: cp.conversation.id,
          senderId: { not: userId },
          receipts: { none: { userId, status: { in: ["READ", "SEEN"] } } },
        },
      });
      return { ...cp, unreadCount } as any;
    })
  );

  res.json({ conversations: withUnread });
});

router.post("/", async (req, res) => {
  const parsed = createConversationSchema.safeParse(req.body);
  if (!parsed.success) {
    console.error('[Conversations] Validation error:', parsed.error.issues);
    res.status(400).json({
      message: "Invalid conversation data",
      errors: parsed.error.issues
    });
    return;
  }

  const { participantIds, title, isGroup = false, isSecret = false, initiatorDeviceId } = parsed.data;
  const userId = (req as AuthedRequest).user!.id;

  const uniqueParticipantIds = Array.from(new Set([...participantIds, userId]));

  // Secret chats are only supported for non-group 1:1 conversations
  if (isSecret) {
    if (isGroup) {
      res.status(400).json({ message: "Secret conversations cannot be group chats" });
      return;
    }
    if (uniqueParticipantIds.length !== 2) {
      res.status(400).json({ message: "Secret conversations must have exactly 2 participants" });
      return;
    }
  }
  let initiatorDevice: { id: string; userId: string; revokedAt?: Date | null } | null = null;
  if (isSecret) {
    if (!initiatorDeviceId) {
      res.status(400).json({ message: "Missing initiator deviceId for secret conversation" });
      return;
    }
    initiatorDevice = await (prisma as any).userDevice.findUnique({
      where: { id: initiatorDeviceId },
      select: { id: true, userId: true, revokedAt: true },
    });
    if (!initiatorDevice || initiatorDevice.userId !== userId || initiatorDevice.revokedAt) {
      res.status(400).json({ message: "Invalid initiator device" });
      return;
    }
  }

  // Try to find existing conversation with the exact same participants set (including current user)
  const candidates = await prisma.conversation.findMany({
    where: {
      isGroup,
      participants: { some: { userId } },
    },
    include: { participants: true },
    orderBy: [{ lastMessageAt: "desc" }, { createdAt: "desc" }],
  });

  const desired = uniqueParticipantIds.slice().sort().join(",");
  const existing = (candidates as any[]).find((c) => {
    const ids = (c.participants as any[]).map((p: any) => p.userId).sort().join(",");
    // Secret and non-secret conversations with the same participants are treated separately
    return ids === desired && !!c.isSecret === !!isSecret && (c.secretStatus ?? 'ACTIVE') !== 'CANCELLED';
  });

  if (existing) {
    if (isSecret && (existing as any).secretStatus === "PENDING") {
      const io = getIO();
      const recipient = existing.participants.find((p: any) => p.userId !== userId);
      if (recipient) {
        const offerDeviceId = (existing as any).secretInitiatorDeviceId ?? initiatorDevice?.id ?? null;
        if (offerDeviceId) {
          const initiatorUser = await prisma.user.findUnique({
            where: { id: userId },
            select: { displayName: true, username: true },
          });
          const name = initiatorUser?.displayName ?? initiatorUser?.username ?? "пользователь";
          io?.to(userRoom(recipient.userId)).emit("secret:chat:offer", {
            conversationId: existing.id,
            from: { id: userId, name, deviceId: offerDeviceId },
          });
        }
      }
    }
    // Return existing conversation instead of creating a duplicate
    const conv = await prisma.conversation.findUnique({
      where: { id: existing.id },
      include: {
        participants: {
          include: {
            user: {
              select: { id: true, username: true, displayName: true, avatarUrl: true },
            },
          },
        },
      },
    });
    res.status(200).json({ conversation: conv, duplicated: true });
    return;
  }

  const conversation = await prisma.conversation.create({
    data: {
      title: isGroup ? title ?? "New group" : null,
      isGroup,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...(isSecret
        ? {
            isSecret: true,
            secretTtlSeconds: env.SECRET_MESSAGE_TTL_SECONDS,
            secretStatus: "PENDING",
            secretInitiatorDeviceId: initiatorDevice?.id ?? null,
          }
        : ({ isSecret: false, secretTtlSeconds: null, secretStatus: "ACTIVE" } as any)),
      createdById: userId,
      participants: { create: uniqueParticipantIds.map((id) => ({ userId: id })) },
    } as any,
    include: {
      participants: {
        include: {
          user: {
            select: {
              id: true,
              username: true,
              displayName: true,
              avatarUrl: true,
            },
          },
        },
      },
    },
  });

  // Notify all participants about the new conversation
  const io = getIO();
  for (const pid of uniqueParticipantIds) {
    io?.to(userRoom(pid)).emit("conversations:new", { conversationId: conversation.id });
  }

  if (isSecret && initiatorDevice) {
    const recipient = conversation.participants.find((p: any) => p.userId !== userId);
    if (recipient) {
      const initiatorUser = await prisma.user.findUnique({
        where: { id: userId },
        select: { displayName: true, username: true },
      });
      const name = initiatorUser?.displayName ?? initiatorUser?.username ?? "пользователь";
      io?.to(userRoom(recipient.userId)).emit("secret:chat:offer", {
        conversationId: conversation.id,
        from: { id: userId, name, deviceId: initiatorDevice.id },
      });
    }
  }

  res.status(201).json({ conversation });
});

// Add participants to a conversation (MUST be before /:id routes)
router.post("/:id/participants", async (req, res) => {
  const { id } = req.params;
  const userId = (req as AuthedRequest).user!.id;

  const conv = await prisma.conversation.findUnique({
    where: { id },
    include: { participants: true },
  });
  if (!conv) return res.status(404).json({ message: "Not found" });
  if (!conv.isGroup) return res.status(400).json({ message: "Can only add participants to group conversations" });
  
  const isMember = conv.participants.some((p) => p.userId === userId);
  if (!isMember) return res.status(403).json({ message: "Forbidden" });

  const addSchema = z.object({
    participantIds: z.array(z.string().cuid()).min(1),
  });
  const parsed = addSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid participant data" });
    return;
  }

  const { participantIds } = parsed.data;
  const existingIds = conv.participants.map((p) => p.userId);
  const newIds = participantIds.filter((id) => !existingIds.includes(id));

  if (newIds.length === 0) {
    res.status(400).json({ message: "All users are already participants" });
    return;
  }

  await prisma.conversationParticipant.createMany({
    data: newIds.map((participantId) => ({
      conversationId: id,
      userId: participantId,
    })),
    skipDuplicates: true,
  });

  const updated = await prisma.conversation.findUnique({
    where: { id },
    include: {
      participants: {
        include: {
          user: {
            select: {
              id: true,
              username: true,
              displayName: true,
              avatarUrl: true,
            },
          },
        },
      },
    },
  });

  // Получаем данные пользователя, который добавляет участников
  const inviter = await prisma.user.findUnique({
    where: { id: userId },
    select: { displayName: true, username: true },
  });
  const inviterName = inviter?.displayName ?? inviter?.username ?? "Пользователь";

  // Получаем данные добавленных пользователей
  const addedUsers = await prisma.user.findMany({
    where: { id: { in: newIds } },
    select: { id: true, displayName: true, username: true },
  });

  // Создаем системное сообщение о добавлении участников
  if (addedUsers.length > 0) {
    const addedNames = addedUsers.map((u) => u.displayName ?? u.username).join(", ");
    const messageContent = addedUsers.length === 1 
      ? `${inviterName} пригласил(а) ${addedNames} в беседу`
      : `${inviterName} пригласил(а) ${addedNames} в беседу`;

    try {
      const systemMessage = await prisma.message.create({
        data: {
          conversationId: id,
          senderId: userId,
          type: "SYSTEM",
          content: messageContent,
          metadata: { action: "participant_added", addedUserIds: newIds } as any,
        },
      });

      // Обновляем lastMessageAt для беседы
      await prisma.conversation.update({
        where: { id },
        data: { lastMessageAt: new Date() },
      });

      const io = getIO();
      // Отправляем событие о новом сообщении всем участникам беседы
      io?.to(id).emit("message:new", { conversationId: id, messageId: systemMessage.id, senderId: userId });
      // Также отправляем message:notify для каждого участника (кроме отправителя)
      const allParticipants = updated?.participants.map((p) => p.userId) ?? [];
      for (const pid of allParticipants) {
        if (pid !== userId) {
          io?.to(userRoom(pid)).emit("message:notify", { conversationId: id, messageId: systemMessage.id, senderId: userId });
        }
      }
    } catch (error) {
      // Игнорируем ошибки создания системного сообщения, чтобы не блокировать добавление участников
      console.error("Failed to create system message:", error);
    }
  }

  // Notify new participants
  const io = getIO();
  for (const pid of newIds) {
    io?.to(userRoom(pid)).emit("conversations:new", { conversationId: id });
  }
  // Notify existing participants
  for (const p of conv.participants) {
    if (p.userId !== userId) {
      io?.to(userRoom(p.userId)).emit("conversations:updated", { conversationId: id, conversation: updated });
    }
  }

  res.json({ conversation: updated });
});

// Update a conversation (title, avatarUrl, etc.)
router.patch("/:id", async (req, res) => {
  const { id } = req.params;
  const userId = (req as AuthedRequest).user!.id;

  const conv = await prisma.conversation.findUnique({
    where: { id },
    include: { participants: true },
  });
  if (!conv) return res.status(404).json({ message: "Not found" });
  const isMember = conv.participants.some((p) => p.userId === userId);
  if (!isMember) return res.status(403).json({ message: "Forbidden" });

  const updateSchema = z.object({
    title: z.string().optional(),
    avatarUrl: z.union([z.string().url(), z.null()]).optional(),
  });
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid update data" });
    return;
  }

  const updateData: any = {};
  if (parsed.data.title !== undefined) updateData.title = parsed.data.title;
  if (parsed.data.avatarUrl !== undefined) updateData.avatarUrl = parsed.data.avatarUrl;

  const updated = await prisma.conversation.update({
    where: { id },
    data: updateData,
    include: {
      participants: {
        include: {
          user: {
            select: {
              id: true,
              username: true,
              displayName: true,
              avatarUrl: true,
            },
          },
        },
      },
    },
  });

  // Notify participants (they will refetch via invalidateQueries)
  // const recipients = conv.participants.map((p) => p.userId);
  // const io = getIO();
  // for (const rid of recipients) io?.to(rid).emit("conversations:updated", { conversationId: id, conversation: updated });

  res.json({ conversation: updated });
});

// Leave a conversation (remove current user's participation)
router.delete("/:id/participants/me", async (req, res) => {
  const { id } = req.params;
  const userId = (req as AuthedRequest).user!.id;

  const conv = await prisma.conversation.findUnique({
    where: { id },
    include: { participants: true },
  });
  if (!conv) return res.status(404).json({ message: "Not found" });
  
  const isMember = conv.participants.some((p) => p.userId === userId);
  if (!isMember) return res.status(403).json({ message: "Forbidden" });

  // Получаем данные пользователя, который покидает беседу (до удаления участия)
  const leavingUser = await prisma.user.findUnique({
    where: { id: userId },
    select: { displayName: true, username: true },
  });
  const leavingUserName = leavingUser?.displayName ?? leavingUser?.username ?? "Пользователь";

  // Создаем системное сообщение о выходе участника (перед удалением участия)
  try {
    const systemMessage = await prisma.message.create({
      data: {
        conversationId: id,
        senderId: userId,
        type: "SYSTEM",
        content: `${leavingUserName} покинул(а) беседу`,
        metadata: { action: "participant_left" } as any,
      },
    });

    // Обновляем lastMessageAt для беседы
    await prisma.conversation.update({
      where: { id },
      data: { lastMessageAt: new Date() },
    });

    const io = getIO();
    // Отправляем событие о новом сообщении всем участникам беседы
    io?.to(id).emit("message:new", { conversationId: id, messageId: systemMessage.id, senderId: userId });
    // Также отправляем message:notify для каждого участника (кроме того, кто уходит)
    const allParticipants = conv.participants.map((p) => p.userId);
    for (const pid of allParticipants) {
      if (pid !== userId) {
        io?.to(userRoom(pid)).emit("message:notify", { conversationId: id, messageId: systemMessage.id, senderId: userId });
      }
    }
  } catch (error) {
    // Игнорируем ошибки создания системного сообщения, чтобы не блокировать выход
    console.error("Failed to create system message:", error);
  }

  // Удаляем участие текущего пользователя
  await prisma.conversationParticipant.deleteMany({
    where: {
      conversationId: id,
      userId: userId,
    },
  });

  // Уведомляем остальных участников об обновлении беседы
  const io = getIO();
  const remainingParticipants = conv.participants.filter((p) => p.userId !== userId);
  for (const p of remainingParticipants) {
    io?.to(userRoom(p.userId)).emit("conversations:updated", { conversationId: id });
  }
  // Уведомляем текущего пользователя об удалении (чтобы беседа исчезла из списка)
  io?.to(userRoom(userId)).emit("conversations:deleted", { conversationId: id });

  res.json({ success: true });
});

// Hard-delete a conversation (for all participants)
router.delete("/:id", async (req, res) => {
  const { id } = req.params;
  const userId = (req as AuthedRequest).user!.id;

  const conv = await prisma.conversation.findUnique({
    where: { id },
    include: { participants: true },
  });
  if (!conv) return res.status(404).json({ message: "Not found" });
  const isMember = conv.participants.some((p) => p.userId === userId);
  if (!isMember) return res.status(403).json({ message: "Forbidden" });

  // Fetch attachment URLs before deletion for best-effort S3 cleanup.
  const attachmentUrls = (
    await prisma.messageAttachment.findMany({
      where: { message: { conversationId: id } },
      select: { url: true },
    })
  ).map((a) => a.url);

  await prisma.$transaction([
    prisma.messageReceipt.deleteMany({ where: { message: { conversationId: id } } }),
    prisma.messageAttachment.deleteMany({ where: { message: { conversationId: id } } }),
    prisma.messageReaction.deleteMany({ where: { message: { conversationId: id } } }),
    prisma.message.deleteMany({ where: { conversationId: id } }),
    prisma.conversationParticipant.deleteMany({ where: { conversationId: id } }),
    prisma.conversation.delete({ where: { id } }),
  ]);

  if (attachmentUrls.length) {
    void deleteS3ObjectsByUrls(attachmentUrls, { reason: `conversation:${id}` });
  }

  // Notify participants
  const recipients = conv.participants.map((p) => p.userId);
  const io = getIO();
  for (const rid of recipients) io?.to(userRoom(rid)).emit("conversations:deleted", { conversationId: id });

  res.json({ success: true });
});

router.get("/:id/messages", async (req, res) => {
  const { id } = req.params;
  const userId = (req as AuthedRequest).user!.id;
  const schema = z.object({
    cursor: z.string().optional(),
    // New pagination param (backwards compatible): fetch up to `limit` newest items per request.
    // If omitted, we keep the legacy behavior (500).
    limit: z.coerce.number().int().min(1).max(500).optional(),
  });
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid query" });
    return;
  }
  const { cursor, limit: limitRaw } = parsed.data;
  const limit = typeof limitRaw === "number" ? limitRaw : 500;

  const membership = await prisma.conversationParticipant.findFirst({
    where: { conversationId: id, userId },
  });

  if (!membership) {
    res.status(403).json({ message: "Forbidden" });
    return;
  }

  // Link preview generation is disabled for secret conversations.
  const convMeta = await prisma.conversation.findUnique({
    where: { id },
    select: { isSecret: true, secretStatus: true },
  });
  const isSecretConversation = Boolean((convMeta as any)?.isSecret) && (convMeta as any)?.secretStatus !== "CANCELLED";

  const now = new Date();

  const query: any = {
    where: {
      conversationId: id,
      OR: [
        { expiresAt: null },
        { expiresAt: { gt: now } },
      ],
    },
    orderBy: { createdAt: "desc" as const },
    // Fetch `limit + 1` to detect whether there are more items.
    take: limit + 1,
    include: {
      sender: { select: { id: true, username: true, displayName: true } },
      attachments: true,
      reactions: true,
      receipts: true,
      replyTo: { select: { id: true, content: true, senderId: true, createdAt: true } },
    },
  };
  if (cursor) {
    query.skip = 1;
    query.cursor = { id: cursor } as any;
  }
  let messages = await prisma.message.findMany(query);
  const hasMore = messages.length > limit;
  if (hasMore) {
    messages = messages.slice(0, limit);
  }
  const last = messages.at(-1);
  const nextCursor = hasMore && last ? last.id : null;

  // Telegram-like unfurl for older messages: enqueue preview jobs lazily when messages are requested.
  // Actual fetching/parsing is done ONLY by the worker.
  if (!isSecretConversation) {
    try {
      const MAX_PREVIEWS_PER_FETCH = 3;
      const RETRY_AFTER_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
      const candidates = (messages as any[])
        .filter((m) => m && m.type === "TEXT" && typeof m.content === "string" && m.content && !m.deletedAt)
        .filter((m) => {
          const meta = (m.metadata && typeof m.metadata === "object") ? (m.metadata as any) : null;
          if (meta?.linkPreview) return false;
          const attemptedAt = typeof meta?.linkPreviewAttemptedAt === "string" ? meta.linkPreviewAttemptedAt : null;
          if (!attemptedAt) return true;
          const t = Date.parse(attemptedAt);
          if (Number.isNaN(t)) return true;
          return Date.now() - t > RETRY_AFTER_MS;
        })
        .slice(0, MAX_PREVIEWS_PER_FETCH);

      for (const m of candidates) {
        const firstUrl = extractFirstUrl(m.content);
        if (!firstUrl) continue;
        void enqueueLinkPreview({ messageId: m.id, conversationId: id, url: firstUrl }).catch(() => {});
      }
    } catch {
      // ignore preview errors
    }
  }

  res.json({ messages, hasMore, nextCursor });
});

const sendMessageSchema = z.object({
  conversationId: z.string().cuid(),
  type: z.union([
    z.literal("TEXT"),
    z.literal("IMAGE"),
    z.literal("VIDEO"),
    z.literal("AUDIO"),
    z.literal("FILE"),
    z.literal("SYSTEM"),
    z.literal("CALL"),
  ]),
  content: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  replyToId: z.string().cuid().optional(),
  attachments: z
    .array(
      z.object({
        // allow absolute URLs and relative paths like /api/uploads/xxx
        url: z.string().min(1),
        type: z.union([
          z.literal("IMAGE"),
          z.literal("VIDEO"),
          z.literal("AUDIO"),
          z.literal("FILE"),
        ]),
        size: z.number().optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      })
    )
    .optional(),
});

router.post(
  "/send",
  rateLimit({ name: "send_message", windowMs: 60_000, max: 60 }),
  async (req, res) => {
  const parsed = sendMessageSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid message data" });
    return;
  }

  const { conversationId, type, content, metadata, attachments, replyToId } = parsed.data;
  const userId = (req as AuthedRequest).user!.id;

  const membership = await prisma.conversationParticipant.findFirst({
    where: { conversationId, userId },
  });

  if (!membership) {
    res.status(403).json({ message: "Forbidden" });
    return;
  }

  // Load conversation to determine whether this is a secret chat and compute TTL
  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId },
  });
  if (!conv) {
    res.status(404).json({ message: "Conversation not found" });
    return;
  }
  if ((conv as any).isSecret && (conv as any).secretStatus !== "ACTIVE") {
    res.status(409).json({ message: "Secret conversation is not active" });
    return;
  }

  let expiresAt: Date | undefined;
  if ((conv as any).isSecret) {
    const secretTtlSecondsValue = (conv as any).secretTtlSeconds as number | null | undefined;
    const ttlSeconds =
      typeof secretTtlSecondsValue === "number" && secretTtlSecondsValue > 0
        ? secretTtlSecondsValue
        : env.SECRET_MESSAGE_TTL_SECONDS;
    expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  }

  const message = await prisma.message.create({
    data: {
      conversationId,
      senderId: userId,
      type,
      content: content ?? null,
      replyToId: replyToId ?? null,
      ...(expiresAt ? { expiresAt } : {}),
      ...(metadata !== undefined ? { metadata: metadata as any } : {}),
      ...(attachments && attachments.length
        ? {
            attachments: {
              create: attachments.map((a) => ({
                url: a.url,
                type: a.type,
                size: a.size ?? null,
                ...(a.metadata !== undefined ? { metadata: a.metadata as any } : {}),
              })),
            },
          }
        : {}),
    },
    include: {
      sender: { select: { id: true, username: true, displayName: true } },
      attachments: true,
      replyTo: { select: { id: true, content: true, senderId: true, createdAt: true } },
    },
  });

  await prisma.conversation.update({
    where: { id: conversationId },
    data: { lastMessageAt: new Date() },
  });

  const io = getIO();
  io?.to(conversationId).emit("message:new", {
    conversationId,
    messageId: message.id,
    senderId: userId,
    message,
  });

  // Immediate notify event for tiles/unread without waiting for queries
  const recipients =
    (
      await prisma.conversation.findUnique({
        where: { id: conversationId },
        include: { participants: true },
      })
    )?.participants.map((p) => p.userId) ?? [];

  for (const rid of recipients) {
    if (rid !== userId) {
      io?.to(userRoom(rid)).emit("message:notify", {
        conversationId,
        messageId: message.id,
        senderId: userId,
        message,
      });
    }
  }

  // Link preview (Telegram-like unfurl): enqueue job and return immediately.
  // Disabled for secret conversations to avoid metadata leaks.
  try {
    const isSecret = Boolean((conv as any).isSecret);
    const contentForPreview = type === "TEXT" ? (content ?? null) : null;
    const firstUrl = !isSecret ? extractFirstUrl(contentForPreview) : null;
    if (firstUrl) {
      void enqueueLinkPreview({ messageId: message.id, conversationId, url: firstUrl }).catch(() => {});
    }
  } catch {}

  res.status(201).json({ message });
  }
);

export default router;

// Utilities
async function deduplicateUserConversations(userId: string) {
  // Pull all conversations user participates in
  const list = await prisma.conversation.findMany({
    where: { participants: { some: { userId } } },
    include: { participants: true },
    orderBy: [{ lastMessageAt: "desc" }, { createdAt: "desc" }],
  }) as any[];

  // Group by participants set + isGroup + isSecret
  const groups = new Map<string, typeof list>();
  for (const c of list) {
    const key = `${c.isGroup ? "G" : "D"}:${(c as any).isSecret ? "S" : "N"}:${c.participants
      .map((p: any) => p.userId)
      .sort()
      .join(",")}`;
    const arr = (groups.get(key) as any[]) || [];
    arr.push(c);
    groups.set(key, arr as any);
  }

  // For each duplicate group, keep the newest; delete the others entirely
  for (const [, arr] of groups) {
    if (arr.length <= 1) continue;
    const sorted = arr.sort((a, b) => {
      const ta = (a as any).lastMessageAt ?? (a as any).createdAt;
      const tb = (b as any).lastMessageAt ?? (b as any).createdAt;
      return new Date(tb as any).getTime() - new Date(ta as any).getTime();
    });
    const keep = sorted[0];
    const toDelete = sorted.slice(1);
    for (const conv of toDelete) {
      try {
        await prisma.$transaction([
          prisma.messageReceipt.deleteMany({ where: { message: { conversationId: conv.id } } }),
          prisma.messageAttachment.deleteMany({ where: { message: { conversationId: conv.id } } }),
          prisma.messageReaction.deleteMany({ where: { message: { conversationId: conv.id } } }),
          prisma.message.deleteMany({ where: { conversationId: conv.id } }),
          prisma.conversationParticipant.deleteMany({ where: { conversationId: conv.id } }),
          prisma.conversation.delete({ where: { id: conv.id } }),
        ]);
      } catch {}
    }
  }
}

