/**
 * Карточка карты для чата: фрагмент карты мира (/map плагина) вокруг игрока/точки, туман
 * войны (/fog — неразведанное притушено), игроки стрелками по повороту, порталы, база,
 * могилы, подписи, масштаб и «С». Оформление — как у сайта koban.uk/v («Борт драккара»):
 * тёмная панель, золотая кайма, светлый текст.
 *
 * Пиксель карты = pixel_size м (12), центр картинки — точка 0,0 мира, север — вверх
 * (та же формула, что у web-src/map.js: imgX = x/12 + 1024, imgY = 1024 − z/12).
 */
import sharp from "sharp";
import type { Pt } from "./geo";
import { plainLabel } from "./names";
import type { Raster } from "./raster";

export interface CardMarker extends Pt {
  kind: "player" | "portal" | "bed" | "tombstone" | "point" | "home" | "ship";
  label?: string;
  yaw?: number | null;
  color?: string;
  dead?: boolean;
  focus?: boolean;
}

export interface CardSpec {
  center: Pt;
  radiusM: number;
  title: string;
  subtitle: string;
  /** Подпись-ссылка в углу: «v.koban.uk/map». */
  link: string;
  markers: CardMarker[];
}

export interface RenderedCard {
  data: Buffer;
  width: number;
  height: number;
  mime: "image/png";
}

const OUT = 720;
const PAD = 16;
const FOOT = 86;
export const CARD_W = OUT + PAD * 2;
export const CARD_H = OUT + PAD + FOOT;

const C = {
  bg: "#07110f",
  panel: "#0f1d1b",
  text: "#ece4d6",
  muted: "#9aa39b",
  accent: "#c8a45a",
  line: "rgba(200,164,90,0.45)",
  portal: "#00e5ff",
  portalText: "#a8f4ff",
  bed: "#81c784",
  grave: "#bdbdbd",
  ship: "#4fc3f7",
  point: "#ffd24d",
  dead: "#e86868",
  ocean: [38, 58, 74] as const,
};

/** Палитра стрелок как у сайта (players.js): 6 цветов по djb2 от имени, при совпадении — следующий свободный. */
export const PLAYER_COLORS = ["#ff9640", "#3fd8ff", "#8df25c", "#ff5fae", "#c29bff", "#ffe304"] as const;
function djb2(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 33) + s.charCodeAt(i)) >>> 0;
  return h;
}
/** Цвета игроков в порядке подключения (как сервер шлёт список). */
export function playerColors(names: string[]): Map<string, string> {
  const taken = new Set<number>();
  const out = new Map<string, string>();
  for (const n of names) {
    let i = djb2(n) % PLAYER_COLORS.length;
    for (let k = 0; k < PLAYER_COLORS.length && taken.has(i); k++) i = (i + 1) % PLAYER_COLORS.length;
    taken.add(i);
    out.set(n, PLAYER_COLORS[i]!);
  }
  return out;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function cropRaster(src: Raster, left: number, top: number, size: number, fill: readonly number[]): Buffer {
  const ch = src.channels;
  const out = Buffer.alloc(size * size * ch);
  if (fill.some((v) => v !== 0)) for (let i = 0; i < size * size; i++) for (let c = 0; c < ch; c++) out[i * ch + c] = fill[c] ?? 255;
  const x0 = Math.max(0, left);
  const x1 = Math.min(src.width, left + size);
  if (x1 <= x0) return out;
  for (let y = 0; y < size; y++) {
    const sy = top + y;
    if (sy < 0 || sy >= src.height) continue;
    src.data.copy(out, (y * size + (x0 - left)) * ch, (sy * src.width + x0) * ch, (sy * src.width + x1) * ch);
  }
  return out;
}

/** Хорошая длина линейки масштаба. */
function niceScale(maxMeters: number): number {
  const steps = [10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000];
  let best = steps[0]!;
  for (const s of steps) if (s <= maxMeters) best = s;
  return best;
}

function fmtMeters(m: number): string {
  return m >= 1000 ? `${String(m / 1000).replace(".", ",")} км` : `${m} м`;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

export async function renderCard(map: Raster, fog: Raster | null, cfg: { texture_size: number; pixel_size: number }, spec: CardSpec): Promise<RenderedCard> {
  if (map.channels !== 4) throw new Error("карта должна быть RGBA");
  const T = cfg.texture_size;
  const ps = cfg.pixel_size;
  // Окно исходной карты в пикселях (не меньше 24 px — дальше смысла увеличивать нет).
  const S = Math.max(24, Math.round((2 * spec.radiusM) / ps));
  const left = Math.round(spec.center.x / ps + T / 2 - S / 2);
  const top = Math.round(T / 2 - spec.center.z / ps - S / 2);
  const k = OUT / S; // экранных пикселей на пиксель карты
  const toScreen = (p: Pt) => ({ X: PAD + (p.x / ps + T / 2 - left) * k, Y: PAD + (T / 2 - p.z / ps - top) * k });
  const pxPerMeter = k / ps;

  // 1. Карта: вырезать, увеличить.
  const crop = cropRaster(map, left, top, S, [...C.ocean, 255]);
  const kernel = S * 3 < OUT ? "mitchell" : "lanczos3";
  const base = await sharp(crop, { raw: { width: S, height: S, channels: 4 } }).resize(OUT, OUT, { kernel }).raw().toBuffer();

  // 2. Туман: неразведанное притушить (не прятать — как карта сайта без тумана, но видно, где были).
  if (fog) {
    const fogCrop = cropRaster(fog, left, top, S, [0]);
    const { data: f, info } = await sharp(fogCrop, { raw: { width: S, height: S, channels: fog.channels } })
      .resize(OUT, OUT, { kernel: "cubic" })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const fc = info.channels;
    for (let i = 0; i < OUT * OUT; i++) {
      const lit = (f[i * fc] ?? 0) / 255;
      const m = 0.4 + 0.6 * lit;
      base[i * 4] = Math.round(base[i * 4]! * m);
      base[i * 4 + 1] = Math.round(base[i * 4 + 1]! * m);
      base[i * 4 + 2] = Math.round(base[i * 4 + 2]! * m);
    }
  }

  // 3. Скруглённые углы.
  const mask = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${OUT}" height="${OUT}"><rect width="${OUT}" height="${OUT}" rx="14" ry="14" fill="#fff"/></svg>`);
  const mapPng = await sharp(base, { raw: { width: OUT, height: OUT, channels: 4 } }).composite([{ input: mask, blend: "dest-in" }]).png().toBuffer();

  // 4. Слой значков и подписей.
  const font = `font-family="DejaVu Sans, Noto Sans, Liberation Sans, Arial, sans-serif"`;
  const shapes: string[] = [];
  const labels: string[] = [];
  const taken: Box[] = [];
  const inside = (X: number, Y: number, m = 0) => X >= PAD - m && X <= PAD + OUT + m && Y >= PAD - m && Y <= PAD + OUT + m;
  const label = (X: number, Y: number, text: string, color: string, size: number, bold = false): void => {
    const t = plainLabel(text).slice(0, 28);
    if (!t) return;
    const w = t.length * size * 0.62 + 4;
    const h = size + 4;
    const tries: Array<[number, number, "start" | "end" | "middle"]> = [
      [X + 15, Y + size * 0.36, "start"],
      [X - 15, Y + size * 0.36, "end"],
      [X, Y - 16, "middle"],
      [X, Y + size + 12, "middle"],
    ];
    for (const [tx, ty, anchor] of tries) {
      const bx = anchor === "start" ? tx : anchor === "end" ? tx - w : tx - w / 2;
      const box = { x: bx, y: ty - size, w, h };
      if (box.x < PAD + 2 || box.x + box.w > PAD + OUT - 2 || box.y < PAD + 2 || box.y + box.h > PAD + OUT - 2) continue;
      if (taken.some((b) => overlaps(b, box))) continue;
      taken.push(box);
      labels.push(
        `<text x="${tx.toFixed(1)}" y="${ty.toFixed(1)}" text-anchor="${anchor}" font-size="${size}"${bold ? ' font-weight="bold"' : ""} fill="${color}" stroke="${C.bg}" stroke-width="3.5" stroke-linejoin="round" paint-order="stroke" ${font}>${esc(t)}</text>`
      );
      return;
    }
  };

  const order: CardMarker["kind"][] = ["bed", "ship", "home", "portal", "tombstone", "point", "player"];
  const sorted = [...clusterPortals(spec.markers, toScreen)].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || Number(!!a.focus) - Number(!!b.focus));
  // Подписи — по важности: в фокусе, игроки, дом, точка, могилы, порталы.
  const labelOrder = [...sorted].sort((a, b) => labelRank(a) - labelRank(b));

  for (const m of sorted) {
    const { X, Y } = toScreen(m);
    if (!inside(X, Y, 6)) continue;
    // значок занимает место — подписи на него не лезут
    taken.push({ x: X - 8, y: Y - 8, w: 16, h: 16 });
    switch (m.kind) {
      case "player": {
        const col = m.color ?? PLAYER_COLORS[0];
        if (m.focus) shapes.push(`<circle cx="${X.toFixed(1)}" cy="${Y.toFixed(1)}" r="17" fill="none" stroke="${col}" stroke-width="2" opacity="0.85"/>`);
        if (m.dead) {
          shapes.push(
            `<g transform="translate(${X.toFixed(1)} ${Y.toFixed(1)})" stroke="${C.bg}" stroke-width="6" stroke-linecap="round"><path d="M-7 -7 L7 7 M7 -7 L-7 7"/></g>`,
            `<g transform="translate(${X.toFixed(1)} ${Y.toFixed(1)})" stroke="${C.dead}" stroke-width="3" stroke-linecap="round"><path d="M-7 -7 L7 7 M7 -7 L-7 7"/></g>`
          );
        } else if (m.yaw !== null && m.yaw !== undefined) {
          shapes.push(
            `<g transform="translate(${X.toFixed(1)} ${Y.toFixed(1)}) rotate(${m.yaw.toFixed(0)})"><path d="M0 -12 L8 9 L0 4.5 L-8 9 Z" fill="${col}" stroke="${C.bg}" stroke-width="2" stroke-linejoin="round"/></g>`
          );
        } else {
          shapes.push(`<circle cx="${X.toFixed(1)}" cy="${Y.toFixed(1)}" r="7" fill="${col}" stroke="${C.bg}" stroke-width="2"/>`);
        }
        break;
      }
      case "portal":
        shapes.push(`<circle cx="${X.toFixed(1)}" cy="${Y.toFixed(1)}" r="6" fill="rgba(0,229,255,0.18)" stroke="${C.portal}" stroke-width="2.5"/>`);
        break;
      case "home":
        shapes.push(
          `<g transform="translate(${X.toFixed(1)} ${Y.toFixed(1)})"><path d="M0 -11 L10 -2 L7 -2 L7 9 L-7 9 L-7 -2 L-10 -2 Z" fill="${C.accent}" stroke="${C.bg}" stroke-width="2" stroke-linejoin="round"/></g>`
        );
        break;
      case "bed":
        shapes.push(`<rect x="${(X - 4).toFixed(1)}" y="${(Y - 3).toFixed(1)}" width="8" height="6" rx="1.5" fill="${C.bed}" stroke="${C.bg}" stroke-width="1.5"/>`);
        break;
      case "tombstone":
        shapes.push(
          `<g transform="translate(${X.toFixed(1)} ${Y.toFixed(1)})"><rect x="-5" y="-8" width="10" height="14" rx="4" fill="${C.grave}" stroke="${C.bg}" stroke-width="1.5"/><path d="M0 -5 L0 3 M-3 -2 L3 -2" stroke="${C.bg}" stroke-width="1.6"/></g>`
        );
        break;
      case "ship":
        shapes.push(`<path d="M${(X - 7).toFixed(1)} ${(Y - 1).toFixed(1)} L${(X + 7).toFixed(1)} ${(Y - 1).toFixed(1)} L${(X + 4).toFixed(1)} ${(Y + 4).toFixed(1)} L${(X - 4).toFixed(1)} ${(Y + 4).toFixed(1)} Z" fill="${C.ship}" stroke="${C.bg}" stroke-width="1.5"/>`);
        break;
      case "point":
        shapes.push(`<path d="M${X.toFixed(1)} ${(Y - 9).toFixed(1)} L${(X + 7).toFixed(1)} ${Y.toFixed(1)} L${X.toFixed(1)} ${(Y + 9).toFixed(1)} L${(X - 7).toFixed(1)} ${Y.toFixed(1)} Z" fill="${C.point}" stroke="${C.bg}" stroke-width="2"/>`);
        break;
    }
  }
  for (const m of labelOrder) {
    if (!m.label) continue;
    const { X, Y } = toScreen(m);
    if (!inside(X, Y)) continue;
    const col =
      m.kind === "player" ? (m.dead ? C.dead : m.color ?? C.text) : m.kind === "portal" ? C.portalText : m.kind === "home" || m.kind === "point" ? C.accent : m.kind === "tombstone" ? C.grave : C.text;
    label(X, Y, m.label, col, m.kind === "player" ? (m.focus ? 17 : 15) : m.kind === "home" ? 15 : 13, m.kind === "player" || m.kind === "home");
  }

  // Масштаб и «С».
  const scaleM = niceScale((OUT * 0.26) / pxPerMeter);
  const scalePx = scaleM * pxPerMeter;
  const sx = PAD + 18;
  const sy = PAD + OUT - 22;
  const deco = [
    `<rect x="${sx - 10}" y="${sy - 22}" width="${(scalePx + 20).toFixed(1)}" height="34" rx="8" fill="rgba(7,17,15,0.72)"/>`,
    `<path d="M${sx} ${sy - 5} L${sx} ${sy} L${(sx + scalePx).toFixed(1)} ${sy} L${(sx + scalePx).toFixed(1)} ${sy - 5}" fill="none" stroke="${C.text}" stroke-width="2"/>`,
    `<text x="${(sx + scalePx / 2).toFixed(1)}" y="${sy - 8}" text-anchor="middle" font-size="13" fill="${C.text}" ${font}>${fmtMeters(scaleM)}</text>`,
    `<g transform="translate(${PAD + OUT - 30} ${PAD + 30})"><circle r="18" fill="rgba(7,17,15,0.72)" stroke="${C.line}" stroke-width="1.2"/><path d="M0 -13 L5 -3 L-5 -3 Z" fill="${C.accent}"/><text y="11" text-anchor="middle" font-size="13" font-weight="bold" fill="${C.text}" ${font}>С</text></g>`,
    `<rect x="${PAD}" y="${PAD}" width="${OUT}" height="${OUT}" rx="14" ry="14" fill="none" stroke="${C.line}" stroke-width="1.5"/>`,
  ];
  const fy = PAD + OUT;
  const foot = [
    `<text x="${PAD + 2}" y="${fy + 36}" font-size="24" font-weight="bold" fill="${C.text}" ${font}>${esc(plainLabel(spec.title).slice(0, 44))}</text>`,
    `<text x="${PAD + 2}" y="${fy + 64}" font-size="16" fill="${C.muted}" ${font}>${esc(plainLabel(spec.subtitle).slice(0, 70))}</text>`,
    `<text x="${CARD_W - PAD - 2}" y="${fy + 36}" text-anchor="end" font-size="16" fill="${C.accent}" ${font}>${esc(spec.link)}</text>`,
    `<text x="${CARD_W - PAD - 2}" y="${fy + 64}" text-anchor="end" font-size="13" fill="${C.muted}" ${font}>Valheim · Koban</text>`,
  ];
  const overlay = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_W}" height="${CARD_H}">${shapes.join("")}${labels.join("")}${deco.join("")}${foot.join("")}</svg>`
  );

  const data = await sharp({ create: { width: CARD_W, height: CARD_H, channels: 4, background: C.bg } })
    .composite([
      { input: mapPng, left: PAD, top: PAD },
      { input: overlay, left: 0, top: 0 },
    ])
    .png({ compressionLevel: 9, palette: true, quality: 92, effort: 8 })
    .toBuffer();
  return { data, width: CARD_W, height: CARD_H, mime: "image/png" };
}

export function ruPlural(n: number, forms: [string, string, string]): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b === 1) return forms[0];
  if (b >= 2 && b <= 4) return forms[1];
  return forms[2];
}

/** Порталы, слипшиеся на картинке (у дома их бывает десяток), — одним кружком «16 порталов». */
function clusterPortals(markers: CardMarker[], toScreen: (p: Pt) => { X: number; Y: number }): CardMarker[] {
  const out: CardMarker[] = markers.filter((m) => m.kind !== "portal");
  const groups: Array<{ X: number; Y: number; members: CardMarker[] }> = [];
  for (const m of markers) {
    if (m.kind !== "portal") continue;
    const s = toScreen(m);
    const g = groups.find((x) => Math.hypot(x.X - s.X, x.Y - s.Y) < 14);
    if (g) g.members.push(m);
    else groups.push({ X: s.X, Y: s.Y, members: [m] });
  }
  for (const g of groups) {
    if (g.members.length === 1) {
      out.push(g.members[0]!);
      continue;
    }
    const n = g.members.length;
    out.push({
      kind: "portal",
      x: g.members.reduce((s, m) => s + m.x, 0) / n,
      z: g.members.reduce((s, m) => s + m.z, 0) / n,
      label: `${n} ${ruPlural(n, ["портал", "портала", "порталов"])}`,
    });
  }
  return out;
}

function labelRank(m: CardMarker): number {
  if (m.focus) return 0;
  if (m.kind === "player") return 1;
  if (m.kind === "home") return 2;
  if (m.kind === "point") return 3;
  if (m.kind === "tombstone") return 4;
  if (m.kind === "portal") return 5;
  return 9;
}
