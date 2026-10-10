/**
 * Список модулей бота. Включаются переменной BOT_MODULES=имя1,имя2.
 *
 * Как подключить новый модуль (например, Valheim):
 *   1. src/modules/valheim/index.ts экспортирует `createValheimModule(): BotModule`
 *      (контракт — src/modules/api.ts);
 *   2. добавить строку в FACTORIES ниже: `valheim: () => createValheimModule()`;
 *   3. в deploy/docker-compose.full.yml у сервиса eblusha-bot: BOT_MODULES=valheim
 *      (и переменные самого модуля, если нужны).
 */
import type { BotModule } from "./api";

const FACTORIES: Record<string, () => BotModule> = {
  // valheim: () => createValheimModule(),
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
