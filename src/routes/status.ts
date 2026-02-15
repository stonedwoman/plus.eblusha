import { Router, type Request } from "express";
import prisma from "../lib/prisma";
import { authenticate } from "../middlewares/auth";
import { getIO } from "../realtime/socket";
import { z } from "zod";
import { getMetricsSnapshot } from "../obs/metrics";
import env from "../config/env";

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
      status: true,
      lastSeenAt: true,
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
  if (avatarUrl !== undefined) data.avatarUrl = avatarUrl ?? null;

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
      status: true,
      lastSeenAt: true,
    },
  });

  // notify others about profile change
  getIO()?.emit("profile:update", { userId, avatarUrl: updated.avatarUrl, displayName: updated.displayName });

  res.json({ user: updated });
});

export default router;




