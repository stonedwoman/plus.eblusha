import fsp from "node:fs/promises";
import path from "node:path";
import { Worker } from "bullmq";
import IORedis from "ioredis";
import env from "../../config/env";
import prisma from "../../lib/prisma";
import logger from "../../config/logger";
import cloudConfig from "../config";
import { DERIVED_DIR, STAGING_DIR, derivedAbsPath, dirSizeBytes, rmQuiet, stagingPath } from "../paths";
import { purgeDerived, purgeObjectIfUnreferenced } from "../storage/objects";
import { CLOUD_MAINTENANCE_QUEUE, type CloudMaintenanceJob } from "./queues";
import { cleanupTmp } from "./mediaWorker";

/**
 * Фоновая уборка. Правило номер один: оригинал удаляется, только если на него
 * не осталось ни одной логической ссылки И истёк retention корзины.
 */

export async function purgeTrash(): Promise<{ files: number; objects: number }> {
  const cutoff = new Date(Date.now() - cloudConfig.CLOUD_TRASH_RETENTION_DAYS * 86400_000);
  const doomed = await prisma.cloudFile.findMany({
    where: { deletedAt: { not: null, lt: cutoff } },
    select: { id: true, storageObjectId: true },
    take: 500,
  });
  let objects = 0;
  for (const file of doomed) {
    await purgeDerived(file.id);
    await prisma.cloudFile.delete({ where: { id: file.id } });
    // refCount пересчитывается внутри: если на объект ссылается другой Space
    // (дедуп или «Сохранить к себе»), физический blob остаётся жить.
    if (await purgeObjectIfUnreferenced(file.storageObjectId)) objects++;
  }
  if (doomed.length) logger.info({ files: doomed.length, objects }, "cloud maintenance: trash purged");
  return { files: doomed.length, objects };
}

export async function gcUploads(): Promise<number> {
  const now = new Date();
  const stale = await prisma.cloudUploadSession.findMany({
    where: {
      expiresAt: { lt: now },
      status: { in: ["CREATED", "UPLOADING", "PAUSED", "FAILED", "CANCELLED"] },
    },
    take: 500,
  });
  for (const s of stale) {
    await rmQuiet(stagingPath(s.uploadProtocolId));
    await prisma.cloudUploadSession.delete({ where: { id: s.id } });
  }

  // Осиротевшие .part без записи в БД (например, после ручного вмешательства).
  try {
    const entries = await fsp.readdir(STAGING_DIR);
    for (const name of entries) {
      if (!name.endsWith(".part")) continue;
      const id = name.slice(0, -5);
      const exists = await prisma.cloudUploadSession.findUnique({ where: { uploadProtocolId: id }, select: { id: true } });
      if (exists) continue;
      const p = path.join(STAGING_DIR, name);
      const st = await fsp.stat(p).catch(() => null);
      if (st && Date.now() - st.mtimeMs > 6 * 3600_000) await rmQuiet(p);
    }
  } catch {
    // каталог может отсутствовать на свежей установке
  }
  if (stale.length) logger.info({ count: stale.length }, "cloud maintenance: stale uploads removed");
  return stale.length;
}

/**
 * Кэш производных: если вылезли за потолок, выбрасываем самые старые по
 * обращению. Файлы остаются целы — превью пересоздадутся по требованию.
 */
export async function gcDerived(): Promise<number> {
  const size = await dirSizeBytes(DERIVED_DIR);
  if (size <= cloudConfig.CLOUD_DERIVED_CACHE_MAX_BYTES) return 0;

  const variants = await prisma.cloudFileVariant.findMany({
    where: { status: "READY", storagePath: { not: null } },
    orderBy: { createdAt: "asc" },
    select: { id: true, fileId: true, kind: true, storagePath: true, size: true },
    take: 5000,
  });
  let freed = 0;
  let removed = 0;
  const target = size - Math.floor(cloudConfig.CLOUD_DERIVED_CACHE_MAX_BYTES * 0.85);
  for (const v of variants) {
    if (freed >= target) break;
    // PLAYBACK убираем в последнюю очередь: его пересоздание — часы CPU.
    if (v.kind === "PLAYBACK") continue;
    if (!v.storagePath) continue;
    await rmQuiet(derivedAbsPath(v.storagePath));
    await prisma.cloudFileVariant.update({ where: { id: v.id }, data: { status: "PENDING", storagePath: null } });
    freed += Number(v.size ?? 0n);
    removed++;
  }
  logger.warn({ freed, removed }, "cloud maintenance: derived cache trimmed");
  return removed;
}

/** Сверка refCount с реальностью — дешёвая страховка от рассинхрона. */
export async function auditRefCounts(): Promise<number> {
  const rows = await prisma.$queryRaw<{ id: string; refCount: number; actual: bigint }[]>`
    SELECT o."id", o."refCount", COUNT(f."id") AS actual
    FROM "CloudStorageObject" o
    LEFT JOIN "CloudFile" f ON f."storageObjectId" = o."id"
    GROUP BY o."id", o."refCount"
    HAVING o."refCount" <> COUNT(f."id")
    LIMIT 1000
  `;
  for (const r of rows) {
    await prisma.cloudStorageObject.update({ where: { id: r.id }, data: { refCount: Number(r.actual) } });
  }
  if (rows.length) logger.warn({ fixed: rows.length }, "cloud maintenance: refCount drift fixed");
  return rows.length;
}

export async function runMaintenanceTask(task: CloudMaintenanceJob["task"]): Promise<unknown> {
  switch (task) {
    case "trash-purge":
      return purgeTrash();
    case "upload-gc":
      return gcUploads();
    case "derived-gc":
      return gcDerived();
    case "refcount-audit":
      return auditRefCounts();
    default:
      return null;
  }
}

export async function runAllMaintenance(): Promise<void> {
  await gcUploads();
  await purgeTrash();
  await auditRefCounts();
  await gcDerived();
  await cleanupTmp();
}

const MAINTENANCE_INTERVAL_MS = 6 * 3600_000;

/**
 * Уборка запускается в процессе backend, а не в медиа-воркере: удаление
 * оригиналов требует прав на запись в objects/, и давать их процессу, который
 * скармливает ffmpeg недоверенные файлы, не нужно.
 */
export function startCloudMaintenance(): Worker {
  const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const worker = new Worker<CloudMaintenanceJob>(
    CLOUD_MAINTENANCE_QUEUE,
    async (job) => runMaintenanceTask(job.data.task),
    { connection, concurrency: 1 }
  );
  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, err: String(err).slice(0, 500) }, "cloud maintenance job failed");
  });

  const tick = () => {
    void runAllMaintenance().catch((err) => logger.error({ err }, "cloud maintenance sweep failed"));
  };
  setTimeout(tick, 120_000).unref?.();
  setInterval(tick, MAINTENANCE_INTERVAL_MS).unref?.();
  logger.info("Eblusha Cloud maintenance scheduler started");
  return worker;
}
