/**
 * Конфигурация бота — только из переменных окружения.
 *
 * Откуда берутся значения в проде (deploy/docker-compose.full.yml, сервис eblusha-bot):
 *   /DATA/eblusha-plus/.env.bot-account — логин/пароль бота и id владельца
 *       (пишет src/scripts/seedBotUser.ts, права 600);
 *   /DATA/eblusha-plus/.env.bot         — ANTHROPIC_API_KEY (кладёт владелец; без него бот
 *       работает, но вместо модели отвечает короткими шаблонами);
 *   environment в compose                — адрес backend, каталог данных.
 * Секреты в журнал не попадают: describeConfig() печатает только их наличие.
 */

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface BotConfig {
  /** Базовый адрес backend Еблуши (HTTP и socket.io), без завершающего «/». */
  apiUrl: string;
  username: string;
  password: string;
  /** userId владельца (ston): команды управления, расход, привязка чужих ников. */
  ownerUserId: string | null;
  anthropicApiKey: string | null;
  /**
   * Workspace для ключа, не привязанного к workspace (ключи вида sk-ant-usr…): без него API
   * отвечает 400 «must include the anthropic-workspace-id header». Уходит параметром workspace_id.
   */
  anthropicWorkspaceId: string | null;
  model: string;
  /** Каталог для SQLite (учёт расходов, привязки ников, подтверждения). */
  dataDir: string;

  /** Потолок трат на модель за календарный месяц (UTC), $. */
  monthlyBudgetUsd: number;
  /** Потолок трат за сутки (UTC) на всех, $ — чтобы месяц не сгорел за вечер. */
  dailyBudgetUsd: number;
  /** Вопросов к модели на человека в сутки (владельца не касается). */
  userDailyQuestions: number;
  /** Трат на человека в сутки, $ (владельца не касается). */
  userDailyUsd: number;
  /** Жёсткий потолок одного ответа, $: дальше цикл инструментов обрывается. */
  requestMaxUsd: number;

  /** Сколько сообщений цепочки ответов отдавать модели. */
  contextMaxMessages: number;
  /** Сколько поисков/чтений страниц за один ответ. */
  webSearchMaxUses: number;
  webFetchMaxUses: number;
  webFetchMaxContentTokens: number;
  /** max_tokens одного обращения (размышление + ответ). */
  maxTokens: number;
  /** Сколько итераций цикла инструментов максимум. */
  maxToolIterations: number;
  /** Параллельных обращений к модели на весь бот. */
  maxConcurrentLlm: number;

  /** В личке отвечать и без «Еблуша,» (по умолчанию нет — правило владельца). */
  dmWithoutPrefix: boolean;
  /** Модули: имена через запятую (valheim, …). Пусто — только ядро. */
  modules: string[];
  /** Часовой пояс для «сейчас» в подсказке модели. */
  timeZone: string;
  logLevel: "debug" | "info" | "warn" | "error";
}

function str(env: NodeJS.ProcessEnv, key: string, def?: string): string {
  const v = env[key];
  if (v !== undefined && v.trim() !== "") return v.trim();
  if (def !== undefined) return def;
  throw new Error(`Не задана переменная окружения ${key}`);
}

function optStr(env: NodeJS.ProcessEnv, key: string): string | null {
  const v = env[key];
  return v !== undefined && v.trim() !== "" ? v.trim() : null;
}

function num(env: NodeJS.ProcessEnv, key: string, def: number): number {
  const v = env[key];
  if (v === undefined || v.trim() === "") return def;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${key}=${v}: ждём неотрицательное число`);
  return n;
}

function bool(env: NodeJS.ProcessEnv, key: string, def: boolean): boolean {
  const v = env[key];
  if (v === undefined || v.trim() === "") return def;
  return /^(1|true|yes|on|да)$/i.test(v.trim());
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BotConfig {
  const level = str(env, "BOT_LOG_LEVEL", "info");
  if (!["debug", "info", "warn", "error"].includes(level)) throw new Error(`BOT_LOG_LEVEL=${level}`);
  return {
    apiUrl: str(env, "BOT_API_URL", "http://127.0.0.1:4000").replace(/\/+$/, ""),
    username: str(env, "BOT_USERNAME"),
    password: str(env, "BOT_PASSWORD"),
    ownerUserId: optStr(env, "BOT_OWNER_USER_ID"),
    anthropicApiKey: optStr(env, "ANTHROPIC_API_KEY"),
    anthropicWorkspaceId: optStr(env, "ANTHROPIC_WORKSPACE_ID"),
    model: str(env, "BOT_MODEL", "claude-opus-5-5"),
    dataDir: str(env, "BOT_DATA_DIR", "./data"),
    monthlyBudgetUsd: num(env, "BOT_MONTHLY_BUDGET_USD", 60),
    dailyBudgetUsd: num(env, "BOT_DAILY_BUDGET_USD", 6),
    userDailyQuestions: num(env, "BOT_USER_DAILY_QUESTIONS", 25),
    userDailyUsd: num(env, "BOT_USER_DAILY_USD", 2),
    requestMaxUsd: num(env, "BOT_REQUEST_MAX_USD", 1.5),
    contextMaxMessages: Math.max(1, Math.floor(num(env, "BOT_CONTEXT_MAX_MESSAGES", 12))),
    webSearchMaxUses: Math.floor(num(env, "BOT_WEB_SEARCH_MAX_USES", 5)),
    webFetchMaxUses: Math.floor(num(env, "BOT_WEB_FETCH_MAX_USES", 4)),
    webFetchMaxContentTokens: Math.floor(num(env, "BOT_WEB_FETCH_MAX_CONTENT_TOKENS", 15000)),
    maxTokens: Math.floor(num(env, "BOT_MAX_TOKENS", 16000)),
    maxToolIterations: Math.max(1, Math.floor(num(env, "BOT_MAX_TOOL_ITERATIONS", 8))),
    maxConcurrentLlm: Math.max(1, Math.floor(num(env, "BOT_MAX_CONCURRENT_LLM", 3))),
    dmWithoutPrefix: bool(env, "BOT_DM_WITHOUT_PREFIX", false),
    modules: (optStr(env, "BOT_MODULES") ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    timeZone: str(env, "BOT_TIME_ZONE", "Europe/Moscow"),
    logLevel: level as BotConfig["logLevel"],
  };
}

/** Для журнала при старте: без секретов. */
export function describeConfig(c: BotConfig): Record<string, unknown> {
  return {
    apiUrl: c.apiUrl,
    owner: c.ownerUserId ? "set" : "unset",
    anthropicKey: c.anthropicApiKey ? "set" : "unset",
    anthropicWorkspace: c.anthropicWorkspaceId ? "set" : "unset",
    model: c.model,
    dataDir: c.dataDir,
    monthlyBudgetUsd: c.monthlyBudgetUsd,
    dailyBudgetUsd: c.dailyBudgetUsd,
    userDailyQuestions: c.userDailyQuestions,
    userDailyUsd: c.userDailyUsd,
    modules: c.modules,
    dmWithoutPrefix: c.dmWithoutPrefix,
  };
}
