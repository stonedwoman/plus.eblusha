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
const backupPrefixRaw = getArg("--backup-prefix");
const backupPrefix = backupPrefixRaw ? backupPrefixRaw.replace(/^\/|\/$/g, "") : null;
const bucket = env_1.default.STORAGE_S3_BUCKET;
const endpoint = env_1.default.STORAGE_S3_ENDPOINT;
const region = env_1.default.STORAGE_S3_REGION;
if (!bucket || !endpoint || !region) {
    throw new Error("Missing STORAGE_S3_BUCKET / STORAGE_S3_ENDPOINT / STORAGE_S3_REGION");
}
if (!env_1.default.STORAGE_S3_ACCESS_KEY || !env_1.default.STORAGE_S3_SECRET_KEY) {
    throw new Error("Missing STORAGE_S3_ACCESS_KEY / STORAGE_S3_SECRET_KEY (required for migration)");
}
if (!env_1.default.STORAGE_ENC_KEY) {
    throw new Error("Missing STORAGE_ENC_KEY (required to encrypt objects)");
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
async function main() {
    console.log("Encrypting S3 objects in-place");
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
    let token;
    let processed = 0;
    let encrypted = 0;
    let skippedAlready = 0;
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
            const key = obj.Key;
            if (!key)
                continue;
            if (limit && processed >= limit)
                break;
            processed += 1;
            try {
                const head = await s3.send(new client_s3_1.HeadObjectCommand({ Bucket: bucket, Key: key }));
                const isAlready = head.Metadata?.enc === "ebp1";
                const contentLength = head.ContentLength ?? obj.Size ?? 0;
                if (isAlready) {
                    skippedAlready += 1;
                    continue;
                }
                if (maxBytes && contentLength && contentLength > maxBytes) {
                    console.log("SKIP too large:", key, contentLength);
                    skippedTooLarge += 1;
                    continue;
                }
                const get = await s3.send(new client_s3_1.GetObjectCommand({ Bucket: bucket, Key: key }));
                const bodyBuf = await readBodyToBuffer(get.Body);
                // If it was encrypted but missing metadata, don't double-encrypt.
                if ((0, storageEncryption_1.isEncryptedPayload)(bodyBuf)) {
                    console.log("SKIP already encrypted (magic, metadata missing):", key);
                    skippedAlready += 1;
                    continue;
                }
                const originalCt = get.ContentType || head.ContentType || "application/octet-stream";
                const { payload, meta } = (0, storageEncryption_1.encryptBuffer)(bodyBuf, encKey, { aad: key, contentType: originalCt });
                if (dryRun) {
                    console.log("DRY encrypt:", key, "bytes:", bodyBuf.length, "->", payload.length);
                    encrypted += 1;
                    continue;
                }
                if (backupPrefix) {
                    const backupKey = `${backupPrefix}/${key}`;
                    try {
                        await s3.send(new client_s3_1.PutObjectCommand({
                            Bucket: bucket,
                            Key: backupKey,
                            Body: bodyBuf,
                            ContentType: originalCt,
                        }));
                    }
                    catch (e) {
                        console.error("ERR backup PutObject:", backupKey, e?.name || e?.Code || e?.message || e, "status=", e?.$metadata?.httpStatusCode ?? "");
                        throw e;
                    }
                    console.log("Backup saved:", backupKey);
                }
                try {
                    await s3.send(new client_s3_1.PutObjectCommand({
                        Bucket: bucket,
                        Key: key,
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
                }
                catch (e) {
                    console.error("ERR main PutObject:", key, e?.name || e?.Code || e?.message || e, "status=", e?.$metadata?.httpStatusCode ?? "");
                    throw e;
                }
                console.log("OK encrypted:", key);
                encrypted += 1;
            }
            catch (e) {
                errors += 1;
                console.error("ERR:", key, e?.name || e?.Code || e?.message || e, "status=", e?.$metadata?.httpStatusCode ?? "");
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
    console.log("Encrypted:", encrypted);
    console.log("Skipped already:", skippedAlready);
    console.log("Skipped too large:", skippedTooLarge);
    console.log("Errors:", errors);
}
main().catch((e) => {
    console.error(e);
    process.exit(1);
});
//# sourceMappingURL=encryptS3Objects.js.map