"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const client_s3_1 = require("@aws-sdk/client-s3");
const env_1 = __importDefault(require("../config/env"));
const storageEncryption_1 = require("../lib/storageEncryption");
const hasFlag = (flag) => process.argv.includes(flag);
const getArg = (name) => {
    const idx = process.argv.indexOf(name);
    if (idx === -1)
        return null;
    return process.argv[idx + 1] ?? null;
};
const dryRun = hasFlag("--dry-run");
const limit = Number(getArg("--limit") ?? "0") || 0;
const maxBytes = Number(getArg("--max-bytes") ?? "0") || 0; // 0 => unlimited
const deleteOld = hasFlag("--delete-old");
const backupPrefixRaw = getArg("--backup-prefix");
const backupPrefix = backupPrefixRaw ? backupPrefixRaw.replace(/^\/|\/$/g, "") : null;
const bucket = env_1.default.STORAGE_S3_BUCKET;
const endpoint = env_1.default.STORAGE_S3_ENDPOINT;
const region = env_1.default.STORAGE_S3_REGION;
if (!bucket || !endpoint || !region) {
    throw new Error("Missing STORAGE_S3_BUCKET / STORAGE_S3_ENDPOINT / STORAGE_S3_REGION");
}
if (!env_1.default.STORAGE_S3_ACCESS_KEY || !env_1.default.STORAGE_S3_SECRET_KEY) {
    throw new Error("Missing STORAGE_S3_ACCESS_KEY / STORAGE_S3_SECRET_KEY");
}
if (!env_1.default.STORAGE_ENC_KEY) {
    throw new Error("Missing STORAGE_ENC_KEY (required for migration)");
}
const encKey = (0, storageEncryption_1.parseStorageEncKey)(env_1.default.STORAGE_ENC_KEY);
const prefix = (getArg("--prefix") ?? env_1.default.STORAGE_PREFIX ?? "uploads").replace(/^\/|\/$/g, "") + "/";
const s3 = new client_s3_1.S3Client({
    region,
    endpoint,
    forcePathStyle: env_1.default.STORAGE_S3_FORCE_PATH_STYLE,
    credentials: {
        accessKeyId: env_1.default.STORAGE_S3_ACCESS_KEY,
        secretAccessKey: env_1.default.STORAGE_S3_SECRET_KEY,
    },
});
const readBodyToBuffer = async (body) => {
    if (!body)
        return Buffer.alloc(0);
    if (typeof body.pipe === "function") {
        const chunks = [];
        await new Promise((resolve, reject) => {
            body.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
            body.on("end", () => resolve());
            body.on("error", (e) => reject(e));
        });
        return Buffer.concat(chunks);
    }
    if (body instanceof ReadableStream || typeof body.getReader === "function") {
        const reader = body.getReader();
        const chunks = [];
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                if (value)
                    chunks.push(value);
            }
        }
        finally {
            reader.releaseLock();
        }
        return Buffer.concat(chunks.map((c) => Buffer.from(c)));
    }
    const arrayBuffer = (await body.transformToByteArray?.()) || (await body.arrayBuffer?.());
    if (arrayBuffer)
        return Buffer.from(arrayBuffer);
    throw new Error("Unsupported S3 body type");
};
const toEblushaKey = (k) => {
    if (k.endsWith(".eblusha"))
        return k;
    const parts = k.split("/");
    const base = parts.pop() ?? "";
    if (!base)
        return `${k}.eblusha`;
    const dot = base.lastIndexOf(".");
    const baseNoExt = dot > 0 ? base.slice(0, dot) : base;
    parts.push(`${baseNoExt}.eblusha`);
    return parts.join("/");
};
async function exists(key) {
    try {
        await s3.send(new client_s3_1.HeadObjectCommand({ Bucket: bucket, Key: key }));
        return true;
    }
    catch (e) {
        if (e?.$metadata?.httpStatusCode === 404 || e?.name === "NotFound" || e?.name === "NoSuchKey") {
            return false;
        }
        throw e;
    }
}
async function main() {
    console.log("Migrating S3 keys to *.eblusha");
    console.log("Bucket:", bucket);
    console.log("Endpoint:", endpoint);
    console.log("Prefix:", prefix);
    console.log("Dry-run:", dryRun);
    if (limit)
        console.log("Limit:", limit);
    if (maxBytes)
        console.log("Max bytes:", maxBytes);
    if (backupPrefix)
        console.log("Backup prefix:", backupPrefix);
    console.log("Delete old:", deleteOld);
    let token;
    let processed = 0;
    let migrated = 0;
    let skippedAlready = 0;
    let skippedExists = 0;
    let skippedTooLarge = 0;
    let errors = 0;
    while (true) {
        const page = await s3.send(new client_s3_1.ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            ContinuationToken: token,
            MaxKeys: 1000,
        }));
        for (const obj of page.Contents ?? []) {
            const oldKey = obj.Key;
            if (!oldKey)
                continue;
            if (limit && processed >= limit)
                break;
            processed += 1;
            if (oldKey.endsWith(".eblusha")) {
                skippedAlready += 1;
                continue;
            }
            const newKey = toEblushaKey(oldKey);
            try {
                const head = await s3.send(new client_s3_1.HeadObjectCommand({ Bucket: bucket, Key: oldKey }));
                const contentLength = head.ContentLength ?? obj.Size ?? 0;
                if (maxBytes && contentLength && contentLength > maxBytes) {
                    skippedTooLarge += 1;
                    continue;
                }
                if (await exists(newKey)) {
                    console.log("SKIP new key exists:", newKey);
                    skippedExists += 1;
                    continue;
                }
                const get = await s3.send(new client_s3_1.GetObjectCommand({ Bucket: bucket, Key: oldKey }));
                const raw = await readBodyToBuffer(get.Body);
                if (backupPrefix && !dryRun) {
                    const backupKey = `${backupPrefix}/${oldKey}`;
                    await s3.send(new client_s3_1.PutObjectCommand({
                        Bucket: bucket,
                        Key: backupKey,
                        Body: raw,
                        ContentType: get.ContentType || head.ContentType || "application/octet-stream",
                    }));
                    console.log("Backup saved:", backupKey);
                }
                const isEnc = head.Metadata?.enc === "ebp1" || (0, storageEncryption_1.isEncryptedPayload)(raw);
                let plaintext;
                let originalCt = head.Metadata?.ct || get.ContentType || head.ContentType || "application/octet-stream";
                if (isEnc) {
                    plaintext = (0, storageEncryption_1.decryptBuffer)(raw, encKey, { aad: oldKey });
                    // prefer stored CT if present
                    if (head.Metadata?.ct)
                        originalCt = head.Metadata.ct;
                }
                else {
                    plaintext = raw;
                }
                const { payload, meta } = (0, storageEncryption_1.encryptBuffer)(plaintext, encKey, { aad: newKey, contentType: originalCt });
                if (dryRun) {
                    console.log("DRY migrate:", oldKey, "->", newKey);
                    migrated += 1;
                    continue;
                }
                await s3.send(new client_s3_1.PutObjectCommand({
                    Bucket: bucket,
                    Key: newKey,
                    Body: payload,
                    ContentType: "application/octet-stream",
                    Metadata: {
                        enc: "ebp1",
                        encv: meta.v,
                        encalg: meta.alg,
                        enciv: meta.iv,
                        enctag: meta.tag,
                        ct: meta.ct || "",
                    },
                }));
                if (deleteOld) {
                    await s3.send(new client_s3_1.DeleteObjectCommand({ Bucket: bucket, Key: oldKey }));
                }
                console.log("OK:", oldKey, "->", newKey, deleteOld ? "(deleted old)" : "");
                migrated += 1;
            }
            catch (e) {
                errors += 1;
                console.error("ERR:", oldKey, e?.name || e?.Code || e?.message || e, "status=", e?.$metadata?.httpStatusCode ?? "");
            }
        }
        if (limit && processed >= limit)
            break;
        if (!page.IsTruncated || !page.NextContinuationToken)
            break;
        token = page.NextContinuationToken;
    }
    console.log("Done.");
    console.log("Processed:", processed);
    console.log("Migrated:", migrated);
    console.log("Skipped already .eblusha:", skippedAlready);
    console.log("Skipped new key exists:", skippedExists);
    console.log("Skipped too large:", skippedTooLarge);
    console.log("Errors:", errors);
}
main().catch((e) => {
    console.error(e);
    process.exit(1);
});
//# sourceMappingURL=migrateKeysToEblusha.js.map