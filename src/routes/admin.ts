import { Router } from "express";
import { z } from "zod";
import { requireAdmin } from "../middlewares/adminAuth";
import {
  banUser,
  getAdminUserDetails,
  listAdminUsers,
  softDeleteUser,
  unbanUser,
} from "../lib/adminUsers";
import { buildStorageReport } from "../lib/adminStorage";
import prisma from "../lib/prisma";
import logger from "../config/logger";

const router = Router();

router.use(requireAdmin);

router.get("/ping", (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

const listSchema = z.object({
  search: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

router.get("/users", async (req, res) => {
  const parsed = listSchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid query", errors: parsed.error.flatten() });
    return;
  }
  const { search, limit, offset } = parsed.data;
  const result = await listAdminUsers({
    ...(search ? { search } : {}),
    limit,
    offset,
  });
  res.json(result);
});

router.get("/users/:id", async (req, res) => {
  const id = String(req.params.id || "").trim();
  if (!id) {
    res.status(400).json({ message: "Missing user id" });
    return;
  }
  const details = await getAdminUserDetails(id);
  if (!details) {
    res.status(404).json({ message: "User not found" });
    return;
  }
  res.json({ user: details });
});

const banSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});

router.post("/users/:id/ban", async (req, res) => {
  const id = String(req.params.id || "").trim();
  if (!id) {
    res.status(400).json({ message: "Missing user id" });
    return;
  }
  const parsed = banSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid payload", errors: parsed.error.flatten() });
    return;
  }
  const result = await banUser(id, parsed.data.reason ?? null);
  if (!result) {
    res.status(404).json({ message: "User not found" });
    return;
  }
  logger.warn({ adminAction: "ban", userId: id, reason: parsed.data.reason ?? null }, "User banned by admin");
  res.json({ ok: true, user: result });
});

router.post("/users/:id/unban", async (req, res) => {
  const id = String(req.params.id || "").trim();
  if (!id) {
    res.status(400).json({ message: "Missing user id" });
    return;
  }
  try {
    const result = await unbanUser(id);
    if (!result) {
      res.status(404).json({ message: "User not found" });
      return;
    }
    logger.warn({ adminAction: "unban", userId: id }, "User unbanned by admin");
    res.json({ ok: true, user: result });
  } catch (error: any) {
    res.status(409).json({ message: error?.message ?? "Cannot unban" });
  }
});

const deleteSchema = z.object({
  confirmUsername: z.string().trim().min(1),
});

router.delete("/users/:id", async (req, res) => {
  const id = String(req.params.id || "").trim();
  if (!id) {
    res.status(400).json({ message: "Missing user id" });
    return;
  }
  // Require operator to retype the username (or `id:<userId>`) so a bad
  // click on the wrong row in the admin UI can't nuke an account silently.
  const parsed = deleteSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid payload", errors: parsed.error.flatten() });
    return;
  }
  const details = await getAdminUserDetails(id);
  if (!details) {
    res.status(404).json({ message: "User not found" });
    return;
  }
  const expected = details.username;
  const got = parsed.data.confirmUsername;
  if (got !== expected && got !== `id:${id}`) {
    res.status(409).json({
      message: "confirmUsername must match the user's username (or 'id:<userId>')",
    });
    return;
  }
  const result = await softDeleteUser(id);
  logger.warn({ adminAction: "delete", userId: id }, "User account deleted (anonymized) by admin");
  res.json({ ok: true, user: result });
});

router.get("/storage", async (req, res) => {
  const walk = String((req.query as any)?.walk ?? "") === "1";
  const report = await buildStorageReport({ walk });
  res.json(report);
});

router.get("/summary", async (_req, res) => {
  // High-level dashboard counts. Cheap aggregates only.
  const [totalUsers, banned, deleted, devices, activeDevices, storage] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { bannedAt: { not: null } } }),
    prisma.user.count({ where: { deletedAt: { not: null } } }),
    prisma.userDevice.count(),
    prisma.userDevice.count({ where: { revokedAt: null } }),
    buildStorageReport({ walk: false }),
  ]);
  res.json({
    users: {
      total: totalUsers,
      banned,
      deleted,
    },
    devices: {
      total: devices,
      active: activeDevices,
    },
    storage,
  });
});

export default router;
