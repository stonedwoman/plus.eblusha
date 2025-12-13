"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const multer_1 = __importDefault(require("multer"));
const path_1 = __importDefault(require("path"));
const crypto_1 = __importDefault(require("crypto"));
const fs_1 = __importDefault(require("fs"));
const client_s3_1 = require("@aws-sdk/client-s3");
const auth_1 = require("../middlewares/auth");
const env_1 = __importDefault(require("../config/env"));
const logger_1 = __importDefault(require("../config/logger"));
const router = (0, express_1.Router)();
const upload = (0, multer_1.default)({
    storage: multer_1.default.memoryStorage(),
    // Increase max size to 100MB to support typical documents/archives
    limits: { fileSize: 100 * 1024 * 1024 },
});
const s3Config = env_1.default.STORAGE_S3_ENDPOINT &&
    env_1.default.STORAGE_S3_REGION &&
    env_1.default.STORAGE_S3_BUCKET &&
    env_1.default.STORAGE_S3_ACCESS_KEY &&
    env_1.default.STORAGE_S3_SECRET_KEY &&
    env_1.default.STORAGE_PUBLIC_BASE_URL
    ? {
        endpoint: env_1.default.STORAGE_S3_ENDPOINT,
        region: env_1.default.STORAGE_S3_REGION,
        bucket: env_1.default.STORAGE_S3_BUCKET,
        accessKeyId: env_1.default.STORAGE_S3_ACCESS_KEY,
        secretAccessKey: env_1.default.STORAGE_S3_SECRET_KEY,
        publicBaseUrl: env_1.default.STORAGE_PUBLIC_BASE_URL.replace(/\/$/, ""),
    }
    : null;
const s3Client = s3Config
    ? new client_s3_1.S3Client({
        region: s3Config.region,
        endpoint: s3Config.endpoint,
        forcePathStyle: env_1.default.STORAGE_S3_FORCE_PATH_STYLE,
        credentials: {
            accessKeyId: s3Config.accessKeyId,
            secretAccessKey: s3Config.secretAccessKey,
        },
    })
    : null;
const objectPrefix = env_1.default.STORAGE_PREFIX.replace(/^\/|\/$/g, "");
const encodeKeyForUrl = (key) => key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
const allowedObjectAcls = [
    "private",
    "public-read",
    "public-read-write",
    "authenticated-read",
    "aws-exec-read",
    "bucket-owner-read",
    "bucket-owner-full-control",
];
const resolveObjectAcl = (value) => {
    if (!value)
        return undefined;
    if (allowedObjectAcls.includes(value)) {
        return value;
    }
    logger_1.default.warn({ acl: value }, "Ignoring unsupported STORAGE_S3_ACL value, falling back to default permissions");
    return undefined;
};
const resolveServerSideEncryption = (value) => {
    if (!value)
        return undefined;
    const normalized = value.toUpperCase();
    if (normalized === "AES256") {
        return client_s3_1.ServerSideEncryption.AES256;
    }
    if (normalized === "AWS:KMS" || normalized === "AWS_KMS") {
        return client_s3_1.ServerSideEncryption.aws_kms;
    }
    logger_1.default.warn({ sse: value }, "Ignoring unsupported STORAGE_S3_SSE value, falling back to no encryption");
    return undefined;
};
const uploadsDir = path_1.default.join(process.cwd(), "uploads");
if (!fs_1.default.existsSync(uploadsDir)) {
    fs_1.default.mkdirSync(uploadsDir, { recursive: true });
}
router.use(auth_1.authenticate);
router.post("/", upload.single("file"), async (req, res) => {
    const file = req.file;
    if (!file) {
        res.status(400).json({ message: "No file" });
        return;
    }
    const ext = path_1.default.extname(file.originalname || "") || ".bin";
    const randomId = typeof crypto_1.default.randomUUID === "function"
        ? crypto_1.default.randomUUID()
        : crypto_1.default.randomBytes(16).toString("hex");
    const uniqueName = `${Date.now()}-${randomId}${ext}`;
    const key = objectPrefix ? `${objectPrefix}/${uniqueName}` : uniqueName;
    try {
        if (!s3Client || !s3Config) {
            logger_1.default.error("S3 storage is not configured. File uploads require S3 configuration.");
            res.status(500).json({
                message: "File storage is not configured. Please configure S3 storage."
            });
            return;
        }
        // All uploads go to S3 - no local fallback
        // Hetzner Object Storage may not support ACL/SSE parameters
        // Use them only if explicitly needed for other providers
        const putObjectParams = {
            Bucket: s3Config.bucket,
            Key: key,
            Body: file.buffer,
            ContentType: file.mimetype || "application/octet-stream",
        };
        // Note: twcstorage.ru (Russian S3) doesn't support ACL/SSE in PutObject
        // Similar to Hetzner, these parameters cause InvalidRequest errors
        // Uncomment if needed for AWS S3 or other providers that support it:
        // const acl = resolveObjectAcl(env.STORAGE_S3_ACL);
        // if (acl) putObjectParams.ACL = acl;
        // const sse = resolveServerSideEncryption(env.STORAGE_S3_SSE);
        // if (sse) putObjectParams.ServerSideEncryption = sse;
        const command = new client_s3_1.PutObjectCommand(putObjectParams);
        await s3Client.send(command);
        // Возвращаем прямую ссылку на S3 (без внутреннего прокси)
        const encodedKey = encodeKeyForUrl(key);
        const publicUrl = `${s3Config.publicBaseUrl}/${encodedKey}`;
        res.json({ url: publicUrl, path: key, publicUrl });
    }
    catch (error) {
        logger_1.default.error({ err: error }, "Failed to upload file to S3");
        res.status(500).json({ message: "Upload failed" });
    }
});
exports.default = router;
//# sourceMappingURL=upload.js.map