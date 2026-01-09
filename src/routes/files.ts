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

const objectPrefix = env.STORAGE_PREFIX.replace(/^\/|\/$/g, "");

if (s3Client && s3Config) {
  logger.info(
    {
      endpoint: s3Config.endpoint,
      region: s3Config.region,
      bucket: s3Config.bucket,
      forcePathStyle: env.STORAGE_S3_FORCE_PATH_STYLE,
      objectPrefix,
    },
    "S3 file proxy initialized"
  );
}

// Decode URL-encoded path segments
const decodeKeyFromUrl = (urlPath: string) =>
  urlPath
    .split("/")
    .map((segment) => decodeURIComponent(segment))
    .join("/");

const splitPathSegments = (p: string) => p.split("/").filter(Boolean);

const stripLeadingBucketSegment = (decodedPath: string, bucket: string | null, prefix: string) => {
  const segments = splitPathSegments(decodedPath);
  if (segments.length === 0) return decodedPath;

  // Common case: proxy path was derived from a path-style public URL:
  //   https://s3.example.com/<bucket>/<key>
  // Frontend converts it to: /api/files/<bucket>/<key>
  // If we see "<something>/<prefix>/..." treat the leading segment as bucket and strip it.
  const prefixSegments = splitPathSegments(prefix);
  if (prefixSegments.length > 0 && segments.length >= 1 + prefixSegments.length) {
    const maybePrefix = segments.slice(1, 1 + prefixSegments.length).join("/");
    if (maybePrefix === prefixSegments.join("/")) {
      return segments.slice(1).join("/");
    }
  }

  // Also strip an explicit, configured bucket name if present.
  if (bucket && segments[0] === bucket) {
    return segments.slice(1).join("/");
  }

  return decodedPath;
};

const isAccessDenied = (err: any) =>
  err?.name === "AccessDenied" ||
  err?.name === "Forbidden" ||
  err?.Code === "AccessDenied" ||
  err?.$metadata?.httpStatusCode === 403;

const buildCandidateKeys = (decodedPath: string, bucket: string, prefix: string): string[] => {
  const base = decodedPath.replace(/^\//, "");
  const stripped = stripLeadingBucketSegment(base, bucket, prefix);

  const candidates: string[] = [];
  const push = (k: string) => {
    const key = k.replace(/^\//, "");
    if (!key) return;
    if (!candidates.includes(key)) candidates.push(key);
  };

  // Try as-is first (it might already be the real object key).
  push(base);
  push(stripped);

  // Then try enforcing STORAGE_PREFIX (avoids missing prefix issues).
  const prefixNorm = prefix.replace(/^\/|\/$/g, "");
  if (prefixNorm) {
    for (const k of [base, stripped]) {
      if (k === prefixNorm || k.startsWith(prefixNorm + "/")) {
        push(k);
      } else {
        push(`${prefixNorm}/${k}`);
      }
    }
  }

  return candidates;
};

// Proxy route: /api/files/*
// Use router.use with method check for catch-all
router.use(async (req: Request, res: Response, next) => {
  // Only handle GET and HEAD requests
  if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS") {
    return next();
  }

  // Handle OPTIONS for CORS preflight without touching S3.
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "*");
    res.setHeader("Access-Control-Max-Age", "3600");
    res.status(204).end();
    return;
  }

  if (!s3Client || !s3Config) {
    res.status(503).json({ message: "S3 storage is not configured" });
    return;
  }

  // Extract path from request (everything after /api/files/)
  // req.path will be like "/files/uploads/file.jpg" when mounted at /api
  const urlPath = req.path.replace(/^\//, "");
  if (!urlPath) {
    res.status(400).json({ message: "File path is required" });
    return;
  }

  // Decode the path
  let decodedPath = decodeKeyFromUrl(urlPath);
  // Remove leading slash if present
  decodedPath = decodedPath.replace(/^\//, "");

  const candidates = buildCandidateKeys(decodedPath, s3Config.bucket, objectPrefix);
  logger.info(
    { urlPath, decodedPath, objectPrefix, candidates, originalPath: req.path },
    "Resolving S3 key candidates for file request"
  );

  try {
    let contentType = "application/octet-stream";
    let contentLength: number | undefined;
    let lastModified: Date | undefined;
    let etag: string | undefined;
    let lastErr: any = null;

    for (const key of candidates) {
      try {
        // First, check if object exists and get metadata (best-effort).
        try {
          const headCommand = new HeadObjectCommand({ Bucket: s3Config.bucket, Key: key });
          const headResponse = await s3Client.send(headCommand);
          contentType = headResponse.ContentType || contentType;
          contentLength = headResponse.ContentLength;
          lastModified = headResponse.LastModified;
          etag = headResponse.ETag;
        } catch (headError: any) {
          // NotFound -> try next candidate without GET.
          if (headError.name === "NotFound" || headError.$metadata?.httpStatusCode === 404) {
            lastErr = headError;
            continue;
          }
          // Other errors (including AccessDenied or unsupported HEAD) -> we still try GET.
          lastErr = headError;
          logger.warn({ err: headError, key }, "HEAD request failed for candidate, will try GET");
        }

        // Get the object
        const getCommand = new GetObjectCommand({ Bucket: s3Config.bucket, Key: key });
        const response = await s3Client.send(getCommand);

        logger.info({ key }, "Proxying file from S3 using resolved key");

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
        res.setHeader(
          "Access-Control-Expose-Headers",
          "ETag, Content-Length, Content-Type, Last-Modified"
        );

        // Cache headers
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");

        // Handle range requests (for video/audio streaming)
        const range = req.headers.range;
        if (range && response.ContentRange) {
          res.status(206).setHeader("Content-Range", response.ContentRange);
        }

        // Stream the object body to response
        if (response.Body) {
          const body = response.Body as any;

          if (typeof body.pipe === "function") {
            body.pipe(res);
            return;
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

            const buffer = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
            res.send(buffer);
            return;
          }

          try {
            const arrayBuffer =
              (await body.transformToByteArray?.()) || (await body.arrayBuffer?.());
            if (arrayBuffer) {
              res.send(Buffer.from(arrayBuffer));
              return;
            }
            res.status(500).json({ message: "Unable to read file content" });
            return;
          } catch (readError) {
            logger.error({ err: readError, key }, "Failed to read file body");
            res.status(500).json({ message: "Failed to read file content" });
            return;
          }
        }

        res.status(500).json({ message: "No file content" });
        return;
      } catch (err: any) {
        lastErr = err;
        if (err?.name === "NoSuchKey" || err?.$metadata?.httpStatusCode === 404) {
          continue;
        }
        // Some S3-compatible providers return 403 even for missing keys; continue trying other candidates.
        if (isAccessDenied(err)) {
          continue;
        }
        // For other errors, also continue (we'll return a best-effort status later).
        continue;
      }
    }

    // If we got here, none of the candidates worked.
    if (lastErr && isAccessDenied(lastErr)) {
      res.status(403).json({ message: "Access denied" });
      return;
    }
    res.status(404).json({ message: "File not found" });
    return;
  } catch (error: any) {
    logger.error({ err: error }, "Failed to proxy file from S3");
    
    if (error.name === "NoSuchKey" || error.$metadata?.httpStatusCode === 404) {
      res.status(404).json({ message: "File not found" });
    } else if (isAccessDenied(error)) {
      res.status(403).json({ message: "Access denied" });
    } else {
      res.status(500).json({ message: "Failed to retrieve file" });
    }
  }
});

export default router;

