import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import cloudConfig from "./config";

/**
 * Физическая раскладка хранилища. Пользовательская иерархия папок здесь НЕ
 * отражается: имена файлов и папок — это только метаданные в БД.
 *
 *   objects/  ab/cd/<sha256>      — оригиналы (бэкапим)
 *   derived/  ab/cd/<fileId>/...  — превью/постеры/web-видео (кэш, не бэкапим)
 *   staging/  <uploadId>.part     — незавершённые загрузки
 *   tmp/                          — рабочие файлы медиа-джоб
 */
export const ROOT = path.resolve(cloudConfig.CLOUD_STORAGE_ROOT);
export const OBJECTS_DIR = path.join(ROOT, "objects");
export const DERIVED_DIR = path.join(ROOT, "derived");
export const STAGING_DIR = path.join(ROOT, "staging");
export const TMP_DIR = path.join(ROOT, "tmp");

export function ensureStorageDirs(): void {
  for (const dir of [OBJECTS_DIR, DERIVED_DIR, STAGING_DIR, TMP_DIR]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
  }
}

const HEX64 = /^[0-9a-f]{64}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Относительный путь объекта внутри objects/. Только из sha256, никогда из имени файла. */
export function objectRelPath(sha256: string): string {
  if (!HEX64.test(sha256)) throw new Error("invalid sha256");
  return path.posix.join(sha256.slice(0, 2), sha256.slice(2, 4), sha256);
}

export function objectAbsPath(relOrSha: string): string {
  const rel = HEX64.test(relOrSha) ? objectRelPath(relOrSha) : relOrSha;
  return safeJoin(OBJECTS_DIR, rel);
}

export function derivedRelPath(fileId: string, name: string): string {
  if (!ID_RE.test(fileId)) throw new Error("invalid file id");
  if (!/^[a-z0-9._-]{1,40}$/.test(name)) throw new Error("invalid derived name");
  return path.posix.join(fileId.slice(0, 2), fileId.slice(2, 4) || "00", fileId, name);
}

export function derivedAbsPath(rel: string): string {
  return safeJoin(DERIVED_DIR, rel);
}

export function stagingPath(uploadProtocolId: string): string {
  if (!ID_RE.test(uploadProtocolId)) throw new Error("invalid upload id");
  return path.join(STAGING_DIR, `${uploadProtocolId}.part`);
}

/**
 * Склейка пути с проверкой, что результат остался внутри base.
 * Это последний рубеж против path traversal: сюда никогда не приходят
 * пользовательские строки, но проверка стоит копейки.
 */
export function safeJoin(base: string, rel: string): string {
  if (typeof rel !== "string" || !rel) throw new Error("empty path");
  if (rel.includes("\0")) throw new Error("invalid path");
  const baseResolved = path.resolve(base);
  const abs = path.resolve(baseResolved, rel);
  if (abs !== baseResolved && !abs.startsWith(baseResolved + path.sep)) {
    throw new Error("path escapes storage root");
  }
  return abs;
}

/** Путь внутри ROOT → путь для X-Accel-Redirect (nginx alias на ROOT). */
export function accelPath(absolute: string): string {
  const rootResolved = path.resolve(ROOT);
  const abs = path.resolve(absolute);
  if (abs !== rootResolved && !abs.startsWith(rootResolved + path.sep)) {
    throw new Error("path escapes storage root");
  }
  const rel = path.relative(rootResolved, abs).split(path.sep).map(encodeURIComponent).join("/");
  return cloudConfig.CLOUD_XACCEL_PREFIX.replace(/\/+$/, "") + "/" + rel;
}

export async function ensureParentDir(absolute: string): Promise<void> {
  await fsp.mkdir(path.dirname(absolute), { recursive: true, mode: 0o750 });
}

export async function fileSizeOrNull(absolute: string): Promise<number | null> {
  try {
    const st = await fsp.stat(absolute);
    return st.isFile() ? st.size : null;
  } catch {
    return null;
  }
}

export async function rmQuiet(absolute: string): Promise<void> {
  try {
    await fsp.rm(absolute, { force: true, recursive: false });
  } catch {
    // не критично: физическую уборку добьёт maintenance
  }
}

export async function rmDirQuiet(absolute: string): Promise<void> {
  try {
    await fsp.rm(absolute, { force: true, recursive: true });
  } catch {
    // см. rmQuiet
  }
}

/** Свободное место на ФС хранилища (байты). */
export async function freeDiskBytes(): Promise<number> {
  try {
    const st = await fsp.statfs(ROOT);
    return Number(st.bavail) * Number(st.bsize);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export async function dirSizeBytes(dir: string): Promise<number> {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop() as string;
    let entries;
    try {
      entries = await fsp.readdir(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) {
        try {
          total += (await fsp.stat(p)).size;
        } catch {
          // файл мог исчезнуть между readdir и stat
        }
      }
    }
  }
  return total;
}
