/**
 * Настройки модуля Valheim — из переменных окружения сервиса eblusha-bot (network_mode: host,
 * поэтому все адреса — loopback хоста stoned).
 */
export interface ValheimConfig {
  /** Плагин карты WebMap. */
  mapUrl: string;
  /** Закрытый канал мода для бота (/bot/v1). */
  botUrl: string;
  /** Файл токена канала (X-Bot-Token). В контейнере — смонтированный только на чтение. */
  botTokenFile: string | null;
  /** valheim-join-code.json через хаб koban.uk: join-код и недавние игроки. Пусто — не брать. */
  joinJsonUrl: string | null;
  /** Ссылка на живую карту для людей. */
  publicMapUrl: string;
  /** Unix-сокет помощника valheim-ops (команды владельца). Пусто — команды только показывают статус. */
  opsSocket: string | null;
  /** Часовой пояс для времени в ответах. */
  timeZone: string;
}

function s(env: NodeJS.ProcessEnv, key: string, def: string): string {
  const v = env[key];
  return v !== undefined && v.trim() !== "" ? v.trim() : def;
}

function opt(env: NodeJS.ProcessEnv, key: string, def: string | null): string | null {
  const v = env[key];
  if (v === undefined) return def;
  return v.trim() === "" ? null : v.trim();
}

export function loadValheimConfig(env: NodeJS.ProcessEnv = process.env): ValheimConfig {
  return {
    mapUrl: s(env, "VALHEIM_MAP_URL", "http://127.0.0.1:3010").replace(/\/+$/, ""),
    botUrl: s(env, "VALHEIM_BOT_URL", "http://127.0.0.1:3011").replace(/\/+$/, ""),
    botTokenFile: opt(env, "VALHEIM_BOT_TOKEN_FILE", "/run/secrets/webmap-bot.token"),
    joinJsonUrl: opt(env, "VALHEIM_JOIN_JSON_URL", "http://127.0.0.1:8090/v/valheim-join-code.json"),
    publicMapUrl: s(env, "VALHEIM_PUBLIC_MAP_URL", "https://v.koban.uk/map/"),
    opsSocket: opt(env, "VALHEIM_OPS_SOCKET", "/run/valheim-ops/ops.sock"),
    timeZone: s(env, "BOT_TIME_ZONE", "Europe/Moscow"),
  };
}
