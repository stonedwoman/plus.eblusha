#!/usr/bin/env npx ts-node
/**
 * Unify storage: flatten uploads/uploads → uploads, convert all files to .eblusha
 *
 * 1. Move uploads/uploads/* to uploads/ (resolve conflicts)
 * 2. For each file not .eblusha: encrypt if plaintext, rename/save as .eblusha
 * 3. Update DB URLs to new keys
 *
 * Usage:
 *   npx ts-node src/scripts/unifyStorage.ts           # dry-run
 *   npx ts-node src/scripts/unifyStorage.ts --apply  # actually apply
 */

import fs from "fs";
import path from "path";
import { PrismaClient } from "@prisma/client";
import env from "../config/env";
import {
  encryptBuffer,
  isEncryptedPayload,
  parseStorageEncKey,
} from "../lib/storageEncryption";

const prisma = new PrismaClient();
const basePath = path.resolve(
  env.LOCAL_STORAGE_PATH ?? "/var/lib/eblusha/storage"
);
const prefix = (env.STORAGE_PREFIX ?? "uploads").replace(/^\/|\/$/g, "");
const doApply = process.argv.includes("--apply");

function extToMime(ext: string): string {
  const m: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    webm: "audio/webm",
    mp4: "video/mp4",
    ogg: "audio/ogg",
  };
  return m[ext.toLowerCase()] ?? "application/octet-stream";
}

function encodeKeyForUrl(key: string): string {
  return key
    .split("/")
    .map((s) => encodeURIComponent(s))
    .join("/");
}

async function main() {
  if (!env.STORAGE_ENC_KEY) {
    throw new Error("STORAGE_ENC_KEY required for encryption");
  }
  const encKey = parseStorageEncKey(env.STORAGE_ENC_KEY);

  console.log("Unify storage: flatten uploads/uploads, convert to .eblusha");
  console.log("  Base path:", basePath);
  console.log("  Apply:", doApply);

  if (!fs.existsSync(basePath)) {
    console.log("Storage path does not exist");
    return;
  }

  const uploadsDir = path.join(basePath, prefix);
  const nestedDir = path.join(uploadsDir, "uploads");

  const keyToNewKey = new Map<string, string>();

  function relPathToKey(rel: string): string {
    return rel.replace(path.sep, "/");
  }

  // 1. Flatten uploads/uploads -> uploads
  if (fs.existsSync(nestedDir)) {
    const entries = fs.readdirSync(nestedDir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile() || e.name.endsWith(".meta.json")) continue;
      const oldKey = `${prefix}/uploads/${e.name}`;
      let newKey = `${prefix}/${e.name}`;
      const oldPath = path.join(basePath, oldKey.replace(/\//g, path.sep));
      let newPath = path.join(basePath, newKey.replace(/\//g, path.sep));

      if (fs.existsSync(newPath)) {
        const base = e.name.replace(/\.[^.]+$/, "");
        const ext = path.extname(e.name).slice(1) || "bin";
        newKey = `${prefix}/${base}-nested.${ext}`;
        newPath = path.join(basePath, newKey.replace(/\//g, path.sep));
        let idx = 0;
        while (fs.existsSync(newPath)) {
          idx++;
          newKey = `${prefix}/${base}-nested${idx}.${ext}`;
          newPath = path.join(basePath, newKey.replace(/\//g, path.sep));
        }
      }
      keyToNewKey.set(oldKey, newKey);
      if (doApply) {
        fs.mkdirSync(path.dirname(newPath), { recursive: true });
        fs.renameSync(oldPath, newPath);
        const metaOld = oldPath + ".meta.json";
        if (fs.existsSync(metaOld)) {
          fs.renameSync(metaOld, newPath + ".meta.json");
        }
        console.log("Flatten:", oldKey, "->", newKey);
      } else {
        console.log("Would flatten:", oldKey, "->", newKey);
      }
    }
    if (doApply) {
      try {
        fs.rmdirSync(nestedDir);
      } catch {}
    }
  }

  // 2. Convert non-.eblusha to .eblusha
  function walk(dir: string, relPrefix: string): Array<{ key: string; abs: string }> {
    const out: Array<{ key: string; abs: string }> = [];
    if (!fs.existsSync(dir)) return out;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = relPrefix ? `${relPrefix}/${e.name}` : e.name;
      const abs = path.join(dir, e.name);
      if (e.isDirectory() && e.name !== "_migrated") {
        out.push(...walk(abs, rel));
      } else if (e.isFile() && !e.name.endsWith(".meta.json")) {
        out.push({ key: rel.replace(/\\/g, "/"), abs });
      }
    }
    return out;
  }

  const allFiles = walk(uploadsDir, prefix);
  for (const { key, abs } of allFiles) {
    if (key.endsWith(".eblusha")) continue;

    const base = key.replace(/\.[^.]+$/, "");
    const newKey = `${base}.eblusha`;
    const newPath = path.join(basePath, newKey.replace(/\//g, path.sep));

    if (keyToNewKey.has(key)) continue; // already mapped from flatten step
    keyToNewKey.set(key, newKey);

    const buf = fs.readFileSync(abs);
    let outBuf: Buffer;
    let meta: Record<string, string>;

    if (isEncryptedPayload(buf)) {
      outBuf = buf;
      const metaPath = abs + ".meta.json";
      meta = fs.existsSync(metaPath)
        ? (JSON.parse(fs.readFileSync(metaPath, "utf8")) as Record<string, string>)
        : {};
      meta.ct = meta.ct || meta.contentType || "application/octet-stream";
    } else {
      const ext = path.extname(key).slice(1) || "bin";
      const contentType = extToMime(ext);
      const { payload, meta: encMeta } = encryptBuffer(buf, encKey, {
        aad: newKey,
        contentType,
      });
      outBuf = payload;
      meta = {
        enc: "ebp1",
        encv: encMeta.v,
        encalg: encMeta.alg,
        enciv: encMeta.iv,
        enctag: encMeta.tag,
        ct: contentType,
        aad: newKey,
      };
    }

    if (doApply) {
      fs.mkdirSync(path.dirname(newPath), { recursive: true });
      fs.writeFileSync(newPath, outBuf);
      fs.writeFileSync(newPath + ".meta.json", JSON.stringify(meta));
      fs.unlinkSync(abs);
      try {
        fs.unlinkSync(abs + ".meta.json");
      } catch {}
      console.log("Convert:", key, "->", newKey);
    } else {
      console.log("Would convert:", key, "->", newKey);
    }
  }

  // 3. Update DB
  if (keyToNewKey.size === 0) {
    console.log("Nothing to update in DB");
    return;
  }

  const buildNewUrl = (oldUrl: string): string | null => {
    if (!oldUrl || typeof oldUrl !== "string") return null;
    let afterFiles = "";
    try {
      if (oldUrl.includes("/api/files/")) {
        afterFiles = oldUrl.split("/api/files/")[1]?.split("?")[0] ?? "";
      } else {
        const u = new URL(oldUrl, "http://x");
        const idx = u.pathname.indexOf("/api/files/");
        if (idx >= 0) {
          afterFiles = u.pathname.slice(idx + "/api/files/".length);
        }
      }
    } catch {
      return null;
    }
    if (!afterFiles) return null;
    const decoded = decodeURIComponent(afterFiles).replace(/^\//, "").replace(/\/+/g, "/");
    const candidates = [decoded];
    if (prefix && !decoded.startsWith(prefix)) {
      candidates.push(`${prefix}/${decoded}`);
    }
    for (const k of candidates) {
      let resolved = k;
      while (keyToNewKey.has(resolved)) {
        resolved = keyToNewKey.get(resolved)!;
      }
      if (resolved !== k) {
        return `/api/files/${encodeKeyForUrl(resolved)}`;
      }
    }
    return null;
  };

  const updateUrl = async (
    model: "messageAttachment" | "user" | "conversation",
    field: "url" | "avatarUrl"
  ) => {
    const rows = await (prisma[model] as any).findMany({
      select: { id: true, [field]: true },
    });
    let upd = 0;
    for (const r of rows) {
      const oldUrl = (r as any)[field];
      if (!oldUrl) continue;
      const newUrl = buildNewUrl(oldUrl);
      if (newUrl && newUrl !== oldUrl) {
        if (doApply) {
          await (prisma[model] as any).update({
            where: { id: r.id },
            data: { [field]: newUrl },
          });
        }
        upd++;
      }
    }
    return upd;
  };

  const updateAttachmentMetadata = async () => {
    const attachments = await prisma.messageAttachment.findMany({
      select: { id: true, metadata: true },
    });
    let upd = 0;
    for (const a of attachments) {
      const meta = (a.metadata ?? {}) as Record<string, unknown>;
      const posterKey = meta.posterKey;
      if (typeof posterKey !== "string") continue;
      let newKey = posterKey;
      while (keyToNewKey.has(newKey)) {
        newKey = keyToNewKey.get(newKey)!;
      }
      if (newKey === posterKey) continue;
      if (doApply) {
        await prisma.messageAttachment.update({
          where: { id: a.id },
          data: { metadata: { ...meta, posterKey: newKey } },
        });
      }
      upd++;
    }
    return upd;
  };

  const updateSecretRefs = async () => {
    const refs = await prisma.secretAttachmentRef.findMany({
      where: { deletedAt: null },
      select: { id: true, objectKey: true },
    });
    let upd = 0;
    for (const r of refs) {
      let newKey = r.objectKey;
      while (keyToNewKey.has(newKey)) {
        newKey = keyToNewKey.get(newKey)!;
      }
      if (newKey === r.objectKey) continue;
      if (doApply) {
        await prisma.secretAttachmentRef.update({
          where: { id: r.id },
          data: { objectKey: newKey },
        });
      }
      upd++;
    }
    return upd;
  };

  console.log("\nUpdating DB...");
  const [a1, a2, a3, a4, a5] = await Promise.all([
    updateUrl("messageAttachment", "url"),
    updateUrl("user", "avatarUrl"),
    updateUrl("conversation", "avatarUrl"),
    updateAttachmentMetadata(),
    updateSecretRefs(),
  ]);

  console.log("  Attachments:", a1);
  console.log("  User avatars:", a2);
  console.log("  Conversation avatars:", a3);
  console.log("  Poster keys:", a4);
  console.log("  Secret refs:", a5);

  if (!doApply) {
    console.log("\nDry-run. Run with --apply to apply changes.");
  }
}

main()
  .finally(() => prisma.$disconnect())
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
