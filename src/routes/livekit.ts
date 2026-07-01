import { Router, type Request } from "express";
import { randomBytes } from "crypto";
import { AccessToken, WebhookReceiver } from "livekit-server-sdk";
import { z } from "zod";
import env from "../config/env";
import { authenticate } from "../middlewares/auth";
import { getRedisClient } from "../lib/redis";
import prisma from "../lib/prisma";
import { applyLivekitFactsEvent } from "../lib/livekitFacts";
import { buildLivekitPublicUrl } from "../lib/livekitUrl";

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

// Call rooms are always named `conv-<conversationId>` (see the web CallOverlay and
// android LiveKitRepository). Tokens are minted ONLY for such rooms, and ONLY for a
// member of that conversation — otherwise any authenticated user could mint a
// join-token for an arbitrary room and eavesdrop on / disrupt any ongoing call.
const CONV_ROOM_PREFIX = "conv-";
// Comfortable margin so a normal-length call (or a held reconnection) never crosses
// token expiry mid-call. LiveKit reuses the existing token across its own reconnects,
// so this only matters for very long sessions.
const CALL_TOKEN_TTL_SECONDS = 12 * 60 * 60;

router.post("/token", async (req, res) => {
  const parsed = tokenSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid token request" });
    return;
  }

  const { room, participantMetadata } = parsed.data;

  type AuthedRequest = Request & {
    user?: { id: string; username: string; displayName?: string | null };
    deviceId?: string;
  };
  const authed = req as AuthedRequest;
  const user = authed.user!;

  // ── Authorization: only conversation call rooms, only for members. ──
  if (!room.startsWith(CONV_ROOM_PREFIX)) {
    res.status(403).json({ message: "Forbidden room" });
    return;
  }
  const conversationId = room.slice(CONV_ROOM_PREFIX.length).trim();
  if (!conversationId) {
    res.status(400).json({ message: "Invalid room" });
    return;
  }
  const membership = await prisma.conversationParticipant.findFirst({
    where: { conversationId, userId: user.id },
    select: { id: true },
  });
  if (!membership) {
    res.status(403).json({ message: "Forbidden" });
    return;
  }

  // Unique identity per device: the same user joining from two devices must NOT
  // collide on a single LiveKit identity (LiveKit evicts the older participant on a
  // clash, kicking the first device off the call). The app-level userId travels in
  // server-controlled metadata, so participant→user mapping stays correct.
  const deviceSuffix =
    authed.deviceId && authed.deviceId.trim() ? authed.deviceId.trim() : randomBytes(6).toString("hex");
  const identity = `${user.id}#${deviceSuffix}`;
  const displayName = user.displayName ?? user.username;

  // Metadata is SERVER-controlled for the identity fields (anti-spoofing): a client
  // cannot claim another user's id/name in the call roster. Cosmetic client fields
  // (e.g. avatarUrl) are passed through but can never override userId/displayName.
  const clientMeta =
    participantMetadata && typeof participantMetadata === "object" ? { ...participantMetadata } : {};
  const metadata = {
    ...clientMeta,
    app: "eblusha",
    userId: user.id,
    displayName,
  };

  const opts: any = {
    identity,
    name: displayName,
    ttl: CALL_TOKEN_TTL_SECONDS,
    metadata: JSON.stringify(metadata),
  };

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

  // LIVEKIT_PATH: строим URL от хоста запроса (без привязки к домену)
  let url: string;
  if (env.LIVEKIT_PATH) {
    url = buildLivekitPublicUrl(req, env.LIVEKIT_PATH);
  } else {
    url = env.LIVEKIT_URL!;
  }

  res.json({ token: jwt, url });
});

export default router;




