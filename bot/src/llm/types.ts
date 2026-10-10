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

export interface LlmEngine {
  readonly model: string;
  answer(req: AnswerRequest): Promise<AnswerResult>;
  /** Какого персонажа из списка человек имел в виду (null — никакого). */
  matchCharacter(input: string, known: string[], signal: AbortSignal): Promise<{ character: string | null; cost: CostBreakdown }>;
}
