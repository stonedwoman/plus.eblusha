/**
 * Потребитель очереди BullMQ `bot` (кладёт сервер: src/lib/systemBot.ts → dispatchToBot).
 *
 * Бот больше не сидит в сокете под своей учёткой и не участвует в беседах: каждое обращение к нему
 * приходит отдельной задачей (сообщение + цепочка ответов + разрешение ответить). Очередь живёт в
 * Redis backend (в проде — 127.0.0.1:6379, бот с network_mode: host), поэтому:
 *   - обращения, пришедшие, пока бот перезапускался, дождутся его (старше jobMaxAgeMs — отбрасываем,
 *     ответ на вопрос получасовой давности только запутает);
 *   - задача висит «в работе», пока бот отвечает (обработчик ждёт ответа целиком), BullMQ сам продлевает
 *     замок; упавшую задачу сервер не повторяет (attempts: 1) — модель дорогая и не идемпотентная.
 */
import { Worker, type ConnectionOptions } from "bullmq";
import type { Logger } from "../log";
import { parseBotJob, parseBotSignal, type BotJob, type BotSignal } from "./types";

export interface JobSource {
  /** onSignal — сигналы без разрешения (rev 4: «согласие закончилось — стереть переписку»). */
  start(handler: (job: BotJob) => Promise<void>, onSignal?: (signal: BotSignal) => Promise<void>): void;
  stop(): Promise<void>;
}

/** redis://[:пароль@]хост:порт[/db] → параметры подключения BullMQ (без отдельной зависимости ioredis). */
export function redisConnection(url: string): ConnectionOptions {
  const u = new URL(url);
  if (u.protocol !== "redis:" && u.protocol !== "rediss:") throw new Error(`BOT_REDIS_URL: ждём redis://…, а не ${u.protocol}`);
  const db = u.pathname && u.pathname !== "/" ? Number(u.pathname.slice(1)) : 0;
  if (!Number.isInteger(db) || db < 0) throw new Error("BOT_REDIS_URL: номер базы после / — целое число");
  return {
    host: u.hostname || "127.0.0.1",
    port: u.port ? Number(u.port) : 6379,
    db,
    ...(u.username ? { username: decodeURIComponent(u.username) } : {}),
    ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
    ...(u.protocol === "rediss:" ? { tls: {} } : {}),
    // BullMQ требует для Worker: команды блокирующие, повторы — его забота.
    maxRetriesPerRequest: null,
  };
}

export class BullJobSource implements JobSource {
  private worker: Worker | null = null;

  constructor(
    private readonly opts: { redisUrl: string; queueName: string; concurrency: number },
    private readonly log: Logger
  ) {}

  start(handler: (job: BotJob) => Promise<void>, onSignal?: (signal: BotSignal) => Promise<void>): void {
    const worker = new Worker(
      this.opts.queueName,
      async (job) => {
        const signal = parseBotSignal(job.data);
        if (signal) {
          if (onSignal) await onSignal(signal);
          return;
        }
        const parsed = parseBotJob(job.data);
        if (!parsed) {
          this.log.warn("job.malformed", { jobId: job.id ?? null });
          return;
        }
        await handler(parsed);
      },
      {
        connection: redisConnection(this.opts.redisUrl),
        concurrency: Math.max(1, this.opts.concurrency),
        // Ответ с поиском — минуты; замок продлевается сам, а это — срок, после которого задачу
        // упавшего процесса сочтут «застрявшей».
        lockDuration: 60_000,
        autorun: true,
      }
    );
    worker.on("ready", () => this.log.info("queue.ready", { queue: this.opts.queueName }));
    worker.on("error", (e) => this.log.warn("queue.error", { err: e }));
    worker.on("failed", (job, e) => this.log.warn("queue.job_failed", { jobId: job?.id ?? null, err: e }));
    this.worker = worker;
  }

  async stop(): Promise<void> {
    const w = this.worker;
    this.worker = null;
    // close() дожидается начатых задач — ответы не обрываются на полуслове при SIGTERM.
    await w?.close();
  }
}
