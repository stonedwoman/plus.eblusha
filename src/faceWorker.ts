/**
 * Отдельный воркер распознавания лиц (контейнер face-worker, Debian+glibc —
 * требование onnxruntime-node). Слушает очередь cloud-faces: по файлу находит
 * лица, считает эмбеддинги, сохраняет и дотягивает автопривязку к персонам.
 */
import { Worker } from "bullmq";
import IORedis from "ioredis";
import path from "node:path";
import fs from "node:fs";
import env from "./config/env";
import logger from "./config/logger";
import prisma from "./lib/prisma";
import { CLOUD_FACES_QUEUE, type CloudFacesJob } from "./cloud/jobs/queues";
import { detectFaces, cosine } from "./cloud/faces/engine";
import { DERIVED_DIR, objectAbsPath } from "./cloud/paths";

/** Порог автопривязки: косинус к центроиду персоны. ArcFace на своих людях
 * даёт 0.5–0.8, чужие — ниже 0.3; 0.38 — консервативная середина. */
const MATCH_THRESHOLD = Number(process.env.CLOUD_FACE_MATCH ?? 0.38);
/** Слабые детекции не пишем вовсе: ниже 0.7 в базу лезли облака и узоры,
 * а настоящие лица у SCRFD держатся в районе 0.75–0.9. */
const MIN_SCORE = 0.7;
/** Совсем мелкие лица не несут эмбеддинг-сигнала. */
const MIN_SIDE_PX = 40;

type Centroid = { personId: string; vec: Float32Array; count: number };

async function loadCentroids(): Promise<Centroid[]> {
  const faces = await prisma.cloudFace.findMany({
    where: { personId: { not: null } },
    select: { personId: true, embedding: true },
  });
  const acc = new Map<string, { sum: Float64Array; n: number }>();
  for (const f of faces) {
    const v = new Float32Array(f.embedding.buffer, f.embedding.byteOffset, f.embedding.byteLength / 4);
    let slot = acc.get(f.personId!);
    if (!slot) {
      slot = { sum: new Float64Array(v.length), n: 0 };
      acc.set(f.personId!, slot);
    }
    for (let i = 0; i < v.length; i++) slot.sum[i]! += v[i]!;
    slot.n++;
  }
  const out: Centroid[] = [];
  for (const [personId, { sum, n }] of acc) {
    const vec = new Float32Array(sum.length);
    let norm = 0;
    for (let i = 0; i < sum.length; i++) norm += (sum[i]! / n) ** 2;
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < sum.length; i++) vec[i] = sum[i]! / n / norm;
    out.push({ personId, vec, count: n });
  }
  return out;
}

async function processFile(fileId: string): Promise<void> {
  const file = await prisma.cloudFile.findUnique({
    where: { id: fileId },
    include: { storageObject: true, variants: true },
  });
  if (!file || file.deletedAt || file.kind !== "IMAGE") return;

  /*
   * Источник — превью 2048px, если готово: для детекции его хватает с
   * запасом, а декод в разы дешевле оригинала. Рамки нормируются в доли
   * кадра, поэтому от выбора источника не зависят.
   */
  const preview = file.variants.find((v) => v.kind === "PREVIEW" && v.status === "READY" && v.storagePath);
  const source = preview ? path.join(DERIVED_DIR, preview.storagePath!) : objectAbsPath(file.storageObject.storagePath);
  if (!fs.existsSync(source)) return;

  const found = await detectFaces(source);
  if (found === null) throw new Error("модели лиц не установлены (npm run cloud:faces-fetch)");

  const centroids = await loadCentroids();
  const kept = found.filter((f) => f.score >= MIN_SCORE && f.facePx >= MIN_SIDE_PX);

  await prisma.$transaction(async (tx) => {
    // Пересканирование заменяет ТОЛЬКО непривязанные руками лица: ручную
    // разметку не смеет трогать никакая автоматика.
    await tx.cloudFace.deleteMany({ where: { fileId, NOT: { assignedBy: "user" } } });
    for (const f of kept) {
      let personId: string | null = null;
      let matchScore: number | null = null;
      for (const c of centroids) {
        const s = cosine(f.embedding, c.vec);
        if (s >= MATCH_THRESHOLD && (matchScore === null || s > matchScore)) {
          personId = c.personId;
          matchScore = s;
        }
      }
      await tx.cloudFace.create({
        data: {
          fileId,
          x: f.box.x,
          y: f.box.y,
          w: f.box.w,
          h: f.box.h,
          score: f.score,
          embedding: new Uint8Array(new Float32Array(f.embedding).buffer),
          personId,
          assignedBy: personId ? "auto" : null,
          matchScore,
        },
      });
    }
    await tx.cloudFile.update({ where: { id: fileId }, data: { facesScannedAt: new Date() } });
  });
  logger.info({ fileId, faces: kept.length }, "faces: файл просканирован");
}

const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
const worker = new Worker<CloudFacesJob>(
  CLOUD_FACES_QUEUE,
  async (job) => {
    await processFile(job.data.fileId);
  },
  { connection, concurrency: 1 }
);
worker.on("failed", (job, err) => logger.warn({ jobId: job?.id, err: err.message }, "faces: задача упала"));
logger.info("Eblusha Cloud face worker started");
