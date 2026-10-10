/**
 * Память бота о своих разговорах (решение владельца 2026-10-11: «сейчас он не запоминает ни свои ответы, ни
 * наши вопросы… надо хранить контекст всей переписки… компактировать, как в харнессах»).
 *
 * Что помнит. В обычной беседе — ВСЕ обращения к нему (от любого участника, с именами) и свои ответы, с самого
 * начала, без окна; остальную переписку людей сервер не отдаёт. В «Чате с Еблушей» — весь чат. Секретные чаты —
 * нет (бот туда не ходит). Источник — сервер: POST /api/bot/history по разрешению задачи (контракт rev 3), только
 * беседа обращения, без удалённых и истёкших. Обращения из memory_skip (отказ по лимитам, отменённый ответ) и
 * ответы на них — не берутся.
 *
 * Как помнит (как в харнессах): дословный свежий хвост + накопительная сводка всего более старого.
 *   - Хвост — сообщения после курсора сводки. Стал длиннее BOT_MEMORY_TAIL_TOKENS (оценка) — самое старое
 *     сворачивается в сводку кусками ≤ BOT_MEMORY_CHUNK_TOKENS, пока хвост не станет ≤ BOT_MEMORY_TAIL_KEEP_TOKENS
 *     (гистерезис: между сжатиями хвост только дописывается — префикс промпта стоит, кэш читается).
 *   - Сводка обновляется по шагам: прежняя сводка + вытесняемые реплики → новая сводка (недорогая модель,
 *     BOT_MEMORY_MODEL; расход — в учёт бюджета, вид "memory"). Хранится в SQLite бота (таблица memory: текст,
 *     курсор покрытия, версия, время), переживает перезапуск.
 *   - Не больше BOT_MEMORY_MAX_CALLS сжатий на ответ и не дороже половины потолка ответа: длинная пересборка
 *     догоняется на следующих обращениях, а что не влезло в этот раз — модель на этот ответ не видит, и ей об
 *     этом говорится (gaps → служебная заметка «память неполная»), чтобы она не утверждала «мы не говорили».
 *   - Сжатие выключено (BOT_MEMORY_MODEL=off) — вытесняемое просто забывается: курсор всё равно двигается (иначе
 *     каждый вопрос перечитывал бы всю историю, а кэш не держался бы), забытое считается (forgotten/forgottenAt).
 *     Кусок, который не сжался MAX_FAILS раз подряд (отказ модели, обрыв), — так же пропускается; между
 *     попытками — растущая пауза.
 *
 * Удаления и правки. Сервер ведёт журнал изменений беседы в Postgres (в той же транзакции, что удаление/правка):
 * если изменённое уже в сводке (createdAt ≤ курсора) — сводка беседы выбрасывается и собирается с нуля из истории
 * сервера (лениво, при этом обращении). Изменённое в хвосте — и так перечитывается. Журнал не может ответить
 * (сменился epoch, бот отстал дольше срока хранения) — тоже с нуля. Истёкшее (у обычных бесед не бывает) — по
 * minExpiresAt. Журнал сервер отдаёт с запасом по времени — уже учтённые записи бот узнаёт по id (seenChanges).
 * После ответа модели — ещё одна проверка: удалили сообщение, которое модель ВИДЕЛА (дословно или в сводке),
 * пока она думала, — ответ не публикуется (мог пересказать удалённое). Правки (опечатка в своём вопросе) и
 * изменения того, чего модель не видела, ответ не отменяют.
 *
 * Сводка — текст на диске бота (раньше бот текста не хранил вовсе): только то, что и так лежит на сервере, а
 * сводка беседы, к которой не обращались BOT_MEMORY_IDLE_DAYS, удаляется (соберётся заново, если понадобится).
 */
import type { ChatApi } from "../api/eblusha";
import { BOT_JOB_REV_MEMORY, type BotHistoryMessage, type BotJob, type BotMemoryChange, type BotMemoryStatus } from "../api/types";
import type { BotConfig } from "../config";
import type { Logger } from "../log";
import type { LlmEngine } from "../llm/types";
import type { CostBreakdown } from "./budget";
import { charsForTokens, renderUnits, type HistoryFormat, type MemoryUnit, type MemoryView } from "./context";
import type { MemoryRow, Store } from "./store";

/** Формат сводки (промпт сжатия, разметка реплик): сменился — старые сводки пересобираются. */
export const MEMORY_FORMAT = 1;
/** Страница истории и сколько страниц за раз (45 000 сообщений после курсора; сервер даёт 200 страниц на обращение). */
const PAGE = 500;
const MAX_PAGES = 90;
/** Сжатие сломалось (отказ, сеть) — пауза перед следующей попыткой: 10 мин, потом вдвое больше, до 6 ч. */
const FAIL_BACKOFF_MS = 10 * 60_000;
const FAIL_BACKOFF_MAX_MS = 6 * 3600_000;
/** Столько неудач подряд на одном куске — кусок пропускается (забывается), чтобы память не застряла навсегда. */
export const MAX_FAILS = 3;
/** Сколько времени ответа можно потратить на сжатие (дальше — догоняем на следующих обращениях). */
const COMPACT_TIME_MS = 90_000;
/** Сколько помнить id учтённых записей журнала (сервер отдаёт журнал с запасом 10 с). */
const SEEN_WINDOW_MS = 120_000;

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
  /** Можно ли сейчас потратить ещё ~одно сжатие (потолки бюджета и доля потолка ответа). */
  canSpend(): boolean;
  /** Учесть расход сжатия (вид "memory"). */
  record(cost: CostBreakdown): void;
  signal: AbortSignal;
  log: Logger;
}

/** Чего в памяти на этот ответ не хватает. Всё пусто — память полная. */
export interface MemoryGaps {
  /** Сообщений между сводкой и хвостом, которые на этот раз не сжались и модели не показаны. */
  trimmed: number;
  /** createdAt (ISO) последнего из них. */
  trimmedUntil: string | null;
  /** Свёрнуто без сводки (сжатие выключено, кусок не сжался): разговоры до этого момента помнятся не все. */
  forgottenAt: string | null;
  /** История не дочитана (больше MAX_PAGES страниц после курсора): свежие разговоры видны не все. */
  truncated: boolean;
}

export function memoryComplete(g: MemoryGaps): boolean {
  return g.trimmed === 0 && g.forgottenAt === null && !g.truncated;
}

export interface MemoryStats {
  /** Сообщений в хвосте (показано модели). */
  tail: number;
  tailTokens: number;
  summaryChars: number;
  /** Сколько сжатий сделано за этот ответ. */
  compactions: number;
  /** Сколько сообщений забыто без сводки за этот ответ. */
  forgot: number;
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
  /** id записей журнала, уже учтённых при чтении (повторно их после ответа не считать). */
  seenChanges: string[];
  gaps: MemoryGaps;
  stats: MemoryStats;
}

const at = (m: { createdAt: string }) => Date.parse(m.createdAt);
const lastOf = (u: MemoryUnit) => u.messages[u.messages.length - 1]!;
const total = (units: MemoryUnit[]) => units.reduce((s, u) => s + u.cost, 0);

export function backoffMs(fails: number): number {
  return Math.min(FAIL_BACKOFF_MAX_MS, FAIL_BACKOFF_MS * 2 ** Math.max(0, fails - 1));
}

export class Memory {
  constructor(private readonly d: MemoryDeps) {}

  /** Есть ли память для этой задачи: сервер с маршрутом (rev ≥ 3), клиент умеет, не выключена. */
  enabled(job: BotJob): boolean {
    return !!this.d.api.history && (job.rev ?? 1) >= BOT_JOB_REV_MEMORY && this.d.cfg.memoryTailTokens > 0;
  }

  /** Сжимает ли память давнее в сводку (иначе давнее со временем забывается). */
  get summarizes(): boolean {
    return !!this.d.cfg.memoryModel && !!this.d.llm?.summarize;
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
    // Записи журнала, которых бот ещё не учитывал (сервер отдаёт с запасом — повторы узнаём по id).
    const seenBefore = new Set(row?.seenChanges ?? []);
    const firstStatus = got.status;
    const fresh = (firstStatus.changes ?? []).filter((c) => !seenBefore.has(c.id));
    if (row && row.summary.trim()) {
      const cursorMs = Date.parse(row.cursorAt);
      const touched =
        firstStatus.changes === null || firstStatus.truncated
          ? firstStatus.changedFrom !== null && Date.parse(firstStatus.changedFrom) <= cursorMs
          : fresh.some((c) => Date.parse(c.at) <= cursorMs);
      if (firstStatus.reset || touched) {
        // Удалили/поправили то, что уже в сводке (или журнал не может ответить): сводку — с нуля.
        r.log.info("memory.invalidated", { why: firstStatus.reset ? "reset" : "changed", covered: row.covered, version: row.version });
        this.d.store.dropMemory(convId);
        row = null;
        rebuilt = true;
        got = await this.fetch(job.grant, null);
      }
    }
    const status = got.status;
    // Учтённые записи журнала: этот снимок (с запасом по времени) и прежние, если с прошлого раза прошло мало.
    const seenChanges = [
      ...(firstStatus.changes ?? []).filter((c) => c.loggedAt > status.checkedAt - SEEN_WINDOW_MS).map((c) => c.id),
      ...(row && row.checkedAt !== null && status.checkedAt - row.checkedAt < SEEN_WINDOW_MS ? row.seenChanges : []),
    ];
    const seenAll = [...new Set([...seenChanges, ...(firstStatus.changes ?? []).map((c) => c.id)])];

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
    const skips = this.d.store.memorySkips(convId);
    let units = renderUnits(list, this.d.format, skips);

    let summary = row?.summary ?? "";
    let cursor = row ? { at: row.cursorAt, id: row.cursorId } : null;
    let covered = row?.covered ?? 0;
    let version = row?.version ?? 0;
    let minExpiresAt = row?.minExpiresAt ?? null;
    let failedAt = row?.failedAt ?? null;
    let fails = row?.fails ?? 0;
    let forgotten = row?.forgotten ?? 0;
    let forgottenAt = row?.forgottenAt ?? null;
    let compactions = 0;
    let forgot = 0;
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
        fails,
        forgotten,
        forgottenAt,
        seenChanges,
      } satisfies MemoryRow);

    // Вытеснять можно только то, что не новее обращения (ответы бота на прежние вопросы после него — в хвосте).
    const evictable = () => {
      let k = 0;
      while (k < units.length && !(at(lastOf(units[k]!)) > tAt)) k++;
      return k;
    };

    if (total(units) > cfg.memoryTailTokens) {
      const summarize = this.summarizes ? this.d.llm!.summarize!.bind(this.d.llm) : null;
      const started = Date.now();
      while (total(units) > cfg.memoryTailKeepTokens) {
        const ev = evictable();
        if (ev === 0) break;
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

        let forget = !summarize;
        let skipped = false;
        if (summarize && transcript.trim()) {
          if (compactions >= cfg.memoryMaxCalls || Date.now() - started > COMPACT_TIME_MS) break;
          if (failedAt !== null && now - failedAt < backoffMs(fails)) break;
          if (!r.canSpend()) break;
          let ok = false;
          try {
            const res = await summarize({
              previous: summary,
              transcript,
              maxChars: charsForTokens(cfg.memorySummaryTokens),
              kind: job.conversation.kind,
              signal: r.signal,
            });
            r.record(res.cost);
            usd += res.cost.usd;
            if (res.stop === "end_turn" && res.text.trim()) {
              summary = res.text.trim();
              ok = true;
            } else {
              r.log.warn("memory.compact_failed", { stop: res.stop, empty: !res.text.trim(), fails: fails + 1 });
            }
          } catch (e) {
            if (r.signal.aborted) throw e;
            r.log.warn("memory.compact_failed", { err: e as Error, fails: fails + 1 });
          }
          if (!ok) {
            fails++;
            failedAt = now;
            if (fails < MAX_FAILS) break;
            // Этот кусок не сжимается раз за разом (отказ модели на нём, обрыв) — пропустить, иначе память застрянет
            // навсегда, а каждая попытка снова стоит денег.
            r.log.warn("memory.chunk_skipped", { msgs: chunk.reduce((s, u) => s + u.messages.length, 0), fails });
            forget = true;
            skipped = true;
          }
        }
        const last = lastOf(chunk[chunk.length - 1]!);
        cursor = { at: last.createdAt, id: last.id };
        const n = chunk.reduce((s, u) => s + u.messages.length, 0);
        covered += n;
        if (forget) {
          forgotten += n;
          forgot += n;
          forgottenAt = last.createdAt;
        } else {
          for (const u of chunk) {
            for (const m of u.messages) {
              const e = m.expiresAt ? Date.parse(m.expiresAt) : NaN;
              if (Number.isFinite(e)) minExpiresAt = minExpiresAt === null ? e : Math.min(minExpiresAt, e);
            }
          }
          if (transcript.trim()) {
            version++;
            compactions++;
          }
        }
        fails = 0;
        failedAt = null;
        units = units.slice(take);
        save();
        r.log.info(forget ? "memory.forgot" : "memory.compacted", { msgs: n, covered, version, chars: summary.length, usd: Number(usd.toFixed(4)) });
        // После пропуска куска — больше в этом ответе не сжимаем (следующий кусок — на следующем обращении).
        if (skipped) break;
      }
      // Хвост — заново, как его увидит следующий запрос (от нового курсора): иначе первая реплика могла бы
      // отличаться (пометка «к какому обращению»), и следующий вопрос не прочитал бы память из кэша.
      if (compactions || forgot) units = renderUnits(units.flatMap((u) => u.messages), this.d.format, skips);
    }

    // Что не сжалось (лимит вызовов, пауза после сбоя, бюджет) — на этот ответ модель этого не видит (и знает об этом).
    let trimmed = 0;
    let trimmedUntil: string | null = null;
    while (total(units) > cfg.memoryTailTokens && units.length > 1 && evictable() > 0) {
      const u = units.shift()!;
      trimmed += u.messages.length;
      trimmedUntil = lastOf(u).createdAt;
    }
    if (trimmed) r.log.info("memory.trimmed", { msgs: trimmed });
    if (got.truncated) r.log.warn("memory.history_truncated", { pages: got.pages });

    // Первое знакомство: сводки нет, курсор — начало просмотра (дальше не листать то, где нас не звали).
    if (!cursor && got.messages.length) cursor = { at: got.messages[0]!.createdAt, id: "" };
    // Журнал проверен до status.checkedAt — продвинуть, отметить использование.
    if (cursor) save();

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
      seenChanges: seenAll,
      gaps: { trimmed, trimmedUntil, forgottenAt: forgotten > 0 ? forgottenAt : null, truncated: got.truncated },
      stats: {
        tail: units.reduce((s, u) => s + (u.skip ? 0 : u.messages.length), 0),
        tailTokens: total(units),
        summaryChars: view.summary?.length ?? 0,
        compactions,
        forgot,
        rebuilt,
        trimmed,
        usd,
        pages: got.pages,
      },
    };
  }

  /**
   * После ответа модели, до публикации: не удалили ли сообщение, которое модель ВИДЕЛА (дословно — shownIds, или
   * в сводке — createdAt не позже её курсора), пока она думала. true — ответ мог пересказать удалённое,
   * публиковать нельзя. Не считаются: само обращение (его удаление сервер и так не пропустит, правка — опечатка),
   * правки (текст был у модели в руках законно), изменения того, чего модель не видела (новее, чужое), и записи,
   * учтённые ещё при чтении. Сбой проверки — false (не мешаем ответу).
   */
  async changedSince(grant: string, load: MemoryLoad, shown: { ids: string[]; triggerId: string; triggerAt: string }, log: Logger): Promise<boolean> {
    if (!this.d.api.history) return false;
    try {
      const p = await this.d.api.history(grant, { limit: 0, changesSince: load.checkedAt, epoch: load.epoch });
      return memoryChangeMatters(p.memory, load, shown);
    } catch (e) {
      log.debug("memory.recheck_failed", { err: e as Error });
      return false;
    }
  }

  private async fetch(
    grant: string,
    row: MemoryRow | null
  ): Promise<{ status: BotMemoryStatus; messages: BotHistoryMessage[]; mode: "botchat" | "recent"; pages: number; truncated: boolean }> {
    const api = this.d.api;
    let after = row ? { at: row.cursorAt, id: row.cursorId } : null;
    const messages: BotHistoryMessage[] = [];
    let status: BotMemoryStatus | null = null;
    let mode: "botchat" | "recent" = "recent";
    let pages = 0;
    let truncated = false;
    for (;;) {
      if (pages >= MAX_PAGES) {
        truncated = true;
        break;
      }
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
    return { status: status!, messages, mode, pages, truncated };
  }
}

/** Решение проверки после ответа (отдельно — для тестов). */
export function memoryChangeMatters(
  st: BotMemoryStatus,
  load: Pick<MemoryLoad, "seenChanges" | "view">,
  shown: { ids: string[]; triggerId: string; triggerAt: string }
): boolean {
  if (st.reset) return true;
  const seen = new Set(load.seenChanges);
  const ids = new Set(shown.ids);
  const cursorMs = load.view.summary && load.view.summaryUntil ? Date.parse(load.view.summaryUntil) : null;
  const visible = (c: BotMemoryChange) => ids.has(c.messageId) || (cursorMs !== null && Date.parse(c.at) <= cursorMs);
  if (st.changes && !st.truncated) {
    return st.changes.some((c) => !seen.has(c.id) && c.kind === "deleted" && c.messageId !== shown.triggerId && visible(c));
  }
  // Сервер не прислал список — по самому раннему изменённому: всё, что не новее обращения, модель могла видеть.
  return st.changedFrom !== null && Date.parse(st.changedFrom) < Date.parse(shown.triggerAt);
}
