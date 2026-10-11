/** Граница между ядром и моделью: ядро не знает про SDK, тесты подставляют свою реализацию. */
import type { Effort } from "../config";
import type { CostBreakdown } from "../core/budget";

export interface LlmImage {
  mime: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  data: Buffer;
}

export interface LlmTurn {
  role: "user" | "assistant";
  text: string;
  images?: LlmImage[];
}

/** Определение пользовательского инструмента в форме API (custom tool). */
export interface LlmToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface LlmToolResult {
  content: string;
  /** Картинки к результату (view_photo — фото из переписки «глазами» модели). */
  images?: LlmImage[];
  isError: boolean;
  /**
   * Инструмент сам дал ответ человеку (карточка таймера, карточка «поделиться перепиской»): цикл НЕ зовёт модель
   * ещё раз, текст модели не публикуется (AnswerResult.suppressed).
   */
  endTurn?: boolean;
}

export interface ToolRuntime {
  defs: LlmToolDef[];
  /** Выполнить инструмент; ошибки — не исключения, а isError. */
  run(name: string, input: unknown): Promise<LlmToolResult>;
}

export interface AnswerRequest {
  turns: LlmTurn[];
  /**
   * Индекс реплики в turns, на конце которой ставится точка кэша промпта (конец истории беседы): следующий
   * вопрос в том же разговоре читает системный текст и историю из кэша. null/нет — без этой точки.
   */
  cacheAt?: number | null;
  /** Срок этой точки кэша: "5m" (по умолчанию) или "1h" (BOT_MEMORY_CACHE_TTL). */
  cacheTtl?: "5m" | "1h";
  /** Сведения о запросе для модели (время, чат, кто спрашивает): уходят системным сообщением. */
  contextNote: string;
  effort: Effort;
  /** Непрозрачный идентификатор человека для metadata.user_id (хэш, не id). */
  userKey: string;
  tools: ToolRuntime;
  signal: AbortSignal;
  /** Потолок цены этого ответа, $. */
  maxUsd: number;
  /** Другая модель на этот ответ («Подумай лучше»: claude-fable-5-1 или запасная). */
  model?: string;
  /** Усилие верхним уровнем без сообщения усилия (глубокий ответ: high / max). */
  topEffort?: Effort;
  /** max_tokens одного шага (глубокий ответ — от потолка цены). */
  maxTokens?: number;
  /** Шагов цикла инструментов (глубокий ответ — BOT_DEEP_MAX_STEPS). */
  maxIterations?: number;
  /** false — без web_search/web_fetch (ответ по переписке: адрес из неё + выдержка = утечка наружу). */
  web?: boolean;
  /** Жёсткий потолок: не начинать шаг, если прогноз (потрачено + прошлый шаг) выше maxUsd. */
  hardCap?: boolean;
  /** Срок кэша системного текста (по умолчанию 1h; глубокий ответ — 5m: запись 1h у Fable вдвое дороже). */
  systemTtl?: "5m" | "1h";
  /**
   * Готовый текст ПЕРЕД цепочкой (переписка беседы по согласию): отдельной репликой человека с точкой кэша на её
   * конце (уточнения в те же 5 минут читают её из кэша).
   */
  preamble?: string;
}

export type AnswerStop = "end_turn" | "refusal" | "max_tokens" | "budget" | "iterations";

export interface AnswerResult {
  text: string;
  sources: Array<{ url: string; title: string | null }>;
  cost: CostBreakdown;
  stop: AnswerStop;
  refusalCategory?: string | null;
  /** Модель, давшая итоговый ответ (может отличаться при server-side fallback). */
  servedBy: string;
  /** Инструмент сам ответил человеку (endTurn): текст модели не публикуется. */
  suppressed?: boolean;
}

/** Вспомогательный вызов недорогой модели (заметки кусков переписки, описания фото, разбор времени). */
export interface AuxRequest {
  model: string;
  system: string;
  content: Array<{ type: "text"; text: string } | { type: "image"; mime: LlmImage["mime"]; data: Buffer }>;
  /** Строгая JSON-схема ответа (structured outputs) или нет — обычный текст. */
  schema?: Record<string, unknown>;
  maxTokens: number;
  signal: AbortSignal;
}

export interface AuxResult {
  text: string;
  cost: CostBreakdown;
  model: string;
  stop: "end_turn" | "max_tokens" | "refusal";
}

/** Итог пробы глубокой модели при старте (llm.deep_probe). */
export interface DeepProbeResult {
  /** Модель «Подумай лучше» (null — выключено: обе модели недоступны). */
  model: string | null;
  /** Набор серверных инструментов для неё. */
  tools: "web_20260209" | "web_fetch_20260318" | "web_basic" | "none";
  /** Почему не основная (без подробностей API). */
  note: string | null;
  cost: CostBreakdown;
}

/** Сжатие памяти беседы (core/memory.ts): прежняя сводка + следующие по времени реплики → новая сводка. */
export interface SummarizeRequest {
  /** Прежняя сводка (пусто — первая). */
  previous: string;
  /** Новые реплики, уже в формате памяти («⟦Имя · дата⟧» и текст; ответы бота — «⟦Еблуша⟧»). */
  transcript: string;
  /** Ориентир длины сводки, символов. */
  maxChars: number;
  /** Вид беседы: в обычной — обращения разных людей к боту, в «Чате с Еблушей» — разговор одного человека. */
  kind: "bot" | "dm" | "group";
  signal: AbortSignal;
}

export interface SummarizeResult {
  text: string;
  cost: CostBreakdown;
  /** Модель, которая сжимала (для учёта расходов). */
  model: string;
  /** end_turn — сводка готова; refusal / max_tokens — не годится (прежняя остаётся), но деньги учтены. */
  stop: "end_turn" | "max_tokens" | "refusal";
}

export interface LlmEngine {
  readonly model: string;
  answer(req: AnswerRequest): Promise<AnswerResult>;
  /** Какого персонажа из списка человек имел в виду (null — никакого). */
  matchCharacter(input: string, known: string[], signal: AbortSignal): Promise<{ character: string | null; cost: CostBreakdown }>;
  /**
   * Сжать память беседы недорогой моделью (BOT_MEMORY_MODEL). Нет метода или модели — память без сводки
   * (только свежий хвост). Ошибка API — исключение; отказ и обрыв — stop (прежняя сводка остаётся).
   */
  summarize?(req: SummarizeRequest): Promise<SummarizeResult>;
  /** Недорогая модель на вспомогательную работу (переписка по согласию, фото, разбор времени). */
  aux?(req: AuxRequest): Promise<AuxResult>;
  /** Проба «Подумай лучше»: основная и запасная модели, совместимость серверных инструментов. */
  deepProbe?(primary: string, fallback: string): Promise<DeepProbeResult>;
  /** Точный счёт токенов текста (бесплатно, count_tokens). null — не вышло. */
  countTokens?(text: string, signal: AbortSignal): Promise<number | null>;
}
