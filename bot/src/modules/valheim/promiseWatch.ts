/**
 * Таймер обещания: «пришёл» по входу в Valheim (docs/promise-timer.md). Сервер мессенджера не видит ни мода игры,
 * ни привязок персонажей — следит бот.
 *
 *   - Раз в 30 с — идущие таймеры (GET /api/bot/promises/active: id, беседа, обещавший, начало, срок — без текстов).
 *     Нет таймеров у людей с привязанными персонажами — мод не опрашиваем вовсе.
 *   - Есть — игроки раз в 15 с (мод, loopback). Персонаж обещавшего в игре и вошёл НЕ РАНЬШЕ обещания (since ≥
 *     startAt) → POST /api/bot/promises/:id/arrived {via:"valheim", at: since, detail: персонаж}. Был в игре раньше
 *     обещания — не считается (он обещал что-то другое). «Скрыт с карты» не мешает: вход видят все игроки, место
 *     не раскрывается. Перезапуск бота ничего не теряет: считаем по since, а не по моменту опроса.
 *   - Без since (данные карты без мода) — вход замечается переходом «не было в игре → есть» между опросами, если
 *     прошлый опрос был уже после обещания.
 */
import type { CoreServices } from "../api";

export interface OnlinePlayer {
  name: string;
  /** Когда вошёл (мс); null — неизвестно. */
  since: number | null;
}

export class PromiseWatch {
  private timer: NodeJS.Timeout | null = null;
  private active: Array<{ id: string; promiserId: string; startAt: string }> = [];
  private activeAt = 0;
  private lastPoll = 0;
  private lastSeen = new Set<string>();
  private readonly done = new Set<string>();
  private busy = false;

  constructor(
    private readonly core: CoreServices,
    private readonly online: () => Promise<OnlinePlayer[]>,
    private readonly opts: { activeEveryMs?: number; playersEveryMs?: number; now?: () => number } = {}
  ) {}

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  start(): void {
    if (!this.core.promises || this.timer) return;
    const every = this.opts.playersEveryMs ?? 15_000;
    this.timer = setInterval(() => void this.tick(), every);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Один шаг (тесты зовут напрямую). Возвращает, сколько таймеров отмечено. */
  async tick(): Promise<number> {
    if (!this.core.promises || this.busy) return 0;
    this.busy = true;
    try {
      const t = this.now();
      if (t - this.activeAt >= (this.opts.activeEveryMs ?? 30_000) || this.activeAt === 0) {
        this.active = (await this.core.promises.active()).map((p) => ({ id: p.id, promiserId: p.promiserId, startAt: p.startAt }));
        this.activeAt = t;
      }
      const watched = this.active.filter((p) => !this.done.has(p.id) && this.core.links.charactersOf(p.promiserId).length > 0);
      if (!watched.length) {
        this.lastSeen.clear();
        this.lastPoll = 0;
        return 0;
      }
      const players = await this.online();
      const seen = new Set(players.map((p) => p.name));
      let marked = 0;
      for (const p of watched) {
        const start = Date.parse(p.startAt);
        for (const ch of this.core.links.charactersOf(p.promiserId)) {
          const pl = players.find((x) => x.name === ch);
          if (!pl) continue;
          let at: number | null = null;
          if (pl.since !== null) at = pl.since >= start - 1000 ? pl.since : null;
          else if (this.lastPoll >= start && !this.lastSeen.has(ch)) at = t;
          if (at === null) continue;
          const ok = await this.core.promises.arrived(p.id, { at: new Date(Math.min(at, t)).toISOString(), detail: ch });
          this.done.add(p.id);
          if (ok) {
            marked++;
            this.core.log.info("promise.valheim_arrived", {});
          }
          break;
        }
      }
      this.lastSeen = seen;
      this.lastPoll = t;
      if (this.done.size > 2000) this.done.clear();
      return marked;
    } catch (e) {
      this.core.log.debug("promise.valheim_watch_failed", { err: e as Error });
      return 0;
    } finally {
      this.busy = false;
    }
  }
}
