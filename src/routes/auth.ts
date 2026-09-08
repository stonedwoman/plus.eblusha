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
import { destroyAllCloudSessions } from "../cloud/auth/session";
import logger from "../config/logger";
import { rateLimit } from "../middlewares/rateLimit";
import { getIO } from "../realtime/socket";
import { verifyRefreshToken } from "../utils/jwt";

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

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  // Те же требования, что и при регистрации.
  newPassword: z.string().min(6).max(200),
  revokeOtherSessions: z.boolean().optional(),
});

router.post(
  "/change-password",
  authenticate,
  // Каждая попытка проверяет текущий пароль, поэтому лимит жёсткий — иначе это
  // готовый оракул для перебора у того, кто украл живую сессию.
  rateLimit({ name: "auth_change_password", windowMs: 60_000, max: 5 }),
  async (req, res) => {
    const userId = (req as any).user!.id as string;
    const parsed = changePasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: "Invalid data" });
      return;
    }
    const { currentPassword, newPassword, revokeOtherSessions } = parsed.data;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { passwordHash: true },
    });
    if (!user) {
      res.status(401).json({ message: "Unauthorized" });
      return;
    }
    const valid = await verifyPassword(currentPassword, user.passwordHash);
    if (!valid) {
      res.status(403).json({ message: "Wrong current password" });
      return;
    }

    await prisma.user.update({
      where: { id: userId },
      data: { passwordHash: await hashPassword(newPassword) },
    });

    let revokedSessions = 0;
    if (revokeOtherSessions) {
      // Свой сеанс не трогаем: находим его по tokenId access-токена.
      const currentTokenId = (req as any).accessTokenId as string | undefined;
      let currentSessionId: string | null = null;
      if (currentTokenId) {
        const rec = await prisma.refreshToken.findUnique({
          where: { token: currentTokenId },
          select: { sessionId: true, userId: true },
        });
        if (rec && rec.userId === userId) currentSessionId = rec.sessionId;
      }
      const result = await prisma.refreshToken.updateMany({
        where: {
          userId,
          revokedAt: null,
          ...(currentSessionId
            ? { NOT: { sessionId: currentSessionId } }
            : currentTokenId
              ? { NOT: { token: currentTokenId } }
              : {}),
        },
        data: { revokedAt: new Date(), revocationReason: "password_change" },
      });
      revokedSessions = result.count;
      // Cloud-сессии живут отдельно (Redis) и паролём не защищены. Режем все:
      // живая вкладка Картотеки молча получит новую по SSO от этого же сеанса.
      try {
        await destroyAllCloudSessions(userId);
      } catch (error) {
        logger.warn({ error, userId }, "Failed to destroy cloud sessions on password change");
      }
    }

    logger.info({ userId, revokedSessions }, "Password changed");
    res.json({ success: true, revokedSessions });
  }
);

router.post("/logout", async (req, res) => {
  const rawRefreshToken = getRefreshTokenFromRequest(req);
  await revokeRefreshSession(rawRefreshToken, "logout");
  // Push-токены устройства снимаем и здесь, а не только в DELETE /devices/:id/push: тот
  // запрос клиент шлёт до logout, и если он упал без сети, а logout дошёл, разлогиненный
  // iPhone продолжал бы получать VoIP-звонки чужого аккаунта. did подписан в самом
  // refresh-токене, userId в условии — чтобы чужое устройство задеть было нельзя.
  // Для веба безвредно: он токенов не регистрирует.
  if (rawRefreshToken) {
    let did = "";
    let userId = "";
    try {
      const payload = verifyRefreshToken<{ sub?: string; did?: string }>(rawRefreshToken);
      did = typeof payload.did === "string" ? payload.did.trim() : "";
      userId = typeof payload.sub === "string" ? payload.sub : "";
    } catch {
      // Просроченный или чужой токен: сессии по нему уже нет, снимать нечего.
    }
    if (did && userId) {
      try {
        await prisma.userDevice.updateMany({
          where: { id: did, userId },
          data: { pushToken: null, pushProvider: null, pushVoipToken: null },
        });
      } catch (error) {
        logger.warn({ error, userId, deviceId: did }, "Failed to clear push tokens on logout");
      }
    }
  }
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

