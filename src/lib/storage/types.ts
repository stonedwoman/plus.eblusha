import type { Readable } from "stream";

/** Storage object metadata (content-type, encryption metadata, etc.) */
export interface StorageObjectMetadata {
  contentType?: string;
  contentLength?: number;
  lastModified?: Date;
  etag?: string;
  /** Custom metadata (e.g. enc, encalg, enciv, ct, aad for EBP1/EBP2) */
  metadata?: Record<string, string>;
}

/** Result of headObject or getObject metadata */
export interface StorageHeadResult {
  contentLength?: number;
  contentType?: string;
  lastModified?: Date;
  etag?: string;
  metadata?: Record<string, string>;
}

/** Result of getObject for streaming reads */
export interface StorageGetResult {
  body: Readable;
  contentLength?: number;
  contentType?: string;
  metadata?: Record<string, string>;
}

/** Storage provider interface. Abstraction over S3, local filesystem, etc. */
export interface StorageProvider {
  /** Put object. Key is logical storage key (e.g. uploads/123-uuid.eblusha). */
  putObject(
    key: string,
    body: Buffer | Readable | NodeJS.ReadableStream,
    options?: { contentType?: string; metadata?: Record<string, string> }
  ): Promise<void>;

  /** Get object. Returns stream or throws if not found. */
  getObject(key: string, range?: { start: number; end: number }): Promise<StorageGetResult>;

  /** Head object. Returns null if not found. */
  headObject(key: string): Promise<StorageHeadResult | null>;

  /** Delete single object. No-op if not found. */
  deleteObject(key: string): Promise<void>;

  /** Delete multiple objects. Returns count of successfully deleted. */
  deleteObjects(keys: string[]): Promise<{ deleted: number }>;

  /** Whether this provider is available (configured and ready). */
  isAvailable(): boolean;
}
