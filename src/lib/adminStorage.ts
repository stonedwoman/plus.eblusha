import path from "node:path";
import { promises as fsp } from "node:fs";
import prisma from "./prisma";
import env from "../config/env";

export type StorageReport = {
  backend: "local" | "s3";
  /** Bytes used by user uploads, summed from DB attachment metadata. */
  dbAttachmentBytes: number;
  /** Number of attachments counted (DB rows). */
  dbAttachmentCount: number;
  /** Number of secret attachment refs (no size in schema). */
  secretAttachmentCount: number;
  /** Number of users with at least one upload. */
  userAvatarCount: number;
  /** Local storage details. Null when STORAGE_BACKEND=s3. */
  local: {
    path: string;
    /** statfs() snapshot of the filesystem hosting the storage path. */
    diskTotalBytes: number | null;
    diskFreeBytes: number | null;
    diskAvailableBytes: number | null;
    /** Sum of file sizes in LOCAL_STORAGE_PATH (recursive). Skipped when too slow / unavailable. */
    onDiskBytes: number | null;
    onDiskFileCount: number | null;
  } | null;
};

async function statfsBest(p: string): Promise<{
  diskTotalBytes: number | null;
  diskFreeBytes: number | null;
  diskAvailableBytes: number | null;
}> {
  // fs.statfs landed in Node 18.15.0 (experimental) and is stable in 19.6+.
  // Wrap it defensively so older runtimes still get a meaningful response.
  const fns = fsp as unknown as { statfs?: (p: string) => Promise<any> };
  if (typeof fns.statfs !== "function") {
    return { diskTotalBytes: null, diskFreeBytes: null, diskAvailableBytes: null };
  }
  try {
    const s = await fns.statfs(p);
    const bsize = Number(s?.bsize ?? 0);
    const blocks = Number(s?.blocks ?? 0);
    const bfree = Number(s?.bfree ?? 0);
    const bavail = Number(s?.bavail ?? 0);
    if (!bsize) {
      return { diskTotalBytes: null, diskFreeBytes: null, diskAvailableBytes: null };
    }
    return {
      diskTotalBytes: bsize * blocks,
      diskFreeBytes: bsize * bfree,
      diskAvailableBytes: bsize * bavail,
    };
  } catch {
    return { diskTotalBytes: null, diskFreeBytes: null, diskAvailableBytes: null };
  }
}

/**
 * Walk the storage tree to compute on-disk size. Runs sequentially with a
 * cap to keep the admin endpoint responsive on large stores. Returns null if
 * the cap is reached or the path is unreadable.
 */
async function tryWalkOnDisk(rootPath: string, opts?: { maxFiles?: number }): Promise<{
  bytes: number;
  files: number;
} | null> {
  const limit = opts?.maxFiles ?? 50_000;
  let bytes = 0;
  let files = 0;
  const stack: string[] = [rootPath];
  try {
    while (stack.length > 0) {
      const current = stack.pop() as string;
      let entries: import("node:fs").Dirent[];
      try {
        entries = await fsp.readdir(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const abs = path.join(current, e.name);
        if (e.isDirectory()) {
          stack.push(abs);
          continue;
        }
        if (!e.isFile()) continue;
        try {
          const st = await fsp.stat(abs);
          bytes += st.size;
          files += 1;
          if (files > limit) return null;
        } catch {
          // ignore unreadable entries
        }
      }
    }
    return { bytes, files };
  } catch {
    return null;
  }
}

export async function buildStorageReport(opts?: { walk?: boolean }): Promise<StorageReport> {
  const backend: "local" | "s3" = (env.STORAGE_BACKEND ?? "s3") as any;

  // DB summaries are cheap aggregates — always run.
  const [attAgg, secretCount, avatarCount] = await Promise.all([
    prisma.messageAttachment.aggregate({
      _sum: { size: true },
      _count: { _all: true },
    }),
    prisma.secretAttachmentRef.count({ where: { deletedAt: null } }),
    prisma.user.count({ where: { avatarUrl: { not: null } } }),
  ]);

  const report: StorageReport = {
    backend,
    dbAttachmentBytes: Number(attAgg._sum?.size ?? 0),
    dbAttachmentCount: Number(attAgg._count?._all ?? 0),
    secretAttachmentCount: Number(secretCount ?? 0),
    userAvatarCount: Number(avatarCount ?? 0),
    local: null,
  };

  if (backend === "local") {
    const basePath = path.resolve(env.LOCAL_STORAGE_PATH ?? "/var/lib/eblusha/storage");
    const fsStats = await statfsBest(basePath);
    let onDisk: { bytes: number; files: number } | null = null;
    if (opts?.walk) {
      onDisk = await tryWalkOnDisk(basePath);
    }
    report.local = {
      path: basePath,
      diskTotalBytes: fsStats.diskTotalBytes,
      diskFreeBytes: fsStats.diskFreeBytes,
      diskAvailableBytes: fsStats.diskAvailableBytes,
      onDiskBytes: onDisk?.bytes ?? null,
      onDiskFileCount: onDisk?.files ?? null,
    };
  }

  return report;
}
