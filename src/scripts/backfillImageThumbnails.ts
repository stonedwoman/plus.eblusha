/**
 * Backfill: сгенерировать превью (~720px) для СУЩЕСТВУЮЩИХ картинок, у которых его ещё нет.
 *
 * Почему через HTTP-прокси, а не прямой декрипт: у объектов многослойное шифрование
 * (EBP1/EBP2 storage-ключом + иногда per-conversation DEK). Файл-прокси /api/files уже
 * умеет их расшифровывать (проверено, работает ежедневно) и ПУБЛИЧЕН (app.ts обходит
 * авторизацию для /files/). Поэтому берём расшифрованную картинку у самого прокси —
 * ноль дублирования крипто-логики, ноль риска рассинхрона.
 *
 * Безопасность: только ДОБАВЛЯЕТ объекты по деривативному ключу (deriveThumbKey), НИКОГДА
 * не трогает оригиналы. Идемпотентно (пропускает готовые). Секретные (E2EE) — пропускает
 * (прокси отдаёт шифротекст, не картинку → ffmpeg падает → skip; плюс явная проверка meta).
 *
 * Запуск (в контейнере бэкенда, где есть ffmpeg + сеть к себе):
 *   docker exec eblusha-backend node dist/scripts/backfillImageThumbnails.js --dry-run --limit 20
 *   docker exec eblusha-backend node dist/scripts/backfillImageThumbnails.js --limit 50
 *   docker exec eblusha-backend node dist/scripts/backfillImageThumbnails.js           # всё, с паузой 150мс
 * Флаги: --dry-run | --limit N | --delay MS | --base http://127.0.0.1:4000
 */
import env from "../config/env";
import prisma from "../lib/prisma";
import logger from "../config/logger";
import { getStorageProvider } from "../lib/storage";
import { encryptBuffer, parseStorageEncKey } from "../lib/storageEncryption";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";

const execAsync = promisify(exec);

const hasFlag = (f: string) => process.argv.includes(f);
const getArg = (n: string) => {
  const i = process.argv.indexOf(n);
  return i === -1 ? null : (process.argv[i + 1] ?? null);
};

const dryRun = hasFlag("--dry-run");
const limit = Number(getArg("--limit") ?? "0") || 0; // 0 => без лимита
const delayMs = Number(getArg("--delay") ?? "150") || 0;
const base = (getArg("--base") ?? process.env.BACKFILL_PROXY_BASE ?? "http://127.0.0.1:4000").replace(/\/$/, "");

const encKey = env.STORAGE_ENC_KEY ? parseStorageEncKey(env.STORAGE_ENC_KEY) : null;

// ДОЛЖЕН совпадать с deriveThumbKey в upload.ts / files.ts.
const deriveThumbKey = (key: string): string =>
  key.endsWith(".eblusha") ? key.replace(/\.eblusha$/, ".thumb.eblusha") : `${key}.thumb`;

// /api/files/<encodedKey> -> объектный ключ (как decodeKeyFromUrl в files.ts).
function objectKeyFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = url.match(/\/api\/files\/(.+)$/);
  const raw = m?.[1];
  if (!raw) return null;
  const p = (raw.split("?")[0] ?? "").replace(/^\//, "");
  if (!p) return null;
  try {
    return p.split("/").map((s) => decodeURIComponent(s)).join("/");
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!encKey) throw new Error("STORAGE_ENC_KEY not configured");
  const storage = getStorageProvider();

  let processed = 0;
  let made = 0;
  let skipped = 0;
  let failed = 0;
  const pageSize = 200;
  let cursor: string | null = null;

  logger.info({ dryRun, limit, delayMs, base }, "[backfill-thumb] start");

  outer: while (true) {
    const batch: Array<{ id: string; url: string; metadata: unknown }> =
      await prisma.messageAttachment.findMany({
        where: { type: "IMAGE" },
        select: { id: true, url: true, metadata: true },
        orderBy: { id: "asc" },
        take: pageSize,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      });
    if (batch.length === 0) break;
    const last = batch[batch.length - 1];
    if (!last) break;
    cursor = last.id;

    for (const att of batch) {
      if (limit && made >= limit) break outer;
      processed++;

      const meta = (att.metadata as Record<string, any> | null) || {};
      if (meta?.e2ee?.kind === "ciphertext") { skipped++; continue; } // секретная — пропуск

      const objKey = objectKeyFromUrl(att.url);
      if (!objKey) { skipped++; continue; }
      const thumbKey = deriveThumbKey(objKey);
      if (thumbKey === objKey) { skipped++; continue; }

      // уже есть превью?
      try {
        const h = await storage.headObject(thumbKey);
        if (h) { skipped++; continue; }
      } catch { /* нет — генерим */ }

      const inPath = path.join(os.tmpdir(), `bf-in-${crypto.randomBytes(6).toString("hex")}`);
      const outPath = path.join(os.tmpdir(), `bf-out-${crypto.randomBytes(6).toString("hex")}.jpg`);
      try {
        // расшифрованная картинка от самого файл-прокси
        const resp = await fetch(`${base}${att.url}`);
        if (!resp.ok) { failed++; continue; }
        const buf = Buffer.from(await resp.arrayBuffer());
        if (buf.length < 64) { skipped++; continue; }
        // НЕ фильтруем по content-type: у части объектов он application/octet-stream, хотя
        // байты — валидная картинка. Единственный валидатор «это картинка» — ffmpeg ниже
        // (секретный шифротекст / битое / неподдерживаемое → ffmpeg падает → failed, skip).
        fs.writeFileSync(inPath, buf);

        await execAsync(
          `ffmpeg -y -i "${inPath}" -vf "scale='min(720,iw)':-2" -frames:v 1 -q:v 5 "${outPath}"`,
          { timeout: 20000 }
        );
        const thumb = fs.existsSync(outPath) ? fs.readFileSync(outPath) : Buffer.alloc(0);
        if (thumb.length < 100) { failed++; continue; }

        if (!dryRun) {
          const enc = encryptBuffer(thumb, encKey, { aad: thumbKey, contentType: "image/jpeg" });
          await storage.putObject(thumbKey, enc.payload, {
            contentType: "application/octet-stream",
            metadata: {
              enc: "ebp1",
              encv: enc.meta.v,
              encalg: enc.meta.alg,
              enciv: enc.meta.iv,
              enctag: enc.meta.tag,
              ct: "image/jpeg",
            },
          });
        }
        made++;
      } catch (e) {
        failed++;
        logger.warn({ err: e, id: att.id }, "[backfill-thumb] failed (non-fatal)");
      } finally {
        try { if (fs.existsSync(inPath)) fs.unlinkSync(inPath); } catch { /* ignore */ }
        try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch { /* ignore */ }
      }

      if (processed % 50 === 0) logger.info({ processed, made, skipped, failed }, "[backfill-thumb] progress");
      if (delayMs) await sleep(delayMs);
    }
  }

  logger.info({ processed, made, skipped, failed, dryRun }, "[backfill-thumb] DONE");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    logger.error({ err: e }, "[backfill-thumb] fatal");
    process.exit(1);
  });
