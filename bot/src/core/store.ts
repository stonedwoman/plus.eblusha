/**
 * Состояние бота: SQLite (встроенный node:sqlite, без нативных зависимостей) в BOT_DATA_DIR.
 *
 * Таблицы:
 *   usage         — учёт расходов на модель по ответам: токены, поиски, $; БЕЗ текста;
 *   char_links    — привязка userId ↔ персонаж Valheim (у персонажа один человек);
 *   confirmations — ожидающие «да» команды владельца;
 *   notices       — «уже говорил» (подсказки, отказы) с ограничением частоты;
 *   memory        — память о своих разговорах (core/memory.ts): по беседе — сводка давнего (ТЕКСТ, написанный
 *                   моделью сжатия по обращениям и ответам), курсор покрытия, версия, время. Источник правды —
 *                   сервер: сводку можно удалить в любой момент, она соберётся заново из истории беседы;
 *   memory_skip   — обращения, которые в память не берутся (отказ по лимитам, ответ отменён): только id.
 *
 * secure_delete: удалённое (выброшенная сводка) затирается нулями, а не остаётся в свободных страницах файла
 * (находка ревью: текст сводки переживал её удаление); после удаления сводок — ещё и сброс WAL.
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface UsageRow {
  ts: number;
  userId: string;
  conversationId: string;
  kind: string; // answer | nick_match | …
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  webSearches: number;
  webFetches: number;
  costUsd: number;
}

export interface ConfirmationRow {
  id: number;
  ownerId: string;
  conversationId: string;
  botMessageId: string;
  command: string;
  argsJson: string;
  expiresAt: number;
  usedAt: number | null;
}

/** Память бота об одной беседе (таблица memory). */
export interface MemoryRow {
  conversationId: string;
  /** Сводка всего, что не дальше курсора (может быть пустой: тогда курсор — просто начало просмотра). */
  summary: string;
  /** Курсор покрытия: сообщения с (createdAt, id) ≤ (cursorAt, cursorId) уже в сводке. */
  cursorAt: string;
  cursorId: string;
  /** Сколько сообщений свёрнуто в сводку. */
  covered: number;
  /** Номер ревизии сводки (растёт при каждом сжатии; с нуля — после пересборки). */
  version: number;
  /** Формат/промпт сжатия (MEMORY_FORMAT): сменился — сводка пересобирается. */
  format: number;
  /** Журнал изменений сервера: опознаватель и время сервера, до которого изменения уже учтены. */
  epoch: string | null;
  checkedAt: number | null;
  /** Самое раннее expiresAt среди свёрнутого (мс): наступило — пересобрать без исчезнувшего. */
  minExpiresAt: number | null;
  updatedAt: number;
  usedAt: number;
  /** Последний сбой сжатия (мс) — не повторять каждый раз. */
  failedAt: number | null;
  /** Сбоев сжатия подряд (на одном и том же куске): растёт пауза, после нескольких кусок пропускается. */
  fails: number;
  /**
   * Сколько сообщений свёрнуто БЕЗ сводки (сжатие выключено, кусок так и не сжался) и до какого createdAt (ISO):
   * этих разговоров бот не помнит — и модели так и говорится.
   */
  forgotten: number;
  forgottenAt: string | null;
  /** id записей журнала изменений, уже учтённых (сервер отдаёт журнал с запасом — не учитывать дважды). */
  seenChanges: string[];
}

function parseIds(v: unknown): string[] {
  try {
    const a = JSON.parse(typeof v === "string" ? v : "[]") as unknown;
    return Array.isArray(a) ? a.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function utcDay(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}
export function utcMonth(ts: number): string {
  return new Date(ts).toISOString().slice(0, 7);
}

export class Store {
  private readonly db: DatabaseSync;

  constructor(file: string) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 3000;
      PRAGMA secure_delete = ON;
      CREATE TABLE IF NOT EXISTS usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        day TEXT NOT NULL,
        month TEXT NOT NULL,
        user_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cache_write_tokens INTEGER NOT NULL,
        cache_read_tokens INTEGER NOT NULL,
        web_searches INTEGER NOT NULL,
        web_fetches INTEGER NOT NULL,
        cost_usd REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS usage_month ON usage(month);
      CREATE INDEX IF NOT EXISTS usage_day_user ON usage(day, user_id);
      CREATE TABLE IF NOT EXISTS char_links (
        character TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        linked_by TEXT NOT NULL,
        verified INTEGER NOT NULL,
        linked_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS char_links_user ON char_links(user_id);
      CREATE TABLE IF NOT EXISTS confirmations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        bot_message_id TEXT NOT NULL UNIQUE,
        command TEXT NOT NULL,
        args_json TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS notices (
        key TEXT PRIMARY KEY,
        at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory (
        conversation_id TEXT PRIMARY KEY,
        summary TEXT NOT NULL,
        cursor_at TEXT NOT NULL,
        cursor_id TEXT NOT NULL,
        covered INTEGER NOT NULL,
        version INTEGER NOT NULL,
        format INTEGER NOT NULL,
        epoch TEXT,
        checked_at INTEGER,
        min_expires_at INTEGER,
        updated_at INTEGER NOT NULL,
        used_at INTEGER NOT NULL,
        failed_at INTEGER,
        fails INTEGER NOT NULL DEFAULT 0,
        forgotten INTEGER NOT NULL DEFAULT 0,
        forgotten_at TEXT,
        seen_changes TEXT NOT NULL DEFAULT '[]'
      );
      CREATE INDEX IF NOT EXISTS memory_used ON memory(used_at);
      CREATE TABLE IF NOT EXISTS memory_skip (
        conversation_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        at INTEGER NOT NULL,
        PRIMARY KEY (conversation_id, message_id)
      );
      CREATE INDEX IF NOT EXISTS memory_skip_at ON memory_skip(at);
    `);
    // Таблица memory из ранней сборки этой ветки — без новых столбцов: добавить (уже есть — SQLite откажет, это норма).
    for (const col of ["fails INTEGER NOT NULL DEFAULT 0", "forgotten INTEGER NOT NULL DEFAULT 0", "forgotten_at TEXT", "seen_changes TEXT NOT NULL DEFAULT '[]'"]) {
      try {
        this.db.exec(`ALTER TABLE memory ADD COLUMN ${col}`);
      } catch {
        /* столбец уже есть */
      }
    }
  }

  close(): void {
    this.db.close();
  }

  // ---------- расходы ----------
  recordUsage(u: UsageRow): void {
    this.db
      .prepare(
        `INSERT INTO usage (ts, day, month, user_id, conversation_id, kind, model, input_tokens, output_tokens,
           cache_write_tokens, cache_read_tokens, web_searches, web_fetches, cost_usd)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        u.ts,
        utcDay(u.ts),
        utcMonth(u.ts),
        u.userId,
        u.conversationId,
        u.kind,
        u.model,
        u.inputTokens,
        u.outputTokens,
        u.cacheWriteTokens,
        u.cacheReadTokens,
        u.webSearches,
        u.webFetches,
        u.costUsd
      );
  }

  spentMonth(month: string): number {
    const r = this.db.prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS s FROM usage WHERE month = ?`).get(month) as { s: number };
    return Number(r.s) || 0;
  }

  spentDay(day: string): number {
    const r = this.db.prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS s FROM usage WHERE day = ?`).get(day) as { s: number };
    return Number(r.s) || 0;
  }

  userDay(userId: string, day: string): { questions: number; usd: number } {
    const r = this.db
      .prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(cost_usd), 0) AS s FROM usage WHERE day = ? AND user_id = ? AND kind = 'answer'`)
      .get(day, userId) as { n: number; s: number };
    const all = this.db
      .prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS s FROM usage WHERE day = ? AND user_id = ?`)
      .get(day, userId) as { s: number };
    return { questions: Number(r.n) || 0, usd: Number(all.s) || 0 };
  }

  /** Сколько обращений вида kind сделал человек за сутки (например, nick_match). */
  userKindCount(userId: string, day: string, kind: string): number {
    const r = this.db
      .prepare(`SELECT COUNT(*) AS n FROM usage WHERE day = ? AND user_id = ? AND kind = ?`)
      .get(day, userId, kind) as { n: number };
    return Number(r.n) || 0;
  }

  monthSummary(month: string): { requests: number; usd: number; webSearches: number; users: number } {
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(cost_usd),0) AS s, COALESCE(SUM(web_searches),0) AS w, COUNT(DISTINCT user_id) AS u
           FROM usage WHERE month = ?`
      )
      .get(month) as { n: number; s: number; w: number; u: number };
    return { requests: Number(r.n), usd: Number(r.s), webSearches: Number(r.w), users: Number(r.u) };
  }

  // ---------- привязки персонажей ----------
  getCharacters(userId: string): string[] {
    const rows = this.db.prepare(`SELECT character FROM char_links WHERE user_id = ? ORDER BY linked_at`).all(userId) as Array<{ character: string }>;
    return rows.map((r) => r.character);
  }

  getLinkOwner(character: string): string | null {
    const r = this.db.prepare(`SELECT user_id FROM char_links WHERE character = ?`).get(character) as { user_id: string } | undefined;
    return r?.user_id ?? null;
  }

  allLinks(): Array<{ userId: string; character: string; verified: boolean }> {
    const rows = this.db.prepare(`SELECT user_id, character, verified FROM char_links ORDER BY character`).all() as Array<{
      user_id: string;
      character: string;
      verified: number;
    }>;
    return rows.map((r) => ({ userId: r.user_id, character: r.character, verified: r.verified === 1 }));
  }

  /**
   * Привязать персонажа к человеку. replaceOwn — снять прежние привязки этого человека
   * (перепривязка той же фразой). force — отобрать у другого (только владелец).
   */
  link(
    userId: string,
    character: string,
    opts: { linkedBy: string; verified: boolean; replaceOwn: boolean; force: boolean; now?: number }
  ): { ok: true } | { ok: false; takenBy: string } {
    const holder = this.getLinkOwner(character);
    if (holder && holder !== userId && !opts.force) return { ok: false, takenBy: holder };
    this.db.exec("BEGIN");
    try {
      if (opts.replaceOwn) this.db.prepare(`DELETE FROM char_links WHERE user_id = ?`).run(userId);
      this.db
        .prepare(
          `INSERT INTO char_links (character, user_id, linked_by, verified, linked_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(character) DO UPDATE SET user_id = excluded.user_id, linked_by = excluded.linked_by,
             verified = excluded.verified, linked_at = excluded.linked_at`
        )
        .run(character, userId, opts.linkedBy, opts.verified ? 1 : 0, opts.now ?? Date.now());
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return { ok: true };
  }

  unlinkUser(userId: string): number {
    const r = this.db.prepare(`DELETE FROM char_links WHERE user_id = ?`).run(userId);
    return Number(r.changes);
  }

  /** Снять привязку персонажа (владелец: «отвяжи персонажа X»). Возвращает, у кого он был. */
  unlinkCharacter(character: string): string | null {
    const holder = this.getLinkOwner(character);
    if (holder) this.db.prepare(`DELETE FROM char_links WHERE character = ?`).run(character);
    return holder;
  }

  // ---------- подтверждения владельца ----------
  createConfirmation(c: Omit<ConfirmationRow, "id" | "usedAt">): void {
    this.db
      .prepare(
        `INSERT INTO confirmations (owner_id, conversation_id, bot_message_id, command, args_json, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(c.ownerId, c.conversationId, c.botMessageId, c.command, c.argsJson, c.expiresAt);
  }

  /** Забрать подтверждение по сообщению бота: ровно один раз и только до истечения срока. */
  takeConfirmation(botMessageId: string, ownerId: string, now: number): ConfirmationRow | null {
    const r = this.db
      .prepare(
        `UPDATE confirmations SET used_at = ?
          WHERE bot_message_id = ? AND owner_id = ? AND used_at IS NULL AND expires_at > ?
          RETURNING id, owner_id, conversation_id, bot_message_id, command, args_json, expires_at, used_at`
      )
      .get(now, botMessageId, ownerId, now) as
      | { id: number; owner_id: string; conversation_id: string; bot_message_id: string; command: string; args_json: string; expires_at: number; used_at: number }
      | undefined;
    if (!r) return null;
    return {
      id: r.id,
      ownerId: r.owner_id,
      conversationId: r.conversation_id,
      botMessageId: r.bot_message_id,
      command: r.command,
      argsJson: r.args_json,
      expiresAt: r.expires_at,
      usedAt: r.used_at,
    };
  }

  isConfirmationMessage(botMessageId: string): boolean {
    return !!this.db.prepare(`SELECT 1 AS x FROM confirmations WHERE bot_message_id = ?`).get(botMessageId);
  }

  // ---------- отметки времени (докачка пропущенного после рестарта) ----------
  getMark(key: string): number | null {
    const r = this.db.prepare(`SELECT at FROM notices WHERE key = ?`).get(`mark:${key}`) as { at: number } | undefined;
    return r ? Number(r.at) : null;
  }

  setMark(key: string, at: number): void {
    this.db
      .prepare(`INSERT INTO notices (key, at) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET at = MAX(at, excluded.at)`)
      .run(`mark:${key}`, at);
  }

  // ---------- память о разговорах ----------
  getMemory(conversationId: string): MemoryRow | null {
    const r = this.db.prepare(`SELECT * FROM memory WHERE conversation_id = ?`).get(conversationId) as Record<string, unknown> | undefined;
    if (!r) return null;
    const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
    return {
      conversationId: String(r.conversation_id),
      summary: String(r.summary),
      cursorAt: String(r.cursor_at),
      cursorId: String(r.cursor_id),
      covered: Number(r.covered),
      version: Number(r.version),
      format: Number(r.format),
      epoch: r.epoch === null || r.epoch === undefined ? null : String(r.epoch),
      checkedAt: n(r.checked_at),
      minExpiresAt: n(r.min_expires_at),
      updatedAt: Number(r.updated_at),
      usedAt: Number(r.used_at),
      failedAt: n(r.failed_at),
      fails: Number(r.fails ?? 0) || 0,
      forgotten: Number(r.forgotten ?? 0) || 0,
      forgottenAt: r.forgotten_at === null || r.forgotten_at === undefined ? null : String(r.forgotten_at),
      seenChanges: parseIds(r.seen_changes),
    };
  }

  saveMemory(m: MemoryRow): void {
    this.db
      .prepare(
        `INSERT INTO memory (conversation_id, summary, cursor_at, cursor_id, covered, version, format, epoch, checked_at,
           min_expires_at, updated_at, used_at, failed_at, fails, forgotten, forgotten_at, seen_changes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(conversation_id) DO UPDATE SET summary = excluded.summary, cursor_at = excluded.cursor_at,
           cursor_id = excluded.cursor_id, covered = excluded.covered, version = excluded.version, format = excluded.format,
           epoch = excluded.epoch, checked_at = excluded.checked_at, min_expires_at = excluded.min_expires_at,
           updated_at = excluded.updated_at, used_at = excluded.used_at, failed_at = excluded.failed_at,
           fails = excluded.fails, forgotten = excluded.forgotten, forgotten_at = excluded.forgotten_at,
           seen_changes = excluded.seen_changes`
      )
      .run(
        m.conversationId,
        m.summary,
        m.cursorAt,
        m.cursorId,
        m.covered,
        m.version,
        m.format,
        m.epoch,
        m.checkedAt,
        m.minExpiresAt,
        m.updatedAt,
        m.usedAt,
        m.failedAt,
        m.fails,
        m.forgotten,
        m.forgottenAt,
        JSON.stringify(m.seenChanges.slice(-500))
      );
  }

  /**
   * Выбросить сводку беседы (затирается: secure_delete) и сбросить WAL, где могла остаться её копия. withSkips —
   * и пометки «не брать в память» (беседы больше нет).
   */
  dropMemory(conversationId: string, opts: { withSkips?: boolean } = {}): void {
    this.db.prepare(`DELETE FROM memory WHERE conversation_id = ?`).run(conversationId);
    if (opts.withSkips) this.db.prepare(`DELETE FROM memory_skip WHERE conversation_id = ?`).run(conversationId);
    this.checkpoint();
  }

  /** Удалить сводки бесед, к которым не обращались с `before` (мс). Возвращает, сколько удалено. */
  purgeIdleMemory(before: number): number {
    const n = Number(this.db.prepare(`DELETE FROM memory WHERE used_at < ?`).run(before).changes);
    this.db.prepare(`DELETE FROM memory_skip WHERE at < ?`).run(before);
    if (n) this.checkpoint();
    return n;
  }

  /** Обращение не брать в память беседы (и ответ на него): отказ по лимитам, ответ отменён. */
  skipInMemory(conversationId: string, messageId: string, at = Date.now()): void {
    this.db
      .prepare(`INSERT INTO memory_skip (conversation_id, message_id, at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`)
      .run(conversationId, messageId, at);
  }

  memorySkips(conversationId: string): Set<string> {
    const rows = this.db.prepare(`SELECT message_id FROM memory_skip WHERE conversation_id = ?`).all(conversationId) as Array<{ message_id: string }>;
    return new Set(rows.map((r) => String(r.message_id)));
  }

  /** Перенести WAL в файл и обнулить его: копии удалённых страниц там не остаются. Сбой — не страшно. */
  private checkpoint(): void {
    try {
      this.db.exec(`PRAGMA wal_checkpoint(TRUNCATE)`);
    } catch {
      /* занято — в следующий раз */
    }
  }

  // ---------- «уже говорил» ----------
  /** true — можно сказать (и отметить); false — уже говорили в пределах ttl. */
  noticeOnce(key: string, ttlMs: number, now = Date.now()): boolean {
    const r = this.db.prepare(`SELECT at FROM notices WHERE key = ?`).get(key) as { at: number } | undefined;
    if (r && now - r.at < ttlMs) return false;
    this.db.prepare(`INSERT INTO notices (key, at) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET at = excluded.at`).run(key, now);
    return true;
  }
}
