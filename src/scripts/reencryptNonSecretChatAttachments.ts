import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import env from "../config/env";
import prisma from "../lib/prisma";
import {
  decryptBuffer,
  encryptBuffer,
  isEncryptedPayload,
  parseStorageEncKey,
} from "../lib/storageEncryption";
import { getOrCreateNonSecretConversationDek } from "../lib/nonSecretChatEncryption";
import { extractS3KeyCandidatesFromUrl } from "../lib/storageDeletion";

const hasFlag = (flag: string) => process.argv.includes(flag);
const getArg = (name: string) => {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return null;
  return process.argv[idx + 1] ?? null;
};

const dryRun = hasFlag("--dry-run");
const limit = Number(getArg("--limit") ?? "0") || 0;
const maxBytes = Number(getArg("--max-bytes") ?? "0") || 0; // 0 => unlimited
const backupPrefixRaw = getArg("--backup-prefix");
const backupPrefix = backupPrefixRaw ? backupPrefixRaw.replace(/^\/|\/$/g, "") : null;

const bucket = env.STORAGE_S3_BUCKET;
const endpoint = env.STORAGE_S3_ENDPOINT;
const region = env.STORAGE_S3_REGION;

if (!bucket || !endpoint || !region) {
  throw new Error("Missing STORAGE_S3_BUCKET / STORAGE_S3_ENDPOINT / STORAGE_S3_REGION");
}
if (!env.STORAGE_S3_ACCESS_KEY || !env.STORAGE_S3_SECRET_KEY) {
  throw new Error("Missing STORAGE_S3_ACCESS_KEY / STORAGE_S3_SECRET_KEY (required for migration)");
}

const storageEncKey = env.STORAGE_ENC_KEY ? parseStorageEncKey(env.STORAGE_ENC_KEY) : null;

const s3 = new S3Client({
  region,
  endpoint,
  forcePathStyle: env.STORAGE_S3_FORCE_PATH_STYLE,
  credentials: {
    accessKeyId: env.STORAGE_S3_ACCESS_KEY,
    secretAccessKey: env.STORAGE_S3_SECRET_KEY,
  },
});

const readBodyToBuffer = async (body: any): Promise<Buffer> => {
  if (!body) return Buffer.alloc(0);
  if (typeof body.pipe === "function") {
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      body.on("data", (c: any) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      body.on("end", () => resolve());
      body.on("error", (e: any) => reject(e));
    });
    return Buffer.concat(chunks);
  }
  if (body instanceof ReadableStream || typeof body.getReader === "function") {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c)));
  }
  const arrayBuffer = (await body.transformToByteArray?.()) || (await body.arrayBuffer?.());
  if (arrayBuffer) return Buffer.from(arrayBuffer);
  throw new Error("Unsupported S3 body type");
};

async function resolveExistingKey(candidates: string[]): Promise<{ key: string; head: any } | null> {
  for (const key of candidates) {
    try {
      const head = await s3.send(new HeadObjectCommand({ Bucket: bucket!, Key: key }));
      return { key, head };
    } catch (e: any) {
      if (e?.name === "NotFound" || e?.$metadata?.httpStatusCode === 404) continue;
      // Some providers return 403 for missing keys; continue best-effort.
      if (e?.$metadata?.httpStatusCode === 403) continue;
      continue;
    }
  }
  return null;
}

async function main() {
  console.log("Re-encrypting non-secret chat attachments with per-conversation DEK");
  console.log("Bucket:", bucket);
  console.log("Endpoint:", endpoint);
  console.log("Dry-run:", dryRun);
  if (limit) console.log("Limit:", limit);
  if (maxBytes) console.log("Max bytes:", maxBytes);
  if (backupPrefix) console.log("Backup prefix:", backupPrefix);
  console.log("Has STORAGE_ENC_KEY:", !!storageEncKey);

  const rows = await prisma.messageAttachment.findMany({
    where: { message: { conversation: { isSecret: false } } },
    select: { url: true, message: { select: { conversationId: true } } },
    orderBy: { createdAt: "asc" },
  });

  const uniq = new Map<string, { url: string; conversationId: string }>();
  for (const r of rows) {
    const url = r.url;
    const conversationId = (r as any).message?.conversationId;
    if (typeof url !== "string" || !url) continue;
    if (typeof conversationId !== "string" || !conversationId) continue;
    const k = `${conversationId}::${url}`;
    if (!uniq.has(k)) uniq.set(k, { url, conversationId });
  }

  const list = Array.from(uniq.values());
  console.log("Unique attachments:", list.length);

  let processed = 0;
  let encrypted = 0;
  let skippedAlready = 0;
  let skippedTooLarge = 0;
  let skippedNoKey = 0;
  let errors = 0;

  for (const item of list) {
    if (limit && processed >= limit) break;
    processed += 1;

    const { url, conversationId } = item;
    const candidates = extractS3KeyCandidatesFromUrl(url);
    if (!candidates.length) {
      skippedNoKey += 1;
      continue;
    }

    const resolved = await resolveExistingKey(candidates);
    if (!resolved) {
      skippedNoKey += 1;
      continue;
    }

    const { key, head } = resolved;
    const meta = head.Metadata || {};
    const isAlreadyChatEnc = meta.enc === "ebp1" && meta.encscope === "chat" && meta.cid === conversationId;
    if (isAlreadyChatEnc) {
      skippedAlready += 1;
      continue;
    }

    const contentLength = head.ContentLength ?? 0;
    if (maxBytes && contentLength && contentLength > maxBytes) {
      skippedTooLarge += 1;
      continue;
    }

    try {
      const dek = await getOrCreateNonSecretConversationDek(conversationId);
      const get = await s3.send(new GetObjectCommand({ Bucket: bucket!, Key: key }));
      const bodyBuf = await readBodyToBuffer(get.Body);

      const originalCt = (meta.ct && String(meta.ct).trim()) || get.ContentType || head.ContentType || "application/octet-stream";

      let plaintext = bodyBuf;

      const isMetaEncrypted = meta.enc === "ebp1" || meta.encv === "1";
      const isMagicEncrypted = isEncryptedPayload(bodyBuf);

      if (isMetaEncrypted || isMagicEncrypted) {
        // If it's already chat-encrypted (but maybe wrong cid), don't risk corruption.
        if (meta.encscope === "chat") {
          // Wrong cid or missing cid: skip.
          errors += 1;
          console.warn("SKIP encrypted with encscope=chat but cid mismatch/missing:", key);
          continue;
        }
        // Otherwise assume STORAGE_ENC_KEY encryption (legacy).
        if (!storageEncKey) {
          errors += 1;
          console.warn("SKIP encrypted object but STORAGE_ENC_KEY is not set:", key);
          continue;
        }
        plaintext = decryptBuffer(bodyBuf, storageEncKey, { aad: key });
      }

      const { payload, meta: newMeta } = encryptBuffer(plaintext, dek, { aad: key, contentType: originalCt });

      if (dryRun) {
        encrypted += 1;
        continue;
      }

      if (backupPrefix) {
        const backupKey = `${backupPrefix}/${key}`;
        await s3.send(
          new PutObjectCommand({
            Bucket: bucket!,
            Key: backupKey,
            Body: bodyBuf,
            ContentType: head.ContentType || get.ContentType || "application/octet-stream",
            Metadata: head.Metadata,
          })
        );
      }

      await s3.send(
        new PutObjectCommand({
          Bucket: bucket!,
          Key: key,
          Body: payload,
          ContentType: "application/octet-stream",
          Metadata: {
            enc: "ebp1",
            encv: newMeta.v,
            encalg: newMeta.alg,
            enciv: newMeta.iv,
            enctag: newMeta.tag,
            ct: newMeta.ct || "",
            encscope: "chat",
            cid: conversationId,
          },
        })
      );

      encrypted += 1;
    } catch (e: any) {
      errors += 1;
      console.warn("ERR:", key, e?.name || e?.Code || e?.message || e);
    }
  }

  console.log("Done.");
  console.log("Processed:", processed);
  console.log("Encrypted:", encrypted);
  console.log("Skipped already:", skippedAlready);
  console.log("Skipped too large:", skippedTooLarge);
  console.log("Skipped no key:", skippedNoKey);
  console.log("Errors:", errors);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    try {
      await prisma.$disconnect();
    } catch {}
  });

