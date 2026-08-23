import type { NextFunction, Request, Response } from "express";
import crypto from "node:crypto";
import prisma from "../../lib/prisma";
import cloudConfig from "../config";
import { CloudError, forbidden, unauthorized } from "../errors";
import { writeAudit } from "../audit";
import {
  CLOUD_CSRF_HEADER,
  readCloudSession,
  readSessionCookie,
  touchCloudSession,
} from "./session";

export type CloudUser = {
  id: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
};

/** Требует валидную Cloud-сессию. Ничего не знает про пароли Еблуши. */
export async function requireCloudUser(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const sid = readSessionCookie(req);
    if (!sid) throw unauthorized();
    const record = await readCloudSession(sid);
    if (!record) throw unauthorized("Сессия истекла");

    const user = await prisma.user.findUnique({
      where: { id: record.userId },
      select: { id: true, username: true, displayName: true, avatarUrl: true, bannedAt: true, deletedAt: true },
    });
    if (!user || user.deletedAt) throw unauthorized("Аккаунт недоступен");
    if (user.bannedAt) throw forbidden("Аккаунт заблокирован");

    req.cloudUser = {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
    };
    req.cloudSessionId = sid;
    req.cloudCsrf = record.csrf;
    void touchCloudSession(sid);
    next();
  } catch (err) {
    next(err);
  }
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF для cookie-аутентификации: помимо SameSite=Lax требуем заголовок,
 * который кросс-сайтовая форма выставить не может.
 */
export function requireCsrf(req: Request, _res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method)) return next();
  const expected = req.cloudCsrf;
  const provided = req.headers[CLOUD_CSRF_HEADER];
  const token = Array.isArray(provided) ? provided[0] : provided;
  if (!expected || typeof token !== "string" || token.length !== expected.length) {
    void writeAudit(req, "PERMISSION_DENIED", { detail: { reason: "csrf" } });
    return next(new CloudError(403, "CSRF", "CSRF-токен не совпал"));
  }
  if (!crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected))) {
    void writeAudit(req, "PERMISSION_DENIED", { detail: { reason: "csrf" } });
    return next(new CloudError(403, "CSRF", "CSRF-токен не совпал"));
  }
  next();
}

export function isCloudAdmin(user: CloudUser | undefined): boolean {
  if (!user) return false;
  const allow = cloudConfig.CLOUD_ADMIN_USERNAMES;
  if (allow.length === 0) return false;
  return allow.includes(user.username.toLowerCase());
}

export function requireCloudAdmin(req: Request, _res: Response, next: NextFunction): void {
  if (!isCloudAdmin(req.cloudUser)) {
    void writeAudit(req, "PERMISSION_DENIED", { detail: { reason: "admin" } });
    return next(forbidden("Только для администратора"));
  }
  next();
}
