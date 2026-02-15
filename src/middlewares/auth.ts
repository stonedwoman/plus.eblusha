import type { Request, Response, NextFunction } from "express";
import prisma from "../lib/prisma";
import { verifyAccessToken } from "../utils/jwt";
import logger from "../config/logger";

type AuthedRequest = Request & {
  user?: { id: string; username: string; displayName?: string | null };
  accessTokenId?: string;
  deviceId?: string;
};

export async function authenticate(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ")
    ? authHeader.slice(7)
    : undefined;

  if (!token) {
    res.status(401).json({ message: "Unauthorized" });
    return;
  }

  try {
    const payload = verifyAccessToken<{ sub: string; tokenId: string; did?: string }>(token);

    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, username: true, displayName: true },
    });

    if (!user) {
      res.status(401).json({ message: "Unauthorized" });
      return;
    }

    const r = req as AuthedRequest;
    r.user = user;
    r.accessTokenId = payload.tokenId;
    if (typeof payload.did === "string" && payload.did.trim()) {
      r.deviceId = payload.did.trim();
    }
    next();
  } catch (error) {
    logger.warn({ error }, "Auth middleware error");
    res.status(401).json({ message: "Unauthorized" });
  }
}


