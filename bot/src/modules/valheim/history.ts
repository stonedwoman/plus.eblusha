/**
 * Летопись сервера Valheim (инструмент модели valheim_history): сессии, вечера, смерти, боссы, мир — за всё
 * время, из выжимки /DATA/valheim-history/export/history-bot.json (её пересобирает таймер на хосте раз в сутки,
 * заменяя файл атомарно — новым inode; поэтому в контейнер монтируется КАТАЛОГ export/ только на чтение, а файл
 * перечитывается по пути при смене mtime/размера).
 *
 * ТОЛЬКО ЧТЕНИЕ. Приватность — как у остальных инструментов Valheim (tools.ts):
 *   - личные цифры (игрок, смерти, вечер, факты) — только игрокам сервера и только там, где ответ не увидят
 *     непривязанные (playerDataVisible); остальным — тот же отказ, что у access "player";
 *   - мир и боссы — всем, но без имён и часов людей (кто был онлайн, кто строил);
 *   - имена персонажей пишут игроки → результат недоверенный (untrusted).
 * Мир Koban — по умолчанию (корень файла); старый мир santonoma (раздел archive) — только если спросили (world=archive).
 */
import fs from "node:fs";
import type { BotTool, ToolContext, ToolResult } from "../api";
import { fuzzyCharacter, matchCharacter, sameCharacter } from "../../core/nick";
import { accessDeniedText, playerDataVisible } from "../../core/registry";
import { prefixCharacter } from "./tools";

export const HISTORY_TOPICS = ["player", "world", "bosses", "deaths", "evening", "facts"] as const;
export type HistoryTopic = (typeof HISTORY_TOPICS)[number];

export interface HistoryInput {
  topic: HistoryTopic;
  who?: string;
  date?: string;
  world?: "koban" | "archive";
}

/** Потолок ответа инструмента (знаков): больше — обрезаем с пометкой. */
export const HISTORY_MAX_CHARS = 12_000;

const SELF_RE = /^(?:я|меня|мне|мной|себя|сам|сама|мой|моя|мои|мой\s+персонаж|мой\s+перс|me|myself|self)$/i;

/** Ключи с людьми и их часами — вычищаются из «мира» и «боссов» для тех, кому личные данные не положены. */
const PERSONAL_KEYS = new Set([
  "online_in_window",
  "death_clusters_hint",
  "evenings_in_window",
  "by_character",
  "by_person",
  "main_builder",
  "characters",
  "character",
  "person",
  "people",
  "online",
  "who",
  "hours_by_person",
  "hours_by_character",
  "deaths_within_30min_by_character",
  "longest_sessions_top5",
  "rollbacks",
  "stopped_while_players_in_game",
]);

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Obj = { [k: string]: Json };

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function arr(v: unknown): Json[] {
  return Array.isArray(v) ? (v as Json[]) : [];
}
function obj(v: unknown): Obj {
  return isObj(v) ? v : {};
}
function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/** «2026-09-11T18:06:30+03:00» → «2026-09-11 18:06» (время Бухареста, как в файле). */
function shortLocal(s: string): string {
  const m = /^(\d{4}-\d\d-\d\d)T(\d\d:\d\d)/.exec(s);
  return m ? `${m[1]} ${m[2]}` : s;
}

/**
 * Компактный вид для модели: {utc, local} → местное «гггг-мм-дд чч:мм», *_local → то же, без src;
 * personal=false — без людей (PERSONAL_KEYS).
 */
export function slim(v: Json, personal = true): Json {
  if (Array.isArray(v)) return v.map((x) => slim(x, personal));
  if (!isObj(v)) return v;
  if (typeof v.local === "string" && typeof v.utc === "string" && Object.keys(v).every((k) => k === "local" || k === "utc")) {
    return shortLocal(v.local);
  }
  const out: Obj = {};
  for (const [k, x] of Object.entries(v)) {
    if (k === "src" || k === "utc") continue;
    if (!personal && (PERSONAL_KEYS.has(k) || k.endsWith("by_character") || k.endsWith("by_person"))) continue;
    out[k] = typeof x === "string" && (k === "local" || k.endsWith("_local")) ? shortLocal(x) : slim(x, personal);
  }
  return out;
}

/** Все имена людей и персонажей из выжимки (люди, логины, прозвища, персонажи обоих миров). */
function allNames(h: Obj): string[] {
  const names = obj(h.names);
  const out = new Set<string>(Object.keys(obj(names.character_to_person)));
  for (const p of arr(names.people).filter(isObj)) {
    for (const x of [p.id, p.eblusha_user, ...arr(p.nicknames), ...arr(p.characters_koban), ...arr(p.characters_archive)]) if (typeof x === "string" && x.trim().length >= 2) out.add(x.trim());
  }
  // длинные раньше коротких: «РомаH» до «Рома»
  return [...out].sort((a, b) => b.length - a.length);
}

/** Для тех, кому личные данные не положены: имена в свободном тексте (заметки, пояснения) → «игрок». */
export function scrubNames(v: Json, names: readonly string[]): Json {
  if (typeof v === "string") return names.reduce((s, n) => (s.includes(n) ? s.split(n).join("игрок") : s), v);
  if (Array.isArray(v)) return v.map((x) => scrubNames(x, names));
  if (!isObj(v)) return v;
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [scrubNames(k, names) as string, scrubNames(x, names)]));
}

/**
 * Граница окна босса: время и основание без внутренних подробностей (имена архивов снимков, пути, чужие
 * переписки — их в ответ не несём).
 */
function boundText(b: Json | undefined): Json {
  if (!isObj(b)) return null;
  const kind = str(b.kind) ?? "";
  const why = str(b.why) ?? "";
  const when = str(b.local) ? shortLocal(b.local as string) : null;
  let basis: string;
  if (kind === "snapshot") basis = /ключа нет/.test(why) ? "снимок мира: ключа ещё нет" : "снимок мира: ключ уже есть";
  else if (kind === "external") basis = "со слов игроков в тот вечер";
  else basis = why.replace(/\s*\([^)]*[\/\:][^)]*\)/g, "").slice(0, 200);
  return { время: when, основание: basis };
}

export interface HistoryFile {
  load(): Obj | null;
}

/** Файл выжимки: перечитывается, когда сменились mtime/размер (атомарная замена — новый файл). */
export function historyFile(path: string, deps: { stat?: (p: string) => { mtimeMs: number; size: number }; read?: (p: string) => string } = {}): HistoryFile {
  const stat = deps.stat ?? ((p: string) => fs.statSync(p));
  const read = deps.read ?? ((p: string) => fs.readFileSync(p, "utf8"));
  let key = "";
  let cached: Obj | null = null;
  return {
    load(): Obj | null {
      let st: { mtimeMs: number; size: number };
      try {
        st = stat(path);
      } catch {
        cached = null;
        key = "";
        return null;
      }
      const k = `${st.mtimeMs}:${st.size}`;
      if (k === key && cached) return cached;
      try {
        const parsed: unknown = JSON.parse(read(path));
        if (!isObj(parsed) || !String(parsed.schema ?? "").startsWith("valheim-history/bot-export")) return cached;
        cached = parsed;
        key = k;
        return cached;
      } catch {
        // Полузаписанный или битый файл — остаёмся на прежнем разборе (если был).
        return cached;
      }
    },
  };
}

/** Местная дата Бухареста «гггг-мм-дд» для момента t. */
function bucharestDate(t: number): string {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Bucharest", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(t));
  return p;
}

/** «Вечер» как в летописи: местная дата Бухареста минус 6 часов. */
export function eveningOf(t: number): string {
  return bucharestDate(t - 6 * 3600_000);
}

/**
 * Дата вечера из слов: «2026-10-04», «04.10», «4.10.2026», «сегодня», «вчера», «позавчера», «последний».
 * null — не разобрали; "last" — последний вечер в данных.
 */
export function parseEveningDate(raw: string | undefined, now: Date): string | "last" | null {
  const s = (raw ?? "").trim().toLowerCase().replace(/ё/g, "е");
  if (!s || /^(последн\S*|крайн\S*|last)(\s+вечер\S*)?$/.test(s)) return "last";
  const day = 86_400_000;
  if (/^(сегодня|сегодняшн\S*|today)(\s+вечер\S*)?$/.test(s)) return eveningOf(now.getTime());
  if (/^(вчера|вчерашн\S*|yesterday)(\s+вечер\S*)?$/.test(s)) return eveningOf(now.getTime() - day);
  if (/^позавчера/.test(s)) return eveningOf(now.getTime() - 2 * day);
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return `${m[1]}-${m[2]!.padStart(2, "0")}-${m[3]!.padStart(2, "0")}`;
  m = /^(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?$/.exec(s);
  if (m) {
    const year = m[3] ? (m[3].length === 2 ? `20${m[3]}` : m[3]) : bucharestDate(now.getTime()).slice(0, 4);
    return `${year}-${m[2]!.padStart(2, "0")}-${m[1]!.padStart(2, "0")}`;
  }
  return null;
}

type Who =
  | { kind: "person"; id: string; character: string | null }
  | { kind: "ambiguous"; names: string[] }
  | { kind: "unlinked" }
  | { kind: "unknown"; people: string[]; characters: string[] };

function norm(s: string): string {
  return s.trim().toLowerCase().replace(/ё/g, "е").replace(/^[«"'“„`]+|[»"'”`]+$/g, "");
}

/** Кто это: «я», персонаж (похожие буквы, транслит, начало имени), человек Еблуши или его прозвище. */
export function resolveWho(raw: string | undefined, ctx: ToolContext, h: Obj): Who {
  const names = obj(h.names);
  const c2p = obj(names.character_to_person);
  const people = arr(names.people).filter(isObj);
  const characters = Object.keys(c2p);
  const personOfChar = (c: string): string | null => {
    const direct = str(c2p[c]);
    if (direct) return direct;
    const k = characters.find((x) => sameCharacter(x, c));
    return k ? str(c2p[k]) : null;
  };
  const q = (raw ?? "").trim();
  if (!q || SELF_RE.test(q)) {
    for (const c of ctx.requester.characters) {
      const p = personOfChar(c);
      if (p) return { kind: "person", id: p, character: null };
    }
    const me = norm(ctx.requester.displayName);
    const byName = people.find((p) => [p.id, p.eblusha_user].some((x) => typeof x === "string" && norm(x) === me));
    if (byName && typeof byName.id === "string" && ctx.requester.characters.length > 0) return { kind: "person", id: byName.id, character: null };
    return { kind: "unlinked" };
  }
  const nq = norm(q);
  // Человек Еблуши: id, логин, прозвища — точно (без учёта регистра).
  const personHit = people.filter((p) => [p.id, p.eblusha_user, ...arr(p.nicknames)].some((x) => typeof x === "string" && norm(x) === nq));
  if (personHit.length === 1 && typeof personHit[0]!.id === "string") return { kind: "person", id: personHit[0]!.id, character: null };
  // Персонаж: точно, по похожим буквам/транслиту, ≤1 правка, начало имени.
  const exact = characters.find((c) => norm(c) === nq);
  let ch: string | null = exact ?? null;
  if (!ch) {
    const m = matchCharacter(q, characters);
    if (m.kind === "exact") ch = m.character;
    else if (m.kind === "ambiguous") {
      // Разные персонажи одного человека (РомаH в Koban и Pomаh в архиве) — это не неоднозначность.
      const owners = new Set(m.candidates.map((c) => personOfChar(c)));
      if (owners.size === 1 && [...owners][0]) return { kind: "person", id: [...owners][0]!, character: m.candidates[0]! };
      return { kind: "ambiguous", names: m.candidates };
    }
  }
  ch ??= fuzzyCharacter(q, characters) ?? prefixCharacter(q, characters);
  if (ch) {
    const p = personOfChar(ch);
    if (p) return { kind: "person", id: p, character: ch };
  }
  // Прозвище/имя похожими буквами («Парасюха» → прозвище «Парасюха», «Валя» → ValenCur — нет, только явные).
  const fuzzyPeople = people.filter((p) => [p.id, p.eblusha_user, ...arr(p.nicknames)].some((x) => typeof x === "string" && sameCharacter(x, q)));
  if (fuzzyPeople.length === 1 && typeof fuzzyPeople[0]!.id === "string") return { kind: "person", id: fuzzyPeople[0]!.id, character: null };
  return {
    kind: "unknown",
    people: people.map((p) => str(p.id)).filter((x): x is string => !!x),
    characters,
  };
}

function whoError(w: Who): ToolResult | null {
  if (w.kind === "unlinked") return { content: "Спрашивающий не привязан к персонажу — не знаю, кто «я». Пусть напишет: «Еблуша, мой ник в игре …».", isError: false };
  if (w.kind === "ambiguous") return { content: `Похоже сразу на нескольких: ${w.names.map((n) => `«${n}»`).join(", ")}. Уточни, кого именно.`, untrusted: true };
  if (w.kind === "unknown")
    return {
      content: `В летописи нет такого игрока. Есть люди: ${w.people.map((n) => `«${n}»`).join(", ") || "—"}; персонажи: ${w.characters.map((n) => `«${n}»`).join(", ") || "—"}.`,
      untrusted: true,
    };
  return null;
}

/** Раздел мира: Koban — корень файла, santonoma — archive. */
function part(h: Obj, world: "koban" | "archive"): Obj {
  return world === "archive" ? obj(h.archive) : h;
}

function header(h: Obj, world: "koban" | "archive"): Obj {
  const cov = obj(h.coverage);
  const server = obj(h.server);
  return slim({
    летопись: world === "archive" ? "старый мир santonoma (архив, апрель 2026)" : `мир ${str(server.world_now) ?? "Koban"} (сейчас на сервере)`,
    выжимка_от: str(h.generated_utc) ?? null,
    мир_koban_с: (cov.koban_from as Json) ?? null,
    лог_с: (cov.log_from as Json) ?? null,
    лог_по: (cov.log_to as Json) ?? null,
    время: str(h.time_note) ?? null,
    как_отвечать: (h.how_to_answer as Json) ?? null,
    уверенность: (h.confidence_scale as Json) ?? null,
  } as Obj) as Obj;
}

function personEntry(h: Obj, world: "koban" | "archive", id: string): Obj | null {
  const list = world === "archive" ? arr(obj(h.archive).people) : arr(h.people);
  const p = list.find((x) => isObj(x) && x.id === id);
  return isObj(p) ? p : null;
}

function charactersOf(h: Obj, world: "koban" | "archive", id: string): Obj[] {
  const list = world === "archive" ? arr(obj(h.archive).characters) : arr(h.characters);
  return list.filter((c): c is Obj => isObj(c) && c.person === id);
}

function playerTopic(h: Obj, world: "koban" | "archive", w: { id: string; character: string | null }): Obj {
  const p = personEntry(h, world, w.id);
  const deaths = obj(part(h, world).deaths);
  const out: Obj = {
    человек: w.id,
    ...(w.character ? { спросили_про_персонажа: w.character } : {}),
  };
  if (!p) {
    out.нет_данных = world === "archive" ? "в старом мире santonoma этот человек не играл" : "в мире Koban этот человек не играл";
    return out;
  }
  if (world === "archive") {
    out.статистика = p;
    // «За всё время» (оба мира вместе) — только когда спросили про старый мир или всё время.
    const root = personEntry(h, "koban", w.id);
    if (root?.all_time !== undefined) out.за_всё_время_оба_мира = root.all_time;
  } else {
    out.роль = p.role ?? null;
    out.персонажи = obj(p.characters).koban ?? null;
    out.koban = obj(p.koban);
  }
  out.персонажи_подробно = charactersOf(h, world, w.id) as Json;
  const bp = obj(deaths.by_person)[w.id];
  if (bp !== undefined) out.смерти_сводка = bp;
  return out;
}

function deathsTopic(h: Obj, world: "koban" | "archive", w: { id: string; character: string | null } | null): Obj {
  const d = obj(part(h, world).deaths);
  if (!w) return { смерти: d };
  const mine = new Set(charactersOf(h, world, w.id).map((c) => str(c.name)).filter((x): x is string => !!x));
  const byChar = (x: Json): boolean => isObj(x) && typeof x.character === "string" && mine.has(x.character);
  const evenings = arr(d.deadliest_evenings).filter(isObj).map((e) => {
    const bc = obj(e.by_character);
    const n = [...mine].reduce((s, c) => s + (typeof bc[c] === "number" ? (bc[c] as number) : 0), 0);
    return { вечер: e.evening ?? null, всего: e.deaths ?? null, его: n } as Obj;
  });
  return {
    человек: w.id,
    ...(w.character ? { спросили_про_персонажа: w.character } : {}),
    его_персонажи: [...mine],
    сводка: obj(d.by_person)[w.id] ?? null,
    по_персонажам: Object.fromEntries(charactersOf(h, world, w.id).map((c) => [str(c.name) ?? "?", c.deaths ?? null])),
    по_месяцам: Object.fromEntries(Object.entries(obj(d.by_month_by_character)).map(([m, v]) => [m, Object.fromEntries(Object.entries(obj(v)).filter(([c]) => mine.has(c)))])),
    самые_смертельные_вечера: evenings,
    серии: arr(d.longest_series).filter(byChar),
    известные_места: arr(d.known_places).filter(byChar),
    всего_на_сервере: d.total ?? null,
    как_считали: d.method ?? null,
    conf: d.conf ?? null,
    conf_note: d.conf_note ?? null,
  };
}

function overlaps(win: Json | undefined, day: string): boolean {
  const w = obj(win);
  const from = str(obj(w.from).utc);
  const to = str(obj(w.to).utc);
  if (!from || !to) return false;
  return eveningOf(Date.parse(from)) <= day && day <= eveningOf(Date.parse(to));
}

function eveningTopic(h: Obj, world: "koban" | "archive", date: string | "last" | null, raw: string | undefined): Obj {
  const p = part(h, world);
  const list = arr(p.evenings).filter(isObj);
  const dates = list.map((e) => str(e.date)).filter((x): x is string => !!x).sort();
  if (date === null) return { не_понял_дату: raw ?? "", вечера_есть: dates.slice(-12) };
  const want = date === "last" ? dates[dates.length - 1] ?? null : date;
  const ev = list.find((e) => e.date === want);
  if (!ev) {
    return {
      вечер: want,
      нет_данных: "в этот вечер на сервере никто не играл (или он вне летописи)",
      ближайшие_вечера: dates.filter((d) => !want || Math.abs(Date.parse(d) - Date.parse(want)) <= 7 * 86_400_000).slice(-10),
      последние_вечера: dates.slice(-5),
    };
  }
  const raids = arr(obj(p.raids).list).filter((r) => isObj(r) && typeof obj(r.start).utc === "string" && eveningOf(Date.parse(obj(r.start).utc as string)) === want);
  const bosses = arr(p.bosses).filter((b) => isObj(b) && overlaps(b.window_with_players, want!));
  const keys = arr(p.other_world_keys).filter((b) => isObj(b) && overlaps(b.window_with_players, want!));
  const deadly = arr(obj(p.deaths).deadliest_evenings).find((e) => isObj(e) && e.evening === want) ?? null;
  const people = (world === "archive" ? arr(p.people) : arr(h.people)).filter(isObj);
  const perPerson: Obj = {};
  for (const pe of people) {
    const rows = arr(world === "archive" ? pe.evening_list : obj(pe.koban).evening_list);
    const row = rows.find((r) => Array.isArray(r) && r[0] === want);
    if (Array.isArray(row) && typeof pe.id === "string") {
      perPerson[pe.id] = { часы: row[1] ?? null, вошёл: row[2] ?? null, вышел: row[3] ?? null, сессий: row[4] ?? null, персонажи: row[5] ?? null };
    }
  }
  return {
    вечер: ev,
    по_людям: perPerson,
    набеги: raids,
    ...(deadly ? { смерти_вечера: deadly } : {}),
    боссы_в_окне: bosses.map((b) => ({ босс: obj(b).boss_ru ?? null, окно: obj(b).window_with_players ?? null, conf: obj(b).conf ?? null })),
    ключи_мира_в_окне: keys.map((b) => ({ что: obj(b).what_ru ?? null, окно: obj(b).window_with_players ?? null, conf: obj(b).conf ?? null })),
    соседние_вечера: dates.filter((d) => Math.abs(Date.parse(d) - Date.parse(want!)) <= 3 * 86_400_000 && d !== want),
  };
}

function worldTopic(h: Obj, world: "koban" | "archive", personal: boolean): Obj {
  const p = part(h, world);
  if (world === "archive") {
    return {
      о_разделе: p.about ?? null,
      мир: p.world ?? null,
      итоги: p.overall ?? null,
      постройки: p.builds ?? null,
      ...(personal ? { активность: p.activity ?? null } : {}),
      сервер: p.server_history ?? null,
      ключи_мира: p.other_world_keys ?? null,
    };
  }
  const w = obj(h.world);
  const edits = arr(w.site_key_edits);
  const builds = obj(h.builds);
  const raids = obj(h.raids);
  return {
    сервер: h.server ?? null,
    мир: {
      ...Object.fromEntries(Object.entries(w).filter(([k]) => k !== "site_key_edits" && k !== "days_by_local_date")),
      дни_по_датам_последние: arr(w.days_by_local_date).slice(-7),
      правки_ключей_с_сайта: { всего: edits.length, последние: edits.slice(-3), note: w.site_key_edits_note ?? null },
    },
    итоги: h.overall ?? null,
    разведка: h.exploration ?? null,
    постройки: { сейчас: builds.koban_latest ?? null, рост: arr(builds.koban_growth).slice(-3), базы: arr(builds.bases_top).slice(0, 3), note: builds.note ?? null, conf: builds.conf ?? null },
    набеги: { всего: arr(raids.list).length, по_месяцам: raids.by_month ?? null, последние: arr(raids.list).slice(-3), note: raids.note ?? null, conf: raids.conf ?? null },
    ...(personal ? { активность: h.activity ?? null } : {}),
    сервер_история: { ...obj(h.server_history), game_versions: arr(obj(h.server_history).game_versions).slice(-3) },
    ключи_мира: "квесты и прочие ключи мира — topic bosses",
  };
}

function bossesTopic(h: Obj, world: "koban" | "archive"): Obj {
  const p = part(h, world);
  return {
    боссы: arr(p.bosses).filter(isObj).map((b) => ({
      босс: b.boss_ru ?? null,
      статус: b.status ?? null,
      окно_с_игроками: b.window_with_players ?? null,
      дни_мира: b.world_days ?? null,
      online_in_window: b.online_in_window ?? null,
      не_раньше: boundText(b.lower_bound),
      не_позже: boundText(b.upper_bound),
      кто_добил: b.who_landed_the_blow ?? null,
      death_clusters_hint: arr(b.death_clusters_hint).slice(0, 2),
      conf: b.conf ?? null,
      conf_note: b.conf_note ?? null,
    })),
    другие_ключи_мира: p.other_world_keys ?? null,
  };
}

function factsTopic(h: Obj, world: "koban" | "archive"): Obj {
  const p = part(h, world);
  return {
    факты: arr(p.facts).filter(isObj).map((f) => ({ id: f.id ?? null, text: f.text ?? null, conf: f.conf ?? null, ...(f.conf_note ? { conf_note: f.conf_note } : {}) })),
    итоги: p.overall ?? null,
    чего_нет_в_данных: h.limits ?? null,
  };
}

function finish(h: Obj, head: Obj, body: Obj, personal: boolean): ToolResult {
  let out: Json = { ...head, ...(slim(body, personal) as Obj) };
  if (!personal) out = scrubNames(out, allNames(h));
  let s = JSON.stringify(out);
  if (s.length > HISTORY_MAX_CHARS) s = `${s.slice(0, HISTORY_MAX_CHARS)}… [обрезано: уточни вопрос — кто, какой вечер]`;
  return { content: s, untrusted: true };
}

export interface HistoryToolDeps {
  file: HistoryFile;
}

export const HISTORY_SYSTEM_PROMPT = `### Летопись сервера (valheim_history)
Вопросы о ПРОШЛОМ на сервере — сколько кто наиграл, кто чаще умирает, что было в такой-то вечер, когда убили босса, рекорды, серии, кто больше строил, «итоги месяца» — инструмент valheim_history (topic: player — человек или персонаж, who; deaths — смерти, можно с who; evening — вечер, date: «2026-10-04», «04.10», «вчера», пусто — последний; bosses; world — мир, постройки, набеги, сервер; facts — готовые факты). Это выжимка из логов, она обновляется раз в сутки ночью: свежее, чем «выжимка_от», в ней нет — про сейчас спрашивай живые инструменты valheim_*. По умолчанию — нынешний мир Koban; старый мир santonoma (апрель) — world: "archive", только если спросили про апрель, старый мир или «за всё время». Время в летописи — по Бухаресту; «вечер» — дата входа минус 6 часов. У чисел есть conf: high — говори уверенно, medium и low — как предположение, с оговоркой. Чего в данных нет (рюкзаки, навыки, кто добил босса, причина смерти, чат) — так и говори, не выдумывай.`;

export function createHistoryTool(deps: HistoryToolDeps): BotTool<HistoryInput> {
  return {
    name: "valheim_history",
    description:
      "Valheim, сервер Koban: летопись за всё время — сессии и часы людей, вечера, смерти (серии, рекорды, места), боссы (окна, кто был онлайн), мир (дни, модификаторы, постройки, набеги, перезапуски), готовые факты. topic: player | deaths (who — человек или персонаж; пусто или «я» — спрашивающий) | evening (date: гггг-мм-дд, дд.мм, «вчера», пусто — последний вечер) | bosses | world | facts. world: koban (по умолчанию) или archive — старый мир santonoma (апрель), только если спросили. Вызывай на вопросы о прошлом: «сколько я наиграл», «кто чаще всех умирает», «что было вчера в вальхейме», «когда убили Старейшину», «кто больше всех строил». Данные обновляются раз в сутки; про то, что происходит сейчас, — другие инструменты.",
    access: "anyone",
    inputSchema: {
      type: "object",
      properties: {
        topic: { type: "string", enum: [...HISTORY_TOPICS] },
        who: { type: "string", description: "Человек или персонаж, как назвали; «я» или пусто — спрашивающий" },
        date: { type: "string", description: "Вечер: 2026-10-04, 04.10, «вчера», «сегодня»; пусто — последний" },
        world: { type: "string", enum: ["koban", "archive"], description: "archive — только если спросили про старый мир / апрель" },
      },
      required: ["topic"],
      additionalProperties: false,
    },
    async run(input, ctx) {
      const h = deps.file.load();
      if (!h) return { content: "Летопись сервера сейчас недоступна (нет файла выжимки) — ответить по истории не могу.", isError: true };
      const world = input.world === "archive" ? "archive" : "koban";
      const personal = playerDataVisible(ctx);
      if (!personal && input.topic !== "world" && input.topic !== "bosses") {
        return accessDeniedText("player", ctx.requester);
      }
      const head = header(h, world);
      switch (input.topic) {
        case "player": {
          const w = resolveWho(input.who, ctx, h);
          const err = whoError(w);
          if (err) return err;
          return finish(h, head, playerTopic(h, world, w as { id: string; character: string | null }), true);
        }
        case "deaths": {
          if (!input.who || !input.who.trim()) return finish(h, head, deathsTopic(h, world, null), true);
          const w = resolveWho(input.who, ctx, h);
          const err = whoError(w);
          if (err) return err;
          return finish(h, head, deathsTopic(h, world, w as { id: string; character: string | null }), true);
        }
        case "evening":
          return finish(h, head, eveningTopic(h, world, parseEveningDate(input.date, ctx.now), input.date), true);
        case "world":
          return finish(h, head, worldTopic(h, world, personal), personal);
        case "bosses":
          return finish(h, head, bossesTopic(h, world), personal);
        case "facts":
          return finish(h, head, factsTopic(h, world), true);
      }
      return { content: "Неизвестная тема летописи.", isError: true };
    },
  };
}
