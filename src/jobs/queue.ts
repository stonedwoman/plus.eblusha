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
  /** Отложить отправку (мс) — «хвостовой» пуш read-sync, см. push/readSync.ts. */
  delayMs?: number | undefined;
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
  const delay = opts?.delayMs && opts.delayMs > 0 ? Math.round(opts.delayMs) : 0;
  const jobOpts = jobId || delay ? { ...(jobId ? { jobId } : {}), ...(delay ? { delay } : {}) } : undefined;
  try {
    void getPushQueue()
      .add(
        "push",
        { userIds: recipients, payload, ...(excludeDeviceIds.length ? { excludeDeviceIds } : {}) },
        jobOpts,
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

// ─────────────────────────── Очередь бота «Еблуша» ───────────────────────────
// Контракт задачи — BotJob в src/lib/botContract.ts (его же читает сервис бота bot/src/api/types.ts).
// Кладёт её только конвейер отправки (src/lib/systemBot.ts → dispatchToBot), забирает сервис бота
// (BullMQ Worker на той же очереди). Модель дорогая и не идемпотентная, поэтому attempts: 1 —
// упавшую задачу не повторяем; jobId по id сообщения — повтор той же отправки задачи не задвоит.
export const BOT_QUEUE_NAME = "bot";

let botQueue: Queue | null = null;

export function getBotQueue(): Queue {
  if (botQueue) return botQueue;
  botQueue = new Queue(BOT_QUEUE_NAME, {
    connection: getConnection(),
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: true,
      // В задаче — текст обращения и цепочки: упавшие храним не дольше суток (для разбора), не больше 200.
      removeOnFail: { age: 24 * 3600, count: 200 },
    },
  });
  return botQueue;
}

/**
 * Задача, которая ждёт бота дольше этого, ему уже не нужна (он сам выбрасывает задачи старше
 * BOT_JOB_MAX_AGE_SEC, по умолчанию 10 мин) — а в ней текст обращения и цепочки. Если сервис бота лежит
 * (или ещё не выложен), такие задачи иначе копились бы в Redis (и в его снимках на диске) бессрочно.
 */
export const BOT_JOB_WAIT_MAX_MS = 30 * 60 * 1000;
const BOT_PRUNE_EVERY_MS = 5 * 60 * 1000;
let botPrunedAt = 0;

/** Выбросить из очереди бота задачи, ждущие дольше graceMs. Возвращает, сколько выброшено. */
export async function pruneStaleBotJobs(graceMs: number = BOT_JOB_WAIT_MAX_MS): Promise<number> {
  botPrunedAt = Date.now();
  const removed = await getBotQueue().clean(graceMs, 1000, "wait");
  return removed.length;
}

/**
 * Поставить задачу боту. Бросает — вызывающий (dispatchToBot) ловит и пишет в журнал. jobId — свой у продолжения
 * после «Поделиться» (share-<id>-<n>: исходная задача на тот же вопрос могла ещё не уйти из очереди) и у сигналов.
 */
export async function enqueueBotJob(data: unknown, messageId: string, jobId?: string, name: "message" | "signal" = "message"): Promise<void> {
  // BullMQ запрещает двоеточие в custom jobId (см. enqueuePush).
  await getBotQueue().add(name, data, { jobId: (jobId ?? `msg-${messageId}`).replace(/:/g, "-") });
  // Заодно (не чаще раза в 5 мин) — уборка задач, которых бот так и не взял.
  if (Date.now() - botPrunedAt > BOT_PRUNE_EVERY_MS) {
    void pruneStaleBotJobs().catch(() => undefined);
  }
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


export type ImageThumbJob = {
  /** Ключ ОРИГИНАЛА в хранилище (putKey из upload.ts), не URL и не путь запроса. */
  objectKey: string;
  /** Content-type, как его прислал клиент, — только для журнала. */
  contentType?: string;
  /**
   * Дополнительные AAD-кандидаты для СТАРЫХ объектов EBP1.
   *
   * У новых загрузок AAD записан в сайдкаре — угадывать нечего. А у объектов,
   * залитых до переименования в `.eblusha`, в сайдкаре его нет, и AAD привязан к
   * ПРЕЖНЕМУ ключу (`uploads/<имя>.jpg`, иногда с бакетом впереди). Отдача
   * (routes/files.ts) перебирает ровно те же варианты; воркер, которому передали
   * только ключ объекта, сам их знать не может — поэтому их передаёт тот, кто
   * ставит задачу и видел исходный url.
   */
  aadCandidates?: string[];
};

let imageThumbQueue: Queue<ImageThumbJob> | null = null;

export function getImageThumbQueue(): Queue<ImageThumbJob> {
  if (imageThumbQueue) return imageThumbQueue;
  imageThumbQueue = new Queue<ImageThumbJob>("imageThumb", {
    connection: getConnection(),
    defaultJobOptions: {
      removeOnComplete: true,
      removeOnFail: 500,
    },
  });
  return imageThumbQueue;
}

/**
 * Поставить генерацию превью картинки в очередь.
 *
 * НИКОГДА не бросает и НИЧЕГО не ждёт: отправка фото не должна зависеть ни от Redis,
 * ни от воркера. До этого превью делалось прямо в POST /api/upload — форк ffmpeg
 * с таймаутом 15 с внутри запроса, и человек всё это время смотрел на прогресс.
 * Нет превью — отдача честно вернёт оригинал (см. files.ts), лента не сломается.
 */
export function enqueueImageThumb(job: ImageThumbJob): void {
  const objectKey = String(job?.objectKey ?? "").trim();
  if (!objectKey) return;
  try {
    void getImageThumbQueue()
      .add(
        "imageThumb",
        {
          objectKey,
          ...(job.contentType ? { contentType: job.contentType } : {}),
          ...(job.aadCandidates?.length ? { aadCandidates: job.aadCandidates } : {}),
        },
        {
          // BullMQ запрещает двоеточие в custom jobId (см. историю с пушами выше).
          // Ключ объекта уникален → дубль постановки лишней работы не создаст.
          jobId: objectKey.replace(/:/g, "-"),
          attempts: 3,
          backoff: { type: "exponential", delay: 5000 },
        },
      )
      .catch((error) => {
        logger.warn({ error, objectKey }, "imageThumb: failed to enqueue");
      });
  } catch (error) {
    logger.warn({ error, objectKey }, "imageThumb: failed to enqueue");
  }
}

// ─────────────────────────── Карточки бота: напоминания, сроки, окна ───────────────────────────
// Одна очередь `cards` на все типы карточек (src/lib/botCards.ts, docs/bot-cards.md): таймер обещания
// (напоминания в срок / +15 / +30, авто-закрытие через 6 ч) и «поделиться перепиской» (ожидание выбора 30 мин,
// окно доступа 60 мин), плюс страховочный sweep раз в 5 минут. Воркер — в процессе backend (src/server.ts):
// ему нужен Socket.IO. Отложенные задачи живут в Redis и переживают перезапуск. jobId — без двоеточий.
export const CARDS_QUEUE_NAME = "cards";

export type CardsJob =
  | { kind: "promise.remind"; id: string; deadlineMs: number; offset: number }
  | { kind: "promise.autoclose"; id: string; deadlineMs: number }
  | { kind: "share.pending"; id: string }
  | { kind: "share.end"; id: string; untilMs: number }
  | { kind: "sweep" };

let cardsQueue: Queue<CardsJob> | null = null;

export function getCardsQueue(): Queue<CardsJob> {
  if (cardsQueue) return cardsQueue;
  cardsQueue = new Queue<CardsJob>(CARDS_QUEUE_NAME, {
    connection: getConnection(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 2000 },
      removeOnComplete: true,
      removeOnFail: { age: 7 * 24 * 3600, count: 500 },
    },
  });
  return cardsQueue;
}

/**
 * Ускорение времени очереди карточек в ТЕСТАХ (CARDS_TEST_TIME_SCALE=60 — минута за секунду). В бою не действует:
 * только при NODE_ENV=test.
 */
export function cardsTimeScale(): number {
  if (process.env.NODE_ENV !== "test") return 1;
  const n = Number(process.env.CARDS_TEST_TIME_SCALE ?? "1");
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

/** jobId задачи карточки (без двоеточий; один и тот же для того же шага — повтор постановки не задвоит). */
export function cardsJobId(job: CardsJob): string {
  switch (job.kind) {
    case "promise.remind":
      return `promise-${job.id}-${job.deadlineMs}-${job.offset}`;
    case "promise.autoclose":
      return `promise-${job.id}-${job.deadlineMs}-close`;
    case "share.pending":
      return `share-${job.id}-pending`;
    case "share.end":
      return `share-${job.id}-end-${job.untilMs}`;
    case "sweep":
      return "cards-sweep";
  }
}

/** Поставить задачу карточки на момент atMs. Бросает — вызывающий ловит (sweep догонит потерянное). */
export async function enqueueCardsJob(job: CardsJob, atMs: number, now: number = Date.now()): Promise<void> {
  const delay = Math.max(0, Math.round((atMs - now) / cardsTimeScale()));
  const queue = getCardsQueue();
  const jobId = cardsJobId(job).replace(/:/g, "-");
  // Уже выполненная задача с тем же id удалена (removeOnComplete), ждущая — не задвоится.
  await queue.add(job.kind, job, { jobId, delay });
}

/** Снять ждущую задачу карточки (продление, ручное закрытие). Не бросает. */
export async function removeCardsJob(job: CardsJob): Promise<void> {
  try {
    const j = await getCardsQueue().getJob(cardsJobId(job));
    if (j && (await j.isDelayed())) await j.remove();
  } catch {
    /* задача сама ничего не сделает: проверяет состояние строки */
  }
}
