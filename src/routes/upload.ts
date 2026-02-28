import { Router, type Request } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import {
  S3Client,
  PutObjectCommand,
  type ObjectCannedACL,
  ServerSideEncryption,
} from "@aws-sdk/client-s3";
import { authenticate } from "../middlewares/auth";
import env from "../config/env";
import logger from "../config/logger";
import { rateLimit } from "../middlewares/rateLimit";
import {
  encryptBuffer,
  decryptBuffer,
  encryptToEbp2Stream,
  parseStorageEncKey,
  EBP2_DEFAULT_CHUNK_SIZE,
  type EncryptionMetadata,
  type EBP2Metadata,
} from "../lib/storageEncryption";

const router = Router();

const encV2 = env.STORAGE_ENC_V2 === true;

const upload = multer({
  storage:
    encV2
      ? multer.diskStorage({
          destination: (_req, _file, cb) => {
            const tmp = path.join(process.cwd(), "tmp", "uploads");
            fs.mkdirSync(tmp, { recursive: true });
            cb(null, tmp);
          },
          filename: (_req, _file, cb) => {
            cb(null, `upload-${Date.now()}-${crypto.randomBytes(8).toString("hex")}`);
          },
        })
      : multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
});

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

router.post("/", rateLimit({ name: "upload_init", windowMs: 60_000, max: 20 }), upload.single("file"), async (req: Request, res) => {
  const file = (req as any).file as Express.Multer.File | undefined;
  if (!file) {
    res.status(400).json({ message: "No file" });
    return;
  }

  if (!encKey) {
    res.status(503).json({ message: "Storage encryption key is not configured" });
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
  const putKey = objectPrefix ? `${objectPrefix}/${uniqueName}` : uniqueName;
  const aadUsedForEncrypt = putKey;
  const metaAadWritten = putKey;

  try {
    if (!s3Client || !s3Config) {
      logger.error("S3 storage is not configured. File uploads require S3 configuration.");
      res.status(500).json({ 
        message: "File storage is not configured. Please configure S3 storage." 
      });
      return;
    }

    let bodyToUpload: Buffer | NodeJS.ReadableStream;
    let encryptionMeta: EncryptionMetadata | EBP2Metadata | null = null;
    let originalContentType = file.mimetype || "application/octet-stream";

    if (encKey && encV2) {
      const filePath = (file as any).path as string | undefined;
      if (!filePath || !fs.existsSync(filePath)) {
        res.status(500).json({ message: "Upload file not found on disk" });
        return;
      }
      const stat = fs.statSync(filePath);
      const totalSize = stat.size;
      const inputStream = fs.createReadStream(filePath);
      const encryptedStream = encryptToEbp2Stream(
        inputStream,
        aadUsedForEncrypt,
        totalSize,
        encKey,
        { chunkSize: EBP2_DEFAULT_CHUNK_SIZE }
      );
      bodyToUpload = encryptedStream;
      encryptionMeta = {
        enc: "ebp2",
        encalg: "aes-256-gcm",
        chunksize: String(EBP2_DEFAULT_CHUNK_SIZE),
        totalSize: String(totalSize),
        ct: originalContentType,
      };
      originalContentType = "application/octet-stream";
    } else if (encKey) {
      const buffer = file.buffer;
      if (!buffer) {
        res.status(500).json({ message: "Upload file data not available" });
        return;
      }
      const encrypted = encryptBuffer(buffer, encKey, {
        aad: aadUsedForEncrypt,
        contentType: originalContentType,
      });
      try {
        decryptBuffer(encrypted.payload, encKey, { aad: aadUsedForEncrypt });
      } catch (err) {
        logger.error(
          {
            err,
            stack: err instanceof Error ? err.stack : undefined,
            putKey,
            magic: encrypted.payload.slice(0, 4).toString("utf8"),
            len: encrypted.payload.length,
          },
          "[upload] EBP1 selfcheck failed"
        );
        res.status(500).json({ message: "storage_enc_selfcheck_failed" });
        return;
      }
      bodyToUpload = encrypted.payload;
      encryptionMeta = encrypted.meta;
      originalContentType = "application/octet-stream";
    } else {
      bodyToUpload = file.buffer!;
    }

    const encFormat = encryptionMeta
      ? "enc" in encryptionMeta && encryptionMeta.enc === "ebp2"
        ? "ebp2"
        : "ebp1"
      : "none";
    const putObjectParams: any = {
      Bucket: s3Config.bucket,
      Key: putKey,
      Body: bodyToUpload,
      ContentType: originalContentType,
      Metadata:
        encryptionMeta && "enc" in encryptionMeta && encryptionMeta.enc === "ebp2"
          ? {
              enc: "ebp2",
              encalg: (encryptionMeta as EBP2Metadata).encalg,
              chunksize: (encryptionMeta as EBP2Metadata).chunksize,
              totalSize: (encryptionMeta as EBP2Metadata).totalSize,
              ct: (encryptionMeta as EBP2Metadata).ct || "",
              aad: metaAadWritten,
            }
          : encryptionMeta
            ? {
                enc: "ebp1",
                encv: (encryptionMeta as EncryptionMetadata).v,
                encalg: (encryptionMeta as EncryptionMetadata).alg,
                enciv: (encryptionMeta as EncryptionMetadata).iv,
                enctag: (encryptionMeta as EncryptionMetadata).tag,
                ct: (encryptionMeta as EncryptionMetadata).ct || "",
                aad: metaAadWritten,
              }
            : undefined,
    };
    if (encryptionMeta) {
      logger.info(
        { putKey, aadUsedForEncrypt, metaAadWritten, enc: encFormat },
        "[upload] aad invariants"
      );
    }
    if (encFormat === "ebp1" && Buffer.isBuffer(bodyToUpload)) {
      const enc = bodyToUpload;
      logger.info(
        {
          putKey,
          encLen: enc.length,
          encFirst32: enc.slice(0, 32).toString("hex"),
          encLast32: enc.slice(-32).toString("hex"),
          encSha: crypto.createHash("sha256").update(enc).digest("hex").slice(0, 12),
        },
        "[upload] enc bytes"
      );
    }
    // Note: twcstorage.ru (Russian S3) doesn't support ACL/SSE in PutObject
    // Similar to Hetzner, these parameters cause InvalidRequest errors
    // Uncomment if needed for AWS S3 or other providers that support it:
    // const acl = resolveObjectAcl(env.STORAGE_S3_ACL);
    // if (acl) putObjectParams.ACL = acl;
    // const sse = resolveServerSideEncryption(env.STORAGE_S3_SSE);
    // if (sse) putObjectParams.ServerSideEncryption = sse;
    const command = new PutObjectCommand(putObjectParams);
    await s3Client.send(command);

    if (encV2 && (file as any).path) {
      try {
        fs.unlinkSync((file as any).path);
      } catch (e) {
        logger.warn({ err: e, path: (file as any).path }, "Failed to remove temp upload file");
      }
    }

    const encodedKey = encodeKeyForUrl(putKey);
    const proxyUrl = `/api/files/${encodedKey}`;
    res.json({ url: proxyUrl, path: putKey, publicUrl: proxyUrl });
  } catch (error) {
    logger.error({ err: error }, "Failed to upload file to S3");
    if ((file as any).path && fs.existsSync((file as any).path)) {
      try {
        fs.unlinkSync((file as any).path);
      } catch {}
    }
    res.status(500).json({ message: "Upload failed" });
  }
});

export default router;
