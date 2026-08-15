#!/usr/bin/env npx ts-node
/**
 * Remove storage files that are not referenced in the database.
 *
 * Collects keys from: MessageAttachment.url, metadata.posterKey,
 * User.avatarUrl, Conversation.avatarUrl, SecretAttachmentRef.objectKey.
 * Deletes files in LOCAL_STORAGE_PATH that are not in that set.
 *
 * Usage:
 *   npx ts-node src/scripts/gcUnusedStorageFiles.ts           # dry-run by default
 *   npx ts-node src/scripts/gcUnusedStorageFiles.ts --delete # actually delete
 */

import fs from "fs";
import path from "path";
import { PrismaClient } from "@prisma/client";
import env from "../config/env";
import { extractStorageKeyCandidatesFromUrl } from "../lib/storageDeletion";

const prisma = new PrismaClient();
const basePath = path.resolve(
  env.LOCAL_STORAGE_PATH ?? "/var/lib/eblusha/storage"
);
const doDelete = process.argv.includes("--delete");

function toEblushaKeyLocal(k: string): string {
  if (k.endsWith(".eblusha")) return k;
  const parts = k.split("/");
  const base = parts.pop() ?? "";
  const baseNoExt = base.includes(".")
    ? base.slice(0, base.lastIndexOf("."))
    : base;
  parts.push(`${baseNoExt}.eblusha`);
  return parts.join("/");
}

async function main() {
  const used = new Set<string>();

  // Превью-дериваты (<key>.thumb.eblusha) генерятся на аплоаде и в БД НЕ записываются —
  // ключ выводится на лету (files.ts ?thumb=1). Без этой строки ночной GC считал их
  // сиротами и ежедневно сносил все превью (ревью).
  const deriveThumbKeyLocal = (key: string): string =>
    key.endsWith(".eblusha") ? key.replace(/\.eblusha$/, ".thumb.eblusha") : `${key}.thumb`;

  const markUsed = (k: string) => {
    used.add(k);
    used.add(deriveThumbKeyLocal(k));
  };

  const addFromUrl = (url: string | null) => {
    if (!url || typeof url !== "string") return;
    const keys = extractStorageKeyCandidatesFromUrl(url.trim());
    keys.forEach((k) => markUsed(k));
  };

  const addFromKey = (key: string | null) => {
    if (!key || typeof key !== "string") return;
    const k = key.trim().replace(/^\//, "");
    if (!k || k.includes("..")) return;
    markUsed(k);
    markUsed(toEblushaKeyLocal(k));
  };

  console.log("Collecting used keys from DB...");

  const [attachments, users, conversations, secretRefs] = await Promise.all([
    prisma.messageAttachment.findMany({
      select: { url: true, metadata: true },
    }),
    prisma.user.findMany({
      where: { avatarUrl: { not: null } },
      select: { avatarUrl: true },
    }),
    prisma.conversation.findMany({
      where: { avatarUrl: { not: null } },
      select: { avatarUrl: true },
    }),
    prisma.secretAttachmentRef.findMany({
      where: { deletedAt: null },
      select: { objectKey: true },
    }),
  ]);

  for (const a of attachments) {
    addFromUrl(a.url);
    const meta = (a.metadata ?? {}) as Record<string, unknown>;
    const posterKey = meta.posterKey;
    if (typeof posterKey === "string") addFromKey(posterKey);
  }
  for (const u of users) addFromUrl(u.avatarUrl);
  for (const c of conversations) addFromUrl(c.avatarUrl);
  for (const r of secretRefs) addFromKey(r.objectKey);

  console.log("Used keys:", used.size);

  if (!fs.existsSync(basePath)) {
    console.log("Storage path does not exist:", basePath);
    return;
  }

  function walkDir(dir: string, prefix: string): string[] {
    const keys: string[] = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) {
        keys.push(...walkDir(path.join(dir, e.name), rel));
      } else if (e.isFile() && !e.name.endsWith(".meta.json")) {
        keys.push(rel);
      }
    }
    return keys;
  }

  const allKeys = walkDir(basePath, "");
  const orphaned = allKeys.filter((k) => !used.has(k));

  console.log("Total files:", allKeys.length);
  console.log("Orphaned (not in DB):", orphaned.length);

  if (orphaned.length === 0) {
    console.log("Nothing to delete.");
    return;
  }

  if (!doDelete) {
    console.log("\nDry-run. Orphaned files (first 20):");
    orphaned.slice(0, 20).forEach((k) => console.log(" ", k));
    if (orphaned.length > 20) {
      console.log(" ... and", orphaned.length - 20, "more");
    }
    console.log("\nRun with --delete to actually remove them.");
    return;
  }

  console.log("\nDeleting", orphaned.length, "orphaned files...");
  let deleted = 0;
  for (const key of orphaned) {
    const absolute = path.join(basePath, key);
    try {
      if (fs.existsSync(absolute) && fs.statSync(absolute).isFile()) {
        fs.unlinkSync(absolute);
        deleted++;
      }
      const metaPath = absolute + ".meta.json";
      if (fs.existsSync(metaPath)) {
        fs.unlinkSync(metaPath);
      }
    } catch (e: any) {
      console.error("ERR deleting", key, e?.message);
    }
  }
  console.log("Deleted:", deleted);
}

main()
  .finally(() => prisma.$disconnect())
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
