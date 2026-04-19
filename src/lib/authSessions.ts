import crypto from "node:crypto";
import type { CookieOptions, Request, Response } from "express";
import prisma from "./prisma";
import env from "../config/env";
import { signAccessToken, signRefreshToken, verifyRefreshToken } from "../utils/jwt";

const REFRESH_COOKIE_NAME = "refreshToken";
const REVOCATION_REASON_ROTATED = "rotated";

const sessionUserSelect = {
  id: true,
  username: true,
  displayName: true,
  avatarUrl: true,
} as const;

const refreshTokenSelect = {
  token: true,
  userId: true,
  sessionId: true,
  client: true,
  deviceId: true,
  expiresAt: true,
  revokedAt: true,
  replacedByToken: true,
  revocationReason: true,
} as const;

type StoredRefreshTokenRecord = {
  token: string;
  userId: string;
  sessionId: string | null;
  client: string | null;
  deviceId: string | null;
  expiresAt: Date;
  revokedAt: Date | null;
  replacedByToken: string | null;
  revocationReason: string | null;
};

export type SessionUser = {
  id: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
};

export type IssuedSession = {
  userId: string;
  sessionId: string | null;
  client: string | null;
  deviceId: string | null;
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  refreshMaxAgeMs: number;
};

export class RefreshTokenUnauthorizedError extends Error {
  constructor(message = "Invalid or revoked refresh token") {
    super(message);
    this.name = "RefreshTokenUnauthorizedError";
  }
}

export async function loadSessionUser(userId: string): Promise<SessionUser | null> {
  return prisma.user.findUnique({
    where: { id: userId },
    select: sessionUserSelect,
  });
}

export function getRequestDeviceId(req: Request): string | null {
  const bodyDeviceId =
    typeof req.body?.deviceId === "string" ? normalizeOptionalString(req.body.deviceId) : null;
  const headerDeviceId =
    typeof req.headers["x-device-id"] === "string"
      ? normalizeOptionalString(req.headers["x-device-id"])
      : null;
  return headerDeviceId ?? bodyDeviceId;
}

export function getRequestClient(req: Request): string {
  const bodyClient =
    typeof req.body?.client === "string" ? normalizeOptionalString(req.body.client) : null;
  if (bodyClient) {
    return bodyClient;
  }
  if (req.get("x-native-client") === "1") {
    return "native";
  }
  return "web";
}

export function getRefreshTokenFromRequest(req: Request): string | null {
  const bodyToken =
    typeof req.body?.refreshToken === "string" ? normalizeOptionalString(req.body.refreshToken) : null;
  const cookieToken =
    typeof req.cookies?.refreshToken === "string"
      ? normalizeOptionalString(req.cookies.refreshToken)
      : null;
  const requestClient = getRequestClient(req);
  if ((requestClient === "android-apk" || req.get("x-native-client") === "1") && bodyToken) {
    return bodyToken;
  }
  return cookieToken ?? bodyToken;
}

export function setRefreshCookie(res: Response, refreshToken: string, maxAgeMs: number): void {
  res.cookie(REFRESH_COOKIE_NAME, refreshToken, {
    ...getRefreshCookieBaseOptions(),
    maxAge: Math.max(1, maxAgeMs),
  });
}

export function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE_NAME, getRefreshCookieBaseOptions());
}

export async function createRefreshSession(input: {
  userId: string;
  sessionId?: string | null;
  client?: string | null;
  deviceId?: string | null;
}): Promise<IssuedSession> {
  const record = buildNewRefreshTokenRecord(input);
  await prisma.refreshToken.create({ data: record });
  return buildIssuedSession(record);
}

export async function rotateRefreshSession(
  rawRefreshToken: string,
  input?: { client?: string | null; deviceId?: string | null }
): Promise<IssuedSession> {
  const refreshToken = normalizeOptionalString(rawRefreshToken);
  if (!refreshToken) {
    throw new RefreshTokenUnauthorizedError();
  }

  let payload: { sub: string; tokenId: string; did?: string; sid?: string };
  try {
    payload = verifyRefreshToken<{ sub: string; tokenId: string; did?: string; sid?: string }>(
      refreshToken
    );
  } catch {
    throw new RefreshTokenUnauthorizedError();
  }

  const stored = await findRefreshTokenRecord(payload.tokenId);
  if (!stored || stored.userId !== payload.sub) {
    throw new RefreshTokenUnauthorizedError();
  }

  const tokenDid = normalizeOptionalString(payload.did);
  if (stored.deviceId && tokenDid && stored.deviceId !== tokenDid) {
    throw new RefreshTokenUnauthorizedError();
  }

  const activeRecord = await resolveActiveRefreshTokenRecord(stored);
  if (stored.revokedAt || isRefreshTokenExpired(stored)) {
    if (!activeRecord) {
      throw new RefreshTokenUnauthorizedError();
    }
    return buildIssuedSession(activeRecord);
  }

  const nextRecord = buildNewRefreshTokenRecord({
    userId: stored.userId,
    ...(stored.sessionId || normalizeOptionalString(payload.sid)
      ? { sessionId: stored.sessionId ?? normalizeOptionalString(payload.sid) }
      : {}),
    ...(stored.client || input?.client ? { client: stored.client ?? input?.client ?? null } : {}),
    ...(stored.deviceId || tokenDid || input?.deviceId
      ? { deviceId: stored.deviceId ?? tokenDid ?? input?.deviceId ?? null }
      : {}),
  });

  const rotated = await prisma.$transaction(async (tx) => {
    const updated = await tx.refreshToken.updateMany({
      where: { token: stored.token, revokedAt: null },
      data: {
        revokedAt: new Date(),
        replacedByToken: nextRecord.token,
        revocationReason: REVOCATION_REASON_ROTATED,
      },
    });
    if (updated.count === 0) {
      return null;
    }
    await tx.refreshToken.create({ data: nextRecord });
    return nextRecord;
  });

  if (rotated) {
    return buildIssuedSession(rotated);
  }

  const racedRecord = await findRefreshTokenRecord(payload.tokenId);
  const currentRecord = racedRecord ? await resolveActiveRefreshTokenRecord(racedRecord) : null;
  if (!currentRecord) {
    throw new RefreshTokenUnauthorizedError();
  }
  return buildIssuedSession(currentRecord);
}

export async function revokeRefreshSession(
  rawRefreshToken: string | null | undefined,
  reason = "logout"
): Promise<void> {
  const refreshToken = normalizeOptionalString(rawRefreshToken);
  if (!refreshToken) return;

  let payload: { tokenId: string };
  try {
    payload = verifyRefreshToken<{ tokenId: string }>(refreshToken);
  } catch {
    return;
  }

  const stored = await findRefreshTokenRecord(payload.tokenId);
  if (!stored) return;

  const revokedAt = new Date();
  if (stored.sessionId) {
    await prisma.refreshToken.updateMany({
      where: {
        userId: stored.userId,
        sessionId: stored.sessionId,
        revokedAt: null,
      },
      data: { revokedAt, revocationReason: reason },
    });
    return;
  }

  const currentRecord = await resolveActiveRefreshTokenRecord(stored);
  const tokensToRevoke = [stored.token];
  if (currentRecord && currentRecord.token !== stored.token) {
    tokensToRevoke.push(currentRecord.token);
  }
  await prisma.refreshToken.updateMany({
    where: {
      token: { in: tokensToRevoke },
      revokedAt: null,
    },
    data: { revokedAt, revocationReason: reason },
  });
}

export async function revokeRefreshTokensForDevice(
  userId: string,
  deviceId: string,
  reason = "device_revoked"
): Promise<void> {
  const normalizedDeviceId = normalizeOptionalString(deviceId);
  if (!normalizedDeviceId) return;
  await prisma.refreshToken.updateMany({
    where: {
      userId,
      deviceId: normalizedDeviceId,
      revokedAt: null,
    },
    data: {
      revokedAt: new Date(),
      revocationReason: reason,
    },
  });
}

export async function revokeRefreshTokensForDevices(
  userId: string,
  deviceIds: string[],
  reason = "device_revoked"
): Promise<void> {
  const normalizedIds = deviceIds
    .map((deviceId) => normalizeOptionalString(deviceId))
    .filter((deviceId): deviceId is string => Boolean(deviceId));
  if (normalizedIds.length === 0) return;
  await prisma.refreshToken.updateMany({
    where: {
      userId,
      deviceId: { in: normalizedIds },
      revokedAt: null,
    },
    data: {
      revokedAt: new Date(),
      revocationReason: reason,
    },
  });
}

function buildNewRefreshTokenRecord(input: {
  userId: string;
  sessionId?: string | null;
  client?: string | null;
  deviceId?: string | null;
}): StoredRefreshTokenRecord {
  return {
    token: crypto.randomUUID(),
    userId: input.userId,
    sessionId: normalizeOptionalString(input.sessionId) ?? crypto.randomUUID(),
    client: normalizeOptionalString(input.client),
    deviceId: normalizeOptionalString(input.deviceId),
    expiresAt: new Date(Date.now() + getRefreshTokenLifetimeMs()),
    revokedAt: null,
    replacedByToken: null,
    revocationReason: null,
  };
}

function buildIssuedSession(record: StoredRefreshTokenRecord): IssuedSession {
  const tokenPayload = buildTokenPayload(record);
  const remainingRefreshMs = Math.max(1, record.expiresAt.getTime() - Date.now());
  return {
    userId: record.userId,
    sessionId: record.sessionId,
    client: record.client,
    deviceId: record.deviceId,
    accessToken: signAccessToken(tokenPayload),
    refreshToken: signRefreshToken(tokenPayload, {
      expiresInSeconds: Math.max(1, Math.floor(remainingRefreshMs / 1000)),
    }),
    expiresAt: record.expiresAt,
    refreshMaxAgeMs: remainingRefreshMs,
  };
}

function buildTokenPayload(record: StoredRefreshTokenRecord): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    sub: record.userId,
    tokenId: record.token,
  };
  if (record.deviceId) {
    payload.did = record.deviceId;
  }
  if (record.sessionId) {
    payload.sid = record.sessionId;
  }
  return payload;
}

async function findRefreshTokenRecord(tokenId: string): Promise<StoredRefreshTokenRecord | null> {
  return prisma.refreshToken.findUnique({
    where: { token: tokenId },
    select: refreshTokenSelect,
  });
}

async function resolveActiveRefreshTokenRecord(
  record: StoredRefreshTokenRecord
): Promise<StoredRefreshTokenRecord | null> {
  let current: StoredRefreshTokenRecord | null = record;
  for (let hop = 0; hop < 16; hop += 1) {
    if (!current) return null;
    if (!current.revokedAt) {
      return isRefreshTokenExpired(current) ? null : current;
    }
    if (
      current.revocationReason !== REVOCATION_REASON_ROTATED ||
      !normalizeOptionalString(current.replacedByToken)
    ) {
      return null;
    }
    const nextTokenId = normalizeOptionalString(current.replacedByToken);
    if (!nextTokenId) {
      return null;
    }
    current = await findRefreshTokenRecord(nextTokenId);
  }
  return null;
}

function isRefreshTokenExpired(record: StoredRefreshTokenRecord): boolean {
  return record.expiresAt.getTime() <= Date.now();
}

function getRefreshTokenLifetimeMs(): number {
  const expiry = env.JWT_REFRESH_EXPIRES_IN ?? "180d";
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

function getRefreshCookieBaseOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: env.COOKIE_SECURE ?? env.NODE_ENV === "production",
    sameSite: env.COOKIE_SAMESITE,
    path: env.COOKIE_PATH || "/api",
    domain: env.COOKIE_DOMAIN || undefined,
  };
}

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized ? normalized : null;
}
