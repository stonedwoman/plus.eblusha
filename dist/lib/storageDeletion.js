"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractS3KeyCandidatesFromUrl = extractS3KeyCandidatesFromUrl;
exports.deleteS3ObjectsByUrls = deleteS3ObjectsByUrls;
const client_s3_1 = require("@aws-sdk/client-s3");
const env_1 = __importDefault(require("../config/env"));
const logger_1 = __importDefault(require("../config/logger"));
const splitSegments = (p) => p.split("/").filter(Boolean);
const decodePathSegments = (p) => p
    .split("/")
    .filter((s) => s.length > 0)
    .map((s) => decodeURIComponent(s))
    .join("/");
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
function isSafeKey(key) {
    if (!key)
        return false;
    if (key.includes(".."))
        return false;
    if (key.startsWith("/"))
        return false;
    return true;
}
function stripLeadingBucketSegment(decodedPath, bucket, prefix) {
    const segments = splitSegments(decodedPath);
    if (segments.length === 0)
        return decodedPath;
    const prefixSegments = splitSegments(prefix);
    if (prefixSegments.length > 0 && segments.length >= 1 + prefixSegments.length) {
        const maybePrefix = segments.slice(1, 1 + prefixSegments.length).join("/");
        if (maybePrefix === prefixSegments.join("/")) {
            return segments.slice(1).join("/");
        }
    }
    if (segments[0] === bucket) {
        return segments.slice(1).join("/");
    }
    return decodedPath;
}
function enforcePrefixCandidates(decodedPath, prefix) {
    const prefixNorm = prefix.replace(/^\/|\/$/g, "");
    const base = decodedPath.replace(/^\//, "");
    const candidates = [];
    const push = (k) => {
        const kk = k.replace(/^\//, "");
        if (!kk)
            return;
        if (!candidates.includes(kk))
            candidates.push(kk);
    };
    push(base);
    if (prefixNorm) {
        if (base === prefixNorm || base.startsWith(prefixNorm + "/"))
            push(base);
        else
            push(`${prefixNorm}/${base}`);
    }
    return candidates;
}
function extractS3KeyCandidatesFromUrl(url) {
    const bucket = env_1.default.STORAGE_S3_BUCKET;
    const prefix = env_1.default.STORAGE_PREFIX || "uploads";
    const publicBaseUrl = env_1.default.STORAGE_PUBLIC_BASE_URL;
    if (!bucket)
        return [];
    let pathname = "";
    try {
        // Relative URL support
        const parsed = new URL(url, "http://localhost");
        pathname = parsed.pathname || "";
    }
    catch {
        return [];
    }
    // Primary format: /api/files/<encodedKey>
    let afterApiFiles = null;
    if (pathname.startsWith("/api/files/")) {
        afterApiFiles = pathname.slice("/api/files/".length);
    }
    // Direct S3/public URL (path-style) also supported:
    // STORAGE_PUBLIC_BASE_URL=https://s3.twcstorage.ru/<bucket>
    // then pathname might be /<bucket>/<key> or /<bucket>/... depending on provider.
    if (!afterApiFiles && publicBaseUrl) {
        try {
            const base = new URL(publicBaseUrl);
            const parsed = new URL(url, base.origin);
            if (parsed.origin === base.origin) {
                // If url is exactly under the same origin, accept it.
                // We'll strip the bucket segment below if it is present.
                afterApiFiles = parsed.pathname.replace(/^\//, "");
            }
        }
        catch {
            // ignore
        }
    }
    if (!afterApiFiles)
        return [];
    const decodedPath = decodePathSegments(afterApiFiles).replace(/^\//, "");
    const stripped = stripLeadingBucketSegment(decodedPath, bucket, prefix);
    const keys = [
        ...enforcePrefixCandidates(decodedPath, prefix),
        ...enforcePrefixCandidates(stripped, prefix),
    ];
    const expanded = Array.from(new Set([...keys, ...keys.map(toEblushaKey)]));
    return expanded.filter(isSafeKey);
}
async function deleteS3ObjectsByUrls(urls, opts) {
    const bucket = env_1.default.STORAGE_S3_BUCKET;
    const endpoint = env_1.default.STORAGE_S3_ENDPOINT;
    const region = env_1.default.STORAGE_S3_REGION;
    if (!bucket || !endpoint || !region) {
        return { ok: false, reason: "s3_not_configured" };
    }
    const allKeys = urls.flatMap(extractS3KeyCandidatesFromUrl);
    const keys = Array.from(new Set(allKeys));
    if (!keys.length) {
        return { ok: true, deleted: 0, skipped: urls.length };
    }
    const s3 = new client_s3_1.S3Client({
        region,
        endpoint,
        forcePathStyle: env_1.default.STORAGE_S3_FORCE_PATH_STYLE,
        ...(env_1.default.STORAGE_S3_ACCESS_KEY && env_1.default.STORAGE_S3_SECRET_KEY
            ? {
                credentials: {
                    accessKeyId: env_1.default.STORAGE_S3_ACCESS_KEY,
                    secretAccessKey: env_1.default.STORAGE_S3_SECRET_KEY,
                },
            }
            : {}),
    });
    const results = await Promise.allSettled(keys.map((Key) => s3.send(new client_s3_1.DeleteObjectCommand({ Bucket: bucket, Key }))));
    let deleted = 0;
    results.forEach((r, i) => {
        const key = keys[i] ?? "(unknown)";
        if (r.status === "fulfilled") {
            deleted += 1;
            return;
        }
        logger_1.default.warn({ err: r.reason, key, reason: opts?.reason }, "Failed to delete S3 object");
    });
    logger_1.default.info({ deleted, candidates: keys.length, reason: opts?.reason }, "S3 delete completed");
    return { ok: true, deleted, candidates: keys.length };
}
//# sourceMappingURL=storageDeletion.js.map