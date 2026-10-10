import type { Request } from "express";
import logger from "../config/logger";
import prisma from "../lib/prisma";
import { getRedisClient } from "../lib/redis";
import { resolveCurrentDeviceId } from "../lib/currentDevice";
import { enqueuePush } from "../jobs/queue";
import type { PushPayload } from "./types";

/**
 * read-sync: «беседу прочитали на одном устройстве» → все ОСТАЛЬНЫЕ устройства того же человека
 * снимают уже показанные уведомления этой беседы. Любые комбинации: iPhone, Android, ПК (натив),
 * веб — и обычные, и секретные беседы.
 *
 * Два канала, оба несут один и тот же момент прочтения readAt (мс, часы сервера):
 *  1. Сокет: событие "conversation:read-self" {conversationId, readAt, byDeviceId?} в комнату
 *     ПОЛЬЗОВАТЕЛЯ user:<id> — в неё входит каждый его сокет при подключении, где бы он ни сидел
 *     (беседа открыта, другая беседа, свёрнуто в трей). Сразу, без дребезга: это дёшево, а живым
 *     клиентам (натив ПК, Android с ConnectionService, веб) нужно мгновенно. Уходит и самому
 *     читающему устройству (byDeviceId), чтобы у всех клиентов был один путь снятия уведомлений.
 *  2. Тихий пуш {kind:"read", conversationId, readAt} на iOS (APNs background) и Android (FCM data,
 *     priority normal) — для устройств, у которых сейчас нет живого сокета. Читающее устройство
 *     исключается. Дребезг (ниже), а readAt подставляет воркер уже при отправке.
 *
 * Где вызывается: POST /messages/mark-conversation-read и POST /messages/receipts (READ/SEEN) —
 * это единственные пути, которыми клиенты сообщают серверу «прочитал». Для секретных бесед
 * сигнала-квитанции нет вовсе (облачных Message там нет), поэтому тот же mark-conversation-read
 * принимает и их: в секретке он ничего не пишет в БД, только запускает read-sync.
 *
 * Дребезг пуша — не чаще раза в 5 с на (пользователь, беседа), в Redis, «передний + хвостовой»:
 *  - первое событие уходит сразу;
 *  - события внутри окна НЕ теряются, а сворачиваются в ОДИН отложенный пуш на конец окна.
 * Хвост нужен не для красоты: пока человек читает живую переписку на ПК, сообщения идут каждые
 * пару секунд, и без хвоста уведомление второго сообщения осталось бы на телефоне — «прочитано» к
 * нему пришло бы внутри окна и было бы выброшено. Окно хвоста считается заново от его отправки,
 * так что при непрерывном чтении пуши идут ровно раз в 5 с. Окно общее для iOS и Android: это
 * одна задача очереди, провайдеров разводит sendPushToUsers.
 *
 * Пуш не ставим вовсе, если у человека нет живых push-токенов (кроме устройства, которое само
 * прочитало: оно снимает уведомления у себя). Сокет-событие уходит всегда.
 * Функции НИКОГДА не бросают: «прочитано» не должно ломаться из-за Redis, сокета или очереди.
 */

export const READ_SYNC_WINDOW_MS = 5_000;

/** Имя сокет-события «прочитано на одном из моих устройств». */
export const READ_SELF_EVENT = "conversation:read-self" as const;

/** Тело сокет-события (контракт для клиентов — см. описание ServerToClientEvents в realtime/socket.ts). */
export type ReadSelfEvent = {
  conversationId: string;
  /** Момент прочтения, мс эпохи, часы сервера. Тот же, что уйдёт в read-пуш. */
  readAt: number;
  /** Устройство, на котором прочитали; нет поля — сервер не смог его определить. */
  byDeviceId?: string;
};

const lastKey = (userId: string, conversationId: string) => `readsync:last:${userId}:${conversationId}`;
const trailKey = (userId: string, conversationId: string) => `readsync:trail:${userId}:${conversationId}`;
const atKey = (userId: string, conversationId: string) => `readsync:at:${userId}:${conversationId}`;
/** Как apns-expiration / FCM ttl у read-пуша: дольше пуш всё равно не живёт. */
const READ_AT_TTL_MS = 3_600_000;

/**
 * readAt в Redis только растёт: два «прочитано» с разных устройств в одну миллисекунду обгоняют
 * друг друга в асинхронщине, и более раннее не должно затереть более позднее (иначе хвостовой пуш
 * оставил бы уведомление, пришедшее между ними).
 */
const SET_READ_AT_MAX_LUA = `
local cur = tonumber(redis.call('GET', KEYS[1]) or '0') or 0
local nxt = tonumber(ARGV[1])
if nxt > cur then
  redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
else
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 1
`;

export type ReadSyncOutcome = "sent" | "deferred" | "throttled" | "no-push" | "error";

/**
 * Пуш-часть одного «прочитано» по одной беседе. readerDeviceId — устройство, которое прочитало
 * (исключаем из пуша); readAt — момент прочтения (по умолчанию «сейчас»).
 */
export async function notifyConversationRead(opts: {
  userId: string;
  conversationId: string;
  readerDeviceId?: string | null | undefined;
  readAt?: number | undefined;
}): Promise<ReadSyncOutcome> {
  const { userId, conversationId } = opts;
  const readerDeviceId = opts.readerDeviceId || null;
  const readAt = opts.readAt ?? Date.now();
  try {
    // Любой живой alert-токен: APNs (iOS) или FCM (Android). VoIP-токены сюда не идут никогда.
    const pushDevices = await prisma.userDevice.count({
      where: {
        userId,
        revokedAt: null,
        pushToken: { not: null },
        ...(readerDeviceId ? { NOT: { id: readerDeviceId } } : {}),
      },
    });
    if (pushDevices === 0) return "no-push";

    const payload = { kind: "read", conversationId } as const;
    const excludeDeviceIds = readerDeviceId ? [readerDeviceId] : undefined;
    const redis = await getRedisClient();
    const last = lastKey(userId, conversationId);
    // Момент прочтения — в пуш его подставит воркер (attachReadAt) уже при отправке: пуш-хвост
    // уходит до 5 с спустя, и за это время в беседе могло прийти непрочитанное сообщение, уведомление
    // которого снимать нельзя. Пишем при КАЖДОМ событии, в том числе свёрнутом в хвост.
    await redis.eval(SET_READ_AT_MAX_LUA, {
      keys: [atKey(userId, conversationId)],
      arguments: [String(readAt), String(READ_AT_TTL_MS)],
    });

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
 * Сокет-часть: событие в комнату пользователя (все его подключённые устройства). Не бросает.
 * socket.ts грузим динамически: этот модуль импортирует и воркер пушей (ради attachReadAt), а ему
 * сокет-сервер со всеми его зависимостями не нужен. В процессе API модуль уже загружен — импорт
 * из кэша, getIO() вернёт живой сервер (с redis-адаптером: событие дойдёт и до сокетов на других
 * инстансах). В воркере getIO() = null — молча ничего.
 */
export async function emitReadSelf(userId: string, event: ReadSelfEvent): Promise<boolean> {
  try {
    const { getIO } = await import("../realtime/socket");
    const io = getIO();
    if (!io) return false;
    io.to(`user:${userId}`).emit(READ_SELF_EVENT, event);
    return true;
  } catch (error) {
    logger.warn({ error, conversationId: event.conversationId }, "read-sync: socket emit failed");
    return false;
  }
}

/**
 * Запуск из HTTP-маршрута: после ответа клиенту, не блокируя его. Устройство-читатель берём из
 * запроса (did токена / X-Device-Id) — тем же резолвером, что /devices и /secret.
 * Момент прочтения фиксируем сразу, при обработке запроса, — он один для сокет-события и пуша.
 */
export function scheduleReadSync(req: Request, userId: string, conversationIds: Iterable<string>): void {
  const ids = Array.from(new Set(conversationIds)).filter(Boolean);
  if (ids.length === 0) return;
  const readAt = Date.now();
  void (async () => {
    let readerDeviceId: string | null = null;
    try {
      readerDeviceId = await resolveCurrentDeviceId(req);
    } catch {
      // Не определили устройство — не страшно: оно просто получит лишний тихий пуш, а в
      // сокет-событии не будет byDeviceId.
    }
    for (const conversationId of ids) {
      await emitReadSelf(userId, { conversationId, readAt, ...(readerDeviceId ? { byDeviceId: readerDeviceId } : {}) });
      await notifyConversationRead({ userId, conversationId, readerDeviceId, readAt });
    }
  })();
}

/**
 * Воркер, перед отправкой: дописать в read-пуш момент последнего прочтения (readAt); остальные
 * пуши — как есть. Не бросает. Нет записи в Redis или он недоступен — берём fallbackMs (время
 * постановки задачи: не позже настоящего прочтения, так что лишнего уведомления не снимем). Совсем
 * без времени пуш уходить не должен: приложение сняло бы вообще все уведомления беседы.
 */
export async function attachReadAt(
  userIds: string[],
  payload: PushPayload,
  fallbackMs: number,
): Promise<PushPayload> {
  if (payload.kind !== "read" || payload.readAt !== undefined) return payload;
  let readAt = fallbackMs;
  try {
    const userId = userIds[0];
    if (userId) {
      const raw = await (await getRedisClient()).get(atKey(userId, payload.conversationId));
      const parsed = raw ? Number(raw) : NaN;
      if (Number.isFinite(parsed) && parsed > 0) readAt = parsed;
    }
  } catch (error) {
    logger.warn({ error, conversationId: payload.conversationId }, "read-sync: readAt lookup failed");
  }
  return { ...payload, readAt };
}
