import { Router, type Request } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import prisma from "../lib/prisma";
import { authenticate } from "../middlewares/auth";
import { getIO } from "../realtime/socket";

const router = Router();

type AuthedRequest = Request & { user?: { id: string } };

router.use(authenticate);

const previewParamsSchema = z.object({ messageId: z.string().cuid() });

router.get("/:messageId/preview", async (req, res) => {
  const parsedParams = previewParamsSchema.safeParse(req.params);
  if (!parsedParams.success) {
    res.status(400).json({ message: "Invalid message id" });
    return;
  }

  const { messageId } = parsedParams.data;
  const userId = (req as AuthedRequest).user!.id;

  const message = await prisma.message.findUnique({
    where: { id: messageId },
    select: {
      id: true,
      content: true,
      conversationId: true,
      senderId: true,
      createdAt: true,
      attachments: {
        select: {
          id: true,
          type: true,
        },
      },
    },
  });

  if (!message) {
    res.status(404).json({ message: "Message not found" });
    return;
  }

  const participantCount = await prisma.conversationParticipant.count({
    where: { conversationId: message.conversationId, userId },
  });

  if (participantCount === 0) {
    res.status(403).json({ message: "Forbidden" });
    return;
  }

  res.json({ message });
});

const updateStatusSchema = z.object({
  messageIds: z.array(z.string().cuid()).min(1),
  status: z.enum(["DELIVERED", "READ", "SEEN"]),
});

router.post("/receipts", async (req, res) => {
  const parsed = updateStatusSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid receipt payload" });
    return;
  }

  const { messageIds, status } = parsed.data;
  const userId = (req as AuthedRequest).user!.id;

  const ops = messageIds.map((messageId) =>
    prisma.messageReceipt.upsert({
      where: {
        messageId_userId: {
          messageId,
          userId,
        },
      },
      update: { status },
      create: { messageId, userId, status },
    })
  );
  const receipts = await prisma.$transaction(ops);

  // Notify participants in affected conversations to refresh receipts
  if (messageIds.length > 0) {
    const meta = await prisma.message.findMany({
      where: { id: { in: messageIds } },
      select: { id: true, conversationId: true },
    });
    const byConv = new Map<string, string[]>();
    for (const m of meta) {
      const list = byConv.get(m.conversationId) ?? [];
      list.push(m.id);
      byConv.set(m.conversationId, list);
    }
    for (const [conversationId, ids] of byConv.entries()) {
      getIO()?.to(conversationId).emit("receipts:update", { conversationId, messageIds: ids });
    }
  }

  res.json({ receipts });
});

const reactSchema = z.object({
  messageId: z.string().cuid(),
  emoji: z.string().min(1),
});

router.post("/react", async (req, res) => {
  const parsed = reactSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid reaction" });
    return;
  }

  const { messageId, emoji } = parsed.data;
  const userId = (req as AuthedRequest).user!.id;

  const message = await prisma.message.findUnique({ where: { id: messageId } });
  if (!message) {
    res.status(404).json({ message: "Message not found" });
    return;
  }

  const reaction = await prisma.messageReaction.upsert({
    where: {
      messageId_userId_emoji: {
        messageId,
        userId,
        emoji,
      },
    },
    update: {},
    create: { messageId, userId, emoji },
  });

  getIO()?.to(message.conversationId).emit("message:reaction", { conversationId: message.conversationId, messageId, senderId: userId });

  res.json({ reaction });
});

router.post("/unreact", async (req, res) => {
  const parsed = reactSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid reaction" });
    return;
  }

  const { messageId, emoji } = parsed.data;
  const userId = (req as AuthedRequest).user!.id;

  const message = await prisma.message.findUnique({ where: { id: messageId } });
  if (!message) {
    res.status(404).json({ message: "Message not found" });
    return;
  }

  await prisma.messageReaction.deleteMany({
    where: {
      messageId,
      userId,
      emoji,
    },
  });

  getIO()?.to(message.conversationId).emit("message:reaction", { conversationId: message.conversationId, messageId, senderId: userId });

  res.json({ success: true });
});

const deleteSchema = z.object({ messageId: z.string().cuid() });

router.post("/delete", async (req, res) => {
  const parsed = deleteSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid message id" });
    return;
  }
  const { messageId } = parsed.data;
  const userId = (req as AuthedRequest).user!.id;

  const msg = await prisma.message.findUnique({ where: { id: messageId } });
  if (!msg) return res.status(404).json({ message: "Not found" });
  if (msg.senderId !== userId) return res.status(403).json({ message: "Forbidden" });

  await prisma.$transaction([
    prisma.messageAttachment.deleteMany({ where: { messageId } }),
    prisma.messageReaction.deleteMany({ where: { messageId } }),
    prisma.message.update({ where: { id: messageId }, data: { deletedAt: new Date(), content: null, metadata: Prisma.DbNull } }),
  ]);
  getIO()?.to(msg.conversationId).emit("message:update", { conversationId: msg.conversationId, messageId, reason: "deleted" });
  res.json({ success: true });
});

// Mark an entire conversation as READ for current user
const markConversationSchema = z.object({ conversationId: z.string().cuid() });

router.post("/mark-conversation-read", async (req, res) => {
  const parsed = markConversationSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid payload" });
    return;
  }
  const { conversationId } = parsed.data;
  const userId = (req as AuthedRequest).user!.id;

  // Create receipts for messages without any receipt from this user
  const missing = await prisma.message.findMany({
    where: {
      conversationId,
      senderId: { not: userId },
      receipts: { none: { userId } },
    },
    select: { id: true },
  });
  if (missing.length) {
    await prisma.messageReceipt.createMany({
      data: missing.map((m) => ({ messageId: m.id, userId, status: "READ" })),
      skipDuplicates: true,
    });
  }

  // Upgrade any non-read receipts to READ
  await prisma.messageReceipt.updateMany({
    where: { userId, status: { notIn: ["READ", "SEEN"] }, message: { conversationId } },
    data: { status: "READ" },
  });

  getIO()?.to(conversationId).emit("receipts:update", { conversationId, messageIds: missing.map((m) => m.id) });
  res.json({ success: true });
});

export default router;

