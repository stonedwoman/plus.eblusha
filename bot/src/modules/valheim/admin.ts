/**
 * Свободные просьбы к серверу Valheim через агента администрирования (/DATA/valheim-agent).
 *
 * Решения владельца 2026-10-10 (DECISIONS-system-bot.md п. 8–11):
 *   - ЛЮБОЙ привязанный игрок просит словами («включи бесплатный крафт», «перезапусти, когда все
 *     выйдут», «сделай бэкап», «дай Сане админку») — модель сама решает, просьба это или вопрос, и
 *     передаёт просьбу инструментом admin_request (POST /tasks агента);
 *   - агент присылает ПЛАН; бот показывает его отдельным сообщением: список изменений из
 *     plan.changes[].description_ru (собран кодом агента — не пересказ модели), на кого действует,
 *     нужен ли перезапуск, риск, и внизу «Ответьте «да», чтобы применить, или «нет»»;
 *   - ЛЮБОЙ привязанный игрок подтверждает ответом «да» на план (POST /tasks/:id/confirm), «нет» —
 *     отмена; непривязанным — вежливый отказ; устаревший план — сказать и предложить заново;
 *   - отчёт о выполнении (report_ru, перезапуск) — отдельным сообщением в ту же беседу, когда задача
 *     завершится (может ждать, пока все выйдут с сервера, — до 49 ч: для этого «долгое разрешение»
 *     сервера, ConversationHandle.followup);
 *   - «верни как было» ответом на отчёт (или фразой — последняя задача этой беседы) — откат;
 *   - команд нет: состояние сервера — инструмент server_status («как там сервер?»).
 *
 * Модель ничего не подтверждает и не выполняет: подтверждение — только кодом по ответу человека.
 * Журнал — без текста сообщений и просьб (только id задач, статусы, длины).
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Logger } from "../../log";
import { playerDataVisible } from "../../core/registry";
import type { BotTool, ConversationHandle, ConversationRef, CoreServices, InterceptInput, Requester, ToolContext } from "../api";
import { AgentError, AgentUnavailable, type AgentClientLike, type AgentPerson, type AgentTask } from "./agent";
import { OpsUnavailable, type OpsClientLike, type OpsStatus } from "./ops";
import type { VhWorld } from "./world";

// ─────────────────────────────────────────────── распознавание ответов людей

/** Нормализация короткой реплики: регистр, ё, лишние пробелы. */
function norm(text: string): string {
  return text.toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();
}

const YES_WORDS =
  "да|ага|угу|ок|окей|ok|okay|yes|yep|применяй|применяйте|примени|применить|применяем|подтверждаю|подтверждаем|давай|давайте|го|гоу|делай|делайте|сделай|конечно|погнали|вперед|валяй|жми|можно|согласен|согласна|разрешаю|поехали";
const NO_WORDS = "нет|неа|no|nope|не надо|не нужно|не делай|не применяй|не стоит|отмена|отмени|отмените|отменить|отменяй|отбой|стоп|не";
const YES_RE = new RegExp(`^(?:(?:${YES_WORDS})(?:[\\s,.!)]+|$))+$`, "u");
const NO_RE = new RegExp(`^(?:(?:${NO_WORDS})(?:[\\s,.!)]+|$))+$`, "u");
export const UNDO_RE =
  /^(?:пожалуйста[\s,]+)?(?:(?:верни|вернуть|верните|вертай)(?:\s+(?:все|это|пожалуйста|настройки|обратно))*\s+(?:как\s+было|обратно|назад)|откат(?:и|ить|ите)?(?:\s+(?:все|это|изменения|назад|обратно|пожалуйста))*|отмени(?:те)?\s+(?:изменения|это\s+изменение))(?:[\s,]+(?:пожалуйста|плиз|pls))?[\s.!]*$/u;

export type AdminIntent = "yes" | "no" | "undo";

/** Короткий ответ на план/отчёт: «да» / «нет» / «верни как было» или null (это вопрос — модели). */
export function classifyIntent(text: string): AdminIntent | null {
  const t = norm(text);
  if (!t || t.length > 60) return null;
  if (UNDO_RE.test(t)) return "undo";
  if (YES_RE.test(t)) return "yes";
  if (NO_RE.test(t)) return "no";
  return null;
}

// ─────────────────────────────────────────────── состояние (SQLite)

/**
 * Чьё это сообщение бота: plan — план (ждёт «да»/«нет»); ack — короткий ответ модели при передаче
 * просьбы («сейчас разберусь — пришлю план»); progress — «применяю»/«ждёт перезапуска»; report — отчёт;
 * undo — отчёт об откате; note — ответ агента без изменений.
 */
export type MsgRole = "plan" | "ack" | "progress" | "report" | "undo" | "note";
export type WatchMode = "plan" | "apply" | "undo";
export type TaskState = "planning" | "planned" | "closed";

export interface TaskRow {
  taskId: string;
  conversationId: string;
  convKind: "bot" | "dm" | "group";
  requesterId: string;
  requesterName: string;
  requestMessageId: string;
  createdAt: number;
  state: TaskState;
  planAt: number | null;
}

export interface WatchRow {
  taskId: string;
  mode: WatchMode;
  grant: string;
  grantExpiresAt: number;
  /** Разрешение — «продолжение» (followup): из него новое продолжение не взять. */
  followup: boolean;
  conversationId: string;
  convKind: "bot" | "dm" | "group";
  triggerMessageId: string;
  /** На какое сообщение отвечать (просьба / «да» / «верни как было»). */
  replyToId: string | null;
  /** Кто подтвердил / попросил откат — для отчёта. */
  who: string | null;
  /** 0 — ничего не сказано; 1 — «применяю»; 2 — «ждёт перезапуска». */
  stage: number;
  startedAt: number;
}

export class AdminStore {
  private readonly db: DatabaseSync;

  constructor(file: string) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 3000;
      CREATE TABLE IF NOT EXISTS admin_tasks (
        task_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        conv_kind TEXT NOT NULL,
        requester_id TEXT NOT NULL,
        requester_name TEXT NOT NULL,
        request_message_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        state TEXT NOT NULL,
        plan_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS admin_tasks_conv ON admin_tasks(conversation_id, created_at);
      CREATE TABLE IF NOT EXISTS admin_msgs (
        message_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        role TEXT NOT NULL,
        at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS admin_watch (
        task_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        grant_token TEXT NOT NULL,
        grant_expires_at INTEGER NOT NULL,
        followup INTEGER NOT NULL,
        conversation_id TEXT NOT NULL,
        conv_kind TEXT NOT NULL,
        trigger_message_id TEXT NOT NULL,
        reply_to_id TEXT,
        who TEXT,
        stage INTEGER NOT NULL,
        started_at INTEGER NOT NULL,
        done INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (task_id, mode)
      );
      CREATE TABLE IF NOT EXISTS admin_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        day TEXT NOT NULL,
        at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS admin_requests_day ON admin_requests(day, user_id);
    `);
  }

  close(): void {
    this.db.close();
  }

  addTask(t: TaskRow): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO admin_tasks (task_id, conversation_id, conv_kind, requester_id, requester_name, request_message_id, created_at, state, plan_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(t.taskId, t.conversationId, t.convKind, t.requesterId, t.requesterName, t.requestMessageId, t.createdAt, t.state, t.planAt);
  }

  task(taskId: string): TaskRow | null {
    const r = this.db.prepare(`SELECT * FROM admin_tasks WHERE task_id = ?`).get(taskId) as Record<string, unknown> | undefined;
    return r ? taskRow(r) : null;
  }

  setState(taskId: string, state: TaskState, planAt?: number): void {
    if (planAt !== undefined) this.db.prepare(`UPDATE admin_tasks SET state = ?, plan_at = ? WHERE task_id = ?`).run(state, planAt, taskId);
    else this.db.prepare(`UPDATE admin_tasks SET state = ? WHERE task_id = ?`).run(state, taskId);
  }

  /** Задачи беседы, новые первыми. */
  tasksIn(conversationId: string, limit = 5): TaskRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM admin_tasks WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(conversationId, limit) as Array<Record<string, unknown>>;
    return rows.map(taskRow);
  }

  addMessages(taskId: string, ids: string[], role: MsgRole, at: number): void {
    const st = this.db.prepare(`INSERT OR REPLACE INTO admin_msgs (message_id, task_id, role, at) VALUES (?, ?, ?, ?)`);
    for (const id of ids) st.run(id, taskId, role, at);
  }

  messageTask(messageId: string): { taskId: string; role: MsgRole } | null {
    const r = this.db.prepare(`SELECT task_id, role FROM admin_msgs WHERE message_id = ?`).get(messageId) as { task_id: string; role: string } | undefined;
    return r ? { taskId: r.task_id, role: r.role as MsgRole } : null;
  }

  upsertWatch(w: WatchRow): void {
    this.db
      .prepare(
        `INSERT INTO admin_watch (task_id, mode, grant_token, grant_expires_at, followup, conversation_id, conv_kind, trigger_message_id, reply_to_id, who, stage, started_at, done)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
         ON CONFLICT(task_id, mode) DO UPDATE SET grant_token = excluded.grant_token, grant_expires_at = excluded.grant_expires_at,
           followup = excluded.followup, conversation_id = excluded.conversation_id, conv_kind = excluded.conv_kind,
           trigger_message_id = excluded.trigger_message_id, reply_to_id = excluded.reply_to_id, who = excluded.who,
           stage = excluded.stage, started_at = excluded.started_at, done = 0`
      )
      .run(w.taskId, w.mode, w.grant, w.grantExpiresAt, w.followup ? 1 : 0, w.conversationId, w.convKind, w.triggerMessageId, w.replyToId, w.who, w.stage, w.startedAt);
  }

  setWatchStage(taskId: string, mode: WatchMode, stage: number): void {
    this.db.prepare(`UPDATE admin_watch SET stage = ? WHERE task_id = ? AND mode = ?`).run(stage, taskId, mode);
  }

  finishWatch(taskId: string, mode: WatchMode): void {
    this.db.prepare(`UPDATE admin_watch SET done = 1, grant_token = '' WHERE task_id = ? AND mode = ?`).run(taskId, mode);
  }

  openWatches(): WatchRow[] {
    const rows = this.db.prepare(`SELECT * FROM admin_watch WHERE done = 0 ORDER BY started_at`).all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      taskId: String(r.task_id),
      mode: String(r.mode) as WatchMode,
      grant: String(r.grant_token),
      grantExpiresAt: Number(r.grant_expires_at),
      followup: Number(r.followup) === 1,
      conversationId: String(r.conversation_id),
      convKind: String(r.conv_kind) as WatchRow["convKind"],
      triggerMessageId: String(r.trigger_message_id),
      replyToId: r.reply_to_id === null ? null : String(r.reply_to_id),
      who: r.who === null ? null : String(r.who),
      stage: Number(r.stage),
      startedAt: Number(r.started_at),
    }));
  }

  countRequests(userId: string, day: string): number {
    const r = this.db.prepare(`SELECT COUNT(*) AS n FROM admin_requests WHERE day = ? AND user_id = ?`).get(day, userId) as { n: number };
    return Number(r.n) || 0;
  }

  addRequest(userId: string, day: string, at: number): void {
    this.db.prepare(`INSERT INTO admin_requests (user_id, day, at) VALUES (?, ?, ?)`).run(userId, day, at);
  }
}

function taskRow(r: Record<string, unknown>): TaskRow {
  return {
    taskId: String(r.task_id),
    conversationId: String(r.conversation_id),
    convKind: String(r.conv_kind) as TaskRow["convKind"],
    requesterId: String(r.requester_id),
    requesterName: String(r.requester_name),
    requestMessageId: String(r.request_message_id),
    createdAt: Number(r.created_at),
    state: String(r.state) as TaskState,
    planAt: r.plan_at === null || r.plan_at === undefined ? null : Number(r.plan_at),
  };
}

// ─────────────────────────────────────────────── оформление (кодом, не моделью)

/** Текст агента абзацами (ответ без изменений): без ссылок-обманок, не длиннее max. */
export function para(s: string | null | undefined, max = 3000): string {
  let v = String(s ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/\[([^\]]*)\]\(([^)]*)\)/g, "$1 ($2)")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (v.length > max) v = `${v.slice(0, max - 1).trimEnd()}…`;
  return v;
}

/** Строка из данных агента — в одну строку, без разметки-ссылок и выделения. */
export function plain(s: string | null | undefined, max = 300): string {
  let v = String(s ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\[([^\]]*)\]\(([^)]*)\)/g, "$1 ($2)")
    .replace(/[*`_~]{2,}/g, "")
    .replace(/`/g, "'")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (v.length > max) v = `${v.slice(0, max - 1).trimEnd()}…`;
  return v;
}

const SECRET_LINE = /^([+-]?\s*[\w. -]*?(?:token|password|passwd|secret|webhook|api[_-]?key)[\w. -]*?\s*[=:]\s*)(\S.*)$/i;

/** Изменённые строки диффа (без заголовков), секреты скрыты; null — нечего показать. */
export function diffLines(diff: string | undefined, maxLines: number): string[] {
  if (!diff) return [];
  const out: string[] = [];
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++") || raw.startsWith("---") || raw.startsWith("@@")) continue;
    if (!raw.startsWith("+") && !raw.startsWith("-")) continue;
    let line = raw.replace(/```/g, "'''");
    line = line.replace(SECRET_LINE, "$1<скрыто>");
    if (line.length > 120) line = `${line.slice(0, 119)}…`;
    out.push(line);
    if (out.length >= maxLines) break;
  }
  return out;
}

const RISK_RU: Record<string, string> = { low: "низкий", medium: "средний", high: "**высокий**" };

export function restartPlanText(restart: string): string {
  if (restart === "none") return "не нужен";
  if (restart === "when_empty") return "нужен — когда на сервере никого не будет";
  if (restart === "now_warn") return "нужен — сразу, если на сервере пусто; если кто-то играет — когда все выйдут";
  return plain(restart, 60);
}

export function affectsText(affects: string): string {
  if (!affects || affects === "all") return "все игроки сервера";
  const m = /^player:(.+)$/.exec(affects);
  return m ? `только ${plain(m[1], 60)}` : plain(affects, 80);
}

function personName(p: AgentPerson | null | undefined, fallback: string | null = null): string {
  return plain(p?.character || fallback || "игрок", 60);
}

/** Предел длины плана: одно сообщение (splitMessage режет на 3800) — «Да»/«Нет» под одним сообщением. */
export const PLAN_MAX_CHARS = 3700;

/**
 * Сообщение с планом. Всё, что меняется, — из description_ru (код агента). Всегда одно сообщение:
 * не влезает — сначала без строк диффа, потом с короче пояснением агента.
 */
export function formatPlan(task: AgentTask, opts: { requesterName: string | null; isTest: boolean }): string {
  const full = buildPlan(task, opts, { diffs: true, summaryMax: 600, notesMax: 400 });
  if (full.length <= PLAN_MAX_CHARS) return full;
  const noDiff = buildPlan(task, opts, { diffs: false, summaryMax: 600, notesMax: 400 });
  if (noDiff.length <= PLAN_MAX_CHARS) return noDiff;
  return buildPlan(task, opts, { diffs: false, summaryMax: 200, notesMax: 150 });
}

function buildPlan(task: AgentTask, opts: { requesterName: string | null; isTest: boolean }, lim: { diffs: boolean; summaryMax: number; notesMax: number }): string {
  const plan = task.plan!;
  const lines: string[] = [];
  lines.push(`**План для сервера Valheim** — просьба ${personName(task.requester, opts.requesterName)}: «${plain(task.text, 200)}»`);
  lines.push("", "**Что поменяю:**");
  let used = 0;
  let shown = 0;
  for (const c of plan.changes) {
    const deps = Array.isArray(c.dependencies) && c.dependencies.length ? `; зависимости: ${c.dependencies.slice(0, 6).map((d) => plain(String(d), 60)).join(", ")}` : "";
    const line = `- ${plain(c.description_ru, 260)}${deps}`;
    if (used + line.length > 2200) break;
    lines.push(line);
    used += line.length;
    shown++;
  }
  if (shown < plan.changes.length) lines.push(`- …и ещё ${plan.changes.length - shown}`);
  if (plan.changes.length === 0) lines.push("- (изменений в плане нет)");
  const diffs: string[] = [];
  for (const c of lim.diffs ? plan.changes : []) {
    if (diffs.length >= 8) break;
    diffs.push(...diffLines(typeof c.diff === "string" ? c.diff : undefined, 8 - diffs.length));
  }
  if (diffs.length) lines.push("", "Правки в файлах:", "```", ...diffs, "```");
  lines.push("");
  lines.push(`**На кого действует:** ${affectsText(plan.affects)}`);
  lines.push(`**Перезапуск сервера:** ${restartPlanText(plan.restart)}`);
  lines.push(`**Риск:** ${RISK_RU[plan.risk] ?? plain(plan.risk, 20)}`);
  lines.push("Перед изменениями агент сделает бэкап мира; откатить можно ответом «верни как было» на отчёт.");
  if (opts.isTest) lines.push("⚠️ Сейчас агент работает с **тестовым стендом**, а не с боевым сервером.");
  if (plan.summary_ru) lines.push("", `Пояснение агента: ${plain(plan.summary_ru, lim.summaryMax)}`);
  if (plan.notes_ru) lines.push(`Заметка агента: ${plain(plan.notes_ru, lim.notesMax)}`);
  lines.push("", "Подтвердить может любой привязанный игрок; план действует час.");
  lines.push("Ответьте «да», чтобы применить, или «нет».");
  return lines.join("\n");
}

/** Строки отчёта агента (report_ru) — без первой строки и без «откат по задаче …», с метками ✅/❗/⚠️. */
function reportBody(report: string | null | undefined): string[] {
  const out: string[] = [];
  const src = String(report ?? "").split("\n");
  for (let i = 1; i < src.length; i++) {
    const raw = src[i]!.trimEnd();
    if (!raw.trim()) continue;
    if (/^Вернуть как было — «откат» по задаче/.test(raw)) continue;
    if (/^(Что сделано|Проверка):$/.test(raw)) {
      out.push(`**${raw}**`);
      continue;
    }
    const m = /^-\s+(\[(ok|!|\?)\]\s+)?(.*)$/.exec(raw);
    if (m) {
      const mark = m[2] === "ok" ? "✅ " : m[2] === "!" ? "❗ " : m[2] === "?" ? "⚠️ " : "";
      out.push(`- ${mark}${plain(m[3], 300)}`);
      continue;
    }
    out.push(plain(raw, 600));
  }
  return out.slice(0, 40);
}

export function restartResultText(task: AgentTask, mode: "apply" | "undo"): string | null {
  const r = mode === "apply" ? task.execution?.restart : task.undo?.restart;
  const planned = task.plan?.restart ?? "none";
  if (mode === "apply" && planned === "none" && !r) return "не нужен";
  if (!r) return mode === "undo" ? null : "не нужен";
  const note = r.note_ru ? ` (${plain(r.note_ru, 200)})` : "";
  if (r.seenBoot) return "был — сервер поднялся";
  if (task.status === "waiting_restart" || (mode === "undo" && task.status === "undoing")) {
    return `ждёт: ${r.effective === "now" ? "сервер перезапускается" : "когда на сервере никого не будет"}${note}`;
  }
  if (task.status === "applied") return `не состоялся — изменения заработают при следующем перезапуске${note}`;
  return `не состоялся${note}`;
}

/** Шапка + строки отчёта агента + хвост — одним сообщением (≤ PLAN_MAX_CHARS): лишние строки — «…». */
function fitReport(head: string[], body: string[], tail: string[]): string {
  let used = [...head, ...tail].join("\n").length + 8;
  const kept: string[] = [];
  for (const l of body) {
    if (used + l.length + 1 > PLAN_MAX_CHARS) {
      kept.push("- …");
      break;
    }
    kept.push(l);
    used += l.length + 1;
  }
  return [...head, ...kept, ...tail].join("\n");
}

export function formatReport(task: AgentTask, who: string | null): string {
  const head: Record<string, string> = {
    done: "✅ **Готово.**",
    applied: "✅ **Изменения применены**, но перезапуска сервера не было.",
    failed: "❗ **Не получилось.**",
  };
  const lines = [head[task.status] ?? `**Задача: ${statusText(task)}.**`];
  lines.push(`Просьба: «${plain(task.text, 160)}» — ${personName(task.requester)}${task.confirmer ? `; подтвердил(а) ${personName(task.confirmer, who)}` : ""}.`);
  const tail: string[] = [];
  const rs = restartResultText(task, "apply");
  if (rs) tail.push(`**Перезапуск:** ${rs}`);
  if (task.canUndo) tail.push("", "Вернуть как было — ответьте на это сообщение «верни как было».");
  return fitReport(lines, reportBody(task.report_ru), tail);
}

export function formatUndoReport(task: AgentTask): string {
  const ok = task.status === "undone";
  const lines = [ok ? "↩️ **Вернул как было.**" : "❗ **Откат выполнен не полностью.**"];
  lines.push(`Задача: «${plain(task.text, 160)}»${task.undo?.requester ? `; откат попросил(а) ${personName(task.undo.requester)}` : ""}.`);
  const rs = restartResultText(task, "undo");
  return fitReport(lines, reportBody(task.undo?.report_ru), rs ? [`**Перезапуск:** ${rs}`] : []);
}

export function statusText(t: Pick<AgentTask, "status" | "confirmer" | "cancelledBy" | "error">): string {
  switch (t.status) {
    case "planning":
      return "агент ещё составляет план";
    case "planned":
      return "план ждёт ответа «да» или «нет»";
    case "answered":
      return "агент ответил без изменений";
    case "error":
      return `ошибка${t.error ? `: ${plain(t.error, 200)}` : ""}`;
    case "cancelled":
      return `план отменён${t.cancelledBy ? ` (${personName(t.cancelledBy)})` : ""}`;
    case "expired":
      return "план устарел";
    case "executing":
      return "выполняется";
    case "waiting_restart":
      return "изменения на месте, ждём перезапуска сервера";
    case "verifying":
      return "идёт проверка";
    case "done":
      return "готово";
    case "applied":
      return "применено, но перезапуска не было";
    case "failed":
      return "не получилось";
    case "undoing":
      return "идёт откат";
    case "undone":
      return "откачено — всё как было";
    case "undo_failed":
      return "откат прошёл не полностью";
    default:
      return plain(String(t.status), 40);
  }
}

const APPLY_DONE = new Set(["done", "applied", "failed", "undoing", "undone", "undo_failed"]);
const UNDO_DONE = new Set(["undone", "undo_failed"]);

function isFinal(mode: WatchMode, t: AgentTask): boolean {
  if (mode === "plan") return t.status !== "planning";
  if (mode === "apply") return APPLY_DONE.has(t.status) || t.status === "cancelled" || t.status === "expired" || t.status === "error";
  return UNDO_DONE.has(t.status) || !["undoing"].includes(t.status);
}

// ─────────────────────────────────────────────── сам модуль

export interface AdminOptions {
  agent: AgentClientLike | null;
  ops?: OpsClientLike | null;
  world?: VhWorld | null;
  /** Своё хранилище (тесты); иначе — valheim-admin.sqlite в каталоге данных бота. */
  store?: AdminStore;
  now?: () => number;
  /** Шаг опроса агента, мс (дальше реже: ×5 после 2 мин, ×20 после 30 мин). */
  pollMs?: number;
  /** Просьб агенту на человека в сутки (владельца не касается). */
  userDailyRequests?: number;
  timeZone?: string;
  sleep?: (ms: number) => Promise<void>;
}

const UNLINKED_TEXT =
  "Подтверждать и отменять планы для сервера могут только игроки — люди, привязанные к персонажу. Привяжи свой ник: «Еблуша, мой ник в игре …».";
const UNAVAILABLE_TEXT = "Администратор сервера сейчас недоступен — попробуйте чуть позже.";
/** Через сколько шагов опроса без итога сказать «применяю» (≈ 20 с при шаге 3 с). */
const ACK_AFTER_POLLS = 7;
const PLAN_TTL_MS = 60 * 60_000;

function personOf(r: Requester): AgentPerson {
  return { userId: r.userId.slice(0, 100), character: r.characters[0] ? r.characters[0].slice(0, 60) : null };
}

function utcDay(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

export class ValheimAdmin {
  private core: CoreServices | null = null;
  private store: AdminStore | null;
  private readonly active = new Map<string, Promise<void>>();
  /** Обращения, по которым в этом ответе уже ушла просьба (одна за ответ). */
  private readonly askedIn = new Set<string>();
  private stopped = false;
  private readonly now: () => number;
  private readonly pollMs: number;
  /** Спящие наблюдения: stop() будит их, чтобы не ждать до минуты. */
  private readonly sleepers = new Set<() => void>();
  /** Цель агента (test/live) — по последнему ответу; для пометки «тестовый стенд». */
  private target: string | null = null;

  constructor(private readonly o: AdminOptions) {
    this.store = o.store ?? null;
    this.now = o.now ?? Date.now;
    this.pollMs = o.pollMs ?? 3000;

  }

  get enabled(): boolean {
    return !!this.o.agent;
  }

  async start(core: CoreServices): Promise<void> {
    this.core = core;
    this.stopped = false;
    if (!this.store) this.store = new AdminStore(core.dataDir === ":memory:" ? ":memory:" : path.join(core.dataDir, "valheim-admin.sqlite"));
    if (!this.o.agent) return;
    // Перезапуск бота: дослеживаем задачи, о которых ещё не отчитались, — по сохранённым разрешениям.
    for (const w of this.store.openWatches()) {
      if (!w.grant || w.grantExpiresAt < this.now() + 10_000) {
        this.store.finishWatch(w.taskId, w.mode);
        core.log.info("admin.watch_lost", { task: w.taskId, mode: w.mode });
        continue;
      }
      this.spawnWatch(w, core.conversation(this.refOf(w)), core.log);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const wake of [...this.sleepers]) wake();
    await this.idle();
  }

  private sleep(ms: number): Promise<void> {
    if (this.o.sleep) return this.o.sleep(ms);
    if (this.stopped) return Promise.resolve();
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        this.sleepers.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, ms);
      this.sleepers.add(wake);
    });
  }

  /** Дождаться фоновых наблюдений (тесты). */
  async idle(): Promise<void> {
    while (this.active.size > 0) await Promise.allSettled([...this.active.values()]);
  }

  private refOf(w: WatchRow): ConversationRef {
    return { grant: w.grant, expiresAt: w.grantExpiresAt, conversationId: w.conversationId, kind: w.convKind, triggerMessageId: w.triggerMessageId };
  }

  // ─────────────────────────────── инструменты модели

  tools(): BotTool<any>[] {
    const out: BotTool<any>[] = [this.statusTool()];
    if (this.o.agent) out.push(this.requestTool());
    return out;
  }

  private statusTool(): BotTool<Record<string, never>> {
    return {
      name: "server_status",
      description:
        "Состояние сервера Valheim «Koban» прямо сейчас: работает ли, сколько людей в игре, версия игры, ждёт ли перезапуска, последний бэкап, диск, какие настройки мира отличаются от обычных; администратор сервера (агент): доступен ли, с каким сервером работает (боевой или тестовый стенд), его расход и последние просьбы с их состоянием. Вызывай на «как там сервер?», «сервер живой?», «перезапуск запланирован?», «что недавно меняли?», «какие настройки мира?», «как там моя просьба?». Только чтение, ничего не меняет.",
      access: "anyone",
      inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
      run: async (_i, ctx) => this.serverStatus(ctx),
    };
  }

  private async serverStatus(ctx: ToolContext): Promise<{ content: string; untrusted: boolean }> {
    const world = this.o.world ?? null;
    const ops = this.o.ops ?? null;
    const agent = this.o.agent;
    const players = playerDataVisible(ctx);
    const [st, time, opts, health, tasks] = await Promise.all([
      ops ? ops.call<OpsStatus>("status", {}, 15_000).catch((e: unknown) => e as Error) : Promise.resolve(null),
      world ? world.time(ctx.signal).catch(() => null) : Promise.resolve(null),
      world ? world.map.options(ctx.signal).catch(() => null) : Promise.resolve(null),
      agent ? agent.health().catch(() => null) : Promise.resolve(null),
      agent && players ? agent.listTasks(6).catch(() => null) : Promise.resolve(null),
    ]);
    const out: Record<string, unknown> = {};
    if (st === null) out.server = { known: false, note: "помощник сервера не подключён" };
    else if (st instanceof Error) out.server = { known: false, note: st instanceof OpsUnavailable ? "помощник сервера недоступен" : "помощник сервера не ответил" };
    else if (st.ok) {
      const c = st.container;
      out.server = {
        running: !!c?.running,
        state: c?.status ?? null,
        startedAtUtc: c?.startedAt ?? null,
        restartWhenEmptyPending: !!st.restartWhenEmpty?.active,
        restartingNow: !!st.restartNow?.active,
        gameVersion: st.game?.version ?? null,
        plugins: st.game?.plugins ?? null,
        lastHourlyBackup: st.backups?.lastHourly?.at ?? null,
        lastManualBackup: st.backups?.lastManual?.at ?? null,
        diskFreeGb: st.disk ? Math.round(st.disk.freeGb) : null,
      };
    } else out.server = { known: false, note: plain(String(st.error ?? "ошибка"), 120) };
    out.world = time
      ? { mapResponds: true, playersOnline: time.players, day: time.day, timeRunning: time.running }
      : { mapResponds: false, note: world ? "карта сервера (WebMap) не отвечает" : "нет данных" };
    if (opts?.groups) {
      const changed: string[] = [];
      for (const g of opts.groups) {
        for (const it of g.items) {
          const isChanged = it.kind === "flag" ? !!it.on : it.isDefault === false;
          if (isChanged) changed.push(`${it.label} (${it.key}): ${it.kind === "flag" ? "вкл" : it.kind === "scale" ? `x${it.value ?? 1}` : String(it.value ?? 0)}`);
        }
      }
      out.worldSettingsChanged = changed;
    }
    if (agent) {
      if (health) {
        this.target = health.target;
        out.admin = {
          available: true,
          serverItWorksWith: health.target === "live" ? "боевой сервер" : health.target === "test" ? "тестовый стенд (не боевой сервер)" : health.target,
          spentUsd: health.budget?.spentUsd ?? null,
          monthlyLimitUsd: health.budget?.limitUsd ?? null,
          howToUse: "просьбы об изменениях передаются через admin_request; план подтверждает любой привязанный игрок ответом «да»",
        };
      } else out.admin = { available: false };
      if (tasks) {
        out.recentRequests = tasks.map((t) => ({
          taskId: t.taskId,
          when: this.when(t.createdAt),
          requestedBy: t.requester?.character ?? null,
          request: plain(t.text, 160),
          status: statusText({ status: t.status, confirmer: t.confirmer, cancelledBy: null, error: null }),
          summary: t.summary_ru ? plain(t.summary_ru, 200) : null,
          confirmedBy: t.confirmer?.character ?? null,
          undoneBy: t.undoneBy?.character ?? null,
        }));
      } else if (!players) {
        out.recentRequests = "видны только игрокам сервера в беседе, где все привязаны";
      }
    }
    return { content: JSON.stringify(out), untrusted: true };
  }

  private when(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return new Intl.DateTimeFormat("ru-RU", { timeZone: this.o.timeZone ?? "Europe/Moscow", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(d);
  }

  private requestTool(): BotTool<{ text: string }> {
    return {
      name: "admin_request",
      description:
        "Передать просьбу ИЗМЕНИТЬ что-то на сервере Valheim «Koban» администратору сервера (агенту на сервере): включить/выключить или поменять настройку мира или мода (творческий режим, бесплатный крафт, ресурсы x3, сложность, сон…), перезапустить сервер (сразу или когда все выйдут), сделать бэкап мира, выдать/снять админку, поставить/обновить/удалить мод, вернуть прежнее значение. Агент сам разберётся, что нужно, и составит план; бот САМ покажет план отдельным сообщением, и любой привязанный игрок подтвердит его ответом «да». Ты ничего не меняешь и не подтверждаешь. Вызывай, только когда человек ПРОСИТ сделать («включи», «поставь», «сделай», «перезапусти», «можешь включить…?» в смысле «включи»). Вопросы («можно ли…», «как…», «что будет, если…», «какие сейчас настройки», «как там сервер?») — НЕ просьбы: отвечай сам или через server_status. Если неясно, что именно поменять, — сначала уточни у человека. Одна просьба за ответ.",
      access: "anyone",
      inputSchema: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description:
              "Просьба по-русски, как её сформулировал человек, полностью и конкретно (с уточнениями из цепочки ответов): что сделать и для кого. Ничего не добавляй от себя.",
          },
        },
        required: ["text"],
        additionalProperties: false,
      },
      run: async (input, ctx) => this.request(input.text, ctx),
    };
  }

  private async request(rawText: string, ctx: ToolContext): Promise<{ content: string; isError?: boolean }> {
    const agent = this.o.agent;
    const store = this.store;
    if (!agent || !store) return { content: "Администратор сервера не подключён: передать просьбу некуда. Скажи человеку честно.", isError: true };
    const r = ctx.requester;
    if (!r.isPlayer) {
      ctx.log.info("admin.request_denied", { why: "unlinked" });
      return {
        content:
          "ОТКАЗ, ничего не передано: просить изменения на сервере могут только игроки сервера — люди, привязанные к персонажу. Вежливо скажи человеку, что сначала нужно привязать ник: «Еблуша, мой ник в игре …».",
      };
    }
    const conv = ctx.conversation;
    if (!conv || !ctx.afterReply) return { content: "Отсюда передать просьбу нельзя.", isError: true };
    if (this.askedIn.has(conv.triggerMessageId)) return { content: "Одна просьба за ответ: эта уже передана агенту, план придёт отдельным сообщением.", isError: true };
    const text = rawText.replace(/\s+/g, " ").trim();
    if (!text) return { content: "Пустая просьба: передай, что именно нужно сделать.", isError: true };
    const day = utcDay(this.now());
    const cap = this.o.userDailyRequests ?? 15;
    if (!r.isOwner && store.countRequests(r.userId, day) >= cap) {
      ctx.log.info("admin.request_denied", { why: "daily_cap" });
      return { content: `ОТКАЗ, ничего не передано: у этого человека на сегодня исчерпан лимит просьб к администратору сервера (${cap} в сутки). Скажи об этом коротко.` };
    }
    let task: AgentTask;
    try {
      task = await agent.createTask(personOf(r), text.slice(0, 2000), 0);
    } catch (e) {
      if (e instanceof AgentError && e.status === 429) {
        return { content: "Администратор сервера сейчас занят другими просьбами (две уже в работе) — ничего не передано. Попроси человека повторить через минуту." };
      }
      ctx.log.warn("admin.create_failed", { err: e as Error });
      return { content: `Не удалось передать просьбу: ${e instanceof AgentUnavailable ? "администратор сервера недоступен" : plain((e as Error).message, 160)}. Скажи человеку, что сейчас не получится.` };
    }
    this.askedIn.add(conv.triggerMessageId);
    if (this.askedIn.size > 500) this.askedIn.delete(this.askedIn.values().next().value as string);
    store.addRequest(r.userId, day, this.now());
    this.target = task.target ?? this.target;
    ctx.log.info("admin.task_created", { task: task.taskId, status: task.status, len: text.length });
    if (task.status === "error") {
      return { content: `Агент отказал: ${plain(task.error, 300)}. Передай это человеку коротко.` };
    }
    store.addTask({
      taskId: task.taskId,
      conversationId: conv.conversationId,
      convKind: conv.kind,
      requesterId: r.userId,
      requesterName: r.displayName,
      requestMessageId: conv.triggerMessageId,
      createdAt: this.now(),
      state: "planning",
      planAt: null,
    });
    const row: WatchRow = {
      ...this.watchBase(conv),
      taskId: task.taskId,
      mode: "plan",
      replyToId: conv.triggerMessageId,
      who: r.displayName,
      stage: 0,
      startedAt: this.now(),
    };
    store.upsertWatch(row);
    const log = ctx.log;
    const taskId = task.taskId;
    ctx.afterReply(async (replyIds) => {
      // «Сейчас разберусь — пришлю план»: «да» ответом на него — тоже про этот план.
      if (replyIds.length) store.addMessages(taskId, replyIds, "ack", this.now());
      this.spawnWatch(row, conv, log);
    });
    return {
      content: `Передал администратору сервера (задача ${task.taskId}). Он составит план (обычно за 1–2 минуты), и я САМ пришлю его следующим сообщением с вопросом «да/нет» — подтвердить сможет любой привязанный игрок. Не пересказывай и не выдумывай план, не обещай результат, не спрашивай подтверждения сам. Ответь человеку одной короткой фразой (например: «Сейчас разберусь, что для этого нужно, — пришлю план»).`,
    };
  }

  private watchBase(conv: ConversationHandle): Pick<WatchRow, "grant" | "grantExpiresAt" | "followup" | "conversationId" | "convKind" | "triggerMessageId"> {
    const ref = conv.ref;
    return {
      grant: ref.grant,
      grantExpiresAt: ref.expiresAt,
      followup: false,
      conversationId: ref.conversationId,
      convKind: ref.kind,
      triggerMessageId: ref.triggerMessageId,
    };
  }

  // ─────────────────────────────── ответы людей на план / отчёт

  async intercept(inp: InterceptInput): Promise<boolean> {
    const agent = this.o.agent;
    const store = this.store;
    if (!agent || !store) return false;
    const intent = classifyIntent(inp.text);
    if (!intent) return false;
    // Ответ на сообщение человека («Еблуша, да» в ответ Сане) — не про план.
    if (inp.parent && !inp.parent.isBot) return false;
    const linked = inp.parent ? store.messageTask(inp.parent.id) : null;
    if (linked) return this.onLinked(intent, linked, inp);
    if (intent === "undo") {
      const id = await this.latestUndoable(inp.conversation.conversationId);
      if (!id) return false;
      return this.act("undo", id, inp);
    }
    // «Да» ответом на другое сообщение бота (не план и не «пришлю план») — это ответ ему: модели.
    if (inp.parent) return false;
    // «Да»/«нет» без ответа (в «Чате с Еблушей» так пишут почти всегда): про план — только если план
    // (или «пришлю план») и есть последнее, что бот сказал в этой беседе. Иначе это ответ на что-то
    // другое — модели (она видит разговор).
    if (inp.lastBotMessageId) {
      const last = store.messageTask(inp.lastBotMessageId);
      if (last && (last.role === "plan" || last.role === "ack")) return this.onLinked(intent, last, inp);
      return false;
    }
    // Бот не помнит, что говорил здесь последним (его перезапускали): если план ждёт ответа — подсказать.
    if (this.openPlans(inp.conversation.conversationId).length === 0) return false;
    await inp.conversation.post("Чтобы было понятно, какой план, ответьте «да» или «нет» прямо на сообщение с планом (ответом на него).", {
      kind: "notice",
      replyToId: inp.message.id,
    });
    return true;
  }

  /** Планы этой беседы, которые ждут «да»/«нет» (по памяти бота; срок — час). */
  private openPlans(conversationId: string): TaskRow[] {
    return this.store!.tasksIn(conversationId, 5).filter((t) => t.state === "planned" && t.planAt !== null && this.now() - t.planAt < PLAN_TTL_MS);
  }

  /** «Да» / «нет» / «верни как было» про сообщение бота, связанное с задачей. */
  private async onLinked(intent: AdminIntent, linked: { taskId: string; role: MsgRole }, inp: InterceptInput): Promise<boolean> {
    // «Да» на ответ агента без плана («это делается модом X, поставить?») — новая просьба: пусть модель
    // по цепочке сформулирует её и передаст через admin_request.
    if (linked.role === "note" && intent !== "undo") return false;
    if (linked.role === "ack" && intent !== "undo") {
      const t = this.store!.task(linked.taskId);
      if (t?.state === "planning") {
        await inp.conversation.post("План ещё составляется — пришлю его здесь, тогда и ответьте «да» или «нет».", {
          kind: "notice",
          replyToId: inp.message.id,
        });
        return true;
      }
      if (t?.state !== "planned") return false;
    }
    return this.act(intent, linked.taskId, inp);
  }

  private async latestUndoable(conversationId: string): Promise<string | null> {
    for (const t of this.store!.tasksIn(conversationId, 5)) {
      if (t.state !== "closed") continue;
      try {
        const v = await this.o.agent!.getTask(t.taskId);
        if (v.canUndo) return v.taskId;
      } catch {
        /* пропала у агента — дальше */
      }
    }
    return null;
  }

  private async act(intent: AdminIntent, taskId: string, inp: InterceptInput): Promise<boolean> {
    const agent = this.o.agent!;
    const store = this.store!;
    const conv = inp.conversation;
    const reply = (text: string, kind: "command" | "notice" = "command") => conv.post(text, { kind, replyToId: inp.message.id });
    const r = inp.requester;
    if (!r.isPlayer) {
      inp.log.info("admin.decision_denied", { task: taskId, intent });
      await reply(UNLINKED_TEXT, "notice");
      return true;
    }
    const person = personOf(r);
    const who = r.characters[0] ?? r.displayName;
    try {
      if (intent === "yes") {
        const t = await agent.confirm(taskId, person);
        store.setState(taskId, "closed");
        inp.log.info("admin.confirmed", { task: taskId, status: t.status });
        await this.startExecWatch("apply", taskId, who, inp);
        return true;
      }
      if (intent === "no") {
        await agent.cancel(taskId, person);
        store.setState(taskId, "closed");
        inp.log.info("admin.cancelled", { task: taskId });
        await reply("Отменил — ничего не меняю.");
        return true;
      }
      const t = await agent.undo(taskId, person);
      inp.log.info("admin.undo", { task: taskId, status: t.status });
      await this.startExecWatch("undo", taskId, who, inp);
      return true;
    } catch (e) {
      if (e instanceof AgentUnavailable) {
        inp.log.warn("admin.agent_unavailable", { task: taskId, intent });
        await reply(UNAVAILABLE_TEXT, "notice");
        return true;
      }
      if (!(e instanceof AgentError)) throw e;
      inp.log.info("admin.agent_refused", { task: taskId, intent, code: e.code });
      await reply(await this.explainRefusal(intent, taskId, e, inp.chat.kind), "notice");
      return true;
    }
  }

  private async explainRefusal(intent: AdminIntent, taskId: string, e: AgentError, kind: "bot" | "dm" | "group"): Promise<string> {
    const store = this.store!;
    if (e.code === "expired") {
      store.setState(taskId, "closed");
      return `Этот план устарел — планы живут час. Напишите просьбу ещё раз${kind === "bot" ? "" : " («Еблуша, …»)"}, и я попрошу свежий план.`;
    }
    if (e.code === "wrong_target") {
      store.setState(taskId, "closed");
      return `Не могу: ${plain(e.message, 300)}. Напишите просьбу ещё раз — план составят заново.`;
    }
    if (e.status === 404) return "Не нахожу эту задачу у администратора сервера. Напишите просьбу ещё раз.";
    let t: AgentTask | null = null;
    try {
      t = await this.o.agent!.getTask(taskId);
    } catch {
      t = null;
    }
    if (intent === "undo") {
      if (t?.status === "verifying") return "Сейчас идёт короткая проверка после изменений — повторите «верни как было» через минуту.";
      return `Откатывать нечего${t ? `: ${statusText(t)}` : ""}.`;
    }
    if (!t) return `Администратор ответил: ${plain(e.message, 200)}.`;
    if (t.status !== "planned") store.setState(taskId, "closed");
    if (t.confirmer && ["executing", "waiting_restart", "verifying", "done", "applied", "failed", "undoing", "undone", "undo_failed"].includes(t.status)) {
      return `Этот план уже подтвердил(а) ${personName(t.confirmer)} — ${statusText(t)}.${t.canUndo && intent === "no" ? " Вернуть как было — ответьте «верни как было» на отчёт." : ""}`;
    }
    return `Тут уже нечего ${intent === "yes" ? "подтверждать" : "отменять"}: ${statusText(t)}.`;
  }

  /** После «да» или «верни как было»: долгое разрешение (если сервер даст) и наблюдение до итога. */
  private async startExecWatch(mode: "apply" | "undo", taskId: string, who: string, inp: InterceptInput): Promise<void> {
    const store = this.store!;
    let conv = inp.conversation;
    let followup = false;
    const fu = await conv.followup();
    if (fu && this.core) {
      conv = this.core.conversation({ ...conv.ref, grant: fu.grant, expiresAt: fu.expiresAt });
      followup = true;
    }
    const row: WatchRow = { ...this.watchBase(conv), followup, taskId, mode, replyToId: inp.message.id, who, stage: 0, startedAt: this.now() };
    store.upsertWatch(row);
    this.spawnWatch(row, conv, inp.log);
  }

  // ─────────────────────────────── наблюдение за задачей

  private spawnWatch(row: WatchRow, conv: ConversationHandle, log: Logger): void {
    const key = `${row.taskId}:${row.mode}`;
    if (this.active.has(key)) return;
    const p = this.watch(row, conv, log)
      .catch((e: unknown) => log.error("admin.watch_failed", { task: row.taskId, mode: row.mode, err: e as Error }))
      .finally(() => this.active.delete(key));
    this.active.set(key, p);
  }

  private interval(i: number, elapsedMs: number): number {
    if (elapsedMs < 2 * 60_000 && i < 60) return this.pollMs;
    if (elapsedMs < 30 * 60_000) return this.pollMs * 5;
    return this.pollMs * 20;
  }

  private async watch(row: WatchRow, conv0: ConversationHandle, log: Logger): Promise<void> {
    const agent = this.o.agent!;
    const store = this.store!;
    let conv = conv0;
    const typingWhile = row.mode === "plan" || row.stage === 0;
    let failures = 0;
    for (let i = 0; !this.stopped; i++) {
      let task: AgentTask | null = null;
      try {
        task = await agent.getTask(row.taskId);
        failures = 0;
      } catch (e) {
        if (e instanceof AgentError && e.status === 404) {
          log.warn("admin.task_gone", { task: row.taskId });
          store.finishWatch(row.taskId, row.mode);
          return;
        }
        failures++;
        if (failures === 1) log.warn("admin.poll_failed", { task: row.taskId, err: e as Error });
      }
      if (task) {
        this.target = task.target ?? this.target;
        if (isFinal(row.mode, task)) {
          if (typingWhile) conv.typing(false);
          await this.deliverFinal(row, task, conv, log);
          store.finishWatch(row.taskId, row.mode);
          return;
        }
        await this.deliverInterim(row, task, conv, i);
      }
      // Разрешение кончается, а итога нет: продолжение (если сервер даст), иначе — честно сказать и выйти.
      if (this.now() > conv.expiresAt - 60_000) {
        const fu = row.followup ? null : await conv.followup();
        if (fu && this.core) {
          row.grant = fu.grant;
          row.grantExpiresAt = fu.expiresAt;
          row.followup = true;
          store.upsertWatch(row);
          conv = this.core.conversation(this.refOf(row));
          log.info("admin.watch_followup", { task: row.taskId, mode: row.mode });
        } else {
          if (task) {
            await conv.post(`Не дождался итога по просьбе «${plain(task.text, 120)}»: ${statusText(task)}. Спросите позже «как там сервер?».`, {
              kind: "notice",
              replyToId: row.replyToId,
            });
          }
          log.info("admin.watch_expired", { task: row.taskId, mode: row.mode });
          store.finishWatch(row.taskId, row.mode);
          return;
        }
      }
      if ((row.mode === "plan" || row.stage === 0) && i % 2 === 0) conv.typing(true);
      await this.sleep(this.interval(i, this.now() - row.startedAt));
    }
  }

  private async deliverInterim(row: WatchRow, task: AgentTask, conv: ConversationHandle, i: number): Promise<void> {
    const store = this.store!;
    if (row.mode === "apply") {
      if (row.stage < 2 && task.status === "waiting_restart") {
        const n = task.plan?.changes.length ?? 0;
        const note = task.execution?.restart?.note_ru ? ` (${plain(task.execution.restart.note_ru, 200)})` : "";
        const ids = await conv.post(
          `✅ Изменения на месте${n ? ` (${n})` : ""}. Чтобы они заработали, сервер перезапустится, когда на нём никого не будет${note}. Итог напишу здесь же. Передумали — ответьте «верни как было».`,
          { kind: "command", replyToId: row.replyToId }
        );
        store.addMessages(row.taskId, ids, "progress", this.now());
        row.stage = 2;
        store.setWatchStage(row.taskId, row.mode, 2);
        conv.typing(false);
        return;
      }
      if (row.stage === 0 && i >= ACK_AFTER_POLLS && (task.status === "executing" || task.status === "verifying")) {
        const ids = await conv.post(`Применяю план — подтвердил(а) ${plain(row.who ?? "игрок", 60)}. Отчитаюсь здесь же.`, { kind: "command", replyToId: row.replyToId });
        store.addMessages(row.taskId, ids, "progress", this.now());
        row.stage = 1;
        store.setWatchStage(row.taskId, row.mode, 1);
      }
      return;
    }
    if (row.mode === "undo" && row.stage < 2 && task.status === "undoing" && task.undo?.restart && !task.undo.restart.seenBoot) {
      const ids = await conv.post("↩️ Откатываю. Чтобы вернулось как было, серверу нужен перезапуск — он будет, когда на сервере никого не будет. Итог напишу здесь же.", {
        kind: "command",
        replyToId: row.replyToId,
      });
      store.addMessages(row.taskId, ids, "progress", this.now());
      row.stage = 2;
      store.setWatchStage(row.taskId, row.mode, 2);
      conv.typing(false);
    }
  }

  private async deliverFinal(row: WatchRow, task: AgentTask, conv: ConversationHandle, log: Logger): Promise<void> {
    const store = this.store!;
    const now = this.now();
    if (row.mode === "plan") {
      const meta = store.task(row.taskId);
      if (task.status === "planned" && task.plan) {
        const ids = await conv.post(formatPlan(task, { requesterName: meta?.requesterName ?? row.who, isTest: task.target === "test" }), {
          kind: "confirm",
          replyToId: row.replyToId,
        });
        store.addMessages(row.taskId, ids, "plan", now);
        store.setState(row.taskId, ids.length ? "planned" : "closed", now);
        log.info("admin.plan_posted", { task: row.taskId, changes: task.plan.changes.length, restart: task.plan.restart, risk: task.plan.risk, parts: ids.length });
        return;
      }
      store.setState(row.taskId, "closed");
      if (task.status === "answered") {
        const ids = await conv.post(para(task.answer_ru, 3000) || "Администратор сервера ничего не стал менять.", { kind: "answer", replyToId: row.replyToId });
        store.addMessages(row.taskId, ids, "note", now);
      } else if (task.status === "error") {
        const ids = await conv.post(`Администратор сервера не смог составить план: ${plain(task.error, 300) || "ошибка"}.`, { kind: "notice", replyToId: row.replyToId });
        store.addMessages(row.taskId, ids, "note", now);
      }
      log.info("admin.plan_result", { task: row.taskId, status: task.status });
      return;
    }
    if (row.mode === "apply") {
      if (task.status === "cancelled" || task.status === "expired" || task.status === "error") return;
      const ids = await conv.post(formatReport(task, row.who), { kind: "command", replyToId: row.replyToId });
      store.addMessages(row.taskId, ids, "report", now);
      log.info("admin.report_posted", { task: row.taskId, status: task.status });
      return;
    }
    if (!UNDO_DONE.has(task.status)) return;
    const ids = await conv.post(formatUndoReport(task), { kind: "command", replyToId: row.replyToId });
    store.addMessages(row.taskId, ids, "undo", now);
    log.info("admin.undo_posted", { task: row.taskId, status: task.status });
  }
}
