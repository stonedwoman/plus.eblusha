import { Router, type Request } from "express";
import { z } from "zod";
import env from "../config/env";
import { authenticate } from "../middlewares/auth";
import prisma from "../lib/prisma";
import { getRedisClient } from "../lib/redis";
import { appendClientLogs, listClientLogDevices, pullClientLogs } from "../lib/clientLogs";
import { rateLimit } from "../middlewares/rateLimit";

const router = Router();
router.use(authenticate);

type AuthedRequest = Request & { user?: { id: string }; deviceId?: string };

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

const eventSchema = z.object({
  ts: z.number().int().nonnegative(),
  level: z.enum(["debug", "info", "warn", "error"]),
  tag: z.string().min(1).max(80),
  threadId: z.string().min(1).max(64).optional(),
  msgId: z.string().min(1).max(80).optional(),
  kind: z.string().min(1).max(40).optional(),
  rootCause: z.string().min(1).max(60).optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});

const pushSchema = z.object({
  deviceId: z.string().min(1).optional(),
  events: z.array(eventSchema).min(1).max(200),
});

router.post(
  "/client-logs",
  rateLimit({ name: "debug_client_logs_push", windowMs: 60_000, max: 1200 }),
  async (req, res) => {
    if (!env.DEBUG_CLIENT_LOGS) {
      res.status(404).json({ message: "Not found" });
      return;
    }
    const parsed = pushSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: "Invalid payload" });
      return;
    }
    const userId = (req as AuthedRequest).user!.id;
    const currentDeviceId = await resolveCurrentDeviceId(req);
    if (!currentDeviceId) {
      res.status(400).json({ message: "Current device is required (token did claim)" });
      return;
    }
    const requested = parsed.data.deviceId?.trim();
    if (requested && requested !== currentDeviceId) {
      res.status(403).json({ message: "Forbidden" });
      return;
    }
    const redis = await getRedisClient();
    await appendClientLogs(
      redis as any,
      userId,
      currentDeviceId,
      parsed.data.events.map((e) => ({
        ...e,
        userId,
        deviceId: currentDeviceId,
      }))
    );
    res.json({ ok: true });
  }
);

router.get(
  "/client-logs/devices",
  rateLimit({ name: "debug_client_logs_devices", windowMs: 60_000, max: 300 }),
  async (req, res) => {
    if (!env.DEBUG_CLIENT_LOGS) {
      res.status(404).json({ message: "Not found" });
      return;
    }
    const userId = (req as AuthedRequest).user!.id;
    const redis = await getRedisClient();
    const devices = await listClientLogDevices(redis as any, userId);
    res.json({ devices });
  }
);

router.get(
  "/client-logs",
  rateLimit({ name: "debug_client_logs_pull", windowMs: 60_000, max: 600 }),
  async (req, res) => {
    if (!env.DEBUG_CLIENT_LOGS) {
      res.status(404).json({ message: "Not found" });
      return;
    }
    const schema = z.object({
      deviceId: z.string().min(1),
      limit: z.coerce.number().int().min(1).max(500).default(200),
    });
    const parsed = schema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ message: "Invalid query" });
      return;
    }
    const userId = (req as AuthedRequest).user!.id;
    // Only allow reading your own device logs.
    const device = await prisma.userDevice.findUnique({
      where: { id: parsed.data.deviceId },
      select: { id: true, userId: true, revokedAt: true },
    });
    if (!device || device.userId !== userId || device.revokedAt) {
      res.status(404).json({ message: "Device not found" });
      return;
    }
    const redis = await getRedisClient();
    const events = await pullClientLogs(redis as any, userId, device.id, parsed.data.limit);
    res.json({ deviceId: device.id, events });
  }
);

export default router;

