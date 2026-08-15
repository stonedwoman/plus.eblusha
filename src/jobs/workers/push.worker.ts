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
      const { userIds, payload } = job.data;
      const sent = await sendPushToUsers(userIds, payload);
      if (sent > 0) {
        logger.debug({ kind: payload.kind, sent }, "push delivered");
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
