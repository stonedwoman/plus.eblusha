import { Queue } from "bullmq";
import IORedis from "ioredis";
import env from "../../config/env";
import logger from "../../config/logger";

/**
 * Очереди Cloud поверх того же Redis, что и у мессенджера (BullMQ уже в стеке).
 * Разделены по стоимости задачи: картинка — секунды, видео — часы, поэтому у
 * них разная concurrency и они не блокируют друг друга.
 */
export const CLOUD_IMAGE_QUEUE = "cloud-media-images";
export const CLOUD_VIDEO_QUEUE = "cloud-media-video";
export const CLOUD_MAINTENANCE_QUEUE = "cloud-maintenance";

export type CloudImageJob = { fileId: string; reason?: string };
export type CloudVideoJob = { fileId: string; reason?: string };
export type CloudMaintenanceJob = { task: "trash-purge" | "upload-gc" | "derived-gc" | "refcount-audit" };

let connection: IORedis | null = null;
const queues = new Map<string, Queue>();

function getConnection(): IORedis {
  if (!connection) {
    connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: true });
  }
  return connection;
}

export function getQueue<T>(name: string): Queue<T> {
  const existing = queues.get(name);
  if (existing) return existing as Queue<T>;
  const q = new Queue<T>(name, {
    connection: getConnection(),
    defaultJobOptions: {
      removeOnComplete: 200,
      removeOnFail: 500,
      attempts: 3,
      backoff: { type: "exponential", delay: 15_000 },
    },
  });
  queues.set(name, q as unknown as Queue);
  return q;
}

/**
 * Идемпотентная постановка: jobId = fileId, повторный вызов не плодит дубли
 * (важно при ретраях finalize и при ручной перегенерации превью).
 */
export async function enqueueImageJob(fileId: string, reason = "upload"): Promise<void> {
  try {
    await getQueue<CloudImageJob>(CLOUD_IMAGE_QUEUE).add("image", { fileId, reason }, { jobId: `img:${fileId}:${reason}` });
  } catch (err) {
    logger.error({ err, fileId }, "cloud: failed to enqueue image job");
  }
}

export async function enqueueVideoJob(fileId: string, reason = "upload"): Promise<void> {
  try {
    await getQueue<CloudVideoJob>(CLOUD_VIDEO_QUEUE).add("video", { fileId, reason }, { jobId: `vid:${fileId}:${reason}` });
  } catch (err) {
    logger.error({ err, fileId }, "cloud: failed to enqueue video job");
  }
}

export async function enqueueMaintenance(task: CloudMaintenanceJob["task"]): Promise<void> {
  try {
    await getQueue<CloudMaintenanceJob>(CLOUD_MAINTENANCE_QUEUE).add("maintenance", { task }, { jobId: `mnt:${task}:${Math.floor(Date.now() / 60000)}` });
  } catch (err) {
    logger.error({ err, task }, "cloud: failed to enqueue maintenance job");
  }
}

export async function queueStats(): Promise<Record<string, { waiting: number; active: number; failed: number; delayed: number }>> {
  const out: Record<string, { waiting: number; active: number; failed: number; delayed: number }> = {};
  for (const name of [CLOUD_IMAGE_QUEUE, CLOUD_VIDEO_QUEUE, CLOUD_MAINTENANCE_QUEUE]) {
    const q = getQueue(name);
    const [waiting, active, failed, delayed] = await Promise.all([
      q.getWaitingCount(),
      q.getActiveCount(),
      q.getFailedCount(),
      q.getDelayedCount(),
    ]);
    out[name] = { waiting, active, failed, delayed };
  }
  return out;
}

export async function failedJobSummaries(limit = 20) {
  const out: { queue: string; id: string; name: string; reason: string; data: unknown; failedAt: number | null }[] = [];
  for (const name of [CLOUD_IMAGE_QUEUE, CLOUD_VIDEO_QUEUE, CLOUD_MAINTENANCE_QUEUE]) {
    const jobs = await getQueue(name).getFailed(0, limit);
    for (const j of jobs) {
      out.push({
        queue: name,
        id: String(j.id),
        name: j.name,
        reason: String(j.failedReason ?? "").slice(0, 500),
        data: j.data,
        failedAt: j.finishedOn ?? null,
      });
    }
  }
  return out.slice(0, limit);
}
