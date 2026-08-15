import { Router, type Request, type Response } from "express";
import env from "../config/env";
import logger from "../config/logger";
import {
  decryptBuffer,
  decryptEbp2RangeStream,
  isEncryptedPayload,
  parseStorageEncKey,
} from "../lib/storageEncryption";
import { getNonSecretConversationDek } from "../lib/nonSecretChatEncryption";
import { getStorageProvider } from "../lib/storage";

const EBP1_RANGE_SIZE_LIMIT = 50 * 1024 * 1024; // 50MB: above this, EBP1 ignores Range and returns 200
const RANGE_MAX_SIZE = 16 * 1024 * 1024; // 16MB: default max Range span
const RANGE_MAX_SIZE_VIDEO = 64 * 1024 * 1024; // 64MB: video/ for longer seeks
const RANGE_MAX_SIZE_AUDIO = 16 * 1024 * 1024; // 16MB: audio/

function sanitizeFilename(name: string): string {
  // Remove path separators and control chars; keep it reasonable length.
  const cleaned = String(name)
    .replace(/[\\/]+/g, "_")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/"/g, "")
    .trim();
  if (!cleaned) return "file";
  return cleaned.slice(0, 180);
}

function extFromContentType(contentType: string): string | null {
  const ct = (contentType || "").toLowerCase().trim();
  if (ct === "video/mp4") return "mp4";
  if (ct === "video/webm") return "webm";
  if (ct === "video/quicktime") return "mov";
  if (ct === "image/jpeg") return "jpg";
  if (ct === "image/png") return "png";
  return null;
}

function applyContentDisposition(req: Request, res: Response, contentType: string) {
  const q = req.query as any;
  const filenameRaw = typeof q?.filename === "string" ? q.filename : null;
  if (!filenameRaw) return;

  const download = q?.download === "1" || q?.download === "true";
  let safe = sanitizeFilename(filenameRaw);
  // Avoid leaking ".eblusha" to end users if we know the real content type.
  if (safe.toLowerCase().endsWith(".eblusha")) {
    const ext = extFromContentType(contentType);
    safe = safe.replace(/\.eblusha$/i, ext ? `.${ext}` : ".bin");
  }

  res.setHeader("Content-Disposition", `${download ? "attachment" : "inline"}; filename="${safe}"`);

  const existing = String(res.getHeader("Access-Control-Expose-Headers") || "");
  if (!existing.toLowerCase().includes("content-disposition")) {
    res.setHeader(
      "Access-Control-Expose-Headers",
      existing ? `${existing}, Content-Disposition` : "Content-Disposition"
    );
  }
}

function getRangeMaxSize(contentType: string): number {
  const ct = (contentType || "").toLowerCase().trim();
  if (ct.startsWith("video/")) return RANGE_MAX_SIZE_VIDEO;
  if (ct.startsWith("audio/")) return RANGE_MAX_SIZE_AUDIO;
  return RANGE_MAX_SIZE;
}

function send416RangeNotSatisfiable(res: Response, totalSize: number, opts?: { contentType?: string; message?: string }) {
  res.status(416);
  res.setHeader("Content-Range", `bytes */${totalSize}`);
  res.setHeader("Accept-Ranges", "bytes");
  if (opts?.message) {
    res.setHeader("Content-Type", "application/json");
    res.json({ message: opts.message });
  } else {
    if (opts?.contentType) res.setHeader("Content-Type", opts.contentType);
    res.end();
  }
}

const router = Router();
const objectPrefix = env.STORAGE_PREFIX.replace(/^\/|\/$/g, "");
const encKey = env.STORAGE_ENC_KEY ? parseStorageEncKey(env.STORAGE_ENC_KEY) : null;
const bucketForKeys =
  env.STORAGE_BACKEND === "local" ? null : (env.STORAGE_S3_BUCKET ?? null);

// Decode URL-encoded path segments
const decodeKeyFromUrl = (urlPath: string) =>
  urlPath
    .split("/")
    .map((segment) => decodeURIComponent(segment))
    .join("/");

// Деривативный ключ превью картинки. ДОЛЖЕН совпадать с deriveThumbKey в upload.ts.
const deriveThumbKey = (key: string): string =>
  key.endsWith(".eblusha") ? key.replace(/\.eblusha$/, ".thumb.eblusha") : `${key}.thumb`;

/** S3/metadata иногда даёт смешанный регистр; без нормализации remap и отдача файла могут «не узнать» EBP1. */
const metaEncTag = (m: Record<string, string>) => String(m?.enc ?? "").trim().toLowerCase();
const metaIsEbp2 = (m: Record<string, string>) => metaEncTag(m) === "ebp2";
const metaIsEbp1 = (m: Record<string, string>) =>
  metaEncTag(m) === "ebp1" ||
  String((m as any)?.encv ?? (m as any)?.enc_v ?? "")
    .trim()
    .toLowerCase() === "1";

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

const parseRangeHeader = (
  rangeHeader: string,
  totalSize: number
): { start: number; end: number } | null => {
  // Only support single range: "bytes=start-end" or "bytes=start-" or "bytes=-suffix"
  const m = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());
  if (!m) return null;
  const startStr = m[1];
  const endStr = m[2];

  if (!startStr && !endStr) return null;

  // suffix range: last N bytes
  if (!startStr && endStr) {
    const suffixLen = Number(endStr);
    if (!Number.isFinite(suffixLen) || suffixLen <= 0) return null;
    const start = Math.max(0, totalSize - suffixLen);
    const end = totalSize > 0 ? totalSize - 1 : 0;
    return { start, end };
  }

  const start = Number(startStr);
  if (!Number.isFinite(start) || start < 0) return null;
  let end = totalSize > 0 ? totalSize - 1 : 0;
  if (endStr) {
    const parsedEnd = Number(endStr);
    if (!Number.isFinite(parsedEnd) || parsedEnd < start) return null;
    end = Math.min(end, parsedEnd);
  }
  if (start >= totalSize) return null;
  return { start, end };
};

const readBodyToBuffer = async (body: any): Promise<Buffer> => {
  if (!body) return Buffer.alloc(0);
  // Node stream
  if (typeof body.pipe === "function") {
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      body.on("data", (c: any) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      body.on("end", () => resolve());
      body.on("error", (e: any) => reject(e));
    });
    return Buffer.concat(chunks);
  }

  // Web ReadableStream
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

  // ArrayBuffer-ish
  const arrayBuffer = (await body.transformToByteArray?.()) || (await body.arrayBuffer?.());
  if (arrayBuffer) return Buffer.from(arrayBuffer);
  throw new Error("Unsupported S3 body type");
};

const buildCandidateKeys = (decodedPath: string, bucket: string | null, prefix: string): string[] => {
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

// Proxy route: /api/files/*
// Use router.use with method check for catch-all
router.use(async (req: Request, res: Response, next) => {
  // Only handle GET and HEAD requests
  if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS") {
    return next();
  }

  // Handle OPTIONS for CORS preflight without touching storage.
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "*");
    res.setHeader("Access-Control-Max-Age", "3600");
    res.status(204).end();
    return;
  }

  let storage;
  try {
    storage = getStorageProvider();
  } catch (e: any) {
    logger.error({ err: e }, "Storage provider not configured");
    res.status(503).json({ message: "Storage is not configured" });
    return;
  }

  if (!encKey) {
    res.status(503).json({ message: "Storage encryption key is not configured" });
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

  // ?thumb=1: если есть заранее сгенерированное превью картинки (деривативный ключ) —
  // отдаём его; если нет (старые фото / секретные / генерация не удалась) — оставляем
  // оригинал и отдаём полный размер (безопасный фолбэк). Дешёвая head-проверка.
  if ((req.query as Record<string, unknown>)?.thumb && encKey) {
    try {
      const thumbBase = deriveThumbKey(decodedPath);
      const thumbCandidates = Array.from(
        new Set([
          ...buildCandidateKeys(thumbBase, bucketForKeys, objectPrefix),
          ...buildCandidateKeys(thumbBase, bucketForKeys, objectPrefix).map(toEblushaKey),
        ])
      );
      for (const ck of thumbCandidates) {
        try {
          const h = await storage.headObject(ck);
          if (h) { decodedPath = thumbBase; break; }
        } catch { /* try next candidate */ }
      }
    } catch { /* fall back to full-size */ }
  }

  const candidates = buildCandidateKeys(
    decodedPath,
    bucketForKeys,
    objectPrefix
  );
  // If we migrated objects to *.eblusha but DB still contains old URLs (.jpg/.png/.bin),
  // transparently try the ".eblusha" variant as a fallback.
  const expandedCandidates = encKey
    ? Array.from(new Set([...candidates, ...candidates.map(toEblushaKey)]))
    : candidates;
  logger.info(
    { urlPath, decodedPath, objectPrefix, candidates: expandedCandidates, originalPath: req.path },
    "Resolving storage key candidates for file request"
  );

  try {
    let contentType = "application/octet-stream";
    let contentLength: number | undefined;
    let lastModified: Date | undefined;
    let etag: string | undefined;
    let lastErr: any = null;

    for (const key of expandedCandidates) {
      try {
        let headResponse: { metadata?: Record<string, string>; contentType?: string; contentLength?: number; lastModified?: Date; etag?: string } | null = null;
        try {
          const h = await storage.headObject(key);
          if (!h) {
            lastErr = new Error("NotFound");
            continue;
          }
          headResponse = {
            metadata: h.metadata ?? {},
            ...(h.contentType != null && { contentType: h.contentType }),
            ...(h.contentLength != null && { contentLength: h.contentLength }),
            ...(h.lastModified != null && { lastModified: h.lastModified }),
            ...(h.etag != null && { etag: h.etag }),
          };
          contentType = h.contentType || contentType;
          contentLength = h.contentLength;
          lastModified = h.lastModified;
          etag = h.etag;
        } catch (headError: any) {
          if (
            headError?.code === "NotFound" ||
            headError?.name === "NotFound" ||
            headError?.name === "NoSuchKey" ||
            headError?.$metadata?.httpStatusCode === 404
          ) {
            lastErr = headError;
            continue;
          }
          lastErr = headError;
          logger.warn({ err: headError, key }, "HEAD request failed for candidate, will try GET");
        }

        const meta = (headResponse?.metadata ?? {}) as Record<string, string>;
        const isEbp2 = metaIsEbp2(meta);

        if (req.method === "HEAD" && headResponse && !isEbp2) {
          res.setHeader("Content-Type", headResponse.contentType || contentType);
          if (headResponse.contentLength !== undefined) {
            res.setHeader("Content-Length", headResponse.contentLength.toString());
          }
          if (headResponse.lastModified) {
            res.setHeader("Last-Modified", headResponse.lastModified.toUTCString());
          }
          if (headResponse.etag) {
            res.setHeader("ETag", headResponse.etag);
          }
          res.setHeader("Access-Control-Allow-Origin", "*");
          res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
          res.setHeader("Access-Control-Expose-Headers", "ETag, Content-Length, Content-Type, Last-Modified");
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
          res.status(200).end();
          return;
        }

        if (isEbp2 && meta?.totalSize && meta?.chunksize) {
          const totalSize = parseInt(meta.totalSize, 10);
          const chunkSize = parseInt(meta.chunksize, 10);
          // meta.ct есть только у S3-провайдера: локальный сторадж при чтении
          // ПЕРЕКЛАДЫВАЕТ ct в верхний contentType и удаляет его из metadata.
          // Без фолбэка видео числилось «просто файлом» (octet-stream): плеер получал
          // лимит диапазона 16МБ вместо видео-64МБ и неверный Content-Type — ролик
          // крупнее 16МБ вообще не начинал играть.
          const originalCt = (meta.ct && meta.ct.trim()) || (contentType && contentType.trim()) || "application/octet-stream";

          if (req.method === "HEAD") {
            res.setHeader("Content-Type", originalCt);
            res.setHeader("Content-Length", totalSize.toString());
            res.setHeader("Accept-Ranges", "bytes");
            res.setHeader("Access-Control-Allow-Origin", "*");
            res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
            res.setHeader("Access-Control-Expose-Headers", "ETag, Content-Length, Content-Type, Last-Modified, Accept-Ranges");
            res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
            res.status(200).end();
            return;
          }

          const rangeHeader = req.headers.range as string | undefined;
          let byteRange: { start: number; end: number };
          if (rangeHeader) {
            const parsed = parseRangeHeader(rangeHeader, totalSize);
            if (!parsed) {
              send416RangeNotSatisfiable(res, totalSize, { contentType: originalCt, message: "Invalid Range" });
              return;
            }
            byteRange = parsed;
            const rangeLen = byteRange.end - byteRange.start + 1;
            const rangeMax = getRangeMaxSize(originalCt);
            if (rangeLen > rangeMax) {
              // Не 416, а УСЕЧЁННЫЙ 206. Плеер всегда начинает с «bytes=0-» (до конца
              // файла), так что 416 здесь означал «файл больше лимита не играет вовсе»
              // — вечная буферизация. Отдаём первый кусок в пределах лимита; получив
              // меньше запрошенного, плеер штатно дозапрашивает следующий диапазон.
              byteRange = { start: byteRange.start, end: byteRange.start + rangeMax - 1 };
            }
          } else {
            byteRange = { start: 0, end: totalSize > 0 ? totalSize - 1 : 0 };
          }

          const fetcher = async (range: { start: number; end: number }) => {
            const r = await storage.getObject(key, range);
            return readBodyToBuffer(r.body);
          };

          const contentLength = byteRange.end - byteRange.start + 1;
          if (rangeHeader) {
            res.status(206);
            res.setHeader("Content-Range", `bytes ${byteRange.start}-${byteRange.end}/${totalSize}`);
          }
          res.setHeader("Content-Type", originalCt);
          applyContentDisposition(req, res, originalCt);
          res.setHeader("Content-Length", contentLength.toString());
          res.setHeader("Accept-Ranges", "bytes");
          res.setHeader("Access-Control-Allow-Origin", "*");
          res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
          res.setHeader("Access-Control-Expose-Headers", "ETag, Content-Length, Content-Type, Last-Modified, Content-Range, Accept-Ranges");
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");

          const plainStream = decryptEbp2RangeStream(key, fetcher, byteRange, encKey!, { chunkSize, totalSize });
          plainStream.on("error", (err) => res.destroy(err));
          res.on("close", () => {
            if (!res.writableEnded) plainStream.destroy();
          });
          req.on("close", () => {
            plainStream.destroy();
          });
          plainStream.pipe(res);
          return;
        }

        // EBP1 or unencrypted
        const isEbp1 = metaIsEbp1(meta);

        let rangeOpt: { start: number; end: number } | undefined;
        if (!isEbp1 && headResponse) {
          const rangeHeader = req.headers.range as string | undefined;
          const objSize = headResponse.contentLength ?? 0;
          const unencCt = headResponse.contentType || "application/octet-stream";
          if (rangeHeader) {
            const parsed = parseRangeHeader(rangeHeader, objSize);
            if (!parsed) {
              send416RangeNotSatisfiable(res, objSize, { contentType: unencCt, message: "Invalid Range" });
              return;
            }
            const rangeLen = parsed.end - parsed.start + 1;
            const rangeMax = getRangeMaxSize(unencCt);
            if (rangeLen > rangeMax) {
              // Как и в ebp2-ветке: усечённый 206 вместо 416, иначе «bytes=0-» на
              // большом файле не играет вовсе.
              rangeOpt = { start: parsed.start, end: parsed.start + rangeMax - 1 };
            } else {
              rangeOpt = parsed;
            }
          }
        }
        const getResult = await storage.getObject(key, rangeOpt);

        logger.info({ key }, "Proxying file from storage using resolved key");

        const isEncrypted = isEbp1;

        if (isEncrypted) {
          let rangeHeader = req.headers.range as string | undefined;
          const encSize = contentLength ?? 0;
          const originalCt =
            (getResult.metadata?.ct && getResult.metadata.ct.trim()) || "application/octet-stream";

          // EBP1: for large files or oversized Range, ignore Range and return 200 full — lets <video> play without seek, no OOM
          if (rangeHeader) {
            if (encSize > EBP1_RANGE_SIZE_LIMIT) {
              rangeHeader = undefined;
            } else {
              const parsed = parseRangeHeader(rangeHeader, encSize || 0);
              if (parsed) {
                const rangeLen = parsed.end - parsed.start + 1;
                if (rangeLen > getRangeMaxSize(originalCt)) {
                  rangeHeader = undefined;
                }
              }
            }
          }

          const encryptedBuf = await readBodyToBuffer(getResult.body);
          const blobMeta = {
            ...(meta ?? {}),
            ...((getResult.metadata ?? {}) as Record<string, string>),
          } as Record<string, string>;
          const aadFromMetaRaw = blobMeta?.aad?.trim?.() ?? "";

          /** Per-chat DEK blobs (migrate script `encscope=chat` + `cid=<conversation id>`): wrong key → decrypt fails → внешний цикл считает «не найдено» и возвращает 404. Перессылка сохраняет тот же URL — новый диалог всё так же загружает тот же объект. */
          const isChatScopedEbp =
            String(blobMeta.encscope || "").toLowerCase() === "chat" &&
            typeof blobMeta.cid === "string" &&
            blobMeta.cid.trim().length > 0;

          const aadCandidates: string[] = aadFromMetaRaw
            ? [aadFromMetaRaw]
            : [key, ...expandedCandidates.filter((k) => k !== key)];

          let decrypted: Buffer | undefined;

          if (isChatScopedEbp) {
            try {
              const dekConv = await getNonSecretConversationDek(blobMeta.cid!.trim());
              let lastConvErr: Error | null = null;
              for (const aadCandidate of aadCandidates) {
                try {
                  decrypted = decryptBuffer(encryptedBuf, dekConv, { aad: aadCandidate });
                  break;
                } catch (e) {
                  lastConvErr = e as Error;
                }
              }
              if (!decrypted && lastConvErr) {
                logger.warn(
                  { err: lastConvErr, cid: blobMeta.cid, key },
                  "[files] chat-scoped EBP1 decrypt failed (aad candidates exhausted)"
                );
              }
            } catch (e: any) {
              logger.warn(
                { err: e, cid: blobMeta.cid, key },
                "[files] chat-scoped EBP1: could not unwrap conversation DEK",
              );
            }
          }

          if (!decrypted) {
            let lastErr: Error | null = null;
            for (const aadCandidate of aadCandidates) {
              try {
                decrypted = decryptBuffer(encryptedBuf, encKey!, { aad: aadCandidate });
                break;
              } catch (e) {
                lastErr = e as Error;
              }
            }
            if (!decrypted) throw lastErr ?? new Error("EBP1 decrypt failed");
          }

          if (rangeHeader) {
            const parsed = parseRangeHeader(rangeHeader, decrypted.length);
            if (!parsed) {
              res.status(416).json({ message: "Invalid Range" });
              return;
            }
            const { start, end } = parsed;
            const slice = decrypted.subarray(start, end + 1);
            res.status(206);
            res.setHeader("Accept-Ranges", "bytes");
            res.setHeader("Content-Range", `bytes ${start}-${end}/${decrypted.length}`);
            res.setHeader("Content-Type", originalCt);
            applyContentDisposition(req, res, originalCt);
            res.setHeader("Content-Length", slice.length.toString());
            res.setHeader("Access-Control-Allow-Origin", "*");
            res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
            res.setHeader("Access-Control-Expose-Headers", "ETag, Content-Length, Content-Type, Last-Modified, Content-Range, Accept-Ranges");
            res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
            res.send(slice);
            return;
          }

          res.setHeader("Content-Type", originalCt);
          applyContentDisposition(req, res, originalCt);
          res.setHeader("Content-Length", decrypted.length.toString());
          res.setHeader("Accept-Ranges", "bytes");
          res.setHeader("Access-Control-Allow-Origin", "*");
          res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
          res.setHeader("Access-Control-Expose-Headers", "ETag, Content-Length, Content-Type, Last-Modified, Accept-Ranges");
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
          res.send(decrypted);
          return;
        }

        // Unencrypted: set headers and stream
        const usedRange = !!rangeOpt;
        if (usedRange && rangeOpt) {
          res.status(206);
          res.setHeader(
            "Content-Range",
            `bytes ${rangeOpt.start}-${rangeOpt.end}/${contentLength ?? "*"}`
          );
        }
        res.setHeader("Content-Type", getResult.contentType || contentType);
        applyContentDisposition(req, res, String(getResult.contentType || contentType));
        const bodyLength = getResult.contentLength ?? contentLength;
        if (bodyLength !== undefined) {
          res.setHeader("Content-Length", bodyLength.toString());
        }
        res.setHeader("Accept-Ranges", "bytes");
        if (lastModified) {
          res.setHeader("Last-Modified", lastModified.toUTCString());
        }
        if (etag) {
          res.setHeader("ETag", etag);
        }
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
        res.setHeader(
          "Access-Control-Expose-Headers",
          "ETag, Content-Length, Content-Type, Last-Modified, Content-Range, Accept-Ranges"
        );
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");

        // Stream the object body
        const body = getResult.body;
        if (body) {
          if (typeof body.pipe === "function") {
            body.pipe(res);
            return;
          }

          try {
            const buffer = await readBodyToBuffer(body);
            res.send(buffer);
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
        if (
          err?.code === "NotFound" ||
          err?.name === "NoSuchKey" ||
          err?.$metadata?.httpStatusCode === 404
        ) {
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
    logger.error({ err: error }, "Failed to proxy file from storage");
    
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

