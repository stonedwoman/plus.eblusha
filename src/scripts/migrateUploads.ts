import path from "path";
import fs from "fs";
import { promises as fsPromises } from "fs";
import type { Dirent } from "fs";
import {
  S3Client,
  PutObjectCommand,
  type ObjectCannedACL,
  ServerSideEncryption,
} from "@aws-sdk/client-s3";
import { PrismaClient } from "@prisma/client";
import env from "../config/env";

const prisma = new PrismaClient();

const uploadsDir = path.join(process.cwd(), "uploads");
const archiveDir = path.join(uploadsDir, "_migrated");
const keepLocal = process.argv.includes("--keep-local");

const skipUpload = process.argv.includes("--skip-upload");

const missingS3Vars = [
  "STORAGE_S3_ENDPOINT",
  "STORAGE_S3_REGION",
  "STORAGE_S3_BUCKET",
  "STORAGE_S3_ACCESS_KEY",
  "STORAGE_S3_SECRET_KEY",
].filter((key) => !(env as Record<string, unknown>)[key]);

// For proxy URLs, we need API base URL (e.g., https://ru.eblusha.org)
// If not set, we'll try to extract from STORAGE_PUBLIC_BASE_URL or use default
const apiBaseUrl = process.env.API_BASE_URL || 
  (env.STORAGE_PUBLIC_BASE_URL && typeof env.STORAGE_PUBLIC_BASE_URL === 'string'
    ? new URL(env.STORAGE_PUBLIC_BASE_URL).origin 
    : "http://localhost:3000");

if (!skipUpload && missingS3Vars.length > 0) {
  throw new Error(
    `Missing S3 configuration variables: ${missingS3Vars.join(", ")}.`,
  );
}

const s3Client = skipUpload
  ? null
  : new S3Client({
      region: env.STORAGE_S3_REGION!,
      endpoint: env.STORAGE_S3_ENDPOINT!,
      forcePathStyle: env.STORAGE_S3_FORCE_PATH_STYLE,
      credentials: {
        accessKeyId: env.STORAGE_S3_ACCESS_KEY!,
        secretAccessKey: env.STORAGE_S3_SECRET_KEY!,
      },
    });

const objectPrefix = env.STORAGE_PREFIX.replace(/^\/|\/$/g, "");
// Use proxy URL instead of direct S3 URL to avoid blocking in Russia
const proxyBaseUrl = apiBaseUrl.replace(/\/$/, "");
const resolvedAcl = env.STORAGE_S3_ACL as ObjectCannedACL | undefined;

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
  console.warn(
    `Ignoring unsupported STORAGE_S3_SSE value: ${value}, falling back to no encryption`
  );
  return undefined;
};

const encodeKeyForUrl = (key: string) =>
  key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");

const suffixesForFile = (fileName: string) => [
  `/api/uploads/${fileName}`,
  `/uploads/${fileName}`,
  fileName,
];

const guessContentType = (fileName: string) => {
  switch (path.extname(fileName).toLowerCase()) {
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

const buildOrConditions = (field: string, fileName: string) =>
  suffixesForFile(fileName).map((suffix) => ({
    [field]: { endsWith: suffix },
  }));

const migrateFile = async (fileName: string) => {
  const filePath = path.join(uploadsDir, fileName);
  // Preserve directory structure in S3 key
  const key = objectPrefix ? `${objectPrefix}/${fileName}` : fileName;
  const contentType = guessContentType(fileName);
  const body = fs.createReadStream(filePath);

  if (!skipUpload) {
    if (!s3Client) throw new Error("S3 client not initialized");
    try {
      // Hetzner Object Storage may not support ACL/SSE parameters
      // Try without them first, add back if needed for other providers
      await s3Client.send(
        new PutObjectCommand({
          Bucket: env.STORAGE_S3_BUCKET!,
          Key: key,
          Body: body,
          ContentType: contentType,
          // ACL and SSE disabled for Hetzner compatibility
          // ACL: resolvedAcl,
          // ServerSideEncryption: resolveServerSideEncryption(env.STORAGE_S3_SSE),
        }),
      );
    } finally {
      body.close();
    }
  } else {
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
    await fsPromises.mkdir(archiveDir, { recursive: true });
    await moveToArchive(filePath, fileName);
  }

  return {
    url: publicUrl,
    attachments: attachmentResult.count,
    userAvatars: userResult.count,
    conversationAvatars: conversationResult.count,
  };
};

const moveToArchive = async (filePath: string, fileName: string) => {
  let targetPath = path.join(archiveDir, fileName);
  const parsed = path.parse(fileName);
  let counter = 1;
  while (await exists(targetPath)) {
    targetPath = path.join(
      archiveDir,
      `${parsed.name}-${counter}${parsed.ext}`,
    );
    counter += 1;
  }
  await fsPromises.rename(filePath, targetPath);
};

const exists = async (target: string) => {
  try {
    await fsPromises.access(target);
    return true;
  } catch {
    return false;
  }
};

const isMigratableFile = (entry: Dirent) =>
  entry.isFile() && !entry.name.startsWith(".");

const getAllFiles = async (dir: string, baseDir: string = dir): Promise<string[]> => {
  const files: string[] = [];
  const entries = await fsPromises.readdir(dir, { withFileTypes: true });
  
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const subFiles = await getAllFiles(fullPath, baseDir);
      files.push(...subFiles);
    } else if (entry.isFile() && !entry.name.startsWith(".")) {
      const relativePath = path.relative(baseDir, fullPath);
      files.push(relativePath);
    }
  }
  
  return files;
};

const main = async () => {
  if (!fs.existsSync(uploadsDir)) {
    console.log("No uploads directory, nothing to migrate.");
    return;
  }

  const files = await getAllFiles(uploadsDir);
  let processed = 0;
  
  for (const fileName of files) {
    try {
      const summary = await migrateFile(fileName);
      processed += 1;
      console.log(
        `✓ ${fileName} -> ${summary.url} (attachments=${summary.attachments}, userAvatars=${summary.userAvatars}, conversationAvatars=${summary.conversationAvatars})`,
      );
    } catch (error) {
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

