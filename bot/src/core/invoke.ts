/**
 * Разбор обращения на стороне бота.
 *
 * Решает, адресовано ли сообщение боту, СЕРВЕР (src/lib/systemBot.ts → detectBotAddress, те же
 * правила владельца): «Еблуша,» / «Еблуша:» / «Еблуша!» в начале (регистр, е/ё и похожая латиница
 * не важны), /eb, /еб, ответ на сообщение бота, «Чат с Еблушей». Бот получает только такие сообщения
 * и здесь лишь срезает обращение с текста (invocationText) и узнаёт благодарность («спасибо» → 👍).
 */

/** Сворачивает первые символы к виду «еблуша»: регистр, ё, похожая латиница. */
function foldHead(s: string): string {
  const map: Record<string, string> = { e: "е", a: "а", y: "у", "6": "б", b: "б", w: "ш", ё: "е" };
  return Array.from(s.toLowerCase())
    .map((ch) => map[ch] ?? ch)
    .join("");
}

const NAME_LEN = "еблуша".length;

/** Если текст начинается с «Еблуша,»/«Еблуша:»/«Еблуша!» — вернуть остаток, иначе null. */
export function stripNamePrefix(content: string): string | null {
  const m = /^\s*@?/.exec(content);
  const start = m ? m[0].length : 0;
  const head = content.slice(start, start + NAME_LEN);
  if (foldHead(head) !== "еблуша") return null;
  const after = content.slice(start + NAME_LEN);
  const p = /^\s*[,:!]/.exec(after);
  if (!p) return null;
  return after.slice(p[0].length).trim();
}

/** «/eb …», «/еб …» (любой регистр, как на сервере) → остаток (может быть пустым), иначе null. */
export function stripCommandPrefix(content: string): string | null {
  const m = /^\s*\/(?:eb|еб)(?=$|\s)/iu.exec(content);
  if (!m) return null;
  return content.slice(m[0].length).trim();
}

/** Текст вопроса без обращения: «Еблуша, …» / «/eb …» срезаются, остальное — как есть. */
export function invocationText(content: string | null | undefined): string {
  const t = (content ?? "").trim();
  return stripNamePrefix(t) ?? stripCommandPrefix(t) ?? t;
}

const THANKS_CORE = new Set([
  "спасибо", "спасиб", "спасибки", "спасибочки", "спс", "пасиб", "пасиба", "пасибо", "сенкс", "сенк", "сенкью",
  "thanks", "thank", "thx", "ty", "благодарю", "мерси", "лол", "lol", "ору", "кек", "ржу", "хд", "xd",
  "пушка", "огонь", "красава", "красавчик", "топ", "имба", "гений", "легенда", "база",
]);
const THANKS_EXTRA = new Set([
  "большое", "огромное", "тебе", "вам", "you", "a", "lot", "so", "much", "бро", "братан", "друг", "дружище",
  "еблуша", "ты", "просто", "круто", "класс", "классно", "отлично", "супер", "понял", "поняла", "понятно", "ясно",
  "ок", "окей", "ok", "okay", "хорошо", "ладно", "норм", "ага", "угу", "и", "да", "вот", "это", "оно", "самое",
  "прям", "очень", "лучший", "лучшая", "спасибище",
]);
const LAUGH = /^(?:а?(?:ха|хах|хе|хи|ах)+[ахеи]*|хд+|ха-ха(?:-ха)*|lo+l|ахахах?а*|ъ+|пх+а+)$/u;
const THANKS_EMOJI = /^(?:[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}‍️\s)(]|:\)|:D)+$/u;

/**
 * «Спасибо!», «ахахах», «спс бро 👍», «😂😂» — короткая благодарность или смех без вопроса.
 * Любое «содержательное» слово (вопрос, просьба) — уже не благодарность.
 */
export function isThanksOrLaugh(content: string | null | undefined): boolean {
  const raw = (content ?? "").trim();
  if (!raw || raw.length > 60) return false;
  if (raw.includes("?")) return false;
  if (THANKS_EMOJI.test(raw)) return true;
  const words = raw
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}‍️]/gu, " ")
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return /[\p{Extended_Pictographic}]/u.test(raw);
  if (words.length > 7) return false;
  let core = false;
  for (const w of words) {
    if (THANKS_CORE.has(w) || LAUGH.test(w)) {
      core = true;
      continue;
    }
    if (THANKS_EXTRA.has(w)) continue;
    return false;
  }
  return core;
}
