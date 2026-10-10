/**
 * Контекст для модели — из задачи очереди (её собрал сервер, src/lib/systemBot.ts):
 *   - цепочка ответов (chain): триггер и его предки по replyTo в этой беседе (loadReplyChain);
 *   - история (history, контракт rev 2) — контекст без цитирования (решение владельца 2026-10-10):
 *       "botchat" — «Чат с Еблушей»: последние сообщения чата, разговор идёт без ответа на сообщение;
 *       "recent"  — обычная беседа: свои разговоры за последние 30 минут — обращения к боту от любого
 *                   участника (с именами) и ответы бота; остальную переписку людей сервер не отдаёт.
 * Остальное бот не видит и не запрашивает. Текст сообщений бот на диск не пишет.
 *
 * Сборка: история (без дублей с цепочкой) → цепочка → триггер; каждое сообщение — реплика user/assistant
 * (у человека — «Имя: текст»), подряд идущие одной роли сливаются в одну реплику API (turnsToMessages).
 * Под бюджет: не больше historyMaxMessages и ~historyMaxTokens; длинные ответы бота ужимаются, старое
 * отбрасывается первым. Начало окна истории держится на «якорных» сообщениях (stableStart), чтобы
 * несколько обменов подряд префикс промпта не менялся и читался из кэша (точка кэша — на конце истории).
 */
import type { ChatApi } from "../api/eblusha";
import type { BotJob, BotJobMessage } from "../api/types";
import type { LlmImage, LlmTurn } from "../llm/types";
import { sniffImage } from "./images";
import { invocationText, isThanksOrLaugh } from "./invoke";

/** Цепочка от самого старого к триггеру (включительно), не длиннее max. */
export function jobChain(job: BotJob, max: number): BotJobMessage[] {
  const all = [...job.chain, job.message];
  return all.slice(Math.max(0, all.length - Math.max(1, max)));
}

export function messageText(m: BotJobMessage): string {
  const stripped = invocationText(m.content);
  const atts = m.attachments ?? [];
  const notes: string[] = [];
  const count = (t: string) => atts.filter((a) => a.type === t).length;
  if (count("IMAGE")) notes.push(`[картинок: ${count("IMAGE")}]`);
  if (count("VIDEO")) notes.push("[видео]");
  if (count("AUDIO")) notes.push("[голосовое сообщение — расшифровки нет]");
  if (count("FILE")) notes.push("[файл]");
  return [stripped, ...notes].filter(Boolean).join(" ");
}

export interface TurnOptions {
  nameOf(m: BotJobMessage): string;
  /** Загрузить картинки сообщения (для триггера и того, на что он отвечает). */
  loadImages?(m: BotJobMessage): Promise<LlmImage[]>;
}

function botText(m: BotJobMessage): string {
  return m.content?.trim() || (m.attachments?.length ? "[картинка]" : "…");
}

/** Реплики цепочки; keepLeadingAssistant — не срезать ответы бота в начале (перед ними идёт история). */
export async function chainToTurns(chain: BotJobMessage[], o: TurnOptions, keepLeadingAssistant = false): Promise<LlmTurn[]> {
  const turns: LlmTurn[] = [];
  const trigger = chain[chain.length - 1];
  const triggerParent = chain.length > 1 ? chain[chain.length - 2] : undefined;
  for (const m of chain) {
    if (m.isBot) {
      turns.push({ role: "assistant", text: botText(m) });
      continue;
    }
    const t: LlmTurn = { role: "user", text: `${o.nameOf(m)}: ${messageText(m) || "(без текста)"}` };
    if (o.loadImages && (m === trigger || m === triggerParent) && (m.attachments ?? []).some((a) => a.type === "IMAGE")) {
      const imgs = await o.loadImages(m);
      if (imgs.length) t.images = imgs;
    }
    turns.push(t);
  }
  if (!keepLeadingAssistant) while (turns.length && turns[0]!.role !== "user") turns.shift();
  return turns;
}

// ---------------------------------------------------------------- история

export interface HistoryLimits {
  /** Сообщений истории не больше (0 — история выключена). */
  maxMessages: number;
  /** Бюджет истории, токенов (оценка). */
  maxTokens: number;
  /** Ответ бота в истории — не длиннее (символов). */
  botChars: number;
  /** Сообщение человека в истории — не длиннее (символов). */
  userChars: number;
  /** "recent": окно, мс (сервер шлёт своё; берётся меньшее). */
  recentWindowMs: number;
}

const SHORTENED = " …(сокращено)";

export function shorten(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - SHORTENED.length)).trimEnd()}${SHORTENED}`;
}

/** Грубая оценка токенов (кириллица ~3 символа на токен) — для бюджета, не для счёта денег. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3) + 4;
}

/** FNV-1a 32 бит. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** «Якорь» — сообщение, с которого можно начинать окно истории (в среднем каждое 8-е, по id). */
export const ANCHOR_EVERY = 8;
export function isAnchor(id: string): boolean {
  return fnv1a(id) % ANCHOR_EVERY === 0;
}

/**
 * С какого сообщения начать окно истории. Влезает всё — с начала. Иначе — с самого старого «якоря», от
 * которого остаток влезает в лимиты: пока новые сообщения дописываются в конец, начало окна стоит на
 * месте, и префикс промпта (системный текст + история) читается из кэша; когда перестаёт влезать —
 * окно перескакивает на следующий якорь (один промах кэша на ~8 сообщений вместо промаха на каждом).
 * Якоря нет — самое раннее начало, которое влезает.
 */
export function stableStart(ids: string[], costs: number[], maxMessages: number, maxTokens: number): number {
  const n = ids.length;
  if (n === 0 || maxMessages <= 0 || maxTokens <= 0) return n;
  const suffix = new Array<number>(n + 1).fill(0);
  for (let i = n - 1; i >= 0; i--) suffix[i] = suffix[i + 1]! + costs[i]!;
  const fits = (s: number) => n - s <= maxMessages && suffix[s]! <= maxTokens;
  if (fits(0)) return 0;
  let plain = n;
  for (let s = 0; s < n; s++) {
    if (fits(s)) {
      plain = s;
      break;
    }
  }
  for (let s = plain; s < n; s++) if (isAnchor(ids[s]!)) return s;
  return plain;
}

export interface PickedHistory {
  mode: "botchat" | "recent" | null;
  /** Окно "recent", которое действительно применено (меньшее из серверного и своего), мс; иначе null. */
  windowMs: number | null;
  messages: BotJobMessage[];
  turns: LlmTurn[];
}

/** История из задачи → реплики (без дублей с цепочкой, по окну, бюджету и якорям). */
export function pickHistory(job: BotJob, chain: BotJobMessage[], limits: HistoryLimits, nameOf: (m: BotJobMessage) => string): PickedHistory {
  const h = job.history;
  if (!h || limits.maxMessages <= 0 || limits.maxTokens <= 0) return { mode: h?.mode ?? null, windowMs: null, messages: [], turns: [] };
  const skip = new Set<string>([job.message.id, ...chain.map((m) => m.id)]);
  const anchorAt = Date.parse(job.message.createdAt);
  const windowMs = h.mode === "recent" ? Math.min(h.windowMs ?? limits.recentWindowMs, limits.recentWindowMs) : null;
  const seen = new Set<string>();
  const list: Array<{ m: BotJobMessage; turn: LlmTurn; cost: number; at: number; i: number }> = [];
  h.messages.forEach((m, i) => {
    if (skip.has(m.id) || seen.has(m.id)) return;
    seen.add(m.id);
    const at = Date.parse(m.createdAt);
    if (Number.isFinite(anchorAt) && Number.isFinite(at)) {
      if (at > anchorAt) return; // новее обращения — не наше
      if (windowMs !== null && at < anchorAt - windowMs) return;
    } else if (windowMs !== null) {
      return; // без времени окно не проверить — не берём
    }
    let turn: LlmTurn;
    if (m.isBot) {
      turn = { role: "assistant", text: shorten(botText(m), limits.botChars) };
    } else {
      const body = messageText(m);
      // «спасибо», «ахах» — бот на них ставит 👍, в истории они ничего не добавляют
      if (!(m.attachments ?? []).length && body && isThanksOrLaugh(body)) return;
      turn = { role: "user", text: `${nameOf(m)}: ${shorten(body || "(без текста)", limits.userChars)}` };
    }
    list.push({ m, turn, cost: estimateTokens(turn.text), at: Number.isFinite(at) ? at : 0, i });
  });
  list.sort((a, b) => a.at - b.at || a.i - b.i);
  const start = stableStart(
    list.map((x) => x.m.id),
    list.map((x) => x.cost),
    limits.maxMessages,
    limits.maxTokens
  );
  const kept = list.slice(start);
  return { mode: h.mode, windowMs, messages: kept.map((x) => x.m), turns: kept.map((x) => x.turn) };
}

export interface BuiltContext {
  turns: LlmTurn[];
  /** Индекс последней реплики истории — там точка кэша промпта; null — истории нет. */
  cacheAt: number | null;
  /** Сколько сообщений истории ушло модели. */
  historyCount: number;
  /** Режим истории задачи (null — истории нет: старый сервер, выключена или пусто). */
  historyMode: "botchat" | "recent" | null;
  /** Окно "recent", мс (для подсказки модели «за последние N мин»). */
  historyWindowMs: number | null;
}

/** Реплики для модели: история → цепочка → триггер. Первая реплика — всегда человека. */
export async function buildContext(job: BotJob, o: TurnOptions & { chainMax: number; limits: HistoryLimits }): Promise<BuiltContext> {
  const chain = jobChain(job, o.chainMax);
  const hist = pickHistory(job, chain, o.limits, o.nameOf);
  const chainTurns = await chainToTurns(chain, o, hist.turns.length > 0);
  const turns = [...hist.turns, ...chainTurns];
  let cacheAt: number | null = hist.turns.length ? hist.turns.length - 1 : null;
  let dropped = 0;
  while (turns.length && turns[0]!.role !== "user") {
    turns.shift();
    dropped++;
  }
  let historyCount = hist.messages.length;
  if (cacheAt !== null) {
    cacheAt -= dropped;
    historyCount = Math.max(0, historyCount - Math.min(dropped, hist.turns.length));
    if (cacheAt < 0) cacheAt = null;
  }
  return { turns, cacheAt, historyCount, historyMode: historyCount > 0 ? hist.mode : null, historyWindowMs: hist.windowMs };
}

/** Картинки сообщения Еблуши → блоки для модели (серверные превью, максимум 3). */
export async function loadMessageImages(api: Pick<ChatApi, "fetchFile">, m: BotJobMessage): Promise<LlmImage[]> {
  const out: LlmImage[] = [];
  for (const a of (m.attachments ?? []).filter((x) => x.type === "IMAGE").slice(0, 3)) {
    const f = (await api.fetchFile(a.url, { thumb: true, maxBytes: 5 * 1024 * 1024 })) ?? (await api.fetchFile(a.url, { maxBytes: 5 * 1024 * 1024 }));
    if (!f) continue;
    const info = sniffImage(f.data);
    if (!info) continue;
    out.push({ mime: info.mime, data: f.data });
  }
  return out;
}
