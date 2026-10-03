/**
 * Страховка «звонок 1:1 без шифрования невозможен» на стороне сервера (ТЗ E2EE звонков, этап 0:
 * §5.9, §8.4; правка скептика В11).
 *
 * Что закрывает. Старые телефоны при ЛЮБОМ сбое получения ключа (сеть, 403/404/5xx, длина) молча
 * собирали комнату LiveKit без E2EE и публиковали микрофон. LiveKit пишет это в метку публикации
 * TrackInfo.encryption = NONE и присылает вебхук track_published. Если такая звуковая или
 * видеодорожка появилась в комнате беседы один на один, дорожку глушим, а участника выкидываем
 * из комнаты — старый телефон честно завершит звонок вместо открытого разговора.
 *
 * Чего НЕ даёт. Метку ставит клиент, а пересылает сервер: от самого владельца сервера страховка
 * не защищает (от него защищают ключи устройств, Еблуша 2.0). Это не замена клиентским затворам
 * (веб, iOS и натив сами не играют дорожку NONE в шифрованном звонке).
 *
 * Группы на этапе 0 не трогаем: их сегодня не шифрует ни один клиент (подписаны «Без шифрования»).
 *
 * Беседа берётся из имени комнаты `conv-<conversationId>` (так её называют все клиенты и
 * POST /livekit/token). Сравнивать roomName с id беседы напрямую нельзя — так страховка молча
 * не срабатывала бы никогда (В11). Подлинность события проверяет вызывающий: WebhookReceiver
 * с LIVEKIT_API_KEY/SECRET, неподписанный запрос получает 401 до этой функции.
 *
 * Как выполняется (по ревью этапа 0).
 *  - В ФОНЕ, после ответа на вебхук ([startCallEncryptionEnforcement]): RoomService может отвечать
 *    до 5 с на вызов, а обработчик вебхука, ждущий его, держит очередь вебхуков комнаты в LiveKit.
 *    Подпись и дедуп остаются синхронными (routes/livekit.ts).
 *  - С ПОВТОРАМИ: и поиск беседы (сбой БД), и выкидывание (RoomService недоступен) повторяются
 *    несколько раз с растущими паузами. Раньше один неудачный вызов оставлял открытую дорожку в
 *    комнате навсегда: ключ дедупа уже стоял, и LiveKit повтор не присылал.
 *  - С ЗАПРЕТОМ НА ВОЗВРАТ: RemoveParticipant не отзывает токен (он живёт 12 ч), и клиент с циклом
 *    переподключения снова отдавал бы открытый звук до следующего вебхука. Поэтому до выкидывания
 *    ставим в Redis короткий запрет на это устройство в этой комнате, а POST /livekit/token его
 *    соблюдает ([isBlockedFromCallRoom]).
 */
import { RoomServiceClient, TrackType } from "livekit-server-sdk";
import env from "../config/env";
import logger from "../config/logger";
import prisma from "./prisma";
import { getRedisClient } from "./redis";

/** Префикс имени комнаты звонка беседы (routes/livekit.ts, все клиенты). */
export const CALL_ROOM_PREFIX = "conv-";

/** `conv-<id>` → `<id>`; всё остальное (в т.ч. голый id беседы) — не комната звонка беседы. */
export function conversationIdFromCallRoom(roomName: string | null | undefined): string | null {
  const name = typeof roomName === "string" ? roomName.trim() : "";
  if (!name.startsWith(CALL_ROOM_PREFIX)) return null;
  const id = name.slice(CALL_ROOM_PREFIX.length).trim();
  return id.length > 0 ? id : null;
}

/**
 * livekit.Encryption.Type: NONE = 0, GCM = 1, CUSTOM = 2. Отсутствие поля в JSON вебхука —
 * тоже NONE (значение по умолчанию protobuf): клиент без шифрования метку просто не шлёт.
 */
export function isUnencryptedTrack(encryption: unknown): boolean {
  return encryption === undefined || encryption === null || encryption === 0 || encryption === "NONE";
}

function isMediaTrack(type: unknown): boolean {
  return type === TrackType.AUDIO || type === TrackType.VIDEO || type === "AUDIO" || type === "VIDEO";
}

/** Минимум полей WebhookEvent, который нужен решению (удобно и для тестов). */
export type CallEncryptionEvent = {
  event?: string | null;
  room?: { name?: string | null } | null;
  participant?: { identity?: string | null } | null;
  track?: { sid?: string | null; type?: unknown; source?: unknown; encryption?: unknown } | null;
};

export type CallEncryptionVerdict =
  | {
      action: "ignore";
      reason: "not_track_published" | "not_media" | "encrypted" | "not_call_room" | "no_participant" | "lookup_failed";
    }
  | { action: "ignore"; reason: "group_call"; conversationId: string }
  | {
      action: "evict";
      /**
       * one_to_one — беседа 1:1 (в т.ч. секретная). conversation_not_found — беседы с таким id нет:
       * токен в её комнату выдать уже нельзя (POST /livekit/token проверяет участие), значит, там
       * сидит кто-то с токеном удалённой беседы; законного звонка в такой комнате нет.
       */
      reason: "one_to_one" | "conversation_not_found";
      conversationId: string;
      roomName: string;
      identity: string;
      trackSid: string | null;
    };

type ConversationLookup = (conversationId: string) => Promise<{ isGroup: boolean } | null>;

const lookupConversation: ConversationLookup = (conversationId) =>
  prisma.conversation.findUnique({ where: { id: conversationId }, select: { isGroup: true } });

/** Решение по одному вебхуку: ничего не делает, только смотрит событие и беседу. */
export async function judgeCallEncryptionEvent(
  evt: CallEncryptionEvent,
  findConversation: ConversationLookup = lookupConversation
): Promise<CallEncryptionVerdict> {
  if (evt.event !== "track_published") return { action: "ignore", reason: "not_track_published" };
  const track = evt.track ?? null;
  if (!track || !isMediaTrack(track.type)) return { action: "ignore", reason: "not_media" };
  if (!isUnencryptedTrack(track.encryption)) return { action: "ignore", reason: "encrypted" };
  const roomName = (evt.room?.name ?? "").trim();
  const conversationId = conversationIdFromCallRoom(roomName);
  if (!conversationId) return { action: "ignore", reason: "not_call_room" };
  const identity = (evt.participant?.identity ?? "").trim();
  if (!identity) return { action: "ignore", reason: "no_participant" };
  const trackSid = typeof track.sid === "string" && track.sid.trim() ? track.sid.trim() : null;
  const conversation = await findConversation(conversationId);
  if (!conversation) {
    return { action: "evict", reason: "conversation_not_found", conversationId, roomName, identity, trackSid };
  }
  if (conversation.isGroup) return { action: "ignore", reason: "group_call", conversationId };
  return { action: "evict", reason: "one_to_one", conversationId, roomName, identity, trackSid };
}

/**
 * Адрес API LiveKit для вызовов сервер→сервер (RoomService). LIVEKIT_API_URL → LIVEKIT_URL
 * (ws→http делает сам SDK) → контейнер livekit в сети докера (deploy/docker-compose.full.yml,
 * порт 7880 из deploy/livekit.yaml; оттуда же LiveKit шлёт вебхуки на backend:4000).
 */
export function livekitApiUrl(): string {
  return env.LIVEKIT_API_URL ?? env.LIVEKIT_URL ?? "http://livekit:7880";
}

let roomService: RoomServiceClient | null = null;
function getRoomService(): RoomServiceClient {
  if (!roomService) {
    // Один вызов не должен висеть: 60 с по умолчанию у SDK — слишком долго, повторы — наши.
    roomService = new RoomServiceClient(livekitApiUrl(), env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, {
      requestTimeout: 5,
    });
  }
  return roomService;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- Запрет на возврат в комнату -----------------------------------------------------------

/** Сколько выкинутому устройству не выдаём пропуск в ту же комнату (POST /livekit/token). */
export const CALL_E2EE_BAN_TTL_SECONDS = 120;
const CALL_E2EE_BAN_PREFIX = "call_e2ee_ban:";

export function callEncryptionBanKey(roomName: string, identity: string): string {
  return `${CALL_E2EE_BAN_PREFIX}${roomName}:${identity}`;
}

/** Устройство недавно выкинуто из этой комнаты за открытую дорожку — пропуск не выдаём. */
export async function isBlockedFromCallRoom(roomName: string, identity: string): Promise<boolean> {
  const redis = await getRedisClient();
  return (await redis.exists(callEncryptionBanKey(roomName, identity))) > 0;
}

async function blockFromCallRoom(roomName: string, identity: string): Promise<boolean> {
  try {
    const redis = await getRedisClient();
    await redis.set(callEncryptionBanKey(roomName, identity), "1", { EX: CALL_E2EE_BAN_TTL_SECONDS });
    return true;
  } catch (error) {
    logger.error({ err: error, roomName, identity }, "call-e2ee: не удалось поставить запрет на возврат в комнату");
    return false;
  }
}

// ---- Выкидывание с повторами ---------------------------------------------------------------

/** Паузы перед попытками выкинуть (первая — сразу): ~26 с на всё. */
export const EVICT_RETRY_DELAYS_MS: readonly number[] = [0, 1_000, 3_000, 7_000, 15_000];
/** Паузы перед попытками найти беседу, если БД не ответила. */
export const LOOKUP_RETRY_DELAYS_MS: readonly number[] = [0, 500, 2_000, 5_000];

/** Участника в комнате уже нет — выкидывать некого, это успех. */
function isNotFound(error: unknown): boolean {
  const e = error as { status?: unknown; code?: unknown } | null | undefined;
  return e?.status === 404 || e?.code === "not_found";
}

export type EvictionResult = { muted: boolean; removed: boolean; blocked: boolean; attempts: number };

/** Ставим запрет на возврат, глушим дорожку (перестаёт пересылаться сразу) и выкидываем участника. */
export async function evictUnencryptedParticipant(
  verdict: Extract<CallEncryptionVerdict, { action: "evict" }>,
  details: { trackType?: unknown; trackSource?: unknown } = {},
  delaysMs: readonly number[] = EVICT_RETRY_DELAYS_MS
): Promise<EvictionResult> {
  const { roomName, identity, trackSid, conversationId } = verdict;
  // Запрет — ДО выкидывания: иначе клиент с циклом переподключения успел бы взять новый пропуск.
  const blocked = await blockFromCallRoom(roomName, identity);
  const svc = getRoomService();
  let muted = false;
  let removed = false;
  let attempts = 0;
  for (const delay of delaysMs.length > 0 ? delaysMs : [0]) {
    if (delay > 0) await sleep(delay);
    attempts += 1;
    if (trackSid && !muted) {
      try {
        await svc.mutePublishedTrack(roomName, identity, trackSid, true);
        muted = true;
      } catch (error) {
        logger.warn({ err: error, conversationId, roomName, identity, trackSid, attempt: attempts }, "call-e2ee: не удалось заглушить незашифрованную дорожку");
      }
    }
    try {
      await svc.removeParticipant(roomName, identity);
      removed = true;
    } catch (error) {
      if (isNotFound(error)) {
        removed = true; // уже ушёл сам
      } else {
        logger.error(
          { err: error, conversationId, roomName, identity, attempt: attempts },
          "call-e2ee: не удалось выкинуть участника с незашифрованной дорожкой"
        );
      }
    }
    if (removed) break;
  }
  // Громкий след в журнале: в звонке 1:1 появилась открытая дорожка. Ключей здесь нет — только
  // кто, где и что сделано.
  logger.error(
    {
      conversationId,
      roomName,
      identity,
      trackSid,
      reason: verdict.reason,
      trackType: details.trackType,
      trackSource: details.trackSource,
      muted,
      removed,
      blocked,
      attempts,
    },
    removed
      ? "call-e2ee: незашифрованная дорожка в звонке 1:1 — участник выкинут из комнаты"
      : "call-e2ee: незашифрованная дорожка в звонке 1:1 — выкинуть участника НЕ удалось (все попытки)"
  );
  return { muted, removed, blocked, attempts };
}

export type EnforceOptions = {
  findConversation?: ConversationLookup;
  lookupDelaysMs?: readonly number[];
  evictDelaysMs?: readonly number[];
};

export type EnforcementOutcome = { verdict: CallEncryptionVerdict; eviction: EvictionResult | null };

/** Вебхук track_published → решение (с повторами поиска беседы) → (если надо) выкинуть с повторами. */
export async function enforceCallEncryption(evt: CallEncryptionEvent, options: EnforceOptions = {}): Promise<EnforcementOutcome> {
  const findConversation = options.findConversation ?? lookupConversation;
  const lookupDelays = options.lookupDelaysMs ?? LOOKUP_RETRY_DELAYS_MS;
  let verdict: CallEncryptionVerdict | null = null;
  let lastError: unknown = null;
  for (const delay of lookupDelays.length > 0 ? lookupDelays : [0]) {
    if (delay > 0) await sleep(delay);
    try {
      verdict = await judgeCallEncryptionEvent(evt, findConversation);
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!verdict) {
    // Без беседы не понять, 1:1 это или группа, а выкидывать из группы нельзя (там пока все без
    // шифрования). Поэтому не выкидываем, но громко пишем: клиентские затворы 1:1 остаются.
    logger.error({ err: lastError, room: evt.room?.name, identity: evt.participant?.identity }, "call-e2ee: проверка вебхука упала (все попытки)");
    return { verdict: { action: "ignore", reason: "lookup_failed" }, eviction: null };
  }
  if (verdict.action !== "evict") return { verdict, eviction: null };
  if (verdict.reason === "conversation_not_found") {
    logger.warn({ conversationId: verdict.conversationId, room: evt.room?.name }, "call-e2ee: открытая дорожка в комнате несуществующей беседы — выкидываем");
  }
  try {
    const eviction = await evictUnencryptedParticipant(
      verdict,
      { trackType: evt.track?.type, trackSource: evt.track?.source },
      options.evictDelaysMs ?? EVICT_RETRY_DELAYS_MS
    );
    return { verdict, eviction };
  } catch (error) {
    logger.error({ err: error, conversationId: verdict.conversationId, identity: verdict.identity }, "call-e2ee: выкинуть не удалось");
    return { verdict, eviction: null };
  }
}

// ---- Фоновый запуск ----------------------------------------------------------------------

const pending = new Set<Promise<unknown>>();

/**
 * Запустить страховку в фоне и сразу вернуть управление: обработчик вебхука отвечает LiveKit,
 * не дожидаясь RoomService. Ошибки не всплывают — всё уже записано в журнал.
 */
export function startCallEncryptionEnforcement(evt: CallEncryptionEvent, options: EnforceOptions = {}): void {
  const p = enforceCallEncryption(evt, options).catch((error) => {
    logger.error({ err: error, room: evt.room?.name, identity: evt.participant?.identity }, "call-e2ee: фоновая страховка упала");
  });
  pending.add(p);
  void p.finally(() => pending.delete(p));
}

/** Для тестов и мягкой остановки: дождаться всех запущенных фоновых проверок. */
export async function whenCallEncryptionIdle(): Promise<void> {
  while (pending.size > 0) {
    await Promise.allSettled(Array.from(pending));
  }
}
