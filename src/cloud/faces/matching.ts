/**
 * Сопоставление лица с персонами. Сеть не дообучается — «обучение» здесь
 * метрическое, двумя путями:
 *
 *  - ЦЕНТРОИД: средний эмбеддинг всех лиц персоны. Каждая новая привязка
 *    (и ручная, и авто) уточняет его.
 *  - ЯКОРЯ: лица, привязанные ЧЕЛОВЕКОМ. Ручная разметка трудного ракурса
 *    (профиль, очки, темнота) почти не двигает центроид из восьмидесяти
 *    обычных лиц — но как якорь сразу начинает узнавать такие же трудные.
 *    Порог якоря строже центроидного: одиночное совпадение обязано быть
 *    увереннее среднего, иначе один случайный кадр уводил бы персону.
 */
import type { PrismaClient, Prisma } from "@prisma/client";

export const CENTROID_MATCH = Number(process.env.CLOUD_FACE_MATCH ?? 0.38);
export const ANCHOR_MATCH = Number(process.env.CLOUD_FACE_ANCHOR ?? 0.45);
/** Якорей на персону: свежие ручные привязки ценнее давних. */
const ANCHOR_CAP = 60;

export type PersonModel = { personId: string; centroid: Float32Array; anchors: Float32Array[] };

const toVec = (b: Uint8Array): Float32Array => new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);

export function cosine(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

type Client = PrismaClient | Prisma.TransactionClient;

export async function loadPersonModels(prisma: Client): Promise<PersonModel[]> {
  const faces = await prisma.cloudFace.findMany({
    where: { personId: { not: null } },
    select: { personId: true, embedding: true, assignedBy: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });
  const acc = new Map<string, { sum: Float64Array; n: number; anchors: Float32Array[] }>();
  for (const f of faces) {
    const v = toVec(f.embedding);
    let slot = acc.get(f.personId!);
    if (!slot) {
      slot = { sum: new Float64Array(v.length), n: 0, anchors: [] };
      acc.set(f.personId!, slot);
    }
    for (let i = 0; i < v.length; i++) slot.sum[i]! += v[i]!;
    slot.n++;
    if (f.assignedBy === "user" && slot.anchors.length < ANCHOR_CAP) slot.anchors.push(v);
  }
  const out: PersonModel[] = [];
  for (const [personId, { sum, n, anchors }] of acc) {
    const centroid = new Float32Array(sum.length);
    let norm = 0;
    for (let i = 0; i < sum.length; i++) norm += (sum[i]! / n) ** 2;
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < sum.length; i++) centroid[i] = sum[i]! / n / norm;
    out.push({ personId, centroid, anchors });
  }
  return out;
}

/** Лучшее совпадение эмбеддинга с персонами; null — никто не дотянул. */
export function matchPerson(
  embedding: Float32Array,
  models: PersonModel[]
): { personId: string; score: number } | null {
  let best: { personId: string; score: number } | null = null;
  for (const m of models) {
    const c = cosine(embedding, m.centroid);
    let s = c >= CENTROID_MATCH ? c : -1;
    for (const a of m.anchors) {
      const av = cosine(embedding, a);
      if (av >= ANCHOR_MATCH && av > s) s = av;
    }
    if (s > 0 && (!best || s > best.score)) best = { personId: m.personId, score: s };
  }
  return best;
}
