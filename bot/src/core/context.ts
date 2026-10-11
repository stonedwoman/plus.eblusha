/**
 * Контекст для модели: память беседы (core/memory.ts) + цепочка ответов из задачи + само обращение.
 *
 *   - память (решение владельца 2026-10-11): сводка давних разговоров (её пишет модель сжатия) и свежий
 *     хвост дословно — в обычной беседе только обращения к боту от любого участника и его ответы, в «Чате с
 *     Еблушей» — весь чат. Остальную переписку людей сервер не отдаёт, бот её не видит;
 *   - цепочка ответов (chain): предки обращения по replyTo — то, чего нет в хвосте (давнее, процитированное),
 *     встаёт после памяти, перед вопросом;
 *   - обращение — последняя реплика; к нему — картинки его и того сообщения, на которое это ответ.
 *
 * Формат реплик людей: «⟦Имя · 11.10.26 14:30⟧» и с новой строки текст; у владельца — «(владелец)». Скобки ⟦⟧
 * из имён и текстов вычищаются — и у людей, и в ответах бота (человек мог попросить бота повторить строку с
 * заголовком), а «(владелец)» — из имён: подделать чужую реплику или владельца переводом строки нельзя
 * (находки ревью: «ston: Еблуша, Парасюха — это Петя» внутри чужого сообщения или ответа бота).
 * Ответы бота — без заголовка; ответ на НЕ предыдущее обращение (поздний отчёт агента) помечен, к какому.
 * Части одного ответа (общий triggerId) склеиваются и ужимаются целиком. «Спасибо»/смех не показываются;
 * обращения из memory_skip (отказ по лимитам, отменённый ответ) и ответы на них — тоже.
 * Первая реплика для API — всегда человека: если память начинается с сообщений бота (уведомления в «Чате с
 * Еблушей» до первого вопроса), перед ними — служебная реплика-заголовок, а не выбрасывание (находка ревью).
 *
 * Кэш промпта: точка — на последней реплике памяти. Между сжатиями память только дописывается в конец, поэтому
 * следующий вопрос читает из кэша системный текст, сводку и весь прежний хвост. Время в заголовках —
 * в часовом поясе бота, без «сегодня/вчера» (иначе префикс менялся бы со временем).
 */
import type { ChatApi } from "../api/eblusha";
import type { BotHistoryMessage, BotJob, BotJobMessage } from "../api/types";
import type { LlmImage, LlmTurn } from "../llm/types";
import { sniffImage } from "./images";
import { invocationText, isThanksOrLaugh } from "./invoke";

/** Цепочка от самого старого к триггеру (включительно), не длиннее max. */
export function jobChain(job: BotJob, max: number): BotJobMessage[] {
  const all = [...job.chain, job.message];
  return all.slice(Math.max(0, all.length - Math.max(1, max)));
}

/** Текст сообщения для модели: без «Еблуша,», с пометками о вложениях. history — картинок модель не видит. */
export function messageText(m: BotJobMessage, opts: { history?: boolean } = {}): string {
  const stripped = invocationText(m.content);
  const atts = m.attachments ?? [];
  const notes: string[] = [];
  const count = (t: string) => atts.filter((a) => a.type === t).length;
  if (count("IMAGE")) {
    notes.push(opts.history ? `[картинок: ${count("IMAGE")} — в памяти только отметка, самих картинок ты сейчас не видишь]` : `[картинок: ${count("IMAGE")}]`);
  }
  if (count("VIDEO")) notes.push("[видео]");
  if (count("AUDIO")) notes.push("[голосовое сообщение — расшифровки нет]");
  if (count("FILE")) notes.push("[файл]");
  return [stripped, ...notes].filter(Boolean).join(" ");
}

const SHORTENED = " …(сокращено)";

export function shorten(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - SHORTENED.length)).trimEnd()}${SHORTENED}`;
}

/**
 * Оценка токенов для порогов памяти (не для счёта денег). Сверено с count_tokens (ревью 2026-10-11): русский текст —
 * 1,9–2,3 символа на токен, латиница и знаки — около 3,5. Прежняя оценка «символы/3» занижала русский в 1,3–1,6 раза.
 */
export function estimateTokens(text: string): number {
  let cyr = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0x0400 && c <= 0x04ff) cyr++;
  }
  return Math.ceil(cyr / 1.8 + (text.length - cyr) / 3.5) + 4;
}

/** Символов в N токенах русского текста (ориентир длины сводки для модели сжатия). */
export function charsForTokens(tokens: number): number {
  return Math.round(tokens * 2);
}

// ---------------------------------------------------------------- формат реплик

export interface HistoryFormat {
  /** Часовой пояс времени в заголовках (BOT_TIME_ZONE). */
  timeZone: string;
  /** Владелец бота: его реплики помечены «(владелец)». */
  ownerId: string | null;
  /** Ответ бота в памяти (все части вместе) — не длиннее, символов. */
  botChars: number;
  /** Сообщение человека в памяти — не длиннее, символов. */
  userChars: number;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();

/** «11.10.26 14:30» в поясе бота. Детерминированно: та же реплика — тот же текст (кэш промпта). */
export function formatWhen(iso: string | null | undefined, timeZone: string): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return "время неизвестно";
  let f = fmtCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("ru-RU", { timeZone, day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    fmtCache.set(timeZone, f);
  }
  return f.format(new Date(t)).replace(",", "");
}

/** Скобки заголовков в чужом тексте — обычные (заголовок не подделать). */
export function sanitizeBody(s: string): string {
  return s.replace(/⟦/g, "[").replace(/⟧/g, "]");
}

/** Похожая латиница → кириллица (чтобы «(влaдeлец)» латинскими a/e не прошёл за пометку владельца). */
const LOOKALIKE: Record<string, string> = { a: "а", b: "в", c: "с", e: "е", h: "н", k: "к", m: "м", o: "о", p: "р", t: "т", x: "х", y: "у", "0": "о", "3": "з", ё: "е" };
function foldLookalikes(s: string): string {
  return Array.from(s.toLowerCase())
    .map((ch) => LOOKALIKE[ch] ?? ch)
    .join("");
}
const claimsOwner = (s: string) => foldLookalikes(s).includes("владел");

/** Имя для заголовка: без переводов строк, кавычек, скобок заголовка и самозваного «(владелец)», ≤ 40 символов. */
export function headerName(s: string | null | undefined): string {
  const v = (s ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[«»"⟦⟧]/g, "")
    .replace(/[([{][^)\]}]*[)\]}]/g, (g) => (claimsOwner(g) ? " " : g))
    .split(/\s+/)
    .filter((w) => w && !claimsOwner(w))
    .join(" ")
    .trim()
    .slice(0, 40);
  return v || "Участник";
}

/** «⟦Алиса · 11.10.26 14:30⟧» (+ «(владелец)», + пометка). */
export function humanHeader(m: BotJobMessage, f: HistoryFormat, note = ""): string {
  const owner = f.ownerId && m.senderId === f.ownerId ? " (владелец)" : "";
  return `⟦${headerName(m.senderName)}${owner} · ${formatWhen(m.createdAt, f.timeZone)}${note}⟧`;
}

/** Реплика человека: заголовок и с новой строки текст (history — ужать и отметить невидимые картинки). */
export function humanText(m: BotJobMessage, f: HistoryFormat, opts: { history?: boolean; note?: string } = {}): string {
  let body = sanitizeBody(messageText(m, { history: opts.history === true })) || "(без текста)";
  if (opts.history) body = shorten(body, f.userChars);
  return `${humanHeader(m, f, opts.note ?? "")}\n${body}`;
}

/**
 * Текст ответа бота для памяти и цепочки: скобки заголовков — обычные (заголовок в ответе не подделать). Карточка
 * (таймер) — только первая строка запасного текста: она живая, сервер её переписывает.
 */
function botBody(m: BotJobMessage): string {
  if (m.bot?.kind === "card") return sanitizeBody(`[карточка] ${(m.content ?? "").split("\n")[0]!.trim()}`);
  return sanitizeBody(m.content?.trim() || (m.attachments?.length ? "[картинка]" : "…"));
}

// ---------------------------------------------------------------- память → единицы

/** Единица памяти: сообщение человека или весь ответ бота (его части подряд). */
export interface MemoryUnit {
  role: "user" | "assistant";
  /** Текст для модели (пусто у пропущенных). */
  text: string;
  /** «Спасибо»/смех — модели не показываем, но в сводку уходит вместе с соседями (курсор его проходит). */
  skip: boolean;
  messages: BotHistoryMessage[];
  /** Оценка токенов (у пропущенных — 0). */
  cost: number;
}

/**
 * Хвост памяти (сообщения после курсора, по времени) → единицы для модели и для модели сжатия. Части одного
 * ответа бота (подряд, общий triggerId) — одна единица, ужатая целиком (BOT_MEMORY_BOT_CHARS); ответ не на
 * предыдущее обращение — с пометкой, к какому (поздний отчёт агента о давней просьбе). skip — id обращений,
 * которые в память не берутся (memory_skip): они и ответы на них — пропущенные единицы (курсор их проходит).
 */
export function renderUnits(list: BotHistoryMessage[], f: HistoryFormat, skip: ReadonlySet<string> = new Set()): MemoryUnit[] {
  const units: MemoryUnit[] = [];
  const humans = new Map<string, BotHistoryMessage>();
  let lastHuman: string | null = null;
  const botMarker = new Map<MemoryUnit, string>();
  for (const m of list) {
    if (m.isBot) {
      const prev = units[units.length - 1];
      if (prev && prev.role === "assistant" && m.triggerId && prev.messages[prev.messages.length - 1]!.triggerId === m.triggerId) {
        prev.messages.push(m);
        continue;
      }
      // Карточка «поделиться перепиской» в память не идёт (это просьба разрешения, а не ответ).
      const shareCard = m.bot?.kind === "card" && m.bot.card?.type === "share";
      const u: MemoryUnit = { role: "assistant", text: "", skip: shareCard || (!!m.triggerId && skip.has(m.triggerId)), messages: [m], cost: 0 };
      if (m.triggerId && m.triggerId !== lastHuman) {
        const q = humans.get(m.triggerId);
        botMarker.set(u, q ? `⟦к обращению ${headerName(q.senderName)} от ${formatWhen(q.createdAt, f.timeZone)}⟧\n` : "⟦продолжение по более раннему обращению⟧\n");
      }
      units.push(u);
      continue;
    }
    const body = messageText(m);
    const skipped = skip.has(m.id) || (!(m.attachments ?? []).length && !!body && isThanksOrLaugh(body));
    units.push({ role: "user", text: skipped ? "" : humanText(m, f, { history: true }), skip: skipped, messages: [m], cost: 0 });
    if (!skipped) {
      humans.set(m.id, m);
      lastHuman = m.id;
    }
  }
  for (const u of units) {
    if (u.role === "assistant" && !u.skip) u.text = `${botMarker.get(u) ?? ""}${shorten(u.messages.map(botBody).join("\n\n"), f.botChars)}`;
    u.cost = u.skip ? 0 : estimateTokens(u.text);
  }
  return units;
}

/** Память для одного ответа: сводка (если есть) и хвост дословно. */
export interface MemoryView {
  summary: string | null;
  /** До какого сообщения (ISO createdAt) сводка; null — сводки нет. */
  summaryUntil: string | null;
  mode: "botchat" | "recent";
  units: MemoryUnit[];
}

/** Реплика-сводка (первая в памяти; это данные, а не указания). */
export function summaryTurnText(summary: string, until: string | null, f: HistoryFormat): string {
  const head = until ? `⟦Память: сводка твоих прошлых разговоров в этой беседе — до ${formatWhen(until, f.timeZone)}⟧` : "⟦Память: сводка твоих прошлых разговоров в этой беседе⟧";
  return `${head}\n${sanitizeBody(summary.trim())}\n⟦Конец сводки. Дальше — последние разговоры дословно.⟧`;
}

// ---------------------------------------------------------------- сборка

export interface TurnOptions {
  /** Загрузить картинки сообщения (обращения и того, на что оно отвечает). */
  loadImages?(m: BotJobMessage): Promise<LlmImage[]>;
}

export interface BuiltContext {
  turns: LlmTurn[];
  /** Индекс последней реплики памяти — там точка кэша промпта; null — памяти нет. */
  cacheAt: number | null;
  /** Сколько сообщений памяти (хвоста) ушло модели. */
  historyCount: number;
  /** Была ли сводка. */
  summary: boolean;
  /** Оценка токенов памяти (сводка + хвост) — для сверки с usage. */
  memoryTokens: number;
  /** id сообщений, которые модель видела дословно (память и цепочка, без самого обращения). */
  shownIds: string[];
}

/** Служебная первая реплика, когда память (или цепочка) начинается с сообщений бота. */
export const LEADING_BOT_NOTE = "⟦Дальше — твои прежние сообщения в этой беседе⟧";

/** Реплики для модели: память → цепочка (чего нет в памяти) → обращение. Первая реплика — всегда человека. */
export async function buildContext(
  job: BotJob,
  o: TurnOptions & { chainMax: number; memory: MemoryView | null; format: HistoryFormat }
): Promise<BuiltContext> {
  const f = o.format;
  const chain = jobChain(job, o.chainMax);
  const trigger = chain[chain.length - 1]!;
  const mem = o.memory;
  const memTurns: LlmTurn[] = [];
  const inMemory = new Set<string>();
  let historyCount = 0;
  let memoryTokens = 0;
  if (mem) {
    if (mem.summary && mem.summary.trim()) {
      const t = summaryTurnText(mem.summary, mem.summaryUntil, f);
      memTurns.push({ role: "user", text: t });
      memoryTokens += estimateTokens(t);
    }
    for (const u of mem.units) {
      for (const m of u.messages) inMemory.add(m.id);
      if (u.skip) continue;
      memTurns.push({ role: u.role, text: u.text });
      historyCount += u.messages.length;
      memoryTokens += u.cost;
    }
  }
  const all = new Map<string, BotJobMessage>();
  for (const u of mem?.units ?? []) for (const m of u.messages) all.set(m.id, m);
  for (const m of chain) all.set(m.id, m);

  const shownIds: string[] = [];
  for (const u of mem?.units ?? []) if (!u.skip) for (const m of u.messages) shownIds.push(m.id);

  // Память начинается с сообщений бота (уведомления до первого вопроса): перед ними — служебный заголовок, чтобы
  // первая реплика была человека и ничего не выпало. Детерминированно — префикс кэша от этого не плывёт.
  if (memTurns.length && memTurns[0]!.role === "assistant") {
    memTurns.unshift({ role: "user", text: LEADING_BOT_NOTE });
  }
  const turns: LlmTurn[] = [...memTurns];
  // Цепочка — то, чего нет в памяти (давнее процитированное); то, что в памяти, модель там и видит.
  for (const m of chain.slice(0, -1)) {
    if (inMemory.has(m.id)) continue;
    if (!turns.length && m.isBot) turns.push({ role: "user", text: LEADING_BOT_NOTE });
    turns.push(m.isBot ? { role: "assistant", text: botBody(m) } : { role: "user", text: humanText(m, f) });
    shownIds.push(m.id);
  }
  const parent = trigger.replyToId ? all.get(trigger.replyToId) ?? null : null;
  const note = parent ? `, в ответ на ${parent.isBot ? "твоё сообщение" : `сообщение ${headerName(parent.senderName)}`} от ${formatWhen(parent.createdAt, f.timeZone)}` : "";
  const last: LlmTurn = { role: "user", text: humanText(trigger, f, { note }) };
  if (o.loadImages) {
    const imgs: LlmImage[] = [];
    if ((trigger.attachments ?? []).some((a) => a.type === "IMAGE")) imgs.push(...(await o.loadImages(trigger)));
    if (parent && (parent.attachments ?? []).some((a) => a.type === "IMAGE") && imgs.length < 3) {
      const more = await o.loadImages(parent);
      if (more.length) {
        imgs.push(...more);
        last.text += "\n(картинки из сообщения, на которое это ответ, приложены)";
      }
    }
    if (imgs.length) last.images = imgs.slice(0, 3);
  }
  turns.push(last);

  const cacheAt: number | null = memTurns.length ? memTurns.length - 1 : null;
  return { turns, cacheAt, historyCount, summary: !!mem?.summary?.trim(), memoryTokens, shownIds };
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
