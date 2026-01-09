"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.StorageEncryptionError = void 0;
exports.parseStorageEncKey = parseStorageEncKey;
exports.isEncryptedPayload = isEncryptedPayload;
exports.encryptBuffer = encryptBuffer;
exports.decryptBuffer = decryptBuffer;
const crypto_1 = __importDefault(require("crypto"));
const MAGIC = Buffer.from("EBP1", "utf8"); // Eblusha Blob Payload v1
const IV_LEN = 12; // recommended for GCM
const TAG_LEN = 16;
class StorageEncryptionError extends Error {
}
exports.StorageEncryptionError = StorageEncryptionError;
function parseStorageEncKey(raw) {
    const trimmed = raw.trim();
    if (!trimmed)
        throw new StorageEncryptionError("STORAGE_ENC_KEY is empty");
    // Try hex
    if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length % 2 === 0) {
        const buf = Buffer.from(trimmed, "hex");
        if (buf.length !== 32) {
            throw new StorageEncryptionError(`STORAGE_ENC_KEY hex must decode to 32 bytes, got ${buf.length}`);
        }
        return buf;
    }
    // Try base64
    let buf;
    try {
        buf = Buffer.from(trimmed, "base64");
    }
    catch {
        throw new StorageEncryptionError("STORAGE_ENC_KEY must be hex or base64");
    }
    if (buf.length !== 32) {
        throw new StorageEncryptionError(`STORAGE_ENC_KEY base64 must decode to 32 bytes, got ${buf.length}`);
    }
    return buf;
}
function isEncryptedPayload(buf) {
    return buf.length >= MAGIC.length + IV_LEN + TAG_LEN && buf.subarray(0, 4).equals(MAGIC);
}
function encryptBuffer(plaintext, masterKey, opts) {
    const iv = crypto_1.default.randomBytes(IV_LEN);
    const cipher = crypto_1.default.createCipheriv("aes-256-gcm", masterKey, iv);
    if (opts?.aad)
        cipher.setAAD(Buffer.from(opts.aad, "utf8"));
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
function decryptBuffer(payload, masterKey, opts) {
    if (!isEncryptedPayload(payload)) {
        throw new StorageEncryptionError("Payload is not encrypted (missing magic header)");
    }
    const iv = payload.subarray(MAGIC.length, MAGIC.length + IV_LEN);
    const tag = payload.subarray(MAGIC.length + IV_LEN, MAGIC.length + IV_LEN + TAG_LEN);
    const ciphertext = payload.subarray(MAGIC.length + IV_LEN + TAG_LEN);
    const decipher = crypto_1.default.createDecipheriv("aes-256-gcm", masterKey, iv);
    if (opts?.aad)
        decipher.setAAD(Buffer.from(opts.aad, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
//# sourceMappingURL=storageEncryption.js.map