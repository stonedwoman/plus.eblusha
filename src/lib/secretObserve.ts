/**
 * Наблюдение за лог-режимами секретных чатов (волна 2): суточные счётчики в Redis.
 *
 * Зачем. S3 (`SECRET_SEND_ENFORCE`) и строгий режим S7 включаются в волне 3, только когда
 * ≥7 суток (TTL инбокса) показали, что честный трафик правилам не противоречит. Логи контейнера
 * за неделю могут уехать ротацией, поэтому кроме `logger.warn` факты копятся здесь:
 *
 *   ключ  secret:obs:YYYY-MM-DD (UTC), HASH «поле → число», живёт 45 суток;
 *   смотреть: docker exec eblusha-redis redis-cli HGETALL secret:obs:2026-10-05
 *
 * Поля (kind — из закрытого списка, чужие значения сводятся к `other`, чтобы клиент не мог
 * раздуть хэш произвольными строками):
 *   s3.checked.<kind>                          — сколько конвертов /secret/send проверено;
 *   s3.would_reject.<reason>.<kind>            — нарушения S3 в лог-режиме (конверт ПРИНЯТ);
 *   s3.rejected.<reason>.<kind>                — нарушения S3 в жёстком режиме (конверт отброшен);
 *   s3.legacy_no_threadid.<kind>.<relation>    — thread_key без threadId в заголовке (легаси);
 *                                                relation: self|shared_secret (общая ACTIVE-секретка)
 *                                                — пропускается, stranger — нарушение legacy_stranger;
 *   s2.invalid.<route>.<enforce|log>           — заголовок неверной формы на входе;
 *   s2.hidden.<route> / s2.served.<route>      — такие записи на выдаче;
 *   s7.<event>                                 — учёт загрузчика секретных вложений (см. secret.ts).
 * Счётчик — best-effort: сбой Redis не ломает доставку.
 */
import { getRedisClient } from "./redis";
import logger from "../config/logger";

export const SECRET_OBS_KEY_PREFIX = "secret:obs:";
const SECRET_OBS_TTL_SECONDS = 45 * 24 * 60 * 60;

const KNOWN_KINDS = new Set([
  "msg",
  "key_package",
  "control",
  "prekeys_needed",
  "link_device_join",
  "key_resend_request",
  "self_check",
  "direct",
]);

/** kind заголовка → значение для имени поля счётчика (закрытый список + other). */
export function obsKind(kind: unknown): string {
  if (typeof kind !== "string" || !kind) return "none";
  return KNOWN_KINDS.has(kind) ? kind : "other";
}

export function secretObsKey(at: Date = new Date()): string {
  return `${SECRET_OBS_KEY_PREFIX}${at.toISOString().slice(0, 10)}`;
}

export async function bumpSecretObs(counts: Record<string, number>): Promise<void> {
  const entries = Object.entries(counts).filter(([field, n]) => !!field && Number.isFinite(n) && n > 0);
  if (!entries.length) return;
  try {
    const redis = await getRedisClient();
    const key = secretObsKey();
    const multi = redis.multi();
    for (const [field, n] of entries) multi.hIncrBy(key, field.slice(0, 160), Math.floor(n));
    multi.expire(key, SECRET_OBS_TTL_SECONDS);
    await multi.exec();
  } catch (error) {
    logger.warn({ error }, "secret-obs: counter bump failed");
  }
}

/** Сложить счётчик в словарь (для одной пачки — один round-trip в Redis). */
export function addObs(counts: Record<string, number>, field: string, n = 1): void {
  counts[field] = (counts[field] ?? 0) + n;
}
