import prisma from "../../lib/prisma";
import cloudConfig from "../config";
import { insufficientStorage, tooLarge } from "../errors";
import { DERIVED_DIR, STAGING_DIR, dirSizeBytes, freeDiskBytes } from "../paths";

/**
 * Квота считается по ФИЗИЧЕСКИМ объектам (после дедупликации) — так пользователь
 * не платит дважды за один и тот же blob, а мы видим реальный расход диска.
 */
export async function usedObjectBytes(): Promise<number> {
  const agg = await prisma.cloudStorageObject.aggregate({ _sum: { size: true } });
  return Number(agg._sum.size ?? 0n);
}

export async function stagingBytes(): Promise<number> {
  const rows = await prisma.cloudUploadSession.aggregate({
    _sum: { bytesReceived: true },
    where: { status: { in: ["CREATED", "UPLOADING", "PAUSED", "UPLOADED", "VERIFYING"] } },
  });
  return Number(rows._sum.bytesReceived ?? 0n);
}

export type StorageSnapshot = {
  originals: number;
  derived: number;
  staging: number;
  free: number;
  quotaMax: number;
  minFree: number;
  derivedMax: number;
};

/** Полный снимок для дашборда. dirSizeBytes по derived/staging — обход дерева, не для hot path. */
export async function storageSnapshot(): Promise<StorageSnapshot> {
  const [originals, derived, staging, free] = await Promise.all([
    usedObjectBytes(),
    dirSizeBytes(DERIVED_DIR),
    dirSizeBytes(STAGING_DIR),
    freeDiskBytes(),
  ]);
  return {
    originals,
    derived,
    staging,
    free,
    quotaMax: cloudConfig.CLOUD_STORAGE_MAX_BYTES,
    minFree: cloudConfig.CLOUD_STORAGE_MIN_FREE_BYTES,
    derivedMax: cloudConfig.CLOUD_DERIVED_CACHE_MAX_BYTES,
  };
}

/**
 * Проверка ПЕРЕД началом загрузки: квота, реальное свободное место и резерв.
 * Резерв обязателен — заполнять диск под завязку нельзя, иначе ляжет и Postgres.
 */
export async function assertCanAccept(sizeBytes: number): Promise<void> {
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) throw tooLarge("Некорректный размер");
  if (sizeBytes > cloudConfig.CLOUD_MAX_FILE_BYTES) {
    throw tooLarge(
      `Файл больше лимита (${Math.floor(cloudConfig.CLOUD_MAX_FILE_BYTES / 1024 ** 3)} ГБ)`
    );
  }

  const [used, staged, free] = await Promise.all([usedObjectBytes(), stagingBytes(), freeDiskBytes()]);
  if (used + staged + sizeBytes > cloudConfig.CLOUD_STORAGE_MAX_BYTES) {
    throw insufficientStorage("Достигнута квота Cloud");
  }
  if (free - sizeBytes < cloudConfig.CLOUD_STORAGE_MIN_FREE_BYTES) {
    throw insufficientStorage("На диске не останется обязательного резерва");
  }
}
