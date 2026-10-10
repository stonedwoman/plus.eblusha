/**
 * Контракт «сервер ↔ сервис бота Еблуша» (очередь BullMQ `bot`). Сервис бота держит копию этих
 * типов (bot/src/api/types.ts, BotJob) — меняя здесь, поднимайте `v` и правьте обе стороны.
 *
 * Сервер кладёт задачу ТОЛЬКО на сообщение, адресованное боту (src/lib/systemBot.ts →
 * detectBotAddress), в обычной (не секретной) беседе. Остальные сообщения бесед бот не видит:
 * он не участник, а в задачу идут лишь триггер и цепочка его ответов (replyTo вверх).
 */

/** Как сообщение оказалось адресовано боту. */
export type BotAddressVia =
  /** «Еблуша,» / «Еблуша:» / «Еблуша!» в начале (регистр, е/ё и похожая латиница не важны). */
  | "name"
  /** /eb или /еб в начале. */
  | "command"
  /** Ответ (replyToId) на сообщение бота. */
  | "reply"
  /** Личный чат пользователя с ботом — там всё адресовано боту. */
  | "botchat"
  /** Клиент явно включил режим «Спросить» (metadata.botAsk === true). */
  | "explicit";

/**
 * Вид беседы глазами бота:
 *  - "bot"   — личный чат пользователя с ботом (настройка «Чат с Еблушей»): ответ видит только он;
 *  - "dm"    — личка двух людей: ответ увидят ОБА;
 *  - "group" — группа: ответ увидят все участники.
 */
export type BotConversationKind = "bot" | "dm" | "group";

export interface BotJobAttachment {
  /** /api/files/<ключ> — отдаётся без авторизации, `?thumb=1` — серверное превью картинки. */
  url: string;
  type: "IMAGE" | "VIDEO" | "AUDIO" | "FILE";
  size: number | null;
  metadata: Record<string, unknown> | null;
}

export interface BotJobMessage {
  id: string;
  senderId: string;
  /** displayName отправителя (может быть null). */
  senderName: string | null;
  /** Сообщение самого бота (Message.isBot). */
  isBot: boolean;
  type: "TEXT" | "IMAGE" | "VIDEO" | "AUDIO" | "FILE";
  content: string | null;
  /** ISO. */
  createdAt: string;
  replyToId: string | null;
  attachments: BotJobAttachment[];
}

export interface BotJobV1 {
  v: 1;
  kind: "message";
  /** Когда поставлено (мс, часы сервера). Бот выбрасывает слишком старые задачи. */
  enqueuedAt: number;
  /**
   * Разрешение ответить в ЭТУ беседу: POST /api/bot/messages|typing|react с {grant}. Без него бот
   * писать в беседу не может (кроме уведомлений в личный чат с ботом — POST /api/bot/messages {userId}).
   */
  grant: string;
  /** До какого момента (мс) разрешение действует. */
  grantExpiresAt: number;
  via: BotAddressVia;
  conversation: {
    id: string;
    kind: BotConversationKind;
    /** Название группы (у лички и чата с ботом — null). */
    title: string | null;
    /** Люди-участники беседы (id, без бота) — для правила «данные игроков только игрокам». */
    participantIds: string[];
  };
  author: { id: string; displayName: string | null };
  /** Сообщение-триггер (как сохранено; текст — с «Еблуша,» / «/eb», бот срезает сам). */
  message: BotJobMessage;
  /**
   * Цепочка ответов: предки триггера по replyTo от СТАРШЕГО к родителю триггера (триггера в ней нет),
   * не длиннее BOT_JOB_CHAIN_MAX - 1. Только эта беседа, без удалённых и истёкших.
   */
  chain: BotJobMessage[];
}

export type BotJob = BotJobV1;

/** Сколько сообщений (с триггером) уходит боту цепочкой. */
export const BOT_JOB_CHAIN_MAX = 12;
