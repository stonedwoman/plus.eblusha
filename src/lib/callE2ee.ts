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

