/** Формы данных backend Еблуши (src/routes) и задачи очереди бота (src/lib/botContract.ts). */

export type EbAttachmentType = "IMAGE" | "VIDEO" | "AUDIO" | "FILE";
export type EbMessageType = "TEXT" | "IMAGE" | "VIDEO" | "AUDIO" | "FILE" | "SYSTEM" | "CALL";

export interface EbUserRef {
  id: string;
  username?: string;
  displayName?: string | null;
  avatarUrl?: string | null;
  isBot?: boolean;
}

export interface EbAttachment {
  id?: string;
  url: string;
  type: EbAttachmentType;
  size?: number | null;
  metadata?: Record<string, unknown> | null;
}

export interface EbReplyRef {
  id: string;
  content: string | null;
  senderId: string;
  createdAt?: string;
}

export interface EbMessage {
  id: string;
  conversationId: string;
  senderId: string;
  type: EbMessageType;
  content: string | null;
  createdAt: string;
  replyToId?: string | null;
  replyTo?: EbReplyRef | null;
  sender?: EbUserRef | null;
  attachments?: EbAttachment[];
  metadata?: Record<string, unknown> | null;
  deletedAt?: string | null;
  reactions?: Array<{ userId: string; emoji: string }>;
  /** Сообщение системного бота (Message.isBot). */
  isBot?: boolean;
}

// ─────────────── Очередь бота (контракт сервера: src/lib/botContract.ts в корне репозитория) ───────────────
// Бот не участник бесед и не читает их: сервер кладёт в очередь BullMQ `bot` только сообщение, адресованное
// боту, и цепочку его ответов. `v` — несовместимая смена (чужой `v` бот отвергает), `rev` — добавочное: без
// него бот работает как раньше, лишнее — пропускает. rev ≥ 3 — у сервера есть POST /api/bot/history (память
// бота о своих разговорах, BotHistoryPage). Так старый бот с новым сервером и новый бот со старым сервером
// не ломаются.

export type BotAddressVia = "name" | "command" | "reply" | "botchat" | "explicit";
/** "bot" — личный «Чат с Еблушей» (ответ видит один человек), "dm" — личка двух людей, "group" — группа. */
export type BotConversationKind = "bot" | "dm" | "group";

export interface BotJobAttachment {
  url: string;
  type: EbAttachmentType;
  size: number | null;
  metadata: Record<string, unknown> | null;
}

/** Пометки сообщения БОТА (rev 4): вид, обращение, карточка, согласие «поделиться перепиской», глубина. */
export interface BotJobBotMeta {
  kind: string;
  triggerId?: string;
  card?: { type: string; id: string; state: string };
  shareId?: string;
  promiseId?: string;
  depth?: "deep";
}

export interface BotJobMessage {
  id: string;
  senderId: string;
  senderName: string | null;
  isBot: boolean;
  type: "TEXT" | "IMAGE" | "VIDEO" | "AUDIO" | "FILE";
  content: string | null;
  createdAt: string;
  replyToId: string | null;
  attachments: BotJobAttachment[];
  /** Только у сообщений бота, сервер rev ≥ 4. */
  bot?: BotJobBotMeta;
}

/** Идущий таймер обещания беседы (rev 4). */
export interface BotJobPromise {
  id: string;
  promiserId: string;
  promiserName: string | null;
  requesterId: string;
  cardMessageId: string | null;
  startAt: string;
  deadlineAt: string;
}

/** Продолжение после «Поделиться» (rev 4). */
export interface BotJobShare {
  id: string;
  period: "today" | "week" | "all";
  photos: boolean;
  from: string | null;
  until: string;
}

export interface BotJob {
  v: 1;
  /** Ревизия добавочных полей; нет — 1 (старый сервер: только цепочка). */
  rev?: number;
  kind: "message";
  enqueuedAt: number;
  /** Разрешение ответить в ЭТУ беседу (POST /api/bot/messages|typing|react). */
  grant: string;
  grantExpiresAt: number;
  via: BotAddressVia;
  conversation: { id: string; kind: BotConversationKind; title: string | null; participantIds: string[] };
  author: { id: string; displayName: string | null };
  message: BotJobMessage;
  /** Предки триггера по replyTo: от старшего к родителю триггера (без триггера). */
  chain: BotJobMessage[];
  /** rev 4: идущие таймеры беседы. */
  promises?: BotJobPromise[];
  /** rev 4: продолжение после «Поделиться» — переписку этой беседы читать можно. */
  share?: BotJobShare;
}

/** Сигнал без разрешения (rev 4): согласие закончилось — стереть переписку из памяти процесса. */
export interface BotSignal {
  type: "share.ended";
  shareId: string;
  conversationId: string;
  reason: string;
}

/** Ревизия задачи, с которой у сервера есть POST /api/bot/history (память бота). */
export const BOT_JOB_REV_MEMORY = 3;
/** Ревизия задачи, с которой у сервера есть карточки: /api/bot/promises*, /api/bot/share*. */
export const BOT_JOB_REV_CARDS = 4;

const ATT_TYPES = new Set(["IMAGE", "VIDEO", "AUDIO", "FILE"]);
const MSG_TYPES = new Set(["TEXT", "IMAGE", "VIDEO", "AUDIO", "FILE"]);
const VIAS = new Set(["name", "command", "reply", "botchat", "explicit"]);
const KINDS = new Set(["bot", "dm", "group"]);
const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;

function parseBotMeta(v: unknown): BotJobBotMeta | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const b = v as Record<string, unknown>;
  if (!str(b.kind)) return undefined;
  const out: BotJobBotMeta = { kind: b.kind };
  if (str(b.triggerId)) out.triggerId = b.triggerId;
  if (str(b.shareId)) out.shareId = b.shareId;
  if (str(b.promiseId)) out.promiseId = b.promiseId;
  if (b.depth === "deep") out.depth = "deep";
  const c = b.card as Record<string, unknown> | undefined;
  if (c && typeof c === "object" && str(c.type) && str(c.id)) out.card = { type: c.type, id: c.id, state: typeof c.state === "string" ? c.state : "" };
  return out;
}

function parseJobMessage(v: unknown): BotJobMessage | null {
  if (!v || typeof v !== "object") return null;
  const m = v as Record<string, unknown>;
  if (!str(m.id) || !str(m.senderId) || !str(m.createdAt) || typeof m.type !== "string" || !MSG_TYPES.has(m.type)) return null;
  const atts: BotJobAttachment[] = [];
  for (const a of Array.isArray(m.attachments) ? m.attachments : []) {
    const x = a as Record<string, unknown>;
    if (!x || !str(x.url) || typeof x.type !== "string" || !ATT_TYPES.has(x.type)) continue;
    atts.push({
      url: x.url,
      type: x.type as EbAttachmentType,
      size: typeof x.size === "number" ? x.size : null,
      metadata: x.metadata && typeof x.metadata === "object" && !Array.isArray(x.metadata) ? (x.metadata as Record<string, unknown>) : null,
    });
  }
  return {
    id: m.id,
    senderId: m.senderId,
    senderName: typeof m.senderName === "string" ? m.senderName : null,
    isBot: m.isBot === true,
    type: m.type as BotJobMessage["type"],
    content: typeof m.content === "string" ? m.content : null,
    createdAt: m.createdAt,
    replyToId: str(m.replyToId) ? m.replyToId : null,
    attachments: atts,
    ...(m.isBot === true && parseBotMeta(m.bot) ? { bot: parseBotMeta(m.bot)! } : {}),
  };
}

function parsePromises(v: unknown): BotJobPromise[] {
  const out: BotJobPromise[] = [];
  for (const x of Array.isArray(v) ? v.slice(0, 10) : []) {
    const p = x as Record<string, unknown>;
    if (!p || !str(p.id) || !str(p.promiserId) || !str(p.requesterId) || !str(p.deadlineAt)) continue;
    out.push({
      id: p.id,
      promiserId: p.promiserId,
      promiserName: typeof p.promiserName === "string" ? p.promiserName : null,
      requesterId: p.requesterId,
      cardMessageId: str(p.cardMessageId) ? p.cardMessageId : null,
      startAt: str(p.startAt) ? p.startAt : p.deadlineAt,
      deadlineAt: p.deadlineAt,
    });
  }
  return out;
}

function parseShare(v: unknown): BotJobShare | undefined {
  if (!v || typeof v !== "object") return undefined;
  const s = v as Record<string, unknown>;
  if (!str(s.id) || !str(s.until) || (s.period !== "today" && s.period !== "week" && s.period !== "all")) return undefined;
  return { id: s.id, period: s.period, photos: s.photos === true, from: str(s.from) ? s.from : null, until: s.until };
}

/** Сигнал (kind "signal") из очереди или null. */
export function parseBotSignal(v: unknown): BotSignal | null {
  if (!v || typeof v !== "object") return null;
  const j = v as Record<string, unknown>;
  if (j.v !== 1 || j.kind !== "signal") return null;
  const s = j.signal as Record<string, unknown> | undefined;
  if (!s || s.type !== "share.ended" || !str(s.shareId) || !str(s.conversationId)) return null;
  return { type: "share.ended", shareId: s.shareId, conversationId: s.conversationId, reason: typeof s.reason === "string" ? s.reason : "" };
}

/** Проверить задачу из очереди (данные чужого процесса — доверяем только форме). null — мусор. */
export function parseBotJob(v: unknown): BotJob | null {
  if (!v || typeof v !== "object") return null;
  const j = v as Record<string, unknown>;
  if (j.v !== 1 || j.kind !== "message" || !str(j.grant) || typeof j.enqueuedAt !== "number" || typeof j.grantExpiresAt !== "number") return null;
  if (typeof j.via !== "string" || !VIAS.has(j.via)) return null;
  const c = j.conversation as Record<string, unknown> | undefined;
  if (!c || !str(c.id) || typeof c.kind !== "string" || !KINDS.has(c.kind)) return null;
  const a = j.author as Record<string, unknown> | undefined;
  if (!a || !str(a.id)) return null;
  const message = parseJobMessage(j.message);
  if (!message) return null;
  const chain: BotJobMessage[] = [];
  for (const x of Array.isArray(j.chain) ? j.chain : []) {
    const p = parseJobMessage(x);
    if (p) chain.push(p);
  }
  const rev = typeof j.rev === "number" && Number.isInteger(j.rev) && j.rev > 0 ? j.rev : 1;
  return {
    v: 1,
    rev,
    kind: "message",
    enqueuedAt: j.enqueuedAt,
    grant: j.grant,
    grantExpiresAt: j.grantExpiresAt,
    via: j.via as BotAddressVia,
    conversation: {
      id: c.id,
      kind: c.kind as BotConversationKind,
      title: typeof c.title === "string" ? c.title : null,
      participantIds: Array.isArray(c.participantIds) ? c.participantIds.filter(str) : [],
    },
    author: { id: a.id, displayName: typeof a.displayName === "string" ? a.displayName : null },
    message,
    chain,
    ...(rev >= BOT_JOB_REV_CARDS && Array.isArray(j.promises) ? { promises: parsePromises(j.promises) } : {}),
    ...(rev >= BOT_JOB_REV_CARDS && parseShare(j.share) ? { share: parseShare(j.share)! } : {}),
  };
}

/** Ответ бота (POST /api/bot/messages): ровно одно из grant / userId. */
export interface BotPostInput {
  /** Разрешение из задачи — ответ в беседу обращения. */
  grant?: string;
  /** Или уведомление в личный «Чат с Еблушей» этого человека (если он его включил). */
  userId?: string;
  type: "TEXT" | "IMAGE" | "FILE";
  content?: string;
  replyToId?: string;
  kind?: "answer" | "command" | "notice" | "confirm";
  /** «Подумал лучше»: metadata.bot.depth = "deep" (сервер rev ≥ 4). */
  depth?: "deep";
  /** Модель, давшая ответ (для «Подумал лучше»). */
  model?: string;
  attachments?: Array<{
    url: string;
    type: "IMAGE" | "FILE";
    size?: number;
    metadata?: Record<string, unknown>;
  }>;
}

/** Человек из POST /api/bot/people: имя и публичный EBLID (логин сервер не отдаёт). */
export interface BotPerson {
  id: string;
  displayName: string | null;
  eblid: string | null;
  /** Участник беседы обращения. */
  inConversation: boolean;
  /** Только в matches: по чему сервер нашёл человека (нет — старый сервер). */
  matchedBy?: "name" | "username" | "eblid";
}

export interface BotPeople {
  /** Участники беседы обращения (без бота). */
  participants: BotPerson[];
  /** Найденные по запросу (лучшие первыми). */
  matches: BotPerson[];
  /** Запрошенные по id. */
  users: BotPerson[];
  /** Подходящих могло быть больше, чем отдано. */
  truncated?: boolean;
}

// ─────────────── Память бота: POST /api/bot/history (контракт rev 3) ───────────────

/** Сообщение истории: как в задаче, плюс ответ бота — на какое обращение, и когда исчезнет. */
export interface BotHistoryMessage extends BotJobMessage {
  triggerId?: string;
  expiresAt?: string;
}

/** Запись журнала изменений: какое сообщение (createdAt — at) удалили или поправили. */
export interface BotMemoryChange {
  id: string;
  messageId: string;
  at: string;
  kind: "deleted" | "edited";
  /** Когда записано (мс, время сервера). */
  loggedAt: number;
}

/** Журнал изменений памяти беседы (удалили/поправили то, что бот мог запомнить). */
export interface BotMemoryStatus {
  epoch: string;
  /** Время сервера снимка (мс): следующий раз — changesSince (сервер отдаёт с запасом — повторы отсеять по id). */
  checkedAt: number;
  /** Журнал ответить не может — пересобрать память с нуля. */
  reset: boolean;
  /** Самое раннее createdAt изменённого с changesSince (ISO) или null. */
  changedFrom: string | null;
  /** Сами изменения; null — сервер их не прислал (тогда — только changedFrom). */
  changes: BotMemoryChange[] | null;
  /** Изменений больше, чем в changes. */
  truncated: boolean;
}

export interface BotHistoryPage {
  mode: "botchat" | "recent";
  messages: BotHistoryMessage[];
  next: { at: string; id: string } | null;
  memory: BotMemoryStatus;
}

/** Ответ сервера → BotHistoryPage (данные чужого процесса — доверяем только форме). null — мусор. */
export function parseHistoryPage(v: unknown): BotHistoryPage | null {
  if (!v || typeof v !== "object") return null;
  const j = v as Record<string, unknown>;
  if (j.mode !== "botchat" && j.mode !== "recent") return null;
  const mem = j.memory as Record<string, unknown> | undefined;
  if (!mem || typeof mem.epoch !== "string" || typeof mem.checkedAt !== "number") return null;
  const messages: BotHistoryMessage[] = [];
  for (const x of Array.isArray(j.messages) ? j.messages : []) {
    const p = parseJobMessage(x);
    if (!p) continue;
    const r = x as Record<string, unknown>;
    messages.push({ ...p, ...(str(r.triggerId) ? { triggerId: r.triggerId } : {}), ...(str(r.expiresAt) ? { expiresAt: r.expiresAt } : {}) });
  }
  const n = j.next as Record<string, unknown> | null | undefined;
  return {
    mode: j.mode,
    messages,
    next: n && str(n.at) && typeof n.id === "string" ? { at: n.at, id: n.id } : null,
    memory: {
      epoch: mem.epoch,
      checkedAt: mem.checkedAt,
      reset: mem.reset === true,
      changedFrom: str(mem.changedFrom) ? mem.changedFrom : null,
      changes: Array.isArray(mem.changes) ? mem.changes.map(parseMemoryChange).filter((c): c is BotMemoryChange => c !== null) : null,
      truncated: mem.truncated === true,
    },
  };
}

function parseMemoryChange(v: unknown): BotMemoryChange | null {
  if (!v || typeof v !== "object") return null;
  const c = v as Record<string, unknown>;
  if (!str(c.id) || !str(c.messageId) || !str(c.at) || !Number.isFinite(Date.parse(c.at))) return null;
  return {
    id: c.id,
    messageId: c.messageId,
    at: c.at,
    kind: c.kind === "edited" ? "edited" : "deleted",
    loggedAt: typeof c.loggedAt === "number" && Number.isFinite(c.loggedAt) ? c.loggedAt : 0,
  };
}

export interface UploadResult {
  url: string;
  path?: string;
  publicUrl?: string;
}

// ─────────────── Карточки бота (контракт rev 4, docs/bot-cards.md) ───────────────

export type PromiseSpecInput =
  | { kind: "in"; minSec: number; maxSec: number }
  | { kind: "at"; hour: number; minute: number; half: "am" | "pm" | "unknown"; day: "today" | "tomorrow" | "nearest"; zone?: string }
  | { kind: "none"; reason: "no_time" | "past" | "question" };

/** Таймер (как его отдаёт сервер /api/bot/promises*). */
export interface PromiseSummary {
  id: string;
  conversationId: string;
  promiserId: string;
  promiserName: string | null;
  requesterId: string;
  cardMessageId: string | null;
  status: string;
  label: string;
  upperBound: boolean;
  startAt: string;
  deadlineAt: string;
  originalDeadlineAt: string;
  extensionCount: number;
  zone: string;
}

export interface PromiseCandidate {
  messageId: string;
  senderId: string;
  senderName: string | null;
  text: string;
  createdAt: string;
  parsed: { deadlineAt: string; label: string; upperBound: boolean } | { ambiguous: true; deadlineAt: string; label: string | null };
}

export interface PunctualityStats {
  userId: string;
  displayName: string | null;
  total: number;
  onTime: number;
  late: number;
  unresolved: number;
  cancelled: number;
  onTimeRate: number | null;
  avgDeltaSec: number | null;
  avgLateSec: number | null;
  medianDeltaSec: number | null;
  worst: { deltaSec: number; at: string } | null;
  best: { deltaSec: number; at: string } | null;
  extensions: number;
  timersExtended: number;
  streakOnTime: number;
}

export type SharePeriod = "today" | "week" | "all";

export interface SharePeriodEstimate {
  period: SharePeriod;
  from: string | null;
  messages: number;
  botMessages: number;
  chars: number;
  photos: number;
  capped?: boolean;
}

export interface ShareEstimate {
  conversationKind: "dm" | "group";
  zone: string;
  periods: SharePeriodEstimate[];
  active: { shareId: string; period: string | null; photos: boolean; until: string | null } | null;
  declinedAt: string | null;
}

export interface ShareInfo {
  id: string;
  status: string;
  period: SharePeriod | null;
  photos: boolean;
  from: string | null;
  until: string | null;
  cardMessageId: string | null;
  triggerMessageId: string;
  answers: number;
}

export interface ShareMessage {
  id: string;
  at: string;
  senderId: string;
  senderName: string | null;
  isBot: boolean;
  kind: "text" | "photo" | "video" | "voice" | "file" | "call";
  text: string | null;
  replyTo: { id: string; senderName: string | null; text: string | null } | null;
  edited: boolean;
  forwarded: boolean;
  reactions: Array<{ emoji: string; names: string[] }>;
  photos?: Array<{ url: string; w: number | null; h: number | null }>;
  meta: { durationSec?: number; fileName?: string; size?: number } | null;
}

export interface SharePage {
  share: ShareInfo;
  messages: ShareMessage[];
  next: { at: string; id: string } | null;
  changes: { deleted: string[]; edited: string[] };
  checkedAt: number;
}
