import fs from "node:fs";
import fsp from "node:fs/promises";
import type { Request, Response } from "express";
import logger from "../config/logger";
import cloudConfig from "./config";
import { accelPath } from "./paths";
import { CloudError, notFound } from "./errors";

/**
 * Отдача файлов. Постоянных прямых URL к objects/ не существует: путь на диске
 * известен только серверу, а клиент получает поток только после проверки прав.
 *
 * Большие файлы никогда не поднимаются в память — либо nginx через
 * X-Accel-Redirect (предпочтительно), либо fs.createReadStream с Range.
 */

// Инлайн разрешён только тому, что браузер не может исполнить как код.
// SVG/HTML сюда не входят намеренно: это активный контент.
const INLINE_SAFE = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "audio/mpeg",
  "audio/mp4",
  "audio/ogg",
  "audio/wav",
  "audio/flac",
  "application/pdf",
]);

function contentDisposition(filename: string, forceDownload: boolean, mime: string): string {
  const inline = !forceDownload && INLINE_SAFE.has(mime);
  // RFC 5987: ASCII-фолбэк + UTF-8 вариант, кавычки в имени экранируем.
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export type ServeOptions = {
  mime: string;
  filename: string;
  download?: boolean;
  /** Секунды приватного кэша в браузере (для превью — долго, они иммутабельны). */
  cacheSeconds?: number;
  immutable?: boolean;
};

export async function serveFile(req: Request, res: Response, absolute: string, opts: ServeOptions): Promise<void> {
  const stat = await fsp.stat(absolute).catch(() => null);
  if (!stat || !stat.isFile()) throw notFound("Содержимое недоступно");

  const mime = opts.mime || "application/octet-stream";
  res.setHeader("Content-Type", mime);
  res.setHeader("Content-Disposition", contentDisposition(opts.filename, opts.download === true, mime));
  res.setHeader("X-Content-Type-Options", "nosniff");
  // Даже если сюда как-то попадёт HTML — он не выполнит скрипты и не увидит куки.
  res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'; media-src 'self' blob:; img-src 'self' data:");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Accept-Ranges", "bytes");
  if (opts.cacheSeconds) {
    res.setHeader("Cache-Control", `private, max-age=${opts.cacheSeconds}${opts.immutable ? ", immutable" : ""}`);
  } else {
    res.setHeader("Cache-Control", "private, no-store");
  }

  if (cloudConfig.CLOUD_XACCEL) {
    // nginx сам обработает Range, sendfile и докачку — Node не участвует в передаче байтов.
    res.setHeader("X-Accel-Redirect", accelPath(absolute));
    res.setHeader("X-Accel-Buffering", "no");
    res.status(200).end();
    return;
  }

  await streamWithRange(req, res, absolute, stat.size);
}

/** Ручная реализация Range на случай, когда X-Accel недоступен (dev, прямой доступ). */
export async function streamWithRange(req: Request, res: Response, absolute: string, size: number): Promise<void> {
  const rangeHeader = req.headers.range;
  let start = 0;
  let end = size - 1;
  let partial = false;

  if (typeof rangeHeader === "string" && rangeHeader.startsWith("bytes=")) {
    const spec = rangeHeader.slice(6).split(",")[0]?.trim() ?? "";
    const m = /^(\d*)-(\d*)$/.exec(spec);
    if (!m) {
      res.setHeader("Content-Range", `bytes */${size}`);
      throw new CloudError(416, "RANGE_NOT_SATISFIABLE", "Некорректный Range");
    }
    const [, s, e] = m;
    if (s === "" && e === "") {
      res.setHeader("Content-Range", `bytes */${size}`);
      throw new CloudError(416, "RANGE_NOT_SATISFIABLE", "Некорректный Range");
    }
    if (s === "") {
      const suffix = Number(e);
      start = Math.max(0, size - suffix);
      end = size - 1;
    } else {
      start = Number(s);
      end = e === "" ? size - 1 : Math.min(Number(e), size - 1);
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
      res.setHeader("Content-Range", `bytes */${size}`);
      throw new CloudError(416, "RANGE_NOT_SATISFIABLE", "Range за пределами файла");
    }
    partial = true;
  }

  const length = end - start + 1;
  res.setHeader("Content-Length", String(length));
  if (partial) {
    res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
    res.status(206);
  } else {
    res.status(200);
  }

  if (req.method === "HEAD") {
    res.end();
    return;
  }

  await new Promise<void>((resolve) => {
    const stream = fs.createReadStream(absolute, { start, end, highWaterMark: 1024 * 1024 });
    stream.on("error", (err) => {
      logger.warn({ err }, "cloud: file stream error");
      if (!res.headersSent) res.status(500);
      res.end();
      resolve();
    });
    // Клиент ушёл (закрыл вкладку, перемотал видео) — немедленно освобождаем дескриптор.
    res.on("close", () => stream.destroy());
    stream.on("end", () => resolve());
    stream.pipe(res);
  });
}
