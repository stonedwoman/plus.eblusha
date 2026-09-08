import { Worker } from "bullmq";
import IORedis from "ioredis";
import env from "../../config/env";
import logger from "../../config/logger";
import { sendPushToUsers } from "../../push";
import type { PushJob } from "../queue";

/**
 * Отправка пушей вынесена в воркер намеренно: HTTP-поход к Google не должен ни задерживать
 * ответ на отправку сообщения, ни ронять его, если Google недоступен.
 */
export function startPushWorker(): Worker<PushJob> {
  const connection = new IORedis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });

  const worker = new Worker<PushJob>(
    "push",
    async (job) => {
      const { userIds, payload, excludeDeviceIds } = job.data;
      const { sent, retryable } = await sendPushToUsers(userIds, payload, { excludeDeviceIds });
      // Лог безусловный: sent===0 — самый ценный для диагностики случай (нет токенов?
      // все отфильтрованы? провайдер молчит?), и раньше он как раз проходил молча.
      logger.info(
        { jobId: job.id, kind: payload.kind, recipients: userIds.length, sent, retryable, attempt: job.attemptsMade + 1 },
        "push processed",
      );
      if (retryable) {
        // Бросаем намеренно: только так BullMQ повторит job по attempts/backoff из очереди
        // (1с, 2с — укладывается в 60-секундный ring-timeout звонка).
        throw new Error("push: transient delivery failure");
      }
      return sent;
    },
    { connection, concurrency: 4 },
  );

  worker.on("failed", (job, error) => {
    logger.warn({ jobId: job?.id, error }, "push job failed");
  });

  return worker;
}
