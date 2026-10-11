/**
 * Разбор обещания времени («15мин», «через полчаса», «час-полтора», «в два часа давай», «к 9», «в 21:30») для
 * таймера «Еблуша, проконтролируй» (docs/promise-timer.md, раздел «Разбор времени»). Чистый модуль: ни БД, ни
 * Redis — его же гоняют общие векторы test/fixtures/promise-time-vectors.json.
 *
 * Два шага:
 *   1. parsePromiseText(text) → PromiseSpec — ЧТО сказано (через N; в ЧЧ:ММ с пометкой части суток; ничего);
 *   2. resolveDeadline(spec, {base, zone, now}) → абсолютный срок UTC + метка для карточки, или ошибка
 *      NO_TIME | AMBIGUOUS | PAST | TOO_FAR.
 * Модель (запасной путь в боте) присылает только PromiseSpec — пояс, база и пределы одни для кода и модели.
 *
 * Правила (решения дизайна 2026-10-11):
 *   - база — время сообщения-обещания (не обращения); пояс — автора обещания, явное «по мск» сильнее;
 *   - «через N» — база + N (секунды базы сохраняются: 14:00:37 + 15 мин = 14:15:37);
 *   - диапазон («час-полтора», «10-15 мин») — верхняя граница, метка это показывает;
 *   - часы 1–12 без «утра/дня/вечера/ночи» и не в 24-часовой форме — ближайшее будущее из h:mm и (h+12):mm от
 *     базы; дальше 8 ч — AMBIGUOUS (бот переспрашивает); пометка части суток предел снимает;
 *   - «завтра» + 1–7 без пометки — день (+12), 8–11 — утро, 12 — полдень; ночью (до 5 утра) «завтра» — наступивший
 *     календарный день («после сна»);
 *   - однозначное время (24-часовое или с частью суток), прошедшее не больше 30 мин назад, — опоздание, а не завтра;
 *   - «в/к/до N» + счёт («в 3 раза», «в 2 км», «в двух шагах», «в 5 минутах», «к 15 минутам») — не час;
 *     «в 5 минутах» — через 5 минут; «через 1:30» — длительность;
 *   - срок ∈ [сейчас − 60 мин; база + 36 ч]: раньше — PAST, позже — TOO_FAR (срок в прошлом в пределах часа —
 *     карточка сразу «опаздывает»);
 *   - прошедшее («15 мин назад», «был в 2»), вопросы, «скоро», «к обеду», голое «через 2» — NO_TIME;
 *   - перевод часов: несуществующее местное время — вперёд, двойное — первое из двух.
 */

export type PromiseHalf = "am" | "pm" | "unknown";

export type PromiseSpec =
  /** Через N (секунды). Диапазон: minSec..maxSec, срок — по maxSec. */
  | { kind: "in"; minSec: number; maxSec: number; label?: string }
  /**
   * В ЧЧ:ММ. hour — как сказано (0–23); half — пометка части суток (am — утро/ночь, pm — день/вечер, unknown —
   * без пометки: для 1–12 берётся ближайшее будущее); day — сегодня/завтра/ближайшее; zone — явный пояс из
   * текста (IANA); prep — «к/до» (метка «к 21:00») или «в» (метка «в 21:00»).
   */
  | { kind: "at"; hour: number; minute: number; half: PromiseHalf; day: "today" | "tomorrow" | "after" | "nearest"; zone?: string; prep?: "k" | "v"; h24?: boolean }
  | { kind: "none"; reason: "no_time" | "past" | "question" };

export type DeadlineError = "NO_TIME" | "AMBIGUOUS" | "PAST" | "TOO_FAR";

export type ResolvedDeadline =
  | { ok: true; deadlineAt: Date; label: string; upperBound: boolean; zone: string; zoneFromText: boolean }
  | { ok: false; code: DeadlineError; deadlineAt?: Date; alt?: Date; label?: string };

/** Пределы срока (правило 7). */
export const PROMISE_PAST_GRACE_MS = 60 * 60_000;
export const PROMISE_MAX_AHEAD_MS = 36 * 3600_000;
/** Ближайшее будущее двусмысленных 1–12 дальше этого — переспрос. */
export const PROMISE_AMBIGUOUS_MS = 8 * 3600_000;
/** «щас», «пару минут» — столько. */
export const PROMISE_SOON_SEC = 5 * 60;
/** Однозначное время, прошедшее не больше этого до базы, — опоздание, а не «завтра». */
export const PROMISE_JUST_PASSED_MS = 30 * 60_000;
/** До этого часа ночи «завтра» значит «после сна» — наступивший календарный день. */
export const NIGHT_UNTIL_HOUR = 5;

const MOSCOW = "Europe/Moscow";

// ───────────────────────────── числа словами ─────────────────────────────

const UNITS: Record<string, number> = {
  ноль: 0, один: 1, одна: 1, одну: 1, одного: 1, два: 2, две: 2, двух: 2, двум: 2, три: 3, трех: 3, трем: 3, четыре: 4, четырех: 4, четырем: 4,
  пять: 5, пяти: 5, шесть: 6, шести: 6, семь: 7, семи: 7, восемь: 8, восьми: 8, девять: 9, девяти: 9,
  десять: 10, десяти: 10, одиннадцать: 11, одиннадцати: 11, двенадцать: 12, двенадцати: 12, тринадцать: 13, тринадцати: 13,
  четырнадцать: 14, четырнадцати: 14, пятнадцать: 15, пятнадцати: 15, шестнадцать: 16, шестнадцати: 16, семнадцать: 17, семнадцати: 17,
  восемнадцать: 18, восемнадцати: 18, девятнадцать: 19, девятнадцати: 19,
};
const TENS: Record<string, number> = { двадцать: 20, двадцати: 20, тридцать: 30, тридцати: 30, сорок: 40, сорока: 40, пятьдесят: 50, пятидесяти: 50, шестьдесят: 60 };
/** Порядковые в родительном: «полвторого» = половина второго часа = 1:30. */
const ORDINAL_GEN: Record<string, number> = {
  первого: 1, второго: 2, третьего: 3, четвертого: 4, пятого: 5, шестого: 6, седьмого: 7, восьмого: 8, девятого: 9, десятого: 10, одиннадцатого: 11, двенадцатого: 12,
};

/** Числа словами → цифрами («двадцать пять» → 25, «к девяти» → «к 9»). «час» без числа не трогаем. */
export function wordsToDigits(s: string): string {
  // Слова и всё остальное (пробелы, «-», цифры) по отдельности: «час-два» → «час-2».
  const toks = s.match(/[а-я]+|[^а-я]+/g) ?? [];
  const out: string[] = [];
  for (let i = 0; i < toks.length; i++) {
    const w = toks[i]!;
    if (Object.prototype.hasOwnProperty.call(TENS, w)) {
      const sep = toks[i + 1];
      const next = toks[i + 2];
      if (sep === " " && next !== undefined && Object.prototype.hasOwnProperty.call(UNITS, next) && UNITS[next]! >= 1 && UNITS[next]! <= 9) {
        out.push(String(TENS[w]! + UNITS[next]!));
        i += 2;
        continue;
      }
      out.push(String(TENS[w]));
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(UNITS, w)) {
      out.push(String(UNITS[w]));
      continue;
    }
    out.push(w);
  }
  return out.join("");
}

/** Текст → вид для правил: нижний регистр, ё→е, тире → «-», дробь «1,5» → «1.5», пробелы схлопнуты. */
export function normalizePromiseText(text: string): string {
  let t = (text ?? "").toLowerCase().replace(/ё/g, "е");
  t = t.replace(/[–—−]/g, "-");
  t = t.replace(/(\d),(\d)/g, "$1.$2");
  t = t.replace(/[«»"“”„()[\]{}*_~`]/g, " ");
  t = t.replace(/[!;]+/g, " ");
  t = t.replace(/\s*-\s*/g, "-");
  t = t.replace(/\s+/g, " ").trim();
  // склейки «15мин», «2ч30м», «15min» → с пробелами
  t = t.replace(/(\d)(?=[a-zа-я])/g, "$1 ").replace(/([a-zа-я])(?=\d)/g, "$1 ");
  t = t.replace(/\s+/g, " ").trim();
  t = wordsToDigits(t);
  return t;
}

// ───────────────────────────── разбор ─────────────────────────────

/** Минуты как длительность: «15 мин», «в 5 минутах» (= через 5 минут). «к 15 минутам» — не длительность. */
const MIN_W = "(?:минут(?:ах|а|ы|у)?|минутк[аиу]|минуточ[каеку]+|мин\\.?|м|min|mins|minutes?)";
/** Любая форма минут — после «в/к/до N» это не час («в 5 минутах», «к 15 минутам»). */
const MIN_ANY = "(?:минут[а-я]*|минутк[а-я]*|минуточ[а-я]*|мин\\.?|м|min|mins|minutes?)";
const HOUR_W = "(?:час(?:а|ов|ик|ок|очек|ика|ка)?|ч\\.?|h|hours?)";
const SEC_W = "(?:секунд[аыу]?|сек\\.?|с)";
/**
 * После «в/к/до N» — не время, а счёт чего-то: «в 3 раза», «в 2 км», «в двух шагах», «в 2 словах», «в 5 метрах».
 * Предложный падеж множественного числа (-ах/-ях) после числа — почти всегда «где», а не «когда».
 */
const NOT_HOUR_AFTER =
  /^\s*(?:раз(?:а)?|км|километр[а-я]*|метр[а-я]*|м|см|кг|литр[а-я]*|шаг[а-я]*|слов[а-я]*|рубл[а-я]*|руб|процент[а-я]*|%|тыс[а-я]*|штук[а-я]*|человек[а-я]*|градус[а-я]*|секунд[а-я]*|сек|недел[а-я]*|месяц[а-я]*|год[а-я]*|лет|класс[а-я]*|этаж[а-я]*|квартир[а-я]*|ряд[а-я]*|част[а-я]*|игр[а-я]*|раунд[а-я]*|[а-я]+(?:ах|ях))(?![а-я])/;

export interface ParsedPromise {
  spec: PromiseSpec;
  /** Явный пояс из текста («по мск»). */
  zone?: string;
}

function none(reason: "no_time" | "past" | "question"): ParsedPromise {
  return { spec: { kind: "none", reason } };
}

function fmtNum(n: number): string {
  return Number.isInteger(n) ? String(n) : String(n).replace(".", ",");
}

/** Длительность → метка: «15 мин», «1 ч», «1,5 ч», «2 ч 30 мин». */
export function durationLabel(sec: number): string {
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} мин`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (m === 0) return `${h} ч`;
  if (m === 30 && h === 1) return `${fmtNum(h + 0.5)} ч`;
  return `${h} ч ${m} мин`;
}

/** Явный пояс в тексте. */
function textZone(t: string): string | undefined {
  if (/(?:^|\s)(?:по\s+)?(?:мск|msk)(?:$|\s|[.,])/.test(t) || /по\s+москве|московскому/.test(t)) return MOSCOW;
  return undefined;
}

/** Часть суток после числа. */
function dayPart(rest: string): PromiseHalf | "night" | "noon" | null {
  // \b в JS — только латиница: границу слова у кириллицы проверяем просмотром вперёд.
  const head = /^\s*(?:\d{1,2}\s*(?:минут[аыу]?|мин|м)(?![а-я])\s*)?(?:часов|часа|час|ч)?\s*/;
  const r = rest.replace(head, "");
  if (/^(?:утра|утром)(?![а-я])/.test(r)) return "am";
  if (/^(?:дня|днем)(?![а-я])/.test(r)) return "noon";
  if (/^(?:вечера|вечером)(?![а-я])/.test(r)) return "pm";
  if (/^(?:ночи|ночью)(?![а-я])/.test(r)) return "night";
  return null;
}

/** Час с частью суток → 0–23 и half. */
function applyDayPart(h: number, part: ReturnType<typeof dayPart>): { hour: number; half: PromiseHalf } | null {
  if (part === null) return { hour: h, half: "unknown" };
  if (part === "am") return h === 12 ? { hour: 12, half: "pm" } : h <= 12 ? { hour: h, half: "am" } : null;
  if (part === "pm") return h >= 1 && h <= 11 ? { hour: h + 12, half: "pm" } : h >= 12 && h <= 23 ? { hour: h === 12 ? 0 : h, half: h === 12 ? "am" : "pm" } : null;
  if (part === "noon") return h === 12 ? { hour: 12, half: "pm" } : h >= 1 && h <= 6 ? { hour: h + 12, half: "pm" } : h >= 13 && h <= 18 ? { hour: h, half: "pm" } : null;
  // ночь: 12 ночи = 0:00, 1–4 — как есть
  if (h === 12 || h === 0) return { hour: 0, half: "am" };
  if (h >= 1 && h <= 5) return { hour: h, half: "am" };
  if (h >= 22 && h <= 23) return { hour: h, half: "pm" };
  return null;
}

/** «завтра» и «послезавтра» в тексте. */
function dayWord(t: string): "tomorrow" | "after" | null {
  if (/послезавтра/.test(t)) return "after";
  if (/(?:^|\s)завтра/.test(t)) return "tomorrow";
  return null;
}

/**
 * Что сказано. Порядок правил важен: сначала «не обещание», потом абсолютное время (у него предлог «в/к/до/после»
 * или ЧЧ:ММ), потом относительное.
 */
export function parsePromiseText(text: string): ParsedPromise {
  const t0 = normalizePromiseText(text);
  if (!t0) return none("no_time");
  const zone = textZone(t0);
  const withZone = (p: ParsedPromise): ParsedPromise => (zone && p.spec.kind === "at" ? { spec: { ...p.spec, zone }, zone } : p);
  // Хвост «по мск» мешает правилам — убираем.
  const t = t0.replace(/(?:по\s+)?(?:мск|msk)\b|по\s+москве|по\s+московскому(?:\s+времени)?/g, " ").replace(/\s+/g, " ").trim();

  // 1. Прошедшее и «после игры»: не обещание.
  if (/(?:^|\s)назад(?![а-я])/.test(t) || /(?:^|\s)(?:был|была|были|было|пришел|пришла|пришли|вернулся|вернулась)\s+(?:в|к|около)\s+\d/.test(t)) return none("past");
  // Вопрос без утверждения («во сколько?», «когда будешь?», «в 9?»)
  if (/\?/.test(t) || /(?:^|\s)(?:во сколько|когда)(?:\s|$)/.test(t)) return none("question");

  const day = dayWord(t);

  // 2. «сейчас»: щас/ща/сейчас буду/уже иду/выхожу/5 сек
  const soon = /(?:^|\s)(?:щас|ща|щя|сейчас\s+(?:буду|приду|зайду|подойду|иду)|уже\s+(?:иду|бегу|выхожу|еду)|выхожу|бегу|секунду|сек(?:унду)?\s*$)(?:\s|$)/.test(t) ||
    new RegExp(`(?:^|\\s)\\d{1,2}\\s*${SEC_W}(?:\\s|$)`).test(t);
  // «пару минут»/«пару мин» — тоже «скоро», но с меткой «пара минут»
  if (/(?:^|\s)(?:через\s+)?(?:пару|пара|пару-тройку)\s+мин/.test(t)) {
    return { spec: { kind: "in", minSec: PROMISE_SOON_SEC, maxSec: PROMISE_SOON_SEC, label: "пара минут → 5 мин" } };
  }
  if (/(?:^|\s)(?:через\s+)?(?:пару|пара)\s+час/.test(t)) {
    return { spec: { kind: "in", minSec: 7200, maxSec: 7200 } };
  }

  // 3. Абсолютное время.
  // 3а. полдень / полночь
  {
    const m = /(?:^|\s)(в|к|до|после)?\s*(полдень|полдня|полночь|полночи)(?:\s|$)/.exec(t);
    if (m) {
      const noon = m[2]!.startsWith("полд");
      return withZone({ spec: { kind: "at", hour: noon ? 12 : 0, minute: 0, half: noon ? "pm" : "am", day: day === "tomorrow" ? "tomorrow" : "nearest", prep: prepOf(m[1]), h24: true } });
    }
  }
  // 3б. «полвторого», «пол второго», «в полдесятого вечера»
  {
    const m = /(?:^|\s)(в|к|до|после)?\s*(?:пол|половин[аеуы])\s*-?\s*(первого|второго|третьего|четвертого|пятого|шестого|седьмого|восьмого|девятого|десятого|одиннадцатого|двенадцатого)(.*)$/.exec(t);
    if (m) {
      const n = ORDINAL_GEN[m[2]!]!;
      const h = n - 1;
      const part = dayPart(m[3] ?? "");
      const ap = applyDayPart(h === 0 ? 12 : h, part);
      if (!ap) return none("no_time");
      // «полпервого» без пометки — 00:30 или 12:30 (ближайшее): час 12 даёт оба варианта
      const hour = h === 0 && part === null ? 12 : ap.hour;
      return withZone({ spec: { kind: "at", hour, minute: 30, half: part === null ? "unknown" : ap.half, day: dayOf(day), prep: prepOf(m[1]) } });
    }
  }
  // 3в. «без пятнадцати три», «без четверти три», «без 5 три»
  {
    const m = /(?:^|\s)(в|к|до)?\s*без\s+(четверти|\d{1,2})(?:\s+(?:минут[ыу]?|мин))?\s+(\d{1,2})(?!\d)(.*)$/.exec(t);
    if (m) {
      const less = m[2] === "четверти" ? 15 : Number(m[2]);
      const h0 = Number(m[3]);
      if (less > 0 && less < 60 && h0 >= 1 && h0 <= 24) {
        const part = dayPart(m[4] ?? "");
        const ap = applyDayPart(h0 === 24 ? 0 : h0, part);
        if (!ap) return none("no_time");
        let hour = ap.hour - 1;
        if (hour < 0) hour += 24;
        return withZone({ spec: { kind: "at", hour, minute: 60 - less, half: part === null && h0 <= 12 ? "unknown" : hour >= 12 ? "pm" : "am", day: dayOf(day), prep: prepOf(m[1]), h24: part === null && h0 > 12 } });
      }
    }
  }
  // 3г′. «через 1:30», «через 0:45» — длительность Ч:ММ, а не время суток.
  {
    const m = /(?:^|\s)через\s+(\d{1,2})\s*[:.]\s*(\d{2})(?!\d)/.exec(t);
    if (m) {
      const sec = Number(m[1]) * 3600 + Number(m[2]) * 60;
      if (Number(m[2]) <= 59 && sec > 0) return { spec: { kind: "in", minSec: sec, maxSec: sec } };
      return none("no_time");
    }
  }
  // 3г. ЧЧ:ММ (21:30, 21.30, 21-30 после предлога, «в 9:30»)
  {
    const m = /(?:^|\s)(в|к|до|после|около)?\s*(\d{1,2})\s*[:.]\s*(\d{2})(?!\d)(.*)$/.exec(t) ?? /(?:^|\s)(в|к|до|после|около)\s+(\d{1,2})-(\d{2})(?!\d)(.*)$/.exec(t);
    if (m && !new RegExp(`^\\s*${HOUR_W}`).test(m[4] ?? "") && !new RegExp(`^\\s*${MIN_W}`).test(m[4] ?? "")) {
      const h0 = Number(m[2]);
      const mi = Number(m[3]);
      if (h0 <= 24 && mi <= 59) {
        const part = dayPart(m[4] ?? "");
        const leadingZero = /^0\d/.test(m[2]!);
        const ap = applyDayPart(h0 === 24 ? 0 : h0, part);
        if (!ap) return none("no_time");
        const h24 = part === null && (h0 === 0 || h0 > 12 || leadingZero);
        return withZone({
          spec: { kind: "at", hour: ap.hour, minute: mi, half: part === null ? (h24 ? (ap.hour >= 12 ? "pm" : "am") : "unknown") : ap.half, day: dayOf(day), prep: prepOf(m[1]), h24 },
        });
      }
    }
  }
  // 3д. «в 2», «к 9», «в два часа», «давай в 14», «после 9», «в 9 вечера», «завтра в 2», «в 14 часов»
  {
    const m = /(?:^|\s)(в|к|до|после|около)\s+(\d{1,2})(?![\d.])(?:\s*(?:часов|часа|час|ч)(?![а-я]))?(.*)$/.exec(t) ?? /(?:^|\s)(в|к|до|после|около)\s+(часу)(?![а-я])(.*)$/.exec(t);
    if (m) {
      const rest = m[3] ?? "";
      // «в 2 часа ночи» — часть суток; «к 9 минутам», «в 5 минутах» — нет; «в 3 раза», «в 2 км», «в двух шагах» —
      // счёт, а не час (если «часа» не сказано).
      const hourWord = /^(?:в|к|до|после|около)\s+\d{1,2}\s*(?:часов|часа|час|ч)(?![а-я])/.test(m[0].trim()) || m[2] === "часу";
      if (!new RegExp(`^\\s*${MIN_ANY}(?![а-я])`).test(rest) && (hourWord || !NOT_HOUR_AFTER.test(rest))) {
        const h0 = m[2] === "часу" ? 1 : Number(m[2]);
        // «в 2 часа 30 минут» — минуты после часов
        const mm = new RegExp(`^\\s*(?:и\\s+)?(\\d{1,2})\\s*${MIN_W}(?=\\s|$|[.,])`).exec(rest);
        const minute = mm ? Number(mm[1]) : 0;
        if (h0 >= 0 && h0 <= 24 && minute <= 59) {
          const part = dayPart(rest);
          const ap = applyDayPart(h0 === 24 ? 0 : h0, part);
          if (!ap) return none("no_time");
          const h24 = part === null && (h0 === 0 || h0 > 12);
          return withZone({ spec: { kind: "at", hour: ap.hour, minute, half: part === null ? (h24 ? (ap.hour >= 12 ? "pm" : "am") : "unknown") : ap.half, day: dayOf(day), prep: prepOf(m[1]), h24 } });
        }
      }
    }
  }
  // 3е. «давай в два» без «часа» — уже выше; «завтра в 2» — тоже выше (day). «в начале третьего» — модель.
  if (/(?:^|\s)в\s+(?:начале|конце|районе)\s/.test(t)) return none("no_time");

  // 4. Относительное.
  // «после игры», «после работы» — привязка к событию: модель
  if (/(?:^|\s)после\s+[а-я]/.test(t)) return none("no_time");

  // 4а. «час-полтора», «через час-полтора», «час - два»
  {
    const m = /(?:^|\s)(?:через\s+)?(?:час|часик|часок)-(?:полтора|полтор[аы])(?:\s|$)/.exec(t);
    if (m) return { spec: { kind: "in", minSec: 3600, maxSec: 5400, label: "час-полтора → 1,5 ч" } };
    const m2 = /(?:^|\s)(?:через\s+)?(?:час|часик|часок)-(\d)(?:\s*(?:часа|ч))?(?:\s|$)/.exec(t);
    if (m2) {
      const hi = Number(m2[1]);
      if (hi >= 2 && hi <= 6) return { spec: { kind: "in", minSec: 3600, maxSec: hi * 3600, label: `1–${hi} ч → ${hi} ч` } };
    }
  }
  // 4б. диапазоны минут/часов: «10-15 мин», «минут 10-15», «10 или 15 минут», «2-3 часа»
  {
    const unitAfter = new RegExp(`(?:^|\\s)(?:через\\s+)?(\\d{1,3}(?:\\.\\d)?)\\s*(?:-|или)\\s*(\\d{1,3}(?:\\.\\d)?)\\s*(${MIN_W}|${HOUR_W})(?=\\s|$|[.,])`);
    const unitBefore = new RegExp(`(?:^|\\s)(?:через\\s+)?(${MIN_W}|${HOUR_W})\\s+(?:через\\s+)?(\\d{1,3}(?:\\.\\d)?)\\s*(?:-|или)\\s*(\\d{1,3}(?:\\.\\d)?)(?=\\s|$|[.,])`);
    let lo: number | null = null;
    let hi: number | null = null;
    let unit = "";
    const a = unitAfter.exec(t);
    if (a) {
      lo = Number(a[1]);
      hi = Number(a[2]);
      unit = a[3]!;
    } else {
      const b = unitBefore.exec(t);
      if (b) {
        unit = b[1]!;
        lo = Number(b[2]);
        hi = Number(b[3]);
      }
    }
    if (lo !== null && hi !== null && hi > lo && hi > 0) {
      const mult = new RegExp(`^${HOUR_W}$`).test(unit) ? 3600 : 60;
      const loS = lo * mult;
      const hiS = hi * mult;
      const lbl = mult === 60 ? `${fmtNum(lo)}–${fmtNum(hi)} мин → ${durationLabel(hiS)}` : `${fmtNum(lo)}–${fmtNum(hi)} ч → ${durationLabel(hiS)}`;
      return { spec: { kind: "in", minSec: loS, maxSec: hiS, label: lbl } };
    }
  }
  // 4в. «2 ч 30 мин», «2 часа 30 минут»
  {
    const m = new RegExp(`(?:^|\\s)(?:через\\s+)?(\\d{1,2})\\s*${HOUR_W}\\s*(?:и\\s+)?(\\d{1,2})\\s*${MIN_W}(?=\\s|$|[.,])`).exec(t);
    if (m) {
      const sec = Number(m[1]) * 3600 + Number(m[2]) * 60;
      if (sec > 0) return { spec: { kind: "in", minSec: sec, maxSec: sec } };
    }
  }
  // 4г. полтора часа, полчаса, пол часа, полчасика
  if (/(?:^|\s)(?:через\s+)?полтора\s+час/.test(t)) return { spec: { kind: "in", minSec: 5400, maxSec: 5400 } };
  if (/(?:^|\s)(?:через\s+|минут\s+)?(?:пол\s*-?\s*час(?:а|ика|ик)?|получаса)(?:\s|$|[.,])/.test(t)) return { spec: { kind: "in", minSec: 1800, maxSec: 1800 } };
  // 4д. N часов / N.5 ч / «часа через 2»
  {
    const m =
      new RegExp(`(?:^|\\s)(?:через\\s+)?(\\d{1,2}(?:\\.\\d+)?)\\s*${HOUR_W}(?=\\s|$|[.,])`).exec(t) ??
      new RegExp(`(?:^|\\s)${HOUR_W}\\s+через\\s+(\\d{1,2}(?:\\.\\d+)?)(?=\\s|$|[.,])`).exec(t);
    if (m) {
      const h = Number(m[1]);
      if (h > 0 && h <= 36) return { spec: { kind: "in", minSec: Math.round(h * 3600), maxSec: Math.round(h * 3600) } };
    }
  }
  // 4е. «через час», «часик», «через часок» (без числа)
  if (/(?:^|\s)(?:через\s+)?(?:час|часик|часок|часика)(?:\s|$|[.,])/.test(t) && !/(?:^|\s)(?:в|к|до)\s+час/.test(t)) {
    return { spec: { kind: "in", minSec: 3600, maxSec: 3600 } };
  }
  // 4ж. N минут: «15мин», «15 минут», «минут через 15», «мин 15», «через 15» (≥ 5); продления «+10», «ещё 5»
  {
    const plus = /(?:^|\s)(?:\+\s?|(?:еще|ещ[её])\s+(?:на\s+)?)(\d{1,3})(?:\s*(?:минут[аыу]?|мин|м)(?![а-я]))?(?=\s|$|[.,])/.exec(t);
    if (plus && !new RegExp(`^\\s*${HOUR_W}`).test(t.slice(plus.index + plus[0].length))) {
      const n = Number(plus[1]);
      if (n > 0 && n <= 600) return { spec: { kind: "in", minSec: n * 60, maxSec: n * 60 } };
    }
  }
  {
    const m =
      new RegExp(`(?:^|\\s)(?:через\\s+|в\\s+течение\\s+)?(\\d{1,3})\\s*${MIN_W}(?=\\s|$|[.,])`).exec(t) ??
      new RegExp(`(?:^|\\s)${MIN_W}\\s+(?:через\\s+)?(\\d{1,3})(?=\\s|$|[.,])`).exec(t);
    if (m) {
      const n = Number(m[1]);
      if (n > 0 && n <= 600) return { spec: { kind: "in", minSec: n * 60, maxSec: n * 60 } };
    }
    const bare = /(?:^|\s)через\s+(\d{1,3})(?=\s|$|[.,])/.exec(t);
    if (bare) {
      const n = Number(bare[1]);
      if (n >= 5 && n <= 180) return { spec: { kind: "in", minSec: n * 60, maxSec: n * 60 } };
      return none("no_time");
    }
    if (/(?:^|\s)в\s+течение\s+часа/.test(t)) return { spec: { kind: "in", minSec: 3600, maxSec: 3600 } };
  }
  if (soon) return { spec: { kind: "in", minSec: PROMISE_SOON_SEC, maxSec: PROMISE_SOON_SEC, label: "сейчас → 5 мин" } };
  return none("no_time");
}

function prepOf(p: string | undefined): "k" | "v" {
  return p === "к" || p === "до" ? "k" : "v";
}

function dayOf(d: "tomorrow" | "after" | null): "tomorrow" | "after" | "nearest" {
  return d ?? "nearest";
}

/** Есть ли в тексте хоть что-то похожее на время (цифры или слова времени) — повод звать модель, если код не понял. */
export function looksLikeTime(text: string): boolean {
  const t = normalizePromiseText(text);
  return /\d/.test(t) || /(?:мин|час|полчас|полтор|утр|вечер|ночи|полдень|полночь|щас|сейчас|скоро|попозже|обед|завтра|без\s|пол[а-я]+ого)/.test(t);
}

// ───────────────────────────── пояса ─────────────────────────────

const dtfCache = new Map<string, Intl.DateTimeFormat>();
function dtf(zone: string): Intl.DateTimeFormat {
  let f = dtfCache.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    dtfCache.set(zone, f);
  }
  return f;
}

export interface ZonedParts {
  y: number;
  m: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

export function zonedParts(ms: number, zone: string): ZonedParts {
  const parts = dtf(zone).formatToParts(new Date(ms));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  return { y: get("year"), m: get("month"), d: get("day"), h: get("hour") % 24, mi: get("minute"), s: get("second") };
}

/** Смещение пояса в момент ms, минуты (UTC+3 → 180). */
export function zoneOffsetMin(ms: number, zone: string): number {
  const p = zonedParts(ms, zone);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60_000);
}

/** Пояс годен (IANA, ICU его знает). */
export function isValidZone(zone: string | null | undefined): zone is string {
  if (!zone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Местное время (y-m-d h:mi в поясе) → UTC мс. Несуществующее (весенний перевод) — вперёд на величину скачка;
 * двойное (осенний) — первое из двух (раньшее по UTC).
 */
export function zonedToUtc(y: number, m: number, d: number, h: number, mi: number, zone: string): number {
  const guess = Date.UTC(y, m - 1, d, h, mi, 0);
  const cands = new Set<number>();
  for (const probe of [guess - 12 * 3600_000, guess, guess + 12 * 3600_000]) {
    cands.add(guess - zoneOffsetMin(probe, zone) * 60_000);
  }
  const ok = [...cands].filter((u) => {
    const p = zonedParts(u, zone);
    return p.y === y && p.m === m && p.d === d && p.h === h && p.mi === mi;
  });
  if (ok.length) return Math.min(...ok);
  // Дыра (перевод вперёд): смещение ДО перевода даёт момент после него — сдвиг вперёд.
  const before = zoneOffsetMin(guess - 12 * 3600_000, zone);
  return guess - before * 60_000;
}

/** Календарный день в поясе со сдвигом (для «завтра»). */
function addDays(p: { y: number; m: number; d: number }, n: number): { y: number; m: number; d: number } {
  const t = new Date(Date.UTC(p.y, p.m - 1, p.d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

const pad2 = (n: number) => String(n).padStart(2, "0");

// ───────────────────────────── срок ─────────────────────────────

export interface ResolveOptions {
  /** База — время сообщения-обещания. */
  base: Date;
  /** Пояс автора (или спросившего, или МСК). Явный пояс из spec сильнее. */
  zone: string;
  now: Date;
  /** Двусмысленное время подтвердили («да, это 02:00 ночи»): берём ближайшее будущее без 8-часового предела. */
  confirmAmbiguous?: boolean;
}

/**
 * Абсолютный срок по разобранному. Ошибки: NO_TIME (не время), AMBIGUOUS (ближайшее будущее 1–12 дальше 8 ч;
 * deadlineAt — это ближайшее, alt — другой вариант), PAST (раньше «сейчас − 60 мин»), TOO_FAR (дальше база + 36 ч).
 */
export function resolveDeadline(spec: PromiseSpec, o: ResolveOptions): ResolvedDeadline {
  const baseMs = o.base.getTime();
  const nowMs = o.now.getTime();
  const zoneFromText = spec.kind === "at" && !!spec.zone;
  const zone = zoneFromText && spec.kind === "at" && isValidZone(spec.zone) ? spec.zone! : isValidZone(o.zone) ? o.zone : MOSCOW;
  const limits = (deadline: number, label: string, upperBound: boolean): ResolvedDeadline => {
    if (deadline < nowMs - PROMISE_PAST_GRACE_MS) return { ok: false, code: "PAST", deadlineAt: new Date(deadline), label };
    if (deadline > baseMs + PROMISE_MAX_AHEAD_MS) return { ok: false, code: "TOO_FAR", deadlineAt: new Date(deadline), label };
    return { ok: true, deadlineAt: new Date(deadline), label, upperBound, zone, zoneFromText };
  };

  if (spec.kind === "none") return { ok: false, code: "NO_TIME" };
  if (spec.kind === "in") {
    const sec = Math.max(spec.minSec, spec.maxSec);
    if (!(sec > 0) || sec > PROMISE_MAX_AHEAD_MS / 1000) return { ok: false, code: sec > 0 ? "TOO_FAR" : "NO_TIME" };
    const upper = spec.maxSec > spec.minSec;
    return limits(baseMs + sec * 1000, spec.label ?? durationLabel(sec), upper);
  }
  // kind "at"
  const hour = spec.hour;
  const minute = spec.minute;
  if (!(hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59)) return { ok: false, code: "NO_TIME" };
  const baseLocal = zonedParts(baseMs, zone);
  const today = { y: baseLocal.y, m: baseLocal.m, d: baseLocal.d };
  const at = (day: { y: number; m: number; d: number }, h: number) => zonedToUtc(day.y, day.m, day.d, h, minute, zone);
  const prepWord = spec.prep === "k" ? "к" : "в";
  const labelFor = (ms: number, tomorrow: boolean) => {
    const p = zonedParts(ms, zone);
    return `${tomorrow ? "завтра " : ""}${prepWord} ${pad2(p.h)}:${pad2(p.mi)}`;
  };

  if (spec.day === "tomorrow" || spec.day === "after") {
    // Ночью (до 5 утра) «завтра» — это «после сна», то есть наступивший календарный день: «завтра в 9» в 01:00
    // 12.10 — 12.10 09:00, а не 13.10.
    const night = baseLocal.h < NIGHT_UNTIL_HOUR ? 1 : 0;
    const tm = addDays(today, (spec.day === "after" ? 2 : 1) - night);
    let h = hour;
    if (spec.half === "unknown" && !spec.h24) {
      // «завтра в 2» — день; 8–11 — утро; 12 — полдень
      if (hour >= 1 && hour <= 7) h = hour + 12;
    }
    const ms = at(tm, h);
    return limits(ms, labelFor(ms, true), false);
  }

  // ближайшее будущее от базы
  const candidatesFor = (h: number): number[] => {
    const out: number[] = [];
    for (const n of [0, 1]) out.push(at(addDays(today, n), h));
    return out;
  };
  const ambiguous = spec.half === "unknown" && !spec.h24 && hour >= 1 && hour <= 12;
  const hours = ambiguous ? [hour === 12 ? 0 : hour, hour === 12 ? 12 : hour + 12] : [hour];
  // Однозначное время («в 14», «к 14:00», «в 9 вечера»), только что прошедшее (до 30 мин до базы), — это
  // «я уже опаздываю», а не «завтра»: «в 14 буду» в 14:02 → 14:00 (карточка сразу «опаздывает»), не через 24 часа.
  // Прошло больше — как раньше: завтра («в 13», сказанное в 13:40).
  if (!ambiguous) {
    const recent = [-1, 0]
      .map((n) => at(addDays(today, n), hour))
      .filter((ms) => ms < baseMs - 60_000 && ms >= baseMs - PROMISE_JUST_PASSED_MS)
      .sort((a, b) => b - a)[0];
    if (recent !== undefined) return limits(recent, labelFor(recent, false), false);
  }
  const all = hours.flatMap(candidatesFor).filter((ms) => ms >= baseMs - 60_000).sort((a, b) => a - b);
  // «к 14» сказано в 14:00:20 — это «сейчас», а не завтра: минута запаса.
  const nearest = all[0];
  if (nearest === undefined) return { ok: false, code: "NO_TIME" };
  const isTomorrow = (ms: number) => {
    const p = zonedParts(ms, zone);
    return !(p.y === today.y && p.m === today.m && p.d === today.d);
  };
  if (ambiguous && nearest - baseMs > PROMISE_AMBIGUOUS_MS && !o.confirmAmbiguous) {
    const alt = all.find((ms) => ms !== nearest && zonedParts(ms, zone).h !== zonedParts(nearest, zone).h) ?? undefined;
    return { ok: false, code: "AMBIGUOUS", deadlineAt: new Date(nearest), ...(alt !== undefined ? { alt: new Date(alt) } : {}), label: labelFor(nearest, isTomorrow(nearest) && spec.half !== "unknown") };
  }
  return limits(nearest, labelFor(nearest, false), false);
}

/** Разобрать и сразу посчитать (сервер: кандидаты и создание по тексту). */
export function promiseDeadlineFromText(text: string, o: ResolveOptions): { parsed: ParsedPromise; result: ResolvedDeadline } {
  const parsed = parsePromiseText(text);
  return { parsed, result: resolveDeadline(parsed.spec, o) };
}

/** Проверить spec от модели (strict-схема у бота, но данные чужого процесса). null — мусор. */
export function sanitizeSpec(raw: unknown): PromiseSpec | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const s = raw as Record<string, unknown>;
  if (s.kind === "none") {
    const r = s.reason === "past" || s.reason === "question" ? s.reason : "no_time";
    return { kind: "none", reason: r };
  }
  if (s.kind === "in") {
    const min = Number(s.minSec);
    const max = Number(s.maxSec ?? s.minSec);
    if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max <= 0 || max > PROMISE_MAX_AHEAD_MS / 1000) return null;
    return { kind: "in", minSec: Math.round(Math.min(min, max)), maxSec: Math.round(Math.max(min, max)) };
  }
  if (s.kind === "at") {
    let hour = Number(s.hour);
    const minute = Number(s.minute ?? 0);
    if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
    const half: PromiseHalf = s.half === "am" || s.half === "pm" ? s.half : "unknown";
    // Модель пишет час «как сказано» с частью суток: «8 вечера» → 8 + pm = 20:00, «12 ночи» → 12 + am = 00:00.
    // Уже 24-часовой час (20 + pm) не трогаем.
    if (half === "pm" && hour >= 1 && hour <= 11) hour += 12;
    else if (half === "am" && hour === 12) hour = 0;
    const day = s.day === "today" || s.day === "tomorrow" || s.day === "after" ? s.day : "nearest";
    const zone = typeof s.zone === "string" && isValidZone(s.zone) ? s.zone : undefined;
    return { kind: "at", hour, minute, half, day, ...(zone ? { zone } : {}), prep: s.prep === "k" ? "k" : "v", h24: hour === 0 || hour > 12 || half !== "unknown" };
  }
  return null;
}

/** «14:15» в поясе (для запасного текста — МСК). */
export function hmIn(ms: number, zone: string): string {
  const p = zonedParts(ms, zone);
  return `${pad2(p.h)}:${pad2(p.mi)}`;
}
