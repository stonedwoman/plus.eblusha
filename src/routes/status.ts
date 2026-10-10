import { Router, type Request } from "express";
import prisma from "../lib/prisma";
import { authenticate } from "../middlewares/auth";
import { getIO } from "../realtime/socket";
import { z } from "zod";
import { getMetricsSnapshot } from "../obs/metrics";
import env from "../config/env";
import { rateLimit } from "../middlewares/rateLimit";
import { resolveCurrentDeviceId } from "../lib/currentDevice";
import {
  getOwnLocalTimeState,
  localTimeDeviceKey,
  reportDeviceTimeZone,
  setShareLocalTime,
} from "../lib/localTime";

const router = Router();

type AuthedRequest = Request & { user?: { id: string } };

function requireMetricsToken(req: Request, res: any, next: any) {
  const auth = req.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!env.METRICS_TOKEN || token !== env.METRICS_TOKEN) {
    res.status(401).json({ message: "Unauthorized" });
    return;
  }
  next();
}

router.get("/metrics", requireMetricsToken, (_req, res) => {
  res.json(getMetricsSnapshot());
});

router.use(authenticate);

router.get("/me", async (req, res) => {
  const userId = (req as AuthedRequest).user!.id;
  // ensure eblid exists
  const me = await prisma.user.findUnique({ where: { id: userId }, select: { eblid: true } });
  if (!me?.eblid) {
    // generate 4-digit unique
    let code: string | null = null;
    for (let i = 0; i < 20; i++) {
      const candidate = Math.floor(1000 + Math.random() * 9000).toString();
      const exists = await prisma.user.findFirst({ where: { eblid: candidate }, select: { id: true } });
      if (!exists) { code = candidate; break; }
    }
    if (code) await prisma.user.update({ where: { id: userId }, data: { eblid: code } });
  }
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      username: true,
      eblid: true,
      displayName: true,
      bio: true,
      avatarUrl: true,
      avatarHistory: true,
      status: true,
      lastSeenAt: true,
      isBot: true,
    },
  });

  res.json({ user });
});

router.patch("/me", async (req, res) => {
  const { displayName, bio, status, avatarUrl } = req.body as {
    displayName?: string;
    bio?: string;
    status?: "ONLINE" | "OFFLINE" | "AWAY" | "DND";
    avatarUrl?: string | null;
  };
  const userId = (req as AuthedRequest).user!.id;

  const data: any = {};
  if (displayName !== undefined) data.displayName = displayName ?? null;
  if (bio !== undefined) data.bio = bio ?? null;
  if (status !== undefined) {
    data.status = status;
    data.lastSeenAt = status === "ONLINE" ? new Date() : undefined;
  }
  if (avatarUrl !== undefined) {
    data.avatarUrl = avatarUrl ?? null;
    // Keep the previous avatar in history (newest-first, de-duped, capped at 30) so it
    // can be viewed later. Emoji avatars ("emoji:…") are kept too — the viewer skips them.
    const prev = await prisma.user.findUnique({
      where: { id: userId },
      select: { avatarUrl: true, avatarHistory: true },
    });
    const old = prev?.avatarUrl ?? null;
    if (old && old !== (avatarUrl ?? null)) {
      const hist = [old, ...(prev?.avatarHistory ?? []).filter((u) => u !== old)].slice(0, 30);
      data.avatarHistory = hist;
    }
  }

  const updated = await prisma.user.update({
    where: { id: userId },
    data,
    select: {
      id: true,
      username: true,
      eblid: true,
      displayName: true,
      bio: true,
      avatarUrl: true,
      avatarHistory: true,
      status: true,
      lastSeenAt: true,
    },
  });

  // notify others about profile change
  getIO()?.emit("profile:update", { userId, avatarUrl: updated.avatarUrl, displayName: updated.displayName });

  res.json({ user: updated });
});

/**
 * Местное время (lib/localTime.ts) — своя настройка и свой пояс.
 *
 * GET /status/me/local-time →
 *   { shareLocalTime, shareLocalTimeAt, localTime: {timeZone, city, offsetMinutes} | null }
 *   localTime — какой пояс сейчас видят собеседники (если настройка включена); null — ни одно устройство
 *   ещё не сообщило пояс.
 * PUT /status/me/local-time { shareLocalTime?: boolean, timeZone?: string } → то же, что GET.
 *   shareLocalTime — переключить «Показывать моё местное время» (рассылается своим устройствам событием
 *   localtime:settings, собеседникам — localtime:update). timeZone — пояс ЭТОГО устройства (X-Device-Id /
 *   did токена), запасной путь к сокет-событию localtime:report; засчитывается как «пользовался сейчас»,
 *   поэтому звать только с переднего плана. Негодный пояс — 400 INVALID_TIME_ZONE.
 */
router.get("/me/local-time", async (req, res) => {
  const userId = (req as AuthedRequest).user!.id;
  res.json(await getOwnLocalTimeState(userId));
});

const localTimeSchema = z.object({
  shareLocalTime: z.boolean().optional(),
  timeZone: z.string().min(1).max(64).optional(),
});

router.put(
  "/me/local-time",
  rateLimit({ name: "local_time_put", windowMs: 60_000, max: 30 }),
  async (req, res) => {
    const userId = (req as AuthedRequest).user!.id;
    const parsed = localTimeSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ message: "Invalid payload" });
      return;
    }
    const { shareLocalTime, timeZone } = parsed.data;
    if (timeZone !== undefined) {
      const deviceId = await resolveCurrentDeviceId(req);
      const result = await reportDeviceTimeZone({
        userId,
        deviceKey: localTimeDeviceKey(deviceId),
        timeZone,
        use: true,
      });
      if (!result.ok) {
        if (result.error === "invalid_time_zone") {
          res.status(400).json({ message: "Invalid time zone", code: "INVALID_TIME_ZONE" });
        } else {
          res.status(503).json({ message: "Local time is temporarily unavailable" });
        }
        return;
      }
    }
    if (shareLocalTime !== undefined) await setShareLocalTime(userId, shareLocalTime);
    res.json(await getOwnLocalTimeState(userId));
  },
);

// POST /status/me/avatars/remove { url } — drop a past avatar from the owner's history.
router.post("/me/avatars/remove", async (req, res) => {
  const userId = (req as AuthedRequest).user!.id;
  const url = String((req.body as any)?.url ?? "").trim();
  if (!url) {
    res.status(400).json({ message: "url is required" });
    return;
  }
  const me = await prisma.user.findUnique({ where: { id: userId }, select: { avatarHistory: true } });
  const next = (me?.avatarHistory ?? []).filter((u) => u !== url);
  const updated = await prisma.user.update({
    where: { id: userId },
    data: { avatarHistory: next },
    select: { avatarHistory: true },
  });
  res.json({ avatarHistory: updated.avatarHistory });
});

export default router;




