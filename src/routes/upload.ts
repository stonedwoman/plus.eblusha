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
  env.STORAGE_S3_ACCESS_KEY &&
  env.STORAGE_S3_SECRET_KEY &&
  env.STORAGE_PUBLIC_BASE_URL
    ? {
        endpoint: env.STORAGE_S3_ENDPOINT,
        region: env.STORAGE_S3_REGION,
        bucket: env.STORAGE_S3_BUCKET,
        accessKeyId: env.STORAGE_S3_ACCESS_KEY,
        secretAccessKey: env.STORAGE_S3_SECRET_KEY,
        publicBaseUrl: env.STORAGE_PUBLIC_BASE_URL.replace(/\/$/, ""),
      }
    : null;

const s3Client = s3Config
  ? new S3Client({
      region: s3Config.region,
      endpoint: s3Config.endpoint,
      forcePathStyle: env.STORAGE_S3_FORCE_PATH_STYLE,
      credentials: {
        accessKeyId: s3Config.accessKeyId,
        secretAccessKey: s3Config.secretAccessKey,
      },
    })
  : null;

const objectPrefix = env.STORAGE_PREFIX.replace(/^\/|\/$/g, "");

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

const uploadsDir = path.join(process.cwd(), "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

router.use(authenticate);

router.post("/", upload.single("file"), async (req: Request, res) => {
  const file = (req as any).file as Express.Multer.File | undefined;
  if (!file) {
    res.status(400).json({ message: "No file" });
    return;
  }

  const ext = path.extname(file.originalname || "") || ".bin";
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
    const putObjectParams: any = {
      Bucket: s3Config.bucket,
      Key: key,
      Body: file.buffer,
      ContentType: file.mimetype || "application/octet-stream",
    };
    // Note: Hetzner Object Storage doesn't support ACL/SSE in PutObject
    // Uncomment if needed for AWS S3 or other providers:
    // const acl = resolveObjectAcl(env.STORAGE_S3_ACL);
    // if (acl) putObjectParams.ACL = acl;
    // const sse = resolveServerSideEncryption(env.STORAGE_S3_SSE);
    // if (sse) putObjectParams.ServerSideEncryption = sse;
    const command = new PutObjectCommand(putObjectParams);
    await s3Client.send(command);
    
    // Use proxy URL instead of direct S3 URL to avoid blocking in Russia
    // Construct proxy URL: /api/files/{encodedKey}
    const encodedKey = encodeKeyForUrl(key);
    const protocol = req.protocol;
    const host = req.get("host") || "localhost";
    const proxyUrl = `${protocol}://${host}/api/files/${encodedKey}`;
    
    res.json({ url: proxyUrl, path: key });
  } catch (error) {
    logger.error({ err: error }, "Failed to upload file to S3");
    res.status(500).json({ message: "Upload failed" });
  }
});

export default router;
