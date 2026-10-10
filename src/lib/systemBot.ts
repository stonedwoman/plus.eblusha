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
  BOT_JOB_REV,
  BOT_MEMLOG_EPOCH,
  BOT_MEMLOG_OVERLAP_MS,
  BOT_MEMLOG_PAGE,
  BOT_MEMLOG_RETENTION_DAYS,
  type BotAddressVia,
  type BotConversationKind,
  type BotHistoryMessage,
  type BotJob,
  type BotJobAttachment,
  type BotJobMessage,
  type BotMemoryChange,
  type BotMemoryStatus,
} from "./botContract";

/**
 * Бот «Еблуша» — часть системы мессенджера (решения владельца 2026-10-10 и 2026-10-11).
 *
 *  - Бот НЕ участник бесед. Он «живёт» в каждой обычной беседе (личке и группе): конвейер отправки
 *    (POST /conversations/send — единственный путь создания пользовательских сообщений; сокет
 *    создаёт только SYSTEM-записи звонков, правка не считается) замечает обращение к боту
 *    (detectBotAddress), помечает его metadata.botAsk и кладёт задачу в очередь BullMQ `bot`
 *    (dispatchToBot): триггер + цепочка его ответов. Сервис бота (bot/) — потребитель очереди.
 *  - Память бота о своих разговорах (контракт rev 3): бот сам берёт по разрешению задачи историю беседы —
 *    POST /api/bot/history (loadBotHistoryPage): в обычной беседе ТОЛЬКО разговоры с ботом (обращения от
 *    любого участника + его ответы) за всё время, БЕЗ остальной переписки людей; в «Чате с Еблушей» — весь
 *    чат. Удалили или поправили сообщение, которое бот мог запомнить, — запись в журнал изменений
 *    (botMemoryChangeOps, Postgres, в той же транзакции), бот по нему пересобирает сводку (botMemoryStatus).
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
  "- Здесь можно писать мне без обращения — весь наш разговор я помню.",
  "- В любой обычной беседе позови: «Еблуша, …». Все наши разговоры там я тоже помню, так что отвечать на моё сообщение не обязательно.",
  "- Команды не нужны — пиши словами, как человеку.",
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
/**
 * Продолжение (follow-up) — разрешение на отчёт о ДОЛГОЙ задаче в ту же беседу: агент Valheim после
 * «да» может ждать, пока все выйдут с сервера, до 49 ч (AGENT_RESTART_WAIT_HOURS). Берётся по живому
 * обычному разрешению (POST /api/bot/followup), из продолжения новое не взять, реакций нет.
 */
export const BOT_FOLLOWUP_TTL_SECONDS = 72 * 3600;
/** Сообщений по продолжению («применяю», «ждёт перезапуска», отчёт). */
export const BOT_FOLLOWUP_MAX_MESSAGES = 4;
/** Продолжений с одного обычного разрешения. */
export const BOT_FOLLOWUPS_PER_GRANT = 2;
/** Поисков людей (POST /api/bot/people) на одно обращение: привязка персонажей владельцем. */
export const BOT_GRANT_MAX_LOOKUPS = 20;
/** Сколько строк просматривает поиск людей по имени (новые раньше: свежие люди не отрезаются). */
export const BOT_PEOPLE_SCAN = 60;
/** Сколько найденных людей отдаём боту (лучшие совпадения первыми). */
export const BOT_PEOPLE_MATCHES_MAX = 25;
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
  /** Автор обращения, по разрешению которого написан ответ (grant.authorId): ему можно удалить этот ответ. */
  askerId?: string | null;
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
        bot: {
          v: 1,
          kind: opts.kind,
          ...(opts.triggerMessageId ? { triggerMessageId: opts.triggerMessageId } : {}),
          ...(opts.askerId ? { askerId: opts.askerId } : {}),
        },
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
  /** Продолжение (BOT_FOLLOWUP_*): живёт дольше, без реакций, продлить нельзя. */
  followup?: true;
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
      ...(g.followup === true ? { followup: true as const } : {}),
    };
  } catch (error) {
    logger.warn({ error }, "bot: grant read failed");
    return null;
  }
}

/** Израсходовать одно действие по разрешению. false — лимит исчерпан (или Redis недоступен). */
export async function spendBotGrant(
  token: string,
  what: "msg" | "react" | "followup" | "people" | "history",
  max: number,
  ttlSeconds = BOT_GRANT_TTL_SECONDS,
): Promise<boolean> {
  if (max <= 0) return false;
  try {
    const redis = await getRedisClient();
    const key = `${grantKey(token)}:${what}`;
    const n = await redis.incr(key);
    if (n === 1) await redis.expire(key, ttlSeconds);
    return n <= max;
  } catch (error) {
    logger.warn({ error }, "bot: grant spend failed");
    return false;
  }
}

/**
 * Продолжение по живому разрешению: та же беседа и то же обращение (удалят обращение — отчёт не
 * примут), свой счётчик сообщений, срок BOT_FOLLOWUP_TTL_SECONDS. Проверки — в маршруте.
 */
export async function createBotFollowupGrant(parent: BotGrant): Promise<{ grant: string; expiresAt: number }> {
  const redis = await getRedisClient();
  const grant = crypto.randomBytes(24).toString("base64url");
  const value: BotGrant = {
    conversationId: parent.conversationId,
    triggerMessageId: parent.triggerMessageId,
    authorId: parent.authorId,
    kind: parent.kind,
    followup: true,
  };
  await redis.set(grantKey(grant), JSON.stringify(value), { EX: BOT_FOLLOWUP_TTL_SECONDS });
  return { grant, expiresAt: Date.now() + BOT_FOLLOWUP_TTL_SECONDS * 1000 };
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

/** metadata.bot.kind сообщения бота (answer | command | notice | confirm | welcome) или null. */
export function botKindOf(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const b = (metadata as Record<string, unknown>).bot;
  if (!b || typeof b !== "object" || Array.isArray(b)) return null;
  const k = (b as Record<string, unknown>).kind;
  return typeof k === "string" && k.length > 0 ? k : null;
}

/** metadata.bot.askerId сообщения бота (автор обращения, на которое это ответ) или null — у старых ответов его нет. */
export function botAskerOf(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const b = (metadata as Record<string, unknown>).bot;
  if (!b || typeof b !== "object" || Array.isArray(b)) return null;
  const a = (b as Record<string, unknown>).askerId;
  return typeof a === "string" && a.length > 0 ? a : null;
}

/**
 * Может ли `userId` удалить ЧУЖОЕ для него сообщение — ответ бота (удаление для всех, как своё).
 * Да, если сообщение — не удалённое сообщение системного бота в обычной (не секретной) беседе,
 * где `userId` участник, и:
 *  - беседа — «Чат с Еблушей» (личка человека и бота): любое сообщение бота удаляет её человек-владелец;
 *  - иначе — тот, кто спросил: `metadata.bot.askerId` (если сервер его положил — решает только он;
 *    у отчёта агента Valheim это подтвердивший «да»), а у старых ответов без него — автор обращения
 *    `metadata.bot.triggerMessageId` в этой же беседе (senderId у удалённого обращения остаётся).
 * Сообщения людей и чужие пометки isBot сюда не попадают: false.
 */
export async function canDeleteBotMessage(
  msg: { conversationId: string; senderId: string | null; isBot: boolean; metadata: unknown; deletedAt: Date | null },
  userId: string,
): Promise<boolean> {
  if (!msg.isBot || msg.deletedAt || !msg.senderId) return false;
  const bot = await getSystemBot();
  if (!bot || bot.id !== msg.senderId || bot.id === userId) return false;
  const conv = await prisma.conversation.findUnique({
    where: { id: msg.conversationId },
    select: { isGroup: true, type: true, isSecret: true, participants: { select: { userId: true } } },
  });
  if (!conv || conv.type === "SECRET" || conv.isSecret) return false;
  const participantIds = conv.participants.map((p) => p.userId);
  if (!participantIds.includes(userId)) return false;
  if (isBotChatShape(conv, participantIds, bot.id)) return true;
  const asker = botAskerOf(msg.metadata);
  if (asker) return asker === userId;
  const trigger = botTriggerOf(msg.metadata);
  if (!trigger) return false;
  const t = await prisma.message.findUnique({ where: { id: trigger }, select: { conversationId: true, senderId: true } });
  return Boolean(t && t.conversationId === msg.conversationId && t.senderId === userId);
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

// ───────────────────────────── Память бота: история и журнал изменений ─────────────────────────────

const HISTORY_INCLUDE = { sender: { select: { displayName: true } }, attachments: true } as const;

/** metadata.botAsk === true — обращение к боту (ставит только конвейер отправки, takeBotMeta вычищает у клиента). */
export function botAskOf(metadata: unknown): boolean {
  return !!metadata && typeof metadata === "object" && !Array.isArray(metadata) && (metadata as Record<string, unknown>).botAsk === true;
}

function historyMessage(m: MessageRowForJob & { metadata?: unknown; expiresAt?: Date | null }): BotHistoryMessage {
  const j: BotHistoryMessage = jobMessage(m);
  if (m.isBot) {
    const t = botTriggerOf(m.metadata);
    if (t) j.triggerId = t;
  }
  if (m.expiresAt) j.expiresAt = new Date(m.expiresAt).toISOString();
  return j;
}

/**
 * Страница истории для памяти бота (POST /api/bot/history, контракт rev 3; решение владельца 2026-10-11 —
 * бот помнит ВСЕ свои разговоры в беседе, без окна и лимита сообщений):
 *  - «Чат с Еблушей» (kind "bot", mode "botchat"): весь чат — обе стороны, без приветствия бота;
 *  - обычная беседа ("dm" | "group", mode "recent"): ТОЛЬКО разговоры с ботом — обращения к нему
 *    (metadata.botAsk) от любого участника и ответы бота (isBot). Остальная переписка людей не читается.
 * Везде: без удалённых, истёкших, SYSTEM/CALL, зашифрованных (contentEncV ≠ 0) и без ответов бота на
 * обращение, которого больше нет (удалено, истекло, правкой перестало быть обращением): такой ответ мог
 * пересказывать вопрос. Порядок — (createdAt, id) по возрастанию, после курсора `after`, не новее «сейчас»
 * (что новее обращения, бот отсеет сам: ответы на прежние вопросы ему нужны, чужие новые вопросы — нет).
 * Секретных бесед здесь не бывает: разрешение выдаётся только на обычную.
 */
export async function loadBotHistoryPage(args: {
  conversationId: string;
  kind: BotConversationKind;
  after: { at: Date; id: string } | null;
  limit: number;
}): Promise<{ mode: "botchat" | "recent"; messages: BotHistoryMessage[]; next: { at: string; id: string } | null }> {
  const now = new Date();
  const mode = args.kind === "bot" ? "botchat" : "recent";
  if (args.limit <= 0) return { mode, messages: [], next: null };
  const and: Prisma.MessageWhereInput[] = [{ OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }];
  if (mode === "recent") and.push({ OR: [{ isBot: true }, { metadata: { path: ["botAsk"], equals: true } }] });
  if (args.after) {
    and.push({ OR: [{ createdAt: { gt: args.after.at } }, { createdAt: args.after.at, id: { gt: args.after.id } }] });
  }
  const rows = await prisma.message.findMany({
    where: {
      conversationId: args.conversationId,
      deletedAt: null,
      contentEncV: 0,
      type: { notIn: ["SYSTEM", "CALL"] },
      createdAt: { lte: now },
      AND: and,
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: args.limit + 1,
    include: HISTORY_INCLUDE,
  });
  const more = rows.length > args.limit;
  const page = more ? rows.slice(0, args.limit) : rows;
  const triggerIds = [...new Set(page.filter((r) => r.isBot).map((r) => botTriggerOf(r.metadata)).filter((t): t is string => !!t))];
  const alive = new Set<string>();
  if (triggerIds.length) {
    const ts = await prisma.message.findMany({
      where: { id: { in: triggerIds } },
      select: { id: true, conversationId: true, deletedAt: true, expiresAt: true, metadata: true },
    });
    for (const t of ts) {
      if (t.conversationId !== args.conversationId || t.deletedAt || (t.expiresAt && t.expiresAt <= now)) continue;
      if (mode === "recent" && !botAskOf(t.metadata)) continue;
      alive.add(t.id);
    }
  }
  const messages = page
    .filter((r) => {
      if (!r.isBot) return true;
      if (botKindOf(r.metadata) === "welcome") return false;
      const t = botTriggerOf(r.metadata);
      return !t || alive.has(t);
    })
    .map((r) => historyMessage(r as MessageRowForJob & { metadata: unknown; expiresAt: Date | null }));
  const last = page[page.length - 1];
  return { mode, messages, next: more && last ? { at: last.createdAt.toISOString(), id: last.id } : null };
}

/**
 * Журнал изменений памяти бота (таблица BotMemoryChange): в беседе удалили или поправили сообщение, которое бот
 * мог запомнить (isBotMemoryMessage). Операции — в ТУ ЖЕ транзакцию, что удаление/правка (prisma.$transaction):
 * запись не теряется ни при сбое Redis, ни при падении процесса между коммитом и записью, ни при откате Redis к
 * старому снимку (находка ревью: журнал в Redis без AOF это допускал). Заодно — чистка записей беседы старше
 * BOT_MEMLOG_RETENTION_DAYS. Время записи — время сервера (как checkedAt в botMemoryStatus).
 */
export function botMemoryChangeOps(
  message: { id: string; conversationId: string; createdAt: Date },
  kind: BotMemoryChange["kind"],
  now: Date = new Date(),
): Prisma.PrismaPromise<unknown>[] {
  return [
    prisma.botMemoryChange.create({
      data: { conversationId: message.conversationId, messageId: message.id, messageCreatedAt: new Date(message.createdAt), kind, createdAt: now },
    }),
    prisma.botMemoryChange.deleteMany({
      where: { conversationId: message.conversationId, createdAt: { lt: new Date(now.getTime() - BOT_MEMLOG_RETENTION_DAYS * 86_400_000) } },
    }),
  ];
}

/**
 * Что изменилось в памяти беседы с момента `changesSince` (время сервера из прошлого ответа). checkedAt
 * берётся ДО чтения журнала и сообщений: изменение, случившееся во время чтения, попадёт в следующий ответ
 * (лишняя пересборка лучше пропущенного удаления). Запись, чья транзакция закоммитилась позже своей отметки
 * времени, не потеряется: отдаём с запасом BOT_MEMLOG_OVERLAP_MS, повторы бот отсеивает по id. Нет
 * changesSince — бот только начинает (сводки нет), проверять нечего.
 */
export async function botMemoryStatus(conversationId: string, q: { changesSince: number | null; epoch: string | null }): Promise<BotMemoryStatus> {
  const checkedAt = Date.now();
  const epoch = BOT_MEMLOG_EPOCH;
  if (q.changesSince === null) return { epoch, checkedAt, reset: false, changedFrom: null, changes: [], truncated: false };
  if (q.epoch !== epoch || q.changesSince < checkedAt - BOT_MEMLOG_RETENTION_DAYS * 86_400_000) {
    return { epoch, checkedAt, reset: true, changedFrom: null, changes: [], truncated: false };
  }
  const where = { conversationId, createdAt: { gt: new Date(q.changesSince - BOT_MEMLOG_OVERLAP_MS) } };
  const rows = await prisma.botMemoryChange.findMany({ where, orderBy: { createdAt: "asc" }, take: BOT_MEMLOG_PAGE + 1 });
  const truncated = rows.length > BOT_MEMLOG_PAGE;
  const page = truncated ? rows.slice(0, BOT_MEMLOG_PAGE) : rows;
  let min: Date | null = null;
  if (truncated) {
    const agg = await prisma.botMemoryChange.aggregate({ where, _min: { messageCreatedAt: true } });
    min = agg._min.messageCreatedAt ?? null;
  } else {
    for (const r of page) if (!min || r.messageCreatedAt < min) min = r.messageCreatedAt;
  }
  const changes: BotMemoryChange[] = page.map((r) => ({
    id: r.id,
    messageId: r.messageId,
    at: r.messageCreatedAt.toISOString(),
    kind: r.kind === "edited" ? "edited" : "deleted",
    loggedAt: r.createdAt.getTime(),
  }));
  return { epoch, checkedAt, reset: false, changedFrom: min ? min.toISOString() : null, changes, truncated };
}

/** Беседа — «Чат с Еблушей» (бот среди участников). Бота нет — false. Обычно — один поиск по уникальному ключу. */
export async function isBotChatConversation(conversationId: string): Promise<boolean> {
  const bot = await getSystemBot();
  if (!bot) return false;
  const member = await prisma.conversationParticipant.findUnique({
    where: { conversationId_userId: { conversationId, userId: bot.id } },
    select: { id: true },
  });
  if (!member) return false;
  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { isGroup: true, type: true, isSecret: true, participants: { select: { userId: true } } },
  });
  return !!conv && isBotChatShape(conv, conv.participants.map((p) => p.userId), bot.id);
}

/**
 * Могло ли сообщение попасть в память бота: его ответ, обращение к нему (botAsk) или сообщение «Чата с
 * Еблушей». Для удаления и правки — решить, писать ли в журнал изменений.
 */
export async function isBotMemoryMessage(m: { conversationId: string; isBot: boolean; metadata: unknown }): Promise<boolean> {
  if (m.isBot || botAskOf(m.metadata)) return true;
  return isBotChatConversation(m.conversationId);
}

/**
 * Правка (POST /messages/update): осталось ли обращение обращением. «Еблуша, …» (имя или /eb в начале),
 * исправленное в текст без обращения, — уже не вопрос боту: metadata.botAsk снимаем, иначе новый текст
 * для людей ушёл бы в память бота. Обращения без имени в тексте (ответ на сообщение бота, режим «Спросить»,
 * «Чат с Еблушей») правкой не меняются — это решает вызывающий (replyTo, вид беседы).
 */
export function botAskSurvivesEdit(oldContent: string | null | undefined, newContent: string): boolean {
  const addressed = (s: string) => stripBotNamePrefix(s) !== null || stripBotCommandPrefix(s) !== null;
  if (!addressed(oldContent ?? "")) return true;
  return addressed(newContent);
}

// ───────────────────────────── Люди для привязки персонажей ─────────────────────────────

export interface BotPerson {
  id: string;
  displayName: string | null;
  /** 4-значный код EBLID (публичный, его показывает карточка пользователя). Логин (username) — никогда. */
  eblid: string | null;
  /** Участник беседы обращения. */
  inConversation: boolean;
  /** Только в matches: по чему нашёлся — имя (подстрока/основа слова), точный логин или EBLID. */
  matchedBy?: "name" | "username" | "eblid";
}

function normName(s: string): string {
  return s.toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();
}

/**
 * Люди для инструмента привязки персонажей (POST /api/bot/people; только по обращению владельца, если
 * сервер его знает — BOT_OWNER_USER_ID): участники беседы обращения; по запросу — люди (не бот, не удалён,
 * не заблокирован) по имени (displayName содержит запрос или основу его слова: «Сане» → «Сан»), по логину
 * (только точное совпадение, сам логин не отдаётся) и по EBLID; по ids — имена (у кого забрали персонажа),
 * без удалённых и заблокированных. scope "all" — среди всех людей мессенджера (владелец, известный серверу); "shared" — только
 * среди тех, с кем у спрашивающего есть общая обычная беседа (сервер владельца не знает). Лучшие совпадения
 * первыми (EBLID/логин, имя целиком, начало имени, остальное; при равенстве — новые раньше), не больше
 * BOT_PEOPLE_MATCHES_MAX; truncated — подходящих могло быть больше. Бот сам ранжирует и переспрашивает.
 */
export async function lookupBotPeople(args: {
  conversationId: string;
  botId: string;
  authorId: string;
  scope: "all" | "shared";
  query?: string | undefined;
  ids?: string[] | undefined;
}): Promise<{ participants: BotPerson[]; matches: BotPerson[]; users: BotPerson[]; truncated: boolean }> {
  const select = { id: true, displayName: true, eblid: true, isBot: true, deletedAt: true } as const;
  const parts = await prisma.conversationParticipant.findMany({ where: { conversationId: args.conversationId }, select: { user: { select } } });
  const inConv = new Set(parts.map((p) => p.user.id));
  const person = (u: { id: string; displayName: string | null; eblid: string | null }): BotPerson => ({
    id: u.id,
    displayName: u.displayName ?? null,
    eblid: u.eblid ?? null,
    inConversation: inConv.has(u.id),
  });
  const participants = parts
    .map((p) => p.user)
    .filter((u) => !u.isBot && !u.deletedAt && u.id !== args.botId)
    .map(person);

  let matches: BotPerson[] = [];
  let truncated = false;
  const q = (args.query ?? "").trim().replace(/^@+/, "").slice(0, 64);
  if (q) {
    // Падежи: «Сане Иванову» → ищем и по основам слов («Сан», «Ивано») — бот сам отсеет лишнее.
    const variants = new Set<string>();
    for (const v of [q, q.replace(/ё/g, "е").replace(/Ё/g, "Е")]) {
      variants.add(v);
      for (const w of v.split(/\s+/).slice(0, 3)) if (w.length >= 4) variants.add(w.slice(0, Math.max(3, w.length - 2)));
    }
    const or: Prisma.UserWhereInput[] = [...variants].map((v) => ({ displayName: { contains: v, mode: "insensitive" as const } }));
    or.push({ username: { equals: q, mode: "insensitive" } });
    const isEblid = /^\d{4}$/.test(q);
    if (isEblid) or.push({ eblid: q });
    const rows = await prisma.user.findMany({
      where: {
        isBot: false,
        deletedAt: null,
        bannedAt: null,
        OR: or,
        ...(args.scope === "shared"
          ? { conversations: { some: { conversation: { isSecret: false, participants: { some: { userId: args.authorId } } } } } }
          : {}),
      },
      select: { ...select, username: true },
      orderBy: { createdAt: "desc" },
      take: BOT_PEOPLE_SCAN,
    });
    truncated = rows.length >= BOT_PEOPLE_SCAN;
    const qn = normName(q);
    const ranked = rows
      .filter((u) => u.id !== args.botId)
      .map((u, i) => {
        const matchedBy: NonNullable<BotPerson["matchedBy"]> =
          isEblid && u.eblid === q ? "eblid" : u.username.toLowerCase() === q.toLowerCase() ? "username" : "name";
        const dn = normName(u.displayName ?? "");
        const rank = matchedBy !== "name" ? 0 : dn === qn ? 1 : dn.startsWith(qn) || dn.split(" ").includes(qn) ? 2 : 3;
        return { p: { ...person(u), matchedBy }, rank, i };
      })
      .sort((a, b) => a.rank - b.rank || a.i - b.i);
    if (ranked.length > BOT_PEOPLE_MATCHES_MAX) truncated = true;
    matches = ranked.slice(0, BOT_PEOPLE_MATCHES_MAX).map((x) => x.p);
  }

  let users: BotPerson[] = [];
  const ids = [...new Set(args.ids ?? [])].slice(0, 20);
  if (ids.length) {
    const rows = await prisma.user.findMany({ where: { id: { in: ids }, deletedAt: null, bannedAt: null }, select });
    users = rows.filter((u) => !u.isBot).map(person);
  }
  return { participants, matches, users, truncated };
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
      rev: BOT_JOB_REV,
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
    logger.info(
      { conversationId: conv.id, messageId: m.id, via: args.via, kind, chain: chain.length },
      "bot: dispatched",
    );
    return true;
  } catch (error) {
    logger.warn({ error, conversationId: conv.id, messageId: m.id }, "bot: dispatch failed");
    return false;
  }
}
