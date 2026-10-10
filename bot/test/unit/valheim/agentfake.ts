/**
 * Поддельный агент администрирования Valheim (контракт /DATA/valheim-agent/docs/API.md) — в памяти,
 * со сценариями: план / ответ без изменений / ошибка; выполнение по шагам (в т. ч. ожидание
 * перезапуска); откат; «устарел», «занят». Сеть не используется.
 */
import { AgentError, AgentUnavailable, type AgentClientLike, type AgentHealth, type AgentPerson, type AgentPlan, type AgentTask, type AgentTaskSummary } from "../../../src/modules/valheim/agent";
import { ApiError } from "../../../src/api/eblusha";
import type { Harness } from "../fakes";

export type PlanScript = { kind: "plan"; plan: AgentPlan } | { kind: "answer"; text: string } | { kind: "error"; text: string };

export function samplePlan(over: Partial<AgentPlan> = {}): AgentPlan {
  return {
    summary_ru: "Включаю бесплатный крафт; перезапуск не нужен.",
    changes: [
      { id: "c1", kind: "world_key", description_ru: "Настройка мира NoCraftCost («Бесплатный крафт»): включить", why_ru: "просили" },
    ],
    affects: "all",
    restart: "none",
    risk: "low",
    notes_ru: null,
    ...over,
  };
}

let seq = 0;
function newId(): string {
  seq++;
  return `t20261010-1200${String(seq % 100).padStart(2, "0")}-${(0xa000 + seq).toString(16).slice(-4)}`;
}

export class FakeAgent implements AgentClientLike {
  target = "test";
  tasks = new Map<string, AgentTask>();
  /** Сколько опросов «думает» агент до плана. */
  planPolls = 1;
  planFor: (text: string) => PlanScript = () => ({ kind: "plan", plan: samplePlan() });
  /** Шаги выполнения после «да» (по одному на опрос); последний — итог. */
  execSteps: AgentTask["status"][] = ["executing", "done"];
  undoSteps: AgentTask["status"][] = ["undoing", "undone"];
  busy = false;
  down = false;
  calls: Array<{ op: string; id?: string; person?: AgentPerson; text?: string }> = [];
  private polls = new Map<string, number>();
  private exec = new Map<string, { steps: AgentTask["status"][]; i: number; mode: "apply" | "undo" }>();

  private guard(): void {
    if (this.down) throw new AgentUnavailable("агент не отвечает (нет связи)");
  }

  async health(): Promise<AgentHealth> {
    this.guard();
    return { ok: true, target: this.target, model: "claude-opus-5-5", budget: { spentUsd: 4.12, limitUsd: 60 }, planning: 0 };
  }

  async createTask(requester: AgentPerson, text: string): Promise<AgentTask> {
    this.guard();
    this.calls.push({ op: "create", person: requester, text });
    if (this.busy) throw new AgentError(429, "busy", "агент уже думает над другими просьбами — попробуйте через минуту");
    const now = new Date().toISOString();
    const t: AgentTask = {
      taskId: newId(),
      status: "planning",
      target: this.target,
      createdAt: now,
      updatedAt: now,
      requester,
      text,
      answer_ru: null,
      error: null,
      plan: null,
      planExpiresAt: null,
      confirmer: null,
      confirmedAt: null,
      cancelledBy: null,
      report_ru: null,
      execution: null,
      undo: null,
      costUsd: 0.1,
      canConfirm: false,
      canUndo: false,
    };
    this.tasks.set(t.taskId, t);
    this.polls.set(t.taskId, 0);
    return structuredClone(t);
  }

  private mustGet(id: string): AgentTask {
    const t = this.tasks.get(id);
    if (!t) throw new AgentError(404, "not_found", "нет такой задачи");
    return t;
  }

  /** Сдвинуть задачу на шаг (каждый опрос). */
  private advance(t: AgentTask): void {
    if (t.status === "planning") {
      const n = (this.polls.get(t.taskId) ?? 0) + 1;
      this.polls.set(t.taskId, n);
      if (n < this.planPolls) return;
      const s = this.planFor(t.text);
      if (s.kind === "plan") {
        t.status = "planned";
        t.plan = s.plan;
        t.planExpiresAt = new Date(Date.now() + 3600_000).toISOString();
        t.canConfirm = true;
      } else if (s.kind === "answer") {
        t.status = "answered";
        t.answer_ru = s.text;
      } else {
        t.status = "error";
        t.error = s.text;
      }
      return;
    }
    const e = this.exec.get(t.taskId);
    if (!e) return;
    e.i = Math.min(e.i + 1, e.steps.length - 1);
    const st = e.steps[e.i]!;
    t.status = st;
    if (e.mode === "apply") {
      t.execution ??= { finishedAt: null, worldBackup: { id: "wb-1" }, restart: null, checks: [] };
      if (st === "waiting_restart") t.execution.restart = { requested: "when_empty", effective: "when_empty", note_ru: null, seenBoot: null };
      if (st === "done" || st === "applied" || st === "failed") {
        if (t.execution.restart) t.execution.restart.seenBoot = st === "done" ? "boot-2" : null;
        t.report_ru = [
          st === "done" ? "Готово." : st === "applied" ? "Изменения применены, перезапуск не случился." : "Не получилось.",
          `План: ${t.plan?.summary_ru ?? ""}`,
          "Что сделано:",
          "- бэкап мира: wb-1 (20 МБ)",
          "- ключ мира NoCraftCost: включён",
          "Проверка:",
          "- [ok] NoCraftCost включён (по /options)",
          "Бэкап мира: wb-1.",
          `Вернуть как было — «откат» по задаче ${t.taskId}.`,
        ].join("\n");
        t.canUndo = st !== "failed";
      }
    } else {
      if (st === "undone" || st === "undo_failed") {
        t.undo = { ...(t.undo ?? { requester: { userId: "?", character: null } }), report_ru: "Откат выполнен: всё как было до задачи.\nЧто сделано:\n- ключ мира NoCraftCost: выключен\nПроверка:\n- [ok] NoCraftCost выключен" };
        t.canUndo = false;
      }
    }
  }

  async getTask(id: string): Promise<AgentTask> {
    this.guard();
    const t = this.mustGet(id);
    this.advance(t);
    return structuredClone(t);
  }

  async listTasks(limit = 20): Promise<AgentTaskSummary[]> {
    this.guard();
    return [...this.tasks.values()]
      .reverse()
      .slice(0, limit)
      .map((t) => ({
        taskId: t.taskId,
        status: t.status,
        createdAt: t.createdAt,
        requester: t.requester,
        text: t.text,
        summary_ru: t.plan?.summary_ru ?? t.answer_ru ?? t.error,
        changes: t.plan?.changes.length ?? 0,
        restart: t.plan?.restart ?? null,
        confirmer: t.confirmer,
        undoneBy: t.undo?.requester ?? null,
      }));
  }

  expired = new Set<string>();

  async confirm(id: string, confirmer: AgentPerson): Promise<AgentTask> {
    this.guard();
    this.calls.push({ op: "confirm", id, person: confirmer });
    const t = this.mustGet(id);
    if (this.expired.has(id)) {
      t.status = "expired";
      throw new AgentError(409, "expired", "план устарел — попросите заново, агент составит свежий");
    }
    if (t.status !== "planned") throw new AgentError(409, "not_planned", `подтверждать нечего: задача в состоянии ${t.status}`);
    t.status = "executing";
    t.confirmer = confirmer;
    t.canConfirm = false;
    this.exec.set(id, { steps: [...this.execSteps], i: -1, mode: "apply" });
    return structuredClone(t);
  }

  async cancel(id: string, by: AgentPerson): Promise<AgentTask> {
    this.guard();
    this.calls.push({ op: "cancel", id, person: by });
    const t = this.mustGet(id);
    if (t.status !== "planned") throw new AgentError(409, "not_planned", `отменять нечего: задача в состоянии ${t.status}`);
    t.status = "cancelled";
    t.cancelledBy = by;
    return structuredClone(t);
  }

  async undo(id: string, requester: AgentPerson): Promise<AgentTask> {
    this.guard();
    this.calls.push({ op: "undo", id, person: requester });
    const t = this.mustGet(id);
    if (!t.canUndo) throw new AgentError(409, "not_undoable", `откатывать нечего: задача в состоянии ${t.status}`);
    t.status = "undoing";
    t.undo = { requester, report_ru: null };
    this.exec.set(id, { steps: [...this.undoSteps], i: -1, mode: "undo" });
    return structuredClone(t);
  }
}

/** Долгие разрешения в заглушке API Еблуши (как POST /api/bot/followup на сервере). */
export function enableFollowups(h: Harness): { issued: string[] } {
  const issued: string[] = [];
  let n = 0;
  (h.api as unknown as { followup: (g: string) => Promise<{ grant: string; expiresAt: number }> }).followup = async (grant: string) => {
    const conv = h.api.grants.get(grant);
    if (!conv) throw new ApiError(410, "/api/bot/followup", "BOT_GRANT_EXPIRED", "HTTP 410");
    if (grant.startsWith("followup_")) throw new ApiError(400, "/api/bot/followup", "BOT_FOLLOWUP_NESTED", "HTTP 400");
    const g = `followup_${++n}_xxxxxxxxxxxxxxxxxxxx`;
    h.api.grants.set(g, conv);
    issued.push(g);
    return { grant: g, expiresAt: Date.now() + 72 * 3600_000 };
  };
  return { issued };
}
