/**
 * Детерминированные формы (без модели) для карточек бота и «Подумай лучше» (docs/bot-cards.md):
 *   - таймер обещания: «проконтролируй / засеки / следи», «запомни», «пришёл / он тут / стоп», «ещё 10 минут»,
 *     «отмени», «как у Васи с пунктуальностью?», «кто самый пунктуальный?»;
 *   - «поделиться перепиской»: «забудь переписку», текстовый выбор ответом на карточку («сегодня с фото», «не надо»);
 *   - «подумай лучше / подумай ещё / подумай как следует / глубже».
 * Текст — после «Еблуша,» (invocationText). Регистр, ё и знаки в конце не важны.
 */
import { looksLikeTime, parsePromiseText } from "./promiseTime";

/** Нижний регистр, ё → е, без хвостовых знаков и эмодзи, пробелы схлопнуты. */
export function normIntent(text: string): string {
  return (text ?? "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}‍️]/gu, " ")
    .replace(/[«»"“”]/g, " ")
    .replace(/[.!?…]+\s*$/u, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ───────────────────────────── «Подумай лучше» ─────────────────────────────

const DEEP_RE =
  /^(?:(?:ну\s+|а\s+)?(?:подумай|думай|обдумай)(?:-ка)?\s+(?:лучше|получше|еще|ещё|еще\s+раз|как\s+следует|глубже|хорошенько|посерьезнее|тщательнее|основательнее|внимательнее)(?:\s+(?:пожалуйста|плиз|над\s+этим|над\s+ответом))?|глубже|подумай\s+лучше\s+над\s+этим)$/u;

/** «Подумай лучше» (кнопка шлёт «Еблуша, подумай лучше», в «Чате с Еблушей» — «Подумай лучше»). */
export function isDeepRequest(text: string): boolean {
  return DEEP_RE.test(normIntent(text));
}

// ───────────────────────────── «поделиться перепиской» ─────────────────────────────

const FORGET_RE = /^(?:(?:забудь|сотри|удали)\s+(?:эту\s+|нашу\s+|всю\s+)?(?:переписку|чат|историю\s+чата)|не\s+читай\s+(?:переписку|чат)|хватит\s+читать(?:\s+переписку)?)(?:\s+пожалуйста)?$/u;

export function isShareForget(text: string): boolean {
  return FORGET_RE.test(normIntent(text));
}

export type ShareChoice = { decline: true } | { decline: false; period: "today" | "week" | "all"; photos: boolean };

/** Текстовый выбор ответом на карточку «поделиться перепиской» (старые клиенты). null — не выбор. */
export function parseShareChoice(text: string): ShareChoice | null {
  const t = normIntent(text);
  if (!t) return null;
  if (/^(?:нет|неа|не\s+надо|не\s+делись|не\s+делиться|не\s+хочу|не\s+стоит|отказ|откажусь|не\s+буду)(?:\s|$)/u.test(t)) return { decline: true };
  const photos = /(?:^|\s)(?:с|\+|и|вместе\s+с)\s*(?:фото|фотками|фотографиями|картинками|картинки|фотки)(?:\s|$)/u.test(t);
  const rest = t.replace(/(?:^|\s)(?:с|\+|и|вместе\s+с)\s*(?:фото|фотками|фотографиями|картинками|картинки|фотки)(?:\s|$)/u, " ").replace(/^(?:да|давай|ок|окей)[,\s]+/u, "").trim();
  if (/^(?:за\s+)?(?:сегодня|сегодняшн\S*|день|за\s+день)$/u.test(rest)) return { decline: false, period: "today", photos };
  if (/^(?:за\s+)?(?:эту\s+)?(?:неделю|неделя|за\s+неделю|эта\s+неделя)$/u.test(rest)) return { decline: false, period: "week", photos };
  if (/^(?:за\s+)?(?:все|всё)(?:\s+время)?$/u.test(rest)) return { decline: false, period: "all", photos };
  return null;
}

// ───────────────────────────── таймер обещания ─────────────────────────────

export type PromiseIntent =
  /** Поставить таймер; rest — слова кроме глагола (могут содержать время «о себе»). */
  | { kind: "set"; rest: string }
  /** «запомни» — таймер, только если нашлось обещание (иначе — модели: это может быть просьба о памяти). */
  | { kind: "remember" }
  | { kind: "arrived"; self: boolean }
  | { kind: "extend"; text: string }
  /** Поправка срока спросившим в первые 5 минут: «не 2 ночи, а к 14», «нет, к 14». text — новое время. */
  | { kind: "correct"; text: string }
  | { kind: "cancel" }
  | { kind: "punctuality"; name: string | null; self: boolean }
  | { kind: "board" };

const SET_VERB = "(?:проконтролируй|проконтролить|проконтролировать|контролируй|засеки|засекай|засечь|засекай-ка|следи|последи|проследи|поставь\\s+таймер|таймер|считай|время\\s+пошло)";
const FILLER = "(?:\\s+(?:его|ее|её|это|время|пожалуйста|плиз|-ка|за\\s+ним|за\\s+ней|за\\s+ними|по\\s+нему|по\\s+ней))*";

const ARRIVED_RE =
  /^(?:(?:все|ну\s+все)[,\s]+)?(?:(?:он|она|они|я)\s+(?:тут|здесь|пришел|пришла|пришли|на\s+месте)|пришел|пришла|пришли|тут|здесь|на\s+месте|явился|явилась|явились|стоп|отметь(?:\s+что)?\s+пришел)$/u;
const CANCEL_RE = /^(?:отмени(?:\s+таймер)?|отмена(?:\s+таймера)?|отбой|не\s+надо|сними\s+таймер|отменяй|убери\s+таймер|стоп\s+таймер)$/u;
const EXTEND_RE = /^(?:(?:дай|давай|ну|буду|еще|ещё)\s+)*(?:еще|ещё|\+)\s*\S|^буду\s+(?:в|к|через)\s/u;

/** Намерение по таймеру обещания (или null). */
export function parsePromiseIntent(text: string): PromiseIntent | null {
  // raw — для слов о времени (двоеточие «15:30» нужно разбору), t — для сверки форм (без запятых и двоеточий).
  const raw = normIntent(text);
  const t = raw.replace(/[,;:]+/g, " ").replace(/\s+/g, " ").trim();
  if (!t) return null;
  if (new RegExp(`^${SET_VERB}${FILLER}$`, "u").test(t)) return { kind: "set", rest: "" };
  if (/^запомни(?:\s+это)?$/u.test(t)) return { kind: "remember" };
  if (ARRIVED_RE.test(t)) return { kind: "arrived", self: /^(?:(?:все|ну\s+все)\s+)?я\s/u.test(t) };
  if (CANCEL_RE.test(t)) return { kind: "cancel" };

  // пунктуальность
  if (/^кто\s+(?:у\s+нас\s+|тут\s+|здесь\s+)?(?:самый\s+пунктуальный|самый\s+непунктуальный|чаще\s+(?:всех\s+)?опаздывает|больше\s+всех\s+опаздывает|самый\s+опаздывающий)/u.test(t)) {
    return { kind: "board" };
  }
  {
    const m =
      /^(?:а\s+)?как\s+(?:там\s+)?(?:у\s+)?(.+?)\s+(?:обстоит\s+)?с\s+пунктуальностью$/u.exec(t) ??
      /^(?:а\s+)?(.+?)\s+(?:часто|сильно|всегда)\s+опаздывает$/u.exec(t) ??
      /^пунктуальность\s+(.+)$/u.exec(t) ??
      /^(?:а\s+)?насколько\s+(.+?)\s+пунктуален$/u.exec(t);
    if (m) {
      const raw = m[1]!.trim();
      const self = /^(?:меня|я|мной|мне)$/u.test(raw);
      return { kind: "punctuality", name: self ? null : raw, self };
    }
  }

  // поправка срока («не 2 ночи, а к 14», «нет, к 14», «не в 2, а в 14») — только если в новом есть время
  {
    const c = /^(?:не\s+.+?\s+а|нет(?:\s+не)?)\s+(.+)$/u.exec(raw.replace(/[,;]+/g, " ").replace(/\s+/g, " ").trim());
    if (c && looksLikeTime(c[1]!) && parsePromiseText(c[1]!).spec.kind !== "none") return { kind: "correct", text: c[1]!.trim() };
  }

  // продление словами («ещё 10 минут», «+10», «буду в 15:00») — только если в словах есть время
  if (EXTEND_RE.test(t)) {
    const p = parsePromiseText(raw);
    if (p.spec.kind !== "none") return { kind: "extend", text: raw };
  }

  // «засеки 15 минут», «я буду через 15 минут, засеки», «я в 21:30, проконтролируй» — о себе; «проследи, чтобы
  // Вася был к девяти» — про другого (это решает модель инструментом promise_timer).
  const verb = new RegExp(`(?:^|\\s)${SET_VERB}(?=\\s|$)`, "u");
  if (verb.test(t)) {
    const strip = (x: string) =>
      x
        .replace(new RegExp(`(?:^|\\s)${SET_VERB}${FILLER}(?=[\\s,;:.!]|$)`, "gu"), " ")
        .replace(/\s+/g, " ")
        .replace(/^[\s,;:.!-]+|[\s,;:.!-]+$/g, "")
        .trim();
    const rest = strip(raw);
    if (/(?:^|\s)(?:чтобы|что|пусть|когда)\s/u.test(` ${strip(t)} `)) return null;
    if (rest && looksLikeTime(rest) && parsePromiseText(rest).spec.kind !== "none") return { kind: "set", rest };
  }
  return null;
}

/** Ответ на переспрос «кого контролируем?»: «1», «2», «первого», имя. */
export function pickCandidate(text: string, names: Array<string | null>): number | null {
  const t = normIntent(text);
  const n = /^(?:номер\s+)?(\d)(?:\s|$)/.exec(t);
  if (n) {
    const i = Number(n[1]) - 1;
    return i >= 0 && i < names.length ? i : null;
  }
  const ord: Record<string, number> = { первый: 0, первого: 0, первое: 0, второй: 1, второго: 1, второе: 1, третий: 2, третьего: 2, третье: 2 };
  if (t in ord && ord[t]! < names.length) return ord[t]!;
  const hits = names.map((nm, i) => ({ i, nm: (nm ?? "").toLowerCase().replace(/ё/g, "е") })).filter((x) => x.nm && (x.nm.includes(t) || t.includes(x.nm.split(" ")[0]!)));
  return hits.length === 1 ? hits[0]!.i : null;
}

const YES = /^(?:да|ага|угу|давай|верно|точно|ок|окей|yes|засекай|конечно|да,?\s*засекай)$/u;
export const isYes = (text: string) => YES.test(normIntent(text));
