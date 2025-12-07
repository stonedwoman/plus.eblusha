import { Router, type Request } from "express";
import multer from "multer";
import path from "path";
import crypto from "crypto";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { authenticate } from "../middlewares/auth";
import env from "../config/env";
import logger from "../config/logger";

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  // Increase max size to 100MB to support typical documents/archives
  limits: { fileSize: 100 * 1024 * 1024 },
});

const s3Client = new S3Client({
  region: env.STORAGE_S3_REGION,
  endpoint: env.STORAGE_S3_ENDPOINT,
  forcePathStyle: env.STORAGE_S3_FORCE_PATH_STYLE,
  credentials: {
    accessKeyId: env.STORAGE_S3_ACCESS_KEY,
    secretAccessKey: env.STORAGE_S3_SECRET_KEY,
  },
});

const objectPrefix = env.STORAGE_PREFIX.replace(/^\/|\/$/g, "");
const publicBaseUrl = env.STORAGE_PUBLIC_BASE_URL.replace(/\/$/, "");

const encodeKeyForUrl = (key: string) =>
  key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");

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
    const command = new PutObjectCommand({
      Bucket: env.STORAGE_S3_BUCKET,
      Key: key,
      Body: file.buffer,
      ContentType: file.mimetype || "application/octet-stream",
      ACL: env.STORAGE_S3_ACL,
    });
    await s3Client.send(command);
    const url = `${publicBaseUrl}/${encodeKeyForUrl(key)}`;
    res.json({ url, path: key });
  } catch (error) {
    logger.error({ err: error }, "Failed to upload file to object storage");
    res.status(500).json({ message: "Upload failed" });
  }
});

export default router;
