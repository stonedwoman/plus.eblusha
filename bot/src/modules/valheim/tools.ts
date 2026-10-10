/**
 * Инструменты модели для Valheim. ТОЛЬКО ЧТЕНИЕ: ни один не меняет сервер.
 *
 * Приватность — здесь, в коде, а не в просьбах к модели:
 *   - данные игроков (где кто, экипировка, склады, порталы, карточка карты) — access "player":
 *     ядро пускает только привязанных к персонажу и владельца;
 *   - «кто в игре» доступен всем, но непривязанным — только число (и в группе, где есть
 *     непривязанные: ответ увидят все — ChatInfo.playerDataOk);
 *   - игрок, снявший в игре галочку «показывать на карте» (hidden), — «место скрыто»
 *     и на карточке не рисуется (себя самого видно);
 *   - имена, метки порталов, надписи табличек пишут игроки → результат untrusted.
 */
import type { BotTool, ToolContext, ToolResult } from "../api";
import { fuzzyCharacter, matchCharacter, sameCharacter, skeletons } from "../../core/nick";
import { GROUP_AUDIENCE_TEXT, playerDataVisible } from "../../core/registry";
import { VhUnavailable } from "./client";
import type { ValheimConfig } from "./config";
import { evaluateGear, gearReport } from "./gear";
import { describeNear, dist, facing, fmtDist, fmtDuration, sideOf, type Pt } from "./geo";
import { baseAt, homeBases, type Base } from "./home";
import { BOSS_ALTAR, BOSS_ORDER, biomeRu, classifyLocation, plainLabel, SHIP_PREFABS } from "./names";
import { playerColors, renderCard, ruPlural, type CardMarker } from "./render";
import { matchItems } from "./search";
import type { MapStructure, MapTime, ModContainer } from "./types";
import type { VhPlayer, VhWorld } from "./world";

const SELF_RE = /^(?:я|меня|мне|мной|себя|сам|сама|мой|мой\s+персонаж|мой\s+перс|me|myself|self)$/i;

export type ResolvedPlayer =
  | { kind: "online"; player: VhPlayer; self: boolean }
  | { kind: "offline"; name: string; self: boolean }
  | { kind: "ambiguous"; names: string[] }
  | { kind: "unlinked" }
  | { kind: "unknown"; online: string[] };

export function isOwnCharacter(ctx: ToolContext, name: string): boolean {
  return ctx.requester.characters.some((c) => c === name || sameCharacter(c, name));
}

/** Кого имели в виду: «я», точное имя, похожая запись (IiApaCiOxa = Парасюха), известный оффлайн. */
export function resolvePlayer(input: string, ctx: ToolContext, online: VhPlayer[], known: string[]): ResolvedPlayer {
  const q = input.trim().replace(/^[«"']+|[»"']+$/g, "");
  if (!q || SELF_RE.test(q)) {
    const mine = ctx.requester.characters;
    if (!mine.length) return { kind: "unlinked" };
    const on = online.find((p) => mine.some((c) => c === p.name || sameCharacter(c, p.name)));
    return on ? { kind: "online", player: on, self: true } : { kind: "offline", name: mine[0]!, self: true };
  }
  const names = online.map((p) => p.name);
  const exact = online.find((p) => p.name.toLowerCase() === q.toLowerCase());
  if (exact) return { kind: "online", player: exact, self: isOwnCharacter(ctx, exact.name) };
  const m = matchCharacter(q, names);
  if (m.kind === "exact") {
    const p = online.find((x) => x.name === m.character)!;
    return { kind: "online", player: p, self: isOwnCharacter(ctx, p.name) };
  }
  if (m.kind === "ambiguous") return { kind: "ambiguous", names: m.candidates };
  const fz = fuzzyCharacter(q, names) ?? prefixCharacter(q, names);
  if (fz) {
    const p = online.find((x) => x.name === fz)!;
    return { kind: "online", player: p, self: isOwnCharacter(ctx, p.name) };
  }
  const k = known.find((n) => n.toLowerCase() === q.toLowerCase()) ?? (() => {
    const r = matchCharacter(q, known);
    return r.kind === "exact" ? r.character : fuzzyCharacter(q, known) ?? prefixCharacter(q, known);
  })();
  if (k) return { kind: "offline", name: k, self: isOwnCharacter(ctx, k) };
  return { kind: "unknown", online: names };
}

/** «Рома» → «РомаH»: начало имени (≥3 букв, не короче имени больше чем на 2), если такой один. */
export function prefixCharacter(input: string, names: string[]): string | null {
  const mine = skeletons(input).filter((s) => s.length >= 3);
  if (!mine.length) return null;
  const hits = names.filter((n) => skeletons(n).some((full) => mine.some((s) => full.startsWith(s) && full.length - s.length <= 2)));
  return hits.length === 1 ? hits[0]! : null;
}

function resolveError(r: ResolvedPlayer): ToolResult | null {
  if (r.kind === "unlinked") return { content: "Спрашивающий не привязан к персонажу — не знаю, кто «я». Пусть напишет: «Еблуша, мой ник в игре …».", isError: false };
  if (r.kind === "ambiguous") return { content: `Похоже сразу на нескольких: ${r.names.map((n) => `«${n}»`).join(", ")}. Уточни, кого именно.`, untrusted: true };
  if (r.kind === "unknown")
    return {
      content: `Такого персонажа сервер не знает. Сейчас в игре: ${r.online.length ? r.online.map((n) => `«${n}»`).join(", ") : "никого"}. Можно спросить по имени персонажа как в игре.`,
      untrusted: true,
    };
  return null;
}

function canSee(p: VhPlayer, ctx: ToolContext): boolean {
  return !p.hidden || isOwnCharacter(ctx, p.name);
}

function pct(a: number | null, b: number | null): string {
  if (a === null || b === null || b <= 0) return "?";
  return `${Math.round((100 * Math.max(0, a)) / b)}%`;
}

function healthText(p: VhPlayer): string {
  if (p.dead) return "мёртв (ждёт возрождения)";
  const parts = [`здоровье ${Math.round(p.health ?? 0)} из ${Math.round(p.maxHealth ?? 0)} (${pct(p.health, p.maxHealth)})`];
  if (p.stamina !== null) parts.push(`стамина ${Math.round(p.stamina)}`);
  if (p.eitr !== null && p.eitr > 0) parts.push(`эйтр ${Math.round(p.eitr)}`);
  return parts.join(", ");
}

/** «06:04» из доли суток (smoothFraction: 0 — полночь). */
export function clockText(t: MapTime): string {
  const f = ((t.smoothFraction % 1) + 1) % 1;
  const mins = Math.floor(f * 24 * 60);
  return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
}

function timeLine(t: MapTime | null): string {
  if (!t) return "Часы мира: нет данных.";
  const bits = [`День ${t.day}, ${clockText(t)} (${t.phase})`];
  if (!t.running) bits.push("время в мире стоит — на сервере никого");
  else if (t.canSleep) bits.push(`спать уже можно, до утра ${fmtDuration(t.secondsToMorning)} реального времени`);
  else bits.push(`спать можно через ${fmtDuration(t.secondsToSleep)} реального времени`);
  return `${bits.join("; ")}.`;
}

/** Время из join-json: местное бухарестское без пояса → Date. */
export function bucharestLocal(s: string): Date | null {
  const m = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)/.exec(s);
  if (!m) return null;
  const asUtc = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!);
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Bucharest", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(asUtc));
  const g = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const shown = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second"));
  return new Date(asUtc - (shown - asUtc));
}

function fmtWhen(d: Date, tz: string, now: Date): string {
  const sameDay = d.toDateString() === now.toDateString();
  const f = new Intl.DateTimeFormat("ru-RU", { timeZone: tz, ...(sameDay ? {} : { day: "numeric", month: "long" }), hour: "2-digit", minute: "2-digit" }).format(d);
  return sameDay ? `сегодня в ${f}` : f;
}

function sourceNote(source: "mod" | "map"): string {
  return source === "map" ? "\n(Данные карты: мод для бота на сервере ещё не обновлён — без высоты, точного биома, подземелий и экипировки.)" : "";
}

function unavailable(e: unknown): ToolResult {
  if (e instanceof VhUnavailable) return { content: `Нет данных: ${e.message}.`, isError: true };
  throw e;
}

const SCALE_M: Record<string, number> = { near: 300, area: 900, region: 2500 };

export function createTools(world: VhWorld, cfg: ValheimConfig): BotTool<any>[] {
  const mapLink = cfg.publicMapUrl;

  const playersOnline: BotTool<Record<string, never>> = {
    name: "valheim_players_online",
    description:
      "Valheim, сервер Koban: кто сейчас в игре (персонажи, сколько играют, где примерно, биом, здоровье) и время в мире. Вызывай на «кто в игре», «кто онлайн», «играет кто-нибудь в вальхейм». Непривязанным к персонажу людям показывает только число игроков.",
    access: "anyone",
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
    async run(_i, ctx) {
      let snap;
      try {
        snap = await world.players(ctx.signal);
      } catch (e) {
        return unavailable(e);
      }
      const t = await world.time(ctx.signal).catch(() => null);
      const n = snap.players.length;
      if (!playerDataVisible(ctx)) {
        return ctx.requester.isPlayer
          ? `В игре сейчас: ${n}. ${timeLine(t)}\nКто именно и где — не скажу здесь: ${GROUP_AUDIENCE_TEXT.charAt(0).toLowerCase()}${GROUP_AUDIENCE_TEXT.slice(1)}`
          : `В игре сейчас: ${n}. ${timeLine(t)}\nИмена и места видят только игроки сервера — пусть привяжет ник: «Еблуша, мой ник в игре …».`;
      }
      if (!n) return `Сейчас на сервере никого. ${timeLine(t)}`;
      const lines = [`В игре ${n}:`];
      for (const p of snap.players) {
        const bits: string[] = [];
        if (!p.loaded) bits.push("заходит (персонаж ещё грузится)");
        else if (!canSee(p, ctx)) bits.push("место скрыто (игрок скрылся с карты)");
        else {
          const place = await world.placeOf({ x: p.x!, z: p.z!, y: p.y }, ctx.signal);
          bits.push(place.text);
          const b = p.biomeRu ?? (place.biomeGuess ? `похоже, ${place.biomeGuess}` : null);
          if (b) bits.push(b);
          if (p.dungeon && p.location) bits.push(`в подземелье (${classifyLocation(p.location)?.ru ?? p.location})`);
        }
        bits.push(p.dead ? "мёртв" : `здоровье ${pct(p.health, p.maxHealth)}`);
        if (p.inBed) bits.push("спит");
        if (p.pvp) bits.push("PvP");
        if (p.sessionSec !== null) bits.push(`в игре ${fmtDuration(p.sessionSec)}`);
        lines.push(`- «${p.name}»: ${bits.join(", ")}`);
      }
      lines.push(timeLine(t));
      return { content: lines.join("\n") + sourceNote(snap.source), untrusted: true };
    },
  };

  const whereIs: BotTool<{ player: string }> = {
    name: "valheim_where_is",
    description:
      "Valheim, сервер Koban: где игрок — место словами (у какого портала/базы/локации, сколько метров и в какую сторону), биом, в подземелье ли, куда смотрит, здоровье, жив ли, далеко ли от дома; для ушедших — когда был в последний раз. Ещё показывает его могилы, если есть. Вызывай на «где Куралеска?», «где я?», «далеко ли я от дома», «где моя могила».",
    access: "player",
    inputSchema: {
      type: "object",
      properties: { player: { type: "string", description: "Имя персонажа как в игре или как его называют («Парасюха» = «IiApaCiOxa»); «я» — спрашивающий." } },
      required: ["player"],
      additionalProperties: false,
    },
    async run(input, ctx) {
      let snap;
      try {
        snap = await world.players(ctx.signal);
      } catch (e) {
        return unavailable(e);
      }
      const known = await world.knownCharacters(ctx.signal).catch(() => [] as string[]);
      const r = resolvePlayer(input.player, ctx, snap.players, known);
      const err = resolveError(r);
      if (err) return err;
      const graves = await tombstonesOf(world, r.kind === "online" ? r.player.name : r.kind === "offline" ? r.name : "", ctx);
      if (r.kind === "offline") {
        const join = await world.joinInfo(ctx.signal);
        const rec = join?.recentPlayers?.find((p) => p.name === r.name || sameCharacter(p.name, r.name));
        const seen = rec?.sessionEndedAt ?? rec?.lastSeen ?? null;
        const when = seen ? bucharestLocal(seen) : null;
        const lines = [`«${r.name}» сейчас не в игре.${when ? ` Последний раз заходил(а) ${fmtWhen(when, cfg.timeZone, ctx.now)} (${cfg.timeZone}).` : ""}`];
        if (graves) lines.push(graves);
        return { content: lines.join("\n"), untrusted: true };
      }
      if (r.kind !== "online") return "Нет данных.";
      const p = r.player;
      const lines = [`«${p.name}» в игре${p.sessionSec !== null ? ` ${fmtDuration(p.sessionSec)}` : ""}.`];
      if (!p.loaded) {
        lines.push("Персонаж ещё загружается — координат пока нет.");
        return { content: lines.join("\n"), untrusted: true };
      }
      if (!canSee(p, ctx)) {
        lines.push("Место скрыто: игрок снял в игре галочку «показывать на карте». Где он, я не говорю.");
        lines.push(`Состояние: ${healthText(p)}.`);
        return { content: lines.join("\n"), untrusted: true };
      }
      const place = await world.placeOf({ x: p.x!, z: p.z!, y: p.y }, ctx.signal);
      lines.push(`Место: ${place.text}.`);
      if (p.dungeon) lines.push(`В подземелье${p.location ? `: ${classifyLocation(p.location)?.ru ?? p.location}` : ""}.`);
      lines.push(`Биом: ${p.biomeRu ?? (place.biomeGuess ? `похоже, ${place.biomeGuess} (по ближайшей локации)` : "неизвестен")}.`);
      if (p.yaw !== null && !p.dead) lines.push(`Смотрит ${facing(p.yaw)} (поворот тела, не камеры).`);
      lines.push(`Состояние: ${healthText(p)}${p.inBed ? ", лежит в кровати" : ""}${p.pvp ? ", включён PvP" : ""}.`);
      const bases = await world.bases(ctx.signal).catch(() => [] as Base[]);
      const main = bases.find((b) => b.isMain);
      if (main && !place.base?.isMain) lines.push(`До главного дома: ${fmtDist(dist({ x: p.x!, z: p.z! }, main))}, дом ${sideOf({ x: p.x!, z: p.z! }, main)}.`);
      if (p.y !== null && !p.dungeon) lines.push(`Высота: ${Math.round(p.y)} м.`);
      lines.push(`Координаты: x ${Math.round(p.x!)}, z ${Math.round(p.z!)}.`);
      if (graves) lines.push(graves);
      lines.push(`Живая карта: ${mapLink}`);
      return { content: lines.join("\n") + sourceNote(snap.source), untrusted: true };
    },
  };

  const playerGear: BotTool<{ player: string }> = {
    name: "valheim_player_gear",
    description:
      "Valheim, сервер Koban: что надето на игроке (шлем, грудь, ноги, плащ, пояс, безделушка, оружие и щит в руках и за спиной) и оценка «последний ли комплект брони» с учётом убитых боссов и тиров брони; что лучшее уже доступно. Вызывай на «последний ли у меня комплект брони?», «во что одет Рома», «чем он бьёт», «что крафтить дальше из брони». Личный инвентарь серверу не виден.",
    access: "player",
    inputSchema: {
      type: "object",
      properties: { player: { type: "string", description: "Имя персонажа как в игре или «я» — спрашивающий." } },
      required: ["player"],
      additionalProperties: false,
    },
    async run(input, ctx) {
      if (!(await world.modReady(ctx.signal))) {
        return { content: "Экипировку серверу отдаёт только обновлённый мод карты, а он на сервере ещё не выложен (или мир перезапускается). Пока не знаю, что надето.", isError: false };
      }
      let snap;
      try {
        snap = await world.players(ctx.signal);
      } catch (e) {
        return unavailable(e);
      }
      const known = await world.knownCharacters(ctx.signal).catch(() => [] as string[]);
      const r = resolvePlayer(input.player, ctx, snap.players, known);
      const err = resolveError(r);
      if (err) return err;
      if (r.kind === "offline") return { content: `«${r.name}» сейчас не в игре, а надетое сервер видит только у тех, кто в игре.`, untrusted: true };
      if (r.kind !== "online") return "Нет данных.";
      const p = r.player;
      if (!p.equipment) return { content: `Про «${p.name}» сервер пока не прислал экипировку (персонаж грузится).`, untrusted: true };
      const [bosses, catalog] = await Promise.all([world.bosses(ctx.signal).catch(() => []), world.catalog(ctx.signal)]);
      const verdict = evaluateGear(p.equipment, bosses, catalog);
      return { content: gearReport(p.name, verdict), untrusted: true };
    },
  };

  const findItems: BotTool<{ query: string; area: "home" | "all" }> = {
    name: "valheim_find_items",
    description:
      "Valheim, сервер Koban: что лежит в сундуках, повозках и кораблях игроков — где лежит нужная вещь и сколько её. area=\"home\" — только дома (главная база и базы с кроватями или меткой «дом»), \"all\" — везде. Вызывай на «есть ли у нас дома семена репы?», «где лежит железо», «сколько у нас серебра», «в каком сундуке мед». Рюкзаки игроков серверу не видны.",
    access: "player",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Что искать, по-русски или по-английски, как в игре: «семена репы», «железо», «Silver». Несколько вещей — через запятую." },
        area: { type: "string", enum: ["home", "all"], description: "home — дома; all — во всех сундуках мира." },
      },
      required: ["query", "area"],
      additionalProperties: false,
    },
    async run(input, ctx) {
      if (!(await world.modReady(ctx.signal))) {
        return { content: "Сундуки серверу отдаёт только обновлённый мод карты, а он на сервере ещё не выложен (или мир перезапускается). Пока не вижу, что где лежит.", isError: false };
      }
      const catalog = await world.catalog(ctx.signal);
      const queries = input.query.split(/[,;]|\s+и\s+/).map((s) => s.trim()).filter(Boolean).slice(0, 5);
      const prefabs = new Set<string>();
      const matchedNames: string[] = [];
      const raw: string[] = [];
      for (const q of queries) {
        if (catalog) {
          const hits = matchItems(q, [...catalog.values()], 6);
          if (hits.length) {
            const top = hits[0]!.score;
            for (const h of hits.filter((x) => x.score >= top - 12)) {
              prefabs.add(h.item.p);
              matchedNames.push(`${h.item.ru ?? h.item.p} (${h.item.p})`);
            }
            continue;
          }
        }
        raw.push(q);
      }
      if (!prefabs.size && !raw.length) return `Не понял, что искать: «${input.query}».`;
      let res;
      try {
        res = await world.containers({ item: [...prefabs, ...raw].join(","), kind: "chest,ship,cart", limit: "5000" }, ctx.signal);
      } catch (e) {
        return unavailable(e);
      }
      const bases = await world.bases(ctx.signal).catch(() => [] as Base[]);
      const homes = new Set(homeBases(bases).map((b) => b.id));
      const marks = (await world.landmarks(ctx.signal).catch(() => ({ marks: [], bases: [] }))).marks.filter((m) => m.kind !== "home");
      // Мод ищет подстрокой: «DragonEgg» найдёт и «DragonEggShell…». Префабы из справочника — только точно.
      const rawLower = raw.map((r) => r.toLowerCase());
      const keep = (i: { p: string; ru?: string | undefined; en?: string | undefined }) =>
        prefabs.has(i.p) || rawLower.some((q) => i.p.toLowerCase().includes(q) || (i.ru ?? "").toLowerCase().includes(q) || (i.en ?? "").toLowerCase().includes(q));
      const found = res.containers.map((c) => ({ ...c, items: c.items.filter(keep) })).filter((c) => c.items.length > 0);
      const withBase = found.map((c) => ({ c, base: baseAt(c, bases) }));
      const inScope = input.area === "home" ? withBase.filter((x) => x.base && homes.has(x.base.id)) : withBase;
      const outside = input.area === "home" ? withBase.filter((x) => !(x.base && homes.has(x.base.id))) : [];

      const lines: string[] = [];
      lines.push(`Искал: ${matchedNames.length ? matchedNames.join(", ") : ""}${raw.length ? `${matchedNames.length ? "; " : ""}по словам «${raw.join("», «")}»` : ""}.`);
      const homeNames = homeBases(bases).map((b) => b.name);
      if (input.area === "home") lines.push(`Где искал: дома — ${homeNames.length ? homeNames.join("; ") : "дом не найден (нет кроватей и станков)"}.`);
      const sum = (list: typeof withBase) => {
        const m = new Map<string, { ru: string; n: number; chests: number }>();
        for (const { c } of list) {
          for (const it of c.items) {
            const e = m.get(it.p) ?? { ru: it.ru ?? it.p, n: 0, chests: 0 };
            e.n += it.n;
            e.chests++;
            m.set(it.p, e);
          }
        }
        return [...m.values()];
      };
      const totals = sum(inScope);
      if (!totals.length) lines.push(input.area === "home" ? "Дома в сундуках этого нет." : "Ни в одном сундуке этого нет.");
      else lines.push(`Итого${input.area === "home" ? " дома" : ""}: ${totals.map((t) => `${t.ru} — ${t.n} шт. (${t.chests} ${ruPlural(t.chests, ["сундук", "сундука", "сундуков"])})`).join("; ")}.`);
      const sorted = inScope.sort((a, b) => sumItems(b.c) - sumItems(a.c)).slice(0, 12);
      for (const { c, base } of sorted) {
        const where = base ? `${base.name}${nearestPortal(c, marks)}` : describeNear(c, marks).text;
        const who = [c.label ? `табличка «${plainLabel(c.label)}»` : null, c.creator ? `ставил(а) ${c.creator}` : null].filter(Boolean).join(", ");
        lines.push(`- ${c.name ?? c.prefab}${who ? ` (${who})` : ""}, ${where}${c.dungeon ? ", в подземелье" : ""}: ${c.items.map((i) => `${i.ru ?? i.p} ×${i.n}${i.q && i.q > 1 ? ` (ур. ${i.q})` : ""}`).join(", ")}`);
      }
      if (inScope.length > sorted.length) lines.push(`…и ещё в ${inScope.length - sorted.length} местах.`);
      if (outside.length) {
        const o = sum(outside);
        lines.push(`Не дома: ${o.map((t) => `${t.ru} — ${t.n} шт.`).join("; ")} (${outside.length} ${ruPlural(outside.length, ["место", "места", "мест"])}; спроси с area=all, чтобы узнать где).`);
      }
      lines.push(`Склады сервер пересматривает раз в 30 с (последний раз: ${res.scannedAt ? fmtWhen(new Date(res.scannedAt), cfg.timeZone, ctx.now) : "?"}). Что в рюкзаках у игроков — серверу не видно.`);
      return { content: lines.join("\n"), untrusted: true };
    },
  };

  const bossesProgress: BotTool<Record<string, never>> = {
    name: "valheim_bosses_progress",
    description:
      "Valheim, сервер Koban: каких боссов уже убили, кто следующий по порядку и найден ли (разведан ли) его алтарь — без координат неразведанного. Вызывай на «кого бить следующим», «каких боссов убили», «убили ли Королеву».",
    access: "anyone",
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
    async run(_i, ctx) {
      let bosses;
      try {
        bosses = await world.bosses(ctx.signal);
      } catch (e) {
        return unavailable(e);
      }
      const done = new Set(bosses.filter((b) => b.d === 1 && b.k).map((b) => b.k));
      const lines = ["Боссы по порядку:"];
      for (const b of BOSS_ORDER) lines.push(`- ${b.ru} (${biomeRu(b.biome) ?? b.biome}): ${done.has(b.key) ? "убит" : "не убит"}`);
      const next = BOSS_ORDER.find((b) => !done.has(b.key));
      if (next) {
        let altar = "неизвестно";
        try {
          const [locs, fog, cfgMap] = await Promise.all([world.locations(ctx.signal), world.fog(ctx.signal), world.config(ctx.signal)]);
          const re = BOSS_ALTAR[next.key];
          const spots = re ? locs.filter((l) => re.test(l.n)) : [];
          const explored = spots.filter((l) => world.explored(fog, cfgMap, l));
          altar = explored.length ? `найден — разведано мест: ${explored.length} (на карте отмечены)` : spots.some((l) => l.p === 1) ? "ещё не найден (есть в мире, но там никто не был)" : "ещё не найден";
        } catch {
          /* без локаций */
        }
        lines.push(`Следующий: ${next.ru}. Алтарь/логово: ${altar}.`);
      } else lines.push("Все боссы убиты.");
      lines.push("Келл засчитывается только после третьей фазы.");
      const st = await world.state(ctx.signal);
      if (st?.raid) lines.push(`Сейчас идёт набег: ${st.raid.ru ?? st.raid.name}.`);
      return lines.join("\n");
    },
  };

  const worldTime: BotTool<Record<string, never>> = {
    name: "valheim_world_time",
    description:
      "Valheim, сервер Koban: день и время в мире, можно ли спать и сколько ждать, идёт ли набег, спят ли игроки, сколько человек в игре и код для входа (join-код). Вызывай на «который час в вальхейме», «можно спать?», «какой код сервера», «сколько до ночи».",
    access: "anyone",
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
    async run(_i, ctx) {
      let t;
      try {
        t = await world.time(ctx.signal);
      } catch (e) {
        return unavailable(e);
      }
      const lines = [timeLine(t), `В игре: ${t.players}.`];
      if (!t.canSleep && t.running) lines.push(`Ночь наступит через ~${fmtDuration(t.secondsToSleep)} реального времени (сутки в игре — ${Math.round(t.dayLengthSec / 60)} мин).`);
      const st = await world.state(ctx.signal);
      if (st?.raid) lines.push(`Идёт набег: ${st.raid.ru ?? st.raid.name}.`);
      if (st?.sleeping) lines.push("Сейчас все спят — ночь проматывается.");
      const join = await world.joinInfo(ctx.signal);
      if (join?.code) lines.push(`Код для входа (join-код): ${join.code}. Страница сервера: https://koban.uk/v/`);
      return lines.join("\n");
    },
  };

  const portals: BotTool<{ near: string }> = {
    name: "valheim_portals",
    description:
      "Valheim, сервер Koban: порталы с метками — какие метки есть, у каких есть пара, где стоят (словами) и как далеко от игрока или от дома. Вызывай на «какие у нас порталы», «есть ли портал к болоту», «ближайший портал ко мне», «как добраться до Ромы».",
    access: "player",
    inputSchema: {
      type: "object",
      properties: { near: { type: "string", description: "От кого считать расстояние: имя персонажа, «я» или «дом». Пустая строка — от главного дома." } },
      required: ["near"],
      additionalProperties: false,
    },
    async run(input, ctx) {
      let structs: MapStructure[];
      try {
        structs = await world.structures(ctx.signal);
      } catch (e) {
        return unavailable(e);
      }
      const bases = await world.bases(ctx.signal).catch(() => [] as Base[]);
      let ref: Pt | null = bases.find((b) => b.isMain) ?? null;
      let refName = "главного дома";
      const near = input.near.trim();
      if (near && !/^(?:дом|дома|home|база)$/i.test(near)) {
        const snap = await world.players(ctx.signal).catch(() => null);
        const known = await world.knownCharacters(ctx.signal).catch(() => [] as string[]);
        const r = resolvePlayer(near, ctx, snap?.players ?? [], known);
        if (r.kind === "online" && r.player.loaded && canSee(r.player, ctx)) {
          ref = { x: r.player.x!, z: r.player.z! };
          refName = r.self ? "тебя" : `«${r.player.name}»`;
        } else if (r.kind === "online" && !canSee(r.player, ctx)) {
          refName = "главного дома (место игрока скрыто)";
        } else if (r.kind === "offline") {
          refName = `главного дома («${r.name}» не в игре)`;
        }
      }
      const list = structs.filter((s) => /^portal/.test(s.n));
      const byTag = new Map<string, MapStructure[]>();
      for (const s of list) {
        const tag = plainLabel(s.t ?? "") || "(без метки)";
        byTag.set(tag, [...(byTag.get(tag) ?? []), s]);
      }
      const marks = (await world.landmarks(ctx.signal).catch(() => ({ marks: [], bases: [] }))).marks.filter((m) => m.kind !== "portal");
      const rows = list
        .map((s) => {
          const tag = plainLabel(s.t ?? "") || "(без метки)";
          const n = byTag.get(tag)!.length;
          const base = baseAt(s, bases);
          return { s, tag, pair: n === 2 ? "есть пара" : n === 1 ? "без пары" : `${n} шт. с этой меткой`, where: base ? base.name : describeNear(s, marks).text, d: ref ? dist(ref, s) : 0 };
        })
        .sort((a, b) => a.d - b.d);
      const lines = [`Порталов: ${list.length}, меток: ${byTag.size}. Расстояние — от ${refName}.`];
      for (const r of rows.slice(0, 30)) lines.push(`- «${r.tag}» (${r.pair}): ${r.where}${ref ? `, ${fmtDist(r.d)} ${sideOf(ref, r.s)}` : ""}`);
      if (rows.length > 30) lines.push(`…и ещё ${rows.length - 30} дальше.`);
      lines.push("Портал ведёт к другому порталу с той же меткой.");
      return { content: lines.join("\n"), untrusted: true };
    },
  };

  const mapCard: BotTool<{ center: "player" | "point" | "portal" | "home"; target?: string; x?: number; z?: number; scale: "near" | "area" | "region" | "world" }> = {
    name: "valheim_map_card",
    description:
      "Valheim, сервер Koban: нарисовать карточку карты (картинка приложится к ответу) — фрагмент карты мира вокруг игрока, портала, дома или точки, со стрелками игроков, порталами и подписями, плюс ссылка на живую карту. Вызывай, когда спрашивают «где …» и картинка поможет, или просят «покажи на карте». Одна карточка на ответ.",
    access: "player",
    inputSchema: {
      type: "object",
      properties: {
        center: { type: "string", enum: ["player", "point", "portal", "home"], description: "Вокруг чего: игрок, точка x/z, портал по метке, главный дом." },
        target: { type: "string", description: "Для player — имя персонажа или «я»; для portal — метка портала." },
        x: { type: "number", description: "Для point: x (восток), метры мира.", minimum: -12000, maximum: 12000 },
        z: { type: "number", description: "Для point: z (север), метры мира.", minimum: -12000, maximum: 12000 },
        scale: { type: "string", enum: ["near", "area", "region", "world"], description: "near ≈ 300 м вокруг, area ≈ 900 м, region ≈ 2,5 км, world — весь мир." },
      },
      required: ["center", "scale"],
      additionalProperties: false,
    },
    async run(input, ctx) {
      let cfgMap, snap;
      try {
        [cfgMap, snap] = await Promise.all([world.config(ctx.signal), world.players(ctx.signal)]);
      } catch (e) {
        return unavailable(e);
      }
      const bases = await world.bases(ctx.signal).catch(() => [] as Base[]);
      const structs = await world.structures(ctx.signal).catch(() => [] as MapStructure[]);
      const known = await world.knownCharacters(ctx.signal).catch(() => [] as string[]);
      let center: Pt | null = null;
      let title = "";
      let focusName: string | null = null;
      let pointLabel: string | null = null;
      if (input.center === "player") {
        const r = resolvePlayer(input.target ?? "я", ctx, snap.players, known);
        const err = resolveError(r);
        if (err) return err;
        if (r.kind === "offline") return { content: `«${r.name}» сейчас не в игре — показать на карте нечего.`, untrusted: true };
        if (r.kind !== "online") return "Нет данных.";
        if (!r.player.loaded) return { content: `«${r.player.name}» ещё загружается — координат нет.`, untrusted: true };
        if (!canSee(r.player, ctx)) return { content: `«${r.player.name}» скрылся с карты — его место я не показываю.`, untrusted: true };
        center = { x: r.player.x!, z: r.player.z! };
        focusName = r.player.name;
        title = r.player.name;
      } else if (input.center === "portal") {
        const tag = (input.target ?? "").trim().toLowerCase();
        const hits = structs.filter((s) => /^portal/.test(s.n) && plainLabel(s.t ?? "").toLowerCase() === tag);
        const hit = hits[0] ?? structs.find((s) => /^portal/.test(s.n) && plainLabel(s.t ?? "").toLowerCase().includes(tag) && tag.length > 0);
        if (!hit) return { content: `Портала с меткой «${input.target ?? ""}» не нашёл.`, untrusted: true };
        center = { x: hit.x, z: hit.z };
        title = `Портал «${plainLabel(hit.t ?? "")}»`;
        if (hits.length > 1) title += ` (${hits.length} шт., показан первый)`;
      } else if (input.center === "home") {
        const main = bases.find((b) => b.isMain);
        if (!main) return "Дом не нашёл: на сервере нет кроватей и станков.";
        center = main;
        title = "Главный дом";
      } else {
        if (typeof input.x !== "number" || typeof input.z !== "number") return { content: "Для точки нужны x и z.", isError: true };
        center = { x: input.x, z: input.z };
        title = `Точка ${Math.round(input.x)}, ${Math.round(input.z)}`;
        pointLabel = "здесь";
      }
      const worldR = (cfgMap.texture_size * cfgMap.pixel_size) / 2;
      const radius = input.scale === "world" ? worldR : (SCALE_M[input.scale] ?? 900);
      const c = input.scale === "world" ? { x: 0, z: 0 } : center;

      const colors = playerColors(snap.players.map((p) => p.name));
      const markers: CardMarker[] = [];
      for (const p of snap.players) {
        if (!p.loaded || !canSee(p, ctx)) continue;
        markers.push({ kind: "player", x: p.x!, z: p.z!, yaw: p.yaw, dead: p.dead, label: p.name, color: colors.get(p.name)!, focus: p.name === focusName });
      }
      for (const s of structs) {
        if (/^portal/.test(s.n)) markers.push({ kind: "portal", x: s.x, z: s.z, label: plainLabel(s.t ?? "") });
        else if (s.n === "Player_tombstone") markers.push({ kind: "tombstone", x: s.x, z: s.z, label: s.t ? `могила ${s.t}` : "могила" });
        else if (SHIP_PREFABS.has(s.n)) markers.push({ kind: "ship", x: s.x, z: s.z });
        else if (/^(?:bed|piece_bed02)$/.test(s.n)) markers.push({ kind: "bed", x: s.x, z: s.z });
      }
      for (const b of bases) if (b.isMain || b.homeLabel) markers.push({ kind: "home", x: b.x, z: b.z, label: b.isMain ? "Дом" : b.homeLabel ?? "" });
      if (pointLabel) markers.push({ kind: "point", x: center.x, z: center.z, label: pointLabel });

      const [map, fog, t] = await Promise.all([world.mapRaster(ctx.signal), world.fog(ctx.signal), world.time(ctx.signal).catch(() => null)]);
      const focusPlayer = focusName ? snap.players.find((p) => p.name === focusName) : null;
      const place = await world.placeOf({ ...center, y: focusPlayer?.y ?? null }, ctx.signal);
      const biome = focusPlayer?.biomeRu ?? place.biomeGuess;
      const subtitle = [biome, t ? `день ${t.day}, ${clockText(t)}` : null, input.scale === "world" ? "весь мир" : null].filter(Boolean).join(" · ");
      const card = await renderCard(map, fog, cfgMap, {
        center: c,
        radiusM: radius,
        title,
        subtitle,
        link: mapLink.replace(/^https?:\/\//, "").replace(/\/$/, ""),
        markers,
      });
      ctx.attachImage({
        data: card.data,
        mime: card.mime,
        width: card.width,
        height: card.height,
        name: "karta-valheim.png",
        // Нажатие на карточку — живая карта: явной ссылкой, а не догадкой клиента по тексту ответа.
        ...(/^https:\/\//i.test(mapLink) ? { link: mapLink } : {}),
      });
      const shown = markers.filter((m) => m.kind === "player" && Math.abs(m.x - c.x) <= radius && Math.abs(m.z - c.z) <= radius).map((m) => m.label);
      return {
        content: [
          `Карточка карты приложена к ответу (${card.width}×${card.height}). Центр: ${title}, ${place.text}.`,
          shown.length ? `На ней игроки: ${shown.map((n) => `«${n}»`).join(", ")}.` : "Игроков в кадре нет.",
          `Живая карта: ${mapLink} — дай ссылку в ответе.`,
        ].join("\n"),
        untrusted: true,
      };
    },
  };

  return [playersOnline, whereIs, playerGear, findItems, bossesProgress, worldTime, portals, mapCard];
}

function sumItems(c: ModContainer): number {
  return c.items.reduce((s, i) => s + i.n, 0);
}

function nearestPortal(c: Pt, marks: Array<{ kind: string; name: string } & Pt>): string {
  const d = describeNear(
    c,
    marks.filter((m) => m.kind === "portal") as Parameters<typeof describeNear>[1],
    80
  );
  return d.mark ? `, ${d.text}` : "";
}

/** Могилы персонажа (мод): где и сколько вещей. */
async function tombstonesOf(world: VhWorld, name: string, ctx: ToolContext): Promise<string | null> {
  if (!name || !(await world.modReady(ctx.signal))) return null;
  try {
    const r = await world.containers({ kind: "tombstone", limit: "200" }, ctx.signal);
    const mine = r.containers.filter((c) => c.creator && (c.creator === name || sameCharacter(c.creator, name)));
    if (!mine.length) return null;
    const marks = (await world.landmarks(ctx.signal)).marks;
    const parts = mine.slice(0, 3).map((c) => `${describeNear(c, marks).text}${c.dungeon ? " (в подземелье)" : ""}, вещей: ${c.amount}`);
    return `Могилы «${name}»: ${mine.length} — ${parts.join("; ")}.`;
  } catch {
    return null;
  }
}
