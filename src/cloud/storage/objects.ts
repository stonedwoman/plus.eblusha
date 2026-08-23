import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import prisma from "../../lib/prisma";
import logger from "../../config/logger";
import { DERIVED_DIR, OBJECTS_DIR, derivedAbsPath, ensureParentDir, objectAbsPath, objectRelPath, rmDirQuiet, rmQuiet } from "../paths";

/**
 * Физический blob и логический файл — разные сущности.
 * CloudStorageObject.refCount считает ссылки CloudFile (включая лежащие в корзине):
 * пока он > 0, оригинал с диска не исчезает ни при каких условиях.
 */

/** SHA-256 файла потоком. 30 ГБ в память не поднимаем. */
export function sha256File(absolute: string): Promise<{ sha256: string; size: number }> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    let size = 0;
    const rs = fs.createReadStream(absolute, { highWaterMark: 4 * 1024 * 1024 });
    rs.on("data", (chunk) => {
      size += chunk.length;
      hash.update(chunk);
    });
    rs.on("error", reject);
    rs.on("end", () => resolve({ sha256: hash.digest("hex"), size }));
  });
}

/**
 * Переносит staging-файл в objects/ и создаёт (или переиспользует) StorageObject.
 * Дедупликация происходит ЗДЕСЬ, после полной загрузки — клиент никогда не может
 * спросить «а есть ли у вас хеш X», и оракула наличия чужих файлов не возникает.
 */
export async function adoptStagingFile(
  stagingAbs: string,
  opts: { detectedMime?: string | null }
): Promise<{ objectId: string; sha256: string; size: number; deduped: boolean }> {
  const { sha256, size } = await sha256File(stagingAbs);
  const rel = objectRelPath(sha256);
  const target = objectAbsPath(rel);

  const existing = await prisma.cloudStorageObject.findUnique({ where: { sha256 } });
  if (existing) {
    // Физический blob уже есть: staging просто выбрасываем.
    let onDisk = false;
    try {
      onDisk = (await fsp.stat(target)).isFile();
    } catch {
      onDisk = false;
    }
    if (!onDisk) {
      // Объект в БД есть, а файла нет (потеряли/чинили руками) — восстанавливаем.
      await ensureParentDir(target);
      await moveOrCopy(stagingAbs, target);
      logger.warn({ sha256 }, "cloud: restored missing object body from staging");
    } else {
      await rmQuiet(stagingAbs);
    }
    return { objectId: existing.id, sha256, size: Number(existing.size), deduped: true };
  }

  await ensureParentDir(target);
  await moveOrCopy(stagingAbs, target);
  await applyObjectPermissions(target);

  try {
    const created = await prisma.cloudStorageObject.create({
      data: {
        sha256,
        size: BigInt(size),
        storagePath: rel,
        detectedMime: opts.detectedMime ?? null,
        refCount: 0,
      },
    });
    return { objectId: created.id, sha256, size, deduped: false };
  } catch (err) {
    // Гонка: параллельная загрузка того же контента успела создать объект.
    const raced = await prisma.cloudStorageObject.findUnique({ where: { sha256 } });
    if (raced) return { objectId: raced.id, sha256, size: Number(raced.size), deduped: true };
    throw err;
  }
}

/**
 * Права на оригинал: чтение владельцу (backend) и группе (nginx + медиа-воркер),
 * больше никому.
 *
 * Явный chown обязателен: файл приезжает из staging через rename(), а rename
 * сохраняет исходного владельца и группу — setgid на каталоге objects/ на него
 * не действует, и медиа-воркер под другим пользователем получал бы EACCES.
 */
async function applyObjectPermissions(target: string): Promise<void> {
  try {
    const dir = await fsp.stat(OBJECTS_DIR);
    await fsp.chown(target, -1, dir.gid);
  } catch {
    // не root или другая ФС — не критично, ниже всё равно выставим режим
  }
  try {
    await fsp.chmod(target, 0o640);
  } catch {
    // права не критичны для работы, но чужому пользователю читать нечего
  }
}

async function moveOrCopy(from: string, to: string): Promise<void> {
  try {
    await fsp.rename(from, to);
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EXDEV") throw err;
  }
  // Разные устройства: копируем и только потом удаляем исходник.
  await fsp.copyFile(from, to);
  await rmQuiet(from);
}

export async function incRef(objectId: string, by = 1): Promise<void> {
  await prisma.cloudStorageObject.update({
    where: { id: objectId },
    data: { refCount: { increment: by } },
  });
}

export async function decRef(objectId: string, by = 1): Promise<void> {
  await prisma.cloudStorageObject.update({
    where: { id: objectId },
    data: { refCount: { decrement: by } },
  });
}

/**
 * Физическое удаление объекта. Вызывается ТОЛЬКО из maintenance и только после
 * проверки, что на него не осталось ни одной ссылки CloudFile.
 */
export async function purgeObjectIfUnreferenced(objectId: string): Promise<boolean> {
  const object = await prisma.cloudStorageObject.findUnique({ where: { id: objectId } });
  if (!object) return false;
  const refs = await prisma.cloudFile.count({ where: { storageObjectId: objectId } });
  if (refs > 0) {
    if (object.refCount !== refs) {
      await prisma.cloudStorageObject.update({ where: { id: objectId }, data: { refCount: refs } });
    }
    return false;
  }
  await rmQuiet(objectAbsPath(object.storagePath));
  await prisma.cloudStorageObject.delete({ where: { id: objectId } });
  return true;
}

/** Удаляет все производные файла (кэш, восстановим при необходимости). */
export async function purgeDerived(fileId: string): Promise<void> {
  const variants = await prisma.cloudFileVariant.findMany({ where: { fileId } });
  for (const v of variants) {
    if (v.storagePath) await rmQuiet(derivedAbsPath(v.storagePath));
  }
  await prisma.cloudFileVariant.deleteMany({ where: { fileId } });
  if (/^[A-Za-z0-9_-]{2,64}$/.test(fileId)) {
    await rmDirQuiet(path.join(DERIVED_DIR, fileId.slice(0, 2), fileId.slice(2, 4) || "00", fileId));
  }
}
