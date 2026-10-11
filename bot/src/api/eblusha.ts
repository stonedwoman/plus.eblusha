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
import {
  parseHistoryPage,
  type BotHistoryPage,
  type BotPeople,
  type BotPerson,
  type BotPostInput,
  type EbMessage,
  type PromiseCandidate,
  type PromiseSpecInput,
  type PromiseSummary,
  type PunctualityStats,
  type ShareEstimate,
  type ShareInfo,
  type SharePage,
  type SharePeriod,
  type UploadResult,
} from "./types";

const AUTH_TIMEOUT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 120_000;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly code: string | null,
    message: string,
    /** Тело ответа с ошибкой (JSON), если было: подробности кода (срок, таймер, кандидаты). */
    readonly body: Record<string, unknown> | null = null
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Таймер обещания: методы /api/bot/promises* (сервер rev ≥ 4; старый — 404). */
export interface PromisesApi {
  candidates(grant: string): Promise<PromiseCandidate[]>;
  create(input: {
    grant: string;
    promiserId?: string;
    /** Имя участника, как назвали (сервер найдёт среди участников беседы). */
    promiserName?: string;
    promiseMessageId?: string;
    text?: string;
    /** Сообщение, где сказаны слова времени (ответ на переспрос, обращение), если это не само обещание. */
    textMessageId?: string;
    spec?: PromiseSpecInput;
    cancelAllowedIds?: string[];
    confirmAmbiguous?: boolean;
    dryRun?: boolean;
  }): Promise<{ promise: PromiseSummary | { deadlineAt: string; label: string; upperBound: boolean }; cardMessageId?: string | null; dryRun?: boolean }>;
  extend(id: string, input: { grant: string; text?: string; spec?: PromiseSpecInput; sourceMessageId?: string }): Promise<PromiseSummary>;
  correct(id: string, input: { grant: string; text?: string; spec?: PromiseSpecInput }): Promise<PromiseSummary>;
  arrived(id: string, input: { grant?: string; via: "phrase" | "valheim"; at?: string; detail?: string }): Promise<PromiseSummary>;
  cancel(id: string, grant: string): Promise<PromiseSummary>;
  active(): Promise<Array<{ id: string; conversationId: string; promiserId: string; startAt: string; deadlineAt: string }>>;
  inConversation(grant: string): Promise<PromiseSummary[]>;
  stats(grant: string, input: { userId?: string; name?: string; board?: boolean }): Promise<{ stats?: PunctualityStats; board?: PunctualityStats[] }>;
}

/** «Поделиться перепиской»: методы /api/bot/share* (сервер rev ≥ 4; старый — 404). */
export interface ShareApi {
  estimate(grant: string): Promise<ShareEstimate>;
  request(input: {
    grant: string;
    suggest: { period: SharePeriod; photos: boolean };
    options?: Partial<Record<SharePeriod, { enabled: boolean; off?: "too_big" | "budget" | null }>>;
  }): Promise<{ share: ShareInfo; status?: "granted"; cardMessageId?: string | null }>;
  messages(id: string, input: { grant: string; after?: { at: string; id: string } | null; limit?: number; ids?: string[]; changesSince?: number | null }): Promise<SharePage>;
  status(id: string, grant: string): Promise<ShareInfo>;
  answered(id: string, input: { grant: string; messageIds: string[]; read: { messages: number; photos: number }; usd?: number }): Promise<ShareInfo>;
  reopen(id: string, input: { grant: string; off: { period: SharePeriod; reason: "too_big" | "budget" } }): Promise<ShareInfo>;
  revoke(grant: string): Promise<number>;
  choose(id: string, input: { grant: string; period?: SharePeriod; photos?: boolean; decline?: boolean }): Promise<ShareInfo>;
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
  /**
   * Долгое разрешение на ту же беседу (POST /api/bot/followup): отчёт о задаче, которая идёт дольше
   * жизни обычного разрешения (агент Valheim ждёт перезапуска). Брать, пока grant жив.
   */
  followup?(grant: string): Promise<{ grant: string; expiresAt: number }>;
  /**
   * Люди для привязки персонажей (POST /api/bot/people, по живому разрешению): участники беседы
   * обращения, поиск среди всех по имени/логину/EBLID (query), имена по id (ids). Старый сервер — 404.
   */
  people?(grant: string, input: { query?: string; ids?: string[] }): Promise<BotPeople>;
  /**
   * Память бота (POST /api/bot/history, контракт rev 3): страница его разговоров в беседе обращения после
   * курсора `after` и журнал изменений с changesSince. Старый сервер — 404 (бот туда и не ходит: rev < 3).
   */
  history?(grant: string, input: HistoryQuery): Promise<BotHistoryPage>;
  /** Таймер обещания (контракт rev 4). */
  promises?: PromisesApi;
  /** «Поделиться перепиской» (контракт rev 4). */
  share?: ShareApi;
  upload(data: Buffer, filename: string, mime: string): Promise<UploadResult>;
  /** Скачать вложение Еблуши (/api/files/…); thumb — серверное превью картинки. */
  fetchFile(url: string, opts?: { thumb?: boolean; maxBytes?: number }): Promise<{ data: Buffer; mime: string } | null>;
  /** id бота (известен после первого входа). */
  readonly userId: string | null;
}

export interface HistoryQuery {
  after?: { at: string; id: string } | null;
  /** 0..500; 0 — только журнал изменений. */
  limit?: number;
  changesSince?: number | null;
  epoch?: string | null;
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
      let body: Record<string, unknown> | null = null;
      try {
        body = JSON.parse(text) as Record<string, unknown>;
        code = typeof body.code === "string" ? body.code : null;
      } catch {
        /* не JSON */
      }
      throw new ApiError(res.status, path, code, `HTTP ${res.status} ${method} ${path}${code ? ` (${code})` : ""}`, body);
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

  async followup(grant: string): Promise<{ grant: string; expiresAt: number }> {
    const j = await this.request<{ grant: string; expiresAt: number }>("POST", "/api/bot/followup", { grant });
    return { grant: j.grant, expiresAt: Number(j.expiresAt) };
  }

  async people(grant: string, input: { query?: string; ids?: string[] }): Promise<BotPeople> {
    const j = await this.request<Partial<Record<keyof BotPeople, unknown>>>("POST", "/api/bot/people", {
      grant,
      ...(input.query ? { query: input.query.slice(0, 64) } : {}),
      ...(input.ids?.length ? { ids: input.ids.slice(0, 20) } : {}),
    });
    const list = (v: unknown): BotPerson[] =>
      (Array.isArray(v) ? v : [])
        .map((x) => x as Record<string, unknown>)
        .filter((x) => x && typeof x.id === "string" && x.id.length > 0)
        .map((x) => ({
          id: x.id as string,
          displayName: typeof x.displayName === "string" ? x.displayName : null,
          eblid: typeof x.eblid === "string" ? x.eblid : null,
          inConversation: x.inConversation === true,
          ...(x.matchedBy === "name" || x.matchedBy === "username" || x.matchedBy === "eblid" ? { matchedBy: x.matchedBy } : {}),
        }));
    return { participants: list(j.participants), matches: list(j.matches), users: list(j.users), truncated: j.truncated === true };
  }

  async history(grant: string, input: HistoryQuery): Promise<BotHistoryPage> {
    const j = await this.request<unknown>("POST", "/api/bot/history", {
      grant,
      ...(input.after ? { after: { at: input.after.at, id: input.after.id } } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
      ...(input.changesSince !== undefined && input.changesSince !== null ? { changesSince: input.changesSince } : {}),
      ...(input.epoch ? { epoch: input.epoch } : {}),
    });
    const page = parseHistoryPage(j);
    if (!page) throw new ApiError(502, "/api/bot/history", "BAD_REPLY", "history: unexpected reply");
    return page;
  }

  readonly promises: PromisesApi = {
    candidates: async (grant) => (await this.request<{ candidates: PromiseCandidate[] }>("POST", "/api/bot/promises/candidates", { grant })).candidates ?? [],
    create: async (input) => this.request("POST", "/api/bot/promises", input),
    extend: async (id, input) => (await this.request<{ promise: PromiseSummary }>("POST", `/api/bot/promises/${encodeURIComponent(id)}/extend`, input)).promise,
    correct: async (id, input) => (await this.request<{ promise: PromiseSummary }>("POST", `/api/bot/promises/${encodeURIComponent(id)}/correct`, input)).promise,
    arrived: async (id, input) => (await this.request<{ promise: PromiseSummary }>("POST", `/api/bot/promises/${encodeURIComponent(id)}/arrived`, input)).promise,
    cancel: async (id, grant) => (await this.request<{ promise: PromiseSummary }>("POST", `/api/bot/promises/${encodeURIComponent(id)}/cancel`, { grant })).promise,
    active: async () => (await this.request<{ promises: Array<{ id: string; conversationId: string; promiserId: string; startAt: string; deadlineAt: string }> }>("GET", "/api/bot/promises/active")).promises ?? [],
    inConversation: async (grant) => (await this.request<{ promises: PromiseSummary[] }>("POST", "/api/bot/promises/in-conversation", { grant })).promises ?? [],
    stats: async (grant, input) => this.request("POST", "/api/bot/promises/stats", { grant, ...input }),
  };

  readonly share: ShareApi = {
    estimate: async (grant) => this.request<ShareEstimate>("POST", "/api/bot/share/estimate", { grant }),
    request: async (input) => this.request("POST", "/api/bot/share/request", input),
    messages: async (id, input) => this.request<SharePage>("POST", `/api/bot/share/${encodeURIComponent(id)}/messages`, input),
    status: async (id, grant) => (await this.request<{ share: ShareInfo }>("POST", `/api/bot/share/${encodeURIComponent(id)}/status`, { grant })).share,
    answered: async (id, input) => (await this.request<{ share: ShareInfo }>("POST", `/api/bot/share/${encodeURIComponent(id)}/answered`, input)).share,
    reopen: async (id, input) => (await this.request<{ share: ShareInfo }>("POST", `/api/bot/share/${encodeURIComponent(id)}/reopen`, input)).share,
    revoke: async (grant) => (await this.request<{ revoked: number }>("POST", "/api/bot/share/revoke", { grant })).revoked ?? 0,
    choose: async (id, input) => (await this.request<{ share: ShareInfo }>("POST", `/api/bot/share/${encodeURIComponent(id)}/choose`, input)).share,
  };

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
