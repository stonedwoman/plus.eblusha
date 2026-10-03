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
 * не защищает (от него защищают ключи устройств, Еблуша 2.0). Это не замена клиентским затворам.
 *
 * Группы на этапе 0 не трогаем: их сегодня не шифрует ни один клиент (подписаны «Без шифрования»).
 *
 * Беседа берётся из имени комнаты `conv-<conversationId>` (так её называют все клиенты и
 * POST /livekit/token). Сравнивать roomName с id беседы напрямую нельзя — так страховка молча
 * не срабатывала бы никогда (В11). Подлинность события проверяет вызывающий: WebhookReceiver
 * с LIVEKIT_API_KEY/SECRET, неподписанный запрос получает 401 до этой функции.
 */
import { RoomServiceClient, TrackType } from "livekit-server-sdk";
import env from "../config/env";
import logger from "../config/logger";
import prisma from "./prisma";

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
  | { action: "ignore"; reason: "conversation_not_found" | "group_call"; conversationId: string }
  | { action: "evict"; conversationId: string; roomName: string; identity: string; trackSid: string | null };

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
  const conversation = await findConversation(conversationId);
  if (!conversation) return { action: "ignore", reason: "conversation_not_found", conversationId };
  if (conversation.isGroup) return { action: "ignore", reason: "group_call", conversationId };
  const trackSid = typeof track.sid === "string" && track.sid.trim() ? track.sid.trim() : null;
  return { action: "evict", conversationId, roomName, identity, trackSid };
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
    // Вебхук ждёт ответа: 60 с по умолчанию у SDK — слишком долго.
    roomService = new RoomServiceClient(livekitApiUrl(), env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, {
      requestTimeout: 5,
    });
  }
  return roomService;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type EvictionResult = { muted: boolean; removed: boolean };

/** Глушим дорожку (перестаёт пересылаться сразу) и выкидываем участника из комнаты. */
export async function evictUnencryptedParticipant(
  verdict: Extract<CallEncryptionVerdict, { action: "evict" }>,
  details: { trackType?: unknown; trackSource?: unknown } = {}
): Promise<EvictionResult> {
  const { roomName, identity, trackSid, conversationId } = verdict;
  const svc = getRoomService();
  let muted = false;
  if (trackSid) {
    try {
      await svc.mutePublishedTrack(roomName, identity, trackSid, true);
      muted = true;
    } catch (error) {
      logger.warn({ err: error, conversationId, roomName, identity, trackSid }, "call-e2ee: не удалось заглушить незашифрованную дорожку");
    }
  }
  let removed = false;
  for (let attempt = 1; attempt <= 2 && !removed; attempt += 1) {
    try {
      await svc.removeParticipant(roomName, identity);
      removed = true;
    } catch (error) {
      logger.error(
        { err: error, conversationId, roomName, identity, attempt },
        "call-e2ee: не удалось выкинуть участника с незашифрованной дорожкой"
      );
      if (attempt < 2) await sleep(300);
    }
  }
  // Громкий след в журнале: в звонке 1:1 появилась открытая дорожка. Ключей здесь нет — только
  // кто, где и что сделано.
  logger.error(
    {
      conversationId,
      roomName,
      identity,
      trackSid,
      trackType: details.trackType,
      trackSource: details.trackSource,
      muted,
      removed,
    },
    removed
      ? "call-e2ee: незашифрованная дорожка в звонке 1:1 — участник выкинут из комнаты"
      : "call-e2ee: незашифрованная дорожка в звонке 1:1 — выкинуть участника НЕ удалось"
  );
  return { muted, removed };
}

/** Вебхук track_published → решение → (если надо) выкинуть. Ошибки не роняют обработку вебхука. */
export async function enforceCallEncryption(
  evt: CallEncryptionEvent,
  findConversation: ConversationLookup = lookupConversation
): Promise<CallEncryptionVerdict> {
  let verdict: CallEncryptionVerdict;
  try {
    verdict = await judgeCallEncryptionEvent(evt, findConversation);
  } catch (error) {
    // Без беседы не понять, 1:1 это или группа, а выкидывать из группы нельзя (там пока все без
    // шифрования). Поэтому не выкидываем, но громко пишем: клиентские затворы 1:1 остаются.
    logger.error({ err: error, room: evt.room?.name, identity: evt.participant?.identity }, "call-e2ee: проверка вебхука упала");
    return { action: "ignore", reason: "lookup_failed" };
  }
  if (verdict.action === "evict") {
    try {
      await evictUnencryptedParticipant(verdict, { trackType: evt.track?.type, trackSource: evt.track?.source });
    } catch (error) {
      logger.error({ err: error, conversationId: verdict.conversationId, identity: verdict.identity }, "call-e2ee: выкинуть не удалось");
    }
  } else if (verdict.reason === "conversation_not_found") {
    logger.warn({ conversationId: verdict.conversationId, room: evt.room?.name }, "call-e2ee: открытая дорожка в комнате несуществующей беседы");
  }
  return verdict;
}
