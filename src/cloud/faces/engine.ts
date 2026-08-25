/**
 * Распознавание лиц — ЦЕЛИКОМ офлайн, на моделях InsightFace buffalo_l:
 * SCRFD (det_10g) находит лица и пять опорных точек, ArcFace (w600k_r50)
 * превращает выровненное лицо 112×112 в 512-мерный эмбеддинг. Никакие
 * снимки наружу не уходят. Модели качаются один раз скриптом
 * `npm run cloud:faces-fetch` в CLOUD_STORAGE_ROOT/models/insightface.
 *
 * onnxruntime-node требует glibc, поэтому живёт в ОТДЕЛЬНОМ контейнере
 * face-worker (Debian), а не в общем alpine-образе.
 */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import cloudConfig from "../config";
import logger from "../../config/logger";

// Динамический require: модуль есть только в face-worker-образе, а этот файл
// компилируется общим tsc. Типы заменены минимальным контрактом.
// eslint-disable-next-line @typescript-eslint/no-var-requires
type OrtTensor = { data: Float32Array; dims: number[] };
type OrtSession = {
  run(feeds: Record<string, unknown>): Promise<Record<string, OrtTensor>>;
  inputNames: string[];
  outputNames: string[];
};
type OrtModule = {
  InferenceSession: { create(p: string, o?: unknown): Promise<OrtSession> };
  Tensor: new (type: string, data: Float32Array, dims: number[]) => unknown;
};

export type DetectedFace = {
  /**
   * Рамка в ДОЛЯХ дисплейного кадра (0..1). Нормируем здесь же, в системе
   * координат УЖЕ повёрнутого по EXIF изображения: снаружи размеры исходника
   * читали бы без поворота, и на боковых снимках рамки съезжали.
   */
  box: { x: number; y: number; w: number; h: number };
  score: number;
  /** L2-нормированный эмбеддинг ArcFace, 512 float32. */
  embedding: Float32Array;
  /** Дисплейные размеры кадра в рабочем масштабе — для фильтра мелких лиц. */
  facePx: number;
};

export function modelsDir(): string {
  return path.join(cloudConfig.CLOUD_STORAGE_ROOT, "models", "insightface");
}

const DET_SIZE = 640;
const DET_THRESHOLD = 0.5;
const NMS_IOU = 0.4;

let ort: OrtModule | null = null;
let detSession: OrtSession | null = null;
let recSession: OrtSession | null = null;

async function ensureSessions(): Promise<boolean> {
  if (detSession && recSession) return true;
  const det = path.join(modelsDir(), "det_10g.onnx");
  const rec = path.join(modelsDir(), "w600k_r50.onnx");
  if (!fs.existsSync(det) || !fs.existsSync(rec)) {
    logger.warn({ dir: modelsDir() }, "faces: модели не найдены — сначала npm run cloud:faces-fetch");
    return false;
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  ort = require("onnxruntime-node") as OrtModule;
  const opts = { interOpNumThreads: 1, intraOpNumThreads: 3 };
  detSession = await ort.InferenceSession.create(det, opts);
  recSession = await ort.InferenceSession.create(rec, opts);
  logger.info("faces: модели загружены (SCRFD det_10g + ArcFace w600k_r50)");
  return true;
}

/** IoU для NMS. */
function iou(a: number[], b: number[]): number {
  const x1 = Math.max(a[0]!, b[0]!);
  const y1 = Math.max(a[1]!, b[1]!);
  const x2 = Math.min(a[2]!, b[2]!);
  const y2 = Math.min(a[3]!, b[3]!);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const areaA = (a[2]! - a[0]!) * (a[3]! - a[1]!);
  const areaB = (b[2]! - b[0]!) * (b[3]! - b[1]!);
  return inter / Math.max(1e-6, areaA + areaB - inter);
}

/**
 * Разбор выходов SCRFD: три страйда (8/16/32), на каждой позиции по два якоря;
 * bbox и точки закодированы расстояниями от центра якоря в единицах страйда.
 */
function decodeScrfd(outputs: Record<string, OrtTensor>, names: string[], scale: number) {
  const strides = [8, 16, 32];
  const found: { box: number[]; score: number; kps: [number, number][] }[] = [];
  for (let i = 0; i < strides.length; i++) {
    const stride = strides[i]!;
    const scores = outputs[names[i]!]!.data;
    const bboxes = outputs[names[i + 3]!]!.data;
    const kpss = outputs[names[i + 6]!]!.data;
    const side = DET_SIZE / stride;
    const anchors = 2;
    for (let p = 0; p < side * side; p++) {
      const cx = (p % side) * stride;
      const cy = Math.floor(p / side) * stride;
      for (let a = 0; a < anchors; a++) {
        const idx = p * anchors + a;
        const score = scores[idx]!;
        if (score < DET_THRESHOLD) continue;
        const bo = idx * 4;
        const box = [
          (cx - bboxes[bo]! * stride) / scale,
          (cy - bboxes[bo + 1]! * stride) / scale,
          (cx + bboxes[bo + 2]! * stride) / scale,
          (cy + bboxes[bo + 3]! * stride) / scale,
        ];
        const ko = idx * 10;
        const kps: [number, number][] = [];
        for (let k = 0; k < 5; k++) {
          kps.push([(cx + kpss[ko + k * 2]! * stride) / scale, (cy + kpss[ko + k * 2 + 1]! * stride) / scale]);
        }
        found.push({ box, score, kps });
      }
    }
  }
  // NMS
  found.sort((m, n) => n.score - m.score);
  const keep: typeof found = [];
  for (const f of found) {
    if (keep.every((k) => iou(k.box, f.box) < NMS_IOU)) keep.push(f);
  }
  return keep;
}

/** Эталонные точки ArcFace для кадра 112×112. */
const ARC_DST: [number, number][] = [
  [38.2946, 51.6963],
  [73.5318, 51.5014],
  [56.0252, 71.7366],
  [41.5493, 92.3655],
  [70.7299, 92.2041],
];

/**
 * Похожесть (умеyama без отражения): наименьшие квадраты для s·R + t по пяти
 * точкам. Возвращает матрицу dst→src — ею семплируем исходник.
 */
function similarityTransform(src: [number, number][], dst: [number, number][]) {
  const n = src.length;
  let mx = 0, my = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    mx += src[i]![0]; my += src[i]![1];
    dx += dst[i]![0]; dy += dst[i]![1];
  }
  mx /= n; my /= n; dx /= n; dy /= n;
  let a = 0, b = 0, varSrc = 0;
  for (let i = 0; i < n; i++) {
    const sx = src[i]![0] - mx, sy = src[i]![1] - my;
    const tx = dst[i]![0] - dx, ty = dst[i]![1] - dy;
    a += sx * tx + sy * ty;
    b += sx * ty - sy * tx;
    varSrc += sx * sx + sy * sy;
  }
  const scale = Math.sqrt(a * a + b * b) / Math.max(1e-6, varSrc);
  const theta = Math.atan2(b, a);
  const cos = Math.cos(theta) * scale;
  const sin = Math.sin(theta) * scale;
  // прямое: dst = M·src; нам нужна обратная (dst→src) для семплирования
  const det = cos * cos + sin * sin;
  const ic = cos / det, is = -sin / det;
  // t прямого
  const tx = dx - (cos * mx - sin * my);
  const ty = dy - (sin * mx + cos * my);
  return (x: number, y: number): [number, number] => {
    const px = x - tx, py = y - ty;
    return [ic * px - is * py, is * px + ic * py];
  };
}

/** Билинейная выборка выровненного лица 112×112 из raw-RGB исходника. */
function warpFace(raw: Buffer, W: number, H: number, kps: [number, number][]): Float32Array {
  const inv = similarityTransform(kps, ARC_DST);
  const out = new Float32Array(3 * 112 * 112);
  const plane = 112 * 112;
  for (let y = 0; y < 112; y++) {
    for (let x = 0; x < 112; x++) {
      const [sx, sy] = inv(x, y);
      let r = 0, g = 0, bl = 0;
      if (sx >= 0 && sy >= 0 && sx < W - 1 && sy < H - 1) {
        const x0 = Math.floor(sx), y0 = Math.floor(sy);
        const fx = sx - x0, fy = sy - y0;
        for (let c = 0; c < 3; c++) {
          const i00 = (y0 * W + x0) * 3 + c;
          const v =
            raw[i00]! * (1 - fx) * (1 - fy) +
            raw[i00 + 3]! * fx * (1 - fy) +
            raw[i00 + W * 3]! * (1 - fx) * fy +
            raw[i00 + W * 3 + 3]! * fx * fy;
          if (c === 0) r = v; else if (c === 1) g = v; else bl = v;
        }
      }
      const o = y * 112 + x;
      out[o] = (r - 127.5) / 127.5;
      out[plane + o] = (g - 127.5) / 127.5;
      out[2 * plane + o] = (bl - 127.5) / 127.5;
    }
  }
  return out;
}

/** Найти лица и посчитать эмбеддинги. На входе — путь к изображению. */
export async function detectFaces(imagePath: string): Promise<DetectedFace[] | null> {
  if (!(await ensureSessions())) return null;
  const img = sharp(imagePath, { limitInputPixels: 300_000_000 }).rotate();
  const meta = await img.metadata();
  const W0 = meta.width ?? 0;
  const H0 = meta.height ?? 0;
  if (!W0 || !H0) return [];

  // Рабочий размер: длинная сторона ≤1600 — детектору хватает, память копеечная.
  const workScale = Math.min(1, 1600 / Math.max(W0, H0));
  const W = Math.max(1, Math.round(W0 * workScale));
  const H = Math.max(1, Math.round(H0 * workScale));
  const raw = await img.resize(W, H).removeAlpha().raw().toBuffer();

  // Леттербокс в 640×640
  const scale = Math.min(DET_SIZE / W, DET_SIZE / H);
  const rw = Math.round(W * scale);
  const rh = Math.round(H * scale);
  const det = new Float32Array(3 * DET_SIZE * DET_SIZE);
  const plane = DET_SIZE * DET_SIZE;
  // билинейный даунскейл в леттербокс
  for (let y = 0; y < rh; y++) {
    const sy = Math.min(H - 1.001, y / scale);
    const y0 = Math.floor(sy);
    const fy = sy - y0;
    for (let x = 0; x < rw; x++) {
      const sx = Math.min(W - 1.001, x / scale);
      const x0 = Math.floor(sx);
      const fx = sx - x0;
      for (let c = 0; c < 3; c++) {
        const i00 = (y0 * W + x0) * 3 + c;
        const v =
          raw[i00]! * (1 - fx) * (1 - fy) +
          raw[i00 + 3]! * fx * (1 - fy) +
          raw[i00 + W * 3]! * (1 - fx) * fy +
          raw[i00 + W * 3 + 3]! * fx * fy;
        det[c * plane + y * DET_SIZE + x] = (v - 127.5) / 128;
      }
    }
  }

  const ortm = ort!;
  const dets = detSession!;
  const feeds: Record<string, unknown> = {};
  feeds[dets.inputNames[0]!] = new ortm.Tensor("float32", det, [1, 3, DET_SIZE, DET_SIZE]);
  const outputs = await dets.run(feeds);
  const faces = decodeScrfd(outputs, dets.outputNames, scale);

  const result: DetectedFace[] = [];
  for (const f of faces.slice(0, 32)) {
    const blob = warpFace(raw, W, H, f.kps);
    const recs = recSession!;
    const rfeeds: Record<string, unknown> = {};
    rfeeds[recs.inputNames[0]!] = new ortm.Tensor("float32", blob, [1, 3, 112, 112]);
    const rout = await recs.run(rfeeds);
    const emb = rout[recs.outputNames[0]!]!.data;
    // L2-нормировка: дальше везде чистый косинус скалярным произведением.
    let norm = 0;
    for (let i = 0; i < emb.length; i++) norm += emb[i]! * emb[i]!;
    norm = Math.sqrt(norm) || 1;
    const unit = new Float32Array(emb.length);
    for (let i = 0; i < emb.length; i++) unit[i] = emb[i]! / norm;
    const bw = f.box[2]! - f.box[0]!;
    const bh = f.box[3]! - f.box[1]!;
    result.push({
      box: {
        x: Math.max(0, Math.min(1, f.box[0]! / W)),
        y: Math.max(0, Math.min(1, f.box[1]! / H)),
        w: Math.min(1, bw / W),
        h: Math.min(1, bh / H),
      },
      score: f.score,
      embedding: unit,
      // в пикселях ПОЛНОГО кадра: рабочий масштаб обратно
      facePx: Math.min(bw, bh) / workScale,
    });
  }
  return result;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}
