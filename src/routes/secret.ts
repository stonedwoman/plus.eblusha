import { Router, type Request } from "express";
import { z } from "zod";
import { authenticate } from "../middlewares/auth";
import prisma from "../lib/prisma";
import { rateLimit } from "../middlewares/rateLimit";
import { getRedisClient } from "../lib/redis";
import { ackSecretInbox, enqueueSecretMessages, pullSecretInbox } from "../lib/secretInbox";
import { getIO } from "../realtime/socket";

const router = Router();
router.use(authenticate);

type AuthedRequest = Request & { user?: { id: string }; deviceId?: string };

const attachmentSchema = z.object({
  objectKey: z.string().min(1),
  size: z.number().int().nonnegative(),
  hash: z.string().min(1),
  wrappedContentKeysByDevice: z.record(z.string(), z.string()),
});

const sendSchema = z.object({
  messages: z
    .array(
      z.object({
        toDeviceId: z.string().min(1),
        msgId: z.string().min(1),
        ciphertext: z.string().min(1),
        createdAt: z.string().datetime(),
        ttlSeconds: z.number().int().min(1).max(60 * 60 * 24 * 30).optional(),
        attachment: attachmentSchema.optional(),
      })
    )
    .min(1)
    .max(500),
});

async function resolveCurrentDeviceId(req: Request): Promise<string | null> {
  const r = req as AuthedRequest;
  const candidate = r.deviceId?.trim();
  if (!candidate) return null;
  const device = await prisma.userDevice.findUnique({
    where: { id: candidate },
    select: { id: true, userId: true, revokedAt: true },
  });
  if (!device || device.userId !== r.user?.id || device.revokedAt) return null;
  return device.id;
}

router.post("/send", rateLimit({ name: "secret_send", windowMs: 60_000, max: 300 }), async (req, res) => {
  const parsed = sendSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid secret send payload" });
    return;
  }

  const redis = await getRedisClient();
  const preparedMessages = parsed.data.messages.map((msg) => ({
    toDeviceId: msg.toDeviceId,
    msgId: msg.msgId,
    ciphertext: msg.ciphertext,
    createdAt: msg.createdAt,
    ...(msg.ttlSeconds !== undefined ? { ttlSeconds: msg.ttlSeconds } : {}),
    ...(msg.attachment ? { attachment: msg.attachment } : {}),
  }));
  const results = await enqueueSecretMessages(redis, preparedMessages);
  const io = getIO();
  for (const result of results) {
    if (!result.inserted) continue;
    io?.to(`device:${result.toDeviceId}`).emit("secret:notify", {
      toDeviceId: result.toDeviceId,
      msgId: result.msgId,
    });
  }

  res.json({
    delivery: "at-least-once",
    results,
  });
});

const pullSchema = z.object({
  limit: z.number().int().min(1).max(200).default(50),
});

router.post("/inbox/pull", async (req, res) => {
  const currentDeviceId = await resolveCurrentDeviceId(req);
  if (!currentDeviceId) {
    res.status(400).json({ message: "Current device is required (token did claim)" });
    return;
  }
  const parsed = pullSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid pull payload" });
    return;
  }
  const redis = await getRedisClient();
  const messages = await pullSecretInbox(redis, currentDeviceId, parsed.data.limit);
  res.json({
    deviceId: currentDeviceId,
    delivery: "at-least-once",
    messages,
  });
});

const ackSchema = z.object({
  msgIds: z.array(z.string().min(1)).min(1).max(500),
});

router.post("/inbox/ack", async (req, res) => {
  const currentDeviceId = await resolveCurrentDeviceId(req);
  if (!currentDeviceId) {
    res.status(400).json({ message: "Current device is required (token did claim)" });
    return;
  }
  const parsed = ackSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid ack payload" });
    return;
  }
  const redis = await getRedisClient();
  const acked = await ackSecretInbox(redis, currentDeviceId, parsed.data.msgIds);
  // Idempotent ack: re-ack of already removed msgId is a no-op (removedFromListCount can be 0).
  res.json({ deviceId: currentDeviceId, acked });
});

export default router;
