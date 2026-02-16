import type { RedisClientType } from "redis";

export type ClientLogEvent = {
  ts: number;
  level: "debug" | "info" | "warn" | "error";
  tag: string;
  userId?: string;
  deviceId?: string;
  threadId?: string | undefined;
  msgId?: string | undefined;
  kind?: string | undefined;
  rootCause?: string | undefined;
  data?: Record<string, unknown> | undefined;
};

const MAX_EVENTS = 1200;
const TTL_SECONDS = 24 * 60 * 60;

function keyForDevice(userId: string, deviceId: string) {
  return `clientlog:${userId}:${deviceId}`;
}
function keyIndex(userId: string) {
  return `clientlog_index:${userId}`;
}

export async function appendClientLogs(
  redis: RedisClientType,
  userId: string,
  deviceId: string,
  events: ClientLogEvent[]
) {
  const uid = String(userId || "").trim();
  const did = String(deviceId || "").trim();
  if (!uid || !did) return;
  if (!Array.isArray(events) || events.length === 0) return;

  const k = keyForDevice(uid, did);
  const idx = keyIndex(uid);
  const payloads: string[] = [];
  for (const e of events.slice(0, 200)) {
    if (!e || typeof e !== "object") continue;
    payloads.push(JSON.stringify(e));
  }
  if (payloads.length === 0) return;

  // LPUSH newest first; trim; set TTL; update device index
  const multi = redis.multi();
  multi.sAdd(idx, did);
  multi.expire(idx, TTL_SECONDS);
  multi.lPush(k, payloads);
  multi.lTrim(k, 0, MAX_EVENTS - 1);
  multi.expire(k, TTL_SECONDS);
  await multi.exec();
}

export async function pullClientLogs(
  redis: RedisClientType,
  userId: string,
  deviceId: string,
  limit: number
): Promise<ClientLogEvent[]> {
  const uid = String(userId || "").trim();
  const did = String(deviceId || "").trim();
  if (!uid || !did) return [];
  const n = Math.max(1, Math.min(500, Math.floor(limit || 200)));
  const raw = await redis.lRange(keyForDevice(uid, did), 0, n - 1);
  const out: ClientLogEvent[] = [];
  for (const line of raw || []) {
    try {
      const parsed = JSON.parse(line) as ClientLogEvent;
      if (parsed && typeof parsed === "object") out.push(parsed);
    } catch {
      // ignore
    }
  }
  return out;
}

export async function listClientLogDevices(redis: RedisClientType, userId: string): Promise<string[]> {
  const uid = String(userId || "").trim();
  if (!uid) return [];
  const ids = await redis.sMembers(keyIndex(uid));
  return (ids || []).map((x) => String(x)).filter(Boolean).slice(0, 200);
}

