import { Queue } from "bullmq";
import IORedis from "ioredis";
import env from "../config/env";
import logger from "../config/logger";

import type { PushPayload } from "../push/types";

export type PushJob = {
  userIds: string[];
  payload: PushPayload;
  /** Устройства, которым пуш не нужен — например, то, что само приняло или отклонило звонок. */
  excludeDeviceIds?: string[];
};

export type EnqueuePushOptions = {
  excludeDeviceIds?: string[] | undefined;
};

export type LinkPreviewJob = {
  messageId: string;
  conversationId: string;
  url: string;
};

type LinkPreviewEnqueueContext = {
  userId: string;
  conversationId: string;
};

const PREVIEW_ENQUEUE_WINDOW_SEC = 60;
const PREVIEW_ENQUEUE_MAX_PER_USER_CHAT = 12;

let connection: IORedis | null = null;
let linkPreviewQueue: Queue<LinkPreviewJob> | null = null;
let pushQueue: Queue<PushJob> | null = null;

function getConnection(): IORedis {
  if (connection) return connection;
  connection = new IORedis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });
  return connection;
}

export function getLinkPreviewQueue(): Queue<LinkPreviewJob> {
  if (linkPreviewQueue) return linkPreviewQueue;
  linkPreviewQueue = new Queue<LinkPreviewJob>("linkPreview", {
    connection: getConnection(),
    defaultJobOptions: {
      removeOnComplete: true,
      removeOnFail: 1000,
    },
  });
  return linkPreviewQueue;
}

export function getPushQueue(): Queue<PushJob> {
  if (pushQueue) return pushQueue;
  pushQueue = new Queue<PushJob>("push", {
    connection: getConnection(),
    defaultJobOptions: {
      removeOnComplete: true,
      removeOnFail: 500,
      attempts: 3,
      backoff: { type: "exponential", delay: 1000 },
    },
  });
  return pushQueue;
}

/**
 * Поставить пуш в очередь. НИКОГДА не бросает: отправка сообщения не должна падать
 * из-за недоступного Redis или кривого ключа Firebase.
 *
 * dedupeKey защищает от повторов — клиент имеет право переслать тот же запрос (см. ретраи
 * секретных сообщений), и без него человек получил бы два одинаковых уведомления.
 */
export function enqueuePush(
  userIds: string[],
  payload: PushJob["payload"],
  dedupeKey?: string,
  opts?: EnqueuePushOptions,
): void {
  const recipients = Array.from(new Set(userIds.filter(Boolean)));
  if (recipients.length === 0) return;
  const excludeDeviceIds = (opts?.excludeDeviceIds ?? []).filter(Boolean);
  // BullMQ запрещает двоеточие в своём jobId («Custom Id cannot contain :»), делая
  // исключение только для трёх частей — старый формат repeatable-задач. Из-за этого
  // `msg:<id>` (две части) отвергался, а `call:<чат>:<время>` (три) проходил — и пуши
  // о сообщениях молча не ставились в очередь вовсе, на всех платформах. Поэтому
  // разделитель меняем на дефис и в jobId двоеточий не оставляем никогда.
  const jobId = dedupeKey ? dedupeKey.replace(/:/g, "-") : undefined;
  try {
    void getPushQueue()
      .add(
        "push",
        { userIds: recipients, payload, ...(excludeDeviceIds.length ? { excludeDeviceIds } : {}) },
        jobId ? { jobId } : undefined,
      )
      .catch((error) => {
        // Пуш — ускоритель поверх живого сокета, отправку сообщения он ронять не должен.
        // Но и молчать нельзя: именно так эта функция год глотала ошибку BullMQ выше.
        logger.warn({ error, kind: payload.kind, jobId }, "push: failed to enqueue");
      });
  } catch (error) {
    logger.warn({ error, kind: payload.kind, jobId }, "push: failed to enqueue");
  }
}

function sanitizeRateKeyPart(v: string): string {
  return v.replace(/[^a-zA-Z0-9:_-]/g, "_");
}

async function canEnqueueLinkPreview(ctx: LinkPreviewEnqueueContext): Promise<boolean> {
  const redis = getConnection();
  const user = sanitizeRateKeyPart(ctx.userId);
  const conv = sanitizeRateKeyPart(ctx.conversationId);
  const key = `rate:preview-enqueue:u:${user}:c:${conv}`;

  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, PREVIEW_ENQUEUE_WINDOW_SEC);
  }
  return count <= PREVIEW_ENQUEUE_MAX_PER_USER_CHAT;
}

export async function enqueueLinkPreview(
  job: LinkPreviewJob,
  ctx?: LinkPreviewEnqueueContext
): Promise<boolean> {
  if (ctx) {
    const allowed = await canEnqueueLinkPreview(ctx);
    if (!allowed) return false;
  }

  const queue = getLinkPreviewQueue();
  // Deduplicate per messageId (idempotent enqueue).
  await queue.add("linkPreview", job, {
    jobId: job.messageId,
    attempts: 3,
    backoff: { type: "exponential", delay: 1000 },
  });
  return true;
}

export async function getLinkPreviewQueueDepth(): Promise<number> {
  const queue = getLinkPreviewQueue();
  const [waiting, active, delayed] = await Promise.all([
    queue.getWaitingCount(),
    queue.getActiveCount(),
    queue.getDelayedCount(),
  ]);
  return waiting + active + delayed;
}

