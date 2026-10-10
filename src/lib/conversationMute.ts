/**
 * «Без звука» для бесед: хранение, события, фильтр пушей. Правила — src/lib/conversationMuteRules.ts,
 * контракт клиентам — docs/conversation-mute.md.
 *
 * Поле ConversationParticipant.mutedUntil — личная настройка участника. Prisma-клиент (lib/prisma.ts)
 * глобально его ОПУСКАЕТ, чтобы оно не уходило другим участникам в participants[] (список бесед,
 * conversations:updated, треды, бот…). Читать его можно только явно: select: { mutedUntil: true }
 * или omit: { mutedUntil: false } — так, как это делает этот модуль и GET /api/conversations.
 *
 * Истечение — без уборки: всюду сравнение mutedUntil > now в момент решения.
 */
import prisma from "./prisma";
import logger from "../config/logger";
import { getIO } from "../realtime/socket";
import { isMutedAt, muteView, shouldAlert, type MuteView } from "./conversationMuteRules";

export * from "./conversationMuteRules";

const userRoom = (userId: string) => `user:${userId}`;

/** conversation:mute — во все сокеты человека (user:<id>), включая тот, что поставил. */
export type ConversationMuteEvent = MuteView & {
  conversationId: string;
  /** Момент изменения по часам сервера (ISO). Клиент применяет событие, только если at ≥ своего asOf. */
  at: string;
  /** Устройство, с которого поменяли (если запрос его назвал). */
  byDeviceId?: string;
};

/** conversation:mute:snapshot — при КАЖДОМ подключении сокета, только ему. Замена целиком. */
export type ConversationMuteSnapshot = {
  items: Array<{ conversationId: string; mutedUntil: string; mutedForever: boolean }>;
  serverNow: string;
};

/** Ответ POST /api/conversations/:id/mute. */
export type MuteResponse = MuteView & { conversationId: string; serverNow: string };

/** userId → mutedUntil тех участников беседы, у кого она заглушена в nowMs. Один запрос. */
export async function mutedRecipients(
  conversationId: string,
  nowMs: number = Date.now(),
  userIds?: readonly string[],
): Promise<Map<string, Date>> {
  const rows = await prisma.conversationParticipant.findMany({
    where: {
      conversationId,
      mutedUntil: { gt: new Date(nowMs) },
      ...(userIds ? { userId: { in: [...userIds] } } : {}),
    },
    select: { userId: true, mutedUntil: true },
  });
  const out = new Map<string, Date>();
  for (const r of rows) if (r.mutedUntil && isMutedAt(r.mutedUntil, nowMs)) out.set(r.userId, r.mutedUntil);
  return out;
}

export type AlertContext = {
  /** Conversation.isGroup */
  isGroup: boolean;
  /** message.replyTo?.senderId */
  replyToSenderId?: string | null;
  /** isCallSystemMessage(message) */
  callSystem?: boolean;
};

/**
 * Решение «будить ли» для всех получателей одного события беседы: (recipientId) → true = будить.
 * Сбой БД — будить всех, как до «Без звука» (лишнее уведомление лучше потерянного).
 */
export async function loadAlertGate(
  conversationId: string,
  ctx: AlertContext,
  nowMs: number = Date.now(),
): Promise<(recipientId: string) => boolean> {
  // Запись о звонке 1:1 будит всегда — незачем спрашивать БД.
  if (!ctx.isGroup && ctx.callSystem === true) return () => true;
  let muted: Map<string, Date>;
  try {
    muted = await mutedRecipients(conversationId, nowMs);
  } catch (error) {
    logger.warn({ error, conversationId }, "mute: failed to load muted recipients — alerting everyone");
    return () => true;
  }
  if (muted.size === 0) return () => true;
  return (recipientId: string) =>
    shouldAlert({
      mutedUntil: muted.get(recipientId) ?? null,
      nowMs,
      isGroup: ctx.isGroup,
      recipientId,
      replyToSenderId: ctx.replyToSenderId ?? null,
      callSystem: ctx.callSystem === true,
    });
}

/**
 * Поставить/снять «Без звука» (until уже нормализован: null — включить звук). Шлёт conversation:mute
 * во все сокеты человека. null — человек не участник беседы (или беседы нет).
 *
 * Порядок событий: at берётся ПОСЛЕ записи, а значение перечитывается ПОСЛЕ at. Тогда у события с
 * бОльшим at значение не старее, чем у любого другого, и клиенту достаточно правила «at ≥ asOf»
 * (а снапшот/список берут serverNow ДО чтения) — гонка двух устройств сходится к значению в БД.
 */
export async function setConversationMute(
  userId: string,
  conversationId: string,
  until: Date | null,
  byDeviceId?: string | null,
): Promise<MuteResponse | null> {
  const res = await prisma.conversationParticipant.updateMany({
    where: { conversationId, userId },
    data: { mutedUntil: until },
  });
  if (res.count === 0) return null;
  const at = Date.now();
  const row = await prisma.conversationParticipant.findFirst({
    where: { conversationId, userId },
    select: { mutedUntil: true },
  });
  if (!row) return null; // вышел из беседы между записью и чтением
  const view = muteView(row.mutedUntil, at);
  const atIso = new Date(at).toISOString();
  const event: ConversationMuteEvent = {
    conversationId,
    ...view,
    at: atIso,
    ...(byDeviceId ? { byDeviceId } : {}),
  };
  try {
    getIO()?.to(userRoom(userId)).emit("conversation:mute", event);
  } catch (error) {
    logger.warn({ error, userId, conversationId }, "mute: failed to emit conversation:mute");
  }
  return { conversationId, ...view, serverNow: atIso };
}

/** Снапшот для подключившегося сокета: только заглушённые сейчас. serverNow — ДО чтения. */
export async function muteSnapshot(userId: string, nowMs: number = Date.now()): Promise<ConversationMuteSnapshot> {
  const rows = await prisma.conversationParticipant.findMany({
    where: { userId, mutedUntil: { gt: new Date(nowMs) } },
    select: { conversationId: true, mutedUntil: true },
  });
  const items: ConversationMuteSnapshot["items"] = [];
  for (const r of rows) {
    const v = muteView(r.mutedUntil, nowMs);
    if (v.mutedUntil) items.push({ conversationId: r.conversationId, mutedUntil: v.mutedUntil, mutedForever: v.mutedForever });
  }
  return { items, serverNow: new Date(nowMs).toISOString() };
}
