import { Router } from "express";
import type { Request } from "express";
import fsp from "node:fs/promises";
import { z } from "zod";
import prisma from "../../lib/prisma";
import { ah, invalid, notFound } from "../errors";
import { requireCsrf } from "../auth/middleware";
import { requireSpaceAccess } from "../acl";
import { stagingPath } from "../paths";
import { emitCloud, userRoom } from "../realtime";
import tusRouter from "../upload/tus";

/**
 * REST-обвязка вокруг tus: список незавершённых загрузок и поиск «той же самой»
 * загрузки по отпечатку файла.
 *
 * Именно это делает докачку возможной на ДРУГОМ компьютере: сервер, очевидно,
 * не может сам достать локальный файл — но он помнит, сколько байт уже принял,
 * и по отпечатку узнаёт файл, который пользователь выбрал заново.
 */
const router = Router();

// tus смонтирован первым: его пути (/tus, /tus/:id) не должны попасть в /:id.
router.use("/", tusRouter);

const ACTIVE_STATUSES = ["CREATED", "UPLOADING", "PAUSED", "UPLOADED", "VERIFYING", "FAILED"] as const;

router.get(
  "/",
  ah(async (req: Request, res) => {
    const user = req.cloudUser!;
    const sessions = await prisma.cloudUploadSession.findMany({
      where: { userId: user.id, status: { in: [...ACTIVE_STATUSES] }, expiresAt: { gt: new Date() } },
      orderBy: { updatedAt: "desc" },
      take: 200,
    });
    const spaceIds = Array.from(new Set(sessions.map((s) => s.spaceId)));
    const spaces = await prisma.cloudSpace.findMany({
      where: { id: { in: spaceIds } },
      select: { id: true, name: true },
    });
    const spaceNames = new Map(spaces.map((s) => [s.id, s.name]));

    // Реальный offset берём с диска: БД могла отстать на последнем чанке.
    const enriched = await Promise.all(
      sessions.map(async (s) => {
        let onDisk = Number(s.bytesReceived);
        try {
          onDisk = (await fsp.stat(stagingPath(s.uploadProtocolId))).size;
        } catch {
          // файла может не быть — тогда доверяем счётчику
        }
        return {
          id: s.id,
          spaceId: s.spaceId,
          spaceName: spaceNames.get(s.spaceId) ?? null,
          folderId: s.folderId,
          name: s.originalName,
          expectedSize: Number(s.expectedSize),
          bytesReceived: onDisk,
          status: s.status,
          fingerprint: s.fingerprint,
          uploadUrl: `/api/cloud/uploads/tus/${s.uploadProtocolId}`,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
          expiresAt: s.expiresAt,
          error: s.error,
        };
      })
    );
    res.json({ uploads: enriched });
  })
);

const resolveSchema = z.object({
  spaceId: z.string().min(1),
  folderId: z.string().min(1).nullable().optional(),
  fingerprint: z.string().min(4).max(200),
  size: z.number().int().min(0),
});

/**
 * Есть ли уже начатая загрузка этого файла? Отпечаток считает клиент из
 * размера, mtime и хеша нескольких выборок — целиком 30 ГБ в браузере не хешируем.
 */
router.post(
  "/resolve",
  requireCsrf,
  ah(async (req: Request, res) => {
    const parsed = resolveSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw invalid("Некорректный запрос");
    const user = req.cloudUser!;
    await requireSpaceAccess(req, parsed.data.spaceId, "file:upload");

    const candidates = await prisma.cloudUploadSession.findMany({
      where: {
        userId: user.id,
        spaceId: parsed.data.spaceId,
        fingerprint: parsed.data.fingerprint,
        expectedSize: BigInt(parsed.data.size),
        status: { in: ["CREATED", "UPLOADING", "PAUSED", "FAILED"] },
        expiresAt: { gt: new Date() },
      },
      orderBy: { updatedAt: "desc" },
      take: 1,
    });
    const session = candidates[0];
    if (!session) {
      res.json({ upload: null });
      return;
    }
    let offset = Number(session.bytesReceived);
    try {
      offset = (await fsp.stat(stagingPath(session.uploadProtocolId))).size;
    } catch {
      offset = 0;
    }
    res.json({
      upload: {
        id: session.id,
        uploadUrl: `/api/cloud/uploads/tus/${session.uploadProtocolId}`,
        offset,
        expectedSize: Number(session.expectedSize),
        name: session.originalName,
        folderId: session.folderId,
      },
    });
  })
);

router.post(
  "/:id/pause",
  requireCsrf,
  ah(async (req: Request, res) => {
    const session = await ownSession(req);
    if (session.status === "UPLOADING" || session.status === "CREATED") {
      await prisma.cloudUploadSession.update({ where: { id: session.id }, data: { status: "PAUSED" } });
      await emitCloud("cloud.upload.updated", [userRoom(session.userId)], {
        id: session.id,
        spaceId: session.spaceId,
        status: "PAUSED",
        name: session.originalName,
        expectedSize: Number(session.expectedSize),
        bytesReceived: Number(session.bytesReceived),
      });
    }
    res.json({ ok: true });
  })
);

router.delete(
  "/:id",
  requireCsrf,
  ah(async (req: Request, res) => {
    const session = await ownSession(req);
    await fsp.rm(stagingPath(session.uploadProtocolId), { force: true }).catch(() => undefined);
    await prisma.cloudUploadSession.update({ where: { id: session.id }, data: { status: "CANCELLED" } });
    await emitCloud("cloud.upload.updated", [userRoom(session.userId)], {
      id: session.id,
      spaceId: session.spaceId,
      status: "CANCELLED",
      name: session.originalName,
      expectedSize: Number(session.expectedSize),
      bytesReceived: Number(session.bytesReceived),
    });
    res.json({ ok: true });
  })
);

async function ownSession(req: Request) {
  const session = await prisma.cloudUploadSession.findUnique({ where: { id: String(req.params.id) } });
  if (!session || session.userId !== req.cloudUser!.id) throw notFound("Загрузка не найдена");
  return session;
}

export default router;
