import { Worker } from "bullmq";
import IORedis from "ioredis";
import env from "../../config/env";
import logger from "../../config/logger";
import { CARDS_QUEUE_NAME, getCardsQueue, type CardsJob } from "../queue";
import { processPromiseAutoclose, processPromiseReminder, sweepPromises } from "../../lib/promiseTimer";
import { processShareEnd, processSharePending, sweepShares } from "../../lib/botShare";

/**
 * Воркер очереди `cards` (карточки бота, docs/bot-cards.md) — в процессе backend (src/server.ts): ему нужен
 * Socket.IO (события карточек и сообщения-напоминания). Задачи проверяют состояние строки под замком — старые
 * задачи после продления/закрытия молча ничего не делают. sweep раз в 5 минут догоняет потерянное.
 */
export const CARDS_SWEEP_EVERY_MS = 5 * 60_000;

export async function processCardsJob(job: CardsJob): Promise<unknown> {
  switch (job.kind) {
    case "promise.remind":
      return processPromiseReminder(job.id, job.deadlineMs, job.offset);
    case "promise.autoclose":
      return processPromiseAutoclose(job.id, job.deadlineMs);
    case "share.pending":
      return processSharePending(job.id);
    case "share.end":
      return processShareEnd(job.id, job.untilMs);
    case "sweep": {
      const p = await sweepPromises();
      const s = await sweepShares();
      if (p.reminded || p.closed || s.expired || s.ended) logger.info({ ...p, ...s }, "cards: sweep");
      return { ...p, ...s };
    }
  }
}

export function startCardsWorker(): Worker<CardsJob> {
  const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: true });
  const worker = new Worker<CardsJob>(CARDS_QUEUE_NAME, async (job) => processCardsJob(job.data), { connection, concurrency: 4 });
  worker.on("failed", (job, error) => logger.warn({ jobId: job?.id ?? null, kind: job?.data?.kind, error }, "cards: job failed"));
  worker.on("error", (error) => logger.warn({ error }, "cards: worker error"));
  // Страховочный обход: один на кластер (id расписания постоянный).
  void getCardsQueue()
    .upsertJobScheduler("cards-sweep", { every: CARDS_SWEEP_EVERY_MS }, { name: "sweep", data: { kind: "sweep" } })
    .catch((error: unknown) => logger.warn({ error }, "cards: sweep scheduler failed"));
  logger.info("cards: worker started");
  return worker;
}
