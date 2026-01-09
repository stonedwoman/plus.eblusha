import { DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3";
import env from "../config/env";
import logger from "../config/logger";

const splitSegments = (p: string) => p.split("/").filter(Boolean);

const decodePathSegments = (p: string) =>
  p
    .split("/")
    .filter((s) => s.length > 0)
    .map((s) => decodeURIComponent(s))
    .join("/");

const toEblushaKey = (k: string): string => {
  if (k.endsWith(".eblusha")) return k;
  const parts = k.split("/");
  const base = parts.pop() ?? "";
  if (!base) return `${k}.eblusha`;
  const dot = base.lastIndexOf(".");
  const baseNoExt = dot > 0 ? base.slice(0, dot) : base;
  parts.push(`${baseNoExt}.eblusha`);
  return parts.join("/");
};

function isSafeKey(key: string) {
  if (!key) return false;
  if (key.includes("..")) return false;
  if (key.startsWith("/")) return false;
  return true;
}

function stripLeadingBucketSegment(decodedPath: string, bucket: string, prefix: string) {
  const segments = splitSegments(decodedPath);
  if (segments.length === 0) return decodedPath;

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

function enforcePrefixCandidates(decodedPath: string, prefix: string): string[] {
  const prefixNorm = prefix.replace(/^\/|\/$/g, "");
  const base = decodedPath.replace(/^\//, "");
  const candidates: string[] = [];
  const push = (k: string) => {
    const kk = k.replace(/^\//, "");
    if (!kk) return;
    if (!candidates.includes(kk)) candidates.push(kk);
  };

  push(base);
  if (prefixNorm) {
    if (base === prefixNorm || base.startsWith(prefixNorm + "/")) push(base);
    else push(`${prefixNorm}/${base}`);
  }

  return candidates;
}

export function extractS3KeyCandidatesFromUrl(url: string): string[] {
  const bucket = env.STORAGE_S3_BUCKET;
  const prefix = env.STORAGE_PREFIX || "uploads";
  const publicBaseUrl = env.STORAGE_PUBLIC_BASE_URL;

  if (!bucket) return [];

  let pathname = "";
  try {
    // Relative URL support
    const parsed = new URL(url, "http://localhost");
    pathname = parsed.pathname || "";
  } catch {
    return [];
  }

  // Primary format: /api/files/<encodedKey>
  let afterApiFiles: string | null = null;
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
    } catch {
      // ignore
    }
  }

  if (!afterApiFiles) return [];

  const decodedPath = decodePathSegments(afterApiFiles).replace(/^\//, "");
  const stripped = stripLeadingBucketSegment(decodedPath, bucket, prefix);

  const keys = [
    ...enforcePrefixCandidates(decodedPath, prefix),
    ...enforcePrefixCandidates(stripped, prefix),
  ];

  const expanded = Array.from(new Set([...keys, ...keys.map(toEblushaKey)]));
  return expanded.filter(isSafeKey);
}

export async function deleteS3ObjectsByUrls(urls: string[], opts?: { reason?: string }) {
  const bucket = env.STORAGE_S3_BUCKET;
  const endpoint = env.STORAGE_S3_ENDPOINT;
  const region = env.STORAGE_S3_REGION;

  if (!bucket || !endpoint || !region) {
    return { ok: false as const, reason: "s3_not_configured" as const };
  }

  const allKeys = urls.flatMap(extractS3KeyCandidatesFromUrl);
  const keys = Array.from(new Set(allKeys));

  if (!keys.length) {
    return { ok: true as const, deleted: 0, skipped: urls.length };
  }

  const s3 = new S3Client({
    region,
    endpoint,
    forcePathStyle: env.STORAGE_S3_FORCE_PATH_STYLE,
    ...(env.STORAGE_S3_ACCESS_KEY && env.STORAGE_S3_SECRET_KEY
      ? {
          credentials: {
            accessKeyId: env.STORAGE_S3_ACCESS_KEY,
            secretAccessKey: env.STORAGE_S3_SECRET_KEY,
          },
        }
      : {}),
  });

  const results = await Promise.allSettled(
    keys.map((Key) => s3.send(new DeleteObjectCommand({ Bucket: bucket, Key })))
  );

  let deleted = 0;
  results.forEach((r, i) => {
    const key = keys[i] ?? "(unknown)";
    if (r.status === "fulfilled") {
      deleted += 1;
      return;
    }
    logger.warn({ err: r.reason, key, reason: opts?.reason }, "Failed to delete S3 object");
  });

  logger.info({ deleted, candidates: keys.length, reason: opts?.reason }, "S3 delete completed");
  return { ok: true as const, deleted, candidates: keys.length };
}


