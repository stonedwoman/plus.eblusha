"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const client_1 = require("@prisma/client");
const zod_1 = require("zod");
const prisma_1 = __importDefault(require("../lib/prisma"));
const auth_1 = require("../middlewares/auth");
const socket_1 = require("../realtime/socket");
const router = (0, express_1.Router)();
router.use(auth_1.authenticate);
const updateStatusSchema = zod_1.z.object({
    messageIds: zod_1.z.array(zod_1.z.string().cuid()).min(1),
    status: zod_1.z.enum(["DELIVERED", "READ", "SEEN"]),
});
router.post("/receipts", async (req, res) => {
    const parsed = updateStatusSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ message: "Invalid receipt payload" });
        return;
    }
    const { messageIds, status } = parsed.data;
    const userId = req.user.id;
    const ops = messageIds.map((messageId) => prisma_1.default.messageReceipt.upsert({
        where: {
            messageId_userId: {
                messageId,
                userId,
            },
        },
        update: { status },
        create: { messageId, userId, status },
    }));
    const receipts = await prisma_1.default.$transaction(ops);
    // Notify participants in affected conversations to refresh receipts
    if (messageIds.length > 0) {
        const meta = await prisma_1.default.message.findMany({
            where: { id: { in: messageIds } },
            select: { id: true, conversationId: true },
        });
        const byConv = new Map();
        for (const m of meta) {
            const list = byConv.get(m.conversationId) ?? [];
            list.push(m.id);
            byConv.set(m.conversationId, list);
        }
        for (const [conversationId, ids] of byConv.entries()) {
            (0, socket_1.getIO)()?.to(conversationId).emit("receipts:update", { conversationId, messageIds: ids });
        }
    }
    res.json({ receipts });
});
const reactSchema = zod_1.z.object({
    messageId: zod_1.z.string().cuid(),
    emoji: zod_1.z.string().min(1),
});
router.post("/react", async (req, res) => {
    const parsed = reactSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ message: "Invalid reaction" });
        return;
    }
    const { messageId, emoji } = parsed.data;
    const userId = req.user.id;
    const message = await prisma_1.default.message.findUnique({ where: { id: messageId } });
    if (!message) {
        res.status(404).json({ message: "Message not found" });
        return;
    }
    const reaction = await prisma_1.default.messageReaction.upsert({
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
    (0, socket_1.getIO)()?.to(message.conversationId).emit("message:new", { conversationId: message.conversationId, messageId, senderId: userId });
    res.json({ reaction });
});
const deleteSchema = zod_1.z.object({ messageId: zod_1.z.string().cuid() });
router.post("/delete", async (req, res) => {
    const parsed = deleteSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ message: "Invalid message id" });
        return;
    }
    const { messageId } = parsed.data;
    const userId = req.user.id;
    const msg = await prisma_1.default.message.findUnique({ where: { id: messageId } });
    if (!msg)
        return res.status(404).json({ message: "Not found" });
    if (msg.senderId !== userId)
        return res.status(403).json({ message: "Forbidden" });
    await prisma_1.default.$transaction([
        prisma_1.default.messageAttachment.deleteMany({ where: { messageId } }),
        prisma_1.default.messageReaction.deleteMany({ where: { messageId } }),
        prisma_1.default.message.update({ where: { id: messageId }, data: { deletedAt: new Date(), content: null, metadata: client_1.Prisma.DbNull } }),
    ]);
    (0, socket_1.getIO)()?.to(msg.conversationId).emit("message:update", { conversationId: msg.conversationId, messageId, reason: "deleted" });
    res.json({ success: true });
});
// Mark an entire conversation as READ for current user
const markConversationSchema = zod_1.z.object({ conversationId: zod_1.z.string().cuid() });
router.post("/mark-conversation-read", async (req, res) => {
    const parsed = markConversationSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ message: "Invalid payload" });
        return;
    }
    const { conversationId } = parsed.data;
    const userId = req.user.id;
    // Create receipts for messages without any receipt from this user
    const missing = await prisma_1.default.message.findMany({
        where: {
            conversationId,
            senderId: { not: userId },
            receipts: { none: { userId } },
        },
        select: { id: true },
    });
    if (missing.length) {
        await prisma_1.default.messageReceipt.createMany({
            data: missing.map((m) => ({ messageId: m.id, userId, status: "READ" })),
            skipDuplicates: true,
        });
    }
    // Upgrade any non-read receipts to READ
    await prisma_1.default.messageReceipt.updateMany({
        where: { userId, status: { notIn: ["READ", "SEEN"] }, message: { conversationId } },
        data: { status: "READ" },
    });
    (0, socket_1.getIO)()?.to(conversationId).emit("receipts:update", { conversationId, messageIds: missing.map((m) => m.id) });
    res.json({ success: true });
});
exports.default = router;
//# sourceMappingURL=messages.js.map