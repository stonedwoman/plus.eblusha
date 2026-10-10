/**
 * Поиск предмета по словам человека: «семена репы» → TurnipSeeds, «репа» → Turnip и TurnipSeeds.
 *
 * Мод ищет подстроку, а русский склоняется («репа» не подстрока «Семена репы»), поэтому бот
 * сначала сам сопоставляет слова со справочником игры (/bot/v1/items) по основам слов, а моду
 * передаёт точные префабы. Без справочника — отдаёт моду слова как есть.
 */
import type { CatalogItem } from "./types";

const ENDINGS = [
  "ями", "ами", "ого", "его", "ому", "ему", "ыми", "ими", "иях", "ах", "ях", "ов", "ев", "ей", "ий", "ый", "ой", "ая", "яя", "ое", "ее", "ые", "ие",
  "ом", "ем", "ам", "ям", "ую", "юю", "а", "я", "ы", "и", "у", "ю", "е", "о", "ь", "й",
];

/** Основа слова: нижний регистр, ё→е, без окончания (основа не короче 3 букв). */
export function stem(word: string): string {
  const w = word.toLowerCase().replace(/ё/g, "е");
  if (!/[а-я]/.test(w)) return w.replace(/(?:es|s)$/, (m) => (w.length - m.length >= 3 ? "" : m));
  for (const e of ENDINGS) {
    if (w.endsWith(e) && w.length - e.length >= 3) return w.slice(0, -e.length);
  }
  return w;
}

/** Беглые гласные и чередования, которые простое отсечение окончаний не ловит. */
const SYNONYMS: Record<string, string> = { семян: "семена", семечки: "семена", семечек: "семена", угля: "уголь", углей: "уголь", льна: "лен", пуха: "пух", мха: "мох" };

function words(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/ё/g, "е")
    .split(/[^a-zа-я0-9]+/u)
    .filter((w) => w.length >= 2)
    .map((w) => SYNONYMS[w] ?? w);
}

/** Шумовые слова в запросе: «есть ли у нас дома семена репы» → «семена репы». */
const STOP = new Set(["есть", "ли", "у", "нас", "дома", "доме", "в", "на", "с", "со", "и", "или", "где", "лежит", "лежат", "сколько", "какие", "какой", "наш", "наши", "сундук", "сундуке", "сундуках", "штук", "шт"]);

export interface ItemMatch {
  item: CatalogItem;
  score: number;
}

/**
 * Совпадение: каждое слово запроса (по основе) — начало какого-то слова в русском или
 * английском имени, либо подстрока префаба. Точное имя выше частичного.
 */
export function matchItems(query: string, catalog: CatalogItem[], limit = 8): ItemMatch[] {
  const q = words(query).filter((w) => !STOP.has(w));
  if (!q.length) return [];
  const qs = q.map(stem);
  const out: ItemMatch[] = [];
  for (const it of catalog) {
    if (/^(?:FW_|SP_)/.test(it.p)) continue;
    const ru = words(it.ru ?? "");
    const en = words(it.en ?? "");
    const pref = it.p.toLowerCase();
    const nameStems = [...ru, ...en].map(stem);
    let ok = true;
    let exactWords = 0;
    for (let i = 0; i < qs.length; i++) {
      const s = qs[i]!;
      // «реп» → «репы»; обратное («серебр» ⊃ «сер» из «Сера») — только на одну букву.
      const hit = nameStems.some((n) => n.startsWith(s) || (s.startsWith(n) && n.length >= 4 && s.length - n.length <= 1)) || pref.includes(q[i]!);
      if (!hit) {
        ok = false;
        break;
      }
      if (nameStems.includes(s)) exactWords++;
    }
    if (!ok) continue;
    const nameLen = Math.max(ru.length, en.length, 1);
    // Чем ближе число слов имени к числу слов запроса, тем точнее («репа» → «Репа» выше «Семена репы»).
    const score = exactWords * 10 - Math.abs(nameLen - qs.length) * 3 + (it.type === "Material" || it.type === "Consumable" ? 1 : 0);
    out.push({ item: it, score });
  }
  return out.sort((a, b) => b.score - a.score || a.item.p.localeCompare(b.item.p)).slice(0, limit);
}
