import { Router, type Request } from "express";
import { AccessToken, WebhookReceiver } from "livekit-server-sdk";
import { z } from "zod";
import env from "../config/env";
import { authenticate } from "../middlewares/auth";
import { getRedisClient } from "../lib/redis";
import prisma from "../lib/prisma";
import { applyLivekitFactsEvent } from "../lib/livekitFacts";

const router = Router();
const webhookReceiver = new WebhookReceiver(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET);
const LIVEKIT_EVENT_KEY_PREFIX = "livekit_webhook_event:";
const LIVEKIT_EVENT_TTL_SECONDS = 7 * 24 * 60 * 60;

router.post("/webhook", async (req, res) => {
  const rawBodyBuffer = (req as Request & { rawBody?: Buffer }).rawBody;
  if (!rawBodyBuffer || rawBodyBuffer.length === 0) {
    res.status(400).json({ message: "Missing webhook body" });
    return;
  }
  const rawBody = rawBodyBuffer.toString("utf8");
  const authHeader = req.get("Authorization") ?? undefined;

  let event;
  try {
    event = await webhookReceiver.receive(rawBody, authHeader);
  } catch {
    res.status(401).json({ message: "Invalid LiveKit webhook signature" });
    return;
  }

  const eventId = (event.id || "").trim();
  if (!eventId) {
    res.status(400).json({ message: "Webhook event id is required" });
    return;
  }

  const redis = await getRedisClient();
  const dedupeKey = `${LIVEKIT_EVENT_KEY_PREFIX}${eventId}`;
  const dedupeInserted = await redis.set(dedupeKey, "1", {
    NX: true,
    EX: LIVEKIT_EVENT_TTL_SECONDS,
  });
  if (dedupeInserted !== "OK") {
    res.json({ ok: true, duplicate: true });
    return;
  }

  try {
    await prisma.$transaction(async (tx) => {
      await applyLivekitFactsEvent(tx, {
        id: eventId,
        event: event.event,
        roomName: event.room?.name ?? null,
        participantIdentity: event.participant?.identity ?? null,
        createdAtSeconds: event.createdAt,
      });
    });
  } catch {
    // Allow retry if DB write failed.
    await redis.del(dedupeKey);
    res.status(500).json({ message: "Failed to persist webhook event" });
    return;
  }

  res.json({ ok: true });
});

router.use(authenticate);

const tokenSchema = z.object({
  room: z.string().min(3),
  participantName: z.string().min(1).optional(),
  participantMetadata: z.record(z.string(), z.unknown()).optional(),
});

router.post("/token", async (req, res) => {
  const parsed = tokenSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid token request" });
    return;
  }

  const { room, participantName, participantMetadata } = parsed.data;

  type AuthedRequest = Request & { user?: { id: string; username: string; displayName?: string | null } };
  const user = (req as AuthedRequest).user!;

  const opts: any = {
    identity: user.id,
    name: participantName ?? user.displayName ?? user.username,
  };
  if (participantMetadata) {
    opts.metadata = JSON.stringify(participantMetadata);
  }

  const token = new AccessToken(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, opts);

  token.addGrant({
    room,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
    // required for LiveKit data channel messages (used for ping exchange, etc.)
    canPublishData: true,
  });

  const jwt = await token.toJwt();

  res.json({ token: jwt, url: env.LIVEKIT_URL });
});

export default router;




