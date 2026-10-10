/**
 * Деньги: цена ответа по usage из ответа API и потолки.
 *
 * Цены ($ за 1 млн токенов) — справочник claude-api от 2026-10-06; при расхождении со счётом
 * в консоли Anthropic править здесь. Неизвестную модель считаем по самой дорогой из таблицы
 * Opus (лучше переоценить расход, чем выйти за потолок).
 * Web search: $10 за 1000 запросов. Web fetch отдельно не тарифицируется — только токены
 * прочитанной страницы (они уже в input_tokens). Встроенная фильтрация у инструментов
 * _20260209 исполняет код на стороне Anthropic; отдельной строки в usage для неё нет, и здесь
 * она не учитывается.
 */
import type { BotConfig } from "../config";
import { Store, utcDay, utcMonth } from "./store";

export interface ModelPrice {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
}

export const PRICES: Record<string, ModelPrice> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheWrite5m: 5, cacheWrite1h: 8, cacheRead: 0.2 },
  "claude-opus-5": { input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5 },
  "claude-opus-4-8": { input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.2 },
  "claude-sonnet-5": { input: 2, output: 10, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.2 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheWrite5m: 0.125, cacheWrite1h: 0.2, cacheRead: 0.01 },
};
const FALLBACK_PRICE: ModelPrice = PRICES["claude-opus-5"]!;
export const WEB_SEARCH_USD = 0.01;

export function priceFor(model: string | null | undefined): ModelPrice {
  if (!model) return FALLBACK_PRICE;
  if (PRICES[model]) return PRICES[model]!;
  // снапшоты вида claude-opus-5-5-YYYYMMDD
  const base = Object.keys(PRICES).find((k) => model.startsWith(k));
  return base ? PRICES[base]! : FALLBACK_PRICE;
}

/** Подмножество BetaUsage, которое нам нужно (структурно совместимо с типом SDK). */
export interface UsageLike {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation?: { ephemeral_5m_input_tokens: number; ephemeral_1h_input_tokens: number } | null;
  server_tool_use?: { web_search_requests: number; web_fetch_requests: number } | null;
  iterations?: Array<{
    type: string;
    model?: string | null;
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation?: { ephemeral_5m_input_tokens: number; ephemeral_1h_input_tokens: number } | null;
  }> | null;
}

export interface CostBreakdown {
  usd: number;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  webSearches: number;
  webFetches: number;
  /** Модели, реально отвечавшие (с учётом server-side fallback). */
  models: string[];
}

function tokensCost(
  p: ModelPrice,
  t: { input: number; output: number; cacheRead: number; cacheWriteTotal: number; w5m?: number; w1h?: number }
): number {
  const w1h = t.w1h ?? 0;
  const w5m = t.w5m ?? Math.max(0, t.cacheWriteTotal - w1h);
  return (t.input * p.input + t.output * p.output + t.cacheRead * p.cacheRead + w5m * p.cacheWrite5m + w1h * p.cacheWrite1h) / 1_000_000;
}

export function costOf(usage: UsageLike, requestModel: string): CostBreakdown {
  const webSearches = usage.server_tool_use?.web_search_requests ?? 0;
  const webFetches = usage.server_tool_use?.web_fetch_requests ?? 0;
  const its = (usage.iterations ?? []).filter((i) => i.type === "message" || i.type === "fallback_message");
  let usd = 0;
  const models = new Set<string>();
  if (its.length > 0) {
    for (const it of its) {
      const model = it.model ?? requestModel;
      models.add(model);
      usd += tokensCost(priceFor(model), {
        input: it.input_tokens ?? 0,
        output: it.output_tokens ?? 0,
        cacheRead: it.cache_read_input_tokens ?? 0,
        cacheWriteTotal: it.cache_creation_input_tokens ?? 0,
        ...(it.cache_creation
          ? { w5m: it.cache_creation.ephemeral_5m_input_tokens, w1h: it.cache_creation.ephemeral_1h_input_tokens }
          : {}),
      });
    }
  } else {
    models.add(requestModel);
    usd += tokensCost(priceFor(requestModel), {
      input: usage.input_tokens,
      output: usage.output_tokens,
      cacheRead: usage.cache_read_input_tokens ?? 0,
      cacheWriteTotal: usage.cache_creation_input_tokens ?? 0,
      ...(usage.cache_creation
        ? { w5m: usage.cache_creation.ephemeral_5m_input_tokens, w1h: usage.cache_creation.ephemeral_1h_input_tokens }
        : {}),
    });
  }
  usd += webSearches * WEB_SEARCH_USD;
  return {
    usd,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    webSearches,
    webFetches,
    models: [...models],
  };
}

export function addCost(a: CostBreakdown, b: CostBreakdown): CostBreakdown {
  return {
    usd: a.usd + b.usd,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    webSearches: a.webSearches + b.webSearches,
    webFetches: a.webFetches + b.webFetches,
    models: [...new Set([...a.models, ...b.models])],
  };
}

export const ZERO_COST: CostBreakdown = {
  usd: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheWriteTokens: 0,
  cacheReadTokens: 0,
  webSearches: 0,
  webFetches: 0,
  models: [],
};

export type BudgetVerdict =
  | { ok: true }
  | { ok: false; reason: "month" | "day" | "user_questions" | "user_usd" | "no_key" };

/** Средняя цена ответа с поиском — запас, который должен остаться под потолком перед запросом. */
const RESERVE_USD = 0.2;

export class Budget {
  constructor(
    private readonly store: Store,
    private readonly cfg: Pick<BotConfig, "monthlyBudgetUsd" | "dailyBudgetUsd" | "userDailyQuestions" | "userDailyUsd">,
    private readonly now: () => number = Date.now
  ) {}

  /**
   * Потолки: месяц — для всех, включая владельца; сутки на всех и личные лимиты — кроме
   * владельца (бот принимает контакты от любого пользователя мессенджера: чужие вопросы
   * могут выбрать общий дневной потолок, и владелец не должен из-за этого остаться без бота).
   */
  check(userId: string, isOwner: boolean): BudgetVerdict {
    const t = this.now();
    if (this.store.spentMonth(utcMonth(t)) + RESERVE_USD > this.cfg.monthlyBudgetUsd) return { ok: false, reason: "month" };
    if (!isOwner && this.store.spentDay(utcDay(t)) + RESERVE_USD > this.cfg.dailyBudgetUsd) return { ok: false, reason: "day" };
    if (!isOwner) {
      const u = this.store.userDay(userId, utcDay(t));
      if (u.questions >= this.cfg.userDailyQuestions) return { ok: false, reason: "user_questions" };
      if (u.usd >= this.cfg.userDailyUsd) return { ok: false, reason: "user_usd" };
    }
    return { ok: true };
  }

  record(userId: string, conversationId: string, kind: string, model: string, c: CostBreakdown): void {
    this.store.recordUsage({
      ts: this.now(),
      userId,
      conversationId,
      kind,
      model: c.models.join(",") || model,
      inputTokens: c.inputTokens,
      outputTokens: c.outputTokens,
      cacheWriteTokens: c.cacheWriteTokens,
      cacheReadTokens: c.cacheReadTokens,
      webSearches: c.webSearches,
      webFetches: c.webFetches,
      costUsd: c.usd,
    });
  }

  summary(): { month: string; spentUsd: number; capUsd: number; todayUsd: number; dayCapUsd: number; requests: number; users: number; webSearches: number } {
    const t = this.now();
    const m = utcMonth(t);
    const s = this.store.monthSummary(m);
    return {
      month: m,
      spentUsd: s.usd,
      capUsd: this.cfg.monthlyBudgetUsd,
      todayUsd: this.store.spentDay(utcDay(t)),
      dayCapUsd: this.cfg.dailyBudgetUsd,
      requests: s.requests,
      users: s.users,
      webSearches: s.webSearches,
    };
  }
}

export function budgetRefusalText(reason: Exclude<BudgetVerdict, { ok: true }>["reason"]): string {
  switch (reason) {
    case "month":
      return "На этот месяц лимит на умные ответы исчерпан — до 1-го числа отвечаю только на самое простое.";
    case "day":
      return "На сегодня общий лимит на умные ответы исчерпан. Завтра снова буду думать в полную силу.";
    case "user_questions":
      return "На сегодня твой лимит вопросов закончился. Приходи завтра 🙂";
    case "user_usd":
      return "Сегодня ты задал мне дорогих вопросов на весь дневной лимит. Продолжим завтра.";
    case "no_key":
      return "Мозги ещё не подключены (ключ модели не настроен), поэтому пока умею только самое простое. Скоро буду отвечать по-настоящему.";
  }
}
