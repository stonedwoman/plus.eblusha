import path from "node:path";
import { Router } from "express";
import type { Request, Response } from "express";
import { z } from "zod";
import type { Archiver, ArchiverOptions } from "archiver";

// @types/archiver@8 описывает только классы, без callable-экспорта, тогда как
// сам пакет — CommonJS-фабрика archiver(format, options). Оборачиваем require
// один раз, чтобы дальше работать с нормально типизированным Archiver.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const createArchive = require("archiver") as (format: string, options?: ArchiverOptions) => Archiver;
import crypto from "node:crypto";
import { Prisma } from "@prisma/client";
import prisma from "../../lib/prisma";
import { getRedisClient } from "../../lib/redis";
import logger from "../../config/logger";
import { ah, forbidden, invalid, notFound } from "../errors";
import { listAccessibleSpaceIds, requireFileAccess, requireSpaceAccess } from "../acl";
import { listFileIds, listFiles, loadFileWithSocial, socialFor } from "../queries";
import { DERIVED_DIR, objectAbsPath, safeJoin } from "../paths";
import { serveFile } from "../serve";
import { recordActivity } from "../activity";
import { writeAudit } from "../audit";
import { emitCloud, spaceRoom } from "../realtime";
import { enqueueImageJob, enqueueMaintenance, enqueueVideoJob } from "../jobs/queues";
import { assertCanAccept } from "../storage/quota";
import { fileDto } from "../serialize";

const router = Router();

const listQuery = z.object({
  spaceId: z.string().min(1),
  view: z.enum(["timeline", "files", "map", "places", "trash", "recent"]).default("timeline"),
  folderId: z.string().optional(),
  kind: z.enum(["IMAGE", "VIDEO", "AUDIO", "DOCUMENT", "OTHER"]).optional(),
  q: z.string().max(120).optional(),
  uploaderId: z.string().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().min(1).max(200).default(60),
});

router.get(
  "/",
  ah(async (req: Request, res) => {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) throw invalid("Некорректные параметры выборки");
    const p = parsed.data;
    await requireSpaceAccess(req, p.spaceId, "space:view");

    const folderId = p.view === "files" ? (p.folderId === undefined || p.folderId === "root" ? null : p.folderId) : undefined;
    const result = await listFiles({
      spaceId: p.spaceId,
      viewerId: req.cloudUser!.id,
      view: p.view,
      ...(folderId !== undefined ? { folderId } : {}),
      ...(p.kind ? { kind: p.kind } : {}),
      ...(p.q ? { q: p.q } : {}),
      ...(p.uploaderId ? { uploaderId: p.uploaderId } : {}),
      ...(p.from ? { from: p.from } : {}),
      ...(p.to ? { to: p.to } : {}),
      ...(p.cursor ? { cursor: p.cursor } : {}),
      limit: p.limit,
    });
    res.json(result);
  })
);

/**
 * Идентификаторы всего текущего среза — для «Выбрать все».
 *
 * Раньше кнопка выбирала только подгруженную страницу, но называлась «Выбрать
 * все»: человек нажимал её на 3000 файлов, получал 80 и удалял «всё» — не всё.
 */
router.get(
  "/ids",
  ah(async (req: Request, res) => {
    const parsed = listQuery.omit({ cursor: true, limit: true }).safeParse(req.query);
    if (!parsed.success) throw invalid("Некорректные параметры выборки");
    const p = parsed.data;
    await requireSpaceAccess(req, p.spaceId, "space:view");

    const folderId = p.view === "files" ? (p.folderId === undefined || p.folderId === "root" ? null : p.folderId) : undefined;
    const ids = await listFileIds({
      spaceId: p.spaceId,
      viewerId: req.cloudUser!.id,
      view: p.view,
      ...(folderId !== undefined ? { folderId } : {}),
      ...(p.kind ? { kind: p.kind } : {}),
      ...(p.q ? { q: p.q } : {}),
      ...(p.uploaderId ? { uploaderId: p.uploaderId } : {}),
      ...(p.from ? { from: p.from } : {}),
      ...(p.to ? { to: p.to } : {}),
    });
    res.json({ ids, truncated: ids.length >= 20000 });
  })
);

const timelineQuery = z.object({
  spaceId: z.string().min(1),
  view: z.literal("timeline").default("timeline"),
  kind: z.enum(["IMAGE", "VIDEO", "AUDIO", "DOCUMENT", "OTHER"]).optional(),
  q: z.string().max(120).optional(),
  /** Смещение локального времени клиента в минутах к востоку от UTC. */
  tz: z.coerce.number().int().min(-840).max(840).default(0),
});

/** % и _ в ILIKE — метасимволы; имя файла ими быть управляемым не должно. */
function escapeLike(v: string): string {
  return v.replace(/[\\%_]/g, "\\$&");
}

/**
 * Счётчики по дням съёмки — данные для вертикальной рельсы таймлайна.
 *
 * Один агрегат по всему срезу вместо перелистывания страниц: рельса должна
 * видеть ВСЮ поездку сразу, даже когда в браузер загружена первая сотня файлов.
 * Группируем по локальному дню клиента (tz), тем же календарём, каким галерея
 * собирает группы, — иначе вечерние кадры съезжали бы на соседний день и клик
 * по рельсе промахивался.
 */
router.get(
  "/timeline",
  ah(async (req: Request, res) => {
    const parsed = timelineQuery.safeParse(req.query);
    if (!parsed.success) throw invalid("Некорректные параметры выборки");
    const p = parsed.data;
    await requireSpaceAccess(req, p.spaceId, "space:view");

    const conds: Prisma.Sql[] = [
      Prisma.sql`f."spaceId" = ${p.spaceId}`,
      Prisma.sql`f."deletedAt" IS NULL`,
      Prisma.sql`f."purgedAt" IS NULL`,
    ];
    if (p.kind) conds.push(Prisma.sql`f."kind"::text = ${p.kind}`);
    if (p.q?.trim()) conds.push(Prisma.sql`f."originalName" ILIKE ${"%" + escapeLike(p.q.trim()) + "%"}`);

    // Помимо счётчика — представитель дня: его миниатюра становится узлом на
    // рельсе. Предпочитаем файл с готовым THUMB, чтобы узел не был битым.
    const rows = await prisma.$queryRaw<{ day: string; count: number; fileId: string | null }[]>(Prisma.sql`
      SELECT to_char(date_trunc('day', f."takenAt" + make_interval(mins => ${p.tz}::int)), 'YYYY-MM-DD') AS day,
             count(*)::int AS count,
             (array_agg(f."id" ORDER BY
                EXISTS(SELECT 1 FROM "CloudFileVariant" v
                       WHERE v."fileId" = f."id" AND v."kind"::text = 'THUMB' AND v."status"::text = 'READY') DESC,
                f."takenAt" ASC))[1] AS "fileId"
      FROM "CloudFile" f
      WHERE ${Prisma.join(conds, " AND ")}
      GROUP BY 1
      ORDER BY 1
    `);
    res.json({ days: rows });
  })
);

/**
 * Иерархия мест съёмки для рельсы «Места»: страна → город → район, со
 * счётчиками и представительским снимком на каждый узел.
 *
 * Один агрегат по всему срезу, а не по загруженной странице: рельса обязана
 * показывать всю поездку, даже когда в браузере первая сотня файлов.
 */
router.get(
  "/places",
  ah(async (req: Request, res) => {
    const parsed = z
      .object({
        spaceId: z.string().min(1),
        view: z.literal("places").default("places"),
        kind: z.enum(["IMAGE", "VIDEO", "AUDIO", "DOCUMENT", "OTHER"]).optional(),
      })
      .safeParse(req.query);
    if (!parsed.success) throw invalid("Некорректные параметры выборки");
    const p = parsed.data;
    await requireSpaceAccess(req, p.spaceId, "space:view");

    const conds: Prisma.Sql[] = [
      Prisma.sql`f."spaceId" = ${p.spaceId}`,
      Prisma.sql`f."deletedAt" IS NULL`,
      Prisma.sql`f."purgedAt" IS NULL`,
    ];
    if (p.kind) conds.push(Prisma.sql`f."kind"::text = ${p.kind}`);

    /*
     * Отрезки поездки в порядке ХРОНОЛОГИИ, а не по алфавиту: правая рельса
     * идёт рядом с той же лентой, что и левая, поэтому её станции — это
     * подряд идущие снимки одного места. Вернулись в Тбилиси через неделю —
     * это второй отрезок, а не тот же самый.
     *
     * Приём с двумя нумерациями (общая минус нумерация внутри места) —
     * стандартный способ выделить серии подряд идущих одинаковых значений.
     */
    const rows = await prisma.$queryRaw<
      { path: string; country: string; city: string | null; district: string | null; count: number; fileId: string | null }[]
    >(Prisma.sql`
      WITH ordered AS (
        SELECT f."id", f."geoCountry", f."geoCity", f."geoDistrict", f."takenAt",
               f."geoCountry" || '|' || coalesce(f."geoCity", '') AS ckey,
               row_number() OVER (ORDER BY f."takenAt", f."id") AS rn,
               row_number() OVER (
                 PARTITION BY f."geoCountry" || '|' || coalesce(f."geoCity", '')
                 ORDER BY f."takenAt", f."id"
               ) AS rp
        FROM "CloudFile" f
        WHERE ${Prisma.join(conds, " AND ")} AND f."geoPath" IS NOT NULL
      )
      SELECT ckey AS path,
             min("geoCountry") AS country,
             min("geoCity") AS city,
             -- Район подписываем, только если он один на весь отрезок: иначе
             -- станция врала бы, называя пригородом весь заезд в город.
             CASE WHEN count(DISTINCT coalesce("geoDistrict", '')) = 1
                  THEN min("geoDistrict") ELSE NULL END AS district,
             count(*)::int AS count,
             (array_agg("id" ORDER BY "takenAt" ASC))[1] AS "fileId"
      FROM ordered
      GROUP BY ckey, rn - rp
      ORDER BY min(rn)
    `);

    // Сколько снимков осталось без места — честно показываем, а не прячем.
    const withoutPlace = await prisma.cloudFile.count({
      where: { spaceId: p.spaceId, deletedAt: null, purgedAt: null, geoPath: null, ...(p.kind ? { kind: p.kind } : {}) },
    });

    res.json({ places: rows, withoutPlace });
  })
);

/** Точки для карты: только координаты, без тяжёлых полей. */
router.get(
  "/map",
  ah(async (req: Request, res) => {
    const spaceId = String(req.query.spaceId ?? "");
    if (!spaceId) throw invalid("Не указана хуяпка");
    await requireSpaceAccess(req, spaceId, "space:view");
    const points = await prisma.cloudFile.findMany({
      where: { spaceId, deletedAt: null, purgedAt: null, latitude: { not: null }, longitude: { not: null } },
      select: {
        id: true,
        latitude: true,
        longitude: true,
        takenAt: true,
        kind: true,
        originalName: true,
        // Готовность миниатюры проверяем ЗДЕСЬ. Иначе карта получала ссылку на
        // ещё не построенное превью, /thumb отвечал 404, картинка не рисовалась
        // — и маркер становился невидимым. Со стороны это выглядело как пустая
        // карта, хотя точки были.
        variants: { where: { kind: "THUMB", status: "READY" }, select: { id: true }, take: 1 },
      },
      orderBy: { takenAt: "asc" },
      take: 5000,
    });
    res.json({
      points: points.map((p) => ({
        id: p.id,
        lat: p.latitude,
        lon: p.longitude,
        takenAt: p.takenAt,
        kind: p.kind,
        name: p.originalName,
        thumb: p.variants.length > 0 ? `/api/cloud/files/${p.id}/thumb` : null,
      })),
    });
  })
);


/**
 * Сквозная лента по всем доступным Space: «Недавние», «Избранное», «Корзина».
 * Список доступных Space считается на сервере — клиент не может подсунуть чужой.
 */
router.get(
  "/feed",
  ah(async (req: Request, res) => {
    const user = req.cloudUser!;
    const view = String(req.query.view ?? "recent");
    if (!["recent", "trash"].includes(view)) throw invalid("Неизвестный режим");
    const limit = Math.min(Number(req.query.limit ?? 60) || 60, 200);
    const spaceIds = await listAccessibleSpaceIds(user.id);
    if (spaceIds.length === 0) {
      res.json({ files: [], nextCursor: null });
      return;
    }

    let cursorFilter = {};
    if (typeof req.query.cursor === "string" && req.query.cursor) {
      try {
        const parsed = JSON.parse(Buffer.from(req.query.cursor, "base64url").toString("utf8")) as { k: string; id: string };
        const at = new Date(parsed.k);
        cursorFilter = { OR: [{ createdAt: { lt: at } }, { createdAt: at, id: { lt: parsed.id } }] };
      } catch {
        // битый курсор — начинаем сначала
      }
    }

    const rows = await prisma.cloudFile.findMany({
      where: {
        spaceId: { in: spaceIds },
        deletedAt: view === "trash" ? { not: null } : null,
        purgedAt: null,
        ...cursorFilter,
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      include: { variants: true, uploader: { select: { id: true, username: true, displayName: true, avatarUrl: true } } },
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last
        ? Buffer.from(JSON.stringify({ k: last.createdAt.toISOString(), id: last.id })).toString("base64url")
        : null;

    const social = await socialFor(page.map((f) => f.id), user.id);
    const spaces = await prisma.cloudSpace.findMany({ where: { id: { in: spaceIds } }, select: { id: true, name: true } });
    const spaceNames = Object.fromEntries(spaces.map((s) => [s.id, s.name]));

    res.json({
      files: page.map((f) => ({
        ...fileDto(f, {
          commentCount: social.comments.get(f.id) ?? 0,
          reactions: social.reactions.get(f.id) ?? {},
          myReactions: social.mine.get(f.id) ?? [],
        }),
        spaceName: spaceNames[f.spaceId] ?? null,
      })),
      nextCursor,
    });
  })
);

const zipSchema = z.object({
  spaceId: z.string().min(1),
  ids: z.array(z.string().min(1)).max(2000).optional(),
  folderId: z.string().min(1).optional(),
  all: z.boolean().optional(),
});

/** Столько живёт талон на архив: ровно чтобы браузер успел начать скачивание. */
const ZIP_TICKET_TTL_SEC = 300;

/**
 * Талон на архив по выделению.
 *
 * Скачивание идёт навигацией (нужен Content-Disposition), а значит GET'ом — но
 * список из тысяч id в query упирается в лимит строки запроса у nginx, и
 * «Скачать ZIP» на большом выделении молча ломался. Поэтому список кладём в
 * Redis и отдаём короткий одноразовый талон.
 */
router.post(
  "/zip/prepare",
  ah(async (req: Request, res) => {
    const parsed = z
      .object({ spaceId: z.string().min(1), ids: z.array(z.string().min(1)).min(1).max(5000) })
      .safeParse(req.body);
    if (!parsed.success) throw invalid("Некорректный запрос");
    const access = await requireSpaceAccess(req, parsed.data.spaceId, "file:download");

    // Проверяем принадлежность СЕЙЧАС, а не при скачивании: талон не должен
    // становиться способом дотянуться до файлов, уехавших в другую хуяпку.
    const rows = await prisma.cloudFile.findMany({
      where: { id: { in: parsed.data.ids }, spaceId: access.space.id, deletedAt: null },
      select: { id: true },
    });
    if (rows.length === 0) throw notFound("Нечего скачивать");

    const token = crypto.randomBytes(24).toString("base64url");
    const redis = await getRedisClient();
    await redis.set(
      `cloud:zip:${token}`,
      JSON.stringify({ spaceId: access.space.id, userId: req.cloudUser!.id, ids: rows.map((r) => r.id) }),
      { EX: ZIP_TICKET_TTL_SEC }
    );
    res.json({ token, count: rows.length, expiresIn: ZIP_TICKET_TTL_SEC });
  })
);

router.get(
  "/zip",
  ah(async (req: Request, res) => {
    const ticket = typeof req.query.token === "string" ? req.query.token : null;
    if (ticket) {
      const redis = await getRedisClient();
      const raw = await redis.get(`cloud:zip:${ticket}`);
      if (!raw) throw notFound("Ссылка на архив устарела — соберите заново");
      const payload = JSON.parse(raw) as { spaceId: string; userId: string; ids: string[] };
      // Талон именной: чужая сессия не должна им воспользоваться, даже если
      // ссылка утекла из истории браузера.
      if (payload.userId !== req.cloudUser!.id) throw notFound("Ссылка на архив устарела — соберите заново");
      const access = await requireSpaceAccess(req, payload.spaceId, "file:download");
      const entries = await buildZipEntries(payload.ids, { withFolders: true });
      await streamZip(res, entries, `${access.space.name}.zip`);
      return;
    }

    const parsed = zipSchema.safeParse({
      spaceId: req.query.spaceId,
      ids: typeof req.query.ids === "string" ? String(req.query.ids).split(",").filter(Boolean) : undefined,
      folderId: req.query.folderId ? String(req.query.folderId) : undefined,
      all: req.query.all === "1",
    });
    if (!parsed.success) throw invalid("Некорректный запрос");
    const access = await requireSpaceAccess(req, parsed.data.spaceId, "file:download");

    let ids = parsed.data.ids ?? [];
    if (parsed.data.folderId || parsed.data.all) {
      const rows = await prisma.cloudFile.findMany({
        where: {
          spaceId: access.space.id,
          deletedAt: null,
          ...(parsed.data.folderId ? { folderId: parsed.data.folderId } : {}),
        },
        select: { id: true },
        take: 5000,
      });
      ids = rows.map((r) => r.id);
    } else {
      // Отсекаем всё, что не принадлежит этому Space, до сборки архива.
      const rows = await prisma.cloudFile.findMany({
        where: { id: { in: ids }, spaceId: access.space.id, deletedAt: null },
        select: { id: true },
      });
      ids = rows.map((r) => r.id);
    }
    if (ids.length === 0) throw notFound("Нечего скачивать");

    const entries = await buildZipEntries(ids, { withFolders: true });
    await streamZip(res, entries, `${access.space.name}.zip`);
  })
);

router.get(
  "/:id",
  ah(async (req: Request, res) => {
    const { file } = await requireFileAccess(req, String(req.params.id), "space:view", { includeDeleted: true });
    const dto = await loadFileWithSocial(file.id, req.cloudUser!.id);
    res.json({ file: dto });
  })
);

const patchSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  folderId: z.string().min(1).nullable().optional(),
});

router.patch(
  "/:id",
  ah(async (req: Request, res) => {
    const { file } = await requireFileAccess(req, String(req.params.id), "file:update");
    const parsed = patchSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw invalid("Некорректные поля");
    if (parsed.data.folderId) {
      const folder = await prisma.cloudFolder.findFirst({
        where: { id: parsed.data.folderId, spaceId: file.spaceId, deletedAt: null },
      });
      if (!folder) throw notFound("Папка не найдена");
    }
    const name = parsed.data.name ? sanitizeDisplayName(parsed.data.name) : undefined;
    const updated = await prisma.cloudFile.update({
      where: { id: file.id },
      data: {
        ...(name ? { originalName: name } : {}),
        ...(parsed.data.folderId !== undefined ? { folderId: parsed.data.folderId } : {}),
      },
      include: { variants: true, uploader: { select: { id: true, username: true, displayName: true, avatarUrl: true } } },
    });
    await emitCloud("cloud.file.updated", [spaceRoom(file.spaceId)], { spaceId: file.spaceId, file: fileDto(updated) });
    res.json({ file: fileDto(updated) });
  })
);

const rotateSchema = z.object({ dir: z.enum(["cw", "ccw"]).default("cw") });

/*
 * Поворот кадра. Оригинал неприкосновенен: хранилище контент-адресуемое, и
 * перезапись байтов сломала бы дедупликацию. Угол живёт на файле; превью фото
 * перезапекаются повёрнутыми воркером, видео доворачивает плеер на клиенте —
 * перекодировать ролик ради поворота на четырёх ядрах безумие. Пока превью не
 * перепечено, клиент видит расхождение rotation/bakedRotation и доворачивает
 * картинку CSS-ом сам.
 */
router.post(
  "/:id/rotate",
  ah(async (req: Request, res) => {
    const { file } = await requireFileAccess(req, String(req.params.id), "file:update");
    const parsed = rotateSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw invalid("Некорректное направление");
    if (file.kind !== "IMAGE" && file.kind !== "VIDEO") throw invalid("Поворачивать можно только фото и видео");
    const step = parsed.data.dir === "cw" ? 90 : 270;
    /*
     * Атомарный инкремент вместо read-modify-write: два быстрых щелчка иначе
     * читали бы один и тот же угол и один из них молча пропадал. Postgres
     * вычисляет правую часть по СТАРЫМ значениям строки, поэтому свап
     * width/height в том же UPDATE легален.
     */
    await prisma.$executeRaw`
      UPDATE "CloudFile"
      SET rotation = ((rotation + ${step}) % 360 + 360) % 360,
          width = height,
          height = width
      WHERE id = ${file.id}`;
    const freshRot = await prisma.cloudFile.findUnique({ where: { id: file.id }, select: { rotation: true } });
    const rotation = freshRot?.rotation ?? 0;
    // reason уникален: jobId строится из него, и второй щелчок с тем же id
    // молча отбрасывался бы, пока жив след предыдущей задачи.
    if (file.kind === "IMAGE") await enqueueImageJob(file.id, `rotate-${rotation}-${Date.now()}`);
    const dto = await loadFileWithSocial(file.id, req.cloudUser!.id);
    await emitCloud("cloud.file.updated", [spaceRoom(file.spaceId)], { spaceId: file.spaceId, file: dto });
    res.json({ file: dto });
  })
);

function sanitizeDisplayName(raw: string): string {
  let out = "";
  for (const ch of raw) {
    const code = ch.charCodeAt(0);
    if (code < 32 || code === 127) continue;
    out += ch === "/" || ch === "\\" ? "_" : ch;
  }
  out = out.trim();
  return (out === "." || out === ".." || out === "" ? "file" : out).slice(0, 255);
}

// ── Корзина ──────────────────────────────────────────────────────────────────

// 1000 за раз: клиент всё равно шлёт пачками, но при выделении «все» в крупной
// хуяпке лишний round-trip на каждые 500 штук ощутим.
const idsSchema = z.object({ ids: z.array(z.string().min(1)).min(1).max(1000) });

router.post(
  "/delete",
  ah(async (req: Request, res) => {
    const parsed = idsSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw invalid("Нужен список ids");
    const files = await prisma.cloudFile.findMany({ where: { id: { in: parsed.data.ids }, deletedAt: null } });
    const spaces = new Set(files.map((f) => f.spaceId));
    for (const spaceId of spaces) await requireSpaceAccess(req, spaceId, "file:delete");

    const now = new Date();
    await prisma.cloudFile.updateMany({
      where: { id: { in: files.map((f) => f.id) } },
      data: { deletedAt: now, deletedById: req.cloudUser!.id },
    });
    for (const spaceId of spaces) {
      const ids = files.filter((f) => f.spaceId === spaceId).map((f) => f.id);
      await recordActivity(spaceId, req.cloudUser!.id, "FILES_DELETED", { count: ids.length });
      await emitCloud("cloud.file.deleted", [spaceRoom(spaceId)], { spaceId, fileIds: ids });
    }
    await writeAudit(req, "FILE_DELETED", { detail: { count: files.length } });
    res.json({ ok: true, count: files.length });
  })
);

router.post(
  "/restore",
  ah(async (req: Request, res) => {
    const parsed = idsSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw invalid("Нужен список ids");
    const files = await prisma.cloudFile.findMany({
      where: { id: { in: parsed.data.ids }, deletedAt: { not: null }, purgedAt: null },
    });
    const spaces = new Set(files.map((f) => f.spaceId));
    for (const spaceId of spaces) await requireSpaceAccess(req, spaceId, "file:restore");

    await prisma.cloudFile.updateMany({
      where: { id: { in: files.map((f) => f.id) } },
      data: { deletedAt: null, deletedById: null },
    });
    for (const spaceId of spaces) {
      const ids = files.filter((f) => f.spaceId === spaceId).map((f) => f.id);
      await recordActivity(spaceId, req.cloudUser!.id, "FILES_RESTORED", { count: ids.length });
      await emitCloud("cloud.file.restored", [spaceRoom(spaceId)], { spaceId, fileIds: ids });
    }
    await writeAudit(req, "FILE_RESTORED", { detail: { count: files.length } });
    res.json({ ok: true, count: files.length });
  })
);

/**
 * Необратимое удаление. Физический blob здесь НЕ трогаем — им занимается
 * maintenance после проверки refCount: на объект может ссылаться чужой Space.
 */
router.post(
  "/purge",
  ah(async (req: Request, res) => {
    const schema = z.object({ ids: z.array(z.string()).max(500).optional(), spaceId: z.string().optional(), all: z.boolean().optional() });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) throw invalid("Некорректный запрос");

    let files;
    if (parsed.data.all && parsed.data.spaceId) {
      await requireSpaceAccess(req, parsed.data.spaceId, "file:delete");
      files = await prisma.cloudFile.findMany({
        where: { spaceId: parsed.data.spaceId, deletedAt: { not: null }, purgedAt: null },
        take: 2000,
      });
    } else if (parsed.data.ids?.length) {
      files = await prisma.cloudFile.findMany({ where: { id: { in: parsed.data.ids }, deletedAt: { not: null }, purgedAt: null } });
      for (const spaceId of new Set(files.map((f) => f.spaceId))) {
        await requireSpaceAccess(req, spaceId, "file:delete");
      }
    } else {
      throw invalid("Нужны ids или spaceId+all");
    }

    // purgedAt, а не «deletedAt в 1970»: помеченный так файл исчезает и из
    // корзины, и из выборок, и восстановить его уже нельзя — именно этого
    // человек ждёт от кнопки «Удалить навсегда».
    const now = new Date();
    await prisma.cloudFile.updateMany({
      where: { id: { in: files.map((f) => f.id) } },
      data: { purgedAt: now, deletedAt: now },
    });
    // Уборку просим сразу, а не ждём шестичасового цикла.
    await enqueueMaintenance("trash-purge");
    await writeAudit(req, "FILE_PURGED", { detail: { count: files.length } });
    res.json({ ok: true, count: files.length });
  })
);

/**
 * «Сохранить к себе»: новая логическая ссылка на ТОТ ЖЕ физический объект.
 * Никакого server → браузер → server: байты не двигаются вообще.
 */
router.post(
  "/save",
  ah(async (req: Request, res) => {
    const schema = z.object({
      fileIds: z.array(z.string().min(1)).min(1).max(500),
      targetSpaceId: z.string().min(1),
      targetFolderId: z.string().min(1).nullable().optional(),
      /** id публичной ссылки, если файлы пришли из share (доступ проверяется по ней) */
      shareId: z.string().optional(),
    });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) throw invalid("Некорректный запрос");
    const user = req.cloudUser!;
    const target = await requireSpaceAccess(req, parsed.data.targetSpaceId, "file:upload");

    const sources = await prisma.cloudFile.findMany({
      where: { id: { in: parsed.data.fileIds }, deletedAt: null },
      include: { storageObject: true },
    });
    if (sources.length === 0) throw notFound("Файлы не найдены");

    // Каждый исходник проверяется отдельно: либо у пользователя есть доступ к
    // Space-источнику, либо файл входит в валидную публичную ссылку.
    const allowed: typeof sources = [];
    const shareFileIds = parsed.data.shareId ? await shareAllowedFileIds(parsed.data.shareId) : null;
    for (const src of sources) {
      if (shareFileIds?.has(src.id)) {
        allowed.push(src);
        continue;
      }
      const access = await requireSpaceAccess(req, src.spaceId, "file:download").catch(() => null);
      if (access) allowed.push(src);
    }
    if (allowed.length === 0) throw forbidden("Нет доступа к выбранным файлам");

    if (parsed.data.targetFolderId) {
      const folder = await prisma.cloudFolder.findFirst({
        where: { id: parsed.data.targetFolderId, spaceId: target.space.id, deletedAt: null },
      });
      if (!folder) throw notFound("Папка не найдена");
    }

    // Квоту всё равно проверяем: дедуп даёт скидку по диску, но не право лить бесконечно.
    const totalBytes = allowed.reduce((sum, f) => sum + Number(f.size), 0);
    await assertCanAccept(Math.min(totalBytes, 1));

    const created: string[] = [];
    for (const src of allowed) {
      const copy = await prisma.$transaction(async (tx) => {
        const file = await tx.cloudFile.create({
          data: {
            spaceId: target.space.id,
            folderId: parsed.data.targetFolderId ?? null,
            storageObjectId: src.storageObjectId,
            originalName: src.originalName,
            mimeType: src.mimeType,
            size: src.size,
            kind: src.kind,
            uploaderId: user.id,
            status: "PROCESSING",
            width: src.width,
            height: src.height,
            orientation: src.orientation,
            // Поворот — часть того, как человек видит кадр: копия без него
            // приезжала бы лежащей на боку без каких-либо следов почему.
            rotation: src.rotation,
            durationMs: src.durationMs,
            takenAt: src.takenAt,
            takenAtSource: src.takenAtSource,
            latitude: src.latitude,
            longitude: src.longitude,
            cameraMake: src.cameraMake,
            cameraModel: src.cameraModel,
            videoCodec: src.videoCodec,
            audioCodec: src.audioCodec,
            bitrate: src.bitrate,
            directPlayable: src.directPlayable,
            ...(src.metadata === null ? {} : { metadata: src.metadata as never }),
          },
        });
        await tx.cloudStorageObject.update({ where: { id: src.storageObjectId }, data: { refCount: { increment: 1 } } });
        return file;
      });
      created.push(copy.id);
      // Производные принадлежат конкретному CloudFile, поэтому для копии их
      // создаём заново — это дёшево по сравнению с копированием оригинала.
      if (copy.kind === "IMAGE") await enqueueImageJob(copy.id, "copy");
      else if (copy.kind === "VIDEO") await enqueueVideoJob(copy.id, "copy");
      else await prisma.cloudFile.update({ where: { id: copy.id }, data: { status: "READY" } });
    }

    await recordActivity(target.space.id, user.id, "FILES_SAVED", { count: created.length });
    await writeAudit(req, "FILE_SAVED", { spaceId: target.space.id, detail: { count: created.length } });
    res.status(201).json({ ok: true, count: created.length, fileIds: created });
  })
);

async function shareAllowedFileIds(shareId: string): Promise<Set<string>> {
  const share = await prisma.cloudShareLink.findUnique({ where: { id: shareId } });
  if (!share || share.revokedAt || (share.expiresAt && share.expiresAt < new Date())) return new Set();
  /*
   * Запрет на скачивание обязан распространяться и на «Сохранить к себе».
   * Иначе он не запрет, а видимость: получатель ссылки без allowDownload
   * копировал файлы в свою хуяпку одним запросом и качал их уже оттуда —
   * причём копия ссылается на ТОТ ЖЕ физический объект.
   */
  if (!share.allowDownload) return new Set();
  const { resolveShareFileScope } = await import("./shareScope");
  return resolveShareFileScope(share);
}

// ── Содержимое ───────────────────────────────────────────────────────────────

async function serveVariant(req: Request, res: Response, kind: "THUMB" | "PREVIEW" | "POSTER" | "PLAYBACK") {
  const { file } = await requireFileAccess(req, String(req.params.id), "file:download", { includeDeleted: true });
  await sendVariant(req, res, file.id, file.originalName, kind);
}

export async function sendVariant(
  req: Request,
  res: Response,
  fileId: string,
  originalName: string,
  kind: "THUMB" | "PREVIEW" | "POSTER" | "PLAYBACK"
) {
  const variant = await prisma.cloudFileVariant.findUnique({ where: { fileId_kind: { fileId, kind } } });
  if (!variant || variant.status !== "READY" || !variant.storagePath) throw notFound("Превью ещё не готово");
  const abs = safeJoin(DERIVED_DIR, variant.storagePath);
  await serveFile(req, res, abs, {
    mime: variant.mimeType ?? "application/octet-stream",
    filename: `${path.parse(originalName).name}.${kind.toLowerCase()}`,
    // Производные иммутабельны: имя файла на диске меняется вместе с содержимым.
    cacheSeconds: 60 * 60 * 24 * 30,
    immutable: true,
  });
}

router.get("/:id/thumb", ah(async (req, res) => serveVariant(req, res, "THUMB")));
router.get("/:id/preview", ah(async (req, res) => serveVariant(req, res, "PREVIEW")));
router.get("/:id/poster", ah(async (req, res) => serveVariant(req, res, "POSTER")));
router.get("/:id/playback", ah(async (req, res) => serveVariant(req, res, "PLAYBACK")));

router.get(
  "/:id/content",
  ah(async (req: Request, res) => {
    const { file } = await requireFileAccess(req, String(req.params.id), "file:download", { includeDeleted: true });
    const object = await prisma.cloudStorageObject.findUnique({ where: { id: file.storageObjectId } });
    if (!object) throw notFound("Содержимое недоступно");
    await serveFile(req, res, objectAbsPath(object.storagePath), {
      mime: file.mimeType,
      filename: file.originalName,
      download: req.query.download === "1",
      cacheSeconds: 60 * 60 * 24 * 7,
    });
  })
);

/** Перегенерация превью — если производные потеряли или джоба упала. */
router.post(
  "/:id/reprocess",
  ah(async (req: Request, res) => {
    const { file } = await requireFileAccess(req, String(req.params.id), "file:update");
    await prisma.cloudFile.update({ where: { id: file.id }, data: { status: "PROCESSING", processingError: null } });
    if (file.kind === "IMAGE") await enqueueImageJob(file.id, `manual-${Date.now()}`);
    else if (file.kind === "VIDEO") await enqueueVideoJob(file.id, `manual-${Date.now()}`);
    res.json({ ok: true });
  })
);

// ── ZIP ──────────────────────────────────────────────────────────────────────

/**
 * Потоковый ZIP: архив собирается на лету и сразу уходит клиенту.
 * Промежуточный 80-гигабайтный файл на диске не создаётся.
 */
export async function streamZip(
  res: Response,
  entries: { absolute: string; name: string }[],
  archiveName: string
): Promise<void> {
  res.setHeader("Content-Type", "application/zip");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${archiveName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(archiveName)}`
  );
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");

  // store: содержимое уже сжато (JPEG/H.264), deflate только жёг бы CPU впустую.
  const archive = createArchive("zip", { store: true });
  archive.on("warning", (err: unknown) => logger.warn({ err }, "cloud zip warning"));
  archive.on("error", (err: unknown) => {
    logger.error({ err }, "cloud zip failed");
    res.destroy();
  });
  res.on("close", () => archive.abort());
  archive.pipe(res);
  for (const entry of entries) archive.file(entry.absolute, { name: entry.name });
  await archive.finalize();
}

/** Уникализация имён внутри архива: photo.jpg, photo (2).jpg, ... */
export function uniqueName(taken: Set<string>, desired: string): string {
  let candidate = desired;
  const parsed = path.parse(desired);
  let n = 2;
  while (taken.has(candidate.toLowerCase())) {
    candidate = `${parsed.name} (${n})${parsed.ext}`;
    n++;
  }
  taken.add(candidate.toLowerCase());
  return candidate;
}

export async function buildZipEntries(fileIds: string[], opts: { withFolders: boolean }) {
  const files = await prisma.cloudFile.findMany({
    where: { id: { in: fileIds }, deletedAt: null },
    include: { storageObject: true },
    orderBy: { originalName: "asc" },
  });
  const folderPathCache = new Map<string, string>();
  const taken = new Set<string>();
  const entries: { absolute: string; name: string }[] = [];

  for (const file of files) {
    let prefix = "";
    if (opts.withFolders && file.folderId) {
      prefix = folderPathCache.get(file.folderId) ?? (await folderPath(file.folderId));
      folderPathCache.set(file.folderId, prefix);
    }
    const name = uniqueName(taken, prefix ? `${prefix}/${file.originalName}` : file.originalName);
    entries.push({ absolute: objectAbsPath(file.storageObject.storagePath), name });
  }
  return entries;
}

async function folderPath(folderId: string): Promise<string> {
  const parts: string[] = [];
  let cursor: string | null = folderId;
  for (let i = 0; i < 32 && cursor; i++) {
    const cur: { name: string; parentId: string | null } | null = await prisma.cloudFolder.findUnique({
      where: { id: cursor },
      select: { name: true, parentId: true },
    });
    if (!cur) break;
    parts.unshift(cur.name.replace(/[/\\]/g, "_"));
    cursor = cur.parentId;
  }
  return parts.join("/");
}

export default router;
