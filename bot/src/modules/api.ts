/**
 * КОНТРАКТ МОДУЛЕЙ БОТА (Valheim и будущие).
 *
 * Модуль — объект BotModule, который регистрируется в src/modules/index.ts и включается
 * переменной BOT_MODULES (через запятую). Ядро даёт модулю:
 *   - инструменты модели (BotTool): ТОЛЬКО ЧТЕНИЕ. Модель вызывает их сама; ядро проверяет
 *     доступ (access) и схему входа до вызова run(), результат помечает недоверенным, если
 *     untrusted=true (имена персонажей, метки порталов, игровой чат);
 *   - детерминированные команды (ChatCommand): разбираются КОДОМ, без модели. Команды с
 *     access="owner" работают только у владельца и только в его личном «Чате с Еблушей»; confirm=true —
 *     ядро само спросит и дождётся «да» ответом на вопрос (один раз, до истечения срока);
 *   - справочник персонажей (CharacterDirectory) — для привязки ников фразой
 *     «Еблуша, мой ник в игре …»;
 *   - сервисы ядра (CoreServices) в start(): привязки ников, уведомления в личный чат, журнал.
 *
 * Бот — часть системы, а не участник бесед: он видит только обращённое к нему сообщение и цепочку
 * ответов, а писать может только туда, где к нему обратились (разрешение из задачи очереди), и в
 * личный «Чат с Еблушей» человека, если тот его включил (CoreServices.notify).
 *
 * Действий, меняющих мир/сервер, у модели нет и быть не должно: такие вещи — либо ChatCommand
 * с access="owner" и confirm=true, либо ПЕРЕДАЧА ПРОСЬБЫ исполнителю, который сам покажет план и
 * ничего не сделает без «да» людей (Valheim: admin_request → агент сервера, modules/valheim/admin.ts).
 *
 * Модулю, которому мало «ответить один раз», ядро даёт беседу обращения (ConversationHandle):
 *   - ToolContext.conversation / afterReply — дописать в беседу после ответа модели (план агента);
 *   - BotModule.intercept — разобрать сообщение ДО модели (ответ «да» на план, «верни как было»);
 *   - ConversationHandle.followup — долгое разрешение (до 72 ч) на отчёт о долгой задаче;
 *   - CoreServices.conversation — вернуть беседу по сохранённому разрешению после перезапуска бота.
 */
import type { Logger } from "../log";

export type Access = "anyone" | "player" | "owner";

export interface Requester {
  userId: string;
  displayName: string;
  isOwner: boolean;
  /** Персонажи Valheim, привязанные к этому человеку (может быть пусто). */
  characters: string[];
  /** Игрок сервера: привязан хотя бы к одному персонажу, либо владелец. */
  isPlayer: boolean;
}

export interface ChatInfo {
  conversationId: string;
  /**
   * "bot"   — личный «Чат с Еблушей»: ответ видит только спрашивающий;
   * "dm"    — личка двух людей: ответ увидят ОБА;
   * "group" — группа: ответ увидят все участники.
   */
  kind: "bot" | "dm" | "group";
  title: string | null;
  participantCount: number;
  /**
   * Можно ли показывать здесь данные игроков: в личном чате с ботом — да; в личке двух людей и в
   * группе ответ видят ВСЕ, поэтому по умолчанию — только если все участники — игроки
   * (BOT_GROUP_PLAYER_DATA=all).
   * Ядро учитывает это само для access "player"; модулю — для «смягчённых» ответов
   * (как «кто в игре»: непривязанным — только число). Хелпер — playerDataVisible() в core/registry.
   */
  playerDataOk: boolean;
}

export interface OutgoingImage {
  data: Buffer;
  mime: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  width: number;
  height: number;
  /** Имя файла во вложении, например «karta-kuraleska.png». */
  name: string;
  /**
   * Куда ведёт нажатие на картинку (только https): у карточки карты — живая карта. Уходит во
   * вложение как metadata.link; клиенты открывают её вместо просмотрщика (docs/bot-system.md).
   */
  link?: string;
}

export type BotMessageKind = "answer" | "command" | "notice" | "confirm";

/**
 * Беседа обращения: куда бот может писать по разрешению из задачи (grant) — только сюда, не больше
 * 12 сообщений, 20 минут (src/lib/systemBot.ts). Для долгих задач — followup().
 */
export interface ConversationHandle {
  readonly conversationId: string;
  readonly kind: "bot" | "dm" | "group";
  /** Обращение, на которое отвечает бот по этому разрешению. */
  readonly triggerMessageId: string;
  /** Когда истекает разрешение (мс). */
  readonly expiresAt: number;
  /**
   * Чтобы дописать после перезапуска бота: CoreServices.conversation(ref) вернёт эту же беседу.
   * Внутри — разрешение (одна беседа, ограниченное число сообщений): хранить только у себя.
   */
  readonly ref: ConversationRef;
  /**
   * Сообщение (длинное — частями). Вернёт id всех отправленных частей; [] — сервер не принял
   * (разрешение истекло или исчерпано, обращение удалили, беседы нет) — причина уже в журнале.
   */
  post(text: string, opts?: { kind?: BotMessageKind; replyToId?: string | null }): Promise<string[]>;
  /** «Печатает…» (сбой — только в журнал). */
  typing(on: boolean): void;
  /**
   * Долгое разрешение на эту же беседу (до 72 ч, ≤ 4 сообщений) — отчёт о задаче, которая идёт
   * дольше 20 минут (агент ждёт, когда все выйдут с сервера). Брать, пока это разрешение живо;
   * null — сервер не дал (старый сервер, разрешение уже истекло или это само продолжение).
   */
  followup(): Promise<{ grant: string; expiresAt: number } | null>;
}

/** Сохранённое разрешение: из него CoreServices.conversation() снова делает беседу. */
export interface ConversationRef {
  grant: string;
  expiresAt: number;
  conversationId: string;
  kind: "bot" | "dm" | "group";
  triggerMessageId: string;
}

export interface ToolContext {
  requester: Requester;
  chat: ChatInfo;
  /** Приложить картинку к ответу. Ядро загрузит её в хранилище Еблуши и пришлёт вложением. Не больше 4 на ответ. */
  attachImage(img: OutgoingImage): void;
  signal: AbortSignal;
  log: Logger;
  now: Date;
  /** Беседа обращения (есть при ответе модели и в командах). */
  conversation?: ConversationHandle;
  /**
   * Выполнить после того, как ответ модели отправлен (фоном, задачу очереди не держит): так план
   * агента приходит ПОСЛЕ короткого «сейчас разберусь». replyIds — id отправленных частей ответа
   * модели ([] — ответ не ушёл). Ошибки — только в журнал.
   */
  afterReply?(fn: (replyIds: string[]) => Promise<void>): void;
}

/** Сообщение, адресованное боту, — для BotModule.intercept (до команд и модели). */
export interface InterceptInput {
  /** Обращение: id, автор, текст без «Еблуша,»/«/eb». */
  message: { id: string; senderId: string; replyToId: string | null };
  text: string;
  /** Сообщение, на которое это ответ (из цепочки задачи), или null. */
  parent: { id: string; senderId: string; isBot: boolean; content: string | null } | null;
  requester: Requester;
  chat: ChatInfo;
  /**
   * Последнее сообщение бота в этой беседе, если бот его помнит (память процесса; после перезапуска
   * бота — null). «Да» без ответа (reply) — про план, только если план и есть последнее сообщение.
   */
  lastBotMessageId: string | null;
  conversation: ConversationHandle;
  log: Logger;
  now: Date;
}

export interface ToolResult {
  /** Что увидит модель. Компактно: короткий JSON или строки. */
  content: string;
  /** Внешние данные (имена, метки, чат игры, тексты страниц): ядро обернёт их как недоверенные. */
  untrusted?: boolean;
  isError?: boolean;
}

/**
 * Подмножество JSON Schema для strict tool use. minimum/maximum API не принимает —
 * ядро вырезает их из схемы перед отправкой и проверяет само, до вызова run().
 */
export type JsonSchemaProp =
  | { type: "string"; description?: string; enum?: string[] }
  | { type: "integer" | "number"; description?: string; minimum?: number; maximum?: number }
  | { type: "boolean"; description?: string }
  | { type: "array"; description?: string; items: JsonSchemaProp };

export interface JsonSchemaObject {
  type: "object";
  properties: Record<string, JsonSchemaProp>;
  /** Обязательные поля; остальные — необязательные. */
  required: string[];
  additionalProperties: false;
}

export interface BotTool<I = Record<string, unknown>> {
  /** ^[a-z][a-z0-9_]{0,63}$, с префиксом модуля: valheim_status, valheim_player… */
  name: string;
  /** По-русски; ПРЕДПИСЫВАЙТЕ, когда звать («Вызывай, когда спрашивают, кто сейчас в игре…»). */
  description: string;
  inputSchema: JsonSchemaObject;
  /** anyone — все; player — только привязанные к персонажу (и владелец); owner — только владелец. */
  access: Access;
  run(input: I, ctx: ToolContext): Promise<ToolResult | string>;
}

export interface CommandReply {
  text: string;
  images?: OutgoingImage[];
}

export interface ChatCommand<A = unknown> {
  name: string;
  access: Access;
  /** Нужен ответ «да» на вопрос бота (только для access="owner"). */
  confirm?: boolean;
  /** Срок подтверждения, по умолчанию 2 минуты. */
  confirmTtlMs?: number;
  /** Не используется: подсказки о командах больше не показываются (команды — молчаливые синонимы). */
  help?: string;
  /**
   * Детерминированный разбор: text — сообщение без «Еблуша,»/«/eb», обрезанное.
   * Вернуть аргументы или null (не моя команда). Никакой модели здесь.
   */
  match(text: string): A | null;
  /** Для confirm=true: сводка и вопрос («В игре 2: … Перезапустить сейчас?») или сразу отказ. */
  prepare?(args: A, ctx: ToolContext): Promise<{ question: string } | { reply: CommandReply }>;
  run(args: A, ctx: ToolContext): Promise<CommandReply>;
}

export interface CharacterDirectory {
  /** Персонажи, которых видел сервер (имена ровно как в игре). */
  listKnownCharacters(): Promise<string[]>;
}

export interface CoreServices {
  log: Logger;
  ownerUserId: string | null;
  dataDir: string;
  links: {
    charactersOf(userId: string): string[];
    userOf(character: string): string | null;
    all(): Array<{ userId: string; character: string; verified: boolean }>;
  };
  /**
   * Уведомление человеку в его личный «Чат с Еблушей» (лента, подписки, сторож сервера). false —
   * чат у него выключен (или сервер отказал): писать больше некуда, бот в беседы сам не заходит.
   */
  notify(userId: string, text: string, opts?: { images?: OutgoingImage[] }): Promise<boolean>;
  /** Беседа по сохранённому разрешению (после перезапуска бота — дописать отчёт о долгой задаче). */
  conversation(ref: ConversationRef): ConversationHandle;
}

export interface BotModule {
  name: string;
  /** Постоянная добавка к системному промпту (не меняется между запросами — иначе ломается кэш). */
  systemPrompt?: string;
  tools?: BotTool<any>[];
  commands?: ChatCommand<any>[];
  characters?: CharacterDirectory;
  /**
   * Разобрать адресованное боту сообщение раньше команд и модели (ответ «да» на план агента,
   * «верни как было»). true — обработано, дальше не идём. Ядро зовёт модули по порядку.
   */
  intercept?(input: InterceptInput): Promise<boolean>;
  start?(core: CoreServices): Promise<void>;
  stop?(): Promise<void>;
}
