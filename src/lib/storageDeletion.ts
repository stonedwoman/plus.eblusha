import env from "../config/env";
import logger from "../config/logger";
import { getStorageProvider } from "./storage";

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

function uniqueSafeKeys(keys: string[]): string[] {
  return Array.from(
    new Set(
      (keys || [])
        .map((k) => String(k || "").trim().replace(/^\//, ""))
        .filter(isSafeKey)
    )
  );
}

function stripLeadingBucketSegment(
  decodedPath: string,
  bucket: string | null,
  prefix: string
) {
  const segments = splitSegments(decodedPath);
  if (segments.length === 0) return decodedPath;

  const prefixSegments = splitSegments(prefix);
  if (prefixSegments.length > 0 && segments.length >= 1 + prefixSegments.length) {
    const maybePrefix = segments.slice(1, 1 + prefixSegments.length).join("/");
    if (maybePrefix === prefixSegments.join("/")) {
      return segments.slice(1).join("/");
    }
  }

  if (bucket && segments[0] === bucket) {
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

/** Extract storage key candidates from a URL. Works for both /api/files/ and S3-style URLs. */
export function extractStorageKeyCandidatesFromUrl(url: string): string[] {
  const bucket =
    env.STORAGE_BACKEND === "local" ? null : (env.STORAGE_S3_BUCKET ?? null);
  const prefix = env.STORAGE_PREFIX || "uploads";
  const publicBaseUrl = env.STORAGE_PUBLIC_BASE_URL;

  let pathname = "";
  try {
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

  // Direct S3/public URL (path-style) also supported when bucket is configured
  if (!afterApiFiles && publicBaseUrl) {
    try {
      const base = new URL(publicBaseUrl);
      const parsed = new URL(url, base.origin);
      if (parsed.origin === base.origin) {
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

/** @deprecated Use extractStorageKeyCandidatesFromUrl */
export const extractS3KeyCandidatesFromUrl = extractStorageKeyCandidatesFromUrl;

export async function deleteStorageObjectsByUrls(
  urls: string[],
  opts?: { reason?: string }
) {
  const allKeys = urls.flatMap(extractStorageKeyCandidatesFromUrl);
  const keys = Array.from(new Set(allKeys));

  if (!keys.length) {
    return { ok: true as const, deleted: 0, skipped: urls.length };
  }

  try {
    const storage = getStorageProvider();
    const result = await storage.deleteObjects(keys);
    logger.info(
      { deleted: result.deleted, candidates: keys.length, reason: opts?.reason },
      "Storage delete completed"
    );
    return {
      ok: true as const,
      deleted: result.deleted,
      candidates: keys.length,
    };
  } catch (e: any) {
    logger.error({ err: e }, "Storage delete failed");
    return { ok: false as const, reason: "storage_not_configured" as const };
  }
}

/** @deprecated Use deleteStorageObjectsByUrls */
export const deleteS3ObjectsByUrls = deleteStorageObjectsByUrls;

export async function deleteStorageObjectsByKeys(
  keysInput: string[],
  opts?: { reason?: string }
) {
  const keys = uniqueSafeKeys(keysInput);
  if (!keys.length) {
    return { ok: true as const, deleted: 0, skipped: 0 };
  }

  try {
    const storage = getStorageProvider();
    const result = await storage.deleteObjects(keys);
    logger.info(
      { deleted: result.deleted, candidates: keys.length, reason: opts?.reason },
      "Storage delete by keys completed"
    );
    return {
      ok: true as const,
      deleted: result.deleted,
      candidates: keys.length,
    };
  } catch (e: any) {
    logger.error({ err: e }, "Storage delete by keys failed");
    return { ok: false as const, reason: "storage_not_configured" as const };
  }
}

/** @deprecated Use deleteStorageObjectsByKeys */
export const deleteS3ObjectsByKeys = deleteStorageObjectsByKeys;
