import fsp from "node:fs/promises";
import cloudConfig from "../config";
import { run } from "./exec";

export type ProbeStream = {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  bit_rate?: string;
  duration?: string;
  rotation?: number;
  tags?: Record<string, string>;
  side_data_list?: { rotation?: number }[];
};

export type ProbeResult = {
  durationMs: number | null;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  bitrate: number | null;
  formatName: string | null;
  rotation: number;
  tags: Record<string, string>;
};

export async function ffprobe(absolute: string): Promise<ProbeResult | null> {
  const res = await run(
    "ffprobe",
    [
      "-v", "error",
      "-hide_banner",
      "-print_format", "json",
      "-show_format",
      "-show_streams",
      "-i", absolute,
    ],
    { timeoutMs: cloudConfig.CLOUD_FFPROBE_TIMEOUT_MS }
  ).catch(() => null);
  if (!res || res.code !== 0 || !res.stdout) return null;

  let parsed: { streams?: ProbeStream[]; format?: Record<string, unknown> };
  try {
    parsed = JSON.parse(res.stdout) as typeof parsed;
  } catch {
    return null;
  }
  const streams = parsed.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video");
  const audio = streams.find((s) => s.codec_type === "audio");
  const format = parsed.format ?? {};

  const durationSec = Number(format.duration ?? video?.duration ?? 0);
  const bitrate = Number(format.bit_rate ?? 0);

  let rotation = 0;
  const sideRot = video?.side_data_list?.find((d) => typeof d.rotation === "number")?.rotation;
  if (typeof sideRot === "number") rotation = ((Math.round(-sideRot) % 360) + 360) % 360;
  const tagRot = Number(video?.tags?.rotate ?? 0);
  if (!rotation && Number.isFinite(tagRot) && tagRot) rotation = ((tagRot % 360) + 360) % 360;

  let width = video?.width ?? null;
  let height = video?.height ?? null;
  if ((rotation === 90 || rotation === 270) && width && height) [width, height] = [height, width];

  return {
    durationMs: Number.isFinite(durationSec) && durationSec > 0 ? Math.round(durationSec * 1000) : null,
    width,
    height,
    videoCodec: video?.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
    bitrate: Number.isFinite(bitrate) && bitrate > 0 ? Math.round(bitrate) : null,
    formatName: typeof format.format_name === "string" ? format.format_name : null,
    rotation,
    tags: (format.tags as Record<string, string> | undefined) ?? {},
  };
}

/**
 * Лежит ли moov-атом раньше mdat. Если да — MP4/MOV стримится по Range без
 * подготовки, и переупаковывать оригинал (то есть держать на диске вторую копию
 * 30-гигабайтного файла) незачем.
 *
 * Читаем только заголовки боксов верхнего уровня, тело не трогаем.
 */
export async function isFaststartMp4(absolute: string): Promise<boolean> {
  let fh;
  try {
    fh = await fsp.open(absolute, "r");
    const stat = await fh.stat();
    let offset = 0;
    const header = Buffer.alloc(16);
    for (let i = 0; i < 64 && offset + 8 <= stat.size; i++) {
      const { bytesRead } = await fh.read(header, 0, 16, offset);
      if (bytesRead < 8) return false;
      let boxSize = header.readUInt32BE(0);
      const type = header.subarray(4, 8).toString("latin1");
      let headerSize = 8;
      if (boxSize === 1) {
        if (bytesRead < 16) return false;
        const big = header.readBigUInt64BE(8);
        boxSize = Number(big);
        headerSize = 16;
      } else if (boxSize === 0) {
        boxSize = stat.size - offset;
      }
      if (type === "moov") return true;
      if (type === "mdat") return false;
      if (boxSize < headerSize) return false;
      offset += boxSize;
    }
    return false;
  } catch {
    return false;
  } finally {
    await fh?.close().catch(() => undefined);
  }
}

const BROWSER_VIDEO_CODECS = new Set(["h264", "vp8", "vp9", "av1"]);
const BROWSER_AUDIO_CODECS = new Set(["aac", "mp3", "opus", "vorbis", "flac"]);
const BROWSER_CONTAINERS = ["mp4", "mov", "m4v", "webm", "matroska"];

/**
 * Можно ли отдавать ОРИГИНАЛ прямо в <video>. Консервативно: сомневаешься —
 * лучше сделать web-версию, чем показать пользователю чёрный экран.
 */
export async function canDirectPlay(absolute: string, probe: ProbeResult | null): Promise<boolean> {
  if (!probe || !probe.videoCodec) return false;
  if (!BROWSER_VIDEO_CODECS.has(probe.videoCodec)) return false;
  if (probe.audioCodec && !BROWSER_AUDIO_CODECS.has(probe.audioCodec)) return false;
  const fmt = (probe.formatName ?? "").toLowerCase();
  if (!BROWSER_CONTAINERS.some((c) => fmt.includes(c))) return false;
  // WebM/Matroska стримятся без faststart-требований; для MP4/MOV нужен moov впереди.
  if (fmt.includes("matroska") || fmt.includes("webm")) return true;
  return isFaststartMp4(absolute);
}
