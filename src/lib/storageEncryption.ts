import crypto from "crypto";

const MAGIC = Buffer.from("EBP1", "utf8"); // Eblusha Blob Payload v1
const IV_LEN = 12; // recommended for GCM
const TAG_LEN = 16;

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

export function parseStorageEncKey(raw: string): Buffer {
  const trimmed = raw.trim();
  if (!trimmed) throw new StorageEncryptionError("STORAGE_ENC_KEY is empty");

  // Try hex
  if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length % 2 === 0) {
    const buf = Buffer.from(trimmed, "hex");
    if (buf.length !== 32) {
      throw new StorageEncryptionError(
        `STORAGE_ENC_KEY hex must decode to 32 bytes, got ${buf.length}`
      );
    }
    return buf;
  }

  // Try base64
  let buf: Buffer;
  try {
    buf = Buffer.from(trimmed, "base64");
  } catch {
    throw new StorageEncryptionError("STORAGE_ENC_KEY must be hex or base64");
  }

  if (buf.length !== 32) {
    throw new StorageEncryptionError(
      `STORAGE_ENC_KEY base64 must decode to 32 bytes, got ${buf.length}`
    );
  }
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


