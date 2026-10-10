import crypto from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import logger from "../config/logger";
import prisma from "./prisma";
import { getRedisClient } from "./redis";
import { publishNewMessage, SENT_MESSAGE_INCLUDE } from "./messageFanout";
import { enqueueBotJob } from "../jobs/queue";
import { getIO } from "../realtime/socket";
import {
  BOT_JOB_CHAIN_MAX,
  type BotAddressVia,
  type BotConversationKind,
  type BotJob,
  type BotJobAttachment,
  type BotJobMessage,
} from "./botContract";

/**
 * Бот «Еблуша» — часть системы мессенджера (решения владельца 2026-10-10).
 *
 *  - Бот НЕ участник бесед. Он «живёт» в каждой обычной беседе (личке и группе): конвейер отправки
 *    (POST /conversations/send — единственный путь создания пользовательских сообщений; сокет
 *    создаёт только SYSTEM-записи звонков, правка не считается) замечает обращение к боту
 *    (detectBotAddress) и кладёт задачу в очередь BullMQ `bot` (dispatchToBot): триггер + цепочка
 *    его ответов, БЕЗ остальной переписки. Сервис бота (bot/) — потребитель этой очереди.
 *  - Ответ бот публикует POST /api/bot/messages с разрешением (grant) из задачи: только в ту беседу,
 *    где к нему обратились, ограниченным числом сообщений и в течение BOT_GRANT_TTL_SECONDS.
 *    Сообщение бота — обычное облачное Message с isBot=true от системного пользователя (User.isBot),
 *    рассылка и пуши как у любого сообщения (lib/messageFanout.ts).
 *  - Секретные беседы: сервер их текста не видит (S1, /send отвечает 409 раньше), задач нет; отказ
 *    «бот тут не работает» показывает клиент локально (BOT_SECRET_REFUSAL).
 *  - Личный «Чат с Еблушей» — по умолчанию ВЫКЛЮЧЕН. Включение (PUT /api/bot/settings) создаёт
 *    беседу 1:1 пользователь↔бот (бот в ней участник — это единственная такая беседа); там всё
 *    адресовано боту без «Еблуша,». Выключение снимает участие пользователя (история сохраняется
 *    и вернётся при включении). Признак «включено» = пользователь участник этой беседы.
 *  - Бот не попадает в контакты, группы, секретные треды и звонки (contacts.ts, conversations.ts,
 *    threads.ts, socket.ts call:invite).
 */

export const BOT_SETTINGS_EVENT = "bot:settings" as const;

/** Текст честного отказа для секретных чатов — клиент показывает его ЛОКАЛЬНО (на сервер не уходит). */
export const BOT_SECRET_REFUSAL =
  "Еблуша не работает в секретных чатах: их сообщения не видит даже сервер, и боту они не уходят.";

export const BOT_WELCOME_TEXT = [
  "Привет! Я — **Еблуша**, бот этого мессенджера.",
  "",
  "- Здесь можно писать мне без обращения.",
  "- В любой обычной беседе позови: «Еблуша, …» или `/eb …`, а продолжай ответом на моё сообщение.",
  "- В секретных чатах я не работаю.",
  "",
  "Выключить этот чат: настройки → «Чат с Еблушей».",
].join("\n");

/** Сколько живёт разрешение ответить (ответ модели с поиском — до нескольких минут). */
export const BOT_GRANT_TTL_SECONDS = 20 * 60;
/** Сообщений бота на одно обращение (длинный ответ частями + картинки + подтверждение). */
export const BOT_GRANT_MAX_MESSAGES = 12;
/** Реакций бота на одно обращение («спасибо» → 👍). */
export const BOT_GRANT_MAX_REACTIONS = 3;
/** Обращений к боту от одного человека в минуту — защита очереди от флуда (лимиты денег — в боте). */
export const BOT_DISPATCH_PER_MINUTE = 20;
/** Уведомлений бота в личный чат человека (без обращения) в час. */
export const BOT_NOTICES_PER_HOUR = 30;

const userRoom = (userId: string) => `user:${userId}`;

type Db = PrismaClient | Prisma.TransactionClient;

// ───────────────────────────── Системный бот ─────────────────────────────

export interface SystemBotProfile {
  id: string;
  displayName: string | null;
  avatarUrl: string | null;
  eblid: string | null;
  bio: string | null;
}

let cached: { at: number; bot: SystemBotProfile | null } | null = null;
const FOUND_CACHE_MS = 60_000;
const MISSING_CACHE_MS = 5_000;

/**
 * Системный бот: пользователь с isBot=true (не удалён, не заблокирован; самый ранний, если вдруг
 * их несколько). null — бот не заведён (src/scripts/seedBotUser.ts): обращения просто не ловятся.
 */
export async function getSystemBot(): Promise<SystemBotProfile | null> {
  const now = Date.now();
  if (cached && now - cached.at < (cached.bot ? FOUND_CACHE_MS : MISSING_CACHE_MS)) return cached.bot;
  try {
    const bot = await prisma.user.findFirst({
      where: { isBot: true, deletedAt: null, bannedAt: null },
      orderBy: { createdAt: "asc" },
      select: { id: true, displayName: true, avatarUrl: true, eblid: true, bio: true },
    });
    cached = { at: now, bot: bot ?? null };
    return cached.bot;
  } catch (error) {
    logger.warn({ error }, "bot: system bot lookup failed");
    return cached?.bot ?? null;
  }
}

/** Сбросить кэш (сид/настройка бота, тесты). */
export function resetSystemBotCache(): void {
  cached = null;
}

// ───────────────────────────── Обращение к боту ─────────────────────────────

const NAME = "еблуша";

/** Свернуть начало к виду «еблуша»: регистр, ё, похожая латиница (как в bot/src/core/invoke.ts). */
function foldHead(s: string): string {
  const map: Record<string, string> = { e: "е", a: "а", y: "у", "6": "б", b: "б", w: "ш", ё: "е" };
  return Array.from(s.toLowerCase())
    .map((ch) => map[ch] ?? ch)
    .join("");
}

/** «Еблуша,» / «Еблуша:» / «Еблуша!» в начале (можно с @ и пробелами) → остаток, иначе null. */
export function stripBotNamePrefix(content: string): string | null {
  const m = /^\s*@?/.exec(content);
  const start = m ? m[0].length : 0;
  const head = content.slice(start, start + NAME.length);
  if (foldHead(head) !== NAME) return null;
  const after = content.slice(start + NAME.length);
  const p = /^\s*[,:!]/.exec(after);
  if (!p) return null;
  return after.slice(p[0].length).trim();
}

/** «/eb …», «/еб …» (любой регистр) → остаток (может быть пустым), иначе null. */
export function stripBotCommandPrefix(content: string): string | null {
  const m = /^\s*\/(?:eb|еб)(?=$|\s)/iu.exec(content);
  if (!m) return null;
  return content.slice(m[0].length).trim();
}

export interface BotAddressInput {
  type: string;
  content: string | null | undefined;
  /** metadata.botAsk от клиента: false — «не боту» (Backspace по плашке), true — режим «Спросить». */
  botAsk?: boolean | undefined;
  /** Беседа — личный чат с ботом. */
  isBotChat: boolean;
  /** replyToId указывает на сообщение бота в этой же беседе. */
  replyToIsBot: boolean;
  /** Пересылка (metadata.forwardFrom): чужой текст — не обращение. */
  isForward: boolean;
}

/** Адресовано ли сообщение боту (и как). null — нет. Чистая функция, правила владельца. */
export function detectBotAddress(i: BotAddressInput): BotAddressVia | null {
  if (i.type === "SYSTEM" || i.type === "CALL") return null;
  if (i.botAsk === false) return null;
  if (i.isBotChat) return "botchat";
  // Голосовое вне «Чата с Еблушей» — людям, даже ответом боту: слушать бот не умеет, а его «напиши текстом»
  // в общей беседе — шум. Клиенты шлют с голосовым botAsk по-разному — решает сервер, одинаково для всех.
  if (i.type === "AUDIO") return null;
  if (i.botAsk === true) return "explicit";
  if (i.isForward) return null;
  const text = i.content ?? "";
  if (stripBotNamePrefix(text) !== null) return "name";
  if (stripBotCommandPrefix(text) !== null) return "command";
  if (i.replyToIsBot) return "reply";
  return null;
}

/** Служебные ключи metadata, которые задаёт только сервер. */
const RESERVED_META_KEYS = ["bot", "isBot", "botAsk"] as const;

/**
 * Достать metadata.botAsk клиента и убрать служебные ключи из metadata отправителя.
 * Вернёт новую metadata (undefined, если была undefined) и botAsk (только boolean, иначе undefined).
 */
export function takeBotMeta(meta: Record<string, unknown> | undefined): {
  meta: Record<string, unknown> | undefined;
  botAsk: boolean | undefined;
} {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return { meta, botAsk: undefined };
  const raw = meta.botAsk;
  const botAsk = typeof raw === "boolean" ? raw : undefined;
  if (!RESERVED_META_KEYS.some((k) => Object.prototype.hasOwnProperty.call(meta, k))) return { meta, botAsk };
  const out: Record<string, unknown> = { ...meta };
  for (const k of RESERVED_META_KEYS) delete out[k];
  return { meta: out, botAsk };
}

// ───────────────────────────── Личный чат с ботом ─────────────────────────────

export interface BotChatState {
  botChatEnabled: boolean;
  /** Беседа «Чат с Еблушей», если включён; иначе null. */
  conversationId: string | null;
}

/** Беседа пользователя с ботом: активная (он участник) или «припаркованная» (выключил). */
async function findBotChatRow(db: Db, userId: string, botId: string): Promise<{ id: string; member: boolean } | null> {
  const base = { isGroup: false, type: "CLOUD" as const, isSecret: false };
  const active = await db.conversation.findFirst({
    where: { ...base, AND: [{ participants: { some: { userId } } }, { participants: { some: { userId: botId } } }] },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  if (active) return { id: active.id, member: true };
  const parked = await db.conversation.findFirst({
    where: { ...base, createdById: userId, participants: { some: { userId: botId } } },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  return parked ? { id: parked.id, member: false } : null;
}

export async function getBotChatState(userId: string): Promise<BotChatState> {
  const bot = await getSystemBot();
  if (!bot || bot.id === userId) return { botChatEnabled: false, conversationId: null };
  const row = await findBotChatRow(prisma, userId, bot.id);
  return row?.member ? { botChatEnabled: true, conversationId: row.id } : { botChatEnabled: false, conversationId: null };
}

/** Беседа — личный чат с ботом (не группа, облачная, бот среди участников). */
export function isBotChatShape(
  conv: { isGroup: boolean; type?: unknown; isSecret?: unknown },
  participantIds: string[],
  botId: string,
): boolean {
  return !conv.isGroup && conv.type !== "SECRET" && conv.isSecret !== true && participantIds.includes(botId);
}

export class BotNotConfiguredError extends Error {
  constructor() {
    super("system bot is not configured");
    this.name = "BotNotConfiguredError";
  }
}

/**
 * Включить/выключить «Чат с Еблушей». Идемпотентно. Своим устройствам — bot:settings и
 * conversations:new / conversations:deleted. При первом включении бот здоровается (без модели).
 */
export async function setBotChatEnabled(userId: string, enabled: boolean): Promise<BotChatState> {
  const bot = await getSystemBot();
  if (!bot) throw new BotNotConfiguredError();
  if (bot.id === userId) throw new Error("bot cannot chat with itself");

  const r = await prisma.$transaction(async (tx) => {
    // Два устройства жмут переключатель одновременно — без замка вышли бы две беседы с ботом.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`botchat:${userId}`}))`;
    const row = await findBotChatRow(tx, userId, bot.id);
    if (enabled) {
      if (row?.member) return { id: row.id, changed: false, created: false };
      if (row) {
        await tx.conversationParticipant.create({ data: { conversationId: row.id, userId } });
        return { id: row.id, changed: true, created: false };
      }
      const conv = await tx.conversation.create({
        data: {
          isGroup: false,
          type: "CLOUD",
          isSecret: false,
          secretStatus: "ACTIVE",
          createdById: userId,
          participants: { create: [{ userId }, { userId: bot.id }] },
        },
        select: { id: true },
      });
      return { id: conv.id, changed: true, created: true };
    }
    if (!row?.member) return { id: null as string | null, changed: false, created: false };
    await tx.conversationParticipant.deleteMany({ where: { conversationId: row.id, userId } });
    return { id: row.id, changed: true, created: false };
  });

  const state: BotChatState = enabled
    ? { botChatEnabled: true, conversationId: r.id }
    : { botChatEnabled: false, conversationId: null };

  if (r.created && r.id) {
    try {
      await createBotMessage({ botId: bot.id, conversationId: r.id, type: "TEXT", content: BOT_WELCOME_TEXT, kind: "welcome" });
    } catch (error) {
      logger.warn({ error, conversationId: r.id }, "bot: welcome message failed");
    }
  }
  const io = getIO();
  if (r.changed && r.id) {
    io?.to(userRoom(userId)).emit(enabled ? "conversations:new" : "conversations:deleted", { conversationId: r.id });
  }
  io?.to(userRoom(userId)).emit(BOT_SETTINGS_EVENT, state);
  logger.info({ userId, enabled, changed: r.changed, created: r.created }, "bot: chat setting");
  return state;
}

/** Активный «Чат с Еблушей» пользователя (он участник) или null. */
export async function findActiveBotChat(userId: string, botId: string): Promise<string | null> {
  const row = await findBotChatRow(prisma, userId, botId);
  return row?.member ? row.id : null;
}

// ───────────────────────────── Сообщение от бота ─────────────────────────────

export type BotMessageKind = "answer" | "command" | "notice" | "confirm" | "welcome";
export const BOT_MESSAGE_KINDS: readonly BotMessageKind[] = ["answer", "command", "notice", "confirm", "welcome"];

export interface BotMessageAttachmentInput {
  url: string;
  type: "IMAGE" | "FILE";
  size?: number | undefined;
  metadata?: Record<string, unknown> | undefined;
}

/**
 * Создать и разослать сообщение бота. Проверки прав — у вызывающего (routes/bot.ts, setBotChatEnabled).
 * metadata.bot = {v:1, kind, triggerMessageId?} — подсказка клиентам (кнопка «Уточнить» и т.п.);
 * признак «это бот» — Message.isBot / sender.isBot.
 */
export async function createBotMessage(opts: {
  botId: string;
  conversationId: string;
  type: "TEXT" | "IMAGE" | "FILE";
  content?: string | null;
  replyToId?: string | null;
  attachments?: BotMessageAttachmentInput[];
  kind: BotMessageKind;
  triggerMessageId?: string | null;
  linkPreview?: boolean;
}) {
  const attachments = opts.attachments ?? [];
  const message = await prisma.message.create({
    data: {
      conversationId: opts.conversationId,
      senderId: opts.botId,
      isBot: true,
      type: opts.type,
      content: opts.content ?? null,
      replyToId: opts.replyToId ?? null,
      metadata: {
        bot: { v: 1, kind: opts.kind, ...(opts.triggerMessageId ? { triggerMessageId: opts.triggerMessageId } : {}) },
      } as Prisma.InputJsonValue,
      ...(attachments.length
        ? {
            attachments: {
              create: attachments.map((a) => ({
                url: a.url,
                type: a.type,
                size: a.size ?? null,
                ...(a.metadata !== undefined ? { metadata: a.metadata as Prisma.InputJsonValue } : {}),
              })),
            },
          }
        : {}),
    },
    include: SENT_MESSAGE_INCLUDE,
  });
  await publishNewMessage({
    conversationId: opts.conversationId,
    message,
    senderId: opts.botId,
    secret: false,
    type: opts.type,
    content: opts.content ?? null,
    linkPreview: opts.linkPreview === true,
    previewUserId: opts.botId,
  });
  return message;
}

// ───────────────────────────── Разрешения (grant) ─────────────────────────────

export interface BotGrant {
  conversationId: string;
  triggerMessageId: string;
  authorId: string;
  kind: BotConversationKind;
}

const GRANT_RE = /^[A-Za-z0-9_-]{20,80}$/;
const grantKey = (token: string) => `bot:grant:${token}`;

export async function readBotGrant(token: unknown): Promise<BotGrant | null> {
  if (typeof token !== "string" || !GRANT_RE.test(token)) return null;
  try {
    const redis = await getRedisClient();
    const raw = await redis.get(grantKey(token));
    if (!raw) return null;
    const g = JSON.parse(raw) as Partial<BotGrant>;
    if (typeof g.conversationId !== "string" || typeof g.triggerMessageId !== "string" || typeof g.authorId !== "string") return null;
    return {
      conversationId: g.conversationId,
      triggerMessageId: g.triggerMessageId,
      authorId: g.authorId,
      kind: g.kind === "bot" || g.kind === "group" ? g.kind : "dm",
    };
  } catch (error) {
    logger.warn({ error }, "bot: grant read failed");
    return null;
  }
}

/** Израсходовать одно действие по разрешению. false — лимит исчерпан (или Redis недоступен). */
export async function spendBotGrant(token: string, what: "msg" | "react", max: number): Promise<boolean> {
  try {
    const redis = await getRedisClient();
    const key = `${grantKey(token)}:${what}`;
    const n = await redis.incr(key);
    if (n === 1) await redis.expire(key, BOT_GRANT_TTL_SECONDS);
    return n <= max;
  } catch (error) {
    logger.warn({ error }, "bot: grant spend failed");
    return false;
  }
}

/** Счётчик в окне (секунды). true — ещё можно. */
export async function botRateOk(key: string, windowSec: number, max: number): Promise<boolean> {
  try {
    const redis = await getRedisClient();
    const n = await redis.incr(key);
    if (n === 1) await redis.expire(key, windowSec);
    return n <= max;
  } catch {
    // Redis недоступен — очередь всё равно не поставится; уведомления не душим.
    return true;
  }
}

// ───────────────────────────── Задача боту ─────────────────────────────

type MessageRowForJob = {
  id: string;
  senderId: string;
  isBot: boolean;
  type: string;
  content: string | null;
  createdAt: Date;
  replyToId: string | null;
  sender?: { displayName: string | null } | null;
  attachments?: Array<{ url: string; type: string; size: number | null; metadata: unknown }> | null;
};

const ATTACHMENT_META_KEYS = ["width", "height", "mime", "originalName", "size", "duration", "durationMs"] as const;

function jobAttachment(a: { url: string; type: string; size: number | null; metadata: unknown }): BotJobAttachment {
  let metadata: Record<string, unknown> | null = null;
  if (a.metadata && typeof a.metadata === "object" && !Array.isArray(a.metadata)) {
    const src = a.metadata as Record<string, unknown>;
    metadata = {};
    for (const k of ATTACHMENT_META_KEYS) if (src[k] !== undefined) metadata[k] = src[k];
  }
  const type = a.type === "IMAGE" || a.type === "VIDEO" || a.type === "AUDIO" ? a.type : "FILE";
  return { url: a.url, type, size: a.size ?? null, metadata };
}

function jobMessage(m: MessageRowForJob): BotJobMessage {
  const type = (["TEXT", "IMAGE", "VIDEO", "AUDIO", "FILE"] as const).find((t) => t === m.type) ?? "TEXT";
  return {
    id: m.id,
    senderId: m.senderId,
    senderName: m.sender?.displayName ?? null,
    isBot: m.isBot === true,
    type,
    content: m.content ?? null,
    createdAt: new Date(m.createdAt).toISOString(),
    replyToId: m.replyToId ?? null,
    attachments: (m.attachments ?? []).map(jobAttachment),
  };
}

/** metadata.bot.triggerMessageId сообщения бота (на какое обращение это ответ) или null. */
export function botTriggerOf(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const b = (metadata as Record<string, unknown>).bot;
  if (!b || typeof b !== "object" || Array.isArray(b)) return null;
  const t = (b as Record<string, unknown>).triggerMessageId;
  return typeof t === "string" && t.length > 0 ? t : null;
}

/** Части одного ответа бота пишутся, пока живо разрешение; окно поиска частей — с запасом. */
const BOT_ANSWER_PARTS_WINDOW_MS = (BOT_GRANT_TTL_SECONDS + 5 * 60) * 1000;

/**
 * Предки сообщения по replyTo (от старшего к родителю), только эта беседа, без удалённых/истёкших/системных.
 *
 * Ответ бота на одно обращение бывает несколькими сообщениями (длинный текст частями, картинки отдельно),
 * а replyTo (цитата вопроса) есть только у ПЕРВОЙ части. Ответ человека на любую часть — продолжение
 * всего ответа: в цепочку идут все части этого ответа (общий metadata.bot.triggerMessageId), а дальше
 * вверх — от обращения. Иначе ответ на картинку или вторую часть приносил боту одну эту часть, без
 * вопроса и остального текста (а клиенты ставят «Уточнить» по-разному).
 */
export async function loadReplyChain(conversationId: string, parentId: string | null, max: number): Promise<BotJobMessage[]> {
  const out: BotJobMessage[] = [];
  const seen = new Set<string>();
  const now = new Date();
  const include = { sender: { select: { displayName: true } }, attachments: true } as const;
  const usable = (m: { conversationId: string; deletedAt: Date | null; expiresAt: Date | null; type: string }) =>
    m.conversationId === conversationId && !m.deletedAt && !(m.expiresAt && m.expiresAt <= now) && m.type !== "SYSTEM" && m.type !== "CALL";
  let pid = parentId;
  while (pid && out.length < max && !seen.has(pid)) {
    seen.add(pid);
    const m = await prisma.message.findUnique({ where: { id: pid }, include });
    if (!m || !usable(m)) break;
    const trigger = m.isBot ? botTriggerOf(m.metadata) : null;
    if (trigger) {
      const at = m.createdAt.getTime();
      const near = await prisma.message.findMany({
        where: {
          conversationId,
          isBot: true,
          deletedAt: null,
          createdAt: { gte: new Date(at - BOT_ANSWER_PARTS_WINDOW_MS), lte: new Date(at + BOT_ANSWER_PARTS_WINDOW_MS) },
        },
        orderBy: { createdAt: "asc" },
        take: 60,
        include,
      });
      const parts = near.filter((p) => p.id === m.id || (usable(p) && botTriggerOf(p.metadata) === trigger && !seen.has(p.id)));
      if (parts.length > 1 && parts.some((p) => p.id === m.id) && out.length + parts.length <= max) {
        for (const p of parts) seen.add(p.id);
        out.unshift(...parts.map((p) => jobMessage(p as MessageRowForJob)));
        // Вверх — от первой части (она цитирует обращение), а без цитаты — от самого обращения.
        pid = parts[0]!.replyToId ?? trigger;
        continue;
      }
    }
    out.unshift(jobMessage(m as MessageRowForJob));
    // Часть ответа без цитаты (картинка, продолжение текста) — всё равно ведёт к обращению.
    pid = m.replyToId ?? trigger;
  }
  return out;
}

/**
 * Поставить боту задачу на адресованное ему сообщение. НИКОГДА не бросает: сбой очереди не должен
 * ломать отправку сообщения. Возвращает, поставлена ли задача. В журнал — только id, без текста.
 */
export async function dispatchToBot(args: {
  botId: string;
  via: BotAddressVia;
  conversation: { id: string; isGroup: boolean; title: string | null; participantIds: string[] };
  message: MessageRowForJob;
}): Promise<boolean> {
  const { conversation: conv, message: m } = args;
  try {
    if (m.senderId === args.botId) return false;
    if (!(await botRateOk(`bot:rate:${m.senderId}`, 60, BOT_DISPATCH_PER_MINUTE))) {
      logger.warn({ conversationId: conv.id, messageId: m.id, userId: m.senderId }, "bot: dispatch rate-limited");
      return false;
    }
    const kind: BotConversationKind = conv.participantIds.includes(args.botId) && !conv.isGroup
      ? "bot"
      : conv.isGroup
        ? "group"
        : "dm";
    const chain = await loadReplyChain(conv.id, m.replyToId, BOT_JOB_CHAIN_MAX - 1);
    const grant = crypto.randomBytes(24).toString("base64url");
    const now = Date.now();
    const grantValue: BotGrant = { conversationId: conv.id, triggerMessageId: m.id, authorId: m.senderId, kind };
    const redis = await getRedisClient();
    await redis.set(grantKey(grant), JSON.stringify(grantValue), { EX: BOT_GRANT_TTL_SECONDS });
    const job: BotJob = {
      v: 1,
      kind: "message",
      enqueuedAt: now,
      grant,
      grantExpiresAt: now + BOT_GRANT_TTL_SECONDS * 1000,
      via: args.via,
      conversation: {
        id: conv.id,
        kind,
        title: conv.isGroup ? conv.title ?? null : null,
        participantIds: conv.participantIds.filter((id) => id !== args.botId),
      },
      author: { id: m.senderId, displayName: m.sender?.displayName ?? null },
      message: jobMessage(m),
      chain,
    };
    await enqueueBotJob(job, m.id);
    logger.info({ conversationId: conv.id, messageId: m.id, via: args.via, kind, chain: chain.length }, "bot: dispatched");
    return true;
  } catch (error) {
    logger.warn({ error, conversationId: conv.id, messageId: m.id }, "bot: dispatch failed");
    return false;
  }
}
