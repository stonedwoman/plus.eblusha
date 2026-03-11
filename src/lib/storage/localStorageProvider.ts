import fs from "fs";
import path from "path";
import { Readable } from "stream";
import type { StorageProvider, StorageHeadResult, StorageGetResult } from "./types";

/** Normalize key: remove leading slashes, forbid path traversal. Returns null if invalid. */
function normalizeKey(key: string): string | null {
  if (!key || typeof key !== "string") return null;
  const trimmed = key.trim().replace(/^\/+/, "");
  if (!trimmed) return null;
  // Path traversal protection
  if (trimmed.includes("..") || path.isAbsolute(trimmed)) return null;
  if (trimmed.includes("\\")) return null; // No backslashes
  return trimmed;
}

/** Resolve key to absolute path and verify it stays under baseDir. */
function resolvePath(baseDir: string, key: string): { absolute: string; valid: boolean } {
  const norm = normalizeKey(key);
  if (!norm) return { absolute: "", valid: false };
  const absolute = path.resolve(baseDir, norm);
  const baseResolved = path.resolve(baseDir);
  const valid =
    absolute === baseResolved || absolute.startsWith(baseResolved + path.sep);
  return { absolute, valid };
}

export interface LocalStorageProviderOptions {
  basePath: string;
}

export class LocalStorageProvider implements StorageProvider {
  private readonly basePath: string;

  constructor(options: LocalStorageProviderOptions) {
    this.basePath = path.resolve(options.basePath);
  }

  isAvailable(): boolean {
    try {
      const stat = fs.statSync(this.basePath);
      return stat.isDirectory();
    } catch {
      return false;
    }
  }

  private resolve(key: string): { absolute: string; valid: boolean } {
    return resolvePath(this.basePath, key);
  }

  async putObject(
    key: string,
    body: Buffer | Readable,
    options?: { contentType?: string; metadata?: Record<string, string> }
  ): Promise<void> {
    const { absolute, valid } = this.resolve(key);
    if (!valid) {
      throw new Error(`Invalid storage key: path traversal or invalid characters`);
    }
    const dir = path.dirname(absolute);
    fs.mkdirSync(dir, { recursive: true });
    if (Buffer.isBuffer(body)) {
      fs.writeFileSync(absolute, body);
    } else {
      const w = fs.createWriteStream(absolute);
      await new Promise<void>((resolve, reject) => {
        body.pipe(w);
        body.on("error", reject);
        w.on("finish", resolve);
        w.on("error", reject);
      });
    }
    if (options?.metadata) {
      const metaPath = absolute + ".meta.json";
      fs.writeFileSync(
        metaPath,
        JSON.stringify({
          contentType: options.contentType,
          ...options.metadata,
        })
      );
    }
  }

  async headObject(key: string): Promise<StorageHeadResult | null> {
    const { absolute, valid } = this.resolve(key);
    if (!valid) return null;
    try {
      const stat = fs.statSync(absolute);
      if (!stat.isFile()) return null;
      let contentType = "application/octet-stream";
      let metadata: Record<string, string> = {};
      const metaPath = absolute + ".meta.json";
      if (fs.existsSync(metaPath)) {
        try {
          const meta = JSON.parse(
            fs.readFileSync(metaPath, "utf8")
          ) as Record<string, string>;
          contentType = meta.ct || meta.contentType || contentType;
          const { ct, contentType: _, ...rest } = meta;
          metadata = rest;
        } catch {
          // ignore meta parse errors
        }
      }
      return {
        contentLength: stat.size,
        contentType,
        lastModified: stat.mtime,
        metadata,
      };
    } catch (e: any) {
      if (e?.code === "ENOENT") return null;
      throw e;
    }
  }

  async getObject(
    key: string,
    range?: { start: number; end: number }
  ): Promise<StorageGetResult> {
    const { absolute, valid } = this.resolve(key);
    if (!valid) {
      throw new Error("Invalid storage key");
    }
    if (!fs.existsSync(absolute)) {
      const err = new Error("File not found") as Error & { code?: string };
      err.code = "NotFound";
      throw err;
    }
    const stat = fs.statSync(absolute);
    if (!stat.isFile()) {
      const err = new Error("Not a file") as Error & { code?: string };
      err.code = "NotFound";
      throw err;
    }
    let contentType = "application/octet-stream";
    let metadata: Record<string, string> = {};
    const metaPath = absolute + ".meta.json";
    if (fs.existsSync(metaPath)) {
      try {
        const meta = JSON.parse(
          fs.readFileSync(metaPath, "utf8")
        ) as Record<string, string>;
        contentType = meta.ct || meta.contentType || contentType;
        metadata = meta;
      } catch {
        // ignore
      }
    }
    let stream: Readable;
    if (range !== undefined) {
      const { start, end } = range;
      const len = end - start + 1;
      stream = fs.createReadStream(absolute, { start, end });
      return {
        body: stream,
        contentLength: len,
        contentType,
        metadata,
      };
    }
    stream = fs.createReadStream(absolute);
    return {
      body: stream,
      contentLength: stat.size,
      contentType,
      metadata,
    };
  }

  async deleteObject(key: string): Promise<void> {
    const { absolute, valid } = this.resolve(key);
    if (!valid) return;
    try {
      fs.unlinkSync(absolute);
    } catch (e: any) {
      if (e?.code !== "ENOENT") throw e;
    }
    const metaPath = absolute + ".meta.json";
    try {
      fs.unlinkSync(metaPath);
    } catch {
      // ignore
    }
  }

  async deleteObjects(keys: string[]): Promise<{ deleted: number }> {
    let deleted = 0;
    for (const key of keys) {
      const { absolute, valid } = this.resolve(key);
      if (!valid) continue;
      try {
        if (fs.existsSync(absolute) && fs.statSync(absolute).isFile()) {
          fs.unlinkSync(absolute);
          deleted++;
        }
      } catch {
        // continue
      }
      const metaPath = absolute + ".meta.json";
      try {
        fs.unlinkSync(metaPath);
      } catch {
        // ignore
      }
    }
    return { deleted };
  }
}
