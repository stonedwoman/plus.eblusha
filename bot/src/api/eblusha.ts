/**
 * REST-клиент backend Еблуши под учёткой системного бота.
 *
 * Бот не участник бесед: обращения приходят задачами из очереди (api/queue.ts), а пишет бот
 * только через /api/bot/* (src/routes/bot.ts на сервере) с разрешением (grant) из задачи —
 * в ту беседу, где к нему обратились. Уведомления — в личный «Чат с Еблушей» человека (userId).
 *
 * Вход: POST /api/auth/login (лимит 10/мин на IP) → access (JWT ~15 мин) + refresh (ротация).
 * Обновление: POST /api/auth/refresh с заголовком x-native-client: 1 — тогда сервер берёт
 * refresh из тела (lib/authSessions.ts). Refresh живёт только в памяти: после рестарта бот
 * входит паролем заново.
 */
import type { Logger } from "../log";
import type { BotPostInput, EbMessage, UploadResult } from "./types";

const AUTH_TIMEOUT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 120_000;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly code: string | null,
    message: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** То, чем пользуется ядро. Отдельный интерфейс — чтобы юнит-тесты подсовывали заглушку. */
export interface ChatApi {
  readonly baseUrl: string;
  me(): Promise<{ id: string; displayName: string | null; avatarUrl: string | null; bio: string | null }>;
  updateMe(patch: { displayName?: string; bio?: string; avatarUrl?: string }): Promise<void>;
  /** Сообщение от бота: POST /api/bot/messages (grant — ответ на обращение, userId — в личный чат). */
  postMessage(input: BotPostInput): Promise<EbMessage>;
  /** «Печатает…» в беседе обращения. */
  typing(grant: string, typing: boolean): Promise<void>;
  /** Реакция на сообщение из беседы обращения («спасибо» → 👍). */
  react(grant: string, messageId: string, emoji: string): Promise<void>;
  upload(data: Buffer, filename: string, mime: string): Promise<UploadResult>;
  /** Скачать вложение Еблуши (/api/files/…); thumb — серверное превью картинки. */
  fetchFile(url: string, opts?: { thumb?: boolean; maxBytes?: number }): Promise<{ data: Buffer; mime: string } | null>;
  /** id бота (известен после первого входа). */
  readonly userId: string | null;
}

interface Session {
  access: string;
  refresh: string;
  accessExp: number; // ms
  userId: string;
}

function jwtExpMs(token: string): number {
  try {
    const part = token.split(".")[1];
    if (!part) return 0;
    const payload = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as { exp?: number };
    return typeof payload.exp === "number" ? payload.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

export class EblushaApi implements ChatApi {
  private session: Session | null = null;
  private refreshing: Promise<Session> | null = null;

  constructor(
    readonly baseUrl: string,
    private readonly creds: { username: string; password: string },
    private readonly log: Logger,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  get userId(): string | null {
    return this.session?.userId ?? null;
  }

  private async ensureSession(force = false): Promise<Session> {
    const s = this.session;
    if (!force && s && s.accessExp - Date.now() > 60_000) return s;
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      try {
        if (s) {
          try {
            return await this.doRefresh(s);
          } catch (e) {
            this.log.warn("auth.refresh_failed", { err: e as Error });
          }
        }
        return await this.doLogin();
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  private async doLogin(): Promise<Session> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-native-client": "1" },
      body: JSON.stringify({ username: this.creds.username, password: this.creds.password, client: "eblusha-bot" }),
      signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
    });
    if (!res.ok) throw new ApiError(res.status, "/api/auth/login", null, `login failed: HTTP ${res.status}`);
    const j = (await res.json()) as { user: { id: string }; accessToken: string; refreshToken: string };
    const s: Session = {
      access: j.accessToken,
      refresh: j.refreshToken,
      accessExp: jwtExpMs(j.accessToken) || Date.now() + 10 * 60_000,
      userId: j.user.id,
    };
    this.session = s;
    this.log.info("auth.login_ok", { userId: s.userId });
    return s;
  }

  private async doRefresh(prev: Session): Promise<Session> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-native-client": "1" },
      body: JSON.stringify({ refreshToken: prev.refresh, client: "eblusha-bot" }),
      signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
    });
    if (!res.ok) throw new ApiError(res.status, "/api/auth/refresh", null, `refresh failed: HTTP ${res.status}`);
    const j = (await res.json()) as { accessToken: string; refreshToken: string };
    const s: Session = {
      access: j.accessToken,
      refresh: j.refreshToken,
      accessExp: jwtExpMs(j.accessToken) || Date.now() + 10 * 60_000,
      userId: prev.userId,
    };
    this.session = s;
    return s;
  }

  private async request<T>(method: string, path: string, body?: unknown, retried = false): Promise<T> {
    const s = await this.ensureSession();
    const init: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${s.access}`,
        ...(body !== undefined && !(body instanceof FormData) ? { "Content-Type": "application/json" } : {}),
      },
    };
    if (body !== undefined) init.body = body instanceof FormData ? body : JSON.stringify(body);
    // Без таймаута зависший backend держал бы очередь беседы (и обновление токена) вечно.
    init.signal = AbortSignal.timeout(body instanceof FormData ? UPLOAD_TIMEOUT_MS : REQUEST_TIMEOUT_MS);
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, init);
    if (res.status === 401 && !retried) {
      await this.ensureSession(true);
      return this.request<T>(method, path, body, true);
    }
    const text = await res.text();
    if (!res.ok) {
      let code: string | null = null;
      try {
        code = (JSON.parse(text) as { code?: string }).code ?? null;
      } catch {
        /* не JSON */
      }
      throw new ApiError(res.status, path, code, `HTTP ${res.status} ${method} ${path}${code ? ` (${code})` : ""}`);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  async me() {
    const j = await this.request<{ user: { id: string; displayName?: string | null; avatarUrl?: string | null; bio?: string | null } }>(
      "GET",
      "/api/status/me"
    );
    return {
      id: j.user.id,
      displayName: j.user.displayName ?? null,
      avatarUrl: j.user.avatarUrl ?? null,
      bio: j.user.bio ?? null,
    };
  }

  async updateMe(patch: { displayName?: string; bio?: string; avatarUrl?: string }): Promise<void> {
    await this.request("PATCH", "/api/status/me", patch);
  }

  async postMessage(input: BotPostInput): Promise<EbMessage> {
    const j = await this.request<{ message: EbMessage }>("POST", "/api/bot/messages", input);
    return j.message;
  }

  async typing(grant: string, typing: boolean): Promise<void> {
    await this.request("POST", "/api/bot/typing", { grant, typing });
  }

  async react(grant: string, messageId: string, emoji: string): Promise<void> {
    await this.request("POST", "/api/bot/react", { grant, messageId, emoji });
  }

  async upload(data: Buffer, filename: string, mime: string): Promise<UploadResult> {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(data)], { type: mime }), filename);
    return this.request<UploadResult>("POST", "/api/upload", form);
  }

  async fetchFile(url: string, opts: { thumb?: boolean; maxBytes?: number } = {}) {
    // Только свои файлы backend: относительный /api/files/… Чужие адреса сюда не попадают.
    if (!/^\/api\/files\/[A-Za-z0-9._\/-]+$/.test(url)) return null;
    const s = await this.ensureSession();
    const full = `${this.baseUrl}${url}${opts.thumb ? "?thumb=1" : ""}`;
    const res = await this.fetchImpl(full, { headers: { Authorization: `Bearer ${s.access}` }, signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS) });
    if (!res.ok) return null;
    const max = opts.maxBytes ?? 8 * 1024 * 1024;
    const len = Number(res.headers.get("content-length") ?? "0");
    if (len > max) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > max) return null;
    return { data: buf, mime: (res.headers.get("content-type") ?? "application/octet-stream").split(";")[0]!.trim() };
  }
}
