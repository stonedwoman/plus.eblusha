/**
 * Ответы плагина WebMap (127.0.0.1:3010, публичный формат карты) и закрытого канала мода
 * для бота (127.0.0.1:3011, /bot/v1 — описание: WebMap/Bot/API.md в ветке bot-api).
 * Всё, что пришло отсюда, — данные игры: имена персонажей, подписи табличек и порталов
 * пишут игроки, поэтому модели они отдаются как недоверенные.
 */

// ------------------------------------------------------------------ плагин карты (3010)
export interface MapTime {
  ok: boolean;
  netTime: number;
  day: number;
  dayLengthSec: number;
  fraction: number;
  smoothFraction: number;
  phase: string;
  isDay: boolean;
  isAfternoon: boolean;
  isNight: boolean;
  canSleep: boolean;
  secondsToSleep: number;
  secondsToSleepEnd: number;
  secondsToMorning: number;
  running: boolean;
  players: number;
}

export interface MapBoss {
  p: string;
  k: string;
  d: 0 | 1;
  ru?: string;
  en?: string;
}

export interface MapStructure {
  n: string;
  t?: string;
  x: number;
  z: number;
}

export interface MapLocation {
  n: string;
  g?: string;
  b?: string;
  x: number;
  z: number;
  p?: 0 | 1;
}

export interface MapConfig {
  world_name: string;
  texture_size: number;
  pixel_size: number;
  explore_radius?: number;
}

export interface MapOptionItem {
  key: string;
  kind: "flag" | "scale" | "int";
  label: string;
  hint?: string;
  on?: boolean;
  value?: number;
  isDefault?: boolean;
  choices?: number[];
  min?: number;
  max?: number;
}

export interface MapOptions {
  ready: boolean;
  groups: Array<{ name: string; items: MapOptionItem[] }>;
}

/** Кадр WS «players» карты (без мода). */
export interface FramePlayer {
  uid: string;
  name: string;
  health: number;
  maxHealth: number;
  hidden: boolean;
  x: number | null;
  z: number | null;
  yaw: number | null;
  dead: boolean;
  pvp: boolean;
  inBed: boolean;
}

// ------------------------------------------------------------------ канал мода (3011)
export interface EquipItem {
  p: string;
  ru?: string;
  en?: string;
  q?: number;
  v?: number;
}

export type EquipSlot = "helmet" | "chest" | "legs" | "shoulder" | "utility" | "trinket" | "right" | "left" | "backRight" | "backLeft";

export interface ModPlayer {
  name: string;
  uid: string;
  playerId?: string;
  since?: string;
  sessionSec?: number;
  hidden?: boolean;
  loaded?: boolean;
  x?: number;
  y?: number;
  z?: number;
  yaw?: number;
  biome?: string;
  biomeRu?: string;
  dungeon?: boolean;
  location?: string;
  health?: number;
  maxHealth?: number;
  stamina?: number;
  eitr?: number;
  dead?: boolean;
  pvp?: boolean;
  inBed?: boolean;
  baseValue?: number;
  equipment?: Partial<Record<EquipSlot, EquipItem>>;
}

export interface ModHealth {
  ok: boolean;
  api: string;
  plugin?: string;
  boot: string;
  ready: boolean;
  catalog: boolean;
  players?: number;
  scan: { rev: number; at: string; ms: number; containers: number; anchors: number } | null;
}

export interface ModRaid {
  name: string;
  ru?: string;
  x: number;
  z: number;
  range?: number;
  elapsed?: number;
  duration?: number;
  since?: string;
}

export interface ModState {
  ok: boolean;
  ready: boolean;
  boot: string;
  ts: string;
  world: string;
  day: number;
  netTime: number;
  clock: MapTime;
  players: ModPlayer[];
  sleeping: boolean;
  raid: ModRaid | null;
  globalKeys: string[];
  bosses: { ok: boolean; bosses: MapBoss[] };
}

export interface ContainerItem {
  p: string;
  ru?: string;
  en?: string;
  n: number;
  q?: number;
}

export interface ModContainer {
  id: string;
  prefab: string;
  kind: "chest" | "ship" | "cart" | "tombstone" | "treasure";
  name?: string;
  x: number;
  y: number;
  z: number;
  dist?: number;
  biome?: string;
  dungeon?: boolean;
  creatorId?: string;
  creator?: string;
  deathNetTime?: number;
  label?: string;
  capacity: number;
  slots: number;
  amount: number;
  items: ContainerItem[];
  error?: string;
}

export interface ModContainers {
  ok: boolean;
  boot: string;
  ready: boolean;
  rev: number;
  scannedAt: string;
  total: number;
  count: number;
  truncated: boolean;
  containers: ModContainer[];
  totals?: Array<{ p: string; ru?: string; en?: string; n: number; containers: number }>;
}

export interface ModAnchor {
  kind: "bed" | "station" | "ward" | "portal" | "sign";
  id: string;
  prefab: string;
  name?: string;
  x: number;
  y: number;
  z: number;
  biome?: string;
  ownerId?: string;
  owner?: string;
  creatorId?: string;
  creator?: string;
  world?: boolean;
  text?: string;
  enabled?: boolean;
}

export interface ModAnchors {
  ok: boolean;
  boot: string;
  ready: boolean;
  rev: number;
  scannedAt: string;
  total: number;
  truncated: boolean;
  anchors: ModAnchor[];
}

export interface CatalogItem {
  p: string;
  ru?: string;
  en?: string;
  type: string;
  maxQ?: number;
  armor?: number;
  armorPerLevel?: number;
  set?: string;
  setSize?: number;
  skill?: string;
  dmg?: Record<string, number>;
  block?: number;
  recipe?: { station?: string; stationRu?: string; level?: number; res?: Array<{ p: string; n: number; perLevel?: number }> };
}

export interface ModItems {
  ok: boolean;
  count: number;
  total: number;
  items: CatalogItem[];
  bosses?: Array<{ key: string; p: string; ru?: string; en?: string }>;
}

export interface ModKnown {
  ok: boolean;
  boot?: string;
  players: Array<{ name: string; playerId?: string; firstSeen?: string; lastSeen?: string; sessions?: number; online?: boolean; sources?: string[] }>;
}

/** valheim-join-code.json (хаб): join-код и недавние игроки. Время — Бухарест без пояса. */
export interface JoinJson {
  code?: string;
  serverName?: string;
  ok?: boolean;
  playersOnline?: number;
  players?: string[];
  recentPlayers?: Array<{ name: string; lastSeen?: string; online?: boolean; sessionEndedAt?: string | null }>;
}
