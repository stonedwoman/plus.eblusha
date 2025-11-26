import crypto from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import prisma from "../lib/prisma";
import { hashPassword, verifyPassword } from "../utils/password";
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from "../utils/jwt";
import env from "../config/env";

const router = Router();

const registerSchema = z.object({
  username: z.string().min(3).max(30),
  displayName: z.string().min(2).max(50),
  password: z.string().min(8),
  email: z.string().email().optional(),
  phone: z.string().optional(),
});

const loginSchema = z.object({
  username: z.string(),
  password: z.string(),
});

router.post("/register", async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid data", errors: parsed.error.flatten() });
    return;
  }

  const { username, displayName, password, email, phone } = parsed.data;

  const uniqueChecks = [{ username }] as Array<Record<string, string>>;
  if (email) uniqueChecks.push({ email });
  if (phone) uniqueChecks.push({ phone });

  const existing = await prisma.user.findFirst({
    where: { OR: uniqueChecks },
    select: { id: true, username: true },
  });

  if (existing) {
    res.status(409).json({ message: "User already exists" });
    return;
  }

  const passwordHash = await hashPassword(password);

  const user = await prisma.user.create({
    data: {
      username,
      displayName,
      passwordHash,
      email: email ?? null,
      phone: phone ?? null,
    },
    select: { id: true, username: true, displayName: true },
  });

  res.status(201).json({ user });
});

router.post("/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid credentials" });
    return;
  }

  const { username, password } = parsed.data;

  const user = await prisma.user.findUnique({
    where: { username },
    select: {
      id: true,
      username: true,
      displayName: true,
      passwordHash: true,
    },
  });

  if (!user) {
    res.status(401).json({ message: "Invalid credentials" });
    return;
  }

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) {
    res.status(401).json({ message: "Invalid credentials" });
    return;
  }

  const tokenId = crypto.randomUUID();
  const accessToken = signAccessToken({ sub: user.id, tokenId });
  const refreshTokenValue = signRefreshToken({ sub: user.id, tokenId });

  await prisma.refreshToken.create({
    data: {
      token: tokenId,
      userId: user.id,
      expiresAt: new Date(Date.now() + parseJwtExpiry()),
    },
  });

  // Set httpOnly cookie for refresh token
  const cookieMaxAge = parseJwtExpiry();
  const sameSite = (env.COOKIE_SAMESITE as "lax" | "none" | "strict") ?? "lax";
  res.cookie("refreshToken", refreshTokenValue, {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite,
    maxAge: cookieMaxAge,
    path: env.COOKIE_PATH || "/api",
    domain: env.COOKIE_DOMAIN || undefined,
  });

  const includeRefresh = req.get("x-native-client") === "1";
  res.json({
    accessToken,
    user: {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
    },
    ...(includeRefresh ? { refreshToken: refreshTokenValue } : {}),
  });
});

router.post("/refresh", async (req, res) => {
  // Try to get refresh token from cookie first, then from body (for backward compatibility)
  const token = req.cookies?.refreshToken || req.body?.refreshToken;
  if (typeof token !== "string") {
    res.status(400).json({ message: "Invalid refresh token" });
    return;
  }

  try {
    const payload = verifyRefreshToken<{ sub: string; tokenId: string }>(token);
    const stored = await prisma.refreshToken.findUnique({
      where: { token: payload.tokenId },
    });

    if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
      res.clearCookie("refreshToken", { path: "/api/auth" });
      res.status(401).json({ message: "Refresh token expired" });
      return;
    }

    const newTokenId = crypto.randomUUID();

    await prisma.$transaction([
      prisma.refreshToken.update({
        where: { token: payload.tokenId },
        data: { revokedAt: new Date() },
      }),
      prisma.refreshToken.create({
        data: {
          token: newTokenId,
          userId: payload.sub,
          expiresAt: new Date(Date.now() + parseJwtExpiry()),
        },
      }),
    ]);

    const accessToken = signAccessToken({ sub: payload.sub, tokenId: newTokenId });
    const refreshTokenValue = signRefreshToken({ sub: payload.sub, tokenId: newTokenId });

    // Update httpOnly cookie with new refresh token
    const cookieMaxAge = parseJwtExpiry();
    const sameSite = (env.COOKIE_SAMESITE as "lax" | "none" | "strict") ?? "lax";
    res.cookie("refreshToken", refreshTokenValue, {
      httpOnly: true,
      secure: env.NODE_ENV === "production",
      sameSite,
      maxAge: cookieMaxAge,
      path: env.COOKIE_PATH || "/api",
      domain: env.COOKIE_DOMAIN || undefined,
    });

    const includeRefresh = req.get("x-native-client") === "1";
    res.json({
      accessToken,
      ...(includeRefresh ? { refreshToken: refreshTokenValue } : {}),
    });
  } catch (error) {
    res.clearCookie("refreshToken", {
      path: env.COOKIE_PATH || "/api",
      domain: env.COOKIE_DOMAIN || undefined,
    });
    res.status(401).json({ message: "Invalid refresh token" });
  }
});

router.post("/logout", async (req, res) => {
  const refreshToken = req.cookies?.refreshToken || req.body?.refreshToken;
  if (typeof refreshToken === "string") {
    try {
      const payload = verifyRefreshToken<{ tokenId: string }>(refreshToken);
      await prisma.refreshToken.updateMany({
        where: { token: payload.tokenId },
        data: { revokedAt: new Date() },
      });
    } catch {
      // Ignore errors during logout
    }
  }
  res.clearCookie("refreshToken", {
    path: env.COOKIE_PATH || "/api",
    domain: env.COOKIE_DOMAIN || undefined,
  });
  res.status(204).send();
});

function parseJwtExpiry(): number {
  const expiry = process.env.JWT_REFRESH_EXPIRES_IN ?? "180d";
  const match = expiry.match(/^(\d+)([smhd])$/);
  if (!match) {
    throw new Error("Invalid JWT expiry format");
  }
  const amount = Number(match[1]);
  const unit = match[2];
  const multipliers = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  } as const;
  return amount * multipliers[unit as keyof typeof multipliers];
}

export default router;

