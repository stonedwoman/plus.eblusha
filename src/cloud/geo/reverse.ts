import fs from "node:fs";
import path from "node:path";
import logger from "../../config/logger";
import cloudConfig from "../config";

/**
 * Обратное геокодирование EXIF-координат — ЦЕЛИКОМ офлайн.
 *
 * Никаких обращений к чужим сервисам: координаты личных снимков не должны
 * уходить наружу, да и лимиты публичных геокодеров сделали бы обработку пачки
 * в несколько тысяч файлов невозможной. Датасет — GeoNames cities500
 * (CC BY 4.0), около 235 тысяч населённых пунктов, качается один раз скриптом
 * `npm run cloud:geo-fetch` в CLOUD_STORAGE_ROOT/geo.
 *
 * Глубина намеренно ограничена населённым пунктом: у GeoNames нет городских
 * районов — сразу за городом идут здания и улицы, а раскладывать альбом по
 * улицам бессмысленно.
 */
export type Place = {
  countryCode: string;
  country: string;
  city: string;
  /** Заполняется, только когда рядом честно есть отдельная местность. */
  district: string | null;
  path: string;
};

type Row = {
  id: string;
  name: string;
  ascii: string;
  alt: string;
  lat: number;
  lon: number;
  cc: string;
  pop: number;
};

/** Разделитель уровней в geoPath: печатных символов не бывает, сортируется первым. */
export const PATH_SEP = "";

const CELL = 1; // градус на ячейку сетки
const SEARCH_KM = 30;

let grid: Map<string, Row[]> | null = null;
/** geonameId → русское название из справочника с языковыми метками. */
let ruNames: Map<string, string> = new Map();
let loadFailed = false;

export function geoDatasetPath(): string {
  return path.join(cloudConfig.CLOUD_STORAGE_ROOT, "geo", "cities500.txt");
}

function geoNamesPath(): string {
  return path.join(cloudConfig.CLOUD_STORAGE_ROOT, "geo", "names-ru.tsv");
}

/**
 * Загрузка датасета в память и построение сетки 1°×1°.
 *
 * 235 тысяч строк — порядка 25 МБ в памяти; поиск идёт по девяти соседним
 * ячейкам, поэтому дерево не нужно. Если файла нет, геокодирование просто
 * отключается: обработка медиа не должна падать из-за отсутствия справочника.
 */
function ensureLoaded(): boolean {
  if (grid) return true;
  if (loadFailed) return false;

  const file = geoDatasetPath();
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    loadFailed = true;
    logger.warn({ file }, "cloud: датасет GeoNames не найден, геокодирование выключено");
    return false;
  }

  const next = new Map<string, Row[]>();
  let count = 0;
  for (const line of raw.split("\n")) {
    const f = line.split("\t");
    if (f.length < 15) continue;
    const lat = Number(f[4]);
    const lon = Number(f[5]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const key = `${Math.floor(lat / CELL)}|${Math.floor(lon / CELL)}`;
    let bucket = next.get(key);
    if (!bucket) {
      bucket = [];
      next.set(key, bucket);
    }
    bucket.push({
      id: f[0] ?? "",
      name: f[1] ?? "",
      ascii: f[2] ?? "",
      alt: f[3] ?? "",
      lat,
      lon,
      cc: f[8] ?? "",
      pop: Number(f[14]) || 0,
    });
    count++;
  }
  grid = next;

  /*
   * Русские названия — из отдельного файла с языковыми метками. Он
   * необязателен: без него имена остаются оригинальными, но никогда не
   * становятся неверными.
   */
  ruNames = new Map();
  try {
    for (const line of fs.readFileSync(geoNamesPath(), "utf8").split("\n")) {
      const tab = line.indexOf("\t");
      if (tab > 0) ruNames.set(line.slice(0, tab), line.slice(tab + 1).trim());
    }
  } catch {
    logger.warn("cloud: русских названий мест нет, показываем оригинальные");
  }

  logger.info({ count, cells: next.size, ru: ruNames.size }, "cloud: датасет мест загружен");
  return true;
}

/** Строго русский алфавит: кириллица вообще пропускала «Єреван» и сербские формы. */
const RU_ONLY = /^[А-Яа-яЁё][А-Яа-яЁё\s\-']*$/;

const TRANSLIT: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i",
  й: "i", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t",
  у: "u", ф: "f", х: "kh", ц: "ts", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y",
  ь: "", э: "e", ю: "yu", я: "ya",
};

function translit(v: string): string {
  let out = "";
  for (const ch of v.toLowerCase()) out += TRANSLIT[ch] ?? ch;
  return out;
}

function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n]!;
}

/**
 * Русское имя места.
 *
 * Сначала справочник с языковыми метками — он единственный знает, что Paris
 * по-русски «Париж», а не «Парис». Если его нет, откатываемся на разбор
 * общего списка alternatenames: там языки перемешаны, поэтому вариант
 * выбираем по близости транслитерации к оригиналу — так «Тбилиси» побеждает
 * «Тбилис», а «Степанаван» историческое «Джалалоглу».
 */
function russianName(row: Row): string | null {
  const tagged = ruNames.get(row.id);
  if (tagged) return tagged;
  const base = (row.ascii || row.name).toLowerCase();
  if (!base) return null;
  let best: string | null = null;
  let bestScore = Infinity;
  for (const candidate of row.alt.split(",")) {
    const value = candidate.trim();
    if (!value || !RU_ONLY.test(value)) continue;
    const score = editDistance(translit(value), base) / Math.max(base.length, 1);
    if (score < bestScore) {
      bestScore = score;
      best = value;
    }
  }
  return bestScore <= 0.34 ? best : null;
}

const display = (row: Row): string => russianName(row) ?? row.name;

/**
 * Радиус влияния населённого пункта: крупный город «забирает» снимки своих
 * окраин, деревня — только собственные. Без этого ближайшая точка всегда
 * побеждала, и центр Тбилиси подписывался именем соседнего посёлка.
 */
function reachKm(pop: number): number {
  if (pop >= 500_000) return 28;
  if (pop >= 100_000) return 18;
  if (pop >= 20_000) return 11;
  if (pop >= 5_000) return 7;
  if (pop >= 1_000) return 4;
  return 2.5;
}

function nearby(lat: number, lon: number, km: number): (Row & { km: number })[] {
  const out: (Row & { km: number })[] = [];
  const cy = Math.floor(lat / CELL);
  const cx = Math.floor(lon / CELL);
  const scale = Math.cos((lat * Math.PI) / 180);
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      for (const row of grid!.get(`${cy + dy}|${cx + dx}`) ?? []) {
        const y = (row.lat - lat) * 111;
        const x = (row.lon - lon) * 111 * scale;
        const d = Math.sqrt(y * y + x * x);
        if (d <= km) out.push({ ...row, km: d });
      }
    }
  }
  return out;
}

const regionNames = new Intl.DisplayNames(["ru"], { type: "region" });

function countryName(code: string): string {
  if (!/^[A-Z]{2}$/.test(code)) return code;
  try {
    return regionNames.of(code) ?? code;
  } catch {
    return code;
  }
}

/** Место съёмки по координатам. null — датасета нет или вокруг ничего нет. */
export function resolvePlace(lat: number, lon: number): Place | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  if (!ensureLoaded()) return null;

  const near = nearby(lat, lon, SEARCH_KM);
  if (near.length === 0) return null;

  const covering = near.filter((r) => r.km <= reachKm(r.pop));
  const city = covering.length
    ? covering.reduce((a, b) => (b.pop > a.pop ? b : a))
    : near.reduce((a, b) => (a.km < b.km ? a : b));
  const nearest = near.reduce((a, b) => (a.km < b.km ? a : b));

  /*
   * Район ставим ТОЛЬКО если ближайшая точка честно ближе города и мельче его.
   * Иначе на весь городской центр вешался соседний посёлок в шести километрах
   * — подпись выглядела осмысленной и была неверной.
   */
  const local = nearest.name !== city.name && nearest.pop < city.pop && nearest.km < city.km ? nearest : null;

  const country = countryName(city.cc);
  const cityName = display(city);
  const districtName = local ? display(local) : null;
  return {
    countryCode: city.cc,
    country,
    city: cityName,
    district: districtName,
    path: [country, cityName, districtName ?? ""].join(PATH_SEP),
  };
}

/** Только для тестов и скриптов: сбросить кэш датасета. */
export function resetGeoCache(): void {
  grid = null;
  ruNames = new Map();
  loadFailed = false;
}
