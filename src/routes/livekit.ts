import { Router, type Request } from "express";
import { AccessToken } from "livekit-server-sdk";
import { z } from "zod";
import env from "../config/env";
import { authenticate } from "../middlewares/auth";

const router = Router();

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




