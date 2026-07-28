import { Router, type Response } from "express";
import { z } from "zod";
import prisma from "../lib/prisma";
import { hashPassword, verifyPassword } from "../utils/password";
import {
  clearRefreshCookie,
  createRefreshSession,
  getRefreshTokenFromRequest,
  getRequestClient,
  getRequestDeviceId,
  RefreshTokenUnauthorizedError,
  revokeRefreshSession,
  rotateRefreshSession,
  setRefreshCookie,
  type SessionUser,
} from "../lib/authSessions";
import {
  getCurrentRegistrationInviteCodeForUser,
  getRegistrationInviteCodeDigits,
  issueRegistrationInviteGrant,
  normalizeRegistrationInviteCode,
  refreshRegistrationInviteCodeForUser,
  resolveRegistrationInviteCode,
  verifyRegistrationInviteGrant,
} from "../lib/registrationInvites";
import { authenticate } from "../middlewares/auth";
import { rateLimit } from "../middlewares/rateLimit";
import { getIO } from "../realtime/socket";

const router = Router();
const userRoom = (userId: string) => `user:${userId}`;

const registerSchema = z.object({
  username: z.string().min(3).max(30),
  displayName: z.string().min(2).max(50),
  password: z.string().min(6),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  registrationInviteToken: z.string().optional(),
});

const loginSchema = z.object({
  username: z.string(),
  password: z.string(),
});

const registerInviteCodeVerifySchema = z.object({
  code: z.string().min(1),
});

router.get("/register/code", authenticate, async (req, res) => {
  const userId = (req as any).user!.id as string;
  const invite = await getCurrentRegistrationInviteCodeForUser(userId);
  res.json({
    code: invite.code,
    expiresAt: invite.expiresAt.toISOString(),
    inviter: invite.inviter,
    digits: getRegistrationInviteCodeDigits(),
  });
});

router.post(
  "/register/code/refresh",
  authenticate,
  rateLimit({ name: "auth_register_code_refresh", windowMs: 60_000, max: 30 }),
  async (req, res) => {
    const userId = (req as any).user!.id as string;
    const invite = await refreshRegistrationInviteCodeForUser(userId);
    res.json({
      code: invite.code,
      expiresAt: invite.expiresAt.toISOString(),
      inviter: invite.inviter,
      digits: getRegistrationInviteCodeDigits(),
    });
  }
);

router.post(
  "/register/code/verify",
  rateLimit({ name: "auth_register_code_verify", windowMs: 60_000, max: 20 }),
  async (req, res) => {
    const parsed = registerInviteCodeVerifySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: "Invalid invite code" });
      return;
    }

    const normalizedCode = normalizeRegistrationInviteCode(parsed.data.code);
    if (normalizedCode.length !== getRegistrationInviteCodeDigits()) {
      res.status(400).json({ message: "Invalid invite code" });
      return;
    }

    const invite = await resolveRegistrationInviteCode(normalizedCode);
    if (!invite) {
      res.status(404).json({ message: "Invite code is invalid or expired" });
      return;
    }

    res.json({
      registrationInviteToken: issueRegistrationInviteGrant(invite.inviter.id),
      inviter: invite.inviter,
      code: invite.code,
      expiresAt: invite.expiresAt.toISOString(),
    });
  }
);

router.post(
  "/register/check",
  rateLimit({ name: "auth_register_check", windowMs: 60_000, max: 60 }),
  async (req, res) => {
    const parsed = z.object({ username: z.string().min(3).max(30) }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: "Invalid data" });
      return;
    }
    // Case-insensitive so the form warns about "Мяу" when "мяу" exists — mirrors the
    // uniqueness check below. Invite-only registration + rate limit keep enumeration cheap-proof.
    const existing = await prisma.user.findFirst({
      where: { username: { equals: parsed.data.username, mode: "insensitive" } },
      select: { id: true },
    });
    res.json({ available: !existing });
  }
);

router.post(
  "/register",
  rateLimit({ name: "auth_register", windowMs: 60_000, max: 10 }),
  async (req, res) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: "Invalid data", errors: parsed.error.flatten() });
      return;
    }

    const { username, displayName, password, email, phone, registrationInviteToken } = parsed.data;
    const inviteToken = registrationInviteToken?.trim();
    if (!inviteToken) {
      res.status(403).json({ message: "Registration requires invite code" });
      return;
    }

    let inviterId: string;
    try {
      inviterId = verifyRegistrationInviteGrant(inviteToken).inviterId;
    } catch {
      res.status(403).json({ message: "Invalid or expired registration invite" });
      return;
    }

    const inviter = await prisma.user.findUnique({
      where: { id: inviterId },
      select: { id: true },
    });
    if (!inviter) {
      res.status(403).json({ message: "Invalid or expired registration invite" });
      return;
    }

    const uniqueChecks = [
      { username: { equals: username, mode: "insensitive" } },
    ] as any[];
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

    const created = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          username,
          displayName,
          passwordHash,
          email: email ?? null,
          phone: phone ?? null,
        },
        select: { id: true, username: true, displayName: true, avatarUrl: true },
      });

      const contact = await tx.contact.create({
        data: {
          requesterId: inviterId,
          addresseeId: user.id,
          status: "ACCEPTED",
        },
        select: { id: true },
      });

      const conversation = await tx.conversation.create({
        data: {
          isGroup: false,
          participants: {
            create: [{ userId: inviterId }, { userId: user.id }],
          },
        },
        select: { id: true },
      });

      return {
        user,
        contactId: contact.id,
        conversationId: conversation.id,
      };
    });

    const issuedSession = await createRefreshSession({
      userId: created.user.id,
      client: getRequestClient(req),
      deviceId: getRequestDeviceId(req),
    });

    const io = getIO();
    io?.to(userRoom(inviterId)).emit("contacts:request:accepted", { contactId: created.contactId });
    io?.to(userRoom(created.user.id)).emit("contacts:request:accepted", { contactId: created.contactId });
    io?.to(userRoom(inviterId)).emit("conversations:new", { conversationId: created.conversationId });
    io?.to(userRoom(created.user.id)).emit("conversations:new", { conversationId: created.conversationId });

    setRefreshCookie(res, issuedSession.refreshToken, issuedSession.refreshMaxAgeMs);
    respondWithSession(res, {
      user: created.user,
      accessToken: issuedSession.accessToken,
      refreshToken: issuedSession.refreshToken,
      expiresAt: issuedSession.expiresAt,
      sessionId: issuedSession.sessionId,
      statusCode: 201,
    });
  }
);

router.post(
  "/login",
  rateLimit({ name: "auth_login", windowMs: 60_000, max: 10 }),
  async (req, res) => {
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
        avatarUrl: true,
        passwordHash: true,
        bannedAt: true,
        bannedReason: true,
        deletedAt: true,
      },
    });

    if (!user) {
      res.status(401).json({ message: "Invalid credentials" });
      return;
    }

    if (user.deletedAt) {
      res.status(401).json({ message: "Invalid credentials" });
      return;
    }
    if (user.bannedAt) {
      res.status(403).json({ message: "Account banned", reason: user.bannedReason ?? null });
      return;
    }

    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) {
      res.status(401).json({ message: "Invalid credentials" });
      return;
    }

    const issuedSession = await createRefreshSession({
      userId: user.id,
      client: getRequestClient(req),
      deviceId: getRequestDeviceId(req),
    });

    setRefreshCookie(res, issuedSession.refreshToken, issuedSession.refreshMaxAgeMs);
    respondWithSession(res, {
      user: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
      },
      accessToken: issuedSession.accessToken,
      refreshToken: issuedSession.refreshToken,
      expiresAt: issuedSession.expiresAt,
      sessionId: issuedSession.sessionId,
    });
  }
);

router.post(
  "/refresh",
  rateLimit({ name: "auth_refresh", windowMs: 60_000, max: 30 }),
  async (req, res) => {
    const token = getRefreshTokenFromRequest(req);
    if (!token) {
      clearRefreshCookie(res);
      res.status(400).json({ message: "Invalid refresh token" });
      return;
    }

    try {
      const issuedSession = await rotateRefreshSession(token, {
        client: getRequestClient(req),
        deviceId: getRequestDeviceId(req),
      });
      setRefreshCookie(res, issuedSession.refreshToken, issuedSession.refreshMaxAgeMs);
      res.json({
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

router.post("/logout", async (req, res) => {
  await revokeRefreshSession(getRefreshTokenFromRequest(req), "logout");
  clearRefreshCookie(res);
  res.status(204).send();
});

function respondWithSession(
  res: Response,
  input: {
    user: SessionUser;
    accessToken: string;
    refreshToken: string;
    expiresAt: Date;
    sessionId: string | null;
    statusCode?: number;
  }
): void {
  res.status(input.statusCode ?? 200).json({
    user: input.user,
    accessToken: input.accessToken,
    refreshToken: input.refreshToken,
    expiresAt: input.expiresAt.toISOString(),
    sessionId: input.sessionId,
  });
}

export default router;

