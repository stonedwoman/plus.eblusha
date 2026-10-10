/**
 * Геометрия мира Valheim: x — восток, z — север (метры), y — высота; y > 3000 — подземелье.
 * Поворот (yaw): 0 — север, 90 — восток, градусы (как отдаёт мод и карта сайта).
 */

export interface Pt {
  x: number;
  z: number;
}

export const DUNGEON_Y = 3000;

export function dist(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/** Азимут из a в b: 0 — север, 90 — восток. */
export function bearing(a: Pt, b: Pt): number {
  const deg = (Math.atan2(b.x - a.x, b.z - a.z) * 180) / Math.PI;
  return (deg + 360) % 360;
}

const DIR_NOM = ["север", "северо-восток", "восток", "юго-восток", "юг", "юго-запад", "запад", "северо-запад"] as const;
const DIR_DAT = ["северу", "северо-востоку", "востоку", "юго-востоку", "югу", "юго-западу", "западу", "северо-западу"] as const;

function dirIndex(deg: number): number {
  return ((Math.round((((deg % 360) + 360) % 360) / 45) % 8) + 8) % 8;
}

/** «на северо-восток» — куда смотрит / куда идти. */
export function facing(deg: number): string {
  return `на ${DIR_NOM[dirIndex(deg)]}`;
}

/** «к юго-западу» — где точка b относительно a. */
export function sideOf(a: Pt, b: Pt): string {
  return `к ${DIR_DAT[dirIndex(bearing(a, b))]}`;
}

/** «120 м», «1,2 км», «15 км». */
export function fmtDist(m: number): string {
  if (!Number.isFinite(m)) return "?";
  if (m < 1000) return `${Math.max(10, Math.round(m / 10) * 10)} м`;
  if (m < 10_000) return `${(m / 1000).toFixed(1).replace(".", ",")} км`;
  return `${Math.round(m / 1000)} км`;
}

/** Длительность по-русски: «1 ч 12 мин», «40 мин», «2 мин». */
export function fmtDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return m > 0 ? `${h} ч ${m} мин` : `${h} ч`;
  if (m > 0) return `${m} мин`;
  return `${s} с`;
}

export interface Landmark extends Pt {
  kind: "portal" | "location" | "bed" | "sign" | "ship" | "station" | "home";
  /** Как назвать в тексте: «портала «ЖЕЛЕЗО2»», «Погребальных комнат». Готовая форма в род. падеже не нужна — пишем «от: X». */
  name: string;
}

/**
 * Описание места словами по ближайшему ориентиру.
 *   «у портала «ЖЕЛЕЗО2»» (ближе 25 м)
 *   «в 340 м к юго-западу от портала «БОЛОТО»»
 */
export function describeNear(p: Pt, marks: Landmark[], maxDist = 6000): { text: string; mark: Landmark | null; dist: number } {
  let best: Landmark | null = null;
  let bestD = Infinity;
  for (const m of marks) {
    const d = dist(p, m);
    if (d < bestD) {
      bestD = d;
      best = m;
    }
  }
  if (!best || bestD > maxDist) return { text: "вдали от всех известных мест", mark: null, dist: bestD };
  if (bestD < 25) return { text: `у ${best.name}`, mark: best, dist: bestD };
  return { text: `в ${fmtDist(bestD)} ${sideOf(best, p)} от ${best.name}`, mark: best, dist: bestD };
}
