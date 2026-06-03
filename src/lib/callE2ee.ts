import crypto from "crypto";
import { getRedisClient } from "./redis";

const CALL_E2EE_KEY_PREFIX = "call_e2ee_key:";
export const CALL_E2EE_KEY_TTL_SECONDS = 2 * 60 * 60; // 2 hours

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

export async function getCallE2eeKey(callId: string): Promise<string | null> {
  const redis = await getRedisClient();
  const v = await redis.get(redisKey(callId));
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed ? trimmed : null;
}

export async function deleteCallE2eeKey(callId: string): Promise<void> {
  const redis = await getRedisClient();
  await redis.del(redisKey(callId));
}


export async function getOrCreateCallE2eeKey(callId: string): Promise<string> {
  const redis = await getRedisClient();
  const fresh = generateCallE2eeSharedKeyBase64();
  // SET NX: atomically create ONLY if absent, so a caller fetch, a callee fetch and the
  // call:invite handler all converge on ONE shared key instead of racing/regenerating.
  const created = await redis.set(redisKey(callId), fresh, { EX: CALL_E2EE_KEY_TTL_SECONDS, NX: true });
  if (created) return fresh;
  const existing = await getCallE2eeKey(callId);
  return existing ?? fresh;
}
