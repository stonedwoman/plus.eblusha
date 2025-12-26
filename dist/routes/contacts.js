"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const prisma_1 = __importDefault(require("../lib/prisma"));
const auth_1 = require("../middlewares/auth");
const socket_1 = require("../realtime/socket");
const router = (0, express_1.Router)();
router.use(auth_1.authenticate);
// GET /contacts?filter=accepted|incoming|outgoing|all (default accepted)
router.get("/", async (req, res) => {
    const filter = req.query.filter ?? "accepted";
    const userId = req.user.id;
    if (!["accepted", "incoming", "outgoing", "all"].includes(filter)) {
        res.status(400).json({ message: "Invalid filter" });
        return;
    }
    const whereByFilter = () => {
        switch (filter) {
            case "incoming":
                return { addresseeId: userId, status: "PENDING" };
            case "outgoing":
                return { requesterId: userId, status: "PENDING" };
            case "all":
                return {
                    OR: [
                        { requesterId: userId },
                        { addresseeId: userId },
                    ],
                };
            case "accepted":
            default:
                return {
                    OR: [
                        { requesterId: userId, status: "ACCEPTED" },
                        { addresseeId: userId, status: "ACCEPTED" },
                    ],
                };
        }
    };
    const contacts = await prisma_1.default.contact.findMany({
        where: whereByFilter(),
        include: {
            requester: { select: { id: true, username: true, displayName: true, avatarUrl: true, status: true, eblid: true } },
            addressee: { select: { id: true, username: true, displayName: true, avatarUrl: true, status: true, eblid: true } },
        },
        orderBy: { updatedAt: "desc" },
    });
    const items = contacts.map((c) => {
        const direction = c.requesterId === userId ? "outgoing" : "incoming";
        const friend = c.requesterId === userId ? c.addressee : c.requester;
        return {
            id: c.id,
            status: c.status,
            direction,
            friend,
        };
    });
    res.json({ contacts: items });
});
// POST /contacts/add { identifier }
router.post("/add", async (req, res) => {
    const schema = zod_1.z.object({ identifier: zod_1.z.string().min(2) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ message: "Invalid request" });
        return;
    }
    const userId = req.user.id;
    const identifier = parsed.data.identifier.trim();
    const target = await prisma_1.default.user.findFirst({
        where: {
            OR: [
                { username: identifier },
                { email: identifier },
                { phone: identifier },
                ...(/^\d{4}$/.test(identifier) ? [{ eblid: identifier }] : []),
            ],
        },
        select: { id: true, username: true, displayName: true },
    });
    if (!target) {
        res.status(404).json({ message: "User not found" });
        return;
    }
    if (target.id === userId) {
        res.status(400).json({ message: "Cannot add yourself" });
        return;
    }
    const existing = await prisma_1.default.contact.findFirst({
        where: {
            OR: [
                { requesterId: userId, addresseeId: target.id },
                { requesterId: target.id, addresseeId: userId },
            ],
        },
    });
    if (existing) {
        res.status(409).json({ message: "Contact already exists", contactId: existing.id, status: existing.status });
        return;
    }
    const contact = await prisma_1.default.contact.create({
        data: {
            requesterId: userId,
            addresseeId: target.id,
            status: "PENDING",
        },
    });
    // notify addressee
    (0, socket_1.getIO)()?.to(target.id).emit("contacts:request:new", {
        contactId: contact.id,
        from: { id: req.user.id, username: req.user.username },
    });
    res.status(201).json({ contact });
});
// POST /contacts/respond { contactId, action: accept|reject|block }
router.post("/respond", async (req, res) => {
    const schema = zod_1.z.object({
        contactId: zod_1.z.string().cuid(),
        action: zod_1.z.enum(["accept", "reject", "block"]),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ message: "Invalid request" });
        return;
    }
    const userId = req.user.id;
    const { contactId, action } = parsed.data;
    const contact = await prisma_1.default.contact.findUnique({ where: { id: contactId } });
    if (!contact) {
        res.status(404).json({ message: "Contact not found" });
        return;
    }
    // Только адресат может принять/отклонить входящий запрос
    if (action !== "block" && contact.addresseeId !== userId) {
        res.status(403).json({ message: "Forbidden" });
        return;
    }
    if (action === "reject") {
        await prisma_1.default.contact.delete({ where: { id: contactId } });
        res.status(204).send();
        return;
    }
    if (action === "block") {
        const updated = await prisma_1.default.contact.update({ where: { id: contactId }, data: { status: "BLOCKED" } });
        (0, socket_1.getIO)()?.to(contact.requesterId).emit("contacts:request:blocked", { contactId });
        res.json({ contact: updated });
        return;
    }
    const updated = await prisma_1.default.contact.update({ where: { id: contactId }, data: { status: "ACCEPTED" } });
    // auto create 1:1 conversation if not exists
    let existing = await prisma_1.default.conversation.findFirst({
        where: {
            isGroup: false,
            AND: [
                { participants: { some: { userId: contact.requesterId } } },
                { participants: { some: { userId: contact.addresseeId } } },
            ],
        },
        select: { id: true },
    });
    if (!existing) {
        const conv = await prisma_1.default.conversation.create({
            data: {
                isGroup: false,
                participants: { create: [{ userId: contact.requesterId }, { userId: contact.addresseeId }] },
            },
        });
        (0, socket_1.getIO)()?.to(contact.requesterId).emit("conversations:new", { conversationId: conv.id });
        (0, socket_1.getIO)()?.to(contact.addresseeId).emit("conversations:new", { conversationId: conv.id });
    }
    (0, socket_1.getIO)()?.to(contact.requesterId).emit("contacts:request:accepted", { contactId });
    res.json({ contact: updated });
});
// GET /contacts/search?query=... (supports EBLID exact 4 digits)
router.get("/search", async (req, res) => {
    const query = req.query.query?.trim();
    if (!query || query.length < 2) {
        res.json({ results: [] });
        return;
    }
    // EBLID exact match (4 digits)
    if (/^\d{4}$/.test(query)) {
        const user = await prisma_1.default.user.findFirst({
            where: { eblid: query },
            select: { id: true, username: true, displayName: true, avatarUrl: true, status: true },
        });
        res.json({ results: user ? [user] : [] });
        return;
    }
    const results = await prisma_1.default.user.findMany({
        where: {
            OR: [
                { username: { contains: query, mode: "insensitive" } },
                { email: { contains: query, mode: "insensitive" } },
                { phone: { contains: query, mode: "insensitive" } },
            ],
        },
        take: 10,
        select: { id: true, username: true, displayName: true, avatarUrl: true, status: true },
    });
    res.json({ results });
});
// POST /contacts/remove { contactId }
router.post("/remove", async (req, res) => {
    const schema = zod_1.z.object({ contactId: zod_1.z.string().cuid() });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ message: "Invalid request" });
        return;
    }
    const userId = req.user.id;
    const { contactId } = parsed.data;
    const contact = await prisma_1.default.contact.findUnique({ where: { id: contactId } });
    if (!contact)
        return res.status(404).json({ message: "Contact not found" });
    if (contact.requesterId !== userId && contact.addresseeId !== userId) {
        return res.status(403).json({ message: "Forbidden" });
    }
    await prisma_1.default.contact.delete({ where: { id: contactId } });
    // notify both sides
    (0, socket_1.getIO)()?.to(contact.requesterId).emit("contacts:removed", { contactId });
    (0, socket_1.getIO)()?.to(contact.addresseeId).emit("contacts:removed", { contactId });
    res.json({ success: true });
});
exports.default = router;
//# sourceMappingURL=contacts.js.map