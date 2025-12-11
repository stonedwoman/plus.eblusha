"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const fs_2 = require("fs");
const client_s3_1 = require("@aws-sdk/client-s3");
const client_1 = require("@prisma/client");
const env_1 = __importDefault(require("../config/env"));
const prisma = new client_1.PrismaClient();
const uploadsDir = path_1.default.join(process.cwd(), "uploads");
const archiveDir = path_1.default.join(uploadsDir, "_migrated");
const keepLocal = process.argv.includes("--keep-local");
const skipUpload = process.argv.includes("--skip-upload");
const missingS3Vars = [
    "STORAGE_S3_ENDPOINT",
    "STORAGE_S3_REGION",
    "STORAGE_S3_BUCKET",
    "STORAGE_S3_ACCESS_KEY",
    "STORAGE_S3_SECRET_KEY",
].filter((key) => !env_1.default[key]);
// For proxy URLs, we need API base URL (e.g., https://ru.eblusha.org)
// If not set, we'll try to extract from STORAGE_PUBLIC_BASE_URL or use default
const apiBaseUrl = process.env.API_BASE_URL ||
    (env_1.default.STORAGE_PUBLIC_BASE_URL && typeof env_1.default.STORAGE_PUBLIC_BASE_URL === 'string'
        ? new URL(env_1.default.STORAGE_PUBLIC_BASE_URL).origin
        : "http://localhost:3000");
if (!skipUpload && missingS3Vars.length > 0) {
    throw new Error(`Missing S3 configuration variables: ${missingS3Vars.join(", ")}.`);
}
const s3Client = skipUpload
    ? null
    : new client_s3_1.S3Client({
        region: env_1.default.STORAGE_S3_REGION,
        endpoint: env_1.default.STORAGE_S3_ENDPOINT,
        forcePathStyle: env_1.default.STORAGE_S3_FORCE_PATH_STYLE,
        credentials: {
            accessKeyId: env_1.default.STORAGE_S3_ACCESS_KEY,
            secretAccessKey: env_1.default.STORAGE_S3_SECRET_KEY,
        },
    });
const objectPrefix = env_1.default.STORAGE_PREFIX.replace(/^\/|\/$/g, "");
// Use proxy URL instead of direct S3 URL to avoid blocking in Russia
const proxyBaseUrl = apiBaseUrl.replace(/\/$/, "");
const resolvedAcl = env_1.default.STORAGE_S3_ACL;
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
    console.warn(`Ignoring unsupported STORAGE_S3_SSE value: ${value}, falling back to no encryption`);
    return undefined;
};
const encodeKeyForUrl = (key) => key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
const suffixesForFile = (fileName) => [
    `/api/uploads/${fileName}`,
    `/uploads/${fileName}`,
    fileName,
];
const guessContentType = (fileName) => {
    switch (path_1.default.extname(fileName).toLowerCase()) {
        case ".png":
            return "image/png";
        case ".jpg":
        case ".jpeg":
            return "image/jpeg";
        case ".gif":
            return "image/gif";
        case ".webp":
            return "image/webp";
        case ".svg":
            return "image/svg+xml";
        case ".mp4":
            return "video/mp4";
        case ".mp3":
            return "audio/mpeg";
        case ".wav":
            return "audio/wav";
        case ".webm":
            return "audio/webm";
        case ".ogg":
            return "audio/ogg";
        case ".pdf":
            return "application/pdf";
        case ".txt":
            return "text/plain";
        case ".json":
            return "application/json";
        case ".heic":
            return "image/heic";
        default:
            return "application/octet-stream";
    }
};
const buildOrConditions = (field, fileName) => suffixesForFile(fileName).map((suffix) => ({
    [field]: { endsWith: suffix },
}));
const migrateFile = async (fileName) => {
    const filePath = path_1.default.join(uploadsDir, fileName);
    // Preserve directory structure in S3 key
    const key = objectPrefix ? `${objectPrefix}/${fileName}` : fileName;
    const contentType = guessContentType(fileName);
    const body = fs_1.default.createReadStream(filePath);
    if (!skipUpload) {
        if (!s3Client)
            throw new Error("S3 client not initialized");
        try {
            // Hetzner Object Storage may not support ACL/SSE parameters
            // Try without them first, add back if needed for other providers
            await s3Client.send(new client_s3_1.PutObjectCommand({
                Bucket: env_1.default.STORAGE_S3_BUCKET,
                Key: key,
                Body: body,
                ContentType: contentType,
                // ACL and SSE disabled for Hetzner compatibility
                // ACL: resolvedAcl,
                // ServerSideEncryption: resolveServerSideEncryption(env.STORAGE_S3_SSE),
            }));
        }
        finally {
            body.close();
        }
    }
    else {
        body.close();
    }
    // Use proxy URL: /api/files/{encodedKey}
    const encodedKey = encodeKeyForUrl(key);
    const publicUrl = `${proxyBaseUrl}/api/files/${encodedKey}`;
    const attachmentResult = await prisma.messageAttachment.updateMany({
        where: { OR: buildOrConditions("url", fileName) },
        data: { url: publicUrl },
    });
    const userResult = await prisma.user.updateMany({
        where: { OR: buildOrConditions("avatarUrl", fileName) },
        data: { avatarUrl: publicUrl },
    });
    const conversationResult = await prisma.conversation.updateMany({
        where: { OR: buildOrConditions("avatarUrl", fileName) },
        data: { avatarUrl: publicUrl },
    });
    if (!keepLocal) {
        await fs_2.promises.mkdir(archiveDir, { recursive: true });
        await moveToArchive(filePath, fileName);
    }
    return {
        url: publicUrl,
        attachments: attachmentResult.count,
        userAvatars: userResult.count,
        conversationAvatars: conversationResult.count,
    };
};
const moveToArchive = async (filePath, fileName) => {
    let targetPath = path_1.default.join(archiveDir, fileName);
    const parsed = path_1.default.parse(fileName);
    let counter = 1;
    while (await exists(targetPath)) {
        targetPath = path_1.default.join(archiveDir, `${parsed.name}-${counter}${parsed.ext}`);
        counter += 1;
    }
    await fs_2.promises.rename(filePath, targetPath);
};
const exists = async (target) => {
    try {
        await fs_2.promises.access(target);
        return true;
    }
    catch {
        return false;
    }
};
const isMigratableFile = (entry) => entry.isFile() && !entry.name.startsWith(".");
const getAllFiles = async (dir, baseDir = dir) => {
    const files = [];
    const entries = await fs_2.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path_1.default.join(dir, entry.name);
        if (entry.isDirectory()) {
            const subFiles = await getAllFiles(fullPath, baseDir);
            files.push(...subFiles);
        }
        else if (entry.isFile() && !entry.name.startsWith(".")) {
            const relativePath = path_1.default.relative(baseDir, fullPath);
            files.push(relativePath);
        }
    }
    return files;
};
const main = async () => {
    if (!fs_1.default.existsSync(uploadsDir)) {
        console.log("No uploads directory, nothing to migrate.");
        return;
    }
    const files = await getAllFiles(uploadsDir);
    let processed = 0;
    for (const fileName of files) {
        try {
            const summary = await migrateFile(fileName);
            processed += 1;
            console.log(`✓ ${fileName} -> ${summary.url} (attachments=${summary.attachments}, userAvatars=${summary.userAvatars}, conversationAvatars=${summary.conversationAvatars})`);
        }
        catch (error) {
            console.error(`✗ Failed to migrate ${fileName}`, error);
        }
    }
    console.log(`Completed migration for ${processed} files.`);
};
main()
    .catch((error) => {
    console.error("Migration failed", error);
    process.exitCode = 1;
})
    .finally(async () => {
    await prisma.$disconnect();
});
//# sourceMappingURL=migrateUploads.js.map