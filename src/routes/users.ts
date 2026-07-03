import { Router } from "express";
import prisma from "../lib/prisma";
import { authenticate } from "../middlewares/auth";

const router = Router();

router.use(authenticate);

/**
 * Public (authenticated) mini-profile for the universal user card.
 *
 * Exposes `eblid` (the 4-digit friend-add code) — a deliberate product decision:
 * the login-secret `username` is NEVER returned here (showing it invites password
 * guessing), and the card shows EBLID in its place so people can be friend-added.
 * `avatars` = current + past avatar URLs (avatar history) for the full-image viewer.
 */
router.get("/:id", async (req, res) => {
  const id = String(req.params.id || "").trim();
  if (!id) {
    res.status(400).json({ message: "Invalid user id" });
    return;
  }
  const user = await prisma.user.findUnique({
    where: { id },
    select: {
      id: true,
      eblid: true,
      displayName: true,
      bio: true,
      avatarUrl: true,
      avatarHistory: true,
      status: true,
      lastSeenAt: true,
      createdAt: true,
    },
  });
  if (!user) {
    res.status(404).json({ message: "User not found" });
    return;
  }
  const { avatarHistory, ...rest } = user as any;
  const avatars = [rest.avatarUrl, ...(avatarHistory ?? [])].filter(
    (u: unknown): u is string => typeof u === "string" && u.length > 0,
  );
  res.json({ user: { ...rest, avatars } });
});

export default router;
