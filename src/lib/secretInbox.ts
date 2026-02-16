export const SECRET_INBOX_LIST_KEY_PREFIX = "secret_inbox:";
export const SECRET_MESSAGE_KEY_PREFIX = "secret_msg:";
export const DEFAULT_SECRET_INBOX_TTL_SECONDS = 7 * 24 * 60 * 60;
export const DEFAULT_SECRET_MESSAGE_TTL_SECONDS = 3600;
export const SECRET_MESSAGE_TTL_MIN_SECONDS = 60;
export const SECRET_MESSAGE_TTL_MAX_SECONDS = 7 * 24 * 60 * 60;

export type SecretAttachmentEnvelope = {
  objectKey: string;
  size: number;
  hash: string;
  wrappedContentKeysByDevice: Record<string, string>;
};

export type SealedSecretMessageInput = {
  toDeviceId: string;
  msgId: string;
  ciphertext: string;
  createdAt: string;
  ttlSeconds?: number;
  attachment?: SecretAttachmentEnvelope;
};

export type StoredSecretMessage = {
  toDeviceId: string;
  msgId: string;
  ciphertext: string;
  createdAt: string;
  expiresAt: string;
  attachment?: SecretAttachmentEnvelope;
};

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

function messageKey(deviceId: string, msgId: string): string {
  return `${SECRET_MESSAGE_KEY_PREFIX}${deviceId}:${msgId}`;
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

function parseStoredSecretMessage(raw: string | null): StoredSecretMessage | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredSecretMessage;
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
  messages: SealedSecretMessageInput[]
): Promise<SecretInboxSendResult[]> {
  const enqueueLua = `
local setOk = redis.call('SET', KEYS[1], ARGV[1], 'NX', 'EX', ARGV[2])
if not setOk then
  return 0
end
redis.call('RPUSH', KEYS[2], ARGV[3])
redis.call('EXPIRE', KEYS[2], ARGV[4])
return 1
`;
  const out: SecretInboxSendResult[] = [];
  for (const msg of messages) {
    const ttlSeconds = resolveTtlSeconds(msg.ttlSeconds);
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    const payload: StoredSecretMessage = {
      toDeviceId: msg.toDeviceId,
      msgId: msg.msgId,
      ciphertext: msg.ciphertext,
      createdAt: msg.createdAt,
      expiresAt,
      ...(msg.attachment ? { attachment: msg.attachment } : {}),
    };
    const msgKey = messageKey(msg.toDeviceId, msg.msgId);
    const inboxKey = inboxListKey(msg.toDeviceId);

    const evalResult = await redis.eval(enqueueLua, {
      keys: [msgKey, inboxKey],
      arguments: [
        JSON.stringify(payload),
        String(ttlSeconds),
        msg.msgId,
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

export async function pullSecretInbox(
  redis: RedisLike,
  deviceId: string,
  limit: number
): Promise<StoredSecretMessage[]> {
  const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));
  const inboxKey = inboxListKey(deviceId);
  const msgIds = await redis.lRange(inboxKey, 0, safeLimit - 1);
  if (msgIds.length === 0) return [];

  const payloads = await redis.mGet(msgIds.map((msgId) => messageKey(deviceId, msgId)));
  const out: StoredSecretMessage[] = [];

  for (let i = 0; i < msgIds.length; i += 1) {
    const msgId = msgIds[i];
    if (!msgId) continue;
    const parsed = parseStoredSecretMessage(payloads[i] ?? null);
    if (parsed) {
      out.push(parsed);
      continue;
    }
    // Cleanup stale list entries when payload already expired or malformed.
    await redis.lRem(inboxKey, 0, msgId);
  }
  return out;
}

export async function ackSecretInbox(
  redis: RedisLike,
  deviceId: string,
  msgIds: string[]
): Promise<SecretInboxAckResult[]> {
  const inboxKey = inboxListKey(deviceId);
  const out: SecretInboxAckResult[] = [];
  for (const msgId of msgIds) {
    await redis.del(messageKey(deviceId, msgId));
    const removed = await redis.lRem(inboxKey, 0, msgId);
    out.push({
      msgId,
      removedFromListCount: removed,
    });
  }
  return out;
}
