import { Router, type Request, type Response } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { Readable } from "stream";
import { authenticate } from "../middlewares/auth";
import env from "../config/env";
import logger from "../config/logger";
import { rateLimit } from "../middlewares/rateLimit";
import {
  encryptBuffer,
  decryptBuffer,
  encryptToEbp2Stream,
  parseStorageEncKey,
  EBP2_DEFAULT_CHUNK_SIZE,
  type EncryptionMetadata,
  type EBP2Metadata,
} from "../lib/storageEncryption";
import { getStorageProvider } from "../lib/storage";

const router = Router();

const encV2 = env.STORAGE_ENC_V2 === true;
// Files above this MUST use EBP2 streaming; EBP1 readFileSync would OOM
const EBP2_SIZE_THRESHOLD = 50 * 1024 * 1024; // 50 MB
const CHUNK_UPLOAD_SIZE = 5 * 1024 * 1024; // 5 MB

// Always use disk for large files to avoid OOM (700MB+ in RAM is risky)
const upload = multer({
  storage: multer.diskStorage({
          destination: (_req, _file, cb) => {
            const tmp = path.join(process.cwd(), "tmp", "uploads");
            fs.mkdirSync(tmp, { recursive: true });
            cb(null, tmp);
          },
    filename: (_req, _file, cb) => {
      cb(null, `upload-${Date.now()}-${crypto.randomBytes(8).toString("hex")}`);
    },
  }),
  limits: { fileSize: 1024 * 1024 * 1024 }, // 1 GB
});
const uploadSingle = upload.single("file");

const objectPrefix = env.STORAGE_PREFIX.replace(/^\/|\/$/g, "");
const encKey = env.STORAGE_ENC_KEY ? parseStorageEncKey(env.STORAGE_ENC_KEY) : null;

const encodeKeyForUrl = (key: string) =>
  key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");

function logUploadTiming(req: Request, startedAtMs: number, step: string, extra?: Record<string, unknown>) {
  const reqId = String((req as any).requestId ?? req.headers["x-request-id"] ?? "unknown");
  const dt = Date.now() - startedAtMs;
  logger.info({ reqId, step, dt_ms: dt, ...extra }, "[upload-timing]");
}

type UploadManifest = {
  filename: string;
  contentType: string;
  totalSize: number;
  chunkSize: number;
  createdAt: string;
};

function getUploadsRootDir(): string {
  return path.join(process.cwd(), "tmp", "uploads");
}

function getUploadSessionDir(uploadId: string): string {
  return path.join(getUploadsRootDir(), uploadId);
}

function getUploadPartsDir(uploadId: string): string {
  return path.join(getUploadSessionDir(uploadId), "parts");
}

function getUploadManifestPath(uploadId: string): string {
  return path.join(getUploadSessionDir(uploadId), "manifest.json");
}

function isValidUploadId(uploadId: string): boolean {
  return /^[a-f0-9-]{16,}$/i.test(String(uploadId || ""));
}

function writeUploadManifest(uploadId: string, manifest: UploadManifest) {
  const partsDir = getUploadPartsDir(uploadId);
  fs.mkdirSync(partsDir, { recursive: true });
  fs.writeFileSync(getUploadManifestPath(uploadId), JSON.stringify(manifest, null, 2), "utf8");
}

function readUploadManifest(uploadId: string): UploadManifest | null {
  const manifestPath = getUploadManifestPath(uploadId);
  if (!fs.existsSync(manifestPath)) return null;
  let raw: Partial<UploadManifest>;
  try {
    raw = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Partial<UploadManifest>;
  } catch {
    return null;
  }
  if (
    typeof raw.filename !== "string" ||
    typeof raw.contentType !== "string" ||
    typeof raw.totalSize !== "number" ||
    !Number.isFinite(raw.totalSize) ||
    raw.totalSize < 0 ||
    typeof raw.chunkSize !== "number" ||
    !Number.isFinite(raw.chunkSize) ||
    raw.chunkSize <= 0 ||
    typeof raw.createdAt !== "string"
  ) {
    return null;
  }
  return {
    filename: raw.filename,
    contentType: raw.contentType,
    totalSize: raw.totalSize,
    chunkSize: raw.chunkSize,
    createdAt: raw.createdAt,
  };
}

function removeUploadSession(uploadId: string) {
  fs.rmSync(getUploadSessionDir(uploadId), { recursive: true, force: true });
}

async function readRequestBody(req: Request, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  await new Promise<void>((resolve, reject) => {
    req.on("data", (chunk: Buffer | Uint8Array) => {
      const buf = Buffer.from(chunk);
      total += buf.length;
      if (total > maxBytes) {
        reject(new Error("chunk_too_large"));
        req.destroy();
        return;
      }
      chunks.push(buf);
    });
    req.on("end", () => resolve());
    req.on("error", (err) => reject(err));
    req.on("aborted", () => reject(new Error("request_aborted")));
  });
  return Buffer.concat(chunks);
}

async function readStreamToBuffer(input: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of input as AsyncIterable<Buffer | Uint8Array | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function createPartsReadStream(partPaths: string[]): Readable {
  return Readable.from(
    (async function* () {
      for (const partPath of partPaths) {
        const stream = fs.createReadStream(partPath);
        for await (const chunk of stream as AsyncIterable<Buffer | Uint8Array | string>) {
          yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        }
      }
    })()
  );
}

async function storeUploadedObject(
  req: Request,
  res: Response,
  params: {
    startedAtMs?: number;
    filename: string;
    contentType: string;
    totalSize: number;
    filePath?: string;
    inputStream?: NodeJS.ReadableStream;
  }
): Promise<{ url: string; path: string; publicUrl: string } | null> {
  const { startedAtMs, filename, contentType, totalSize, filePath, inputStream } = params;

  if (!encKey) {
    res.status(503).json({ message: "Storage encryption key is not configured" });
    return null;
  }

  let storage;
  try {
    storage = getStorageProvider();
  } catch (e: any) {
    logger.error({ err: e }, "Storage provider not configured");
    res.status(503).json({
      message: "File storage is not configured. Set STORAGE_BACKEND=local or configure S3.",
    });
    return null;
  }

  if (!storage.isAvailable()) {
    res.status(503).json({
      message: "File storage is not available. Check LOCAL_STORAGE_PATH or S3 configuration.",
    });
    return null;
  }

  const ext = encKey ? ".eblusha" : path.extname(filename || "") || ".bin";
  const randomId =
    typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : crypto.randomBytes(16).toString("hex");
  const uniqueName = `${Date.now()}-${randomId}${ext}`;
  const putKey = objectPrefix ? `${objectPrefix}/${uniqueName}` : uniqueName;
  const aadUsedForEncrypt = putKey;
  const metaAadWritten = putKey;

  let bodyToUpload: Buffer | NodeJS.ReadableStream;
  let encryptionMeta: EncryptionMetadata | EBP2Metadata | null = null;
  let originalContentType = contentType || "application/octet-stream";
  const useEbp2 = encKey && (encV2 || totalSize > EBP2_SIZE_THRESHOLD);

  if (encKey && useEbp2) {
    if (startedAtMs != null) logUploadTiming(req, startedAtMs, "before_server_encryption", { mode: "ebp2", totalSize });
    const sourceStream =
      filePath && fs.existsSync(filePath)
        ? fs.createReadStream(filePath)
        : inputStream;
    if (!sourceStream) {
      res.status(500).json({ message: "Upload file data not available" });
      return null;
    }
    bodyToUpload = encryptToEbp2Stream(
      sourceStream,
      aadUsedForEncrypt,
      totalSize,
      encKey,
      { chunkSize: EBP2_DEFAULT_CHUNK_SIZE }
    );
    encryptionMeta = {
      enc: "ebp2",
      encalg: "aes-256-gcm",
      chunksize: String(EBP2_DEFAULT_CHUNK_SIZE),
      totalSize: String(totalSize),
      ct: originalContentType,
    };
    originalContentType = "application/octet-stream";
    if (startedAtMs != null) logUploadTiming(req, startedAtMs, "server_encryption_done", { mode: "ebp2", totalSize });
  } else if (encKey) {
    if (startedAtMs != null) logUploadTiming(req, startedAtMs, "before_server_encryption", { mode: "ebp1", totalSize });
    let buffer: Buffer;
    if (filePath && fs.existsSync(filePath)) {
      buffer = fs.readFileSync(filePath);
    } else if (inputStream) {
      buffer = await readStreamToBuffer(inputStream);
    } else {
      res.status(500).json({ message: "Upload file data not available" });
      return null;
    }
    const encrypted = encryptBuffer(buffer, encKey, {
      aad: aadUsedForEncrypt,
      contentType: originalContentType,
    });
    try {
      decryptBuffer(encrypted.payload, encKey, { aad: aadUsedForEncrypt });
    } catch (err) {
      logger.error(
        {
          err,
          stack: err instanceof Error ? err.stack : undefined,
          putKey,
          magic: encrypted.payload.slice(0, 4).toString("utf8"),
          len: encrypted.payload.length,
        },
        "[upload] EBP1 selfcheck failed"
      );
      res.status(500).json({ message: "storage_enc_selfcheck_failed" });
      return null;
    }
    bodyToUpload = encrypted.payload;
    encryptionMeta = encrypted.meta;
    originalContentType = "application/octet-stream";
    if (startedAtMs != null) logUploadTiming(req, startedAtMs, "server_encryption_done", { mode: "ebp1", totalSize });
  } else {
    if (startedAtMs != null) logUploadTiming(req, startedAtMs, "server_encryption_skipped", { mode: "none", totalSize });
    if (filePath && fs.existsSync(filePath)) {
      bodyToUpload = fs.createReadStream(filePath);
    } else if (inputStream) {
      bodyToUpload = inputStream;
    } else {
      res.status(500).json({ message: "Upload file data not available" });
      return null;
    }
  }

  const encFormat = encryptionMeta
    ? "enc" in encryptionMeta && encryptionMeta.enc === "ebp2"
      ? "ebp2"
      : "ebp1"
    : "none";
  const metadata: Record<string, string> | undefined =
    encryptionMeta && "enc" in encryptionMeta && encryptionMeta.enc === "ebp2"
      ? {
          enc: "ebp2",
          encalg: (encryptionMeta as EBP2Metadata).encalg,
          chunksize: (encryptionMeta as EBP2Metadata).chunksize,
          totalSize: (encryptionMeta as EBP2Metadata).totalSize,
          ct: (encryptionMeta as EBP2Metadata).ct || "",
          aad: metaAadWritten,
        }
      : encryptionMeta
        ? {
            enc: "ebp1",
            encv: (encryptionMeta as EncryptionMetadata).v,
            encalg: (encryptionMeta as EncryptionMetadata).alg,
            enciv: (encryptionMeta as EncryptionMetadata).iv,
            enctag: (encryptionMeta as EncryptionMetadata).tag,
            ct: (encryptionMeta as EncryptionMetadata).ct || "",
            aad: metaAadWritten,
          }
        : undefined;

  if (encryptionMeta) {
    logger.info(
      { putKey, aadUsedForEncrypt, metaAadWritten, enc: encFormat },
      "[upload] aad invariants"
    );
  }
  if (encFormat === "ebp1" && Buffer.isBuffer(bodyToUpload)) {
    const enc = bodyToUpload;
    logger.info(
      {
        putKey,
        encLen: enc.length,
        encFirst32: enc.slice(0, 32).toString("hex"),
        encLast32: enc.slice(-32).toString("hex"),
        encSha: crypto.createHash("sha256").update(enc).digest("hex").slice(0, 12),
      },
      "[upload] enc bytes"
    );
  }

  if (startedAtMs != null) logUploadTiming(req, startedAtMs, "before_putObject", { putKey, encFormat, totalSize });
  await storage.putObject(
    putKey,
    bodyToUpload as Buffer | import("stream").Readable,
    {
      contentType: originalContentType,
      ...(metadata != null && metadata !== undefined && { metadata }),
    }
  );
  if (startedAtMs != null) logUploadTiming(req, startedAtMs, "putObject_done", { putKey, encFormat, totalSize });

  const encodedKey = encodeKeyForUrl(putKey);
  const proxyUrl = `/api/files/${encodedKey}`;
  if (startedAtMs != null) {
    logUploadTiming(req, startedAtMs, "before_response", { putKey, proxyUrl, encFormat, totalSize });
  }
  return { url: proxyUrl, path: putKey, publicUrl: proxyUrl };
}

router.use(authenticate);

router.post("/init", rateLimit({ name: "upload_chunk_init", windowMs: 60_000, max: 20 }), async (req: Request, res) => {
  const filename = typeof req.body?.filename === "string" ? req.body.filename.trim() : "";
  const contentType =
    typeof req.body?.contentType === "string" && req.body.contentType.trim()
      ? req.body.contentType.trim()
      : "application/octet-stream";
  const totalSize = Number(req.body?.size);

  if (!filename) {
    res.status(400).json({ message: "filename is required" });
    return;
  }
  if (!Number.isInteger(totalSize) || totalSize < 0) {
    res.status(400).json({ message: "size must be a non-negative integer" });
    return;
  }

  const uploadId =
    typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : crypto.randomBytes(16).toString("hex");

  writeUploadManifest(uploadId, {
    filename,
    contentType,
    totalSize,
    chunkSize: CHUNK_UPLOAD_SIZE,
    createdAt: new Date().toISOString(),
  });

  res.json({ uploadId, chunkSize: CHUNK_UPLOAD_SIZE });
});

router.put(
  "/:uploadId/part/:partNumber",
  rateLimit({ name: "upload_chunk_part", windowMs: 60_000, max: 2000 }),
  async (req: Request, res) => {
    const uploadId = String(req.params.uploadId || "");
    const partNumber = Number.parseInt(String(req.params.partNumber || ""), 10);

    if (!isValidUploadId(uploadId)) {
      res.status(400).json({ message: "Invalid uploadId" });
      return;
    }
    if (!Number.isInteger(partNumber) || partNumber < 0) {
      res.status(400).json({ message: "Invalid partNumber" });
      return;
    }

    const manifest = readUploadManifest(uploadId);
    if (!manifest) {
      res.status(404).json({ message: "Upload session not found" });
      return;
    }

    const totalParts = manifest.totalSize === 0 ? 0 : Math.ceil(manifest.totalSize / manifest.chunkSize);
    if (totalParts > 0 && partNumber >= totalParts) {
      res.status(400).json({ message: "partNumber out of range" });
      return;
    }

    let body: Buffer;
    try {
      body = await readRequestBody(req, manifest.chunkSize);
    } catch (err: any) {
      if (String(err?.message) === "chunk_too_large") {
        res.status(400).json({ message: "Chunk exceeds chunkSize" });
        return;
      }
      res.status(400).json({ message: "Invalid chunk body" });
      return;
    }

    if (totalParts === 0) {
      res.status(400).json({ message: "Empty uploads do not accept parts" });
      return;
    }

    const remainingBytes = manifest.totalSize - partNumber * manifest.chunkSize;
    const expectedPartSize = Math.min(manifest.chunkSize, remainingBytes);
    if (body.length !== expectedPartSize) {
      res.status(400).json({ message: "Invalid chunk size" });
      return;
    }

    fs.mkdirSync(getUploadPartsDir(uploadId), { recursive: true });
    fs.writeFileSync(path.join(getUploadPartsDir(uploadId), String(partNumber)), body);
    res.json({ ok: true });
  }
);

router.post(
  "/:uploadId/complete",
  rateLimit({ name: "upload_chunk_complete", windowMs: 60_000, max: 20 }),
  async (req: Request, res) => {
    const startedAtMs = Date.now();
    const uploadId = String(req.params.uploadId || "");

    if (!isValidUploadId(uploadId)) {
      res.status(400).json({ message: "Invalid uploadId" });
      return;
    }

    const manifest = readUploadManifest(uploadId);
    if (!manifest) {
      res.status(404).json({ message: "Upload session not found" });
      return;
    }

    const totalParts = manifest.totalSize === 0 ? 0 : Math.ceil(manifest.totalSize / manifest.chunkSize);
    const partPaths: string[] = [];
    let assembledBytes = 0;

    for (let partNumber = 0; partNumber < totalParts; partNumber += 1) {
      const partPath = path.join(getUploadPartsDir(uploadId), String(partNumber));
      if (!fs.existsSync(partPath)) {
        res.status(400).json({ message: `Missing part ${partNumber}` });
        return;
      }
      const stat = fs.statSync(partPath);
      const remainingBytes = manifest.totalSize - partNumber * manifest.chunkSize;
      const expectedPartSize = Math.min(manifest.chunkSize, remainingBytes);
      if (stat.size !== expectedPartSize) {
        res.status(400).json({ message: `Invalid size for part ${partNumber}` });
        return;
      }
      assembledBytes += stat.size;
      partPaths.push(partPath);
    }

    if (assembledBytes !== manifest.totalSize) {
      res.status(400).json({ message: "Uploaded parts do not match totalSize" });
      return;
    }

    logUploadTiming(req, startedAtMs, "parts_verified", {
      uploadId,
      totalParts,
      totalSize: manifest.totalSize,
    });

    try {
      const result = await storeUploadedObject(req, res, {
        startedAtMs,
        filename: manifest.filename,
        contentType: manifest.contentType,
        totalSize: manifest.totalSize,
        inputStream: createPartsReadStream(partPaths),
      });
      if (!result) return;
      removeUploadSession(uploadId);
      res.json(result);
    } catch (error) {
      logger.error({ err: error, uploadId }, "Failed to complete chunk upload");
      res.status(500).json({ message: "Upload failed" });
    }
  }
);

router.delete(
  "/:uploadId",
  rateLimit({ name: "upload_chunk_delete", windowMs: 60_000, max: 50 }),
  async (req: Request, res) => {
    const uploadId = String(req.params.uploadId || "");
    if (!isValidUploadId(uploadId)) {
      res.status(400).json({ message: "Invalid uploadId" });
      return;
    }
    removeUploadSession(uploadId);
    res.json({ ok: true });
  }
);

router.post("/", rateLimit({ name: "upload_init", windowMs: 60_000, max: 20 }), async (req: Request, res) => {
  const startedAtMs = Date.now();
  logUploadTiming(req, startedAtMs, "request_received", { t: 0 });
  res.on("finish", () => {
    const total = Date.now() - startedAtMs;
    const reqId = String((req as any).requestId ?? req.headers["x-request-id"] ?? "unknown");
    logger.info({ reqId, step: "response_sent", total_ms: total, status: res.statusCode }, "[upload-timing]");
  });

  logUploadTiming(req, startedAtMs, "before_multer");
  await new Promise<void>((resolve, reject) => {
    uploadSingle(req, res, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
  logUploadTiming(req, startedAtMs, "multer_done");

  const file = (req as any).file as Express.Multer.File | undefined;
  if (!file) {
    res.status(400).json({ message: "No file" });
    return;
  }

  try {
    const filePath = (file as any).path as string | undefined;
    const totalSize = filePath && fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
    const result = await storeUploadedObject(req, res, {
      startedAtMs,
      filename: file.originalname || "file",
      contentType: file.mimetype || "application/octet-stream",
      totalSize,
      ...(filePath ? { filePath } : {}),
    });
    if (!result) {
      if ((file as any).path && fs.existsSync((file as any).path)) {
        try {
          fs.unlinkSync((file as any).path);
        } catch {}
      }
      return;
    }

    // Always remove temp file (we use diskStorage)
    if ((file as any).path) {
      try {
        fs.unlinkSync((file as any).path);
      } catch (e) {
        logger.warn({ err: e, path: (file as any).path }, "Failed to remove temp upload file");
      }
    }
    res.json(result);
  } catch (error) {
    logger.error({ err: error }, "Failed to upload file");
    if ((file as any).path && fs.existsSync((file as any).path)) {
      try {
        fs.unlinkSync((file as any).path);
      } catch {}
    }
    res.status(500).json({ message: "Upload failed" });
  }
});

export default router;
