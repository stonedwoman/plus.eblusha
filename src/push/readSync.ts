import type { Request } from "express";
import logger from "../config/logger";
import prisma from "../lib/prisma";
import { getRedisClient } from "../lib/redis";
import { resolveCurrentDeviceId } from "../lib/currentDevice";
import { enqueuePush } from "../jobs/queue";

/**
 * «Беседу прочитали на другом устройстве» → тихий пуш {kind:"read", conversationId} на iOS-устройства
 * того же человека, чтобы телефон снял уже показанные баннеры этой беседы.
 *
 * Где вызывается: POST /messages/mark-conversation-read и POST /messages/receipts (READ/SEEN) —
 * это единственные пути, которыми клиенты сообщают серверу «прочитал». Для секретных бесед
 * сигнала-квитанции нет вовсе (облачных Message там нет), поэтому тот же mark-conversation-read
 * принимает и их: в секретке он ничего не пишет в БД, только запускает этот пуш.
 *
 * Дребезг — не чаще раза в 5 с на (пользователь, беседа), в Redis, «передний + хвостовой»:
 *  - первое событие уходит сразу;
 *  - события внутри окна НЕ теряются, а сворачиваются в ОДИН отложенный пуш на конец окна.
 * Хвост нужен не для красоты: пока человек читает живую переписку на ПК, сообщения идут каждые
 * пару секунд, и без хвоста баннер второго сообщения остался бы на телефоне — «прочитано» к
 * нему пришло бы внутри окна и было бы выброшено. Окно хвоста считается заново от его отправки,
 * так что при непрерывном чтении пуши идут ровно раз в 5 с.
 *
 * Не шлём вовсе, если у человека нет живых iOS-токенов (кроме устройства, которое само прочитало:
 * ему пуш не нужен — оно снимает баннеры у себя, см. clearDelivered в приложении).
 * Функции НИКОГДА не бросают: «прочитано» не должно ломаться из-за Redis или очереди.
 */

export const READ_SYNC_WINDOW_MS = 5_000;

const lastKey = (userId: string, conversationId: string) => `readsync:last:${userId}:${conversationId}`;
const trailKey = (userId: string, conversationId: string) => `readsync:trail:${userId}:${conversationId}`;

export type ReadSyncOutcome = "sent" | "deferred" | "throttled" | "no-ios" | "error";

/** Одно «прочитано» по одной беседе. readerDeviceId — устройство, которое прочитало (исключаем из пуша). */
export async function notifyConversationRead(opts: {
  userId: string;
  conversationId: string;
  readerDeviceId?: string | null | undefined;
}): Promise<ReadSyncOutcome> {
  const { userId, conversationId } = opts;
  const readerDeviceId = opts.readerDeviceId || null;
  try {
    const iosDevices = await prisma.userDevice.count({
      where: {
        userId,
        revokedAt: null,
        pushProvider: "apns",
        pushToken: { not: null },
        ...(readerDeviceId ? { NOT: { id: readerDeviceId } } : {}),
      },
    });
    if (iosDevices === 0) return "no-ios";

    const payload = { kind: "read", conversationId } as const;
    const excludeDeviceIds = readerDeviceId ? [readerDeviceId] : undefined;
    const redis = await getRedisClient();
    const last = lastKey(userId, conversationId);

    // Передний пуш: окно свободно — занимаем его и шлём сразу.
    if ((await redis.set(last, "1", { NX: true, PX: READ_SYNC_WINDOW_MS })) === "OK") {
      enqueuePush([userId], payload, undefined, { excludeDeviceIds });
      return "sent";
    }

    // Окно занято. Хвостовой пуш на его конец — один на окно (trail живёт ровно до конца окна).
    const remainingMs = await redis.pTTL(last);
    if (remainingMs <= 0) {
      // Окно закончилось между SET и PTTL (или ключ без TTL, чего быть не должно) — не задерживаем.
      await redis.set(last, "1", { PX: READ_SYNC_WINDOW_MS });
      enqueuePush([userId], payload, undefined, { excludeDeviceIds });
      return "sent";
    }
    if ((await redis.set(trailKey(userId, conversationId), "1", { NX: true, PX: remainingMs })) !== "OK") {
      return "throttled";
    }
    // Хвост сам занимает следующее окно: события сразу после него снова сворачиваются, а не бьют
    // вторым пушем впритык.
    await redis.pExpire(last, remainingMs + READ_SYNC_WINDOW_MS);
    enqueuePush([userId], payload, undefined, { excludeDeviceIds, delayMs: remainingMs + 50 });
    return "deferred";
  } catch (error) {
    logger.warn({ error, conversationId }, "read-sync: failed");
    return "error";
  }
}

/**
 * Запуск из HTTP-маршрута: после ответа клиенту, не блокируя его. Устройство-читатель берём из
 * запроса (did токена / X-Device-Id) — тем же резолвером, что /devices и /secret.
 */
export function scheduleReadSync(req: Request, userId: string, conversationIds: Iterable<string>): void {
  const ids = Array.from(new Set(conversationIds)).filter(Boolean);
  if (ids.length === 0) return;
  void (async () => {
    let readerDeviceId: string | null = null;
    try {
      readerDeviceId = await resolveCurrentDeviceId(req);
    } catch {
      // Не определили устройство — не страшно: оно просто получит лишний тихий пуш.
    }
    for (const conversationId of ids) {
      await notifyConversationRead({ userId, conversationId, readerDeviceId });
    }
  })();
}
