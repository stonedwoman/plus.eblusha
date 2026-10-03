import crypto from "crypto";
import { getRedisClient } from "./redis";

const CALL_E2EE_KEY_PREFIX = "call_e2ee_key:";
/**
 * Сколько живёт ключ звонка 1:1 с ПОСЛЕДНЕГО обращения к нему. Ключ один на беседу (не на
 * звонок) и не удаляется на call:end — так быстрый перезвон и переподключение посреди звонка
 * берут тот же ключ. Поэтому срок продлевается при каждом чтении (GETEX), на call:accept и
 * call:room:join, а пока звонок беседы идёт — ещё и раз в 10 минут (socket.ts). Без продления
 * ключ истекал через 2 ч от ПЕРВОГО invite: следующий запрос создавал новый ключ, у собеседника
 * оставался старый, и честный звонок падал на «Собеседник не подтвердил шифрование».
 */
export const CALL_E2EE_KEY_TTL_SECONDS = 2 * 60 * 60; // 2 hours
/** Как часто продлевать ключи идущих звонков 1:1 (много меньше срока жизни). */
export const CALL_E2EE_KEY_REFRESH_INTERVAL_MS = 10 * 60 * 1000;

export function generateCallE2eeSharedKeyBase64(): string {
  // 32 bytes → base64
  return crypto.randomBytes(32).toString("base64");
}

function redisKey(callId: string) {
  return `${CALL_E2EE_KEY_PREFIX}${callId}`;
}

export async function setCallE2eeKey(callId: string, keyBase64: string): Promise<void> {
  const redis = await getRedisClient();
  await redis.set(redisKey(callId), keyBase64, { EX: CALL_E2EE_KEY_TTL_SECONDS });
}

/** Прочитать ключ и продлить ему срок (GETEX): ключ, которым пользуются, не истекает. */
export async function getCallE2eeKey(callId: string): Promise<string | null> {
  const redis = await getRedisClient();
  const v = await redis.getEx(redisKey(callId), { type: "EX", value: CALL_E2EE_KEY_TTL_SECONDS });
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed ? trimmed : null;
}

export async function deleteCallE2eeKey(callId: string): Promise<void> {
  const redis = await getRedisClient();
  await redis.del(redisKey(callId));
}

/**
 * Продлить срок ключам бесед, где звонок 1:1 идёт прямо сейчас. Ключ не создаём (EXPIRE на
 * отсутствующем ключе ничего не делает): нет ключа — его создаст первый же запрос.
 */
export async function touchCallE2eeKeys(callIds: Iterable<string>): Promise<void> {
  const ids = Array.from(new Set(callIds)).filter((id) => typeof id === "string" && id.length > 0);
  if (ids.length === 0) return;
  const redis = await getRedisClient();
  await Promise.all(ids.map((id) => redis.expire(redisKey(id), CALL_E2EE_KEY_TTL_SECONDS)));
}

/** Сколько раз пробуем «создать или прочитать», если ключ истекает ровно между SET NX и GETEX. */
const GET_OR_CREATE_ATTEMPTS = 5;

export async function getOrCreateCallE2eeKey(callId: string): Promise<string> {
  const redis = await getRedisClient();
  for (let attempt = 0; attempt < GET_OR_CREATE_ATTEMPTS; attempt += 1) {
    const fresh = generateCallE2eeSharedKeyBase64();
    // SET NX: atomically create ONLY if absent, so a caller fetch, a callee fetch and the
    // call:invite handler all converge on ONE shared key instead of racing/regenerating.
    const created = await redis.set(redisKey(callId), fresh, { EX: CALL_E2EE_KEY_TTL_SECONDS, NX: true });
    if (created) return fresh;
    // Ключ уже есть: читаем и тут же продлеваем срок.
    const existing = await getCallE2eeKey(callId);
    if (existing) return existing;
    // Ключ истёк между SET NX и GETEX. Отдавать `fresh` нельзя — он нигде не сохранён, и
    // собеседник получил бы другой ключ. Пробуем создать заново.
  }
  throw new Error("call E2EE key: could not create or read a stable key");
}
