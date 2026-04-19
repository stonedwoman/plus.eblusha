import type { Request, Response, NextFunction } from "express";
import crypto from "node:crypto";
import env from "../config/env";

/**
 * Admin auth: a single shared bearer token in env (`ADMIN_TOKEN`).
 *
 * Rationale: the user model is invite-only and has no role concept. Adding a
 * full RBAC layer for one operator is overkill — a dedicated env-secret keeps
 * the surface area minimal and orthogonal to user accounts.
 *
 * Accepts the token via either `Authorization: Bearer <token>` or
 * `X-Admin-Token: <token>`. Constant-time compare to avoid timing leaks.
 */
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
    res.status(503).json({ message: "Admin API is disabled (ADMIN_TOKEN unset)" });
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
