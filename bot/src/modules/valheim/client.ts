/**
 * Клиенты к серверу Valheim на stoned (бот работает с network_mode: host):
 *   - PluginClient — плагин карты WebMap, 127.0.0.1:3010: /time, /bosses, /structures,
 *     /locations, /config, /options, /map, /fog и WS-кадр «players». Только чтение.
 *   - BotChannel   — закрытый канал мода для бота, 127.0.0.1:3011, /bot/v1/*, заголовок
 *     X-Bot-Token (токен — файл; после 401 перечитываем). Только GET.
 *   - JoinJson     — valheim-join-code.json через хаб (join-код, недавние игроки).
 * Ни один запрос ничего не меняет на сервере.
 */
import fs from "node:fs";
import type {
  FramePlayer,
  JoinJson,
  MapBoss,
  MapConfig,
  MapLocation,
  MapOptions,
  MapStructure,
  MapTime,
  ModAnchors,
  ModContainers,
  ModHealth,
  ModItems,
  ModKnown,
  ModPlayer,
  ModState,
} from "./types";

export interface HttpResponseLike {
  status: number;
  ok: boolean;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}
export type FetchLike = (url: string, init: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<HttpResponseLike>;

export class VhUnavailable extends Error {
  constructor(
    readonly what: string,
    msg: string
  ) {
    super(msg);
  }
}

const defaultFetch: FetchLike = (url, init) => fetch(url, init) as unknown as Promise<HttpResponseLike>;

function joinSignal(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const t = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, t]) : t;
}

export class PluginClient {
  constructor(
    readonly base: string,
    private readonly fetchFn: FetchLike = defaultFetch,
    private readonly wsFrame: (url: string, timeoutMs: number) => Promise<string> = wsPlayersFrame
  ) {}

  private async get(path: string, signal?: AbortSignal, ms = 8000): Promise<HttpResponseLike> {
    let r: HttpResponseLike;
    try {
      r = await this.fetchFn(`${this.base}${path}`, { signal: joinSignal(signal, ms) });
    } catch (e) {
      throw new VhUnavailable("map", `карта сервера не отвечает (${(e as Error).name})`);
    }
    if (!r.ok) throw new VhUnavailable("map", `карта сервера ответила ${r.status} на ${path}`);
    return r;
  }

  async json<T>(path: string, signal?: AbortSignal, ms?: number): Promise<T> {
    return (await (await this.get(path, signal, ms)).json()) as T;
  }

  time(signal?: AbortSignal) {
    return this.json<MapTime>("/time", signal);
  }
  async bosses(signal?: AbortSignal): Promise<MapBoss[]> {
    const r = await this.json<{ ok: boolean; bosses: MapBoss[] }>("/bosses", signal);
    return r.bosses ?? [];
  }
  structures(signal?: AbortSignal) {
    return this.json<MapStructure[]>("/structures", signal);
  }
  locations(signal?: AbortSignal) {
    return this.json<MapLocation[]>("/locations", signal, 20_000);
  }
  config(signal?: AbortSignal) {
    return this.json<MapConfig>("/config", signal);
  }
  options(signal?: AbortSignal) {
    return this.json<MapOptions>("/options", signal);
  }
  async png(path: "/map" | "/fog", signal?: AbortSignal): Promise<Buffer> {
    const r = await this.get(path, signal, 20_000);
    return Buffer.from(await r.arrayBuffer());
  }
  /** Один кадр «players» по WebSocket карты (без мода позиции иначе не взять). */
  async players(): Promise<FramePlayer[]> {
    const wsUrl = this.base.replace(/^http/, "ws") + "/";
    let frame: string;
    try {
      frame = await this.wsFrame(wsUrl, 5000);
    } catch (e) {
      throw new VhUnavailable("map", `карта сервера не отдаёт игроков (${(e as Error).message})`);
    }
    return parsePlayersFrame(frame);
  }
}

/** Разбор кадра «players» (формат MapDataServer.getPlayerResponse / websocket.js сайта). */
export function parsePlayersFrame(frame: string): FramePlayer[] {
  const body = frame.replace(/^players\n?/, "");
  const out: FramePlayer[] = [];
  for (const section of body.split("\n\n")) {
    const lines = section.split("\n");
    if (lines.length < 4 || lines[2] === undefined) continue;
    const uid = lines.shift()!;
    const name = lines.shift()!;
    const health = Number(lines.shift());
    const maxHealth = Number(lines.shift());
    let hidden = false;
    if (lines[0] === "hidden") {
      hidden = true;
      lines.shift();
    }
    let x: number | null = null;
    let z: number | null = null;
    let yaw: number | null = null;
    if (lines[0] !== undefined && lines[0].includes(",")) {
      const xyz = lines.shift()!.split(",").map(Number);
      x = Number.isFinite(xyz[0]) ? xyz[0]! : null;
      z = Number.isFinite(xyz[1]) ? xyz[1]! : null;
      yaw = xyz.length > 2 && Number.isFinite(xyz[2]) ? xyz[2]! : null;
    }
    const flags = lines[0] ?? "000";
    out.push({
      uid,
      name,
      health: Number.isFinite(health) ? health : 0,
      maxHealth: Number.isFinite(maxHealth) ? maxHealth : 0,
      hidden,
      x,
      z,
      yaw,
      dead: flags[0] === "1",
      pvp: flags[1] === "1",
      inBed: flags[2] === "1",
    });
  }
  return out;
}

/** WS-клиент встроенный (Node 22: глобальный WebSocket). Шлём «players», ждём кадр, закрываем. */
export function wsPlayersFrame(url: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let done = false;
    const ws = new WebSocket(url);
    const finish = (err: Error | null, frame?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* уже закрыт */
      }
      if (err) reject(err);
      else resolve(frame ?? "players");
    };
    const timer = setTimeout(() => finish(new Error("нет ответа")), timeoutMs);
    timer.unref?.();
    ws.onopen = () => ws.send("players");
    ws.onmessage = (ev: MessageEvent) => {
      const s = typeof ev.data === "string" ? ev.data : "";
      if (s === "players" || s.startsWith("players\n")) finish(null, s);
    };
    ws.onerror = () => finish(new Error("ошибка соединения"));
    ws.onclose = () => finish(new Error("соединение закрыто"));
  });
}

export class BotChannel {
  private token: string | null = null;

  constructor(
    readonly base: string,
    private readonly tokenFile: string | null,
    private readonly fetchFn: FetchLike = defaultFetch,
    private readonly readFile: (p: string) => string = (p) => fs.readFileSync(p, "utf8")
  ) {}

  private loadToken(force: boolean): string | null {
    if (this.token && !force) return this.token;
    if (!this.tokenFile) return null;
    try {
      const t = this.readFile(this.tokenFile).trim();
      this.token = t.length >= 16 ? t : null;
    } catch {
      this.token = null;
    }
    return this.token;
  }

  async get<T>(path: string, signal?: AbortSignal, ms = 8000): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = this.loadToken(attempt > 0);
      if (!token) throw new VhUnavailable("mod", "канал мода для бота не настроен (нет файла токена)");
      let r: HttpResponseLike;
      try {
        r = await this.fetchFn(`${this.base}${path}`, { headers: { "X-Bot-Token": token }, signal: joinSignal(signal, ms) });
      } catch (e) {
        throw new VhUnavailable("mod", `канал мода не отвечает (${(e as Error).name}) — вероятно, мод ещё не обновлён на сервере`);
      }
      if (r.status === 401) continue; // токен сменился — перечитать файл и повторить один раз
      if (r.status === 503) throw new VhUnavailable("mod", "мир на сервере ещё загружается");
      if (!r.ok) throw new VhUnavailable("mod", `канал мода ответил ${r.status} на ${path.split("?")[0]}`);
      return (await r.json()) as T;
    }
    throw new VhUnavailable("mod", "канал мода не принял токен (401)");
  }

  health(signal?: AbortSignal) {
    return this.get<ModHealth>("/bot/v1/health", signal, 4000);
  }
  state(signal?: AbortSignal) {
    return this.get<ModState>("/bot/v1/state", signal);
  }
  async players(signal?: AbortSignal): Promise<ModPlayer[]> {
    return (await this.get<{ ok: boolean; players: ModPlayer[] }>("/bot/v1/players", signal)).players ?? [];
  }
  containers(params: Record<string, string>, signal?: AbortSignal) {
    return this.get<ModContainers>(`/bot/v1/containers?${new URLSearchParams(params).toString()}`, signal, 15_000);
  }
  anchors(params: Record<string, string>, signal?: AbortSignal) {
    return this.get<ModAnchors>(`/bot/v1/anchors?${new URLSearchParams(params).toString()}`, signal, 15_000);
  }
  items(params: Record<string, string>, signal?: AbortSignal) {
    const q = new URLSearchParams(params).toString();
    return this.get<ModItems>(`/bot/v1/items${q ? `?${q}` : ""}`, signal, 20_000);
  }
  known(signal?: AbortSignal) {
    return this.get<ModKnown>("/bot/v1/known", signal);
  }
}

export class JoinInfo {
  constructor(
    readonly url: string | null,
    private readonly fetchFn: FetchLike = defaultFetch
  ) {}
  async get(signal?: AbortSignal): Promise<JoinJson | null> {
    if (!this.url) return null;
    try {
      const r = await this.fetchFn(this.url, { signal: joinSignal(signal, 5000) });
      if (!r.ok) return null;
      return (await r.json()) as JoinJson;
    } catch {
      return null;
    }
  }
}
