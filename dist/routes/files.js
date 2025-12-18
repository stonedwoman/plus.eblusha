"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const client_s3_1 = require("@aws-sdk/client-s3");
const env_1 = __importDefault(require("../config/env"));
const logger_1 = __importDefault(require("../config/logger"));
const router = (0, express_1.Router)();
const s3Config = env_1.default.STORAGE_S3_ENDPOINT &&
    env_1.default.STORAGE_S3_REGION &&
    env_1.default.STORAGE_S3_BUCKET
    ? {
        endpoint: env_1.default.STORAGE_S3_ENDPOINT,
        region: env_1.default.STORAGE_S3_REGION,
        bucket: env_1.default.STORAGE_S3_BUCKET,
        accessKeyId: env_1.default.STORAGE_S3_ACCESS_KEY || undefined,
        secretAccessKey: env_1.default.STORAGE_S3_SECRET_KEY || undefined,
    }
    : null;
const s3Client = s3Config
    ? new client_s3_1.S3Client({
        region: s3Config.region,
        endpoint: s3Config.endpoint,
        forcePathStyle: env_1.default.STORAGE_S3_FORCE_PATH_STYLE,
        ...(s3Config.accessKeyId && s3Config.secretAccessKey
            ? { credentials: { accessKeyId: s3Config.accessKeyId, secretAccessKey: s3Config.secretAccessKey } }
            : {}),
    })
    : null;
const objectPrefix = env_1.default.STORAGE_PREFIX.replace(/^\/|\/$/g, "");
// Decode URL-encoded path segments
const decodeKeyFromUrl = (urlPath) => urlPath
    .split("/")
    .map((segment) => decodeURIComponent(segment))
    .join("/");
// Proxy route: /api/files/*
// Use router.use with method check for catch-all
router.use(async (req, res, next) => {
    // Only handle GET and HEAD requests
    if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS") {
        return next();
    }
    if (!s3Client || !s3Config) {
        res.status(503).json({ message: "S3 storage is not configured" });
        return;
    }
    // Extract path from request (everything after /api/files/)
    // req.path will be like "/files/uploads/file.jpg" when mounted at /api
    const urlPath = req.path.replace(/^\/files\/?/, "") || req.path.replace(/^\/api\/files\/?/, "");
    if (!urlPath) {
        res.status(400).json({ message: "File path is required" });
        return;
    }
    // Decode the path
    let decodedPath = decodeKeyFromUrl(urlPath);
    // Remove leading slash if present
    decodedPath = decodedPath.replace(/^\//, "");
    // Some providers (e.g. path-style base URL like https://s3.twcstorage.ru/<bucket>/...)
    // embed the bucket name in the URL path. Our proxy path is "/api/files/*" and should only
    // contain the object key, so strip a leading "<bucket>/" if present.
    if (s3Config?.bucket && decodedPath.startsWith(s3Config.bucket + "/")) {
        decodedPath = decodedPath.slice(s3Config.bucket.length + 1);
    }
    // If objectPrefix is set, ensure the path starts with it
    // If decodedPath already starts with objectPrefix, use it as-is
    // Otherwise, prepend objectPrefix
    let key = decodedPath;
    if (objectPrefix) {
        if (decodedPath.startsWith(objectPrefix + "/")) {
            // Path already has prefix, use as-is
            key = decodedPath;
        }
        else if (decodedPath === objectPrefix) {
            // Path is exactly the prefix, use as-is
            key = decodedPath;
        }
        else {
            // Path doesn't have prefix, add it
            key = `${objectPrefix}/${decodedPath}`;
        }
    }
    logger_1.default.info({ urlPath, decodedPath, objectPrefix, key, originalPath: req.path }, "Resolving S3 key for file request");
    try {
        // First, check if object exists and get metadata
        const headCommand = new client_s3_1.HeadObjectCommand({ Bucket: s3Config.bucket, Key: key });
        let contentType = "application/octet-stream";
        let contentLength;
        let lastModified;
        let etag;
        try {
            const headResponse = await s3Client.send(headCommand);
            contentType = headResponse.ContentType || contentType;
            contentLength = headResponse.ContentLength;
            lastModified = headResponse.LastModified;
            etag = headResponse.ETag;
        }
        catch (headError) {
            if (headError.name === "NotFound" || headError.$metadata?.httpStatusCode === 404) {
                res.status(404).json({ message: "File not found" });
                return;
            }
            // If HEAD fails, try GET anyway (some S3-compatible services don't support HEAD)
            logger_1.default.warn({ err: headError, key }, "HEAD request failed, will try GET");
        }
        // Get the object
        const getCommand = new client_s3_1.GetObjectCommand({ Bucket: s3Config.bucket, Key: key });
        const response = await s3Client.send(getCommand);
        // Set appropriate headers
        res.setHeader("Content-Type", response.ContentType || contentType);
        if (contentLength !== undefined) {
            res.setHeader("Content-Length", contentLength.toString());
        }
        if (lastModified) {
            res.setHeader("Last-Modified", lastModified.toUTCString());
        }
        if (etag) {
            res.setHeader("ETag", etag);
        }
        // CORS headers
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
        res.setHeader("Access-Control-Expose-Headers", "ETag, Content-Length, Content-Type, Last-Modified");
        // Cache headers
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        // Handle range requests (for video/audio streaming)
        const range = req.headers.range;
        if (range && response.ContentRange) {
            res.status(206).setHeader("Content-Range", response.ContentRange);
        }
        // Stream the object body to response
        if (response.Body) {
            // AWS SDK v3 returns Body as ReadableStream
            // Convert to Node.js stream or buffer
            const body = response.Body;
            // Try to pipe if it's a Node.js stream
            if (typeof body.pipe === "function") {
                body.pipe(res);
                return;
            }
            // Otherwise, read as ReadableStream and convert to buffer
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
                const buffer = Buffer.concat(chunks.map(chunk => Buffer.from(chunk)));
                res.send(buffer);
            }
            else {
                // Fallback: try to read as arrayBuffer
                try {
                    const arrayBuffer = await body.transformToByteArray?.() || await body.arrayBuffer?.();
                    if (arrayBuffer) {
                        res.send(Buffer.from(arrayBuffer));
                    }
                    else {
                        res.status(500).json({ message: "Unable to read file content" });
                    }
                }
                catch (readError) {
                    logger_1.default.error({ err: readError, key }, "Failed to read file body");
                    res.status(500).json({ message: "Failed to read file content" });
                }
            }
        }
        else {
            res.status(500).json({ message: "No file content" });
        }
    }
    catch (error) {
        logger_1.default.error({ err: error, key }, "Failed to proxy file from S3");
        if (error.name === "NoSuchKey" || error.$metadata?.httpStatusCode === 404) {
            res.status(404).json({ message: "File not found" });
        }
        else {
            res.status(500).json({ message: "Failed to retrieve file" });
        }
    }
    // Handle OPTIONS for CORS preflight
    if (req.method === "OPTIONS") {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "*");
        res.setHeader("Access-Control-Max-Age", "3600");
        res.status(204).end();
        return;
    }
});
exports.default = router;
//# sourceMappingURL=files.js.map