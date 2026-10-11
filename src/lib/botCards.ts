/**
 * Карточки бота «Еблуша» (Bot Cards v1, docs/bot-cards.md) — общая инфраструктура таймера обещания
 * (src/lib/promiseTimer.ts) и «поделиться перепиской» (src/lib/botShare.ts).
 *
 * Карточка — обычное сообщение бота (Message.isBot), чьё состояние меняет ТОЛЬКО сервер:
 *   metadata.bot  = { v:1, kind:"card", triggerMessageId, askerId }
 *   metadata.card = { v:1, type, id, rev, state, closed, actions:[{id, who:{any}|{ids}, until}], data }
 * `content` — запасной текст для старых клиентов, превью и поиска (сервер переписывает его при каждой смене,
 * без editedAt). Права решает сервер под замком строки типа; actions — подсказка клиенту.
 *
 * Здесь: реестр типов, вставка и рассылка карточки (без src/lib/systemBot.ts → createBotMessage — у карточки свой
 * конверт и пуш только нужным), запись новой версии в той же транзакции, что и переход типа, событие
 * message:update {reason:"card", cardType, message, card, serverNow} после фиксации и общий разбор прав.
 */
import { Prisma } from "@prisma/client";
import logger from "../config/logger";
import prisma from "./prisma";
import { publishNewMessage, SENT_MESSAGE_INCLUDE } from "./messageFanout";
import { getIO } from "../realtime/socket";
import { publishMessageUpdate } from "../realtime/events";

export type CardType = "promise" | "share";
export type CardWho = { any: true } | { ids: string[] };
export interface CardAction {
  id: string;
  who: CardWho;
  /** ISO; null — без срока. */
  until: string | null;
}

export interface CardEnvelope {
  v: 1;
  type: CardType;
  /** id записи типа (PromiseTimer.id / BotShare.id). */
  id: string;
  rev: number;
  state: string;
  /** Финал: действий нет, кроме действий с until (вроде «Вернуть»). */
  closed: boolean;
  actions: CardAction[];
  data: Record<string, unknown>;
}

/** include сообщения карточки в ответах и событиях (как у правки сообщения). */
export const CARD_MESSAGE_INCLUDE = {
  sender: { select: { id: true, username: true, displayName: true, isBot: true } },
  attachments: true,
  reactions: { include: { user: { select: { id: true, username: true, displayName: true, isBot: true } } } },
  receipts: true,
  replyTo: { select: { id: true, content: true, senderId: true, createdAt: true, isBot: true } },
} as const;

/** Ошибка действия по карточке — уходит клиенту как {message, code, card?, serverNow}. */
export class CardError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly card: CardEnvelope | null = null,
  ) {
    super(message);
    this.name = "CardError";
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** metadata.card сообщения (наш конверт v1) или null. */
export function cardOf(metadata: unknown): CardEnvelope | null {
  if (!isObj(metadata)) return null;
  const b = metadata.bot;
  if (!isObj(b) || b.kind !== "card") return null;
  const c = metadata.card;
  if (!isObj(c) || c.v !== 1 || (c.type !== "promise" && c.type !== "share") || typeof c.id !== "string") return null;
  return c as unknown as CardEnvelope;
}

/** Может ли зритель действие сейчас (те же правила, что у клиентов: who + until; у закрытой — только с until). */
export function canActOn(card: CardEnvelope, actionId: string, userId: string, nowMs: number): "ok" | "forbidden" | "expired" | "closed" {
  const a = card.actions.find((x) => x.id === actionId);
  if (!a) return "closed";
  const until = a.until ? Date.parse(a.until) : null;
  if (card.closed && until === null) return "closed";
  if (until !== null && !(until > nowMs)) return "expired";
  if ("any" in a.who) return "ok";
  return a.who.ids.includes(userId) ? "ok" : "forbidden";
}

/** Бросить ошибку прав по итогу canActOn. */
export function assertCanAct(card: CardEnvelope, actionId: string, userId: string, nowMs: number): void {
  const r = canActOn(card, actionId, userId, nowMs);
  if (r === "ok") return;
  if (r === "forbidden") throw new CardError(403, "CARD_FORBIDDEN", "This action is not yours", card);
  if (r === "expired") throw new CardError(409, "CARD_ACTION_EXPIRED", "The action has expired", card);
  throw new CardError(409, "CARD_CLOSED", "The card does not allow this now", card);
}

// ───────────────────────────── реестр типов ─────────────────────────────

export interface CardActInput {
  /** Сообщение-карточка (как в БД). */
  message: { id: string; conversationId: string; metadata: unknown };
  card: CardEnvelope;
  userId: string;
  action: string;
  input: unknown;
  now: Date;
}

export interface CardActResult {
  /** id сообщения карточки (для ответа и события) — то же, что message.id. */
  messageId: string;
  conversationId: string;
}

export interface CardTypeHandler {
  /** Тип включён (выключатели BOT_SHARE=off, PROMISE_TIMERS=off). Выключен — действия 404 CARD_TYPE_DISABLED. */
  enabled(): boolean;
  /**
   * Выполнить действие: сам берёт замок строки типа, проверяет состояние и права (assertCanAct), пишет новую
   * версию карточки (writeCardTx) и публикует событие после фиксации. Ошибки — CardError.
   */
  act(input: CardActInput): Promise<CardActResult>;
}

const handlers = new Map<CardType, CardTypeHandler>();

export function registerCardType(type: CardType, handler: CardTypeHandler): void {
  handlers.set(type, handler);
}

export function cardHandler(type: CardType): CardTypeHandler | null {
  return handlers.get(type) ?? null;
}

// ───────────────────────────── вставка, запись, событие ─────────────────────────────

type Tx = Prisma.TransactionClient;

/** Сообщение-карточка в транзакции типа (рассылка — announceCardMessage после фиксации). */
export async function insertCardMessage(
  tx: Tx,
  opts: {
    botId: string;
    conversationId: string;
    replyToId: string | null;
    triggerMessageId: string;
    askerId: string;
    card: CardEnvelope;
    content: string;
  },
) {
  return tx.message.create({
    data: {
      conversationId: opts.conversationId,
      senderId: opts.botId,
      isBot: true,
      type: "TEXT",
      content: opts.content,
      replyToId: opts.replyToId,
      metadata: {
        bot: { v: 1, kind: "card", triggerMessageId: opts.triggerMessageId, askerId: opts.askerId },
        card: opts.card,
      } as unknown as Prisma.InputJsonValue,
    },
    include: SENT_MESSAGE_INCLUDE,
  });
}

/** Разослать только что вставленную карточку (message:new всем, пуш — pushTo или всем). Не бросает. */
export async function announceCardMessage(opts: {
  conversationId: string;
  botId: string;
  message: Parameters<typeof publishNewMessage>[0]["message"];
  content: string;
  pushTo?: string[];
}): Promise<void> {
  try {
    await publishNewMessage({
      conversationId: opts.conversationId,
      message: opts.message,
      senderId: opts.botId,
      secret: false,
      type: "TEXT",
      content: opts.content,
      linkPreview: false,
      previewUserId: opts.botId,
      ...(opts.pushTo ? { pushTo: opts.pushTo } : {}),
    });
  } catch (error) {
    logger.warn({ error, conversationId: opts.conversationId }, "cards: announce failed");
  }
}

/** Новая версия карточки в транзакции типа: metadata.card и запасной текст (metadata.bot и прочее — как было). */
export async function writeCardTx(tx: Tx, messageId: string, card: CardEnvelope, content: string, extraBot?: Record<string, unknown>): Promise<void> {
  const cur = await tx.message.findUnique({ where: { id: messageId }, select: { metadata: true, deletedAt: true } });
  if (!cur || cur.deletedAt) return;
  const meta: Record<string, unknown> = isObj(cur.metadata) ? { ...(cur.metadata as Record<string, unknown>) } : {};
  if (extraBot && isObj(meta.bot)) meta.bot = { ...meta.bot, ...extraBot };
  meta.card = card as unknown;
  await tx.message.update({
    where: { id: messageId },
    data: { content: content.slice(0, 2000), metadata: meta as unknown as Prisma.InputJsonValue },
  });
}

/**
 * Событие карточки после фиксации: message:update {reason:"card", cardType, message, card, serverNow} в комнату
 * беседы. В процессе backend — прямо в Socket.IO, иначе (воркер) — через Redis-мост. Не бросает.
 */
export async function publishCardUpdate(messageId: string): Promise<{ message: unknown; card: CardEnvelope | null } | null> {
  try {
    const message = await prisma.message.findUnique({ where: { id: messageId }, include: CARD_MESSAGE_INCLUDE });
    if (!message || message.deletedAt) return null;
    const card = cardOf(message.metadata);
    if (!card) return null;
    const payload = {
      conversationId: message.conversationId,
      messageId,
      reason: "card",
      cardType: card.type,
      message,
      card,
      serverNow: new Date().toISOString(),
    };
    const io = getIO();
    if (io) io.to(message.conversationId).emit("message:update", payload);
    else await publishMessageUpdate(payload);
    return { message, card };
  } catch (error) {
    logger.warn({ error, messageId }, "cards: update publish failed");
    return null;
  }
}

/** Сообщение-карточка с include и её конверт (для ответов клиентам). */
export async function loadCardMessage(messageId: string) {
  const message = await prisma.message.findUnique({ where: { id: messageId }, include: CARD_MESSAGE_INCLUDE });
  if (!message || message.deletedAt || !message.isBot) return null;
  const card = cardOf(message.metadata);
  if (!card) return null;
  return { message, card };
}

/** Действия со сроком → ISO или null. */
export const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

/** Имена людей для карточек (displayName — как выбрали сами; без склонения). */
export async function displayNames(ids: Array<string | null | undefined>): Promise<Map<string, string>> {
  const list = [...new Set(ids.filter((x): x is string => !!x))];
  if (!list.length) return new Map();
  const users = await prisma.user.findMany({ where: { id: { in: list } }, select: { id: true, displayName: true, username: true } });
  return new Map(users.map((u) => [u.id, (u.displayName ?? "").trim() || u.username || "Участник"]));
}
