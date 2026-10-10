/**
 * Значок приложения на iOS (APNs aps.badge) — общий счётчик непрочитанного БЕЗ заглушённых бесед
 * («Без звука», lib/conversationMute.ts, docs/conversation-mute.md).
 *
 * Выключено по умолчанию (APNS_BADGE=off): сегодняшнее iOS-приложение значок само не сбрасывает и не
 * пересчитывает (setBadgeCount нигде не зовётся), а тихий read-пуш нести badge не может — включённый
 * сейчас значок залип бы с последним числом. Включать APNS_BADGE=on вместе со сборкой iOS, которая
 * выставляет значок при открытии и после прочтения (тем же правилом: заглушённые не считаются).
 *
 * Модуль намеренно не тянет realtime/socket: его грузит воркер пушей.
 */
import prisma from "../lib/prisma";
import env from "../config/env";
import logger from "../config/logger";

export function apnsBadgeEnabled(): boolean {
  return env.APNS_BADGE === "on";
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
