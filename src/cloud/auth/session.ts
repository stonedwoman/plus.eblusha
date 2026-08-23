import crypto from "node:crypto";
import type { CookieOptions, Request, Response } from "express";
import { getRedisClient } from "../../lib/redis";
import cloudConfig from "../config";

/**
 * Сессия Cloud живёт в Redis и НЕ является токеном Еблуши: мессенджер выдаёт
 * одноразовый код, Cloud меняет его на свою HttpOnly-куку. Пароли/хеши Еблуши
 * сюда не копируются, identity — только eblushaUserId.
 */
export const CLOUD_SESSION_COOKIE = "cloud_sid";
export const CLOUD_CSRF_HEADER = "x-cloud-csrf";

const KEY_PREFIX = "cloud:sess:";
const USER_INDEX_PREFIX = "cloud:sess:user:";

export type CloudSessionRecord = {
  userId: string;
  csrf: string;
  createdAt: number;
  /** Ротация: после rotateAfter выдаём новый id при следующем запросе */
  rotateAfter: number;
  client: string;
  ua?: string;
};

function ttlSeconds(): number {
  return Math.max(3600, Math.floor(cloudConfig.CLOUD_SESSION_TTL_DAYS * 86400));
}

function cookieSecure(): boolean {
  const raw = process.env.COOKIE_SECURE;
  if (raw !== undefined && raw !== "") return /^(1|true|yes)$/i.test(raw.trim());
  return process.env.NODE_ENV === "production";
}

export function cloudCookieOptions(maxAgeMs: number): CookieOptions {
  const secure = cookieSecure();
  const opts: CookieOptions = {
    httpOnly: true,
    // Lax достаточно: все мутации дополнительно требуют X-Cloud-CSRF, а share-ссылки
    // открываются обычной навигацией (top-level GET), которую Lax пропускает.
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: maxAgeMs,
  };
  const domain = process.env.COOKIE_DOMAIN;
  if (domain) opts.domain = domain;
  return opts;
}

function newId(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export async function createCloudSession(
  userId: string,
  meta: { client: string; ua?: string }
): Promise<{ sessionId: string; csrf: string; maxAgeMs: number }> {
  const redis = await getRedisClient();
  const sessionId = newId();
  const csrf = crypto.randomBytes(24).toString("base64url");
  const now = Date.now();
  const record: CloudSessionRecord = {
    userId,
    csrf,
    createdAt: now,
    rotateAfter: now + 12 * 3600_000,
    client: meta.client,
    ...(meta.ua ? { ua: meta.ua.slice(0, 200) } : {}),
  };
  const ttl = ttlSeconds();
  await redis.set(KEY_PREFIX + sessionId, JSON.stringify(record), { EX: ttl });
  await redis.sAdd(USER_INDEX_PREFIX + userId, sessionId);
  await redis.expire(USER_INDEX_PREFIX + userId, ttl);
  return { sessionId, csrf, maxAgeMs: ttl * 1000 };
}

export async function readCloudSession(sessionId: string): Promise<CloudSessionRecord | null> {
  if (!sessionId || sessionId.length > 128) return null;
  const redis = await getRedisClient();
  const raw = await redis.get(KEY_PREFIX + sessionId);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CloudSessionRecord;
  } catch {
    return null;
  }
}

/** Продлеваем скользящее окно; вызывается на каждый аутентифицированный запрос. */
export async function touchCloudSession(sessionId: string): Promise<void> {
  const redis = await getRedisClient();
  await redis.expire(KEY_PREFIX + sessionId, ttlSeconds());
}

export async function destroyCloudSession(sessionId: string): Promise<void> {
  const redis = await getRedisClient();
  const record = await readCloudSession(sessionId);
  await redis.del(KEY_PREFIX + sessionId);
  if (record) await redis.sRem(USER_INDEX_PREFIX + record.userId, sessionId);
}

/** Инвалидация всех сессий пользователя (бан/удаление/смена пароля). */
export async function destroyAllCloudSessions(userId: string): Promise<number> {
  const redis = await getRedisClient();
  const ids = await redis.sMembers(USER_INDEX_PREFIX + userId);
  if (ids.length === 0) return 0;
  await redis.del(ids.map((id) => KEY_PREFIX + id));
  await redis.del(USER_INDEX_PREFIX + userId);
  return ids.length;
}

export function readSessionCookie(req: Request): string | null {
  const raw = (req.cookies as Record<string, unknown> | undefined)?.[CLOUD_SESSION_COOKIE];
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

export function setSessionCookie(res: Response, sessionId: string, maxAgeMs: number): void {
  res.cookie(CLOUD_SESSION_COOKIE, sessionId, cloudCookieOptions(maxAgeMs));
}

export function clearSessionCookie(res: Response): void {
  const opts = cloudCookieOptions(0);
  delete (opts as { maxAge?: number }).maxAge;
  res.clearCookie(CLOUD_SESSION_COOKIE, opts);
}

/** Достаём cloud_sid из Cookie-заголовка рукопожатия Socket.IO. */
export function parseSessionIdFromCookieHeader(header: string | undefined): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    if (part.slice(0, idx).trim() !== CLOUD_SESSION_COOKIE) continue;
    try {
      return decodeURIComponent(part.slice(idx + 1).trim()) || null;
    } catch {
      return null;
    }
  }
  return null;
}
