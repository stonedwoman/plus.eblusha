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

export interface ToolRuntime {
  defs: LlmToolDef[];
  /** Выполнить инструмент; ошибки — не исключения, а isError. */
  run(name: string, input: unknown): Promise<{ content: string; isError: boolean }>;
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
}
