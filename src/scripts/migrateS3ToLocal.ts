#!/usr/bin/env npx ts-node
/**
 * Migrate files from S3 to local storage.
 *
 * Prerequisites:
 * - STORAGE_BACKEND=local and LOCAL_STORAGE_PATH set (or will use default)
 * - S3 credentials still in .env (STORAGE_S3_*)
 *
 * Usage:
 *   npx ts-node src/scripts/migrateS3ToLocal.ts
 *   npx ts-node src/scripts/migrateS3ToLocal.ts --dry-run
 *   npx ts-node src/scripts/migrateS3ToLocal.ts --limit 10
 *
 * After migration, all files will be in LOCAL_STORAGE_PATH. URLs in DB stay
 * unchanged (/api/files/uploads/xxx.eblusha) — they will work seamlessly.
 */

import fs from "fs";
import path from "path";
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import env from "../config/env";

const dryRun = process.argv.includes("--dry-run");
const limitArg = process.argv.indexOf("--limit");
const limit = limitArg >= 0 ? parseInt(process.argv[limitArg + 1] ?? "0", 10) : 0;

const bucket = env.STORAGE_S3_BUCKET;
const endpoint = env.STORAGE_S3_ENDPOINT;
const region = env.STORAGE_S3_REGION;
const prefix =
  (env.STORAGE_PREFIX ?? "uploads").replace(/^\/|\/$/g, "") + "/";
const basePath = path.resolve(env.LOCAL_STORAGE_PATH ?? "/var/lib/eblusha/storage");

if (!bucket || !endpoint || !region) {
  throw new Error(
    "Missing S3 config. Set STORAGE_S3_ENDPOINT, STORAGE_S3_REGION, STORAGE_S3_BUCKET"
  );
}
if (!env.STORAGE_S3_ACCESS_KEY || !env.STORAGE_S3_SECRET_KEY) {
  throw new Error(
    "Missing S3 credentials. Set STORAGE_S3_ACCESS_KEY, STORAGE_S3_SECRET_KEY"
  );
}

const s3 = new S3Client({
  region,
  endpoint,
  forcePathStyle: env.STORAGE_S3_FORCE_PATH_STYLE,
  credentials: {
    accessKeyId: env.STORAGE_S3_ACCESS_KEY,
    secretAccessKey: env.STORAGE_S3_SECRET_KEY,
  },
});

async function readBodyToBuffer(body: any): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  if (typeof body.pipe === "function") {
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      body.on("data", (c: any) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      body.on("end", () => resolve());
      body.on("error", reject);
    });
    return Buffer.concat(chunks);
  }
  const arrayBuffer =
    (await body.transformToByteArray?.()) || (await body.arrayBuffer?.());
  if (arrayBuffer) return Buffer.from(arrayBuffer);
  throw new Error("Unsupported S3 body");
}

function resolveLocalPath(key: string): string {
  const normalized = key.replace(/^\/+/, "").replace(/\.\./g, "");
  if (path.isAbsolute(normalized) || normalized.includes("\\")) {
    throw new Error(`Invalid key: ${key}`);
  }
  return path.join(basePath, normalized);
}

async function main() {
  console.log("S3 → Local migration");
  console.log("  S3 bucket:", bucket);
  console.log("  S3 prefix:", prefix);
  console.log("  Local path:", basePath);
  console.log("  Dry-run:", dryRun);
  if (limit) console.log("  Limit:", limit);

  if (!dryRun) {
    fs.mkdirSync(basePath, { recursive: true });
  }

  let token: string | undefined;
  let processed = 0;
  let migrated = 0;
  let skipped = 0;
  let errors = 0;

  while (true) {
    const page = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: token,
        MaxKeys: 500,
      })
    );

    for (const obj of page.Contents ?? []) {
      const key = obj.Key;
      if (!key) continue;
      if (limit && processed >= limit) break;

      processed += 1;

      try {
        const localPath = resolveLocalPath(key);
        if (!dryRun && fs.existsSync(localPath) && fs.statSync(localPath).isFile()) {
          skipped += 1;
          if (processed % 100 === 0) process.stdout.write(".");
          continue;
        }

        const head = await s3.send(
          new HeadObjectCommand({ Bucket: bucket, Key: key })
        );
        const get = await s3.send(
          new GetObjectCommand({ Bucket: bucket, Key: key })
        );
        const bodyBuf = await readBodyToBuffer(get.Body);

        const meta = (get.Metadata ?? head.Metadata ?? {}) as Record<string, string>;

        if (dryRun) {
          console.log("DRY migrate:", key, "bytes:", bodyBuf.length);
          migrated += 1;
          continue;
        }

        const dir = path.dirname(localPath);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(localPath, bodyBuf);

        const metaPath = localPath + ".meta.json";
        const metaJson: Record<string, string> = {
          ct: meta.ct || meta.contentType || "application/octet-stream",
          ...meta,
        };
        fs.writeFileSync(metaPath, JSON.stringify(metaJson));

        migrated += 1;
        if (migrated % 50 === 0) {
          console.log("Migrated", migrated, "...", key);
        }
      } catch (e: any) {
        errors += 1;
        console.error("ERR:", key, e?.message ?? e);
      }
    }

    if (limit && processed >= limit) break;
    if (!page.IsTruncated || !page.NextContinuationToken) break;
    token = page.NextContinuationToken;
  }

  console.log("\nDone.");
  console.log("  Processed:", processed);
  console.log("  Migrated:", migrated);
  console.log("  Skipped (already exist):", skipped);
  console.log("  Errors:", errors);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
