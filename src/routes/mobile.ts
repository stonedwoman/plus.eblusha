import { Router } from "express";
import { z } from "zod";
import {
  clearRefreshCookie,
  getRequestDeviceId,
  loadSessionUser,
  RefreshTokenUnauthorizedError,
  rotateRefreshSession,
  setRefreshCookie,
} from "../lib/authSessions";
import { rateLimit } from "../middlewares/rateLimit";

const router = Router();

const bootstrapSchema = z.object({
  refreshToken: z.string().min(1),
  client: z.literal("android-apk"),
  deviceId: z.string().min(1).optional(),
});

router.post(
  "/session/bootstrap",
  rateLimit({ name: "mobile_session_bootstrap", windowMs: 60_000, max: 20 }),
  async (req, res) => {
    const parsed = bootstrapSchema.safeParse(req.body);
    if (!parsed.success) {
      clearRefreshCookie(res);
      res.status(400).json({ message: "Invalid bootstrap payload" });
      return;
    }

    try {
      const issuedSession = await rotateRefreshSession(parsed.data.refreshToken, {
        client: parsed.data.client,
        deviceId: parsed.data.deviceId ?? getRequestDeviceId(req),
      });
      const user = await loadSessionUser(issuedSession.userId);
      if (!user) {
        clearRefreshCookie(res);
        res.status(401).json({ message: "Invalid or revoked refresh token" });
        return;
      }

      setRefreshCookie(res, issuedSession.refreshToken, issuedSession.refreshMaxAgeMs);
      res.json({
        user,
        accessToken: issuedSession.accessToken,
        refreshToken: issuedSession.refreshToken,
        expiresAt: issuedSession.expiresAt.toISOString(),
        sessionId: issuedSession.sessionId,
      });
    } catch (error) {
      clearRefreshCookie(res);
      if (error instanceof RefreshTokenUnauthorizedError) {
        res.status(401).json({ message: error.message });
        return;
      }
      throw error;
    }
  }
);

export default router;
