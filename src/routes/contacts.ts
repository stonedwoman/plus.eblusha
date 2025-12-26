import { Router } from "express";
import { z } from "zod";
import prisma from "../lib/prisma";
import { authenticate } from "../middlewares/auth";
import { getIO } from "../realtime/socket";

const router = Router();

router.use(authenticate);

// GET /contacts?filter=accepted|incoming|outgoing|all (default accepted)
router.get("/", async (req, res) => {
  const filter = (req.query.filter as string | undefined) ?? "accepted";
  const userId = (req as any).user!.id as string;

  if (!["accepted", "incoming", "outgoing", "all"].includes(filter)) {
    res.status(400).json({ message: "Invalid filter" });
    return;
  }

  const whereByFilter = () => {
    switch (filter) {
      case "incoming":
        return { addresseeId: userId, status: "PENDING" as const };
      case "outgoing":
        return { requesterId: userId, status: "PENDING" as const };
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
            { requesterId: userId, status: "ACCEPTED" as const },
            { addresseeId: userId, status: "ACCEPTED" as const },
          ],
        };
    }
  };

  const contacts = await prisma.contact.findMany({
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
  const schema = z.object({ identifier: z.string().min(2) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request" });
    return;
  }
  const userId = (req as any).user!.id as string;
  const identifier = parsed.data.identifier.trim();

  const target = await prisma.user.findFirst({
    where: {
      OR: [
        { username: identifier },
        { email: identifier },
        { phone: identifier },
        ...( /^\d{4}$/.test(identifier) ? [{ eblid: identifier }] : [] ),
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

  const existing = await prisma.contact.findFirst({
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

  const contact = await prisma.contact.create({
    data: {
      requesterId: userId,
      addresseeId: target.id,
      status: "PENDING",
    },
  });

  // notify addressee
  getIO()?.to(target.id).emit("contacts:request:new", {
    contactId: contact.id,
    from: { id: (req as any).user!.id, username: (req as any).user!.username },
  });

  res.status(201).json({ contact });
});

// POST /contacts/respond { contactId, action: accept|reject|block }
router.post("/respond", async (req, res) => {
  const schema = z.object({
    contactId: z.string().cuid(),
    action: z.enum(["accept", "reject", "block"]),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request" });
    return;
  }
  const userId = (req as any).user!.id as string;
  const { contactId, action } = parsed.data;

  const contact = await prisma.contact.findUnique({ where: { id: contactId } });
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
    await prisma.contact.delete({ where: { id: contactId } });
    res.status(204).send();
    return;
  }
  if (action === "block") {
    const updated = await prisma.contact.update({ where: { id: contactId }, data: { status: "BLOCKED" } });
    getIO()?.to(contact.requesterId).emit("contacts:request:blocked", { contactId });
    res.json({ contact: updated });
    return;
  }

  const updated = await prisma.contact.update({ where: { id: contactId }, data: { status: "ACCEPTED" } });
  // auto create 1:1 conversation if not exists
  let existing = await prisma.conversation.findFirst({
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
    const conv = await prisma.conversation.create({
      data: {
        isGroup: false,
        participants: { create: [{ userId: contact.requesterId }, { userId: contact.addresseeId }] },
      },
    });
    getIO()?.to(contact.requesterId).emit("conversations:new", { conversationId: conv.id });
    getIO()?.to(contact.addresseeId).emit("conversations:new", { conversationId: conv.id });
  }
  getIO()?.to(contact.requesterId).emit("contacts:request:accepted", { contactId });
  res.json({ contact: updated });
});

// GET /contacts/search?query=... (supports EBLID exact 4 digits)
router.get("/search", async (req, res) => {
  const query = (req.query.query as string | undefined)?.trim();
  if (!query || query.length < 2) {
    res.json({ results: [] });
    return;
  }
  // EBLID exact match (4 digits)
  if (/^\d{4}$/.test(query)) {
    const user = await prisma.user.findFirst({
      where: { eblid: query },
      select: { id: true, username: true, displayName: true, avatarUrl: true, status: true },
    });
    res.json({ results: user ? [user] : [] });
    return;
  }
  const results = await prisma.user.findMany({
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
  const schema = z.object({ contactId: z.string().cuid() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request" });
    return;
  }
  const userId = (req as any).user!.id as string;
  const { contactId } = parsed.data;

  const contact = await prisma.contact.findUnique({ where: { id: contactId } });
  if (!contact) return res.status(404).json({ message: "Contact not found" });
  if (contact.requesterId !== userId && contact.addresseeId !== userId) {
    return res.status(403).json({ message: "Forbidden" });
  }

  await prisma.contact.delete({ where: { id: contactId } });
  // notify both sides
  getIO()?.to(contact.requesterId).emit("contacts:removed", { contactId });
  getIO()?.to(contact.addresseeId).emit("contacts:removed", { contactId });
  res.json({ success: true });
});

export default router;



