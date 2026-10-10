/**
 * КОНТРАКТ МОДУЛЕЙ БОТА (Valheim и будущие).
 *
 * Модуль — объект BotModule, который регистрируется в src/modules/index.ts и включается
 * переменной BOT_MODULES (через запятую). Ядро даёт модулю:
 *   - инструменты модели (BotTool): ТОЛЬКО ЧТЕНИЕ. Модель вызывает их сама; ядро проверяет
 *     доступ (access) и схему входа до вызова run(), результат помечает недоверенным, если
 *     untrusted=true (имена персонажей, метки порталов, игровой чат);
 *   - детерминированные команды (ChatCommand): разбираются КОДОМ, без модели. Команды с
 *     access="owner" работают только у владельца и только в его личке с ботом; confirm=true —
 *     ядро само спросит и дождётся «да» ответом на вопрос (один раз, до истечения срока);
 *   - справочник персонажей (CharacterDirectory) — для привязки ников фразой
 *     «Еблуша, мой ник в игре …»;
 *   - сервисы ядра (CoreServices) в start(): привязки ников, отправка сообщений, журнал.
 *
 * Действий, меняющих мир/сервер, у модели нет и быть не должно: такие вещи — только ChatCommand
 * с access="owner" и confirm=true.
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
  kind: "dm" | "group";
  title: string | null;
  participantCount: number;
  /**
   * Можно ли показывать здесь данные игроков: в личке — да; в группе ответ видят ВСЕ, поэтому
   * по умолчанию — только если все участники группы — игроки (BOT_GROUP_PLAYER_DATA=all).
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
}

export interface ToolContext {
  requester: Requester;
  chat: ChatInfo;
  /** Приложить картинку к ответу. Ядро загрузит её в хранилище Еблуши и пришлёт вложением. Не больше 4 на ответ. */
  attachImage(img: OutgoingImage): void;
  signal: AbortSignal;
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
  /** Строка для «/eb помощь». */
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
  /** Отправить сообщение от бота (в секретные беседы ядро не пишет никогда). */
  send(conversationId: string, text: string, opts?: { replyToId?: string; images?: OutgoingImage[] }): Promise<void>;
}

export interface BotModule {
  name: string;
  /** Постоянная добавка к системному промпту (не меняется между запросами — иначе ломается кэш). */
  systemPrompt?: string;
  tools?: BotTool<any>[];
  commands?: ChatCommand<any>[];
  characters?: CharacterDirectory;
  start?(core: CoreServices): Promise<void>;
  stop?(): Promise<void>;
}
