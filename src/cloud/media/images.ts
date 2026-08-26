import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import exifr from "exifr";
import logger from "../../config/logger";
import cloudConfig from "../config";
import { TMP_DIR } from "../paths";
import { run } from "./exec";

sharp.cache(false);
// 4 ядра на всю машину: не даём libvips сожрать их целиком под превью.
sharp.concurrency(1);
// Защита от «pixel bomb»: картинка 60000x60000 в PNG весит килобайты, а в памяти — гигабайты.
const MAX_PIXELS = 300_000_000;

export type ImageMetadata = {
  width: number | null;
  height: number | null;
  orientation: number | null;
  takenAt: Date | null;
  latitude: number | null;
  longitude: number | null;
  cameraMake: string | null;
  cameraModel: string | null;
  extra: Record<string, unknown>;
};

function cleanString(v: unknown, max = 120): string | null {
  if (typeof v !== "string") return null;
  const s = v.replace(/\0/g, "").trim();
  return s ? s.slice(0, max) : null;
}

function validCoord(v: unknown, limit: number): number | null {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || Math.abs(n) > limit || n === 0) return null;
  return n;
}

/**
 * EXIF читаем ради UX (таймлайн, карта, панель метаданных) и НИКОГДА для
 * решений о доступе: содержимое полностью подконтрольно загрузившему.
 */
export async function readImageMetadata(absolute: string): Promise<ImageMetadata> {
  const out: ImageMetadata = {
    width: null,
    height: null,
    orientation: null,
    takenAt: null,
    latitude: null,
    longitude: null,
    cameraMake: null,
    cameraModel: null,
    extra: {},
  };

  try {
    const meta = await sharp(absolute, { limitInputPixels: MAX_PIXELS }).metadata();
    out.width = meta.width ?? null;
    out.height = meta.height ?? null;
    out.orientation = meta.orientation ?? null;
    if (meta.orientation && meta.orientation >= 5 && out.width && out.height) {
      [out.width, out.height] = [out.height, out.width];
    }
  } catch {
    // HEIC и экзотика — размеры возьмём из ffprobe уровнем выше
  }

  try {
    const exif = (await exifr.parse(absolute, {
      tiff: true,
      exif: true,
      gps: true,
      ifd0: {} as never,
      translateValues: true,
      reviveValues: true,
      sanitize: true,
      mergeOutput: true,
    })) as Record<string, unknown> | undefined;

    if (exif) {
      const taken =
        (exif.DateTimeOriginal as Date | undefined) ??
        (exif.CreateDate as Date | undefined) ??
        (exif.ModifyDate as Date | undefined);
      if (taken instanceof Date && !Number.isNaN(taken.getTime())) {
        const year = taken.getUTCFullYear();
        // Отсекаем мусорные даты (1904, 2145 и прочее из битых камер).
        if (year >= 1970 && year <= new Date().getUTCFullYear() + 1) out.takenAt = taken;
      }
      out.latitude = validCoord(exif.latitude, 90);
      out.longitude = validCoord(exif.longitude, 180);
      out.cameraMake = cleanString(exif.Make);
      out.cameraModel = cleanString(exif.Model);
      if (!out.orientation && typeof exif.Orientation === "number") out.orientation = exif.Orientation;
      if (!out.width && typeof exif.ExifImageWidth === "number") out.width = exif.ExifImageWidth;
      if (!out.height && typeof exif.ExifImageHeight === "number") out.height = exif.ExifImageHeight;

      out.extra = {
        lensModel: cleanString(exif.LensModel),
        fNumber: typeof exif.FNumber === "number" ? exif.FNumber : null,
        exposureTime: typeof exif.ExposureTime === "number" ? exif.ExposureTime : null,
        iso: typeof exif.ISO === "number" ? exif.ISO : null,
        focalLength: typeof exif.FocalLength === "number" ? exif.FocalLength : null,
        software: cleanString(exif.Software),
      };
    }
  } catch {
    // Битый/отсутствующий EXIF — не повод считать файл сломанным
  }

  return out;
}

export type RenditionResult = { path: string; width: number; height: number; size: number; mime: string };

/**
 * Превью в WebP: поддерживается всеми актуальными браузерами, весит заметно
 * меньше JPEG и не требует отдельной AVIF-ветки (кодирование AVIF на 4 ядрах
 * стоило бы слишком дорого).
 */
export async function renderRendition(
  sourceAbs: string,
  targetAbs: string,
  maxSide: number,
  quality: number,
  /** Пользовательский поворот по часовой: 0/90/180/270, поверх EXIF-ориентации. */
  rotation = 0
): Promise<RenditionResult> {
  await fsp.mkdir(path.dirname(targetAbs), { recursive: true });
  let input = sourceAbs;
  let tempDecoded: string | null = null;
  /*
   * Пишем во временный файл и переименовываем: rename в пределах ФС атомарен,
   * и параллельный GET никогда не увидит наполовину записанный webp — при
   * перепечке после поворота старые байты живут до последнего мгновения.
   */
  const tmpTarget = `${targetAbs}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;

  try {
    /*
     * Пользовательский поворот — вторым проходом по уже уменьшенному кадру:
     * в одном конвейере sharp EXIF-нормализация и явный угол вытесняют друг
     * друга. Между проходами — СЫРЫЕ пиксели, не промежуточный JPEG: иначе
     * каждое повёрнутое превью собирало бы лишнее поколение lossy-артефактов.
     * Буфер уже ограничен maxSide, память копеечная.
     */
    const scaled = sharp(input, { limitInputPixels: MAX_PIXELS, failOn: "error" })
      .rotate() // применяет EXIF-ориентацию
      .resize({ width: maxSide, height: maxSide, fit: "inside", withoutEnlargement: true });
    let info;
    if (rotation) {
      const { data, info: ri } = await scaled.raw().toBuffer({ resolveWithObject: true });
      info = await sharp(data, { raw: { width: ri.width, height: ri.height, channels: ri.channels } })
        .rotate(rotation)
        .webp({ quality, effort: 4 })
        .toFile(tmpTarget);
    } else {
      info = await scaled.webp({ quality, effort: 4 }).toFile(tmpTarget);
    }
    await fsp.rename(tmpTarget, targetAbs);
    return { path: targetAbs, width: info.width, height: info.height, size: info.size, mime: "image/webp" };
  } catch (err) {
    await fsp.rm(tmpTarget, { force: true }).catch(() => undefined);
    logger.debug({ err }, "cloud: sharp decode failed, falling back to external decoders");
  }

  // Второй эшелон: HEIC/HEIF и AVIF через libheif. HEIC с современных
  // iPhone часто хранит основной кадр как grid из десятков HEVC-плиток и рядом
  // кладёт auxiliary images (depth/gain maps). ffmpeg 6/7 видит плитки как
  // отдельные video streams и при обычном `-frames:v 1` отдаёт одну плитку или
  // карту глубины. heif-convert понимает связи контейнера и собирает именно
  // primary image целиком; auxiliary-слои без --with-aux он не выбирает.
  tempDecoded = path.join(TMP_DIR, `dec-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
  await fsp.mkdir(TMP_DIR, { recursive: true });
  const heif = await run(
    "heif-convert",
    ["--quiet", "--auto-correct", "--codec-threads", "1", "--tile-threads", "1", sourceAbs, tempDecoded],
    { timeoutMs: cloudConfig.CLOUD_IMAGE_TIMEOUT_MS }
  );
  const heifWroteImage =
    heif.code === 0 &&
    (await fsp
      .stat(tempDecoded)
      .then((stat) => stat.isFile() && stat.size > 0)
      .catch(() => false));

  if (!heifWroteImage) {
    await fsp.rm(tempDecoded, { force: true }).catch(() => undefined);
    logger.debug({ stderr: heif.stderr.slice(-300) }, "cloud: libheif decode failed, falling back to ffmpeg");
    // Третий эшелон для форматов, которые sharp не открыл, но ffmpeg умеет.
    const res = await run(
      "ffmpeg",
      ["-nostdin", "-v", "error", "-y", "-i", sourceAbs, "-frames:v", "1", "-f", "image2", tempDecoded],
      { timeoutMs: cloudConfig.CLOUD_IMAGE_TIMEOUT_MS }
    );
    if (res.code !== 0) {
      await fsp.rm(tempDecoded, { force: true }).catch(() => undefined);
      throw new Error(`image decode failed: ${res.stderr.slice(-300) || heif.stderr.slice(-300)}`);
    }
  }
  input = tempDecoded;
  try {
    const info = await sharp(input, { limitInputPixels: MAX_PIXELS })
      .rotate(rotation || 0)
      .resize({ width: maxSide, height: maxSide, fit: "inside", withoutEnlargement: true })
      .webp({ quality, effort: 4 })
      .toFile(tmpTarget);
    await fsp.rename(tmpTarget, targetAbs);
    return { path: targetAbs, width: info.width, height: info.height, size: info.size, mime: "image/webp" };
  } finally {
    if (tempDecoded) await fsp.rm(tempDecoded, { force: true }).catch(() => undefined);
  }
}

export function tmpWorkPath(prefix: string, ext: string): string {
  const base = `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
  return path.join(TMP_DIR || os.tmpdir(), base);
}
