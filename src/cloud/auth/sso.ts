import crypto from "node:crypto";
import { Router } from "express";
import type { Request } from "express";
import prisma from "../../lib/prisma";
import { getRedisClient } from "../../lib/redis";
import logger from "../../config/logger";
import { authenticate } from "../../middlewares/auth";
import { rateLimit } from "../../middlewares/rateLimit";
import cloudConfig from "../config";
import { CloudError, ah, invalid, unauthorized } from "../errors";
import { writeAudit } from "../audit";
import {
  clearSessionCookie,
  createCloudSession,
  destroyCloudSession,
  readSessionCookie,
  setSessionCookie,
} from "./session";

/**
 * First-party SSO Еблуша → Cloud.
 *
 *   Cloud SPA → POST /api/cloud/auth/authorize   (Bearer сессии Еблуши)
 *             ← одноразовый code (TTL 2 мин, привязан к clientId + PKCE challenge)
 *   Cloud SPA → POST /api/cloud/auth/token       (без Bearer, code + code_verifier)
 *             ← Set-Cookie cloud_sid (HttpOnly) + csrf
 *
 * Зачем отдельная сессия, если это тот же origin: у Cloud свой срок жизни
 * (длинные загрузки переживают ротацию access-токена мессенджера), своя
 * инвалидация и своя CSRF-защита. Пароли Еблуши тут не участвуют вообще.
 */

const CODE_PREFIX = "cloud:authcode:";
const ALLOWED_CLIENTS = new Set(["eblusha-cloud-web"]);

type AuthCodeRecord = {
  userId: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  createdAt: number;
};

/**
 * Куда разрешено возвращать одноразовый код.
 *
 * Два режима:
 *  - один origin (Cloud на eblusha.org/cloud) — только относительный путь /cloud/...;
 *  - отдельный поддомен (cloud.eblusha.org) — абсолютный URL, но ТОЛЬКО с origin
 *    из CLOUD_ALLOWED_REDIRECT_ORIGINS и путём внутри /cloud.
 *
 * Открытый редирект здесь означал бы подарок кода постороннему сайту, поэтому
 * никакого «начинается с https://cloud.» и прочей эвристики: строгий allowlist.
 */
function isSafeRedirect(uri: string): boolean {
  if (uri.startsWith("/")) {
    return /^\/cloud(\/[A-Za-z0-9._~\-/]*)?$/.test(uri) && !uri.includes("//");
  }
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return false;
  if (!cloudConfig.CLOUD_ALLOWED_REDIRECT_ORIGINS.includes(parsed.origin)) return false;
  return /^\/cloud(\/[A-Za-z0-9._~\-/]*)?$/.test(parsed.pathname);
}

function sha256b64url(input: string): string {
  return crypto.createHash("sha256").update(input).digest("base64url");
}

const router = Router();

/**
 * Публичные параметры входа. Нужны Cloud-фронту ДО аутентификации: когда Cloud
 * живёт на отдельном поддомене, он не знает сам, на каком origin искать сессию
 * Еблуши. Секретов здесь нет — только то, что и так видно в адресной строке.
 */
router.get("/config", (_req, res) => {
  res.json({
    clientId: [...ALLOWED_CLIENTS][0],
    messengerOrigin: cloudConfig.CLOUD_MESSENGER_ORIGIN.replace(/\/+$/, ""),
    /// Пусто = Cloud и мессенджер на одном origin, редирект не нужен.
    crossOrigin: cloudConfig.CLOUD_ALLOWED_REDIRECT_ORIGINS.length > 0,
  });
});

router.post(
  "/authorize",
  rateLimit({ name: "cloud-authorize", windowMs: 60_000, max: 30 }),
  authenticate,
  ah(async (req, res) => {
    const user = req.user;
    if (!user) throw unauthorized();
    const body = (req.body ?? {}) as Record<string, unknown>;
    const clientId = String(body.clientId ?? "");
    const redirectUri = String(body.redirectUri ?? "/cloud");
    const codeChallenge = String(body.codeChallenge ?? "");
    const method = String(body.codeChallengeMethod ?? "S256");

    if (!ALLOWED_CLIENTS.has(clientId)) throw invalid("Неизвестный client_id");
    if (!isSafeRedirect(redirectUri)) throw invalid("Недопустимый redirect_uri");
    if (method !== "S256") throw invalid("Поддерживается только PKCE S256");
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(codeChallenge)) throw invalid("Некорректный code_challenge");

    const code = crypto.randomBytes(32).toString("base64url");
    const record: AuthCodeRecord = {
      userId: user.id,
      clientId,
      redirectUri,
      codeChallenge,
      createdAt: Date.now(),
    };
    const redis = await getRedisClient();
    await redis.set(CODE_PREFIX + code, JSON.stringify(record), {
      EX: cloudConfig.CLOUD_AUTH_CODE_TTL_SECONDS,
    });

    res.json({ code, expiresIn: cloudConfig.CLOUD_AUTH_CODE_TTL_SECONDS, redirectUri });
  })
);

router.post(
  "/token",
  rateLimit({ name: "cloud-token", windowMs: 60_000, max: 40 }),
  ah(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const code = String(body.code ?? "");
    const verifier = String(body.codeVerifier ?? "");
    const clientId = String(body.clientId ?? "");
    if (!code || !verifier || !clientId) throw invalid("Не хватает параметров обмена");
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) throw invalid("Некорректный code_verifier");

    const redis = await getRedisClient();
    // GETDEL: код строго одноразовый, гонка двух вкладок не даст две сессии.
    const raw = await redis.getDel(CODE_PREFIX + code);
    if (!raw) throw new CloudError(400, "INVALID_GRANT", "Код недействителен или истёк");
    let record: AuthCodeRecord;
    try {
      record = JSON.parse(raw) as AuthCodeRecord;
    } catch {
      throw new CloudError(400, "INVALID_GRANT", "Код повреждён");
    }
    if (record.clientId !== clientId) throw new CloudError(400, "INVALID_GRANT", "Код выдан другому клиенту");

    const expected = Buffer.from(record.codeChallenge);
    const actual = Buffer.from(sha256b64url(verifier));
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
      logger.warn({ requestId: req.requestId }, "cloud sso: PKCE mismatch");
      throw new CloudError(400, "INVALID_GRANT", "PKCE не сошёлся");
    }

    const user = await prisma.user.findUnique({
      where: { id: record.userId },
      select: { id: true, username: true, displayName: true, avatarUrl: true, bannedAt: true, deletedAt: true },
    });
    if (!user || user.deletedAt) throw unauthorized("Аккаунт недоступен");
    if (user.bannedAt) throw new CloudError(403, "BANNED", "Аккаунт заблокирован");

    const session = await createCloudSession(user.id, {
      client: clientId,
      ...(typeof req.headers["user-agent"] === "string" ? { ua: req.headers["user-agent"] } : {}),
    });
    setSessionCookie(res, session.sessionId, session.maxAgeMs);
    await writeAudit(req, "LOGIN", { actorId: user.id, detail: { client: clientId } });

    res.json({
      user: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
      },
      csrf: session.csrf,
      expiresIn: Math.floor(session.maxAgeMs / 1000),
    });
  })
);

router.post(
  "/logout",
  ah(async (req: Request, res) => {
    const sid = readSessionCookie(req);
    if (sid) await destroyCloudSession(sid);
    clearSessionCookie(res);
    res.json({ ok: true });
  })
);

export default router;
