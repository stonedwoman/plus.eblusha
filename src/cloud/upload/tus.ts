import fs from "node:fs";
import fsp from "node:fs/promises";
import crypto from "node:crypto";
import { Router } from "express";
import type { Request, Response } from "express";
import prisma from "../../lib/prisma";
import logger from "../../config/logger";
import { getRedisClient } from "../../lib/redis";
import { rateLimit } from "../../middlewares/rateLimit";
import cloudConfig from "../config";
import { CloudError, ah, conflict, forbidden, invalid, notFound, tooLarge } from "../errors";
import { requireCloudUser, requireCsrf } from "../auth/middleware";
import { requireSpaceAccess } from "../acl";
import { assertCanAccept } from "../storage/quota";
import { stagingPath } from "../paths";
import { emitCloud, userRoom } from "../realtime";
import { finalizeUpload } from "./finalize";

/**
 * Серверная сторона протокола tus 1.0.0 (core + creation + termination).
 *
 * Почему протокол, а не самодельная схема: на клиенте стоит зрелый tus-js-client,
 * который сам умеет ретраи, экспоненциальный backoff, восстановление после
 * обрыва сети и хранение url между перезагрузками страницы. Нам остаётся честно
 * реализовать серверную половину и связать её с БД, квотами и правами.
 *
 * Состояние загрузки живёт в CloudUploadSession (Postgres), а не в памяти
 * процесса, поэтому рестарт backend не убивает 25-гигабайтную закачку.
 */
const TUS_VERSION = "1.0.0";
const TUS_EXTENSIONS = "creation,creation-with-upload,termination,expiration";
const PROGRESS_FLUSH_MS = 1500;

function tusHeaders(res: Response): void {
  res.setHeader("Tus-Resumable", TUS_VERSION);
  res.setHeader("Cache-Control", "no-store");
}

function decodeMetadata(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const pair of header.split(",")) {
    const [rawKey, rawVal] = pair.trim().split(" ");
    if (!rawKey) continue;
    const key = rawKey.trim();
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(key)) continue;
    try {
      out[key] = rawVal ? Buffer.from(rawVal, "base64").toString("utf8").slice(0, 1024) : "";
    } catch {
      // мусорная метадата игнорируется, а не роняет запрос
    }
  }
  return out;
}

/** Имя файла — только метаданные. Путь на диске из него не строится никогда. */
export function sanitizeName(raw: string): string {
  const cleaned = (raw || "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[/\\]/g, "_")
    .trim();
  const name = cleaned === "." || cleaned === ".." ? "_" : cleaned;
  return (name || "file").slice(0, 255);
}

async function lockUpload(protocolId: string): Promise<string | null> {
  const redis = await getRedisClient();
  const token = crypto.randomBytes(12).toString("hex");
  const ok = await redis.set(`cloud:upload:lock:${protocolId}`, token, { NX: true, EX: 120 });
  return ok ? token : null;
}

async function unlockUpload(protocolId: string, token: string): Promise<void> {
  const redis = await getRedisClient();
  const key = `cloud:upload:lock:${protocolId}`;
  const cur = await redis.get(key);
  if (cur === token) await redis.del(key);
}

function uploadLocation(protocolId: string): string {
  return `/api/cloud/uploads/tus/${protocolId}`;
}

const router = Router();

// Наружу всегда отдаём Tus-Resumable, иначе клиент считает сервер несовместимым.
router.options("/tus", (_req, res) => {
  tusHeaders(res);
  res.setHeader("Tus-Version", TUS_VERSION);
  res.setHeader("Tus-Extension", TUS_EXTENSIONS);
  res.setHeader("Tus-Max-Size", String(cloudConfig.CLOUD_MAX_FILE_BYTES));
  res.status(204).end();
});

router.options("/tus/:id", (_req, res) => {
  tusHeaders(res);
  res.setHeader("Tus-Version", TUS_VERSION);
  res.setHeader("Tus-Extension", TUS_EXTENSIONS);
  res.status(204).end();
});

router.use(requireCloudUser);

/** POST /api/cloud/uploads/tus — создание загрузки. */
router.post(
  "/tus",
  requireCsrf,
  rateLimit({ name: "cloud-upload-create", windowMs: 60_000, max: 400 }),
  ah(async (req: Request, res: Response) => {
    tusHeaders(res);
    const user = req.cloudUser!;
    const lengthRaw = req.headers["upload-length"];
    const length = Number(Array.isArray(lengthRaw) ? lengthRaw[0] : lengthRaw);
    if (!Number.isFinite(length) || length < 0) throw invalid("Upload-Length обязателен");

    const meta = decodeMetadata(req.headers["upload-metadata"] as string | undefined);
    const spaceId = meta.spaceId ?? "";
    if (!spaceId) throw invalid("Не указан Space");
    const access = await requireSpaceAccess(req, spaceId, "file:upload");

    const folderId: string | null = meta.folderId && meta.folderId !== "root" ? meta.folderId : null;
    if (folderId) {
      const folder = await prisma.cloudFolder.findFirst({ where: { id: folderId, spaceId, deletedAt: null } });
      if (!folder) throw notFound("Папка не найдена");
    }

    await assertCanAccept(length);

    const fingerprint = (meta.fingerprint || "").slice(0, 200) || crypto.randomBytes(16).toString("hex");
    const clientMtime = meta.mtime && /^\d+$/.test(meta.mtime) ? new Date(Number(meta.mtime)) : null;
    const protocolId = crypto.randomBytes(24).toString("base64url");

    const session = await prisma.cloudUploadSession.create({
      data: {
        userId: user.id,
        spaceId: access.space.id,
        folderId,
        originalName: sanitizeName(meta.filename ?? meta.name ?? "file"),
        expectedSize: BigInt(length),
        mimeType: (meta.filetype || meta.type || "").slice(0, 200) || null,
        fingerprint,
        uploadProtocolId: protocolId,
        status: "CREATED",
        clientMtime: clientMtime && !Number.isNaN(clientMtime.getTime()) ? clientMtime : null,
        expiresAt: new Date(Date.now() + cloudConfig.CLOUD_UPLOAD_TTL_HOURS * 3600_000),
      },
    });

    const handle = await fsp.open(stagingPath(protocolId), "w");
    await handle.close();

    res.setHeader("Location", uploadLocation(protocolId));
    res.setHeader("Upload-Expires", session.expiresAt.toUTCString());
    res.setHeader("Upload-Offset", "0");
    // Свой заголовок поверх tus: клиенту нужен id сессии, чтобы сопоставлять
    // realtime-события cloud.upload.updated со строкой в очереди загрузок.
    res.setHeader("X-Cloud-Upload-Session", session.id);
    res.setHeader("Access-Control-Expose-Headers", "Location, Upload-Offset, Upload-Length, Upload-Expires, Tus-Resumable, X-Cloud-Upload-Session");
    res.status(201).end();

    void emitCloud("cloud.upload.updated", [userRoom(user.id)], {
      id: session.id,
      spaceId: session.spaceId,
      status: "CREATED",
      name: session.originalName,
      expectedSize: Number(session.expectedSize),
      bytesReceived: 0,
    });
  })
);

async function loadOwnSession(req: Request) {
  const protocolId = String(req.params.id ?? "");
  if (!/^[A-Za-z0-9_-]{10,64}$/.test(protocolId)) throw notFound("Загрузка не найдена");
  const session = await prisma.cloudUploadSession.findUnique({ where: { uploadProtocolId: protocolId } });
  if (!session) throw notFound("Загрузка не найдена");
  // Чужую загрузку не отдаём даже на чтение — offset тоже информация.
  if (session.userId !== req.cloudUser!.id) throw forbidden("Это не ваша загрузка");
  return { session, protocolId };
}

/** HEAD — узнать текущий offset для докачки. */
router.head(
  "/tus/:id",
  ah(async (req: Request, res: Response) => {
    tusHeaders(res);
    const { session, protocolId } = await loadOwnSession(req);
    if (session.status === "CANCELLED") throw notFound("Загрузка отменена");
    // Источник истины по offset — реальный размер файла на диске, а не счётчик в БД.
    let size = 0;
    try {
      size = (await fsp.stat(stagingPath(protocolId))).size;
    } catch {
      size = session.status === "READY" || session.status === "PROCESSING" ? Number(session.expectedSize) : 0;
    }
    res.setHeader("Upload-Offset", String(size));
    res.setHeader("Upload-Length", String(session.expectedSize));
    res.setHeader("Upload-Expires", session.expiresAt.toUTCString());
    res.status(200).end();
  })
);

/** PATCH — дозапись байтов. */
router.patch(
  "/tus/:id",
  requireCsrf,
  ah(async (req: Request, res: Response) => {
    tusHeaders(res);
    const contentType = String(req.headers["content-type"] ?? "");
    if (!contentType.startsWith("application/offset+octet-stream")) {
      throw new CloudError(415, "UNSUPPORTED_MEDIA_TYPE", "Ожидается application/offset+octet-stream");
    }
    const { session, protocolId } = await loadOwnSession(req);
    if (session.status === "READY" || session.status === "PROCESSING" || session.status === "VERIFYING") {
      throw conflict("Загрузка уже завершена");
    }
    if (session.status === "CANCELLED") throw notFound("Загрузка отменена");

    const offsetHeader = req.headers["upload-offset"];
    const offset = Number(Array.isArray(offsetHeader) ? offsetHeader[0] : offsetHeader);
    if (!Number.isFinite(offset) || offset < 0) throw invalid("Upload-Offset обязателен");

    const staging = stagingPath(protocolId);
    const token = await lockUpload(protocolId);
    // Параллельный PATCH в тот же upload перемешал бы байты — второй запрос отбиваем.
    if (!token) throw conflict("Загрузка уже обрабатывается другим запросом");

    try {
      const stat = await fsp.stat(staging).catch(() => null);
      const currentSize = stat?.size ?? 0;
      if (offset !== currentSize) {
        res.setHeader("Upload-Offset", String(currentSize));
        throw conflict(`Offset не совпал: сервер на ${currentSize}`);
      }
      const expected = Number(session.expectedSize);
      const remaining = expected - currentSize;
      if (remaining <= 0) throw conflict("Загрузка уже полная");

      await prisma.cloudUploadSession.update({ where: { id: session.id }, data: { status: "UPLOADING" } });

      const written = await pipeChunk(req, staging, currentSize, remaining, {
        sessionId: session.id,
        userId: session.userId,
        spaceId: session.spaceId,
        name: session.originalName,
        expectedSize: expected,
      });
      const newOffset = currentSize + written;
      const complete = newOffset >= expected;

      await prisma.cloudUploadSession.update({
        where: { id: session.id },
        data: {
          bytesReceived: BigInt(newOffset),
          status: complete ? "UPLOADED" : "UPLOADING",
          expiresAt: new Date(Date.now() + cloudConfig.CLOUD_UPLOAD_TTL_HOURS * 3600_000),
        },
      });

      res.setHeader("Upload-Offset", String(newOffset));
      res.status(204).end();

      if (complete) {
        // Хеширование 30 ГБ — минуты; держать открытым PATCH ради этого нельзя.
        // Клиент узнаёт о завершении из cloud.upload.updated.
        void finalizeUpload(session.id).catch((err) => logger.error({ err }, "cloud finalize crashed"));
      }
    } finally {
      await unlockUpload(protocolId, token);
    }
  })
);

type ProgressCtx = {
  sessionId: string;
  userId: string;
  spaceId: string;
  name: string;
  expectedSize: number;
};

/**
 * Пишем поток запроса в staging начиная с offset. Ничего не буферизуем целиком:
 * между сокетом и диском — только highWaterMark потока.
 */
function pipeChunk(req: Request, staging: string, start: number, remaining: number, ctx: ProgressCtx): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(staging, { flags: "r+", start });
    let written = 0;
    let lastFlush = Date.now();
    let settled = false;

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      req.unpipe(ws);
      ws.destroy();
      reject(err);
    };

    req.on("data", (chunk: Buffer) => {
      written += chunk.length;
      if (written > remaining) {
        fail(tooLarge("Прислано больше, чем объявлено в Upload-Length"));
        return;
      }
      const now = Date.now();
      if (now - lastFlush > PROGRESS_FLUSH_MS) {
        lastFlush = now;
        const offset = start + written;
        void prisma.cloudUploadSession
          .update({ where: { id: ctx.sessionId }, data: { bytesReceived: BigInt(offset) } })
          .catch(() => undefined);
        void emitCloud("cloud.upload.updated", [userRoom(ctx.userId)], {
          id: ctx.sessionId,
          spaceId: ctx.spaceId,
          status: "UPLOADING",
          name: ctx.name,
          expectedSize: ctx.expectedSize,
          bytesReceived: offset,
        });
      }
    });

    req.on("aborted", () => fail(new Error("client aborted")));
    req.on("error", fail);
    ws.on("error", fail);
    ws.on("finish", () => {
      if (settled) return;
      settled = true;
      resolve(written);
    });
    req.pipe(ws);
  });
}

/** DELETE — termination extension. */
router.delete(
  "/tus/:id",
  requireCsrf,
  ah(async (req: Request, res: Response) => {
    tusHeaders(res);
    const { session, protocolId } = await loadOwnSession(req);
    await fsp.rm(stagingPath(protocolId), { force: true }).catch(() => undefined);
    await prisma.cloudUploadSession.update({ where: { id: session.id }, data: { status: "CANCELLED" } });
    await emitCloud("cloud.upload.updated", [userRoom(session.userId)], {
      id: session.id,
      spaceId: session.spaceId,
      status: "CANCELLED",
      name: session.originalName,
      expectedSize: Number(session.expectedSize),
      bytesReceived: Number(session.bytesReceived),
    });
    res.status(204).end();
  })
);

export default router;
