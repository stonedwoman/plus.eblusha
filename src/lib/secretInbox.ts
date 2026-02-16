export const SECRET_INBOX_LIST_KEY_PREFIX = "secret_inbox:";
export const SECRET_MESSAGE_KEY_PREFIX = "secret_msg:";
export const SECRET_SEEN_KEY_PREFIX = "secret_seen:";
export const DEFAULT_SECRET_INBOX_TTL_SECONDS = 7 * 24 * 60 * 60;
export const DEFAULT_SECRET_MESSAGE_TTL_SECONDS = 3600;
export const SECRET_MESSAGE_TTL_MIN_SECONDS = 60;
export const SECRET_MESSAGE_TTL_MAX_SECONDS = 7 * 24 * 60 * 60;

export type SecretInboxEnvelopeInput = {
  toDeviceId: string;
  msgId: string;
  payload: Record<string, unknown>;
  ttlSeconds?: number;
};

export type StoredSecretEnvelope = Record<string, unknown> & { msgId: string; toDeviceId?: string; expiresAt?: string };

type RedisLike = {
  set: (
    key: string,
    value: string,
    options?: {
      EX?: number;
      NX?: boolean;
    }
  ) => Promise<string | null>;
  rPush: (key: string, values: string | string[]) => Promise<number>;
  expire: (key: string, seconds: number) => Promise<number>;
  lRange: (key: string, start: number, stop: number) => Promise<string[]>;
  mGet: (keys: string[]) => Promise<(string | null)[]>;
  del: (keys: string | string[]) => Promise<number>;
  lRem: (key: string, count: number, element: string) => Promise<number>;
  eval: (
    script: string,
    options?: {
      keys?: string[];
      arguments?: string[];
    }
  ) => Promise<unknown>;
};

export type SecretInboxSendResult = {
  toDeviceId: string;
  msgId: string;
  inserted: boolean;
  ttlSeconds: number;
};

export type SecretInboxAckResult = {
  msgId: string;
  removedFromListCount: number;
};

function inboxListKey(deviceId: string): string {
  return `${SECRET_INBOX_LIST_KEY_PREFIX}${deviceId}`;
}

function messageKey(msgId: string): string {
  return `${SECRET_MESSAGE_KEY_PREFIX}${msgId}`;
}

function seenKey(deviceId: string, msgId: string): string {
  return `${SECRET_SEEN_KEY_PREFIX}${deviceId}:${msgId}`;
}

function clampIntSeconds(v: number, min: number, max: number): number {
  const n = Math.floor(v);
  if (!Number.isFinite(n)) return min;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function resolveTtlSeconds(raw?: number): number {
  const fallback = DEFAULT_SECRET_MESSAGE_TTL_SECONDS;
  const envRaw = process.env.SECRET_MESSAGE_TTL_SECONDS;
  const envNum = typeof envRaw === "string" && envRaw.trim() ? Number(envRaw) : NaN;
  const fromEnv = Number.isFinite(envNum) ? envNum : fallback;

  const chosen = Number.isFinite(raw) ? (raw as number) : fromEnv;
  return clampIntSeconds(chosen, SECRET_MESSAGE_TTL_MIN_SECONDS, SECRET_MESSAGE_TTL_MAX_SECONDS);
}

function parseStoredSecretEnvelope(raw: string | null): StoredSecretEnvelope | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredSecretEnvelope;
  } catch {
    return null;
  }
}

/**
 * Delivery semantics:
 * - At-least-once delivery (messages stay in inbox list until explicit ack).
 * - Client must be idempotent by msgId.
 * - Message payload key has TTL; default server TTL is 1 hour (can be overridden by env).
 * - Inbox list key has a longer TTL to avoid unbounded growth.
 */
export async function enqueueSecretMessages(
  redis: RedisLike,
  messages: SecretInboxEnvelopeInput[]
): Promise<SecretInboxSendResult[]> {
  const enqueueLua = `
-- Dedup per (deviceId, msgId): only enqueue once per receiver device.
local seenOk = redis.call('SET', KEYS[3], '1', 'NX', 'EX', ARGV[5])
if not seenOk then
  return 0
end
-- Cache payload (best-effort; may already exist for other devices).
redis.call('SET', KEYS[1], ARGV[1], 'NX', 'EX', ARGV[2])
redis.call('RPUSH', KEYS[2], ARGV[3])
redis.call('EXPIRE', KEYS[2], ARGV[4])
return 1
`;
  const out: SecretInboxSendResult[] = [];
  for (const msg of messages) {
    const ttlSeconds = resolveTtlSeconds(msg.ttlSeconds);
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    const payload: StoredSecretEnvelope = {
      ...msg.payload,
      toDeviceId: msg.toDeviceId,
      msgId: msg.msgId,
      expiresAt,
    };
    const msgKey = messageKey(msg.msgId);
    const inboxKey = inboxListKey(msg.toDeviceId);
    const seen = seenKey(msg.toDeviceId, msg.msgId);

    const evalResult = await redis.eval(enqueueLua, {
      keys: [msgKey, inboxKey, seen],
      arguments: [
        JSON.stringify(payload),
        String(ttlSeconds),
        msg.msgId,
        String(DEFAULT_SECRET_INBOX_TTL_SECONDS),
        String(DEFAULT_SECRET_INBOX_TTL_SECONDS),
      ],
    });
    const inserted = Number(evalResult) === 1;
    out.push({
      toDeviceId: msg.toDeviceId,
      msgId: msg.msgId,
      inserted,
      ttlSeconds,
    });
  }
  return out;
}

export async function pullSecretInboxIds(
  redis: RedisLike,
  deviceId: string,
  limit: number
): Promise<string[]> {
  const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));
  const inboxKey = inboxListKey(deviceId);
  const msgIds = await redis.lRange(inboxKey, 0, safeLimit - 1);
  return msgIds.filter(Boolean);
}

export async function ackSecretInbox(
  redis: RedisLike,
  deviceId: string,
  msgIds: string[]
): Promise<SecretInboxAckResult[]> {
  const inboxKey = inboxListKey(deviceId);
  const out: SecretInboxAckResult[] = [];
  for (const msgId of msgIds) {
    const removed = await redis.lRem(inboxKey, 0, msgId);
    out.push({
      msgId,
      removedFromListCount: removed,
    });
  }
  return out;
}

export async function getSecretPayloads(
  redis: RedisLike,
  msgIds: string[]
): Promise<(StoredSecretEnvelope | null)[]> {
  if (!msgIds.length) return [];
  const raw = await redis.mGet(msgIds.map((id) => messageKey(id)));
  return raw.map((v) => parseStoredSecretEnvelope(v ?? null));
}

export async function setSecretPayloadCache(
  redis: RedisLike,
  msgId: string,
  payload: Record<string, unknown>,
  ttlSeconds?: number
): Promise<boolean> {
  const ttl = resolveTtlSeconds(ttlSeconds);
  const ok = await redis.set(messageKey(msgId), JSON.stringify(payload), { NX: true, EX: ttl });
  return ok === "OK";
}

export async function markSecretSeen(
  redis: RedisLike,
  deviceId: string,
  msgIds: string[],
  ttlSeconds = DEFAULT_SECRET_INBOX_TTL_SECONDS
): Promise<Record<string, boolean>> {
  const out: Record<string, boolean> = {};
  for (const msgId of msgIds) {
    const ok = await redis.set(seenKey(deviceId, msgId), "1", { NX: true, EX: ttlSeconds });
    out[msgId] = ok === "OK";
  }
  return out;
}
