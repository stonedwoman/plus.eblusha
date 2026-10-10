/**
 * Журнал бота: JSON-строки в stdout (их собирает docker).
 *
 * Правило: ТЕКСТ СООБЩЕНИЙ В ЖУРНАЛ НЕ ПИШЕМ — ни вопросов, ни ответов, ни результатов
 * поиска. Только идентификаторы, длины, типы событий, токены и деньги. Поля с подозрительными
 * именами (text, content, prompt, answer…) вырезаются на всякий случай и здесь.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const FORBIDDEN = /^(text|content|prompt|answer|question|body|message|messages|password|token|accessToken|refreshToken|apiKey)$/i;

export interface Logger {
  debug(evt: string, fields?: Record<string, unknown>): void;
  info(evt: string, fields?: Record<string, unknown>): void;
  warn(evt: string, fields?: Record<string, unknown>): void;
  error(evt: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

function scrub(fields: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!fields) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (FORBIDDEN.test(k)) continue;
    if (v instanceof Error) {
      out[k] = { name: v.name, msg: String(v.message).slice(0, 300) };
      const status = (v as { status?: unknown }).status;
      if (typeof status === "number") (out[k] as Record<string, unknown>).status = status;
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function createLogger(
  level: LogLevel = "info",
  base: Record<string, unknown> = {},
  sink: (line: string) => void = (l) => process.stdout.write(l + "\n")
): Logger {
  const min = ORDER[level];
  const emit = (lvl: LogLevel, evt: string, fields?: Record<string, unknown>) => {
    if (ORDER[lvl] < min) return;
    sink(JSON.stringify({ ts: new Date().toISOString(), lvl, evt, ...base, ...scrub(fields) }));
  };
  return {
    debug: (e, f) => emit("debug", e, f),
    info: (e, f) => emit("info", e, f),
    warn: (e, f) => emit("warn", e, f),
    error: (e, f) => emit("error", e, f),
    child: (f) => createLogger(level, { ...base, ...scrub(f) }, sink),
  };
}

export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLogger;
  },
};
