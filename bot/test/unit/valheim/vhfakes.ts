/**
 * Заглушка сервера Valheim для тестов модуля: отвечает СНИМКАМИ реальных ответов
 * (test/fixtures/valheim — карта сервера Koban 2026-10-10 и канал мода со стенда на копии мира),
 * игроки — придуманы (в момент снимка сервер был пуст). Сеть не используется.
 */
import fs from "node:fs";
import path from "node:path";
import type { FetchLike, HttpResponseLike } from "../../../src/modules/valheim/client";
import { BotChannel, JoinInfo, PluginClient } from "../../../src/modules/valheim/client";
import type { ValheimConfig } from "../../../src/modules/valheim/config";
import type { Raster } from "../../../src/modules/valheim/raster";
import type { ModContainer, ModContainers, ModPlayer } from "../../../src/modules/valheim/types";
import { VhWorld } from "../../../src/modules/valheim/world";
import type { OutgoingImage, ToolContext } from "../../../src/modules/api";
import { silentLogger } from "../../../src/log";

const DIR = path.resolve(process.cwd(), "test/fixtures/valheim");
export function fx<T = any>(name: string): T {
  return JSON.parse(fs.readFileSync(path.join(DIR, name), "utf8")) as T;
}

export const TOKEN = "t".repeat(64);

export const CFG: ValheimConfig = {
  mapUrl: "http://map",
  botUrl: "http://mod",
  botTokenFile: "/run/secrets/webmap-bot.token",
  joinJsonUrl: "http://hub/v/valheim-join-code.json",
  publicMapUrl: "https://v.koban.uk/map/",
  opsSocket: null,
  timeZone: "Europe/Moscow",
};

/** Игроки в формате мода: Парасюха дома (видимая), Куралеска скрыта, Рома в склепе. */
export function modPlayers(): ModPlayer[] {
  return [
    {
      name: "IiApaCiOxa",
      uid: "11",
      playerId: "1945189421",
      sessionSec: 4000,
      loaded: true,
      x: -737,
      y: 34.6,
      z: -331,
      yaw: 45,
      biome: "Meadows",
      biomeRu: "Луга",
      dungeon: false,
      health: 80,
      maxHealth: 110,
      stamina: 60,
      eitr: 0,
      dead: false,
      pvp: false,
      inBed: false,
      baseValue: 14,
      equipment: {
        helmet: { p: "HelmetDrake", ru: "Драконий шлем" },
        chest: { p: "ArmorWolfChest", ru: "Волчий нагрудник" },
        legs: { p: "ArmorWolfLegs", ru: "Волчья защита для ног" },
        shoulder: { p: "CapeWolf", ru: "Плащ из шкуры волка", q: 4 },
        right: { p: "SwordSilver", ru: "Серебряный меч", q: 4 },
        left: { p: "ShieldSilver", q: 3 },
      },
    },
    {
      name: "Куралеска",
      uid: "12",
      playerId: "3329435465",
      sessionSec: 600,
      hidden: true,
      loaded: true,
      x: -3782,
      y: 37,
      z: -4505,
      yaw: 180,
      biome: "BlackForest",
      dungeon: false,
      health: 120,
      maxHealth: 120,
      dead: false,
      equipment: { chest: { p: "ArmorFlametalChest" }, helmet: { p: "HelmetFlametal" }, legs: { p: "ArmorFlametalLegs" } },
    },
    {
      name: "РомаH",
      uid: "13",
      playerId: "-263508138",
      sessionSec: 9000,
      loaded: true,
      x: 1866,
      y: 5034,
      z: -8360,
      yaw: 270,
      biome: "AshLands",
      dungeon: true,
      location: "CharredFortress",
      health: 0,
      maxHealth: 150,
      dead: true,
    },
  ];
}

/** Кадр WS «players» карты для тех же игроков (без мода). */
export function playersFrame(players: ModPlayer[]): string {
  const blocks = players.map(
    (p) =>
      `${p.uid}\n${p.name}\n${Math.ceil(p.health ?? 0)}\n${Math.ceil(p.maxHealth ?? 0)}\n${p.hidden ? "hidden\n" : ""}${p.x},${p.z},${p.yaw}\n${p.dead ? 1 : 0}${p.pvp ? 1 : 0}${p.inBed ? 1 : 0}`
  );
  return `players\n${blocks.join("\n\n")}`.trim();
}

function json(v: unknown, status = 200): HttpResponseLike {
  return { status, ok: status >= 200 && status < 300, json: async () => v, arrayBuffer: async () => new ArrayBuffer(8) };
}

/** Фильтр складов как у мода (item — подстрока префаба/рус/англ, kind, totals). */
export function filterContainers(all: ModContainer[], params: URLSearchParams): ModContainers {
  const kinds = (params.get("kind") ?? "chest,ship,cart,tombstone").split(",");
  const items = (params.get("item") ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  let list = all.filter((c) => kinds.includes(c.kind) || kinds.includes("all"));
  if (items.length) {
    const hit = (i: { p: string; ru?: string; en?: string }) => items.some((q) => i.p.toLowerCase().includes(q) || (i.ru ?? "").toLowerCase().includes(q) || (i.en ?? "").toLowerCase().includes(q));
    list = list.filter((c) => c.items.some(hit)).map((c) => ({ ...c, items: c.items.filter(hit) }));
  }
  const totals = new Map<string, { p: string; ru?: string | undefined; n: number; containers: number }>();
  for (const c of list) for (const i of c.items) {
    const t = totals.get(i.p) ?? { p: i.p, ru: i.ru, n: 0, containers: 0 };
    t.n += i.n;
    t.containers++;
    totals.set(i.p, t);
  }
  return { ok: true, boot: "test", ready: true, rev: 1, scannedAt: "2026-10-10T11:25:41.178Z", total: list.length, count: list.length, truncated: false, containers: list, ...(items.length ? { totals: [...totals.values()] } : {}) } as ModContainers;
}

export interface FakeServer {
  fetch: FetchLike;
  calls: string[];
  modUp: boolean;
  players: ModPlayer[];
  structures: Array<{ n: string; t?: string; x: number; z: number }>;
  containers: ModContainer[];
  token: string;
}

export function fakeServer(over: Partial<Pick<FakeServer, "modUp" | "players">> = {}): FakeServer {
  const s: FakeServer = {
    calls: [],
    modUp: over.modUp ?? true,
    players: over.players ?? modPlayers(),
    structures: fx("map-structures.json"),
    containers: fx<ModContainers>("mod-containers.json").containers,
    token: TOKEN,
    fetch: async () => json({}),
  };
  s.fetch = async (url, init) => {
    s.calls.push(url);
    const u = new URL(url);
    if (u.host === "map") {
      const t = fx("map-time.json");
      switch (u.pathname) {
        case "/time":
          return json({ ...t, players: s.players.length, running: s.players.length > 0 });
        case "/bosses":
          return json(fx("map-bosses.json"));
        case "/structures":
          return json(s.structures);
        case "/locations":
          return json(fx("map-locations.json"));
        case "/config":
          return json(fx("map-config.json"));
        case "/options":
          return json(fx("map-options.json"));
        case "/map":
        case "/fog":
          return { status: 200, ok: true, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(16) };
      }
      return json({ ok: false }, 404);
    }
    if (u.host === "hub") return json({ code: "597530", ok: true, recentPlayers: [{ name: "IiApaCiOxa", lastSeen: "2026-10-10T11:22:31", sessionEndedAt: "2026-10-10T11:45:10" }, { name: "Odev", lastSeen: "2026-09-20T10:00:00" }] });
    if (u.host === "mod") {
      if (!s.modUp) throw new TypeError("fetch failed");
      if (init.headers?.["X-Bot-Token"] !== s.token) return json({ ok: false, error: "нужен заголовок X-Bot-Token" }, 401);
      switch (u.pathname) {
        case "/bot/v1/health":
          return json(fx("mod-health.json"));
        case "/bot/v1/players":
          return json({ ok: true, boot: "test", players: s.players });
        case "/bot/v1/state":
          return json({ ...fx<Record<string, unknown>>("mod-state.json"), players: s.players });
        case "/bot/v1/known":
          return json(fx("mod-known.json"));
        case "/bot/v1/items":
          return json(fx("items.json"));
        case "/bot/v1/anchors":
          return json(fx("mod-anchors.json"));
        case "/bot/v1/containers":
          return json(filterContainers(s.containers, u.searchParams));
      }
      return json({ ok: false }, 404);
    }
    throw new TypeError(`нет такого хоста в заглушке: ${url}`);
  };
  return s;
}

/** Туман: разведано всё в 1,5 км от дома и от старта (как на сервере — вокруг баз). */
export function fakeFog(): Raster {
  const size = 2048;
  const data = Buffer.alloc(size * size);
  const lit = (x: number, z: number, r: number) => {
    const cx = Math.round(x / 12 + 1024);
    const cy = Math.round(1024 - z / 12);
    const rp = Math.round(r / 12);
    for (let y = cy - rp; y <= cy + rp; y++) for (let xx = cx - rp; xx <= cx + rp; xx++) if (y >= 0 && xx >= 0 && y < size && xx < size && (xx - cx) ** 2 + (y - cy) ** 2 <= rp * rp) data[y * size + xx] = 255;
  };
  lit(-740, -320, 1500);
  lit(0, 0, 600);
  lit(-3782, -4505, 300);
  lit(1866, -8360, 400);
  return { data, width: size, height: size, channels: 1 };
}

/** Карта: луга-зелёная суша везде (для картинок хватит). */
export function fakeMap(size = 2048): Raster {
  const data = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    data[i * 4] = 120;
    data[i * 4 + 1] = 150;
    data[i * 4 + 2] = 80;
    data[i * 4 + 3] = 255;
  }
  return { data, width: size, height: size, channels: 4 };
}

let FOG: Raster | null = null;
let MAP: Raster | null = null;

export function makeWorld(server: FakeServer, opts: { wsFrame?: () => Promise<string>; now?: () => number } = {}): VhWorld {
  const map = new PluginClient(CFG.mapUrl, server.fetch, opts.wsFrame ?? (async () => playersFrame(server.players)));
  const mod = new BotChannel(CFG.botUrl, CFG.botTokenFile, server.fetch, () => server.token);
  return new VhWorld(map, mod, new JoinInfo(CFG.joinJsonUrl, server.fetch), opts.now ?? Date.now, async (_png, ch) => (ch === 1 ? (FOG ??= fakeFog()) : (MAP ??= fakeMap())));
}

export interface CtxOpts {
  characters?: string[];
  isOwner?: boolean;
  /** "bot" — личный «Чат с Еблушей» (по умолчанию), "dm" — личка двух людей, "group" — группа. */
  kind?: "bot" | "dm" | "group";
  /** В группе: все ли участники — игроки (по умолчанию да). */
  playerDataOk?: boolean;
}

export function makeCtx(o: CtxOpts = {}): ToolContext & { images: OutgoingImage[] } {
  const images: OutgoingImage[] = [];
  const characters = o.characters ?? [];
  return {
    requester: { userId: "u1", displayName: "Тест", isOwner: !!o.isOwner, characters, isPlayer: !!o.isOwner || characters.length > 0 },
    chat: { conversationId: "c1", kind: o.kind ?? "bot", title: null, participantCount: 2, playerDataOk: o.playerDataOk ?? true },
    attachImage: (img) => images.push(img),
    signal: AbortSignal.timeout(30_000),
    log: silentLogger,
    now: new Date("2026-10-10T12:00:00Z"),
    images,
  };
}

export function text(r: unknown): string {
  return typeof r === "string" ? r : (r as { content: string }).content;
}
