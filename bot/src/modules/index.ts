/**
 * Список модулей бота. Включаются переменной BOT_MODULES=имя1,имя2.
 *
 * Как подключить новый модуль:
 *   1. src/modules/<имя>/index.ts экспортирует фабрику `create…Module(): BotModule`
 *      (контракт — src/modules/api.ts);
 *   2. добавить строку в FACTORIES ниже;
 *   3. в deploy/docker-compose.full.yml у сервиса eblusha-bot: BOT_MODULES=<имя>
 *      (и переменные самого модуля, если нужны).
 */
import type { BotModule } from "./api";
import { createValheimModule } from "./valheim";

const FACTORIES: Record<string, () => BotModule> = {
  // Valheim, сервер Koban: src/modules/valheim (переменные VALHEIM_* — bot/README.md).
  valheim: () => createValheimModule(),
};

export function loadModules(names: string[]): BotModule[] {
  const out: BotModule[] = [];
  for (const n of names) {
    const f = FACTORIES[n];
    if (!f) throw new Error(`BOT_MODULES: неизвестный модуль «${n}» (есть: ${Object.keys(FACTORIES).join(", ") || "нет"})`);
    out.push(f());
  }
  return out;
}
