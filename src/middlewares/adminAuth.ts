import type { Request, Response, NextFunction } from "express";
import crypto from "node:crypto";
import env from "../config/env";
import logger from "../config/logger";

/**
 * Admin auth: a single shared bearer token in env (`ADMIN_TOKEN`).
 *
 * Rationale: the user model is invite-only and has no role concept. Adding a
 * full RBAC layer for one operator is overkill — a dedicated env-secret keeps
 * the surface area minimal and orthogonal to user accounts.
 *
 * If `ADMIN_TOKEN` is unset/empty, the admin API is exposed *without* token
 * auth. This is intentional: in the default deployment the admin server only
 * listens on host loopback (deploy/nginx-docker.conf, listener 8088, mapped to
 * 127.0.0.1:8088 in compose) and the backend port itself is also bound to
 * loopback only, so reaching /api/admin requires SSH access to the host. SSH
 * key auth replaces the token in that setup.
 *
 * Accepts the token via either `Authorization: Bearer <token>` or
 * `X-Admin-Token: <token>`. Constant-time compare to avoid timing leaks.
 */
let warnedNoToken = false;
function warnNoTokenOnce(): void {
  if (warnedNoToken) return;
  warnedNoToken = true;
  logger.warn(
    "ADMIN_TOKEN is unset — /api/admin/* is open to anyone who can reach the backend. " +
      "Make sure the backend port and the admin nginx listener are bound to host loopback only " +
      "(see deploy/docker-compose.full.yml + deploy/nginx-docker.conf).",
  );
}
function safeEqualBuffers(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function extractToken(req: Request): string | null {
  const header = req.get("authorization");
  if (header && /^bearer\s+/i.test(header)) {
    const t = header.replace(/^bearer\s+/i, "").trim();
    if (t) return t;
  }
  const x = req.get("x-admin-token");
  if (typeof x === "string" && x.trim()) return x.trim();
  // Allow ?adminToken= for HTML page links/downloads only — useful for the
  // built-in single-file admin UI that stores the token in localStorage.
  const q = (req.query as any)?.adminToken;
  if (typeof q === "string" && q.trim()) return q.trim();
  return null;
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const expected = env.ADMIN_TOKEN;
  if (!expected) {
    warnNoTokenOnce();
    next();
    return;
  }
  const got = extractToken(req);
  if (!got) {
    res.status(401).json({ message: "Admin token required" });
    return;
  }
  if (!safeEqualBuffers(Buffer.from(got, "utf8"), Buffer.from(expected, "utf8"))) {
    res.status(403).json({ message: "Invalid admin token" });
    return;
  }
  next();
}
