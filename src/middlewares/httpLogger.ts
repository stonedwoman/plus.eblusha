import type { Request, Response, NextFunction } from "express";
import logger from "../config/logger";

type Authed = Request & { user?: { id: string } };

export function httpLoggerMiddleware(req: Request, res: Response, next: NextFunction) {
  const start = process.hrtime.bigint();
  res.on("finish", () => {
    const end = process.hrtime.bigint();
    const durationMs = Number(end - start) / 1_000_000;
    const requestId = (req as any).requestId as string | undefined;
    const userId = (req as Authed).user?.id;
    logger.info(
      {
        request_id: requestId,
        userId,
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        duration_ms: Math.round(durationMs * 100) / 100,
      },
      "http_request"
    );
  });
  next();
}

