/**
 * Конфигурация бота — только из переменных окружения.
 *
 * Откуда берутся значения в проде (deploy/docker-compose.full.yml, сервис eblusha-bot):
 *   /DATA/eblusha-plus/.env.bot-account — логин/пароль бота и id владельца
 *       (пишет src/scripts/seedBotUser.ts, права 600);
 *   /DATA/eblusha-plus/.env.bot         — ANTHROPIC_API_KEY (кладёт владелец; без него бот
 *       работает, но вместо модели отвечает короткими шаблонами);
 *   environment в compose                — адрес backend и Redis (очередь обращений), каталог данных.
 * Секреты в журнал не попадают: describeConfig() печатает только их наличие.
 */

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface BotConfig {
  /** Базовый адрес backend Еблуши (HTTP: /api/bot/*, /api/upload, /api/files), без завершающего «/». */
  apiUrl: string;
  /** Redis backend: очередь BullMQ с обращениями к боту (кладёт сервер, src/lib/systemBot.ts). */
  redisUrl: string;
  /** Имя очереди (на сервере — BOT_QUEUE_NAME в src/jobs/queue.ts). */
  queueName: string;
  /** Сколько обращений обрабатывать одновременно (одна беседа — всё равно по очереди). */
  queueConcurrency: number;
  /** Обращение старше этого (бот лежал) — не отвечаем: вопрос уже неактуален, а разрешение вот-вот истечёт. */
  jobMaxAgeMs: number;
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
  /**
   * Справочник по приложению (bot/knowledge/eblusha-app.md; в образе — /app/knowledge/eblusha-app.md) — блоком в
   * системный текст. null (BOT_KNOWLEDGE_FILE=off) — без справочника.
   */
  knowledgeFile: string | null;

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
  /**
   * Память о своих разговорах (решение владельца 2026-10-11, core/memory.ts): бот помнит ВСЕ свои разговоры
   * в беседе — давнее сводкой, свежее дословно. Хвост длиннее memoryTailTokens (оценка) — старое сжимается в
   * сводку, пока хвост не станет ≤ memoryTailKeepTokens. 0 — память выключена (только цепочка ответов).
   */
  memoryTailTokens: number;
  memoryTailKeepTokens: number;
  /**
   * Модель сжатия (недорогая): claude-sonnet-5-5 или claude-haiku-5-5; null (BOT_MEMORY_MODEL=off) — без сводки:
   * давнее, вытесняемое из хвоста, забывается (и бот так и говорит).
   */
  memoryModel: string | null;
  /** Сводка не длиннее (токенов; модели — как ориентир в знаках, ~2 знака русского текста на токен). */
  memorySummaryTokens: number;
  /** Сколько старого (оценка, токенов) сжимать за один вызов модели сжатия. */
  memoryChunkTokens: number;
  /** Вызовов модели сжатия на один ответ (дальше — догоняет на следующих обращениях). */
  memoryMaxCalls: number;
  /** Ответ бота в хвосте (все части вместе) — не длиннее (символов); длиннее — ужимается. */
  memoryBotChars: number;
  /** Сообщение человека в хвосте — не длиннее (символов). */
  memoryUserChars: number;
  /** Сводку беседы, к которой не обращались столько дней, удаляем (сервер хранит всё — соберётся заново). */
  memoryIdleDays: number;
  /** Срок кэша промпта на конце памяти: 5m (дешевле запись) или 1h (дороже запись, переживает паузы). */
  memoryCacheTtl: "5m" | "1h";
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

  /**
   * Данные игроков (access "player": где кто, склады, карточка карты) в ГРУППАХ.
   * "all" (по умолчанию) — только если ВСЕ участники группы — игроки (привязаны или владелец):
   * ответ в группе видят все, а правило владельца — данные игроков только игрокам.
   * "requester" — достаточно, что игрок тот, кто спрашивает.
   */
  groupPlayerData: "all" | "requester";
  /** Модули: имена через запятую (valheim, …). Пусто — только ядро. */
  modules: string[];
  /** Часовой пояс для «сейчас» в подсказке модели. */
  timeZone: string;
  logLevel: "debug" | "info" | "warn" | "error";

  /**
   * «Подумай лучше» (решение владельца 2026-10-11, docs/bot-cards.md): повтор ответа самой мощной моделью.
   * deepModel — claude-fable-5-1 (мышление всегда включено, effort high); недоступна (хранение данных организации,
   * нет доступа, перегрузка) — deepFallbackModel (claude-opus-5-5, effort max). null — фича выключена (BOT_DEEP=off).
   */
  deepModel: string | null;
  deepFallbackModel: string;
  /** «Подумай лучше» на человека в сутки (UTC); владельцу — deepOwnerDaily. */
  deepUserDaily: number;
  deepOwnerDaily: number;
  /** Жёсткий потолок одного «подумай лучше», $ (max_tokens и предел шагов инструментов — от него). */
  deepMaxUsdPerAnswer: number;
  /** Потолок «подумай лучше» за месяц (UTC), $ — внутри общего BOT_MONTHLY_BUDGET_USD. */
  deepMonthlyUsd: number;
  /** Шагов цикла инструментов на один глубокий ответ. */
  deepMaxSteps: number;

  /**
   * «Поделиться перепиской» (docs/bot-cards.md): вспомогательная модель (заметки кусков, описания фото), пороги
   * прямого режима и кусков (токены), фото на согласие и «глазами» на ответ, потолок цены одного чтения, $.
   */
  shareAuxModel: string;
  shareDirectTokens: number;
  shareChunkTokens: number;
  shareMaxTokens: number;
  shareMaxPhotos: number;
  shareViewPhotos: number;
  shareMaxUsd: number;
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
  const groupPlayerData = str(env, "BOT_GROUP_PLAYER_DATA", "all").toLowerCase();
  if (groupPlayerData !== "all" && groupPlayerData !== "requester") throw new Error(`BOT_GROUP_PLAYER_DATA=${groupPlayerData}: ждём all или requester`);
  const memoryTailTokens = Math.floor(num(env, "BOT_MEMORY_TAIL_TOKENS", 25000));
  const memoryTailKeepTokens = Math.floor(num(env, "BOT_MEMORY_TAIL_KEEP_TOKENS", Math.min(15000, Math.floor(memoryTailTokens * 0.6))));
  const memoryModelRaw = str(env, "BOT_MEMORY_MODEL", "claude-sonnet-5-5");
  const memoryCacheTtl = str(env, "BOT_MEMORY_CACHE_TTL", "5m");
  if (memoryCacheTtl !== "5m" && memoryCacheTtl !== "1h") throw new Error(`BOT_MEMORY_CACHE_TTL=${memoryCacheTtl}: ждём 5m или 1h`);
  return {
    apiUrl: str(env, "BOT_API_URL", "http://127.0.0.1:4000").replace(/\/+$/, ""),
    redisUrl: str(env, "BOT_REDIS_URL", "redis://127.0.0.1:6379/0"),
    queueName: str(env, "BOT_QUEUE_NAME", "bot"),
    queueConcurrency: Math.max(1, Math.floor(num(env, "BOT_QUEUE_CONCURRENCY", 6))),
    jobMaxAgeMs: Math.max(30, num(env, "BOT_JOB_MAX_AGE_SEC", 600)) * 1000,
    username: str(env, "BOT_USERNAME"),
    password: str(env, "BOT_PASSWORD"),
    ownerUserId: optStr(env, "BOT_OWNER_USER_ID"),
    anthropicApiKey: optStr(env, "ANTHROPIC_API_KEY"),
    anthropicWorkspaceId: optStr(env, "ANTHROPIC_WORKSPACE_ID"),
    model: str(env, "BOT_MODEL", "claude-opus-5-5"),
    dataDir: str(env, "BOT_DATA_DIR", "./data"),
    knowledgeFile: /^(off|0|false|no|нет)$/i.test(str(env, "BOT_KNOWLEDGE_FILE", "knowledge/eblusha-app.md")) ? null : str(env, "BOT_KNOWLEDGE_FILE", "knowledge/eblusha-app.md"),
    monthlyBudgetUsd: num(env, "BOT_MONTHLY_BUDGET_USD", 60),
    dailyBudgetUsd: num(env, "BOT_DAILY_BUDGET_USD", 6),
    userDailyQuestions: num(env, "BOT_USER_DAILY_QUESTIONS", 25),
    userDailyUsd: num(env, "BOT_USER_DAILY_USD", 2),
    requestMaxUsd: num(env, "BOT_REQUEST_MAX_USD", 1.5),
    contextMaxMessages: Math.max(1, Math.floor(num(env, "BOT_CONTEXT_MAX_MESSAGES", 12))),
    memoryTailTokens,
    memoryTailKeepTokens: Math.min(memoryTailKeepTokens, memoryTailTokens),
    memoryModel: memoryModelRaw.toLowerCase() === "off" ? null : memoryModelRaw,
    memorySummaryTokens: Math.max(500, Math.floor(num(env, "BOT_MEMORY_SUMMARY_TOKENS", 6000))),
    memoryChunkTokens: Math.max(2000, Math.floor(num(env, "BOT_MEMORY_CHUNK_TOKENS", 40000))),
    memoryMaxCalls: Math.max(1, Math.floor(num(env, "BOT_MEMORY_MAX_CALLS", 4))),
    memoryBotChars: Math.max(300, Math.floor(num(env, "BOT_MEMORY_BOT_CHARS", 4000))),
    memoryUserChars: Math.max(300, Math.floor(num(env, "BOT_MEMORY_USER_CHARS", 3000))),
    memoryIdleDays: Math.max(1, Math.floor(num(env, "BOT_MEMORY_IDLE_DAYS", 90))),
    memoryCacheTtl,
    webSearchMaxUses: Math.floor(num(env, "BOT_WEB_SEARCH_MAX_USES", 5)),
    webFetchMaxUses: Math.floor(num(env, "BOT_WEB_FETCH_MAX_USES", 4)),
    webFetchMaxContentTokens: Math.floor(num(env, "BOT_WEB_FETCH_MAX_CONTENT_TOKENS", 15000)),
    maxTokens: Math.floor(num(env, "BOT_MAX_TOKENS", 16000)),
    maxToolIterations: Math.max(1, Math.floor(num(env, "BOT_MAX_TOOL_ITERATIONS", 8))),
    maxConcurrentLlm: Math.max(1, Math.floor(num(env, "BOT_MAX_CONCURRENT_LLM", 3))),
    groupPlayerData,
    modules: (optStr(env, "BOT_MODULES") ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    timeZone: str(env, "BOT_TIME_ZONE", "Europe/Moscow"),
    logLevel: level as BotConfig["logLevel"],
    deepModel: bool(env, "BOT_DEEP", true) ? str(env, "BOT_DEEP_MODEL", "claude-fable-5-1") : null,
    deepFallbackModel: str(env, "BOT_DEEP_FALLBACK_MODEL", "claude-opus-5-5"),
    deepUserDaily: Math.floor(num(env, "BOT_DEEP_USER_DAILY", 5)),
    deepOwnerDaily: Math.floor(num(env, "BOT_DEEP_OWNER_DAILY", 20)),
    deepMaxUsdPerAnswer: num(env, "BOT_DEEP_MAX_USD_PER_ANSWER", 2),
    deepMonthlyUsd: num(env, "BOT_DEEP_MONTHLY_USD", 40),
    deepMaxSteps: Math.max(1, Math.floor(num(env, "BOT_DEEP_MAX_STEPS", 6))),
    shareAuxModel: str(env, "BOT_SHARE_AUX_MODEL", "claude-haiku-5-5"),
    shareDirectTokens: Math.max(1000, Math.floor(num(env, "BOT_SHARE_DIRECT_TOKENS", 100_000))),
    shareChunkTokens: Math.max(2000, Math.floor(num(env, "BOT_SHARE_CHUNK_TOKENS", 60_000))),
    shareMaxTokens: Math.max(1000, Math.floor(num(env, "BOT_SHARE_MAX_TOKENS", 1_500_000))),
    shareMaxPhotos: Math.floor(num(env, "BOT_SHARE_MAX_PHOTOS", 60)),
    shareViewPhotos: Math.floor(num(env, "BOT_SHARE_VIEW_PHOTOS", 4)),
    shareMaxUsd: num(env, "BOT_SHARE_MAX_USD", 1),
  };
}

/** Для журнала при старте: без секретов. */
export function describeConfig(c: BotConfig): Record<string, unknown> {
  return {
    apiUrl: c.apiUrl,
    redis: c.redisUrl.replace(/\/\/[^@/]*@/, "//***@"),
    queue: c.queueName,
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
    groupPlayerData: c.groupPlayerData,
    memory: {
      tailTokens: c.memoryTailTokens,
      keepTokens: c.memoryTailKeepTokens,
      model: c.memoryModel ?? "off",
      summaryTokens: c.memorySummaryTokens,
      cacheTtl: c.memoryCacheTtl,
    },
    deep: {
      model: c.deepModel ?? "off",
      fallback: c.deepFallbackModel,
      userDaily: c.deepUserDaily,
      ownerDaily: c.deepOwnerDaily,
      maxUsd: c.deepMaxUsdPerAnswer,
      monthlyUsd: c.deepMonthlyUsd,
    },
    share: { aux: c.shareAuxModel, directTokens: c.shareDirectTokens, maxTokens: c.shareMaxTokens, maxUsd: c.shareMaxUsd, photos: c.shareMaxPhotos },
  };
}
