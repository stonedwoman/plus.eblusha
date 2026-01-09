export type EncryptionMetadata = {
    alg: "AES-256-GCM";
    v: "1";
    iv: string;
    tag: string;
    ct?: string;
};
export declare class StorageEncryptionError extends Error {
}
export declare function parseStorageEncKey(raw: string): Buffer;
export declare function isEncryptedPayload(buf: Buffer): boolean;
export declare function encryptBuffer(plaintext: Buffer, masterKey: Buffer, opts?: {
    aad?: string;
    contentType?: string;
}): {
    payload: Buffer;
    meta: EncryptionMetadata;
};
export declare function decryptBuffer(payload: Buffer, masterKey: Buffer, opts?: {
    aad?: string;
}): Buffer;
//# sourceMappingURL=storageEncryption.d.ts.map