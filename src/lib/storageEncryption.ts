import crypto from "crypto";
import { PassThrough, Readable } from "stream";
import logger from "../config/logger";

const MAGIC = Buffer.from("EBP1", "utf8"); // Eblusha Blob Payload v1
const MAGIC_EBP2 = Buffer.from("EBP2", "utf8");
const IV_LEN = 12; // recommended for GCM
const TAG_LEN = 16;

/** EBP2 default chunk size: 1MB. Tradeoffs: smaller = more Range flexibility and less RAM per chunk, but more overhead (nonce+tag per chunk). Larger = fewer S3 requests for full download, but coarser Range. 1MB balances seek granularity with overhead. */
export const EBP2_DEFAULT_CHUNK_SIZE = 1024 * 1024;

export type EncryptionMetadata = {
  alg: "AES-256-GCM";
  v: "1";
  // base64
  iv: string;
  tag: string;
  // optional original content type (kept in S3 metadata too)
  ct?: string;
};

export class StorageEncryptionError extends Error {}

/** Parse STORAGE_ENC_KEY: base64 (if / or + or ends with = or len 44) else hex (64 chars) else error. Always 32 bytes. */
export function parseStorageEncKey(raw: string): Buffer {
  const trimmed = raw.trim();
  if (!trimmed) throw new StorageEncryptionError("STORAGE_ENC_KEY is empty");

  let buf: Buffer;
  let detectedFormat: "base64" | "hex";

  const looksLikeBase64 =
    trimmed.length === 44 ||
    trimmed.includes("/") ||
    trimmed.includes("+") ||
    trimmed.includes("=");

  if (looksLikeBase64) {
    try {
      buf = Buffer.from(trimmed, "base64");
    } catch {
      throw new StorageEncryptionError("STORAGE_ENC_KEY base64 decode failed");
    }
    detectedFormat = "base64";
  } else if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    buf = Buffer.from(trimmed, "hex");
    detectedFormat = "hex";
  } else {
    throw new StorageEncryptionError("STORAGE_ENC_KEY must be base64 (44 chars, /, +, =) or hex (64 chars)");
  }

  if (buf.length !== 32) {
    throw new StorageEncryptionError(
      `STORAGE_ENC_KEY must decode to 32 bytes, got ${buf.length}`
    );
  }

  logger.info(
    {
      keyBytesLen: buf.length,
      keyBytesFp: crypto.createHash("sha256").update(buf).digest("hex").slice(0, 8),
      fmt: detectedFormat,
    },
    "[storageEnc] key-bytes"
  );

  return buf;
}

export function isEncryptedPayload(buf: Buffer): boolean {
  return buf.length >= MAGIC.length + IV_LEN + TAG_LEN && buf.subarray(0, 4).equals(MAGIC);
}

export function encryptBuffer(
  plaintext: Buffer,
  masterKey: Buffer,
  opts?: { aad?: string; contentType?: string }
): { payload: Buffer; meta: EncryptionMetadata } {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv("aes-256-gcm", masterKey, iv);
  if (opts?.aad) cipher.setAAD(Buffer.from(opts.aad, "utf8"));

  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  const payload = Buffer.concat([MAGIC, iv, tag, ciphertext]);
  return {
    payload,
    meta: {
      alg: "AES-256-GCM",
      v: "1",
      iv: iv.toString("base64"),
      tag: tag.toString("base64"),
      ...(opts?.contentType ? { ct: opts.contentType } : {}),
    },
  };
}

export function decryptBuffer(
  payload: Buffer,
  masterKey: Buffer,
  opts?: { aad?: string }
): Buffer {
  if (!isEncryptedPayload(payload)) {
    throw new StorageEncryptionError("Payload is not encrypted (missing magic header)");
  }

  const iv = payload.subarray(MAGIC.length, MAGIC.length + IV_LEN);
  const tag = payload.subarray(MAGIC.length + IV_LEN, MAGIC.length + IV_LEN + TAG_LEN);
  const ciphertext = payload.subarray(MAGIC.length + IV_LEN + TAG_LEN);

  const decipher = crypto.createDecipheriv("aes-256-gcm", masterKey, iv);
  if (opts?.aad) decipher.setAAD(Buffer.from(opts.aad, "utf8"));
  decipher.setAuthTag(tag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

// --- EBP2 chunked AEAD ---

export type EBP2Metadata = {
  enc: "ebp2";
  encalg: "aes-256-gcm";
  chunksize: string;
  totalSize: string;
  ct?: string;
};

export function isEbp2Payload(buf: Buffer): boolean {
  return buf.length >= 17 && buf.subarray(0, 4).equals(MAGIC_EBP2);
}

/** Build AAD for EBP2 chunk: objectKey(utf8) + chunkIndex(u32le) + chunkSize(u32le) + totalSize(u64le) + version(u8) */
function buildEbp2Aad(
  objectKey: string,
  chunkIndex: number,
  chunkSize: number,
  totalSize: number,
  version: number
): Buffer {
  const aad = Buffer.alloc(4 + 4 + 8 + 1);
  aad.writeUInt32LE(chunkIndex, 0);
  aad.writeUInt32LE(chunkSize, 4);
  aad.writeBigUInt64LE(BigInt(totalSize), 8);
  aad.writeUInt8(version, 16);
  return Buffer.concat([Buffer.from(objectKey, "utf8"), aad]);
}

/**
 * Encrypt input stream to EBP2 format.
 * Layout: MAGIC(4) + VERSION(1) + chunkSize(4) + totalSize(8) + chunks[nonce(12)+tag(16)+ciphertext]
 */
export function encryptToEbp2Stream(
  inputStream: NodeJS.ReadableStream,
  objectKey: string,
  totalSize: number,
  masterKey: Buffer,
  opts?: { chunkSize?: number }
): PassThrough {
  const chunkSize = opts?.chunkSize ?? EBP2_DEFAULT_CHUNK_SIZE;
  const version = 1;

  const header = Buffer.alloc(17);
  header.set(MAGIC_EBP2, 0);
  header.writeUInt8(version, 4);
  header.writeUInt32LE(chunkSize, 5);
  header.writeBigUInt64LE(BigInt(totalSize), 9);

  const out = new PassThrough();
  out.write(header);

  let chunkIndex = 0;
  let buffer = Buffer.alloc(0);

  const processChunk = (plain: Buffer) => {
    if (plain.length === 0) return;
    const iv = crypto.randomBytes(IV_LEN);
    const aad = buildEbp2Aad(objectKey, chunkIndex, chunkSize, totalSize, version);
    const cipher = crypto.createCipheriv("aes-256-gcm", masterKey, iv);
    cipher.setAAD(aad);

    const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
    const tag = cipher.getAuthTag();
    out.write(Buffer.concat([iv, tag, ciphertext]));
    chunkIndex++;
  };

  inputStream.on("data", (chunk: Buffer | Uint8Array) => {
    buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
    while (buffer.length >= chunkSize) {
      processChunk(buffer.subarray(0, chunkSize));
      buffer = buffer.subarray(chunkSize);
    }
  });

  inputStream.on("end", () => {
    if (buffer.length > 0) processChunk(buffer);
    out.end();
  });

  inputStream.on("error", (err) => out.destroy(err));

  return out;
}

/** Compute encrypted byte range in EBP2 file for a given chunk index. */
export function getEbp2ChunkEncryptedRange(
  chunkSize: number,
  totalSize: number,
  chunkIndex: number
): { start: number; length: number; plainLen: number } {
  const headerLen = 17;
  let offset = headerLen;

  for (let j = 0; j < chunkIndex; j++) {
    const plainLen = Math.min(chunkSize, totalSize - j * chunkSize);
    offset += IV_LEN + TAG_LEN + plainLen;
  }

  const plainLen = Math.min(chunkSize, Math.max(0, totalSize - chunkIndex * chunkSize));
  const encLen = IV_LEN + TAG_LEN + plainLen;

  return { start: offset, length: encLen, plainLen };
}

/**
 * Decrypt EBP2 payload from buffer (sequential chunks, no range math).
 * Used for diagnostics: if this works but decryptEbp2RangeStream fails, bug is in range logic.
 * @param encBuf Full encrypted buffer from byte 0 (includes 17-byte header)
 */
export function decryptEbp2WholeFromBuffer(
  encBuf: Buffer,
  objectKey: string,
  masterKey: Buffer
): Buffer {
  if (encBuf.length < 17 || !encBuf.subarray(0, 4).equals(MAGIC_EBP2)) {
    throw new StorageEncryptionError("EBP2 magic mismatch or buffer too short");
  }
  const version = encBuf.readUInt8(4);
  const chunkSize = encBuf.readUInt32LE(5);
  const totalSize = Number(encBuf.readBigUInt64LE(9));
  const headerLen = 17;

  const chunks: Buffer[] = [];
  let offset = headerLen;
  let chunkIndex = 0;

  while (offset < encBuf.length && chunkIndex * chunkSize < totalSize) {
    const plainLen = Math.min(chunkSize, Math.max(0, totalSize - chunkIndex * chunkSize));
    const encChunkLen = IV_LEN + TAG_LEN + plainLen;
    if (offset + encChunkLen > encBuf.length) break;

    const iv = encBuf.subarray(offset, offset + IV_LEN);
    const tag = encBuf.subarray(offset + IV_LEN, offset + IV_LEN + TAG_LEN);
    const ciphertext = encBuf.subarray(offset + IV_LEN + TAG_LEN, offset + encChunkLen);

    const aad = buildEbp2Aad(objectKey, chunkIndex, chunkSize, totalSize, version);
    const decipher = crypto.createDecipheriv("aes-256-gcm", masterKey, iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    chunks.push(Buffer.concat([decipher.update(ciphertext), decipher.final()]));

    offset += encChunkLen;
    chunkIndex++;
  }

  return Buffer.concat(chunks);
}

/** Get chunk indices that overlap [start, end] (inclusive). */
export function getEbp2ChunksForRange(
  chunkSize: number,
  totalSize: number,
  start: number,
  end: number
): number[] {
  const chunks: number[] = [];
  const startChunk = Math.floor(start / chunkSize);
  const endChunk = Math.floor(end / chunkSize);
  for (let i = startChunk; i <= endChunk; i++) {
    if (i * chunkSize < totalSize) chunks.push(i);
  }
  return chunks;
}

type EncryptedStreamFetcher = (range: { start: number; end: number }) => Promise<Buffer>;

/**
 * Decrypt only the chunks needed for the requested plaintext byte range.
 * Returns a Readable stream that pushes plaintext chunks as they are decrypted (no full buffering).
 */
export function decryptEbp2RangeStream(
  objectKey: string,
  encryptedStreamFetcher: EncryptedStreamFetcher,
  byteRange: { start: number; end: number },
  masterKey: Buffer,
  opts: { chunkSize: number; totalSize: number; version?: number }
): Readable {
  const { chunkSize, totalSize, version = 1 } = opts;
  const { start, end } = byteRange;

  const chunks = getEbp2ChunksForRange(chunkSize, totalSize, start, end);
  let idx = 0;

  const stream = new Readable({
    async read() {
      if (idx >= chunks.length) {
        this.push(null);
        return;
      }
      const ci = chunks[idx++];
      if (ci === undefined) {
        this.push(null);
        return;
      }
      try {
        const { start: encStart, length: encLen, plainLen } = getEbp2ChunkEncryptedRange(
          chunkSize,
          totalSize,
          ci
        );
        const encBuf = await encryptedStreamFetcher({ start: encStart, end: encStart + encLen - 1 });

        if (encBuf.length < IV_LEN + TAG_LEN)
          throw new StorageEncryptionError(`EBP2 chunk ${String(ci)} too short`);

        const iv = encBuf.subarray(0, IV_LEN);
        const tag = encBuf.subarray(IV_LEN, IV_LEN + TAG_LEN);
        const ciphertext = encBuf.subarray(IV_LEN + TAG_LEN);

        const aad = buildEbp2Aad(objectKey, ci, chunkSize, totalSize, version);
        const decipher = crypto.createDecipheriv("aes-256-gcm", masterKey, iv);
        decipher.setAAD(aad);
        decipher.setAuthTag(tag);

        const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

        const chunkPlainStart = ci * chunkSize;
        const sliceStart = Math.max(0, start - chunkPlainStart);
        const sliceEnd = Math.min(plainLen - 1, end - chunkPlainStart);
        const slice = plain.subarray(sliceStart, sliceEnd + 1);

        if (slice.length > 0) this.push(slice);
        if (idx >= chunks.length) this.push(null);
      } catch (err) {
        this.destroy(err as Error);
      }
    },
  });

  return stream;
}


