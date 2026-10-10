/**
 * Команды владельца для сервера Valheim. Разбираются КОДОМ (регулярками), без модели.
 * Ядро пускает их только владельцу и только в его личном «Чате с Еблушей»; всё, что меняет сервер,
 * спрашивает «да» ответом на вопрос (один раз, 2 минуты). Выполняет — помощник valheim-ops.
 *
 *   /eb сервер              — статус (без подтверждения)
 *   /eb рестарт             — перезапуск, когда на сервере никого не будет (restart-when-empty)
 *   /eb рестарт сейчас      — перезапуск сейчас; если в игре люди — их выкинет (предупреждаю в вопросе)
 *   /eb рестарт отмена      — снять ожидание «когда опустеет»
 *   /eb бэкап               — архив мира в /DATA/valheim/backups-manual
 *   /eb мир                 — настройки мира по-русски
 *   /eb мир <ключ> <знач.>  — поменять настройку (ResourceRate 3, NoBuildCost вкл …)
 */
import type { ChatCommand, CommandReply } from "../api";
import type { MapOptionItem } from "./types";
import { OpsUnavailable, type OpsClientLike, type OpsStatus } from "./ops";
import { fmtDuration } from "./geo";
import type { VhWorld } from "./world";

const PREFIX = String.raw`(?:(?:valheim|вальхейм|сервер)\s+)?`;
export const STATUS_RE = /^(?:сервер|статус(?:\s+сервера)?|сервер\s+статус|valheim|вальхейм|статус\s+(?:valheim|вальхейма))\s*\??$/iu;
export const RESTART_RE = new RegExp(
  String.raw`^${PREFIX}(?:рестарт|перезапуск|перезагрузка|перезапусти(?:\s+сервер)?|перезагрузи(?:\s+сервер)?)(?:\s+(?<mode>сейчас|немедленно|прямо\s+сейчас|когда\s+(?:опустеет|все\s+выйдут|никого\s+не\s+будет|будет\s+пусто)|отмена|отмени(?:ть)?))?\s*[.!]?$`,
  "iu"
);
export const CANCEL_RE = /^(?:отмени(?:ть)?\s+(?:рестарт|перезапуск)|рестарт\s+отмена)\s*[.!]?$/iu;
export const BACKUP_RE = new RegExp(String.raw`^${PREFIX}(?:бэкап|бекап|резервная\s+копия|сделай\s+(?:бэкап|бекап|резервную\s+копию)(?:\s+мира)?)\s*[.!]?$`, "iu");
export const WORLD_RE = new RegExp(String.raw`^${PREFIX}(?:мир|настройки\s+мира)(?:\s+(?<key>.+?)\s+(?<val>[^\s]+))?\s*$`, "iu");

type RestartArgs = { mode: "empty" | "now" | "cancel" };
type WorldArgs = { key: string | null; val: string | null };

function opsError(e: unknown): CommandReply {
  if (e instanceof OpsUnavailable) return { text: `Не могу: ${e.message}. Помощника ставят по bot/ops/README.md.` };
  return { text: `Не получилось: ${(e as Error).message}` };
}

/** Значение настройки → строка для valheim-ops ("on"/"off"/число) или ошибка. */
export function parseOptionValue(item: MapOptionItem, raw: string): { value: string } | { error: string } {
  const v = raw.trim().toLowerCase().replace(/^x/, "").replace(",", ".");
  if (item.kind === "flag") {
    if (/^(?:вкл|включить|включи|on|да|1|true|\+)$/.test(v)) return { value: "on" };
    if (/^(?:выкл|выключить|выключи|off|нет|0|false|-)$/.test(v)) return { value: "off" };
    return { error: "для флага — «вкл» или «выкл»" };
  }
  const n = Number(v);
  if (!Number.isFinite(n)) return { error: "нужно число" };
  if (item.kind === "int") {
    const min = item.min ?? 0;
    const max = item.max ?? 10;
    if (!Number.isInteger(n) || n < min || n > max) return { error: `целое от ${min} до ${max}` };
    return { value: String(n) };
  }
  const choices = item.choices ?? [];
  if (choices.length && !choices.includes(n)) return { error: `одно из: ${choices.map((c) => `x${c}`).join(", ")}` };
  return { value: String(n) };
}

function optionValueText(item: MapOptionItem): string {
  if (item.kind === "flag") return item.on ? "вкл" : "выкл";
  return item.kind === "scale" ? `x${item.value ?? 1}` : String(item.value ?? 0);
}

export function findOption(groups: Array<{ items: MapOptionItem[] }>, key: string): MapOptionItem | null {
  const k = key.trim().toLowerCase().replace(/ё/g, "е");
  for (const g of groups) for (const it of g.items) if (it.key.toLowerCase() === k || it.label.toLowerCase().replace(/ё/g, "е") === k) return it;
  return null;
}

export function createCommands(world: VhWorld, ops: OpsClientLike): ChatCommand<any>[] {
  const status: ChatCommand<true> = {
    name: "valheim_status",
    access: "owner",
    help: "`/eb сервер` — статус сервера Valheim (только владелец, в «Чате с Еблушей»)",
    match: (t) => (STATUS_RE.test(t.trim()) ? true : null),
    async run() {
      const lines = ["**Сервер Valheim «Koban»**"];
      const [time, mod, join, st] = await Promise.all([
        world.time().catch(() => null),
        world.mod.health().catch(() => null),
        world.joinInfo().catch(() => null),
        ops.call<OpsStatus>("status", {}, 15_000).catch((e: unknown) => e as Error),
      ]);
      if (!(st instanceof Error) && st.ok) {
        const c = st.container;
        lines.push(`- контейнер: ${c?.running ? `работает${c.startedAt ? ` с ${c.startedAt.replace("T", " ").slice(0, 16)} UTC` : ""}` : `**не работает** (${c?.status ?? "?"})`}`);
        if (st.restartWhenEmpty?.active) lines.push(`- ждёт, когда опустеет, чтобы перезапуститься${st.restartWhenEmpty.since ? ` (с ${st.restartWhenEmpty.since})` : ""}`);
        if (st.restartNow?.active) lines.push("- **перезапускается прямо сейчас**");
        if (st.game?.version) lines.push(`- игра ${st.game.version}${st.game.plugins ? `, плагинов загружено: ${st.game.plugins}` : ""}`);
        const b = st.backups;
        if (b?.lastHourly) lines.push(`- последний бэкап (часовой): ${b.lastHourly.at}, ${(b.lastHourly.size / 1e6).toFixed(0)} МБ; всего часовых: ${b.hourlyCount ?? "?"}`);
        if (b?.lastManual) lines.push(`- последний ручной бэкап: ${b.lastManual.at} (\`${b.lastManual.path}\`)`);
        if (st.disk) lines.push(`- диск: свободно ${st.disk.freeGb.toFixed(0)} ГБ из ${st.disk.totalGb.toFixed(0)}`);
      } else {
        lines.push(`- помощник valheim-ops: ${st instanceof OpsUnavailable ? "не установлен" : "не ответил"} — состояние контейнера и бэкапов не знаю`);
      }
      if (time) {
        lines.push(`- карта отвечает; в игре: ${time.players}; день ${time.day}${time.running ? "" : " (время стоит)"}`);
        if (time.players > 0) {
          const snap = await world.players().catch(() => null);
          if (snap?.players.length) lines.push(`- играют: ${snap.players.map((p) => `${p.name}${p.sessionSec !== null ? ` (${fmtDuration(p.sessionSec)})` : ""}`).join(", ")}`);
        }
      } else lines.push("- **карта (WebMap) не отвечает**");
      lines.push(mod ? `- канал мода для бота: работает (boot ${mod.boot}${mod.scan ? `, сундуков ${mod.scan.containers}` : ""})` : "- канал мода для бота: нет (мод ещё не выложен или мир грузится)");
      if (join?.code) lines.push(`- join-код: \`${join.code}\``);
      return { text: lines.join("\n") };
    },
  };

  const restart: ChatCommand<RestartArgs> = {
    name: "valheim_restart",
    access: "owner",
    confirm: true,
    help: "`/eb рестарт` — перезапуск, когда все выйдут; `/eb рестарт сейчас`; `/eb рестарт отмена`",
    match(t) {
      const s = t.trim();
      if (CANCEL_RE.test(s)) return { mode: "cancel" };
      const m = RESTART_RE.exec(s);
      if (!m) return null;
      const mode = (m.groups?.mode ?? "").toLowerCase();
      if (/^отмен/.test(mode)) return { mode: "cancel" };
      return { mode: /сейчас|немедленно/.test(mode) ? "now" : "empty" };
    },
    async prepare(args) {
      if (args.mode === "cancel") return { question: "Снять ожидание перезапуска «когда опустеет»?" };
      const snap = await world.players().catch(() => null);
      const names = snap?.players.map((p) => p.name) ?? [];
      if (args.mode === "empty") {
        return {
          question: names.length
            ? `Сейчас в игре ${names.length}: ${names.join(", ")}. Перезапущу сервер, когда никого не останется (три проверки подряд по 20 с). Ставим?`
            : "На сервере никого. Перезапущу, как только это подтвердится (три проверки по 20 с). Ставим?",
        };
      }
      return {
        question: names.length
          ? `**Внимание:** в игре ${names.length}: ${names.join(", ")}. Их выкинет из игры на 2–3 минуты (мир сохранится, персонажей сервер попросит сохраниться перед остановкой). Предупредить их в самой игре я пока не умею. Перезапустить **сейчас**?`
          : "На сервере никого. Перезапустить сейчас?",
      };
    },
    async run(args) {
      try {
        if (args.mode === "cancel") {
          const r = await ops.call("restart_cancel");
          return { text: r.ok ? (r.wasActive ? "Отменил: перезапуска «когда опустеет» больше нет." : "Ожидания перезапуска и не было.") : `Не вышло: ${r.error ?? "?"}` };
        }
        if (args.mode === "empty") {
          const r = await ops.call("restart_when_empty");
          return { text: r.ok ? (r.already ? "Уже жду, когда опустеет, — второй раз не ставлю." : "Готово: перезапущу, когда на сервере никого не будет. Отмена — `/eb рестарт отмена`.") : `Не вышло: ${r.error ?? "?"}` };
        }
        const r = await ops.call("restart_now", { reason: "команда владельца из Еблуши" });
        return { text: r.ok ? "Перезапускаю сервер. Он вернётся через 2–4 минуты; join-код не меняется." : `Не вышло: ${r.error ?? "?"}` };
      } catch (e) {
        return opsError(e);
      }
    },
  };

  const backup: ChatCommand<true> = {
    name: "valheim_backup",
    access: "owner",
    confirm: true,
    help: "`/eb бэкап` — архив мира в backups-manual",
    match: (t) => (BACKUP_RE.test(t.trim()) ? true : null),
    async prepare() {
      return { question: "Сделать архив мира (tar.gz с SHA256) в `/DATA/valheim/backups-manual/`? Игра сохраняет мир раз в 30 минут — в архив попадёт последнее сохранение." };
    },
    async run() {
      try {
        const r = await ops.call("backup_now", {}, 180_000);
        if (!r.ok) return { text: `Бэкап не получился: ${r.error ?? "?"}` };
        const size = typeof r.size === "number" ? `${(r.size / 1e6).toFixed(1)} МБ` : "?";
        return { text: `Готово: \`${String(r.path)}\`, ${size}${r.sha256 ? `, SHA256 \`${String(r.sha256).slice(0, 16)}…\`` : ""}.` };
      } catch (e) {
        return opsError(e);
      }
    },
  };

  const worldCmd: ChatCommand<WorldArgs> = {
    name: "valheim_world",
    access: "owner",
    confirm: true,
    help: "`/eb мир` — настройки мира; `/eb мир ResourceRate 3` — поменять",
    match(t) {
      const m = WORLD_RE.exec(t.trim());
      if (!m) return null;
      return { key: m.groups?.key?.trim() ?? null, val: m.groups?.val?.trim() ?? null };
    },
    async prepare(args) {
      let opts;
      try {
        opts = await world.map.options();
      } catch {
        return { reply: { text: "Карта сервера не отвечает — настройки мира прочитать не могу." } };
      }
      if (!args.key || !args.val) {
        const lines = ["**Настройки мира** (меняются сразу, без рестарта):"];
        for (const g of opts.groups) {
          const changed = g.items.filter((i) => (i.kind === "flag" ? i.on : i.isDefault === false));
          lines.push(`- ${g.name}: ${changed.length ? changed.map((i) => `${i.label} — ${optionValueText(i)} (\`${i.key}\`)`).join("; ") : "всё по умолчанию"}`);
        }
        lines.push("", "Поменять: `/eb мир <ключ> <значение>`, например `/eb мир ResourceRate 3` или `/eb мир NoBuildCost выкл`.");
        return { reply: { text: lines.join("\n") } };
      }
      const item = findOption(opts.groups, args.key);
      if (!item) return { reply: { text: `Нет такой настройки: «${args.key}». Список — \`/eb мир\`.` } };
      const v = parseOptionValue(item, args.val);
      if ("error" in v) return { reply: { text: `«${item.label}»: ${v.error}.` } };
      const to = item.kind === "flag" ? (v.value === "on" ? "вкл" : "выкл") : item.kind === "scale" ? `x${v.value}` : v.value;
      return { question: `Поменять «${item.label}» (\`${item.key}\`): ${optionValueText(item)} → ${to}?${item.hint ? ` (${item.hint}.)` : ""} Применится сразу, игрокам перезаходить не надо.` };
    },
    async run(args) {
      if (!args.key || !args.val) return { text: "Нечего менять." };
      try {
        const opts = await world.map.options();
        const item = findOption(opts.groups, args.key);
        if (!item) return { text: `Нет такой настройки: «${args.key}».` };
        const v = parseOptionValue(item, args.val);
        if ("error" in v) return { text: `«${item.label}»: ${v.error}.` };
        // valheim-ops ещё раз сверит ключ и значение со списком /options — ему бот не доверяет.
        const r = await ops.call("options_set", { key: item.key, value: v.value });
        return { text: r.ok ? `Готово: ${String(r.applied ?? args.key)}. Проверить — \`/eb мир\`.` : `Не вышло: ${r.error ?? "?"}` };
      } catch (e) {
        return opsError(e);
      }
    },
  };

  return [status, restart, backup, worldCmd];
}
