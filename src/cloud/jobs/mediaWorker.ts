import fsp from "node:fs/promises";
import path from "node:path";
import { Worker } from "bullmq";
import IORedis from "ioredis";
import env from "../../config/env";
import logger from "../../config/logger";
import prisma from "../../lib/prisma";
import cloudConfig from "../config";
import { DERIVED_DIR, derivedRelPath, ensureStorageDirs, objectAbsPath, rmQuiet } from "../paths";
import { emitCloud, spaceRoom } from "../realtime";
import { readImageMetadata, renderRendition } from "../media/images";
import { canDirectPlay, ffprobe } from "../media/probe";
import { renderPlayback, renderPoster } from "../media/video";
import { sniffFile, kindFromMime } from "../media/sniff";
import { fileDto } from "../serialize";
import { CLOUD_IMAGE_QUEUE, CLOUD_VIDEO_QUEUE, type CloudImageJob, type CloudVideoJob } from "./queues";

/**
 * Медиа-конвейер. Джобы идемпотентны: повторный запуск просто перезапишет
 * производные файлы. Оригинал не трогается ни одной строкой этого файла.
 */

function connection(): IORedis {
  return new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
}

async function loadFile(fileId: string) {
  return prisma.cloudFile.findUnique({
    where: { id: fileId },
    include: { storageObject: true, variants: true, uploader: { select: { id: true, username: true, displayName: true, avatarUrl: true } } },
  });
}

async function upsertVariant(
  fileId: string,
  kind: "THUMB" | "PREVIEW" | "POSTER" | "PLAYBACK",
  data: { storagePath?: string; mimeType?: string; size?: number; width?: number | null; height?: number | null; status: "READY" | "FAILED" | "PENDING"; error?: string | null }
) {
  await prisma.cloudFileVariant.upsert({
    where: { fileId_kind: { fileId, kind } },
    create: {
      fileId,
      kind,
      status: data.status,
      storagePath: data.storagePath ?? null,
      mimeType: data.mimeType ?? null,
      size: data.size !== undefined ? BigInt(data.size) : null,
      width: data.width ?? null,
      height: data.height ?? null,
      error: data.error ?? null,
    },
    update: {
      status: data.status,
      storagePath: data.storagePath ?? null,
      mimeType: data.mimeType ?? null,
      size: data.size !== undefined ? BigInt(data.size) : null,
      width: data.width ?? null,
      height: data.height ?? null,
      error: data.error ?? null,
    },
  });
}

async function announce(fileId: string, event: "cloud.file.processing" | "cloud.file.ready" | "cloud.file.updated") {
  const file = await loadFile(fileId);
  if (!file) return;
  await emitCloud(event, [spaceRoom(file.spaceId)], { spaceId: file.spaceId, file: fileDto(file) });
}

async function markFailed(fileId: string, message: string) {
  await prisma.cloudFile.update({
    where: { id: fileId },
    data: { status: "FAILED", processingError: message.slice(0, 400) },
  });
  await announce(fileId, "cloud.file.ready");
}

export async function processImage(fileId: string): Promise<void> {
  const file = await loadFile(fileId);
  if (!file || file.deletedAt) return;
  const source = objectAbsPath(file.storageObject.storagePath);

  const meta = await readImageMetadata(source);
  const update: Record<string, unknown> = {
    width: meta.width,
    height: meta.height,
    orientation: meta.orientation,
    latitude: meta.latitude,
    longitude: meta.longitude,
    cameraMake: meta.cameraMake,
    cameraModel: meta.cameraModel,
    metadata: meta.extra as never,
  };
  // Хронология поездки строится по времени СЪЁМКИ. Перебиваем takenAt только
  // если EXIF реально есть — иначе остаётся mtime клиента / время загрузки.
  if (meta.takenAt) {
    update.takenAt = meta.takenAt;
    update.takenAtSource = "exif";
  }
  await prisma.cloudFile.update({ where: { id: fileId }, data: update as never });

  let failures = 0;
  for (const [kind, maxSide, quality] of [
    ["THUMB", cloudConfig.THUMB_MAX, 72],
    ["PREVIEW", cloudConfig.PREVIEW_MAX, 82],
  ] as const) {
    const rel = derivedRelPath(fileId, `${kind.toLowerCase()}.webp`);
    const abs = path.join(DERIVED_DIR, rel);
    try {
      const res = await renderRendition(source, abs, maxSide, quality);
      await upsertVariant(fileId, kind, {
        storagePath: rel,
        mimeType: res.mime,
        size: res.size,
        width: res.width,
        height: res.height,
        status: "READY",
      });
      // Размеры из реального декода надёжнее EXIF (который врёт при кропах).
      if (kind === "PREVIEW" && !meta.width) {
        const scale = Math.max(res.width, res.height) / Math.min(cloudConfig.PREVIEW_MAX, Math.max(res.width, res.height));
        await prisma.cloudFile.update({
          where: { id: fileId },
          data: { width: Math.round(res.width * scale), height: Math.round(res.height * scale) },
        });
      }
    } catch (err) {
      failures++;
      logger.warn({ err, fileId, kind }, "cloud: rendition failed");
      await upsertVariant(fileId, kind, { status: "FAILED", error: String(err).slice(0, 300) });
    }
  }

  // Даже без превью файл остаётся полноценным: скачать и посмотреть метаданные можно.
  await prisma.cloudFile.update({
    where: { id: fileId },
    data: { status: "READY", processingError: failures === 2 ? "Превью создать не удалось" : null },
  });
  await announce(fileId, "cloud.file.ready");
}

export async function processVideo(fileId: string): Promise<void> {
  const file = await loadFile(fileId);
  if (!file || file.deletedAt) return;
  const source = objectAbsPath(file.storageObject.storagePath);

  const probe = await ffprobe(source);
  const direct = await canDirectPlay(source, probe);
  await prisma.cloudFile.update({
    where: { id: fileId },
    data: {
      width: probe?.width ?? null,
      height: probe?.height ?? null,
      durationMs: probe?.durationMs ?? null,
      videoCodec: probe?.videoCodec ?? null,
      audioCodec: probe?.audioCodec ?? null,
      bitrate: probe?.bitrate ?? null,
      directPlayable: direct,
      ...(pickCreationTime(probe?.tags) ? { takenAt: pickCreationTime(probe?.tags) as Date, takenAtSource: "exif" } : {}),
    },
  });
  await announce(fileId, "cloud.file.processing");

  const posterRel = derivedRelPath(fileId, "poster.jpg");
  const posterAbs = path.join(DERIVED_DIR, posterRel);
  try {
    const poster = await renderPoster(source, posterAbs, probe);
    await upsertVariant(fileId, "POSTER", {
      storagePath: posterRel,
      mimeType: "image/jpeg",
      size: poster.size,
      status: "READY",
    });
    // Постер заодно служит миниатюрой в галерее.
    const thumbRel = derivedRelPath(fileId, "thumb.webp");
    const thumbAbs = path.join(DERIVED_DIR, thumbRel);
    const thumb = await renderRendition(posterAbs, thumbAbs, cloudConfig.THUMB_MAX, 72);
    await upsertVariant(fileId, "THUMB", {
      storagePath: thumbRel,
      mimeType: thumb.mime,
      size: thumb.size,
      width: thumb.width,
      height: thumb.height,
      status: "READY",
    });
  } catch (err) {
    logger.warn({ err, fileId }, "cloud: poster failed");
    await upsertVariant(fileId, "POSTER", { status: "FAILED", error: String(err).slice(0, 300) });
  }

  if (!direct) {
    // Формат браузеру не по зубам (HEVC/ProRes/экзотический контейнер) —
    // делаем ОДНУ универсальную web-версию, а не лестницу разрешений.
    const playRel = derivedRelPath(fileId, "playback.mp4");
    const playAbs = path.join(DERIVED_DIR, playRel);
    await upsertVariant(fileId, "PLAYBACK", { status: "PENDING" });
    try {
      const res = await renderPlayback(source, playAbs, probe);
      await upsertVariant(fileId, "PLAYBACK", {
        storagePath: playRel,
        mimeType: "video/mp4",
        size: res.size,
        width: res.width,
        height: res.height,
        status: "READY",
      });
    } catch (err) {
      logger.error({ err, fileId }, "cloud: playback transcode failed");
      await rmQuiet(playAbs);
      await upsertVariant(fileId, "PLAYBACK", { status: "FAILED", error: String(err).slice(0, 300) });
    }
  }

  await prisma.cloudFile.update({ where: { id: fileId }, data: { status: "READY", processingError: null } });
  await announce(fileId, "cloud.file.ready");
}

function pickCreationTime(tags: Record<string, string> | undefined): Date | null {
  const raw = tags?.creation_time ?? tags?.["com.apple.quicktime.creationdate"];
  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  const year = d.getUTCFullYear();
  if (year < 1970 || year > new Date().getUTCFullYear() + 1) return null;
  return d;
}

/** Прочие типы: определяем реальный mime и закрываем обработку. */
export async function processGeneric(fileId: string): Promise<void> {
  const file = await loadFile(fileId);
  if (!file || file.deletedAt) return;
  const source = objectAbsPath(file.storageObject.storagePath);
  const sniffed = await sniffFile(source);
  await prisma.cloudFile.update({
    where: { id: fileId },
    data: { status: "READY", kind: kindFromMime(sniffed.mime), processingError: null },
  });
  await announce(fileId, "cloud.file.ready");
}

/**
 * Медиа-воркеры (картинки + видео). Живут в отдельном контейнере под
 * НЕпривилегированным пользователем: ffmpeg и libvips разбирают недоверенный
 * контент, и им незачем иметь root и права на удаление оригиналов.
 * Уборкой занимается backend (см. startCloudMaintenance в src/cloud/jobs/maintenance.ts).
 */
export function startCloudMediaWorkers(): Worker[] {
  ensureStorageDirs();
  const workers: Worker[] = [];

  workers.push(
    new Worker<CloudImageJob>(
      CLOUD_IMAGE_QUEUE,
      async (job) => {
        try {
          await processImage(job.data.fileId);
        } catch (err) {
          await markFailed(job.data.fileId, String(err));
          throw err;
        }
      },
      { connection: connection(), concurrency: cloudConfig.CLOUD_IMAGE_CONCURRENCY }
    )
  );

  workers.push(
    new Worker<CloudVideoJob>(
      CLOUD_VIDEO_QUEUE,
      async (job) => {
        try {
          await processVideo(job.data.fileId);
        } catch (err) {
          await markFailed(job.data.fileId, String(err));
          throw err;
        }
      },
      // Сознательно 1: два параллельных x264 на четырёх ядрах кладут и звонки, и чат.
      { connection: connection(), concurrency: cloudConfig.CLOUD_VIDEO_CONCURRENCY }
    )
  );

  for (const w of workers) {
    w.on("failed", (job, err) => {
      logger.error({ queue: w.name, jobId: job?.id, err: String(err).slice(0, 500) }, "cloud media job failed");
    });
  }
  logger.info(
    { image: cloudConfig.CLOUD_IMAGE_CONCURRENCY, video: cloudConfig.CLOUD_VIDEO_CONCURRENCY },
    "Eblusha Cloud media workers started"
  );
  return workers;
}

export async function cleanupTmp(): Promise<void> {
  try {
    const entries = await fsp.readdir(path.join(cloudConfig.CLOUD_STORAGE_ROOT, "tmp"));
    for (const e of entries) {
      const p = path.join(cloudConfig.CLOUD_STORAGE_ROOT, "tmp", e);
      const st = await fsp.stat(p).catch(() => null);
      if (st && Date.now() - st.mtimeMs > 6 * 3600_000) await rmQuiet(p);
    }
  } catch {
    // каталога может не быть — не беда
  }
}
