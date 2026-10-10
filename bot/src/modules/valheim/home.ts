/**
 * «Дом» и базы. Мод «дом» не вычисляет: бот сам собирает кластеры построек.
 *
 * Опорные точки: кровати, станки (верстак, кузница…), порталы и таблички (с меткой «ДОМ…»).
 * Кластер — точки, связанные цепочкой ближе LINK_M. База — кластер с кроватью, или с меткой
 * «дом», или с тремя и более станками. «Дом» (без уточнения) — база с наибольшим весом:
 * кровати весят больше станков, метка «дом» — ещё больше.
 */
import { dist, type Pt } from "./geo";
import { BASE_STATIONS } from "./names";

export interface AnchorLike extends Pt {
  kind: "bed" | "station" | "portal" | "sign" | "ward";
  prefab: string;
  text?: string | undefined;
  owner?: string | undefined;
  world?: boolean | undefined;
}

export interface Base extends Pt {
  id: number;
  /** «главный дом», «дом «ДОМ4»», «база у кровати РомаH»… — для текста. */
  name: string;
  isMain: boolean;
  radius: number;
  beds: number;
  stations: number;
  owners: string[];
  homeLabel: string | null;
  score: number;
  /** Порталы базы (метки) — чтобы сказать «дома, у портала …». */
  portals: string[];
}

const LINK_M = 45;
const HOME_RE = /^\s*(?:дом|home|база)\s*\d*\s*$/iu;

export function isHomeLabel(s: string | undefined): boolean {
  return !!s && HOME_RE.test(s.replace(/[\p{Extended_Pictographic}\u{FE0F}]/gu, ""));
}

export function findBases(anchors: AnchorLike[]): Base[] {
  const pts = anchors.filter(
    (a) =>
      !a.world &&
      (a.kind === "bed" ||
        (a.kind === "station" && BASE_STATIONS.has(a.prefab)) ||
        a.kind === "portal" ||
        (a.kind === "sign" && isHomeLabel(a.text)))
  );
  // Связные компоненты по расстоянию (точек немного — сотни, n² не страшно).
  const comp = new Array<number>(pts.length).fill(-1);
  let n = 0;
  for (let i = 0; i < pts.length; i++) {
    if (comp[i] !== -1) continue;
    comp[i] = n;
    const stack = [i];
    while (stack.length) {
      const a = stack.pop()!;
      for (let j = 0; j < pts.length; j++) {
        if (comp[j] === -1 && dist(pts[a]!, pts[j]!) <= LINK_M) {
          comp[j] = n;
          stack.push(j);
        }
      }
    }
    n++;
  }

  const bases: Base[] = [];
  for (let c = 0; c < n; c++) {
    const members = pts.filter((_, i) => comp[i] === c);
    const beds = members.filter((m) => m.kind === "bed");
    const stations = members.filter((m) => m.kind === "station");
    const portals = members.filter((m) => m.kind === "portal");
    const labels = members.filter((m) => (m.kind === "portal" || m.kind === "sign") && isHomeLabel(m.text));
    const isBase = beds.length > 0 || labels.length > 0 || stations.length >= 3;
    if (!isBase) continue;
    // Центр — по кроватям и станкам (порталы стоят на краю базы).
    const core = beds.length + stations.length > 0 ? [...beds, ...stations] : members;
    const cx = core.reduce((s, m) => s + m.x, 0) / core.length;
    const cz = core.reduce((s, m) => s + m.z, 0) / core.length;
    const center = { x: cx, z: cz };
    const radius = Math.min(160, Math.max(40, ...members.map((m) => dist(center, m))) + 30);
    const owners = [...new Set(beds.map((b) => b.owner).filter((o): o is string => !!o))];
    const homeLabel = labels[0]?.text?.trim() ?? null;
    const score = beds.length * 5 + stations.length + (homeLabel ? 8 : 0) + Math.min(portals.length, 10) * 0.5;
    bases.push({
      id: c,
      x: Math.round(cx * 10) / 10,
      z: Math.round(cz * 10) / 10,
      name: "",
      isMain: false,
      radius: Math.round(radius),
      beds: beds.length,
      stations: stations.length,
      owners,
      homeLabel,
      score,
      portals: [...new Set(portals.map((p) => p.text?.trim()).filter((t): t is string => !!t))],
    });
  }
  bases.sort((a, b) => b.score - a.score);
  bases.forEach((b, i) => {
    b.isMain = i === 0;
    if (i === 0) b.name = "главный дом";
    else if (b.homeLabel) b.name = `дом «${b.homeLabel}»`;
    else if (b.owners.length) b.name = `база у кровати ${b.owners.join(", ")}`;
    else if (b.portals.length) b.name = `база у портала «${b.portals[0]}»`;
    else b.name = `база №${i + 1}`;
  });
  return bases;
}

/** «Дом» для поиска «у нас дома»: главный дом и базы с кроватью или меткой «дом». */
export function homeBases(bases: Base[]): Base[] {
  return bases.filter((b) => b.isMain || b.beds > 0 || b.homeLabel);
}

export function baseAt(p: Pt, bases: Base[]): Base | null {
  let best: Base | null = null;
  let bestD = Infinity;
  for (const b of bases) {
    const d = dist(p, b);
    if (d <= b.radius && d < bestD) {
      best = b;
      bestD = d;
    }
  }
  return best;
}
