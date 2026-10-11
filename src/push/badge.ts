/**
 * Значок приложения на iOS (APNs aps.badge) — общий счётчик непрочитанного БЕЗ заглушённых бесед
 * («Без звука», lib/conversationMute.ts, docs/conversation-mute.md §5).
 *
 * Число ведёт СЕРВЕР, а не телефон. Приложение, выгруженное свайпом, не получает ни сокета, ни тихих
 * background-пушей (read-sync): прочтение на ПК и «Без звука» с другого устройства до него не доходят, и
 * посчитанное на телефоне число залипало бы. Поэтому сервер ставит число сам:
 *  - в каждый alert-пуш о сообщении (aps.badge);
 *  - отдельным badge-only пушем (kind "badge": apns alert без alert и sound — число применяет сама система,
 *    приложение не будится, работает и у выгруженного) — после прочтения на другом устройстве (вместе с
 *    read-пушем), после смены «Без звука» и в момент истечения его срока.
 * Открытое приложение выставляет то же число по своему списку бесед (то же правило).
 *
 * Только устройствам, которые сами попросили: старые сборки iOS (≤ 995) значок не сбрасывают, и число от
 * сервера у них залипло бы. Сборка с поддержкой объявляет caps:["badge"] при регистрации alert-токена
 * (POST /devices/:id/push, повторяется при каждом запуске) — Redis-хеш push:badge:<userId>, поле = deviceId.
 * Регистрация без caps (откат на старую сборку) и снятие токена (выход) объявление убирают.
 *
 * APNS_BADGE (env) — общий выключатель, по умолчанию off. Включать можно в любой момент: старые сборки
 * значка не получают при любом значении.
 *
 * Модуль намеренно не тянет realtime/socket: его грузит воркер пушей.
 */
import prisma from "../lib/prisma";
import env from "../config/env";
import logger from "../config/logger";
import { getRedisClient } from "../lib/redis";
import { enqueuePush } from "../jobs/queue";

export function apnsBadgeEnabled(): boolean {
  return env.APNS_BADGE === "on";
}

/** Возможность в caps регистрации токена: приложение само сбрасывает значок и просит сервер вести его число. */
export const BADGE_CAP = "badge";

const capKey = (userId: string) => `push:badge:${userId}`;
/** Сколько помнить объявление без повтора. Приложение повторяет регистрацию токена при каждом запуске. */
const CAP_TTL_MS = 180 * 24 * 3_600_000;

/**
 * Запомнить или снять объявление устройства. false — Redis не ответил (тогда устройству и не говорим,
 * что значок ведёт сервер: иначе его число залипло бы без обновлений).
 */
export async function setBadgeCapable(userId: string, deviceId: string, capable: boolean): Promise<boolean> {
  try {
    const redis = await getRedisClient();
    if (capable) {
      await redis.hSet(capKey(userId), deviceId, String(Date.now()));
      await redis.pExpire(capKey(userId), CAP_TTL_MS);
    } else {
      await redis.hDel(capKey(userId), deviceId);
    }
    return true;
  } catch (error) {
    logger.warn({ error, userId, deviceId, capable }, "push: badge capability not saved");
    return false;
  }
}

/** Устройства (deviceId), которым сервер ведёт значок. Сбой Redis — пусто: без числа, но и без залипшего. */
export async function badgeCapableDevices(userIds: readonly string[]): Promise<Set<string>> {
  const out = new Set<string>();
  const unique = Array.from(new Set(userIds.filter(Boolean)));
  if (unique.length === 0) return out;
  try {
    const redis = await getRedisClient();
    const lists = await Promise.all(unique.map((uid) => redis.hKeys(capKey(uid))));
    for (const ids of lists) for (const id of ids) out.add(id);
  } catch (error) {
    logger.warn({ error }, "push: badge capability lookup failed");
  }
  return out;
}

/**
 * То же, что сумма unreadCount плиток GET /api/conversations (чужие сообщения без квитанции READ/SEEN),
 * но только по беседам, которые в nowMs НЕ заглушены (mutedUntil null или ≤ now).
 */
export async function unreadTotalExcludingMuted(userId: string, nowMs: number = Date.now()): Promise<number> {
  const now = new Date(nowMs);
  return prisma.message.count({
    where: {
      senderId: { not: userId },
      receipts: { none: { userId, status: { in: ["READ", "SEEN"] } } },
      conversation: {
        participants: { some: { userId, OR: [{ mutedUntil: null }, { mutedUntil: { lte: now } }] } },
      },
    },
  });
}

/** userId → число на значке. Сбой подсчёта у человека — без badge для него (значок не трогаем). */
export async function apnsBadges(userIds: readonly string[], nowMs: number = Date.now()): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  await Promise.all(
    Array.from(new Set(userIds)).map(async (uid) => {
      try {
        out.set(uid, await unreadTotalExcludingMuted(uid, nowMs));
      } catch (error) {
        logger.warn({ error, userId: uid }, "push: badge count failed");
      }
    }),
  );
  return out;
}

/**
 * Обновить значок на устройствах человека badge-only пушем (число считает воркер в момент отправки, кому
 * слать — тоже он: APNs-устройства с caps badge). Без APNS_BADGE=on — ничего. delayMs — к моменту истечения
 * «Без звука»; dedupeKey — тот же срок той же беседы ставится в очередь один раз.
 */
export function enqueueBadgeRefresh(userId: string, opts?: { delayMs?: number; dedupeKey?: string }): void {
  if (!userId || !apnsBadgeEnabled()) return;
  const delayMs = opts?.delayMs && opts.delayMs > 0 ? opts.delayMs : 0;
  enqueuePush([userId], { kind: "badge" }, opts?.dedupeKey, delayMs ? { delayMs } : undefined);
}
