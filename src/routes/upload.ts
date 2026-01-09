import { Router, type Request } from "express";
import multer from "multer";
import path from "path";
import crypto from "crypto";
import fs from "fs";
import { promises as fsPromises } from "fs";
import {
  S3Client,
  PutObjectCommand,
  type ObjectCannedACL,
  ServerSideEncryption,
} from "@aws-sdk/client-s3";
import { authenticate } from "../middlewares/auth";
import env from "../config/env";
import logger from "../config/logger";
import {
  encryptBuffer,
  parseStorageEncKey,
  type EncryptionMetadata,
} from "../lib/storageEncryption";

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  // Increase max size to 100MB to support typical documents/archives
  limits: { fileSize: 100 * 1024 * 1024 },
});

const s3Config =
  env.STORAGE_S3_ENDPOINT &&
  env.STORAGE_S3_REGION &&
  env.STORAGE_S3_BUCKET &&
  env.STORAGE_PUBLIC_BASE_URL
    ? {
        endpoint: env.STORAGE_S3_ENDPOINT,
        region: env.STORAGE_S3_REGION,
        bucket: env.STORAGE_S3_BUCKET,
        accessKeyId: env.STORAGE_S3_ACCESS_KEY || undefined,
        secretAccessKey: env.STORAGE_S3_SECRET_KEY || undefined,
        publicBaseUrl: env.STORAGE_PUBLIC_BASE_URL.replace(/\/$/, ""),
      }
    : null;

const s3Client = s3Config
  ? new S3Client({
      region: s3Config.region,
      endpoint: s3Config.endpoint,
      forcePathStyle: env.STORAGE_S3_FORCE_PATH_STYLE,
      // If explicit keys aren't provided, fall back to the default AWS credential chain
      // (e.g. /root/.aws/credentials for systemd services running as root).
      ...(s3Config.accessKeyId && s3Config.secretAccessKey
        ? {
            credentials: {
              accessKeyId: s3Config.accessKeyId,
              secretAccessKey: s3Config.secretAccessKey,
            },
          }
        : {}),
    })
  : null;

const objectPrefix = env.STORAGE_PREFIX.replace(/^\/|\/$/g, "");

if (s3Client && s3Config) {
  logger.info(
    {
      endpoint: s3Config.endpoint,
      region: s3Config.region,
      bucket: s3Config.bucket,
      publicBaseUrl: s3Config.publicBaseUrl,
      forcePathStyle: env.STORAGE_S3_FORCE_PATH_STYLE,
      objectPrefix,
    },
    "S3 upload initialized"
  );
}

const encKey = env.STORAGE_ENC_KEY ? parseStorageEncKey(env.STORAGE_ENC_KEY) : null;

const encodeKeyForUrl = (key: string) =>
  key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");

const allowedObjectAcls: ReadonlyArray<ObjectCannedACL> = [
  "private",
  "public-read",
  "public-read-write",
  "authenticated-read",
  "aws-exec-read",
  "bucket-owner-read",
  "bucket-owner-full-control",
];

const resolveObjectAcl = (
  value: string | undefined
): ObjectCannedACL | undefined => {
  if (!value) return undefined;
  if (allowedObjectAcls.includes(value as ObjectCannedACL)) {
    return value as ObjectCannedACL;
  }
  logger.warn(
    { acl: value },
    "Ignoring unsupported STORAGE_S3_ACL value, falling back to default permissions"
  );
  return undefined;
};

const resolveServerSideEncryption = (
  value: string | undefined
): ServerSideEncryption | undefined => {
  if (!value) return undefined;
  const normalized = value.toUpperCase();
  if (normalized === "AES256") {
    return ServerSideEncryption.AES256;
  }
  if (normalized === "AWS:KMS" || normalized === "AWS_KMS") {
    return ServerSideEncryption.aws_kms;
  }
  logger.warn(
    { sse: value },
    "Ignoring unsupported STORAGE_S3_SSE value, falling back to no encryption"
  );
  return undefined;
};

router.use(authenticate);

router.post("/", upload.single("file"), async (req: Request, res) => {
  const file = (req as any).file as Express.Multer.File | undefined;
  if (!file) {
    res.status(400).json({ message: "No file" });
    return;
  }

  // If app-level encryption is enabled, hide the original extension in S3 object keys.
  // Clients will rely on Content-Type from our proxy response (stored in object metadata).
  const ext = encKey ? ".eblusha" : path.extname(file.originalname || "") || ".bin";
  const randomId =
    typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : crypto.randomBytes(16).toString("hex");
  const uniqueName = `${Date.now()}-${randomId}${ext}`;
  const key = objectPrefix ? `${objectPrefix}/${uniqueName}` : uniqueName;

  try {
    if (!s3Client || !s3Config) {
      logger.error("S3 storage is not configured. File uploads require S3 configuration.");
      res.status(500).json({ 
        message: "File storage is not configured. Please configure S3 storage." 
      });
      return;
    }

    // All uploads go to S3 - no local fallback
    // Hetzner Object Storage may not support ACL/SSE parameters
    // Use them only if explicitly needed for other providers
    let bodyToUpload: Buffer = file.buffer;
    let encryptionMeta: EncryptionMetadata | null = null;
    let originalContentType = file.mimetype || "application/octet-stream";

    // Optional app-level encryption: store only ciphertext in S3. Decrypt in /api/files.
    // AAD binds ciphertext to its object key (prevents key-swapping attacks inside the bucket).
    if (encKey) {
      const encrypted = encryptBuffer(file.buffer, encKey, {
        aad: key,
        contentType: originalContentType,
      });
      bodyToUpload = encrypted.payload;
      encryptionMeta = encrypted.meta;
      // ciphertext shouldn't advertise original type
      originalContentType = "application/octet-stream";
    }

    const putObjectParams: any = {
      Bucket: s3Config.bucket,
      Key: key,
      Body: bodyToUpload,
      ContentType: originalContentType,
      Metadata: encryptionMeta
        ? {
            enc: "ebp1",
            // Avoid underscores in x-amz-meta-* keys for S3-compatible providers.
            // Some proxies/services normalize '_' which breaks SigV4 signature verification.
            encv: encryptionMeta.v,
            encalg: encryptionMeta.alg,
            enciv: encryptionMeta.iv,
            enctag: encryptionMeta.tag,
            // preserve original content-type for API response
            ct: encryptionMeta.ct || "",
          }
        : undefined,
    };
    // Note: twcstorage.ru (Russian S3) doesn't support ACL/SSE in PutObject
    // Similar to Hetzner, these parameters cause InvalidRequest errors
    // Uncomment if needed for AWS S3 or other providers that support it:
    // const acl = resolveObjectAcl(env.STORAGE_S3_ACL);
    // if (acl) putObjectParams.ACL = acl;
    // const sse = resolveServerSideEncryption(env.STORAGE_S3_SSE);
    // if (sse) putObjectParams.ServerSideEncryption = sse;
    const command = new PutObjectCommand(putObjectParams);
    await s3Client.send(command);
    
    const encodedKey = encodeKeyForUrl(key);
    // If encrypted, direct S3 URL is useless (ciphertext). Return proxy URL so client always hits server.
    const publicUrl = encKey
      ? `/api/files/${encodedKey}`
      : `${s3Config.publicBaseUrl}/${encodedKey}`;
    
    res.json({ url: publicUrl, path: key, publicUrl });
  } catch (error) {
    logger.error({ err: error }, "Failed to upload file to S3");
    res.status(500).json({ message: "Upload failed" });
  }
});

export default router;
