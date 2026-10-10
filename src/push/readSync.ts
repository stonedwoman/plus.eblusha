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
 *
 * Кого исключать из пуша, решает ВОРКЕР в момент отправки (resolveReadExclusion): устройство
 * ПОСЛЕДНЕГО прочтения — того, чей readAt едет в пуше. Хвост сворачивает прочтения разных устройств
 * (айфон, через секунду ПК), и исключать в нём устройство, которое прочитало раньше, нельзя: его
 * уведомления, пришедшие между двумя прочтениями, иначе так и висели бы.
 *
 * Догон при подключении (replayRecentReads): событие сокета не доходит до тех, кто в этот момент без
 * связи (ПК спал, телефон сменил сеть), а пуша ПК не получает вовсе. Поэтому каждое прочтение ещё и
 * запоминается (readsync:recent:<user>, сутки), и при КАЖДОМ подключении сокета сервер досылает ему
 * эти события с пометкой replay: true. Клиент применяет их тем же правилом readAt — это единственный
 * догон для секреток, у которых нет серверного счётчика непрочитанных.
 *
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
  /**
   * Догон при подключении сокета (replayRecentReads): прочтение было раньше, событие досылается. readAt —
   * настоящий момент прочтения (может быть часы назад), поэтому время ПРИХОДА такого события ничего не
   * говорит о расхождении часов клиента и сервера. byDeviceId в догоне нет.
   */
  replay?: true;
};

const lastKey = (userId: string, conversationId: string) => `readsync:last:${userId}:${conversationId}`;
const trailKey = (userId: string, conversationId: string) => `readsync:trail:${userId}:${conversationId}`;
const atKey = (userId: string, conversationId: string) => `readsync:at:${userId}:${conversationId}`;
/** Устройство, чей readAt сейчас лежит в atKey ('' — не определено или два устройства в одну мс). */
const atByKey = (userId: string, conversationId: string) => `readsync:atby:${userId}:${conversationId}`;
/** Недавние прочтения человека для догона при подключении сокета: zset conversationId → readAt. */
const recentKey = (userId: string) => `readsync:recent:${userId}`;
/** Как apns-expiration / FCM ttl у read-пуша: дольше пуш всё равно не живёт. */
const READ_AT_TTL_MS = 3_600_000;
/**
 * Сколько помнить прочтения для догона. Сутки: ПК, уснувший на ночь, утром должен погасить плашки и
 * всплывашки секреток, прочитанных ночью на телефоне (обычные беседы он догонит и по счётчикам).
 */
export const READ_REPLAY_WINDOW_MS = 24 * 3_600_000;
/** Не больше стольких бесед в догоне (самые свежие). */
export const READ_REPLAY_MAX = 100;

/**
 * readAt в Redis только растёт: два «прочитано» с разных устройств в одну миллисекунду обгоняют
 * друг друга в асинхронщине, и более раннее не должно затереть более позднее (иначе хвостовой пуш
 * оставил бы уведомление, пришедшее между ними). Рядом — устройство этого (последнего) прочтения:
 * его воркер исключит из пуша. Ничья в одну миллисекунду разными устройствами — '' (исключать некого).
 * KEYS: at, atby. ARGV: readAt, ttl, устройство-читатель ('' — не определено).
 */
const SET_READ_AT_MAX_LUA = `
local cur = tonumber(redis.call('GET', KEYS[1]) or '0') or 0
local nxt = tonumber(ARGV[1])
if nxt > cur then
  redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
  redis.call('SET', KEYS[2], ARGV[3], 'PX', ARGV[2])
else
  if nxt == cur and redis.call('GET', KEYS[2]) ~= ARGV[3] then
    redis.call('SET', KEYS[2], '', 'PX', ARGV[2])
  end
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
  redis.call('PEXPIRE', KEYS[2], ARGV[2])
end
return 1
`;

/**
 * Запомнить прочтение для догона: момент только растёт; старше окна — долой; бесед не больше
 * READ_REPLAY_MAX (лишние — самые старые). KEYS: recent. ARGV: readAt, conversationId, нижняя граница
 * окна, ttl, предел.
 */
const NOTE_RECENT_LUA = `
local cur = redis.call('ZSCORE', KEYS[1], ARGV[2])
if (not cur) or tonumber(ARGV[1]) > tonumber(cur) then
  redis.call('ZADD', KEYS[1], ARGV[1], ARGV[2])
end
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', '(' .. ARGV[3])
local n = redis.call('ZCARD', KEYS[1])
local max = tonumber(ARGV[5])
if n > max then
  redis.call('ZREMRANGEBYRANK', KEYS[1], 0, n - max - 1)
end
redis.call('PEXPIRE', KEYS[1], ARGV[4])
return 1
`;

/** Догон: беседы и readAt за окно, самые свежие первыми. KEYS: recent. ARGV: нижняя граница, предел. */
const LIST_RECENT_LUA = `
return redis.call('ZREVRANGEBYSCORE', KEYS[1], '+inf', ARGV[1], 'WITHSCORES', 'LIMIT', 0, tonumber(ARGV[2]))
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
      keys: [atKey(userId, conversationId), atByKey(userId, conversationId)],
      arguments: [String(readAt), String(READ_AT_TTL_MS), readerDeviceId ?? ""],
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

/** Запомнить прочтение для догона при подключении сокета (replayRecentReads). Не бросает. */
export async function noteRecentRead(userId: string, conversationId: string, readAt: number): Promise<void> {
  try {
    const redis = await getRedisClient();
    await redis.eval(NOTE_RECENT_LUA, {
      keys: [recentKey(userId)],
      arguments: [
        String(readAt),
        conversationId,
        String(Date.now() - READ_REPLAY_WINDOW_MS),
        String(READ_REPLAY_WINDOW_MS),
        String(READ_REPLAY_MAX),
      ],
    });
  } catch (error) {
    logger.warn({ error, conversationId }, "read-sync: recent read not stored");
  }
}

/**
 * Догон при подключении сокета: дослать ЭТОМУ сокету (emit — его socket.emit) события read-self обо всех
 * прочтениях человека за сутки, с пометкой replay: true и без byDeviceId. Событие сокета, ушедшее, пока
 * устройство было без связи, иначе потеряно навсегда: ПК пушей не получает, секретки по счётчикам не
 * догнать (их непрочитанных сервер не считает). Клиент снимает по тому же правилу readAt — только
 * показанное не позже прочтения, — так что повтор безвреден. Возвращает, сколько событий отправлено.
 * Не бросает.
 */
export async function replayRecentReads(userId: string, emit: (event: ReadSelfEvent) => void): Promise<number> {
  try {
    const redis = await getRedisClient();
    const rows = (await redis.eval(LIST_RECENT_LUA, {
      keys: [recentKey(userId)],
      arguments: [String(Date.now() - READ_REPLAY_WINDOW_MS), String(READ_REPLAY_MAX)],
    })) as unknown;
    if (!Array.isArray(rows)) return 0;
    let sent = 0;
    for (let i = 0; i + 1 < rows.length; i += 2) {
      const conversationId = String(rows[i] ?? "");
      const readAt = Number(rows[i + 1]);
      if (!conversationId || !Number.isFinite(readAt) || readAt <= 0) continue;
      emit({ conversationId, readAt: Math.floor(readAt), replay: true });
      sent += 1;
    }
    return sent;
  } catch (error) {
    logger.warn({ error, userId }, "read-sync: replay failed");
    return 0;
  }
}

/**
 * Запуск из HTTP-маршрута: после ответа клиенту, не блокируя его. Устройство-читатель берём из
 * запроса (did токена / X-Device-Id) — тем же резолвером, что /devices и /secret.
 * Момент прочтения фиксируем сразу, при обработке запроса, — он один для сокет-события, догона и пуша.
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
      await noteRecentRead(userId, conversationId, readAt);
      await emitReadSelf(userId, { conversationId, readAt, ...(readerDeviceId ? { byDeviceId: readerDeviceId } : {}) });
      await notifyConversationRead({ userId, conversationId, readerDeviceId, readAt });
    }
  })();
}

/**
 * Воркер, перед отправкой read-пуша: кого исключить. Устройство ПОСЛЕДНЕГО прочтения (его readAt и
 * уходит в пуше, attachReadAt): оно само уже прочитало всё до этого момента. Устройство, поставившее
 * задачу, — не обязательно оно: хвост дребезга сворачивает прочтения разных устройств, и айфон,
 * прочитавший первым, должен получить пуш о том, что следом прочитали на ПК, — иначе уведомление,
 * пришедшее ему между двумя прочтениями, повисло бы. Записи нет (Redis недоступен, задача старого
 * формата) — как решил маршрут (jobExclude). Не бросает.
 */
export async function resolveReadExclusion(
  userIds: string[],
  payload: PushPayload,
  jobExclude: string[] | undefined,
): Promise<string[] | undefined> {
  if (payload.kind !== "read") return jobExclude;
  try {
    const userId = userIds[0];
    if (!userId) return jobExclude;
    const raw = await (await getRedisClient()).get(atByKey(userId, payload.conversationId));
    if (raw === null || raw === undefined) return jobExclude;
    return raw ? [raw] : undefined;
  } catch (error) {
    logger.warn({ error, conversationId: payload.conversationId }, "read-sync: reader lookup failed");
    return jobExclude;
  }
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
