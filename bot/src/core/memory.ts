/**
 * Память бота о своих разговорах (решение владельца 2026-10-11: «сейчас он не запоминает ни свои ответы, ни
 * наши вопросы… надо хранить контекст всей переписки… компактировать, как в харнессах»).
 *
 * Что помнит. В обычной беседе — ВСЕ обращения к нему (от любого участника, с именами) и свои ответы, с самого
 * начала, без окна; остальную переписку людей сервер не отдаёт. В «Чате с Еблушей» — весь чат. Секретные чаты —
 * нет (бот туда не ходит). Источник — сервер: POST /api/bot/history по разрешению задачи (контракт rev 3), только
 * беседа обращения, без удалённых и истёкших.
 *
 * Как помнит (как в харнессах): дословный свежий хвост + накопительная сводка всего более старого.
 *   - Хвост — сообщения после курсора сводки. Стал длиннее BOT_MEMORY_TAIL_TOKENS (оценка) — самое старое
 *     сворачивается в сводку кусками ≤ BOT_MEMORY_CHUNK_TOKENS, пока хвост не станет ≤ BOT_MEMORY_TAIL_KEEP_TOKENS
 *     (гистерезис: между сжатиями хвост только дописывается — префикс промпта стоит, кэш читается).
 *   - Сводка обновляется по шагам: прежняя сводка + вытесняемые реплики → новая сводка (недорогая модель,
 *     BOT_MEMORY_MODEL; расход — в учёт бюджета, вид "memory"). Хранится в SQLite бота (таблица memory: текст,
 *     курсор покрытия, версия, время), переживает перезапуск.
 *   - Не больше BOT_MEMORY_MAX_CALLS сжатий на ответ: длинная пересборка догоняется на следующих обращениях, а
 *     что не влезло в этот раз — модель на этот ответ не видит (не сохраняется, курсор не двигается).
 *
 * Удаления и правки. Сервер ведёт журнал изменений беседы (удалили/поправили обращение, ответ бота, сообщение
 * «Чата с Еблушей»): если изменённое уже в сводке (createdAt ≤ курсора) — сводка беседы выбрасывается и
 * собирается с нуля из истории сервера (лениво, при этом обращении). Изменённое в хвосте — и так перечитывается.
 * Журнал потерян (сменился epoch) или бот отстал сильнее, чем журнал помнит, — тоже с нуля. Истёкшее (у обычных
 * бесед не бывает) — по minExpiresAt. После ответа модели — ещё одна проверка журнала: удалили что-то, пока
 * модель думала, — ответ не публикуется (он мог пересказать удалённое).
 *
 * Сводка — текст на диске бота (раньше бот текста не хранил вовсе): только то, что и так лежит на сервере, а
 * сводка беседы, к которой не обращались BOT_MEMORY_IDLE_DAYS, удаляется (соберётся заново, если понадобится).
 */
import type { ChatApi } from "../api/eblusha";
import { BOT_JOB_REV_MEMORY, type BotHistoryMessage, type BotJob, type BotMemoryStatus } from "../api/types";
import type { BotConfig } from "../config";
import type { Logger } from "../log";
import type { LlmEngine } from "../llm/types";
import type { CostBreakdown } from "./budget";
import { renderUnits, type HistoryFormat, type MemoryUnit, type MemoryView } from "./context";
import type { MemoryRow, Store } from "./store";

/** Формат сводки (промпт сжатия, разметка реплик): сменился — старые сводки пересобираются. */
export const MEMORY_FORMAT = 1;
/** Страница истории и сколько страниц за раз (50 000 сообщений после курсора — с большим запасом). */
const PAGE = 500;
const MAX_PAGES = 100;
/** Сжатие сломалось (отказ, сеть) — не пробовать снова раньше. */
const FAIL_BACKOFF_MS = 10 * 60_000;
/** Сколько времени ответа можно потратить на сжатие (дальше — догоняем на следующих обращениях). */
const COMPACT_TIME_MS = 90_000;

export interface MemoryDeps {
  cfg: BotConfig;
  api: ChatApi;
  store: Store;
  llm: LlmEngine | null;
  now(): number;
  format: HistoryFormat;
}

/** Что нужно памяти от ответа, ради которого она грузится. */
export interface MemoryRequest {
  job: BotJob;
  /** Можно ли сейчас тратить деньги на сжатие (потолки бюджета). */
  canSpend(): boolean;
  /** Учесть расход сжатия (вид "memory"). */
  record(cost: CostBreakdown): void;
  signal: AbortSignal;
  log: Logger;
}

export interface MemoryStats {
  /** Сообщений в хвосте (показано модели). */
  tail: number;
  tailTokens: number;
  summaryChars: number;
  /** Сколько сжатий сделано за этот ответ. */
  compactions: number;
  /** Сводка выброшена и собирается с нуля. */
  rebuilt: boolean;
  /** Не влезло в этот раз (не сжато) — модель этого не увидела. */
  trimmed: number;
  usd: number;
  pages: number;
}

export interface MemoryLoad {
  view: MemoryView;
  /** Журнал изменений на момент чтения — для проверки после ответа. */
  checkedAt: number;
  epoch: string;
  stats: MemoryStats;
}

const at = (m: { createdAt: string }) => Date.parse(m.createdAt);
const lastOf = (u: MemoryUnit) => u.messages[u.messages.length - 1]!;
const total = (units: MemoryUnit[]) => units.reduce((s, u) => s + u.cost, 0);

export class Memory {
  constructor(private readonly d: MemoryDeps) {}

  /** Есть ли память для этой задачи: сервер с маршрутом (rev ≥ 3), клиент умеет, не выключена. */
  enabled(job: BotJob): boolean {
    return !!this.d.api.history && (job.rev ?? 1) >= BOT_JOB_REV_MEMORY && this.d.cfg.memoryTailTokens > 0;
  }

  /** Сводки бесед, к которым давно не обращались, — удалить (сервер хранит всё, соберутся заново). */
  purgeIdle(): number {
    return this.d.store.purgeIdleMemory(this.d.now() - this.d.cfg.memoryIdleDays * 86_400_000);
  }

  /**
   * Память беседы для ответа на обращение: проверить журнал изменений (и пересобрать с нуля, если тронуто
   * свёрнутое), дочитать хвост, при переполнении — сжать старое в сводку. null — памяти нет (выключена, старый
   * сервер). Ошибки сервера — исключение (ответ пойдёт без памяти).
   */
  async load(r: MemoryRequest): Promise<MemoryLoad | null> {
    if (!this.enabled(r.job)) return null;
    const cfg = this.d.cfg;
    const job = r.job;
    const convId = job.conversation.id;
    const now = this.d.now();
    let row = this.d.store.getMemory(convId);
    let rebuilt = false;
    if (row && row.format !== MEMORY_FORMAT) {
      r.log.info("memory.reset", { why: "format", from: row.format });
      this.d.store.dropMemory(convId);
      row = null;
      rebuilt = true;
    } else if (row && row.summary && row.minExpiresAt !== null && row.minExpiresAt <= now) {
      r.log.info("memory.reset", { why: "expired" });
      this.d.store.dropMemory(convId);
      row = null;
      rebuilt = true;
    }

    let got = await this.fetch(job.grant, row);
    if (row && row.summary.trim()) {
      const changed = got.status.changedFrom !== null && at({ createdAt: got.status.changedFrom }) <= at({ createdAt: row.cursorAt });
      if (got.status.reset || changed) {
        // Удалили/поправили то, что уже в сводке (или журнал не может ответить): сводку — с нуля.
        r.log.info("memory.invalidated", { why: got.status.reset ? "reset" : "changed", covered: row.covered, version: row.version });
        this.d.store.dropMemory(convId);
        row = null;
        rebuilt = true;
        got = await this.fetch(job.grant, null);
      }
    }
    const status = got.status;

    // Что новее обращения: ответы бота на прежние вопросы нужны (вопросы подряд), чужие новые вопросы — нет.
    const trigger = job.message;
    const tAt = at(trigger);
    const future = new Set(got.messages.filter((m) => !m.isBot && at(m) > tAt).map((m) => m.id));
    const list = got.messages.filter((m) => {
      if (m.id === trigger.id) return false;
      if (!(at(m) > tAt)) return true;
      if (!m.isBot) return false;
      return !!m.triggerId && m.triggerId !== trigger.id && !future.has(m.triggerId);
    });
    let units = renderUnits(list, this.d.format);

    let summary = row?.summary ?? "";
    let cursor = row ? { at: row.cursorAt, id: row.cursorId } : null;
    let covered = row?.covered ?? 0;
    let version = row?.version ?? 0;
    let minExpiresAt = row?.minExpiresAt ?? null;
    let failedAt = row?.failedAt ?? null;
    let compactions = 0;
    let usd = 0;
    const save = () =>
      this.d.store.saveMemory({
        conversationId: convId,
        summary,
        cursorAt: cursor!.at,
        cursorId: cursor!.id,
        covered,
        version,
        format: MEMORY_FORMAT,
        epoch: status.epoch,
        checkedAt: status.checkedAt,
        minExpiresAt,
        updatedAt: now,
        usedAt: now,
        failedAt,
      } satisfies MemoryRow);

    // Вытеснять можно только то, что не новее обращения (ответы бота на прежние вопросы после него — в хвосте).
    const evictable = () => {
      let k = 0;
      while (k < units.length && !(at(lastOf(units[k]!)) > tAt)) k++;
      return k;
    };

    if (total(units) > cfg.memoryTailTokens) {
      const summarize = this.d.llm?.summarize?.bind(this.d.llm);
      const backoff = failedAt !== null && now - failedAt < FAIL_BACKOFF_MS;
      const started = Date.now();
      while (summarize && cfg.memoryModel && !backoff && total(units) > cfg.memoryTailKeepTokens && compactions < cfg.memoryMaxCalls) {
        const ev = evictable();
        if (ev === 0 || !r.canSpend() || Date.now() - started > COMPACT_TIME_MS) break;
        let take = 0;
        let cost = 0;
        let rest = total(units);
        while (take < ev && rest > cfg.memoryTailKeepTokens) {
          const u = units[take]!;
          if (take > 0 && cost + u.cost > cfg.memoryChunkTokens) break;
          cost += u.cost;
          rest -= u.cost;
          take++;
        }
        // Вопрос и ответ на него не разрываем: ответ без своего вопроса в хвосте читался бы как «к давнему обращению».
        while (take < ev) {
          const prev = units[take - 1]!;
          const next = units[take]!;
          if (prev.role !== "user" || prev.skip || next.role !== "assistant" || next.messages[0]!.triggerId !== prev.messages[0]!.id) break;
          take++;
        }
        const chunk = units.slice(0, take);
        const transcript = chunk
          .filter((u) => !u.skip)
          .map((u) => (u.role === "assistant" ? `⟦Еблуша (бот)⟧\n${u.text}` : u.text))
          .join("\n\n");
        if (transcript.trim()) {
          try {
            const res = await summarize({
              previous: summary,
              transcript,
              maxChars: cfg.memorySummaryTokens * 3,
              kind: job.conversation.kind,
              signal: r.signal,
            });
            r.record(res.cost);
            usd += res.cost.usd;
            if (res.stop !== "end_turn" || !res.text.trim()) {
              failedAt = now;
              r.log.warn("memory.compact_failed", { stop: res.stop, empty: !res.text.trim() });
              break;
            }
            summary = res.text.trim();
          } catch (e) {
            if (r.signal.aborted) throw e;
            failedAt = now;
            r.log.warn("memory.compact_failed", { err: e as Error });
            break;
          }
        }
        const last = lastOf(chunk[chunk.length - 1]!);
        cursor = { at: last.createdAt, id: last.id };
        for (const u of chunk) {
          covered += u.messages.length;
          for (const m of u.messages) {
            const e = m.expiresAt ? Date.parse(m.expiresAt) : NaN;
            if (Number.isFinite(e)) minExpiresAt = minExpiresAt === null ? e : Math.min(minExpiresAt, e);
          }
        }
        version++;
        compactions++;
        failedAt = null;
        units = units.slice(take);
        save();
        r.log.info("memory.compacted", { msgs: chunk.reduce((s, u) => s + u.messages.length, 0), covered, version, chars: summary.length, usd: Number(usd.toFixed(4)) });
      }
      // Хвост — заново, как его увидит следующий запрос (от нового курсора): иначе первая реплика могла бы
      // отличаться (пометка «к какому обращению»), и следующий вопрос не прочитал бы память из кэша.
      if (compactions) units = renderUnits(units.flatMap((u) => u.messages), this.d.format);
    }

    // Что не сжалось (сжатие выключено, сломалось, лимит вызовов) — на этот ответ модель этого не видит.
    let trimmed = 0;
    while (total(units) > cfg.memoryTailTokens && units.length > 1 && evictable() > 0) {
      trimmed += units.shift()!.messages.length;
    }
    if (trimmed) r.log.info("memory.trimmed", { msgs: trimmed });

    if (compactions === 0) {
      if (cursor) {
        // Ничего не сжимали: журнал проверен до status.checkedAt — продвинуть, отметить использование.
        save();
      } else if (got.messages.length) {
        // Первое знакомство: сводки нет, курсор — начало просмотра (дальше не листать то, где нас не звали).
        const first = got.messages[0]!;
        cursor = { at: first.createdAt, id: "" };
        save();
      }
    }

    const view: MemoryView = {
      summary: summary.trim() ? summary : null,
      summaryUntil: summary.trim() && cursor ? cursor.at : null,
      mode: got.mode,
      units,
    };
    return {
      view,
      checkedAt: status.checkedAt,
      epoch: status.epoch,
      stats: {
        tail: units.reduce((s, u) => s + (u.skip ? 0 : u.messages.length), 0),
        tailTokens: total(units),
        summaryChars: view.summary?.length ?? 0,
        compactions,
        rebuilt,
        trimmed,
        usd,
        pages: got.pages,
      },
    };
  }

  /**
   * После ответа модели, до публикации: не удалили ли (не поправили ли) что-то из памяти, пока модель думала.
   * true — ответ мог пересказать удалённое, публиковать нельзя. Сбой проверки — false (не мешаем ответу).
   */
  async changedSince(grant: string, load: MemoryLoad, log: Logger): Promise<boolean> {
    if (!this.d.api.history) return false;
    try {
      const p = await this.d.api.history(grant, { limit: 0, changesSince: load.checkedAt, epoch: load.epoch });
      return p.memory.reset || p.memory.changedFrom !== null;
    } catch (e) {
      log.debug("memory.recheck_failed", { err: e as Error });
      return false;
    }
  }

  private async fetch(
    grant: string,
    row: MemoryRow | null
  ): Promise<{ status: BotMemoryStatus; messages: BotHistoryMessage[]; mode: "botchat" | "recent"; pages: number }> {
    const api = this.d.api;
    let after = row ? { at: row.cursorAt, id: row.cursorId } : null;
    const messages: BotHistoryMessage[] = [];
    let status: BotMemoryStatus | null = null;
    let mode: "botchat" | "recent" = "recent";
    let pages = 0;
    while (pages < MAX_PAGES) {
      const page = await api.history!(grant, {
        after,
        limit: PAGE,
        ...(pages === 0 && row && row.checkedAt !== null ? { changesSince: row.checkedAt, epoch: row.epoch } : {}),
      });
      pages++;
      if (!status) {
        status = page.memory;
        mode = page.mode;
      }
      messages.push(...page.messages);
      if (!page.next) break;
      after = page.next;
    }
    return { status: status!, messages, mode, pages };
  }
}
