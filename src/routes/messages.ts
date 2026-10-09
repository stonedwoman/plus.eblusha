import { Router, type Request } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import prisma from "../lib/prisma";
import { deleteS3ObjectsByUrls } from "../lib/storageDeletion";
import { extractFirstUrl } from "../lib/linkPreview";
import { authenticate } from "../middlewares/auth";
import { getIO } from "../realtime/socket";
import { enqueueLinkPreview } from "../jobs/queue";
import { rateLimit } from "../middlewares/rateLimit";
import { scheduleReadSync } from "../push/readSync";
import {
  isSecretConversation,
  logSecretCloudWriteBlocked,
  rejectSecretCloudWrite,
} from "../lib/secretLatch";

const router = Router();

/** Shipped on every Message payload that includes reactions (tooltip / UI). */
const messageReactionsWithUser = {
  include: { user: { select: { id: true, username: true, displayName: true } } },
};

type AuthedRequest = Request & { user?: { id: string } };

router.use(authenticate);

/** Беседа сообщения — для защёлки S1 (секретная беседа: облачные Message не трогаем). */
async function conversationKind(conversationId: string) {
  return prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { type: true, isSecret: true },
  });
}

async function isConversationMember(conversationId: string, userId: string): Promise<boolean> {
  const n = await prisma.conversationParticipant.count({ where: { conversationId, userId } });
  return n > 0;
}

const previewParamsSchema = z.object({ messageId: z.string().cuid() });

router.get(
  "/:messageId/preview",
  rateLimit({ name: "preview_enqueue", windowMs: 60_000, max: 30 }),
  async (req, res) => {
  const parsedParams = previewParamsSchema.safeParse(req.params);
  if (!parsedParams.success) {
    res.status(400).json({ message: "Invalid message id" });
    return;
  }

  const { messageId } = parsedParams.data;
  const userId = (req as AuthedRequest).user!.id;

  const message = await prisma.message.findUnique({
    where: { id: messageId },
    include: {
      sender: { select: { id: true, username: true, displayName: true } },
      attachments: true,
      reactions: messageReactionsWithUser,
      receipts: true,
      replyTo: { select: { id: true, content: true, senderId: true, createdAt: true } },
    }
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

  // Do not generate previews for secret chats (privacy).
  // В секретной беседе (в т.ч. CANCELLED) облачную строку не трогаем вовсе (S1).
  const conv = await conversationKind(message.conversationId);
  const isSecret = isSecretConversation(conv);

  const meta = (message as any).metadata && typeof (message as any).metadata === "object" ? (message as any).metadata : null;
  const existingPreview = meta?.linkPreview ?? null;
  if (existingPreview || isSecret || message.type !== "TEXT" || typeof message.content !== "string") {
    res.json({ message, preview: existingPreview, disabled: isSecret });
    return;
  }

  const firstUrl = extractFirstUrl(message.content);
  if (!firstUrl) {
    // Mark attempt to avoid repeated fetches
    const updated = await prisma.message.update({
      where: { id: messageId },
      data: {
        metadata: {
          ...(meta && typeof meta === "object" ? meta : {}),
          linkPreviewAttemptedAt: new Date().toISOString(),
          linkPreviewUrl: null,
        } as any,
      },
      include: {
        sender: { select: { id: true, username: true, displayName: true } },
        attachments: true,
        reactions: messageReactionsWithUser,
        receipts: true,
        replyTo: { select: { id: true, content: true, senderId: true, createdAt: true } },
      },
    });
    res.json({ message: updated, preview: null });
    return;
  }

  // Enqueue preview generation (API does not wait).
  let enqueued = false;
  let softLimited = false;
  try {
    enqueued = await enqueueLinkPreview(
      { messageId, conversationId: message.conversationId, url: firstUrl },
      { userId, conversationId: message.conversationId }
    );
    softLimited = !enqueued;
  } catch {}

  const updated = await prisma.message.update({
    where: { id: messageId },
    data: {
      metadata: {
        ...(meta && typeof meta === "object" ? meta : {}),
        linkPreviewAttemptedAt: new Date().toISOString(),
        linkPreviewUrl: firstUrl,
      } as any,
    },
    include: {
      sender: { select: { id: true, username: true, displayName: true } },
      attachments: true,
      reactions: messageReactionsWithUser,
      receipts: true,
      replyTo: { select: { id: true, content: true, senderId: true, createdAt: true } },
    },
  });

  res.json({ message: updated, preview: null, enqueued, softLimited });
  }
);

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

  // Для read-sync (тихий пуш «прочитано» на другие устройства): какие сообщения ЧУЖИХ людей этим
  // запросом стали прочитанными впервые. Снимок статусов — до записи, иначе «было/стало» не отличить.
  const isReadStatus = status === "READ" || status === "SEEN";
  const alreadyRead = new Set<string>();
  if (isReadStatus) {
    const prev = await prisma.messageReceipt.findMany({
      where: { userId, messageId: { in: messageIds }, status: { in: ["READ", "SEEN"] } },
      select: { messageId: true },
    });
    for (const r of prev) alreadyRead.add(r.messageId);
  }

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
      select: { id: true, conversationId: true, senderId: true },
    });
    const byConv = new Map<string, string[]>();
    const newlyReadConvs = new Set<string>();
    for (const m of meta) {
      const list = byConv.get(m.conversationId) ?? [];
      list.push(m.id);
      byConv.set(m.conversationId, list);
      if (isReadStatus && m.senderId !== userId && !alreadyRead.has(m.id)) newlyReadConvs.add(m.conversationId);
    }
    scheduleReadSync(req, userId, newlyReadConvs);
    const receiptByMessageId = new Map(receipts.map((receipt) => [receipt.messageId, receipt]));
    for (const [conversationId, ids] of byConv.entries()) {
      getIO()?.to(conversationId).emit("receipts:update", {
        conversationId,
        messageIds: ids,
        userId,
        status,
        receipts: ids.map((id) => receiptByMessageId.get(id)).filter(Boolean),
      });
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
  // Реагировать можно только на сообщения своих бесед (раньше — на любое по id).
  if (!(await isConversationMember(message.conversationId, userId))) {
    res.status(403).json({ message: "Forbidden" });
    return;
  }
  if (isSecretConversation(await conversationKind(message.conversationId))) {
    logSecretCloudWriteBlocked("POST /messages/react", { conversationId: message.conversationId, userId, messageId });
    rejectSecretCloudWrite(res);
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
  if (!(await isConversationMember(message.conversationId, userId))) {
    res.status(403).json({ message: "Forbidden" });
    return;
  }
  // Снять свою реакцию можно и в секретке: это только убирает открытые данные (lib/secretLatch).

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
  // Удаление в секретке разрешено: оно обнуляет content/metadata и сносит вложения и реакции,
  // то есть только уменьшает объём открытых данных. Облачная строка, оказавшаяся в секретке
  // (легаси/записанная до S1), отправитель так может стереть (lib/secretLatch).

  // Fetch attachment URLs before deletion so we can attempt to delete blobs in S3 as well.
  const attachmentUrls = (
    await prisma.messageAttachment.findMany({
      where: { messageId },
      select: { url: true },
    })
  ).map((a) => a.url);

  await prisma.$transaction([
    prisma.messageAttachment.deleteMany({ where: { messageId } }),
    prisma.messageReaction.deleteMany({ where: { messageId } }),
    prisma.message.update({ where: { id: messageId }, data: { deletedAt: new Date(), content: null, metadata: Prisma.DbNull } }),
  ]);

  // Best-effort S3 deletion (do not block the response; do not throw).
  if (attachmentUrls.length) {
    void deleteS3ObjectsByUrls(attachmentUrls, { reason: `message:${messageId}` });
  }
  getIO()?.to(msg.conversationId).emit("message:update", { conversationId: msg.conversationId, messageId, reason: "deleted" });
  res.json({ success: true });
});

const updateMessageSchema = z.object({
  messageId: z.string().cuid(),
  content: z
    .string()
    .max(8000)
    .refine((v) => v.trim().length > 0, "Message content cannot be empty"),
});

router.post("/update", async (req, res) => {
  const parsed = updateMessageSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid update payload" });
    return;
  }

  const { messageId, content } = parsed.data;
  const userId = (req as AuthedRequest).user!.id;

  const existing = await prisma.message.findUnique({
    where: { id: messageId },
    select: { id: true, conversationId: true, senderId: true, deletedAt: true, type: true, metadata: true },
  });
  if (!existing) {
    res.status(404).json({ message: "Message not found" });
    return;
  }
  if (existing.senderId !== userId) {
    res.status(403).json({ message: "Forbidden" });
    return;
  }
  if (existing.deletedAt) {
    res.status(409).json({ message: "Message was deleted" });
    return;
  }
  if (existing.type !== "TEXT") {
    res.status(409).json({ message: "Only text messages can be edited" });
    return;
  }

  const membership = await prisma.conversationParticipant.findFirst({
    where: { conversationId: existing.conversationId, userId },
  });
  if (!membership) {
    res.status(403).json({ message: "Forbidden" });
    return;
  }
  if (isSecretConversation(await conversationKind(existing.conversationId))) {
    logSecretCloudWriteBlocked("POST /messages/update", { conversationId: existing.conversationId, userId, messageId });
    rejectSecretCloudWrite(res);
    return;
  }

  const meta =
    existing.metadata && typeof existing.metadata === "object" ? (existing.metadata as Record<string, unknown>) : {};
  const prevVer = typeof (meta as any).editVersion === "number" ? ((meta as any).editVersion as number) : 0;
  const editedAt = new Date().toISOString();
  const nextMeta = {
    ...meta,
    editedAt,
    editVersion: prevVer + 1,
  } as any;

  const updated = await prisma.message.update({
    where: { id: messageId },
    data: { content, metadata: nextMeta },
    include: {
      sender: { select: { id: true, username: true, displayName: true } },
      attachments: true,
      reactions: messageReactionsWithUser,
      receipts: true,
      replyTo: { select: { id: true, content: true, senderId: true, createdAt: true } },
    },
  });

  getIO()?.to(existing.conversationId).emit("message:update", {
    conversationId: existing.conversationId,
    messageId,
    reason: "edited",
    message: updated,
  });

  res.json({ message: updated });
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

  // Секретная беседа: облачных Message (и квитанций) в ней нет, писать в БД нечего. Вызов
  // нужен только как сигнал «прочитано здесь» — по нему другие iOS-устройства человека снимают
  // баннеры (read-sync, см. push/readSync.ts). Чужую беседу молча игнорируем.
  if (isSecretConversation(await conversationKind(conversationId))) {
    if (await isConversationMember(conversationId, userId)) scheduleReadSync(req, userId, [conversationId]);
    res.json({ success: true });
    return;
  }

  // Create receipts for messages without any receipt from this user
  const missing = await prisma.message.findMany({
    where: {
      conversationId,
      senderId: { not: userId },
      receipts: { none: { userId } },
    },
    select: { id: true },
  });
  const upgradable = await prisma.message.findMany({
    where: {
      conversationId,
      senderId: { not: userId },
      receipts: { some: { userId, status: { notIn: ["READ", "SEEN"] } } },
    },
    select: { id: true },
  });
  const changedIds = Array.from(new Set([...missing.map((m) => m.id), ...upgradable.map((m) => m.id)]));

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

  if (changedIds.length) {
    getIO()?.to(conversationId).emit("receipts:update", {
      conversationId,
      messageIds: changedIds,
      userId,
      status: "READ",
      receipts: changedIds.map((messageId) => ({ messageId, userId, status: "READ" })),
    });
    // Что-то реально стало прочитанным — другие iOS-устройства снимут баннеры беседы.
    scheduleReadSync(req, userId, [conversationId]);
  }
  res.json({ success: true });
});

export default router;

