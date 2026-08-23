import crypto from "node:crypto";
import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import bcrypt from "bcrypt";
import prisma from "../../lib/prisma";
import { getRedisClient } from "../../lib/redis";
import { rateLimit } from "../../middlewares/rateLimit";
import cloudConfig from "../config";
import { CloudError, ah, forbidden, notFound } from "../errors";
import { cloudCookieOptions } from "../auth/session";
import { objectAbsPath } from "../paths";
import { serveFile } from "../serve";
import { fileDto } from "../serialize";
import { writeAudit } from "../audit";
import { hashSecret } from "./shares";
import { shareFileWhere } from "./shareScope";
import { buildZipEntries, sendVariant, streamZip } from "./files";

/**
 * Публичный read-only доступ.
 *
 * Секрет ссылки живёт во фрагменте URL (#t=...), который браузер НЕ отправляет
 * серверу. Фронтенд достаёт его из фрагмента, обменивает POST-запросом на
 * короткоживущую HttpOnly-сессию и стирает из адресной строки через history API.
 * Так capability-секрет не попадает ни в access-логи, ни в Referer, ни в историю
 * прокси.
 *
 * Права проверяются на КАЖДОМ запросе по свежей записи в БД, поэтому revoke
 * действует мгновенно, а не когда истечёт сессия.
 */
const router = Router();

const SESSION_PREFIX = "cloud:share-sess:";

type ShareSession = { shareId: string; publicId: string; createdAt: number };

function cookieName(publicId: string): string {
  return `cloud_share_${publicId}`;
}

async function createShareSession(shareId: string, publicId: string): Promise<{ id: string; ttlMs: number }> {
  const redis = await getRedisClient();
  const id = crypto.randomBytes(24).toString("base64url");
  const ttl = Math.max(600, cloudConfig.CLOUD_SHARE_SESSION_TTL_HOURS * 3600);
  const record: ShareSession = { shareId, publicId, createdAt: Date.now() };
  await redis.set(SESSION_PREFIX + id, JSON.stringify(record), { EX: ttl });
  return { id, ttlMs: ttl * 1000 };
}

async function readShareSession(id: string): Promise<ShareSession | null> {
  if (!id || id.length > 128) return null;
  const redis = await getRedisClient();
  const raw = await redis.get(SESSION_PREFIX + id);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ShareSession;
  } catch {
    return null;
  }
}

declare module "express-serve-static-core" {
  interface Request {
    shareLink?: Awaited<ReturnType<typeof loadActiveShare>>;
  }
}

async function loadActiveShare(publicId: string) {
  const share = await prisma.cloudShareLink.findUnique({ where: { publicId } });
  if (!share || share.revokedAt) return null;
  if (share.expiresAt && share.expiresAt < new Date()) return null;
  const space = await prisma.cloudSpace.findFirst({ where: { id: share.spaceId, deletedAt: null } });
  if (!space) return null;
  return { share, space };
}

/** Обмен секрета из фрагмента на ограниченную сессию. */
router.post(
  "/:publicId/session",
  rateLimit({ name: "cloud-share-session", windowMs: 60_000, max: 30 }),
  ah(async (req: Request, res: Response) => {
    const publicId = String(req.params.publicId ?? "");
    if (!/^[A-Za-z0-9_-]{6,32}$/.test(publicId)) throw notFound("Ссылка недействительна");
    const body = z
      .object({ secret: z.string().min(1).max(200), password: z.string().max(200).optional() })
      .safeParse(req.body ?? {});
    if (!body.success) throw notFound("Ссылка недействительна");

    const active = await loadActiveShare(publicId);
    // Одинаковый ответ на «нет такой ссылки», «отозвана» и «неверный секрет» —
    // иначе публичный эндпоинт становится оракулом существования ссылок.
    if (!active) throw notFound("Ссылка недействительна или отозвана");

    const provided = Buffer.from(hashSecret(body.data.secret));
    const expected = Buffer.from(active.share.tokenHash);
    if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
      throw notFound("Ссылка недействительна или отозвана");
    }

    if (active.share.passwordHash) {
      const password = body.data.password ?? "";
      if (!password) throw new CloudError(401, "PASSWORD_REQUIRED", "Ссылка защищена паролем");
      const ok = await bcrypt.compare(password, active.share.passwordHash);
      if (!ok) throw new CloudError(401, "PASSWORD_REQUIRED", "Неверный пароль");
    }

    const session = await createShareSession(active.share.id, publicId);
    res.cookie(cookieName(publicId), session.id, cloudCookieOptions(session.ttlMs));
    await prisma.cloudShareLink.update({ where: { id: active.share.id }, data: { viewCount: { increment: 1 } } });
    await writeAudit(req, "SHARE_OPENED", { spaceId: active.space.id, targetId: active.share.id });

    res.json(publicShareInfo(active));
  })
);

/** Есть ли пароль — единственное, что можно узнать до предъявления секрета. */
router.get(
  "/:publicId/meta",
  rateLimit({ name: "cloud-share-meta", windowMs: 60_000, max: 120 }),
  ah(async (req: Request, res: Response) => {
    const active = await loadActiveShare(String(req.params.publicId ?? ""));
    if (!active) throw notFound("Ссылка недействительна или отозвана");
    res.json({ requiresPassword: Boolean(active.share.passwordHash) });
  })
);

async function requireShareSession(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const publicId = String(req.params.publicId ?? "");
    const cookie = (req.cookies as Record<string, unknown> | undefined)?.[cookieName(publicId)];
    if (typeof cookie !== "string") throw new CloudError(401, "SHARE_SESSION_REQUIRED", "Нужно открыть ссылку заново");
    const session = await readShareSession(cookie);
    if (!session || session.publicId !== publicId) {
      throw new CloudError(401, "SHARE_SESSION_REQUIRED", "Сессия просмотра истекла");
    }
    // Проверяем ссылку заново на каждом запросе: revoke обязан срабатывать сразу.
    const active = await loadActiveShare(publicId);
    if (!active || active.share.id !== session.shareId) throw notFound("Ссылка отозвана");
    req.shareLink = active;
    next();
  } catch (err) {
    next(err);
  }
}

function publicShareInfo(active: NonNullable<Awaited<ReturnType<typeof loadActiveShare>>>) {
  return {
    share: {
      publicId: active.share.publicId,
      targetType: active.share.targetType,
      allowPreview: active.share.allowPreview,
      allowDownload: active.share.allowDownload,
      expiresAt: active.share.expiresAt,
      label: active.share.label,
    },
    space: {
      id: active.space.id,
      name: active.space.name,
      description: active.space.description,
      dateFrom: active.space.dateFrom,
      dateTo: active.space.dateTo,
    },
  };
}

router.get(
  "/:publicId",
  requireShareSession,
  ah(async (req: Request, res: Response) => {
    const active = req.shareLink!;
    const where = await shareFileWhere(active.share);
    const agg = await prisma.cloudFile.groupBy({ by: ["kind"], where, _count: { _all: true }, _sum: { size: true } });
    let photos = 0;
    let videos = 0;
    let files = 0;
    let bytes = 0;
    for (const r of agg) {
      files += r._count._all;
      bytes += Number(r._sum.size ?? 0n);
      if (r.kind === "IMAGE") photos += r._count._all;
      if (r.kind === "VIDEO") videos += r._count._all;
    }
    res.json({ ...publicShareInfo(active), stats: { photos, videos, files, bytes } });
  })
);

router.get(
  "/:publicId/files",
  requireShareSession,
  ah(async (req: Request, res: Response) => {
    const active = req.shareLink!;
    if (!active.share.allowPreview && !active.share.allowDownload) throw forbidden("Просмотр запрещён");
    const limit = Math.min(Number(req.query.limit ?? 60) || 60, 200);
    const cursorRaw = typeof req.query.cursor === "string" ? req.query.cursor : undefined;

    const where = await shareFileWhere(active.share);
    let cursorFilter = {};
    if (cursorRaw) {
      try {
        const parsed = JSON.parse(Buffer.from(cursorRaw, "base64url").toString("utf8")) as { k: string; id: string };
        const at = new Date(parsed.k);
        cursorFilter = { OR: [{ takenAt: { lt: at } }, { takenAt: at, id: { lt: parsed.id } }] };
      } catch {
        // битый курсор — начинаем сначала
      }
    }

    const rows = await prisma.cloudFile.findMany({
      where: { ...where, ...cursorFilter },
      orderBy: [{ takenAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      include: { variants: true, uploader: { select: { id: true, username: true, displayName: true, avatarUrl: true } } },
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last
        ? Buffer.from(JSON.stringify({ k: last.takenAt.toISOString(), id: last.id })).toString("base64url")
        : null;

    const base = `/api/cloud/public/${active.share.publicId}/files`;
    res.json({
      files: page.map((f) => {
        const dto = fileDto(f, { urlBase: base });
        // Публичному зрителю не показываем ни автора, ни служебные счётчики.
        return {
          ...dto,
          uploader: null,
          commentCount: 0,
          reactions: {},
          myReactions: [],
          urls: {
            ...dto.urls,
            download: active.share.allowDownload ? `${base}/${f.id}/content?download=1` : null,
            content: active.share.allowDownload || f.kind === "VIDEO" ? dto.urls.content : null,
          },
        };
      }),
      nextCursor,
    });
  })
);

/** Проверка, что файл действительно входит в область действия этой ссылки. */
async function shareFile(req: Request) {
  const active = req.shareLink!;
  const fileId = String(req.params.fileId ?? "");
  const where = await shareFileWhere(active.share);
  const file = await prisma.cloudFile.findFirst({ where: { ...where, id: fileId } });
  if (!file) throw notFound("Файл не найден");
  return { active, file };
}

for (const [route, kind] of [
  ["thumb", "THUMB"],
  ["preview", "PREVIEW"],
  ["poster", "POSTER"],
  ["playback", "PLAYBACK"],
] as const) {
  router.get(
    `/:publicId/files/:fileId/${route}`,
    requireShareSession,
    ah(async (req: Request, res: Response) => {
      const { active, file } = await shareFile(req);
      if (!active.share.allowPreview) throw forbidden("Просмотр запрещён");
      await sendVariant(req, res, file.id, file.originalName, kind);
    })
  );
}

router.get(
  "/:publicId/files/:fileId/content",
  requireShareSession,
  ah(async (req: Request, res: Response) => {
    const { active, file } = await shareFile(req);
    const isDownload = req.query.download === "1";
    // Оригинал отдаём, только если разрешено скачивание; исключение — прямое
    // воспроизведение видео, для которого другого источника нет.
    if (isDownload && !active.share.allowDownload) throw forbidden("Скачивание запрещено");
    if (!isDownload && !active.share.allowPreview && !active.share.allowDownload) throw forbidden("Просмотр запрещён");
    if (!isDownload && !active.share.allowDownload && file.kind !== "VIDEO") throw forbidden("Скачивание запрещено");

    const object = await prisma.cloudStorageObject.findUnique({ where: { id: file.storageObjectId } });
    if (!object) throw notFound("Содержимое недоступно");
    if (isDownload) {
      await prisma.cloudShareLink.update({ where: { id: active.share.id }, data: { downloadCount: { increment: 1 } } });
    }
    await serveFile(req, res, objectAbsPath(object.storagePath), {
      mime: file.mimeType,
      filename: file.originalName,
      download: isDownload,
      cacheSeconds: 3600,
    });
  })
);

router.get(
  "/:publicId/zip",
  requireShareSession,
  ah(async (req: Request, res: Response) => {
    const active = req.shareLink!;
    if (!active.share.allowDownload) throw forbidden("Скачивание запрещено");
    const where = await shareFileWhere(active.share);
    const rows = await prisma.cloudFile.findMany({ where, select: { id: true }, take: 5000 });
    if (rows.length === 0) throw notFound("Нечего скачивать");
    await prisma.cloudShareLink.update({ where: { id: active.share.id }, data: { downloadCount: { increment: 1 } } });
    const entries = await buildZipEntries(rows.map((r) => r.id), { withFolders: active.share.targetType !== "SELECTION" });
    await streamZip(res, entries, `${active.space.name}.zip`);
  })
);

/** Список id для «Сохранить к себе»: нужен авторизованному пользователю Cloud. */
router.get(
  "/:publicId/fileIds",
  requireShareSession,
  ah(async (req: Request, res: Response) => {
    const active = req.shareLink!;
    const where = await shareFileWhere(active.share);
    const rows = await prisma.cloudFile.findMany({ where, select: { id: true }, take: 2000 });
    res.json({ shareId: active.share.id, fileIds: rows.map((r) => r.id) });
  })
);

export default router;
