/**
 * Точка входа сервиса бота «Еблуша».
 *   node --disable-warning=ExperimentalWarning dist/src/main.js
 * Конфигурация — src/config.ts (переменные окружения), модули — src/modules/index.ts.
 */
import fs from "node:fs";
import path from "node:path";
import { describeConfig, loadConfig, type BotConfig } from "./config";
import { createLogger, type Logger } from "./log";
import { EblushaApi } from "./api/eblusha";
import { Realtime } from "./api/realtime";
import { Bot } from "./core/bot";
import { Registry } from "./core/registry";
import { Store } from "./core/store";
import { ClaudeEngine } from "./llm/claude";
import { buildSystemPrompt } from "./llm/prompt";
import { loadModules } from "./modules";
import type { BotModule } from "./modules/api";
import type { LlmEngine } from "./llm/types";

const DISPLAY_NAME = "Еблуша";
const BIO = "Бот. Позови: «Еблуша, …» или /eb. Продолжай ответом на моё сообщение.";

/** Имя, описание и аватар (фирменная «Б») — один раз, если их ещё нет. */
async function ensureProfile(api: EblushaApi, log: Logger, assetsDir: string): Promise<void> {
  try {
    const me = await api.me();
    if (me.displayName !== DISPLAY_NAME || !me.bio) await api.updateMe({ displayName: DISPLAY_NAME, ...(me.bio ? {} : { bio: BIO }) });
    if (!me.avatarUrl) {
      const file = path.resolve(assetsDir, "avatar.png");
      if (fs.existsSync(file)) {
        const up = await api.upload(fs.readFileSync(file), "eblusha-bot.png", "image/png");
        await api.updateMe({ avatarUrl: up.url });
        log.info("profile.avatar_set");
      }
    }
  } catch (e) {
    log.warn("profile.ensure_failed", { err: e as Error });
  }
}

export interface StartOptions {
  /** Подмена модели (интеграционный тест: без сети и без денег). undefined — по ключу из конфига. */
  llm?: LlmEngine | null;
  /** Дополнительные модули (тесты); основные — из BOT_MODULES. */
  extraModules?: BotModule[];
  assetsDir?: string;
}

export async function startBot(cfg: BotConfig, log: Logger, opts: StartOptions = {}) {
  const store = new Store(path.join(cfg.dataDir, "bot.sqlite"));
  const registry = new Registry();
  for (const m of [...loadModules(cfg.modules), ...(opts.extraModules ?? [])]) registry.add(m);
  const api = new EblushaApi(cfg.apiUrl, { username: cfg.username, password: cfg.password }, log.child({ c: "api" }));
  await ensureProfile(api, log, opts.assetsDir ?? process.env.BOT_ASSETS_DIR ?? path.join(process.cwd(), "assets"));

  const llm =
    opts.llm !== undefined
      ? opts.llm
      : cfg.anthropicApiKey
        ? new ClaudeEngine(cfg, buildSystemPrompt(registry.prompts), log.child({ c: "llm" }))
        : null;
  if (!llm) log.warn("llm.disabled", { reason: "ANTHROPIC_API_KEY не задан — отвечаю шаблонами" });
  let engine: LlmEngine | null = llm;
  if (llm instanceof ClaudeEngine) {
    const p = await llm.probe();
    if (p.ok) log.info("llm.probe_ok", { model: llm.model });
    else {
      log.error("llm.probe_failed", { status: p.status, why: p.message });
      // 400/401/403 — ключ не принят (нет workspace, отозван, нет прав): само это не пройдёт,
      // поэтому честно отвечаю «мозги не подключены», а не «что-то сломалось» на каждый вопрос.
      // Сеть (status null), 429 и 5xx — временное: модель остаётся включённой.
      if (p.status === 400 || p.status === 401 || p.status === 403) {
        engine = null;
        log.warn("llm.disabled", { reason: "ключ модели не принят API — шаблоны до перезапуска с исправленным .env.bot" });
      }
    }
  }

  let bot!: Bot;
  const rt = new Realtime(
    cfg.apiUrl,
    () => api.accessToken(),
    {
      onMessage: (p) => bot.onMessage(p),
      onConversationsChanged: (p) => bot.onConversationsChanged(p),
      onSecretThread: (p) => bot.onSecretThread(p),
      onContactRequest: (p) => bot.onContactRequest(p),
      onIncomingCall: (p) => bot.onIncomingCall(p),
      onConnect: () => bot.onConnect(),
      onDisconnect: () => bot.onDisconnect(),
    },
    log.child({ c: "socket" })
  );
  bot = new Bot({ cfg, api, rt, store, llm: engine, registry, log: log.child({ c: "core" }) });
  await bot.start();
  rt.start();

  return {
    bot,
    api,
    rt,
    async stop() {
      rt.stop();
      await bot.stop();
      store.close();
    },
  };
}

if (require.main === module) {
  let cfg: BotConfig;
  try {
    cfg = loadConfig();
  } catch (e) {
    process.stderr.write(`[eblusha-bot] конфигурация: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(2);
  }
  const log = createLogger(cfg.logLevel, { svc: "eblusha-bot" });
  log.info("boot", describeConfig(cfg));
  startBot(cfg, log)
    .then((h) => {
      const shutdown = (sig: string) => {
        log.info("shutdown", { sig });
        h.stop().finally(() => process.exit(0));
      };
      process.on("SIGTERM", () => shutdown("SIGTERM"));
      process.on("SIGINT", () => shutdown("SIGINT"));
    })
    .catch((e: unknown) => {
      log.error("boot.failed", { err: e as Error });
      process.exit(1);
    });
}
