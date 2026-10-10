/**
 * Ники Valheim ↔ люди Еблуши.
 *
 * В игре ники часто набирают похожими латинскими буквами: «IiApaCiOxa» читается как «ПАРАСЮХА»
 * («Ii»→П, «iO»→Ю, A→А, p→Р, C→С, x→Х …). Человек же пишет «Парасюха» по-русски.
 * Детерминированный нормализатор сводит обе записи к «скелету» и сравнивает скелеты.
 * Два скелета на строку: по ПОХОЖЕСТИ букв (IiApaCiOxa) и по ТРАНСЛИТУ (Pomah, Kurolesska).
 * Совпало хоть по одному — это тот же персонаж. Что не сошлось — решает модель по списку
 * известных серверу персонажей (core/links.ts), а без модели — близость скелетов (≤1 правка).
 */

/** Многобуквенные «рисунки» → кириллица. Порядок важен: длинные раньше коротких. */
// «Палочки»: латинские I/i/l, |, 1, !, украинские і/І.
const STICK = "[Iil|1!іІ]";
const SHAPE_SEQ: Array<[RegExp, string]> = [
  [new RegExp(`${STICK}{3}`, "g"), "Ш"],
  [/>\|</g, "Ж"],
  [/\}\|\{/g, "Ж"],
  [new RegExp(`${STICK}[oO0оО]`, "g"), "Ю"],
  [new RegExp(`${STICK}-${STICK}`, "g"), "Н"],
  [new RegExp(`${STICK}{2}`, "g"), "П"],
  [new RegExp(`[bЬь]${STICK}`, "g"), "Ы"],
  [new RegExp(`J${STICK}`, "g"), "Л"],
];

/** Одиночные похожие буквы/цифры → кириллица (по форме, а не по звуку). */
const SHAPE_ONE: Record<string, string> = {
  A: "А", a: "А", B: "В", b: "Ь", C: "С", c: "С", E: "Е", e: "Е", H: "Н", h: "Н",
  K: "К", k: "К", M: "М", m: "Т", O: "О", o: "О", P: "Р", p: "Р", T: "Т", X: "Х",
  x: "Х", Y: "У", y: "У", u: "И", n: "П", r: "Г", g: "Д", N: "И", R: "Я", W: "Ш",
  w: "Ш", "3": "З", "4": "Ч", "6": "Б", "0": "О", "@": "А",
};

/** Транслит латиница → кириллица. Сочетания раньше одиночных. */
const TRANSLIT_SEQ: Array<[RegExp, string]> = [
  [/shch/gi, "Щ"],
  [/sch/gi, "Щ"],
  [/zh/gi, "Ж"],
  [/kh/gi, "Х"],
  [/ch/gi, "Ч"],
  [/sh/gi, "Ш"],
  [/ts/gi, "Ц"],
  [/yu|ju|iu/gi, "Ю"],
  [/ya|ja|ia/gi, "Я"],
  [/yo|jo/gi, "Е"],
  [/ye|je/gi, "Е"],
];
const TRANSLIT_ONE: Record<string, string> = {
  a: "А", b: "Б", c: "К", d: "Д", e: "Е", f: "Ф", g: "Г", h: "Х", i: "И", j: "Й",
  k: "К", l: "Л", m: "М", n: "Н", o: "О", p: "П", q: "К", r: "Р", s: "С", t: "Т",
  u: "У", v: "В", w: "В", x: "Х", y: "Ы", z: "З",
};

/** Общая чистка кириллицы: регистр, ё/й, удвоения не трогаем. */
function finishCyr(s: string): string {
  return s
    .toUpperCase()
    .replace(/Ё/g, "Е")
    .replace(/Й/g, "И")
    .replace(/[^А-ЯЁA-Z]/g, "");
}

/** Скелет по форме букв: «IiApaCiOxa» → «ПАРАСЮХА», «РомаH» → «РОМАН». */
export function shapeSkeleton(raw: string): string {
  let s = raw.normalize("NFKC");
  for (const [re, to] of SHAPE_SEQ) s = s.replace(re, to);
  s = Array.from(s)
    .map((ch) => SHAPE_ONE[ch] ?? ch)
    .join("");
  return finishCyr(s);
}

/** Скелет по транслиту: «Kurolesska» → «КУРОЛЕССКА», «PaRaSuXa» → «ПАРАСУХА». */
export function translitSkeleton(raw: string): string {
  let s = raw.normalize("NFKC");
  for (const [re, to] of TRANSLIT_SEQ) s = s.replace(re, to);
  s = Array.from(s)
    .map((ch) => TRANSLIT_ONE[ch.toLowerCase()] ?? ch)
    .join("");
  return finishCyr(s);
}

export function skeletons(raw: string): string[] {
  const out = new Set<string>();
  for (const k of [shapeSkeleton(raw), translitSkeleton(raw)]) if (k.length > 0) out.add(k);
  return [...out];
}

/**
 * Как ник читается по-русски, если он набран латиницей или смесью: «IiApaCiOxa» → «Парасюха»,
 * «РомаH» → «Роман», «Kurolesska» → «Куролесска». Обычная кириллица → null (читать нечего).
 */
export function readableName(nick: string): string | null {
  if (!/[A-Za-z0-9|!@]/.test(nick)) return null;
  const cyr = (s: string) => (s.length >= 2 && /^[А-Я]+$/.test(s) ? s : null);
  const s = cyr(shapeSkeleton(nick)) ?? cyr(translitSkeleton(nick));
  if (!s) return null;
  const pretty = s[0] + s.slice(1).toLowerCase();
  return pretty.toLowerCase() === nick.toLowerCase() ? null : pretty;
}

/** Тот же персонаж по детерминированным правилам. */
export function sameCharacter(a: string, b: string): boolean {
  const sa = skeletons(a);
  const sb = new Set(skeletons(b));
  return sa.some((k) => sb.has(k));
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const prev = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length]!;
}

export type MatchResult =
  | { kind: "exact"; character: string }
  | { kind: "ambiguous"; candidates: string[] }
  | { kind: "none" };

/** Детерминированное сопоставление ввода со списком известных персонажей. */
export function matchCharacter(input: string, known: string[]): MatchResult {
  const hits = known.filter((k) => sameCharacter(input, k));
  const uniq = [...new Set(hits)];
  if (uniq.length === 1) return { kind: "exact", character: uniq[0]! };
  if (uniq.length > 1) return { kind: "ambiguous", candidates: uniq };
  return { kind: "none" };
}

/** Запасной путь без модели: ровно один персонаж на расстоянии ≤1 правки скелета (для имён от 5 букв). */
export function fuzzyCharacter(input: string, known: string[]): string | null {
  const mine = skeletons(input);
  const near: string[] = [];
  for (const k of known) {
    const theirs = skeletons(k);
    const best = Math.min(...mine.flatMap((a) => theirs.map((b) => (Math.min(a.length, b.length) >= 5 ? levenshtein(a, b) : 99))));
    if (best <= 1) near.push(k);
  }
  const uniq = [...new Set(near)];
  return uniq.length === 1 ? uniq[0]! : null;
}

/** Ник из ввода: убрать кавычки/хвостовую пунктуацию; null — если на ник не похоже. */
export function cleanNick(raw: string): string | null {
  let s = raw.trim().replace(/^[«"'“„`]+|[»"'”`]+$/g, "").trim();
  s = s.replace(/[.!?,;:)]+$/u, "").trim();
  s = s.replace(/^[«"'“„`]+|[»"'”`]+$/g, "").trim();
  if (s.length < 2 || s.length > 32) return null;
  if (s.split(/\s+/).length > 3) return null;
  if (/https?:|[\n\r]/i.test(s)) return null;
  return s;
}

export type LinkIntent =
  | { kind: "link_self"; nick: string }
  | { kind: "unlink_self" }
  | { kind: "link_other"; nick: string } // владелец, в ответ на сообщение того человека
  | { kind: "whoami" };

const GAME = String.raw`(?:в\s+(?:игре|валхейме|вальхейме|valheim|вальхе|вальке)|игровой)`;

/**
 * Свободные фразы привязки (после «Еблуша,»). Ничего, кроме этих форм, не ловим —
 * иначе «я голоден» станет ником.
 */
export function parseLinkIntent(text: string): LinkIntent | null {
  const t = text.trim().replace(/ё/g, "е").replace(/Ё/g, "Е");
  const lower = t.toLowerCase();
  const tail = (m: RegExpMatchArray | null): string | null => {
    const nick = m?.groups?.nick ? cleanNick(m.groups.nick) : null;
    if (!nick) return null;
    // «мой ник в игре» без ника: необязательная часть «в игре» не должна стать ником
    if (/^(?:в\s+)?(?:игре|валхейме|вальхейме|valheim|игровой)$|^(?:это|такой|какой|тут|здесь)$/i.test(nick)) return null;
    return nick;
  };

  if (/^(?:отвяжи|отвязать|забудь)\s+(?:меня|мой\s+ник|мою\s+привязку|мой\s+персонаж)(?=$|[\s.,!?])/i.test(lower)) return { kind: "unlink_self" };
  if (/^(?:кто\s+я|какой\s+у\s+меня\s+ник|мой\s+ник\s*\?|за\s+кого\s+ты\s+меня\s+считаешь)/i.test(lower)) return { kind: "whoami" };

  const selfPatterns: RegExp[] = [
    new RegExp(String.raw`^(?:мой|моего)\s+(?:ник|никнейм|персонаж|перс|чар|герой)(?:\s+${GAME})?\s*(?:[-—–:=]|это|—)?\s*(?<nick>.+)$`, "iu"),
    new RegExp(String.raw`^я\s*(?:${GAME}\s*)?[-—–:]\s*(?<nick>.+)$`, "iu"),
    new RegExp(String.raw`^я\s+${GAME}\s+(?<nick>.+)$`, "iu"),
    new RegExp(String.raw`^(?:меня\s+)?${GAME}\s+(?:меня\s+)?зовут\s+(?<nick>.+)$`, "iu"),
    new RegExp(String.raw`^${GAME}\s+я\s+(?<nick>.+)$`, "iu"),
    /^(?:привяжи|привязать)\s+меня\s+к\s+(?<nick>.+)$/iu,
  ];
  for (const re of selfPatterns) {
    const nick = tail(t.match(re));
    if (nick) return { kind: "link_self", nick };
  }

  const otherPatterns: RegExp[] = [
    new RegExp(String.raw`^(?:его|ее|её|их)\s+(?:ник|персонаж|перс|чар)(?:\s+${GAME})?\s*(?:[-—–:=]|это)?\s*(?<nick>.+)$`, "iu"),
    new RegExp(String.raw`^(?:он|она)\s*(?:${GAME}\s*)?[-—–:]\s*(?<nick>.+)$`, "iu"),
    new RegExp(String.raw`^(?:он|она)\s+${GAME}\s+(?<nick>.+)$`, "iu"),
    /^привяжи\s+(?:его|ее|её)\s+к\s+(?<nick>.+)$/iu,
  ];
  for (const re of otherPatterns) {
    const nick = tail(t.match(re));
    if (nick) return { kind: "link_other", nick };
  }
  return null;
}
