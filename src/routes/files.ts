import { Router, type Request, type Response } from "express";
import {
  S3Client,
  GetObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import env from "../config/env";
import logger from "../config/logger";

const router = Router();

const s3Config =
  env.STORAGE_S3_ENDPOINT &&
  env.STORAGE_S3_REGION &&
  env.STORAGE_S3_BUCKET
    ? {
        endpoint: env.STORAGE_S3_ENDPOINT,
        region: env.STORAGE_S3_REGION,
        bucket: env.STORAGE_S3_BUCKET,
        accessKeyId: env.STORAGE_S3_ACCESS_KEY || undefined,
        secretAccessKey: env.STORAGE_S3_SECRET_KEY || undefined,
      }
    : null;

const s3Client = s3Config
  ? new S3Client({
      region: s3Config.region,
      endpoint: s3Config.endpoint,
      forcePathStyle: env.STORAGE_S3_FORCE_PATH_STYLE,
      ...(s3Config.accessKeyId && s3Config.secretAccessKey
        ? { credentials: { accessKeyId: s3Config.accessKeyId, secretAccessKey: s3Config.secretAccessKey } }
        : {}),
    })
  : null;

const fallbackS3Config =
  env.STORAGE_S3_FALLBACK_ENDPOINT &&
  env.STORAGE_S3_FALLBACK_REGION &&
  env.STORAGE_S3_FALLBACK_BUCKET
    ? {
        endpoint: env.STORAGE_S3_FALLBACK_ENDPOINT,
        region: env.STORAGE_S3_FALLBACK_REGION,
        bucket: env.STORAGE_S3_FALLBACK_BUCKET,
        accessKeyId: env.STORAGE_S3_FALLBACK_ACCESS_KEY || undefined,
        secretAccessKey: env.STORAGE_S3_FALLBACK_SECRET_KEY || undefined,
      }
    : null;

const fallbackS3Client = fallbackS3Config
  ? new S3Client({
      region: fallbackS3Config.region,
      endpoint: fallbackS3Config.endpoint,
      forcePathStyle: env.STORAGE_S3_FORCE_PATH_STYLE,
      ...(fallbackS3Config.accessKeyId && fallbackS3Config.secretAccessKey
        ? {
            credentials: { accessKeyId: fallbackS3Config.accessKeyId, secretAccessKey: fallbackS3Config.secretAccessKey },
          }
        : {}),
    })
  : null;

const objectPrefix = env.STORAGE_PREFIX.replace(/^\/|\/$/g, "");

// Decode URL-encoded path segments
const decodeKeyFromUrl = (urlPath: string) =>
  urlPath
    .split("/")
    .map((segment) => decodeURIComponent(segment))
    .join("/");

// Proxy route: /api/files/*
// Use router.use with method check for catch-all
router.use(async (req: Request, res: Response, next) => {
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
  if (fallbackS3Config?.bucket && decodedPath.startsWith(fallbackS3Config.bucket + "/")) {
    decodedPath = decodedPath.slice(fallbackS3Config.bucket.length + 1);
  }
  
  // If objectPrefix is set, ensure the path starts with it
  // If decodedPath already starts with objectPrefix, use it as-is
  // Otherwise, prepend objectPrefix
  let key = decodedPath;
  if (objectPrefix) {
    if (decodedPath.startsWith(objectPrefix + "/")) {
      // Path already has prefix, use as-is
      key = decodedPath;
    } else if (decodedPath === objectPrefix) {
      // Path is exactly the prefix, use as-is
      key = decodedPath;
    } else {
      // Path doesn't have prefix, add it
      key = `${objectPrefix}/${decodedPath}`;
    }
  }
  
  logger.info({ urlPath, decodedPath, objectPrefix, key, originalPath: req.path }, "Resolving S3 key for file request");

  try {
    const fetchFrom = async (client: S3Client, bucket: string) => {
      // First, check if object exists and get metadata
      const headCommand = new HeadObjectCommand({ Bucket: bucket, Key: key });

      let contentType = "application/octet-stream";
      let contentLength: number | undefined;
      let lastModified: Date | undefined;
      let etag: string | undefined;

      try {
        const headResponse = await client.send(headCommand);
        contentType = headResponse.ContentType || contentType;
        contentLength = headResponse.ContentLength;
        lastModified = headResponse.LastModified;
        etag = headResponse.ETag;
      } catch (headError: any) {
        // If HEAD fails, try GET anyway (some S3-compatible services don't support HEAD)
        logger.warn({ err: headError, key, bucket }, "HEAD request failed, will try GET");
      }

      const getCommand = new GetObjectCommand({ Bucket: bucket, Key: key });
      const response = await client.send(getCommand);

      return { response, contentType, contentLength, lastModified, etag };
    };

    let fetched: Awaited<ReturnType<typeof fetchFrom>> | null = null;
    try {
      fetched = await fetchFrom(s3Client, s3Config.bucket);
    } catch (error: any) {
      const notFound = error?.name === "NoSuchKey" || error?.name === "NotFound" || error?.$metadata?.httpStatusCode === 404;
      if (!notFound || !fallbackS3Client || !fallbackS3Config) {
        throw error;
      }
      logger.info({ key }, "Primary S3 missed; trying fallback S3");
      fetched = await fetchFrom(fallbackS3Client, fallbackS3Config.bucket);
    }

    const { response, contentType, contentLength, lastModified, etag } = fetched!;

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
      const body = response.Body as any;
      
      // Try to pipe if it's a Node.js stream
      if (typeof body.pipe === "function") {
        body.pipe(res);
        return;
      }
      
      // Otherwise, read as ReadableStream and convert to buffer
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
        
        const buffer = Buffer.concat(chunks.map(chunk => Buffer.from(chunk)));
        res.send(buffer);
      } else {
        // Fallback: try to read as arrayBuffer
        try {
          const arrayBuffer = await body.transformToByteArray?.() || await body.arrayBuffer?.();
          if (arrayBuffer) {
            res.send(Buffer.from(arrayBuffer));
          } else {
            res.status(500).json({ message: "Unable to read file content" });
          }
        } catch (readError) {
          logger.error({ err: readError, key }, "Failed to read file body");
          res.status(500).json({ message: "Failed to read file content" });
        }
      }
    } else {
      res.status(500).json({ message: "No file content" });
    }
  } catch (error: any) {
    logger.error({ err: error, key }, "Failed to proxy file from S3");
    
    if (error.name === "NoSuchKey" || error.$metadata?.httpStatusCode === 404) {
      res.status(404).json({ message: "File not found" });
    } else {
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

export default router;

