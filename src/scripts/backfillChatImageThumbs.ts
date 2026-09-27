/**
 * Догенерация превью для СТАРЫХ картинок чата.
 *
 * Превью в чате начали делать 1 августа 2026 — всё, что залито раньше, его не имеет
 * и никогда не имело. Этот скрипт добирает архив, ничего не удаляя и не перезаписывая.
 *
 * ЧТО ГАРАНТИРУЕТСЯ
 *  1. Оригинал не трогается ни одной строкой: превью пишется по ДЕРИВАТИВНОМУ ключу
 *     рядом (`…/x.eblusha` → `…/x.thumb.eblusha`). Ни записи, ни удаления по ключу
 *     оригинала здесь нет.
 *  2. Работа прерываемая и повторяемая: курсор и счётчики лежат в Redis, а сама
 *     единица работы идемпотентна (превью уже есть → `already_exists`, ноль записи).
 *     Прервать можно в любой момент — следующий запуск продолжит с того же места и
 *     лишней работы не сделает.
 *  3. Нагрузка ограничена: строго по одному объекту за раз, пауза между объектами и
 *     уступка живой очереди — если кто-то прямо сейчас отправил фото, его превью
 *     делается первым, а догенерация ждёт.
 *  4. ⚠️ ВЛОЖЕНИЯ СЕКРЕТНЫХ ЧАТОВ (E2EE) НЕ ОБРАБАТЫВАЮТСЯ. Ключей от них у сервера
 *     нет и быть не должно. Отличаются они железно, тремя независимыми признаками —
 *     preflight() ниже проверяет все три и ОТКАЗЫВАЕТСЯ работать, если хоть один
 *     перестал держать. Плюс сама единица работы ещё раз сверяется с
 *     secret_attachment_refs до чтения любых байтов.
 *
 * ЗАПУСК — в контейнере eblusha-worker: там смонтирован том хранилища и есть
 * STORAGE_ENC_KEY, sharp и ffmpeg. Бэкенд при этом не нагружается вовсе.
 *
 *   # что вообще есть в архиве, без единой записи
 *   docker exec eblusha-worker node dist/scripts/backfillChatImageThumbs.js --dry-run
 *
 *   # пилот на десятке перечисленных ключей
 *   docker exec eblusha-worker node dist/scripts/backfillChatImageThumbs.js \
 *     --keys-file /var/lib/eblusha/storage/.pilot-keys.txt --jsonl
 *
 *   # всё остальное
 *   docker exec eblusha-worker node dist/scripts/backfillChatImageThumbs.js --jsonl
 *
 * ФЛАГИ
 *   --dry-run         ничего не писать: только разрешить ключи и посчитать, что было бы
 *   --limit N         сделать не больше N превью и остановиться
 *   --delay MS        пауза между вложениями, по умолчанию 200
 *   --keys-file PATH  взять ТОЛЬКО ключи из файла (по одному в строке) — для пилота
 *   --ids a,b,c       взять только эти MessageAttachment.id
 *   --restart         забыть курсор и счётчики прошлого прогона
 *   --no-yield        не уступать живой очереди новых загрузок
 *   --journal PATH    писать по строке JSON на вложение в файл (пишется синхронно,
 *                     не теряется при обрыве — это и есть журнал прогона)
 *   --jsonl           те же строки в stdout (удобно, но при обрыве хвост может пропасть)
 */
import fs from "node:fs";
import env from "../config/env";
import logger from "../config/logger";
import prisma from "../lib/prisma";
import { getStorageProvider } from "../lib/storage";
import { deriveThumbKey } from "../lib/imageThumbs";
import { expandCandidateKeys, requestPathFromMediaUrl } from "../lib/storageKeys";
import { processImageThumb } from "../jobs/workers/imageThumb.worker";
import { getImageThumbQueue } from "../jobs/queue";
import { createDedicatedRedisClient } from "../lib/redis";

const hasFlag = (f: string) => process.argv.includes(f);
const getArg = (n: string) => {
  const i = process.argv.indexOf(n);
  return i === -1 ? null : (process.argv[i + 1] ?? null);
};

const dryRun = hasFlag("--dry-run");
const limit = Number(getArg("--limit") ?? "0") || 0;
const delayMs = Math.max(0, Number(getArg("--delay") ?? "200") || 0);
const keysFile = getArg("--keys-file");
const onlyIds = (getArg("--ids") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const restart = hasFlag("--restart");
const yieldToLive = !hasFlag("--no-yield");
const jsonl = hasFlag("--jsonl");
const journalPath = getArg("--journal");

const PAGE = 200;
const STATE_PREFIX = "backfill:chatImageThumbs";
const CURSOR_KEY = `${STATE_PREFIX}:cursor`;
const TALLY_KEY = `${STATE_PREFIX}:tally`;
const BYTES_KEY = `${STATE_PREFIX}:bytes`;

const objectPrefix = env.STORAGE_PREFIX.replace(/^\/|\/$/g, "");
/** Ровно как в routes/files.ts: на локальном бэкенде бакета в ключах нет. */
const bucketForKeys = env.STORAGE_BACKEND === "local" ? null : (env.STORAGE_S3_BUCKET ?? null);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const kb = (n: number) => `${(n / 1024).toFixed(1)} КБ`;
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} МБ`;

const tally: Record<string, number> = {};

/**
 * ⚠️ E2EE. Три независимых признака, по которым вложения секретных чатов отделяются от
 * обычных. Если хоть один перестал держать — НЕ РАБОТАЕМ: лучше остановиться и сказать,
 * чем угадывать про чужие ключи.
 */
async function preflight(): Promise<{ secretRefs: number }> {
  const secretRefs = await prisma.secretAttachmentRef.count();

  // (1) ни одна картинка чата не висит в секретной беседе
  const inSecretConversation = await prisma.messageAttachment.count({
    where: { type: "IMAGE", message: { conversation: { isSecret: true } } },
  });

  // (2) ни один ключ из secret_attachment_refs не встречается в url вложения чата
  const secretKeys = await prisma.secretAttachmentRef.findMany({ select: { objectKey: true } });
  let overlap = 0;
  for (const { objectKey } of secretKeys) {
    if (!objectKey) continue;
    overlap += await prisma.messageAttachment.count({ where: { url: { contains: objectKey } } });
  }

  // (3) ни одно вложение чата не помечено как шифротекст E2EE
  const markedRows = await prisma.$queryRaw<Array<{ n: bigint }>>`
    select count(*)::bigint as n from "MessageAttachment"
     where metadata::text ilike '%ciphertext%' or metadata::text ilike '%e2ee%'`;
  const marked = Number(markedRows[0]?.n ?? 0);

  logger.info(
    { secretRefs, inSecretConversation, keyOverlap: overlap, ciphertextMarked: marked },
    "[backfill-thumb] preflight: отделение секретных вложений",
  );

  if (inSecretConversation > 0 || overlap > 0 || marked > 0) {
    throw new Error(
      "ОСТАНОВ: среди вложений чата нашлись признаки секретных " +
        `(в секретных беседах: ${inSecretConversation}, пересечение ключей: ${overlap}, ` +
        `помечено как шифротекст: ${marked}). Догенерация не запускается — E2EE не трогаем.`,
    );
  }
  return { secretRefs };
}

/** Живая очередь новых загрузок идёт первой: человек ждёт своё фото сейчас. */
async function waitForLiveQueue(): Promise<void> {
  if (!yieldToLive) return;
  for (let i = 0; i < 120; i++) {
    let depth = 0;
    try {
      const q = getImageThumbQueue();
      const [waiting, active] = await Promise.all([q.getWaitingCount(), q.getActiveCount()]);
      depth = waiting + active;
    } catch {
      return; // очередь недоступна — не повод останавливать догенерацию
    }
    if (depth === 0) return;
    if (i === 0) logger.info({ depth }, "[backfill-thumb] уступаю живой очереди загрузок");
    await sleep(1000);
  }
}

type Row = { id: string; url: string; createdAt: Date; metadata: unknown };

type Resolved = {
  /** Найденный в хранилище ключ оригинала, либо null — файл потерян. */
  key: string | null;
  /** Кандидаты, которые перебирает САМА ОТДАЧА /api/files (только из пути запроса). */
  proxyCandidates: string[];
  /** Всё, что пробовали (плюс metadata.objectKey). */
  tried: string[];
};

/**
 * Ключ ОРИГИНАЛА — ровно тот, который найдёт /api/files: кандидаты строятся тем же
 * кодом (lib/storageKeys), поэтому превью ляжет туда, где отдача его ищет. Ниже это
 * ещё и проверяется утверждением, а не надеждой.
 */
async function resolveOriginalKey(
  storage: ReturnType<typeof getStorageProvider>,
  row: Row,
): Promise<Resolved> {
  const requestPath = requestPathFromMediaUrl(row.url);
  const proxyCandidates = requestPath
    ? expandCandidateKeys(requestPath, bucketForKeys, objectPrefix)
    : [];

  const tried = [...proxyCandidates];
  // metadata.objectKey — авторитетный ключ у новых строк; пробуем его первым.
  const metaKey = (row.metadata as Record<string, unknown> | null)?.objectKey;
  if (typeof metaKey === "string" && metaKey.trim()) {
    const k = metaKey.trim().replace(/^\//, "");
    if (!tried.includes(k)) tried.unshift(k);
  }

  for (const key of tried) {
    const head = await storage.headObject(key).catch(() => null);
    if (head) return { key, proxyCandidates, tried };
  }
  return { key: null, proxyCandidates, tried };
}

async function main() {
  const startedAt = Date.now();
  const { secretRefs } = await preflight();

  const storage = getStorageProvider();
  const redis = await createDedicatedRedisClient();

  if (restart) {
    for (const k of [CURSOR_KEY, TALLY_KEY, BYTES_KEY]) await redis.del(k);
    logger.info("[backfill-thumb] состояние прошлого прогона сброшено (--restart)");
  }

  const allowKeys = keysFile
    ? new Set(
        fs
          .readFileSync(keysFile, "utf8")
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean),
      )
    : null;

  // Курсор — состояние НАСТОЯЩЕЙ работы. Сухой прогон и прогон по списку его не читают
  // и не двигают: иначе «посмотреть, что будет» съедало бы место в очереди работы.
  const scoped = Boolean(allowKeys) || onlyIds.length > 0 || dryRun;
  let cursor: string | null = scoped ? null : await redis.get(CURSOR_KEY);
  if (cursor) logger.info({ cursor }, "[backfill-thumb] продолжаю с сохранённого курсора");

  let made = 0;
  let seen = 0;
  let srcBytesTotal = 0;
  let thumbBytesTotal = 0;
  let stopped = false;

  // SIGINT/SIGTERM: доделать текущее вложение и выйти чисто — курсор уже сохранён.
  const onSignal = (sig: string) => {
    logger.warn({ sig }, "[backfill-thumb] остановка по сигналу — доделываю текущее вложение");
    stopped = true;
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));

  logger.info(
    { dryRun, limit, delayMs, keysFile, journalPath, ids: onlyIds.length, yieldToLive, secretRefs },
    "[backfill-thumb] СТАРТ",
  );

  const record = async (row: Row, reason: string, extra?: Record<string, unknown>) => {
    tally[reason] = (tally[reason] ?? 0) + 1;
    // В Redis накапливаем только итог ОСНОВНОГО прогона: сухие и пилотные прогоны
    // не должны подмешиваться в цифры, по которым потом принимают работу.
    if (!scoped) await redis.hIncrBy(TALLY_KEY, reason, 1);
    if (!jsonl && !journalPath) return;
    const line = `${JSON.stringify({ id: row.id, at: row.createdAt, reason, ...extra })}\n`;
    // В файл — синхронно: журнал не должен терять хвост, если прогон прервали.
    // stdout через docker exec — это труба, и запись в неё асинхронна.
    if (journalPath) fs.appendFileSync(journalPath, line);
    if (jsonl) process.stdout.write(line);
  };

  outer: while (!stopped) {
    const batch: Row[] = await prisma.messageAttachment.findMany({
      where: { type: "IMAGE", ...(onlyIds.length ? { id: { in: onlyIds } } : {}) },
      select: { id: true, url: true, createdAt: true, metadata: true },
      orderBy: { id: "asc" },
      take: PAGE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (batch.length === 0) break;
    cursor = batch[batch.length - 1]?.id ?? null;

    for (const row of batch) {
      if (stopped) break outer;
      if (limit && made >= limit) break outer;

      const resolved = await resolveOriginalKey(storage, row);

      // Пилот по списку ключей: всё остальное молча мимо, чтобы не пачкать журнал.
      if (allowKeys && (!resolved.key || !allowKeys.has(resolved.key))) continue;

      seen++;
      if (!scoped) await redis.set(CURSOR_KEY, row.id);

      if (!resolved.key) {
        // Потерянный файл: строка в базе есть, объекта в хранилище нет — клиент видит
        // на этом месте 404. Не чиним, считаем и докладываем.
        await record(row, "original_missing", { url: row.url, tried: resolved.tried });
        continue;
      }

      const objectKey = resolved.key;
      const thumbKey = deriveThumbKey(objectKey);

      // Утверждение, а не надежда: ключ превью ОБЯЗАН попадать в набор, который
      // перебирает отдача по пути запроса. Иначе работа уйдёт впустую — и узнать об
      // этом надо сейчас, а не после 500 картинок.
      if (!resolved.proxyCandidates.map(deriveThumbKey).includes(thumbKey)) {
        await record(row, "unreachable_thumb_key", { objectKey, thumbKey, tried: resolved.tried });
        logger.error(
          { objectKey, thumbKey, proxyCandidates: resolved.proxyCandidates },
          "[backfill-thumb] ключ превью не в наборе отдачи — превью было бы недостижимо",
        );
        continue;
      }

      if (dryRun) {
        const exists = await storage.headObject(thumbKey).catch(() => null);
        await record(row, exists ? "already_exists" : "would_make", { objectKey, thumbKey });
        if (!exists) made++; // для --limit в сухом прогоне
        continue;
      }

      await waitForLiveQueue();

      try {
        // aadCandidates: у объектов, залитых до переименования в `.eblusha`, AAD в
        // сайдкаре не записан и привязан к ПРЕЖНЕМУ ключу. Отдача перебирает ровно
        // этот набор — передаём его и воркеру, иначе старое фото не расшифровать.
        const out = (await processImageThumb({
          objectKey,
          aadCandidates: resolved.proxyCandidates,
        })) as {
          ok?: true;
          skipped?: string;
          srcBytes?: number;
          thumbBytes?: number;
          via?: string;
          width?: number;
          height?: number;
        };
        if (out?.ok) {
          made++;
          srcBytesTotal += out.srcBytes ?? 0;
          thumbBytesTotal += out.thumbBytes ?? 0;
          if (!scoped) {
            await redis.hIncrBy(BYTES_KEY, "src", out.srcBytes ?? 0);
            await redis.hIncrBy(BYTES_KEY, "thumb", out.thumbBytes ?? 0);
          }
          await record(row, "made", {
            objectKey,
            thumbKey,
            srcBytes: out.srcBytes,
            thumbBytes: out.thumbBytes,
            size: `${out.width}x${out.height}`,
            via: out.via,
          });
        } else {
          await record(row, out?.skipped ?? "skipped_unknown", { objectKey });
        }
      } catch (e) {
        await record(row, "failed", { objectKey, err: (e as Error)?.message });
        logger.warn(
          { objectKey, err: (e as Error)?.message },
          "[backfill-thumb] упало (не фатально, вложение пропущено)",
        );
      }

      if (seen % 25 === 0) logger.info({ seen, made, tally }, "[backfill-thumb] идём");
      if (delayMs) await sleep(delayMs);
    }
    if (onlyIds.length) break;
  }

  const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
  logger.info(
    {
      dryRun,
      seen,
      made,
      tally,
      srcBytes: srcBytesTotal,
      thumbBytes: thumbBytesTotal,
      ratio: srcBytesTotal ? Number((thumbBytesTotal / srcBytesTotal).toFixed(4)) : null,
      elapsedSec,
      stoppedBySignal: stopped,
    },
    "[backfill-thumb] ИТОГ",
  );

  // Ровная таблица для отчёта.
  const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - s.length));
  const rows = Object.entries(tally).sort((a, b) => b[1] - a[1]);
  process.stdout.write(`\n${pad("причина", 24)}количество\n${"-".repeat(38)}\n`);
  for (const [k, v] of rows) process.stdout.write(`${pad(k, 24)}${String(v)}\n`);
  process.stdout.write(`${"-".repeat(38)}\n${pad("просмотрено", 24)}${String(seen)}\n`);
  if (made && !dryRun) {
    process.stdout.write(
      `${pad("сделано превью", 24)}${String(made)}\n` +
        `${pad("оригиналы", 24)}${mb(srcBytesTotal)}\n` +
        `${pad("превью", 24)}${mb(thumbBytesTotal)}\n` +
        `${pad("среднее превью", 24)}${kb(thumbBytesTotal / made)}\n` +
        `${pad("доля от оригинала", 24)}${((thumbBytesTotal / (srcBytesTotal || 1)) * 100).toFixed(1)} %\n`,
    );
  }

  if (journalPath) process.stdout.write(`журнал: ${journalPath}\n`);

  await redis.quit().catch(() => undefined);
  await prisma.$disconnect().catch(() => undefined);
}

main()
  .then(() => {
    // Не process.exit() сразу: stdout через трубу пишется асинхронно, и мгновенный
    // выход обрезает хвост вывода. Даём событийному циклу опустеть, а страховочный
    // таймер (unref — сам цикл не держит) добивает процесс, если что-то повисло.
    const t = setTimeout(() => process.exit(0), 5000);
    t.unref();
  })
  .catch((e) => {
    logger.error({ err: (e as Error)?.message ?? e }, "[backfill-thumb] ФАТАЛЬНО");
    process.exitCode = 1;
    const t = setTimeout(() => process.exit(1), 5000);
    t.unref();
  });
