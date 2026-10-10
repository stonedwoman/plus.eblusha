/**
 * Контракт «сервер ↔ сервис бота Еблуша»: задача очереди BullMQ `bot` и ответ POST /api/bot/history.
 * Сервис бота держит копию этих типов (bot/src/api/types.ts).
 *
 * Версии. `v` — несовместимая смена формы задачи: бот отвергает задачу с чужим `v` (старый бот принимает
 * только v: 1), поэтому `v` НЕ поднимаем, пока можно обойтись добавочным. Добавочное — ревизия `rev` (нет
 * поля — ревизия 1): старый бот её не читает, новый бот без неё работает как раньше. Так старый бот с новым
 * сервером и новый бот со старым сервером не ломаются.
 *   rev 1 — триггер + цепочка ответов (chain).
 *   rev 2 — история прямо в задаче; была только в невыпущенной ветке sysbot/context-ownerlink, заменена rev 3.
 *   rev 3 — память бота о своих разговорах (решение владельца 2026-10-11): истории в задаче НЕТ, бот берёт
 *           её сам по разрешению задачи — POST /api/bot/history (BotHistoryPage): все обращения к нему и его
 *           ответы в этой беседе (в «Чате с Еблушей» — весь чат) после своего курсора, плюс журнал изменений
 *           (BotMemoryStatus): удалили или поправили сообщение, уже вошедшее в сводку, — бот пересобирает
 *           сводку с нуля. rev ≥ 3 — признак, что маршрут есть.
 *
 * Сервер кладёт задачу ТОЛЬКО на сообщение, адресованное боту (src/lib/systemBot.ts → detectBotAddress), в
 * обычной (не секретной) беседе. Остальную переписку людей бот не видит: он не участник, в задаче — триггер и
 * цепочка его ответов (replyTo вверх), а /api/bot/history в обычной беседе отдаёт только разговоры с ботом
 * (обращения + его ответы).
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
  /** Ревизия добавочного (см. шапку). Нет поля — 1. */
  rev?: number;
  kind: "message";
  /** Когда поставлено (мс, часы сервера). Бот выбрасывает слишком старые задачи. */
  enqueuedAt: number;
  /**
   * Разрешение ответить в ЭТУ беседу: POST /api/bot/messages|typing|react|history с {grant}. Без него бот
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

/** Текущая ревизия задачи, которую кладёт этот сервер (3 — есть POST /api/bot/history). */
export const BOT_JOB_REV = 3;

/** Сколько сообщений (с триггером) уходит боту цепочкой. */
export const BOT_JOB_CHAIN_MAX = 12;

// ───────────────────────────── Память бота: POST /api/bot/history ─────────────────────────────

/** Сообщение истории: как в задаче, плюс то, что нужно памяти бота. */
export interface BotHistoryMessage extends BotJobMessage {
  /** Ответ бота: на какое обращение (metadata.bot.triggerMessageId). У людей и у уведомлений — нет поля. */
  triggerId?: string;
  /** Когда сообщение исчезнет (ISO): бот не держит его в сводке дольше. В обычных беседах не бывает. */
  expiresAt?: string;
}

/**
 * Журнал изменений памяти беседы (Redis, src/lib/systemBot.ts → noteBotMemoryChange): удалили или поправили
 * сообщение, которое бот мог запомнить (обращение, ответ бота, сообщение «Чата с Еблушей»).
 */
export interface BotMemoryStatus {
  /** Опознаватель журнала: сменился (Redis потерял журнал) — бот пересобирает сводку с нуля. */
  epoch: string;
  /** Время сервера (мс) этого снимка, взятое ДО чтения сообщений: бот присылает его как changesSince. */
  checkedAt: number;
  /** Журнал не может ответить (сменился epoch, нужная часть журнала вытеснена) — пересобрать с нуля. */
  reset: boolean;
  /** Самое раннее createdAt (ISO) среди изменённых с changesSince сообщений; null — изменений не было. */
  changedFrom: string | null;
}

/** Ответ POST /api/bot/history. */
export interface BotHistoryPage {
  /** "botchat" — «Чат с Еблушей» (весь чат); "recent" — обычная беседа (только разговоры с ботом). */
  mode: "botchat" | "recent";
  /** Сообщения после курсора `after`, от старшего к младшему (createdAt, id). */
  messages: BotHistoryMessage[];
  /** Курсор следующей страницы (последняя просмотренная строка); null — дальше ничего нет. */
  next: { at: string; id: string } | null;
  memory: BotMemoryStatus;
}

/** Страница истории: по умолчанию и максимум (limit: 0 — только memory, без сообщений). */
export const BOT_HISTORY_PAGE_DEFAULT = 200;
export const BOT_HISTORY_PAGE_MAX = 500;
/** Страниц истории на одно обращение (пересборка длинной памяти — много страниц). */
export const BOT_HISTORY_PAGES_PER_GRANT = 200;
/** Записей журнала изменений на беседу (старые вытесняются; бот, отставший сильнее, пересобирает с нуля). */
export const BOT_MEMLOG_MAX = 500;
