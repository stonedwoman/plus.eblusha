"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const multer_1 = __importDefault(require("multer"));
const path_1 = __importDefault(require("path"));
const crypto_1 = __importDefault(require("crypto"));
const client_s3_1 = require("@aws-sdk/client-s3");
const auth_1 = require("../middlewares/auth");
const env_1 = __importDefault(require("../config/env"));
const logger_1 = __importDefault(require("../config/logger"));
const storageEncryption_1 = require("../lib/storageEncryption");
const router = (0, express_1.Router)();
const upload = (0, multer_1.default)({
    storage: multer_1.default.memoryStorage(),
    // Increase max size to 100MB to support typical documents/archives
    limits: { fileSize: 100 * 1024 * 1024 },
});
const s3Config = env_1.default.STORAGE_S3_ENDPOINT &&
    env_1.default.STORAGE_S3_REGION &&
    env_1.default.STORAGE_S3_BUCKET &&
    env_1.default.STORAGE_PUBLIC_BASE_URL
    ? {
        endpoint: env_1.default.STORAGE_S3_ENDPOINT,
        region: env_1.default.STORAGE_S3_REGION,
        bucket: env_1.default.STORAGE_S3_BUCKET,
        accessKeyId: env_1.default.STORAGE_S3_ACCESS_KEY || undefined,
        secretAccessKey: env_1.default.STORAGE_S3_SECRET_KEY || undefined,
        publicBaseUrl: env_1.default.STORAGE_PUBLIC_BASE_URL.replace(/\/$/, ""),
    }
    : null;
const s3Client = s3Config
    ? new client_s3_1.S3Client({
        region: s3Config.region,
        endpoint: s3Config.endpoint,
        forcePathStyle: env_1.default.STORAGE_S3_FORCE_PATH_STYLE,
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
const objectPrefix = env_1.default.STORAGE_PREFIX.replace(/^\/|\/$/g, "");
if (s3Client && s3Config) {
    logger_1.default.info({
        endpoint: s3Config.endpoint,
        region: s3Config.region,
        bucket: s3Config.bucket,
        publicBaseUrl: s3Config.publicBaseUrl,
        forcePathStyle: env_1.default.STORAGE_S3_FORCE_PATH_STYLE,
        objectPrefix,
    }, "S3 upload initialized");
}
const encKey = env_1.default.STORAGE_ENC_KEY ? (0, storageEncryption_1.parseStorageEncKey)(env_1.default.STORAGE_ENC_KEY) : null;
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
router.use(auth_1.authenticate);
router.post("/", upload.single("file"), async (req, res) => {
    const file = req.file;
    if (!file) {
        res.status(400).json({ message: "No file" });
        return;
    }
    // If app-level encryption is enabled, hide the original extension in S3 object keys.
    // Clients will rely on Content-Type from our proxy response (stored in object metadata).
    const ext = encKey ? ".eblusha" : path_1.default.extname(file.originalname || "") || ".bin";
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
        let bodyToUpload = file.buffer;
        let encryptionMeta = null;
        let originalContentType = file.mimetype || "application/octet-stream";
        // Optional app-level encryption: store only ciphertext in S3. Decrypt in /api/files.
        // AAD binds ciphertext to its object key (prevents key-swapping attacks inside the bucket).
        if (encKey) {
            const encrypted = (0, storageEncryption_1.encryptBuffer)(file.buffer, encKey, {
                aad: key,
                contentType: originalContentType,
            });
            bodyToUpload = encrypted.payload;
            encryptionMeta = encrypted.meta;
            // ciphertext shouldn't advertise original type
            originalContentType = "application/octet-stream";
        }
        const putObjectParams = {
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
        const command = new client_s3_1.PutObjectCommand(putObjectParams);
        await s3Client.send(command);
        const encodedKey = encodeKeyForUrl(key);
        // If encrypted, direct S3 URL is useless (ciphertext). Return proxy URL so client always hits server.
        const publicUrl = encKey
            ? `/api/files/${encodedKey}`
            : `${s3Config.publicBaseUrl}/${encodedKey}`;
        res.json({ url: publicUrl, path: key, publicUrl });
    }
    catch (error) {
        logger_1.default.error({ err: error }, "Failed to upload file to S3");
        res.status(500).json({ message: "Upload failed" });
    }
});
exports.default = router;
//# sourceMappingURL=upload.js.map