import fsp from "node:fs/promises";
import path from "node:path";
import cloudConfig from "../config";
import { run } from "./exec";
import type { ProbeResult } from "./probe";

/**
 * Оригинал видео НИКОГДА не меняется. Всё, что делает ffmpeg, пишется в derived/
 * и считается кэшем — потеряли, пересоздали.
 */

/** Кадр-постер. Берём ~10% длительности, чтобы не поймать чёрный первый кадр. */
export async function renderPoster(
  sourceAbs: string,
  targetAbs: string,
  probe: ProbeResult | null,
  maxSide = 1280
): Promise<{ size: number; width: number | null; height: number | null }> {
  await fsp.mkdir(path.dirname(targetAbs), { recursive: true });
  const durationMs = probe?.durationMs ?? 0;
  const seekSec = durationMs > 4000 ? Math.min(durationMs * 0.1, 20_000) / 1000 : 0;

  const args = [
    "-nostdin",
    "-v", "error",
    "-y",
    ...(seekSec > 0 ? ["-ss", seekSec.toFixed(2)] : []),
    "-i", sourceAbs,
    "-frames:v", "1",
    "-vf", `scale='min(${maxSide},iw)':-2:flags=bicubic`,
    "-c:v", "mjpeg",
    "-q:v", "4",
    "-f", "image2",
    targetAbs,
  ];
  let res = await run("ffmpeg", args, { timeoutMs: cloudConfig.CLOUD_IMAGE_TIMEOUT_MS });
  if (res.code !== 0 && seekSec > 0) {
    // Битые индексы/переменный fps: пробуем самый первый кадр.
    res = await run(
      "ffmpeg",
      ["-nostdin", "-v", "error", "-y", "-i", sourceAbs, "-frames:v", "1", "-vf", `scale='min(${maxSide},iw)':-2`, "-c:v", "mjpeg", "-q:v", "4", "-f", "image2", targetAbs],
      { timeoutMs: cloudConfig.CLOUD_IMAGE_TIMEOUT_MS }
    );
  }
  if (res.code !== 0) throw new Error(`poster failed: ${res.stderr.slice(-300)}`);
  const st = await fsp.stat(targetAbs);
  return { size: st.size, width: null, height: null };
}

export type PlaybackResult = { size: number; width: number | null; height: number | null };

/**
 * Web-версия для форматов, которые браузер не откроет (HEVC, ProRes, странные
 * контейнеры). Одна разумная версия 1080p H.264 + AAC, а не пять разрешений:
 * на четырёх ядрах без аппаратного кодировщика это единственный вменяемый режим.
 */
export async function renderPlayback(
  sourceAbs: string,
  targetAbs: string,
  probe: ProbeResult | null
): Promise<PlaybackResult> {
  await fsp.mkdir(path.dirname(targetAbs), { recursive: true });
  const maxH = cloudConfig.PLAYBACK_MAX_HEIGHT;
  const args = [
    "-nostdin",
    "-v", "error",
    "-y",
    "-i", sourceAbs,
    "-map", "0:v:0",
    "-map", "0:a:0?",
    "-vf", `scale=-2:'min(${maxH},ih)':flags=bicubic`,
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "23",
    "-profile:v", "high",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "160k",
    "-ac", "2",
    "-movflags", "+faststart",
    "-max_muxing_queue_size", "1024",
    "-f", "mp4",
    targetAbs,
  ];
  const res = await run("ffmpeg", args, { timeoutMs: cloudConfig.CLOUD_FFMPEG_TIMEOUT_MS });
  if (res.code !== 0) throw new Error(`transcode failed: ${res.stderr.slice(-400)}`);
  const st = await fsp.stat(targetAbs);
  const height = probe?.height ? Math.min(probe.height, maxH) : null;
  const width = probe?.width && probe.height ? Math.round((probe.width * (height ?? probe.height)) / probe.height / 2) * 2 : null;
  return { size: st.size, width, height };
}

/**
 * Дёшево ли можно сделать web-версию: если видео уже h264+aac, но moov в конце,
 * достаточно ремукса без перекодирования (секунды вместо часов).
 */
export async function remuxFaststart(sourceAbs: string, targetAbs: string): Promise<PlaybackResult> {
  await fsp.mkdir(path.dirname(targetAbs), { recursive: true });
  const res = await run(
    "ffmpeg",
    ["-nostdin", "-v", "error", "-y", "-i", sourceAbs, "-map", "0:v:0", "-map", "0:a:0?", "-c", "copy", "-movflags", "+faststart", "-f", "mp4", targetAbs],
    { timeoutMs: cloudConfig.CLOUD_FFMPEG_TIMEOUT_MS }
  );
  if (res.code !== 0) throw new Error(`remux failed: ${res.stderr.slice(-300)}`);
  const st = await fsp.stat(targetAbs);
  return { size: st.size, width: null, height: null };
}
