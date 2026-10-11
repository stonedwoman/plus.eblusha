/**
 * Состояние мира Valheim для бота: что знает сервер прямо сейчас, с короткими кэшами.
 *
 * Два источника:
 *   - канал мода /bot/v1 (127.0.0.1:3011) — точные игроки (высота, биом, подземелье,
 *     экипировка), склады, кровати/станки/таблички, справочник предметов, известные персонажи;
 *   - плагин карты (127.0.0.1:3010) — работает и без нового мода: игроки из WS-кадра (x, z,
 *     поворот, здоровье), часы, боссы, порталы/кровати/станки из /structures, локации, карта и
 *     туман.
 * Пока мод не выложен (или мир перезапускается), всё, что умеет карта, продолжает работать.
 */
import { BotChannel, JoinInfo, PluginClient, VhUnavailable } from "./client";
import { describeNear, dist, DUNGEON_Y, type Landmark, type Pt } from "./geo";
import { baseAt, findBases, type AnchorLike, type Base } from "./home";
import { biomeRu, classifyLocation, plainLabel } from "./names";
import { decodePng, type Raster } from "./raster";
import type {
  CatalogItem,
  EquipItem,
  EquipSlot,
  JoinJson,
  MapBoss,
  MapConfig,
  MapLocation,
  MapStructure,
  MapTime,
  ModContainers,
  ModState,
} from "./types";

export interface VhPlayer {
  name: string;
  uid: string;
  playerId: string | null;
  loaded: boolean;
  x: number | null;
  y: number | null;
  z: number | null;
  yaw: number | null;
  health: number | null;
  maxHealth: number | null;
  stamina: number | null;
  eitr: number | null;
  dead: boolean;
  pvp: boolean;
  inBed: boolean;
  /** Игрок снял галочку «показывать на карте». Бот место такого игрока не раскрывает. */
  hidden: boolean;
  biome: string | null;
  biomeRu: string | null;
  dungeon: boolean | null;
  location: string | null;
  sessionSec: number | null;
  /** Когда вошёл в игру (мс; мод: since, иначе по sessionSec), null — неизвестно (данные карты). */
  since: number | null;
  baseValue: number | null;
  equipment: Partial<Record<EquipSlot, EquipItem>> | null;
}

export interface PlayersSnapshot {
  source: "mod" | "map";
  players: VhPlayer[];
}

interface Entry {
  at: number;
  value?: unknown;
  pending?: Promise<unknown>;
}

export class VhWorld {
  private readonly cache = new Map<string, Entry>();

  constructor(
    readonly map: PluginClient,
    readonly mod: BotChannel,
    readonly join: JoinInfo,
    private readonly now: () => number = Date.now,
    private readonly decode: (png: Buffer, channels: 1 | 4) => Promise<Raster> = decodePng
  ) {}

  /** Кэш с объединением одновременных запросов; ошибки не кэшируются. */
  async cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const e = this.cache.get(key);
    if (e && "value" in e && this.now() - e.at < ttlMs) return e.value as T;
    if (e?.pending) return e.pending as Promise<T>;
    const pending = load().then(
      (v) => {
        this.cache.set(key, { at: this.now(), value: v });
        return v;
      },
      (err: unknown) => {
        if (e && "value" in e) this.cache.set(key, { at: e.at, value: e.value });
        else this.cache.delete(key);
        throw err;
      }
    );
    this.cache.set(key, { ...(e ?? { at: 0 }), pending });
    return pending;
  }

  /** Канал мода жив и мир готов. Ответ кэшируется на 20 с (и «нет» тоже). */
  async modReady(signal?: AbortSignal): Promise<boolean> {
    return this.cached("mod:ok", 20_000, async () => {
      try {
        const h = await this.mod.health(signal);
        return !!(h.ok && h.ready);
      } catch {
        return false;
      }
    });
  }

  async players(signal?: AbortSignal): Promise<PlayersSnapshot> {
    if (await this.modReady(signal)) {
      try {
        return await this.cached("players:mod", 1500, async () => ({ source: "mod" as const, players: (await this.mod.players(signal)).map(fromMod) }));
      } catch (e) {
        if (!(e instanceof VhUnavailable)) throw e;
        this.cache.delete("mod:ok");
      }
    }
    return this.cached("players:map", 2000, async () => ({ source: "map" as const, players: (await this.map.players()).map(fromFrame) }));
  }

  time(signal?: AbortSignal): Promise<MapTime> {
    return this.cached("time", 5000, () => this.map.time(signal));
  }

  bosses(signal?: AbortSignal): Promise<MapBoss[]> {
    return this.cached("bosses", 10_000, () => this.map.bosses(signal));
  }

  /** Живое состояние мода (набег, сон, ключи мира); null — мода нет. */
  async state(signal?: AbortSignal): Promise<ModState | null> {
    if (!(await this.modReady(signal))) return null;
    try {
      return await this.cached("state", 2000, () => this.mod.state(signal));
    } catch {
      return null;
    }
  }

  structures(signal?: AbortSignal): Promise<MapStructure[]> {
    return this.cached("structures", 60_000, () => this.map.structures(signal));
  }

  locations(signal?: AbortSignal): Promise<MapLocation[]> {
    return this.cached("locations", 3600_000, () => this.map.locations(signal));
  }

  config(signal?: AbortSignal): Promise<MapConfig> {
    return this.cached("config", 600_000, () => this.map.config(signal));
  }

  joinInfo(signal?: AbortSignal): Promise<JoinJson | null> {
    return this.cached("join", 30_000, () => this.join.get(signal));
  }

  /** Кровати, станки, порталы, таблички: из мода, а без него — из /structures карты. */
  async anchors(signal?: AbortSignal): Promise<{ source: "mod" | "map"; anchors: AnchorLike[] }> {
    if (await this.modReady(signal)) {
      try {
        return await this.cached("anchors:mod", 30_000, async () => {
          const r = await this.mod.anchors({ kind: "all", limit: "5000" }, signal);
          return {
            source: "mod" as const,
            anchors: r.anchors.map((a) => ({ kind: a.kind, prefab: a.prefab, x: a.x, z: a.z, text: a.text, owner: a.owner, world: a.world })),
          };
        });
      } catch (e) {
        if (!(e instanceof VhUnavailable)) throw e;
      }
    }
    return this.cached("anchors:map", 60_000, async () => ({ source: "map" as const, anchors: structuresToAnchors(await this.structures(signal)) }));
  }

  async bases(signal?: AbortSignal): Promise<Base[]> {
    const a = await this.anchors(signal);
    return this.cached(`bases:${a.source}`, 30_000, async () => findBases(a.anchors));
  }

  /** Справочник предметов игры (мод), по префабу. null — мода нет. */
  async catalog(signal?: AbortSignal): Promise<Map<string, CatalogItem> | null> {
    if (!(await this.modReady(signal))) return null;
    try {
      return await this.cached("catalog", 3600_000, async () => {
        const r = await this.mod.items({}, signal);
        return new Map(r.items.map((i) => [i.p, i]));
      });
    } catch {
      return null;
    }
  }

  async containers(params: Record<string, string>, signal?: AbortSignal): Promise<ModContainers> {
    const key = `containers:${new URLSearchParams(params).toString()}`;
    return this.cached(key, 10_000, () => this.mod.containers(params, signal));
  }

  /**
   * Персонажи, которых видел сервер (для привязки ников): известные моду, недавние игроки
   * из join-json, хозяева кроватей и могил, кто сейчас в игре.
   */
  async knownCharacters(signal?: AbortSignal): Promise<string[]> {
    return this.cached("known", 60_000, async () => {
      const names = new Set<string>();
      const add = (n: string | undefined | null) => {
        const v = (n ?? "").trim();
        if (v && v.length <= 40 && !/[\n\r]/.test(v)) names.add(v);
      };
      if (await this.modReady(signal)) {
        try {
          for (const p of (await this.mod.known(signal)).players) add(p.name);
        } catch {
          /* мод не ответил — остальное ниже */
        }
      }
      const [join, structs, players] = await Promise.allSettled([this.joinInfo(signal), this.structures(signal), this.players(signal)]);
      if (join.status === "fulfilled" && join.value) for (const p of join.value.recentPlayers ?? []) add(p.name);
      if (structs.status === "fulfilled") for (const s of structs.value) if (/^(?:bed|piece_bed02|Player_tombstone)$/.test(s.n)) add(s.t);
      if (players.status === "fulfilled") for (const p of players.value.players) add(p.name);
      return [...names];
    });
  }

  async fog(signal?: AbortSignal): Promise<Raster | null> {
    try {
      return await this.cached("fog", 60_000, async () => this.decode(await this.map.png("/fog", signal), 1));
    } catch {
      return null;
    }
  }

  mapRaster(signal?: AbortSignal): Promise<Raster> {
    return this.cached("map", 30 * 60_000, async () => this.decode(await this.map.png("/map", signal), 4));
  }

  /** Разведано ли место (туман войны карты: белое — были ближе 100 м). Без тумана — «да». */
  explored(fog: Raster | null, cfg: MapConfig, p: Pt): boolean {
    if (!fog) return true;
    const px = Math.floor(p.x / cfg.pixel_size + cfg.texture_size / 2);
    const py = Math.floor(cfg.texture_size / 2 - p.z / cfg.pixel_size);
    if (px < 0 || py < 0 || px >= fog.width || py >= fog.height) return false;
    return (fog.data[(py * fog.width + px) * fog.channels] ?? 0) > 127;
  }

  /**
   * Ориентиры для «где это»: порталы с метками, базы, разведанные локации мира.
   * Неразведанные локации не называем (спойлер).
   */
  landmarks(signal?: AbortSignal): Promise<{ marks: Landmark[]; bases: Base[] }> {
    return this.cached("landmarks", 30_000, () => this.buildLandmarks(signal));
  }

  private async buildLandmarks(signal?: AbortSignal): Promise<{ marks: Landmark[]; bases: Base[] }> {
    const [structs, bases, locs, fog, cfg] = await Promise.all([
      this.structures(signal).catch(() => [] as MapStructure[]),
      this.bases(signal).catch(() => [] as Base[]),
      this.locations(signal).catch(() => [] as MapLocation[]),
      this.fog(signal),
      this.config(signal).catch(() => null),
    ]);
    const marks: Landmark[] = [];
    for (const s of structs) {
      if (/^portal/.test(s.n) && s.t && plainLabel(s.t)) marks.push({ kind: "portal", name: `портала «${plainLabel(s.t)}»`, x: s.x, z: s.z });
    }
    for (const l of locs) {
      const c = classifyLocation(l.n);
      if (!c || c.category === "nature" || c.category === "tar") continue;
      if (cfg && !this.explored(fog, cfg, l)) continue;
      marks.push({ kind: "location", name: `места «${c.ru}»`, x: l.x, z: l.z });
    }
    for (const b of bases) marks.push({ kind: "home", name: b.isMain ? "главного дома" : `базы «${b.homeLabel ?? b.name}»`, x: b.x, z: b.z });
    return { marks, bases };
  }

  /** Место словами: «дома (главный дом), у портала …» / «в 340 м к югу от портала «БОЛОТО»». */
  async placeOf(p: Pt & { y?: number | null }, signal?: AbortSignal): Promise<{ text: string; base: Base | null; biomeGuess: string | null }> {
    const { marks, bases } = await this.landmarks(signal);
    const base = baseAt(p, bases);
    const portalsAndPlaces = marks.filter((m) => m.kind !== "home");
    const near = describeNear(p, portalsAndPlaces);
    let text: string;
    if (base) {
      text = `${base.isMain ? "дома (главный дом)" : `на базе «${base.homeLabel ?? base.name}»`}${near.mark && near.dist < 60 ? `, ${near.text}` : ""}`;
    } else {
      const homeNear = describeNear(p, marks);
      text = homeNear.text;
    }
    if (p.y !== null && p.y !== undefined && p.y > DUNGEON_Y) text = `в подземелье; вход ${text}`;
    // Биом без мода — по ближайшей локации (грубо): у локаций свой биом.
    let biomeGuess: string | null = null;
    try {
      const locs = await this.locations(signal);
      let best: MapLocation | null = null;
      let bd = Infinity;
      for (const l of locs) {
        const d = dist(p, l);
        if (d < bd && l.b) {
          bd = d;
          best = l;
        }
      }
      if (best && bd < 600) biomeGuess = biomeRu(best.b);
    } catch {
      /* без локаций — без догадки */
    }
    return { text, base, biomeGuess };
  }
}

function fromMod(p: import("./types").ModPlayer): VhPlayer {
  const loaded = p.loaded !== false && typeof p.x === "number";
  return {
    name: p.name,
    uid: p.uid,
    playerId: p.playerId ?? null,
    loaded,
    x: loaded ? p.x! : null,
    y: loaded && typeof p.y === "number" ? p.y : null,
    z: loaded && typeof p.z === "number" ? p.z : null,
    yaw: typeof p.yaw === "number" ? p.yaw : null,
    health: p.health ?? null,
    maxHealth: p.maxHealth ?? null,
    stamina: p.stamina ?? null,
    eitr: p.eitr ?? null,
    dead: !!p.dead,
    pvp: !!p.pvp,
    inBed: !!p.inBed,
    hidden: !!p.hidden,
    biome: p.biome ?? null,
    biomeRu: biomeRu(p.biome) ?? p.biomeRu ?? null,
    dungeon: p.dungeon ?? null,
    location: p.location ?? null,
    sessionSec: p.sessionSec ?? null,
    since: p.since && Number.isFinite(Date.parse(p.since)) ? Date.parse(p.since) : typeof p.sessionSec === "number" ? Date.now() - p.sessionSec * 1000 : null,
    baseValue: p.baseValue ?? null,
    equipment: p.equipment ?? null,
  };
}

function fromFrame(p: import("./types").FramePlayer): VhPlayer {
  return {
    name: p.name,
    uid: p.uid,
    playerId: null,
    loaded: p.x !== null,
    x: p.x,
    y: null,
    z: p.z,
    yaw: p.yaw,
    health: p.health,
    maxHealth: p.maxHealth,
    stamina: null,
    eitr: null,
    dead: p.dead,
    pvp: p.pvp,
    inBed: p.inBed,
    hidden: p.hidden,
    biome: null,
    biomeRu: null,
    dungeon: null,
    location: null,
    since: null,
    sessionSec: null,
    baseValue: null,
    equipment: null,
  };
}

export function structuresToAnchors(list: MapStructure[]): AnchorLike[] {
  const out: AnchorLike[] = [];
  for (const s of list) {
    if (/^(?:bed|piece_bed02|ashwood_bed)$/.test(s.n)) out.push({ kind: "bed", prefab: s.n, x: s.x, z: s.z, owner: s.t });
    else if (/^portal/.test(s.n)) out.push({ kind: "portal", prefab: s.n, x: s.x, z: s.z, text: s.t });
    else if (s.n === "guard_stone") out.push({ kind: "ward", prefab: s.n, x: s.x, z: s.z });
    else if (/^(?:piece_|forge|blackforge|smelter|blastfurnace|charcoal_kiln|windmill|eitrrefinery)/.test(s.n)) out.push({ kind: "station", prefab: s.n, x: s.x, z: s.z });
  }
  return out;
}
