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
// Бот не участник бесед и не читает их: сервер кладёт в очередь BullMQ `bot` только сообщение,
// адресованное боту, и цепочку его ответов. Меняя форму — поднимайте `v` на ОБЕИХ сторонах.

export type BotAddressVia = "name" | "command" | "reply" | "botchat" | "explicit";
/** "bot" — личный «Чат с Еблушей» (ответ видит один человек), "dm" — личка двух людей, "group" — группа. */
export type BotConversationKind = "bot" | "dm" | "group";

export interface BotJobAttachment {
  url: string;
  type: EbAttachmentType;
  size: number | null;
  metadata: Record<string, unknown> | null;
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
}

export interface BotJob {
  v: 1;
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
}

const ATT_TYPES = new Set(["IMAGE", "VIDEO", "AUDIO", "FILE"]);
const MSG_TYPES = new Set(["TEXT", "IMAGE", "VIDEO", "AUDIO", "FILE"]);
const VIAS = new Set(["name", "command", "reply", "botchat", "explicit"]);
const KINDS = new Set(["bot", "dm", "group"]);
const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;

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
  };
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
  return {
    v: 1,
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
  attachments?: Array<{
    url: string;
    type: "IMAGE" | "FILE";
    size?: number;
    metadata?: Record<string, unknown>;
  }>;
}

export interface UploadResult {
  url: string;
  path?: string;
  publicUrl?: string;
}
