#!/usr/bin/env npx ts-node
/**
 * Remove stale temporary upload files/sessions from tmp/uploads.
 *
 * Covers:
 * - chunk upload sessions: tmp/uploads/<uploadId>/
 * - loose multer temp files: tmp/uploads/upload-*
 *
 * Usage:
 *   npx ts-node src/scripts/gcUploadSessions.ts
 *   npx ts-node src/scripts/gcUploadSessions.ts --delete
 *   npx ts-node src/scripts/gcUploadSessions.ts --delete --max-age-hours 24
 */

import fs from "fs";
import path from "path";

type UploadManifest = {
  createdAt?: string;
};

const uploadsRoot = path.join(process.cwd(), "tmp", "uploads");
const doDelete = process.argv.includes("--delete");

function readFlagValue(flag: string): string | null {
  const idx = process.argv.indexOf(flag);
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1] ?? null;
  const inline = process.argv.find((arg) => arg.startsWith(`${flag}=`));
  return inline ? inline.slice(flag.length + 1) : null;
}

const maxAgeHours = Math.max(
  1,
  Number(readFlagValue("--max-age-hours") ?? process.env.UPLOAD_TMP_GC_MAX_AGE_HOURS ?? "24")
);
const maxAgeMs = maxAgeHours * 60 * 60 * 1000;

function getManifestCreatedAtMs(sessionDir: string): number | null {
  const manifestPath = path.join(sessionDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as UploadManifest;
    if (!raw.createdAt) return null;
    const ts = Date.parse(raw.createdAt);
    return Number.isFinite(ts) ? ts : null;
  } catch {
    return null;
  }
}

function isStale(tsMs: number, nowMs: number): boolean {
  return nowMs - tsMs >= maxAgeMs;
}

async function main() {
  if (!fs.existsSync(uploadsRoot)) {
    console.log(
      JSON.stringify({
        ok: true,
        uploadsRoot,
        exists: false,
        deleted: 0,
        dryRun: !doDelete,
      })
    );
    return;
  }

  const entries = fs.readdirSync(uploadsRoot, { withFileTypes: true });
  const nowMs = Date.now();
  const staleDirs: string[] = [];
  const staleFiles: string[] = [];

  for (const entry of entries) {
    const absolute = path.join(uploadsRoot, entry.name);
    let createdAtMs: number | null = null;

    try {
      const stat = fs.statSync(absolute);
      createdAtMs = stat.mtimeMs;

      if (entry.isDirectory()) {
        const manifestCreatedAtMs = getManifestCreatedAtMs(absolute);
        const effectiveCreatedAtMs = manifestCreatedAtMs ?? createdAtMs;
        if (isStale(effectiveCreatedAtMs, nowMs)) staleDirs.push(entry.name);
        continue;
      }

      if (entry.isFile() && entry.name.startsWith("upload-") && isStale(createdAtMs, nowMs)) {
        staleFiles.push(entry.name);
      }
    } catch (error: any) {
      console.error("ERR scanning upload tmp entry", entry.name, error?.message ?? error);
    }
  }

  if (!doDelete) {
    console.log(
      JSON.stringify({
        ok: true,
        uploadsRoot,
        maxAgeHours,
        dryRun: true,
        staleSessionDirs: staleDirs,
        staleLooseFiles: staleFiles,
      })
    );
    return;
  }

  let deletedDirs = 0;
  let deletedFiles = 0;

  for (const dirName of staleDirs) {
    try {
      fs.rmSync(path.join(uploadsRoot, dirName), { recursive: true, force: true });
      deletedDirs += 1;
    } catch (error: any) {
      console.error("ERR deleting stale upload session", dirName, error?.message ?? error);
    }
  }

  for (const fileName of staleFiles) {
    try {
      fs.rmSync(path.join(uploadsRoot, fileName), { force: true });
      deletedFiles += 1;
    } catch (error: any) {
      console.error("ERR deleting stale temp upload file", fileName, error?.message ?? error);
    }
  }

  console.log(
    JSON.stringify({
      ok: true,
      uploadsRoot,
      maxAgeHours,
      deletedDirs,
      deletedFiles,
      scannedEntries: entries.length,
    })
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
