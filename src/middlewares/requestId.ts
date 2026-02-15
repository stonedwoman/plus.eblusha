import crypto from "node:crypto";
import type { Request, Response, NextFunction } from "express";

function pickIncomingRequestId(req: Request): string | null {
  const raw = req.headers["x-request-id"];
  if (typeof raw === "string" && raw.trim()) return raw.trim().slice(0, 128);
  if (Array.isArray(raw) && typeof raw[0] === "string" && raw[0].trim()) return raw[0].trim().slice(0, 128);
  return null;
}

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction) {
  const incoming = pickIncomingRequestId(req);
  const id = incoming ?? crypto.randomUUID();
  (req as any).requestId = id;
  res.setHeader("x-request-id", id);
  next();
}

