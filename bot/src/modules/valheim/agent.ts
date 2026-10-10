/**
 * Клиент API агента администрирования Valheim (/DATA/valheim-agent, контракт v1 —
 * /DATA/valheim-agent/docs/API.md): 127.0.0.1:3013 на хосте stoned (у бота network_mode: host),
 * заголовок X-Agent-Token из файла (в контейнере бота — смонтированный только на чтение).
 *
 * Агент только планирует, выполняет и отчитывается; КТО может просить и подтверждать, решает бот
 * (решение владельца: любой привязанный игрок). Агент пишет в журнал, кто попросил / подтвердил /
 * отменил / откатил — поэтому в каждом вызове есть человек {userId, character}.
 */
import fs from "node:fs";

/** fetch для агента (тесты подставляют свой). */
export type AgentFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }
) => Promise<{ status: number; text(): Promise<string> }>;

export interface AgentPerson {
  userId: string;
  character: string | null;
}

export type AgentStatus =
  | "planning"
  | "planned"
  | "answered"
  | "error"
  | "cancelled"
  | "expired"
  | "executing"
  | "waiting_restart"
  | "verifying"
  | "done"
  | "applied"
  | "failed"
  | "undoing"
  | "undone"
  | "undo_failed";

export interface AgentChange {
  id: string;
  kind: "world_key" | "file_replace" | "file_write" | "mod_install" | "mod_remove" | "backup_world" | string;
  /** Описание изменения — собрано КОДОМ агента ровно по тому, что будет выполнено. Его и показываем. */
  description_ru: string;
  why_ru?: string;
  diff?: string;
  dependencies?: string[];
  [k: string]: unknown;
}

export interface AgentPlan {
  summary_ru: string;
  changes: AgentChange[];
  affects: string;
  restart: "none" | "when_empty" | "now_warn" | string;
  risk: "low" | "medium" | "high" | string;
  notes_ru: string | null;
}

export interface AgentRestartInfo {
  requested?: string;
  effective?: string | null;
  note_ru?: string | null;
  seenBoot?: string | null;
}

export interface AgentTask {
  taskId: string;
  status: AgentStatus;
  target: string;
  createdAt: string;
  updatedAt: string;
  requester: AgentPerson;
  text: string;
  answer_ru: string | null;
  error: string | null;
  plan: AgentPlan | null;
  planExpiresAt: string | null;
  confirmer: AgentPerson | null;
  confirmedAt: string | null;
  cancelledBy: AgentPerson | null;
  report_ru: string | null;
  execution: {
    finishedAt?: string | null;
    worldBackup?: { id: string } | null;
    restart?: AgentRestartInfo | null;
    checks?: Array<{ ok: boolean; warn?: boolean; text_ru: string }>;
  } | null;
  undo: {
    requester: AgentPerson;
    finishedAt?: string | null;
    restart?: AgentRestartInfo | null;
    report_ru: string | null;
  } | null;
  costUsd: number;
  canConfirm: boolean;
  canUndo: boolean;
}

export interface AgentTaskSummary {
  taskId: string;
  status: AgentStatus;
  createdAt: string;
  requester: AgentPerson;
  text: string;
  summary_ru: string | null;
  changes: number;
  restart: string | null;
  confirmer: AgentPerson | null;
  undoneBy: AgentPerson | null;
}

export interface AgentHealth {
  ok: boolean;
  target: string;
  model?: string;
  budget?: { spentUsd: number; limitUsd: number };
  planning?: number;
}

/** Ответ агента с ошибкой: status — HTTP, code — `error` из тела (busy, expired, not_planned, wrong_target…). */
export class AgentError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "AgentError";
  }
}

/** Агент не настроен, не запущен или не отвечает. */
export class AgentUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentUnavailable";
  }
}

export interface AgentClientLike {
  health(): Promise<AgentHealth>;
  createTask(requester: AgentPerson, text: string, waitMs?: number): Promise<AgentTask>;
  getTask(id: string): Promise<AgentTask>;
  listTasks(limit?: number): Promise<AgentTaskSummary[]>;
  confirm(id: string, confirmer: AgentPerson): Promise<AgentTask>;
  cancel(id: string, by: AgentPerson): Promise<AgentTask>;
  undo(id: string, requester: AgentPerson): Promise<AgentTask>;
}

const TASK_ID_RE = /^t\d{8}-\d{6}-[0-9a-f]{4}$/;

export function isTaskId(v: unknown): v is string {
  return typeof v === "string" && TASK_ID_RE.test(v);
}

export class AgentClient implements AgentClientLike {
  private token: string | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly tokenFile: string | null,
    private readonly fetchImpl: AgentFetch = (u, i) => fetch(u, i),
    private readonly readFile: (p: string) => string = (p) => fs.readFileSync(p, "utf8")
  ) {}

  private readToken(force = false): string {
    if (this.token && !force) return this.token;
    if (!this.tokenFile) throw new AgentUnavailable("токен агента не настроен (VALHEIM_AGENT_TOKEN_FILE)");
    let t = "";
    try {
      t = this.readFile(this.tokenFile).trim();
    } catch {
      throw new AgentUnavailable("токен агента не читается");
    }
    if (t.length < 16) throw new AgentUnavailable("токен агента пустой");
    this.token = t;
    return t;
  }

  private async call<T>(method: "GET" | "POST", path: string, body?: unknown, timeoutMs = 20_000, retried = false): Promise<T> {
    const token = this.readToken(retried);
    let res;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: { "X-Agent-Token": token, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new AgentUnavailable(`агент не отвечает (${(e as Error).name === "TimeoutError" ? "таймаут" : "нет связи"})`);
    }
    // Токен сменили (агент переустановлен) — перечитать файл один раз.
    if (res.status === 401 && !retried) return this.call<T>(method, path, body, timeoutMs, true);
    const text = await res.text();
    let j: Record<string, unknown> = {};
    try {
      j = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      throw new AgentUnavailable(`агент ответил не JSON (HTTP ${res.status})`);
    }
    if (res.status >= 400) {
      if (res.status === 401) throw new AgentUnavailable("агент не принял токен");
      const code = typeof j.error === "string" ? j.error : `http_${res.status}`;
      const msg = typeof j.message === "string" ? j.message : `HTTP ${res.status}`;
      throw new AgentError(res.status, code, msg);
    }
    return j as T;
  }

  health(): Promise<AgentHealth> {
    return this.call<AgentHealth>("GET", "/health", undefined, 8_000);
  }

  createTask(requester: AgentPerson, text: string, waitMs = 0): Promise<AgentTask> {
    return this.call<AgentTask>("POST", "/tasks", { requester, text: text.slice(0, 2000), waitMs }, Math.max(20_000, waitMs + 15_000));
  }

  getTask(id: string): Promise<AgentTask> {
    if (!isTaskId(id)) return Promise.reject(new AgentError(404, "not_found", "нет такой задачи"));
    return this.call<AgentTask>("GET", `/tasks/${id}`);
  }

  async listTasks(limit = 20): Promise<AgentTaskSummary[]> {
    const j = await this.call<{ tasks?: AgentTaskSummary[] }>("GET", `/tasks?limit=${Math.max(1, Math.min(200, Math.floor(limit)))}`);
    return Array.isArray(j.tasks) ? j.tasks : [];
  }

  confirm(id: string, confirmer: AgentPerson): Promise<AgentTask> {
    if (!isTaskId(id)) return Promise.reject(new AgentError(404, "not_found", "нет такой задачи"));
    return this.call<AgentTask>("POST", `/tasks/${id}/confirm`, { confirmer });
  }

  cancel(id: string, by: AgentPerson): Promise<AgentTask> {
    if (!isTaskId(id)) return Promise.reject(new AgentError(404, "not_found", "нет такой задачи"));
    return this.call<AgentTask>("POST", `/tasks/${id}/cancel`, { by });
  }

  undo(id: string, requester: AgentPerson): Promise<AgentTask> {
    if (!isTaskId(id)) return Promise.reject(new AgentError(404, "not_found", "нет такой задачи"));
    return this.call<AgentTask>("POST", `/tasks/${id}/undo`, { requester });
  }
}
