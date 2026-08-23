import fsp from "node:fs/promises";

/**
 * Определение реального типа файла по сигнатуре. Client-provided Content-Type
 * не является источником истины — им можно объявить .exe картинкой.
 */
export type SniffResult = { mime: string; ext: string };

const ftypBrandMime: Record<string, string> = {
  heic: "image/heic",
  heix: "image/heic",
  hevc: "image/heic",
  heim: "image/heic",
  heis: "image/heic",
  hevm: "image/heic",
  hevs: "image/heic",
  mif1: "image/heif",
  msf1: "image/heif",
  avif: "image/avif",
  avis: "image/avif",
  qt: "video/quicktime",
  M4V: "video/x-m4v",
  M4A: "audio/mp4",
  "3gp": "video/3gpp",
};

function ascii(buf: Buffer, start: number, len: number): string {
  return buf.subarray(start, start + len).toString("latin1");
}

export async function sniffFile(absolute: string): Promise<SniffResult> {
  let fh;
  try {
    fh = await fsp.open(absolute, "r");
    const buf = Buffer.alloc(4096);
    const { bytesRead } = await fh.read(buf, 0, 4096, 0);
    return sniffBuffer(buf.subarray(0, bytesRead));
  } catch {
    return { mime: "application/octet-stream", ext: "bin" };
  } finally {
    await fh?.close().catch(() => undefined);
  }
}

export function sniffBuffer(b: Buffer): SniffResult {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: "image/jpeg", ext: "jpg" };
  if (b.length >= 8 && ascii(b, 0, 8) === "\x89PNG\r\n\x1a\n") return { mime: "image/png", ext: "png" };
  if (b.length >= 6 && (ascii(b, 0, 6) === "GIF87a" || ascii(b, 0, 6) === "GIF89a")) return { mime: "image/gif", ext: "gif" };
  if (b.length >= 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") return { mime: "image/webp", ext: "webp" };
  if (b.length >= 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "AVI ") return { mime: "video/x-msvideo", ext: "avi" };
  if (b.length >= 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WAVE") return { mime: "audio/wav", ext: "wav" };
  if (b.length >= 4 && (ascii(b, 0, 4) === "II*\x00" || ascii(b, 0, 4) === "MM\x00*")) return { mime: "image/tiff", ext: "tif" };
  if (b.length >= 2 && ascii(b, 0, 2) === "BM") return { mime: "image/bmp", ext: "bmp" };
  if (b.length >= 5 && ascii(b, 0, 5) === "%PDF-") return { mime: "application/pdf", ext: "pdf" };
  if (b.length >= 4 && ascii(b, 0, 4) === "fLaC") return { mime: "audio/flac", ext: "flac" };
  if (b.length >= 4 && ascii(b, 0, 4) === "OggS") return { mime: "audio/ogg", ext: "ogg" };
  if (b.length >= 4 && ascii(b, 0, 4) === "\x1aE\xdf\xa3") {
    const head = b.subarray(0, 512).toString("latin1");
    return head.includes("webm") ? { mime: "video/webm", ext: "webm" } : { mime: "video/x-matroska", ext: "mkv" };
  }
  if (b.length >= 3 && ascii(b, 0, 3) === "ID3") return { mime: "audio/mpeg", ext: "mp3" };
  if (b.length >= 2 && b[0] === 0xff && ((b[1] ?? 0) & 0xe0) === 0xe0) return { mime: "audio/mpeg", ext: "mp3" };

  // ISO-BMFF (mp4/mov/heic/avif): размер бокса, затем 'ftyp' и бренд.
  if (b.length >= 12 && ascii(b, 4, 4) === "ftyp") {
    const brand = ascii(b, 8, 4).trim();
    const mapped = ftypBrandMime[brand] ?? ftypBrandMime[brand.slice(0, 3)];
    if (mapped) return { mime: mapped, ext: mapped.split("/")[1] ?? "mp4" };
    return { mime: "video/mp4", ext: "mp4" };
  }

  if (b.length >= 4 && ascii(b, 0, 4) === "PK\x03\x04") return { mime: "application/zip", ext: "zip" };
  const head = b.subarray(0, 512).toString("utf8").trimStart().toLowerCase();
  if (head.startsWith("<?xml") && head.includes("<svg")) return { mime: "image/svg+xml", ext: "svg" };
  if (head.startsWith("<svg")) return { mime: "image/svg+xml", ext: "svg" };
  return { mime: "application/octet-stream", ext: "bin" };
}

export function kindFromMime(mime: string): "IMAGE" | "VIDEO" | "AUDIO" | "DOCUMENT" | "OTHER" {
  // SVG намеренно НЕ IMAGE: активный контент, который мы не рендерим как превью
  // и отдаём только на скачивание.
  if (mime === "image/svg+xml") return "DOCUMENT";
  if (mime.startsWith("image/")) return "IMAGE";
  if (mime.startsWith("video/")) return "VIDEO";
  if (mime.startsWith("audio/")) return "AUDIO";
  if (
    mime === "application/pdf" ||
    mime.startsWith("text/") ||
    mime.includes("officedocument") ||
    mime.includes("opendocument")
  ) {
    return "DOCUMENT";
  }
  return "OTHER";
}
