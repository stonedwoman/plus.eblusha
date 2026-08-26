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
import { detectFaces } from "./cloud/faces/engine";
import { loadPersonModels, matchPerson } from "./cloud/faces/matching";
import { DERIVED_DIR, objectAbsPath } from "./cloud/paths";

/** Слабые детекции не пишем вовсе: ниже 0.7 в базу лезли облака и узоры,
 * а настоящие лица у SCRFD держатся в районе 0.75–0.9. */
const MIN_SCORE = 0.7;
/** Совсем мелкие лица не несут эмбеддинг-сигнала. */
const MIN_SIDE_PX = 40;

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

  const models = await loadPersonModels(prisma);
  const kept = found.filter((f) => f.score >= MIN_SCORE && f.facePx >= MIN_SIDE_PX);

  await prisma.$transaction(async (tx) => {
    // Пересканирование заменяет ТОЛЬКО непривязанные руками лица: ручную
    // разметку не смеет трогать никакая автоматика.
    await tx.cloudFace.deleteMany({ where: { fileId, NOT: { assignedBy: "user" } } });
    for (const f of kept) {
      const hit = matchPerson(f.embedding, models);
      const personId = hit?.personId ?? null;
      const matchScore = hit?.score ?? null;
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
