import type { Request, Response, NextFunction } from "express";
import { getRedisClient } from "../lib/redis";

type RateLimitOptions = {
  name: string;
  windowMs: number;
  max: number;
  key?: (req: Request) => string;
};

function defaultKey(req: Request): string {
  const ip = (req.ip || "").trim() || "unknown_ip";
  const userId = (req as any).user?.id as string | undefined;
  return userId ? `user:${userId}:ip:${ip}` : `ip:${ip}`;
}

async function incrWithTtl(key: string, windowMs: number): Promise<number> {
  const redis = await getRedisClient();
  // Atomic fixed-window counter:
  // INCR; if first hit then set PEXPIRE windowMs; return count
  const script = `
local v = redis.call('INCR', KEYS[1])
if v == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return v
`;
  const res = await redis.eval(script, {
    keys: [key],
    arguments: [String(windowMs)],
  });
  const n = typeof res === "number" ? res : Number(res);
  return Number.isFinite(n) ? n : 0;
}

export function rateLimit(opts: RateLimitOptions) {
  const name = opts.name;
  const windowMs = opts.windowMs;
  const max = opts.max;
  const keyFn = opts.key ?? defaultKey;

  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const identity = keyFn(req);
      const k = `rl:${name}:${identity}`;
      const count = await incrWithTtl(k, windowMs);
      if (count > max) {
        res.status(429).json({ message: "Too Many Requests", code: "RATE_LIMITED" });
        return;
      }
      next();
    } catch {
      // Fail-open: do not break production if Redis is down.
      next();
    }
  };
}

