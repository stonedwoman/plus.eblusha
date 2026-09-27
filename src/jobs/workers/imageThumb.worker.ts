import { exec } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { promisify } from "node:util";
import { Worker } from "bullmq";
import IORedis from "ioredis";
import env from "../../config/env";
import logger from "../../config/logger";
import prisma from "../../lib/prisma";
import { getStorageProvider } from "../../lib/storage";
import {
  decryptBuffer,
  decryptEbp2WholeFromBuffer,
  encryptBuffer,
  isEbp2Payload,
  isEncryptedPayload,
  parseStorageEncKey,
} from "../../lib/storageEncryption";
import {
  deriveThumbKey,
  renderImageThumb,
  THUMB_MAX_SOURCE_BYTES,
} from "../../lib/imageThumbs";
import type { ImageThumbJob } from "../queue";

/**
 * Превью картинок чата. Живёт в eblusha-worker, а НЕ в обработчике загрузки:
 * раньше отправитель фото ждал форк ffmpeg (таймаут 15 с) прямо внутри POST /api/upload.
 *
 * Что здесь важно:
 *  — оригинал НЕ ТРОГАЕТСЯ ни одной строкой: превью пишется по отдельному ключу рядом;
 *  — работа идемпотентна: превью уже есть → выходим, ничего не перезаписывая;
 *  — секретные чаты (E2EE) не обрабатываются. Признак железный: их объекты лежат
 *    в отдельной таблице secret_attachment_refs. Ключей от E2EE у сервера нет и не будет.
 */

const encKey = env.STORAGE_ENC_KEY ? parseStorageEncKey(env.STORAGE_ENC_KEY) : null;
const execAsync = promisify(exec);

/** Один кадр 5712x4284 — это десятки МБ RSS в sharp. Больше двух разом не берём. */
const CONCURRENCY = Number(process.env.IMAGE_THUMB_CONCURRENCY ?? 2) || 2;

export type SkipReason =
  | "no_enc_key"
  | "secret_attachment"
  | "already_exists"
  | "original_missing"
  | "too_large"
  | "chat_scoped_dek"
  | "not_an_image"
  | "not_smaller";

const skip = (reason: SkipReason, extra?: Record<string, unknown>) => ({ skipped: reason, ...extra });

async function readPlaintext(
  storage: ReturnType<typeof getStorageProvider>,
  objectKey: string,
  meta: Record<string, string>,
  extraAadCandidates: string[] = [],
): Promise<Buffer | null> {
  const got = await storage.getObject(objectKey);
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    got.body.on("data", (c: Buffer | string) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    got.body.on("end", () => resolve());
    got.body.on("error", (e: Error) => reject(e));
  });
  const raw = Buffer.concat(chunks);
  if (raw.length === 0) return null;

  if (isEbp2Payload(raw)) {
    return decryptEbp2WholeFromBuffer(raw, objectKey, encKey!);
  }
  if (isEncryptedPayload(raw)) {
    // AAD. У новых загрузок он записан в сайдкаре — этого достаточно. У объектов,
    // залитых ДО переименования в `.eblusha`, в сайдкаре его нет, и AAD привязан к
    // прежнему ключу (`uploads/<имя>.jpg`, иногда с бакетом впереди). Тот же перебор
    // делает routes/files.ts — иначе эти картинки не открывались бы вовсе.
    const aadFromMeta = String(meta?.aad ?? "").trim();
    const candidates = aadFromMeta
      ? [aadFromMeta, objectKey]
      : Array.from(new Set([objectKey, ...extraAadCandidates.filter(Boolean)]));
    let lastErr: unknown = null;
    for (const aad of candidates) {
      try {
        return decryptBuffer(raw, encKey!, { aad });
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr ?? new Error("EBP1 decrypt failed");
  }
  // Незашифрованный объект (легаси) — отдаём как есть.
  return raw;
}

/**
 * Второй эшелон для форматов, которых не знает libvips. В архиве такой ровно один
 * вид — BMP (sharp его не открывает, ffmpeg открывает), и прежний код на ffmpeg
 * такие картинки превьюшил. Без этого шага новая загрузка BMP осталась бы без
 * превью — то есть стало бы хуже, чем было.
 *
 * Здесь это уместно: воркер, а не HTTP-запрос; временные пути — свои, без
 * пользовательского ввода в командной строке.
 */
async function renderViaFfmpeg(input: Buffer): Promise<Awaited<ReturnType<typeof renderImageThumb>>> {
  const stem = path.join(os.tmpdir(), `ithumb-${crypto.randomBytes(8).toString("hex")}`);
  const inPath = `${stem}.bin`;
  const outPath = `${stem}.png`;
  try {
    await fs.promises.writeFile(inPath, input);
    // Промежуточный размер 1440 по ширине: финальную геометрию и качество всё равно
    // задаёт renderImageThumb, а ffmpeg тут только декодер.
    await execAsync(
      `ffmpeg -y -v error -i "${inPath}" -vf "scale='min(1440,iw)':-2" -frames:v 1 "${outPath}"`,
      { timeout: 30000 },
    );
    const png = await fs.promises.readFile(outPath);
    return await renderImageThumb(png);
  } finally {
    for (const f of [inPath, outPath]) {
      try { await fs.promises.unlink(f); } catch { /* ignore */ }
    }
  }
}

/**
 * Одна единица работы: сделать превью для одного объекта.
 *
 * Вынесена из тела Worker, чтобы догенерация для СТАРЫХ картинок
 * (scripts/backfillChatImageThumbs.ts) шла ровно этим кодом, а не своей копией —
 * разошедшиеся копии формулы ключа как раз и оставили превью недостижимыми.
 * Возвращает либо `{ ok: true, … }`, либо `{ skipped: <причина>, … }`; наружу
 * бросает только настоящую ошибку (I/O, крипто), чтобы BullMQ её ретраил.
 */
export async function processImageThumb(data: ImageThumbJob) {
      const objectKey = String(data?.objectKey ?? "").trim();
      if (!objectKey) return skip("original_missing");
      if (!encKey) return skip("no_enc_key");

      // ⚠️ E2EE. Вложения секретных чатов живут в своей таблице; сервер не имеет
      // и не должен иметь ключей от них. Проверка ДО любого чтения байтов.
      const secretRef = await prisma.secretAttachmentRef.findFirst({
        where: { objectKey },
        select: { id: true },
      });
      if (secretRef) {
        logger.info({ objectKey }, "[imageThumb] секретное вложение — пропущено, E2EE не трогаем");
        return skip("secret_attachment");
      }

      const storage = getStorageProvider();
      const thumbKey = deriveThumbKey(objectKey);

      // Идемпотентность: повторный запуск не делает лишней работы и ничего не перезаписывает.
      const existing = await storage.headObject(thumbKey).catch(() => null);
      if (existing) return skip("already_exists");

      const head = await storage.headObject(objectKey).catch(() => null);
      if (!head) return skip("original_missing");

      const meta = (head.metadata ?? {}) as Record<string, string>;
      if (String(meta.encscope ?? "").toLowerCase() === "chat") {
        // Блобы под ключом беседы (миграционный encscope=chat) — отдельная схема,
        // трогать её ради превью не стоит.
        return skip("chat_scoped_dek");
      }

      const encSize = head.contentLength ?? 0;
      if (encSize > THUMB_MAX_SOURCE_BYTES) return skip("too_large", { bytes: encSize });

      const plain = await readPlaintext(storage, objectKey, meta, data?.aadCandidates ?? []);
      if (!plain || plain.length === 0) return skip("original_missing");

      let rendered: Awaited<ReturnType<typeof renderImageThumb>> = null;
      let via = "sharp";
      try {
        rendered = await renderImageThumb(plain);
      } catch (e) {
        // sharp не знает формат (BMP) — пробуем ffmpeg, как это делал прежний код.
        try {
          rendered = await renderViaFfmpeg(plain);
          via = "ffmpeg";
        } catch (e2) {
          logger.info(
            { objectKey, sharpErr: (e as Error)?.message, ffmpegErr: (e2 as Error)?.message },
            "[imageThumb] не картинка (или битый файл) — пропущено",
          );
          return skip("not_an_image");
        }
      }
      if (!rendered) return skip("not_an_image");

      // У 3 % картинок производная выходит БОЛЬШЕ оригинала (мелкий PNG-скриншот).
      // Писать такую — ухудшать трафик и занимать место зря.
      if (rendered.data.length >= plain.length) {
        return skip("not_smaller", { thumbBytes: rendered.data.length, srcBytes: plain.length });
      }

      // Тип берём у рендера, а не жёстко «image/jpeg»: у картинок с прозрачностью
      // превью остаётся PNG, и отдать его как jpeg значило бы соврать клиенту.
      const thumbContentType = rendered.contentType;
      const enc = encryptBuffer(rendered.data, encKey, { aad: thumbKey, contentType: thumbContentType });
      await storage.putObject(thumbKey, enc.payload, {
        contentType: "application/octet-stream",
        metadata: {
          enc: "ebp1",
          encv: enc.meta.v,
          encalg: enc.meta.alg,
          enciv: enc.meta.iv,
          enctag: enc.meta.tag,
          ct: thumbContentType,
          // AAD пишем в сайдкар явно: тогда превью расшифровывается само по себе, не
          // полагаясь на то, что отдача угадает ключ перебором кандидатов.
          aad: thumbKey,
        },
      });

      logger.info(
        {
          objectKey,
          thumbKey,
          srcBytes: plain.length,
          thumbBytes: rendered.data.length,
          ratio: Number((rendered.data.length / plain.length).toFixed(3)),
          src: `${rendered.srcWidth}x${rendered.srcHeight}`,
          out: `${rendered.width}x${rendered.height}`,
          fmt: rendered.srcFormat,
          outCt: thumbContentType,
          via,
        },
        "[imageThumb] превью готово",
      );

      return {
        ok: true as const,
        objectKey,
        thumbKey,
        srcBytes: plain.length,
        thumbBytes: rendered.data.length,
        width: rendered.width,
        height: rendered.height,
        via,
      };
}

let workerInstance: Worker<ImageThumbJob> | null = null;

export function startImageThumbWorker() {
  if (workerInstance) return workerInstance;

  const connection = new IORedis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });

  workerInstance = new Worker<ImageThumbJob>(
    "imageThumb",
    (job) => processImageThumb(job.data),
    { connection, concurrency: CONCURRENCY },
  );

  workerInstance.on("failed", (job, err) => {
    logger.warn({ objectKey: job?.data?.objectKey, err: err?.message }, "[imageThumb] задача упала");
  });

  return workerInstance;
}
