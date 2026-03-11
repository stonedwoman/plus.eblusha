import path from "path";
import { S3Client } from "@aws-sdk/client-s3";
import env from "../../config/env";
import logger from "../../config/logger";
import type { StorageProvider } from "./types";
import { LocalStorageProvider } from "./localStorageProvider";
import { S3StorageProvider } from "./s3StorageProvider";

let _instance: StorageProvider | null = null;

function createProvider(): StorageProvider {
  const backend = (env.STORAGE_BACKEND ?? "s3").toLowerCase();

  if (backend === "local") {
    const basePath = env.LOCAL_STORAGE_PATH ?? "/var/lib/eblusha/storage";
    const provider = new LocalStorageProvider({ basePath });
    logger.info(
      { basePath, resolved: path.resolve(basePath) },
      "Local storage provider initialized"
    );
    return provider;
  }

  // S3 (default)
  const s3Config =
    env.STORAGE_S3_ENDPOINT &&
    env.STORAGE_S3_REGION &&
    env.STORAGE_S3_BUCKET
      ? {
          endpoint: env.STORAGE_S3_ENDPOINT,
          region: env.STORAGE_S3_REGION,
          bucket: env.STORAGE_S3_BUCKET,
          accessKeyId: env.STORAGE_S3_ACCESS_KEY || undefined,
          secretAccessKey: env.STORAGE_S3_SECRET_KEY || undefined,
        }
      : null;

  if (!s3Config) {
    throw new Error(
      "S3 storage requested but STORAGE_S3_ENDPOINT, STORAGE_S3_REGION, STORAGE_S3_BUCKET are not all set"
    );
  }

  const s3Client = new S3Client({
    region: s3Config.region,
    endpoint: s3Config.endpoint,
    forcePathStyle: env.STORAGE_S3_FORCE_PATH_STYLE,
    ...(s3Config.accessKeyId && s3Config.secretAccessKey
      ? {
          credentials: {
            accessKeyId: s3Config.accessKeyId,
            secretAccessKey: s3Config.secretAccessKey,
          },
        }
      : {}),
  });

  const provider = new S3StorageProvider({
    bucket: s3Config.bucket,
    client: s3Client,
  });

  logger.info(
    {
      endpoint: s3Config.endpoint,
      region: s3Config.region,
      bucket: s3Config.bucket,
    },
    "S3 storage provider initialized"
  );
  return provider;
}

/** Get the singleton storage provider. Throws if backend is s3 and S3 is not configured. */
export function getStorageProvider(): StorageProvider {
  if (!_instance) {
    _instance = createProvider();
  }
  return _instance;
}

/** Check if storage is configured and available (without throwing). */
export function isStorageAvailable(): boolean {
  try {
    const backend = (env.STORAGE_BACKEND ?? "s3").toLowerCase();
    if (backend === "local") {
      const basePath = env.LOCAL_STORAGE_PATH ?? "/var/lib/eblusha/storage";
      const provider = new LocalStorageProvider({ basePath });
      return provider.isAvailable();
    }
    return !!(
      env.STORAGE_S3_ENDPOINT &&
      env.STORAGE_S3_REGION &&
      env.STORAGE_S3_BUCKET
    );
  } catch {
    return false;
  }
}
