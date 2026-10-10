/**
 * Разметка ответа → безопасное подмножество, которое одинаково рисуют все четыре клиента
 * (веб, ПК-натив, Android, iOS; см. chat-scout.md §3):
 *   **жирный**, *курсив*, `код`, блок ``` без языка, плоские списки «- », «1. », цитата «> »,
 *   заголовки до ###, ссылки только https://.
 * Нельзя: таблицы (iOS), __жирный__ (Android), ---, вложенные списки, HTML, ![картинки](…),
 * ~~зачёркнутый~~ (веб/ПК без «ворот» показывают сырым).
 *
 * Модель просим писать так же, но на выходе всё равно чистим: дёшево и надёжно.
 */

export interface SanitizeResult {
  text: string;
  /** Адреса картинок из ![alt](https://…) — ядро попробует приложить их вложением. */
  images: Array<{ url: string; alt: string }>;
}

/** Скобки внутри адреса режут мобильные регулярки — кодируем. */
export function safeUrl(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  return u.toString().replace(/\(/g, "%28").replace(/\)/g, "%29").replace(/\s/g, "%20");
}

function convertTable(lines: string[]): string[] {
  const rows = lines
    .filter((l) => !/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l))
    .map((l) =>
      l
        .trim()
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((c) => c.trim())
        .filter((c) => c.length > 0)
    )
    .filter((cells) => cells.length > 0);
  if (rows.length === 0) return [];
  const [head, ...body] = rows;
  if (body.length === 0) return [`- ${head!.join(" — ")}`];
  return body.map((cells) => {
    const first = cells[0] ?? "";
    const rest = cells.slice(1).map((c, i) => {
      const h = head![i + 1];
      return h ? `${h}: ${c}` : c;
    });
    return rest.length ? `- **${first.replace(/\*\*/g, "")}** — ${rest.join(", ")}` : `- ${first}`;
  });
}

function sanitizeInline(line: string, images: SanitizeResult["images"]): string {
  // Код и адреса прячем в заглушки, чтобы правки _курсива_ и __жирного__ их не задели
  // (в адресах Википедии полно подчёркиваний).
  const stash: string[] = [];
  const hold = (v: string) => `\u0000${stash.push(v) - 1}\u0000`;
  let s = line.replace(/`[^`\n]+`/g, (m) => hold(m));
  // картинки: вынимаем во вложения
  s = s.replace(/!\[([^\]]*)\]\(\s*<?((?:[^()\s<>]|\([^()\s]*\))+)>?(?:\s+"[^"]*")?\s*\)/g, (_m, alt: string, url: string) => {
    const safe = safeUrl(url);
    if (safe) images.push({ url: safe, alt: alt.trim() });
    return "";
  });
  // ссылки: только https, адрес без скобок
  s = s.replace(/\[([^\]]+)\]\(\s*<?((?:[^()\s<>]|\([^()\s]*\))+)>?(?:\s+"[^"]*")?\s*\)/g, (_m, label: string, url: string) => {
    const safe = safeUrl(url);
    return safe ? `[${label}](${hold(safe)})` : label;
  });
  // голые адреса не трогаем
  s = s.replace(/https?:\/\/[^\s<>\u0000]+/g, (m) => hold(m));
  // HTML-переносы и теги
  s = s.replace(/<br\s*\/?>/gi, " ").replace(/<\/?(?:b|strong|i|em|u|s|sup|sub|span|div|p|small|code)(?:\s[^>]*)?>/gi, "");
  // __жирный__ → **жирный**, _курсив_ → *курсив* (на границах слова)
  s = s.replace(/(^|[^\p{L}\p{N}_*])__([^_\n]+?)__(?=[^\p{L}\p{N}_*]|$)/gu, "$1**$2**");
  s = s.replace(/(^|[^\p{L}\p{N}_*])_([^_\n]+?)_(?=[^\p{L}\p{N}_]|$)/gu, "$1*$2*");
  // ~~зачёркнутый~~ → просто текст
  s = s.replace(/~~([^~\n]+)~~/g, "$1");
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => stash[Number(i)] ?? "");
}

export function sanitizeMarkdown(input: string): SanitizeResult {
  const images: SanitizeResult["images"] = [];
  const src = input.replace(/\r\n?/g, "\n");
  const lines = src.split("\n");
  const out: string[] = [];
  let inFence = false;
  let table: string[] = [];

  const flushTable = () => {
    if (table.length) {
      out.push(...convertTable(table));
      table = [];
    }
  };

  for (const raw of lines) {
    const fence = /^\s*(```|~~~)/.exec(raw);
    if (fence) {
      flushTable();
      if (!inFence) {
        inFence = true;
        out.push("```"); // язык после ``` убираем: Android покажет его строкой кода
      } else {
        inFence = false;
        out.push("```");
      }
      continue;
    }
    if (inFence) {
      out.push(raw);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(raw) || (/\|/.test(raw) && table.length > 0 && /^\s*\|?\s*:?-{2,}/.test(raw))) {
      table.push(raw);
      continue;
    }
    flushTable();

    // горизонтальные линии → пустая строка
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(raw)) {
      out.push("");
      continue;
    }
    let line = raw;
    // заголовки глубже ### → жирная строка
    const h = /^\s*(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1]!.length;
      const title = h[2]!.replace(/\s*#+\s*$/, "");
      line = level <= 3 ? `${"#".repeat(level)} ${title}` : `**${title.replace(/\*\*/g, "")}**`;
    }
    // вложенные списки → плоские; маркеры * и + → «- »
    const li = /^(\s*)([-*+•])\s+(.*)$/.exec(line);
    if (li) line = `- ${li[3]}`;
    const oli = /^(\s+)(\d+[.)])\s+(.*)$/.exec(line);
    if (oli) line = `${oli[2]} ${oli[3]}`;
    // цитата: Android требует пробел после «>»
    line = line.replace(/^\s*>(?=\S)/, "> ");
    out.push(sanitizeInline(line, images));
  }
  flushTable();
  if (inFence) out.push("```");

  let text = out.join("\n");
  text = text.replace(/\n{3,}/g, "\n\n").trim();
  return { text, images };
}

/**
 * Делит длинный ответ на части ≤ max знаков: по абзацам, не разрывая блок кода.
 * Если часть всё равно длиннее — режет по строкам/словам.
 */
export function splitMessage(text: string, max = 3800, maxParts = 4): string[] {
  if (text.length <= max) return [text];
  const blocks: string[] = [];
  const lines = text.split("\n");
  let cur: string[] = [];
  let inFence = false;
  for (const l of lines) {
    if (/^```/.test(l)) inFence = !inFence;
    cur.push(l);
    if (!inFence && l.trim() === "") {
      blocks.push(cur.join("\n"));
      cur = [];
    }
  }
  if (cur.length) blocks.push(cur.join("\n"));

  const parts: string[] = [];
  let acc = "";
  const pushHard = (chunk: string) => {
    let rest = chunk;
    while (rest.length > max) {
      let cut = rest.lastIndexOf("\n", max);
      if (cut < max * 0.5) cut = rest.lastIndexOf(" ", max);
      if (cut < max * 0.5) cut = max;
      parts.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    return rest;
  };
  for (const b of blocks) {
    if ((acc + "\n" + b).length <= max) {
      acc = acc ? `${acc}\n${b}` : b;
      continue;
    }
    if (acc.trim()) parts.push(acc.trim());
    acc = b.length > max ? pushHard(b) : b;
  }
  if (acc.trim()) parts.push(acc.trim());
  if (parts.length > maxParts) {
    const kept = parts.slice(0, maxParts);
    kept[maxParts - 1] = `${kept[maxParts - 1]!.slice(0, max - 40).trim()}\n\n*(ответ обрезан)*`;
    return kept;
  }
  return parts;
}

/** Есть ли в тексте https-ссылка (тогда список источников уже есть). */
export function hasHttpsLink(text: string): boolean {
  return /https:\/\/\S+/.test(text);
}
