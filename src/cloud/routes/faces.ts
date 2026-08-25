/**
 * Лица и персоны. Персоны глобальны для инстанса (семейный круг один), лица
 * привязаны к файлам; доступ к лицам идёт через право видеть хуяпку файла.
 * Разметка ручная: пользователь называет лицо — рождается персона, дальше
 * матчер дотягивает похожие сам (порог косинуса, см. faceWorker).
 */
import { Router, type Request } from "express";
import { z } from "zod";
import prisma from "../../lib/prisma";
import { ah } from "../errors";
import { invalid, notFound } from "../errors";
import { requireSpaceAccess } from "../acl";
import { enqueueFacesJob } from "../jobs/queues";

const router = Router();

/** Косинус для Buffer-эмбеддингов (уже L2-нормированы воркером). */
function cos(a: Uint8Array, b: Uint8Array): number {
  const va = new Float32Array(a.buffer, a.byteOffset, a.byteLength / 4);
  const vb = new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
  let s = 0;
  for (let i = 0; i < va.length; i++) s += va[i]! * vb[i]!;
  return s;
}

type FaceRow = {
  id: string; fileId: string; x: number; y: number; w: number; h: number; score: number; personId: string | null;
  file?: { width: number | null; height: number | null } | null;
};
/** Размеры кадра нужны фронту: кроп кружка считается в пикселях, а не в
 * долях — доли по разным осям несравнимы на неквадратных превью. */
const faceDto = (f: FaceRow) => ({
  id: f.id,
  fileId: f.fileId,
  box: { x: f.x, y: f.y, w: f.w, h: f.h },
  score: f.score,
  personId: f.personId,
  fileW: f.file?.width ?? null,
  fileH: f.file?.height ?? null,
});

/** Персоны с количеством снимков в конкретной хуяпке (и всего). */
router.get(
  "/people",
  ah(async (req: Request, res) => {
    const spaceId = String(req.query.spaceId ?? "");
    if (!spaceId) throw invalid("Нужен spaceId");
    await requireSpaceAccess(req, spaceId, "space:view");

    const people = await prisma.cloudPerson.findMany({ orderBy: { createdAt: "asc" } });
    const rows = await prisma.cloudFace.groupBy({
      by: ["personId"],
      where: { personId: { not: null }, file: { spaceId, deletedAt: null } },
      _count: { _all: true },
    });
    const inSpace = new Map(rows.map((r) => [r.personId, r._count._all]));
    const covers = await prisma.cloudFace.findMany({
      where: { id: { in: people.map((p) => p.coverFaceId).filter(Boolean) as string[] } },
      include: { file: { select: { width: true, height: true } } },
    });
    const coverById = new Map(covers.map((c) => [c.id, c]));
    res.json({
      people: people.map((p) => {
        const cover = p.coverFaceId ? coverById.get(p.coverFaceId) : null;
        return {
          id: p.id,
          name: p.name,
          countInSpace: inSpace.get(p.id) ?? 0,
          cover: cover ? faceDto(cover) : null,
        };
      }),
    });
  })
);

/**
 * Неопознанные лица хуяпки, сгруппированные жадной кластеризацией по
 * эмбеддингам: один и тот же человек соберётся в одну пачку, и назвать его
 * можно целиком, а не по одному лицу.
 */
router.get(
  "/unnamed",
  ah(async (req: Request, res) => {
    const spaceId = String(req.query.spaceId ?? "");
    if (!spaceId) throw invalid("Нужен spaceId");
    await requireSpaceAccess(req, spaceId, "space:view");

    const faces = await prisma.cloudFace.findMany({
      where: { personId: null, file: { spaceId, deletedAt: null } },
      orderBy: { score: "desc" },
      take: 400,
      include: { file: { select: { width: true, height: true } } },
    });
    const CLUSTER = 0.45;
    const groups: { rep: (typeof faces)[number]; members: typeof faces }[] = [];
    for (const f of faces) {
      const g = groups.find((gr) => cos(gr.rep.embedding, f.embedding) >= CLUSTER);
      if (g) g.members.push(f);
      else groups.push({ rep: f, members: [f] });
    }
    groups.sort((a, b) => b.members.length - a.members.length);
    res.json({
      groups: groups.slice(0, 40).map((g) => ({
        faces: g.members.slice(0, 12).map(faceDto),
        // ВСЕ id кластера: «назвать» обязано привязать пачку целиком, а не
        // только показанную дюжину — иначе счётчик персоны врал в разы.
        faceIds: g.members.map((f) => f.id),
        total: g.members.length,
      })),
    });
  })
);

const nameSchema = z.object({ name: z.string().trim().min(1).max(80), faceIds: z.array(z.string()).min(1).max(500) });

/** Назвать лица: новая персона или довязка к существующей по имени. */
router.post(
  "/name",
  ah(async (req: Request, res) => {
    const parsed = nameSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw invalid("Нужны name и faceIds");
    const faces = await prisma.cloudFace.findMany({
      where: { id: { in: parsed.data.faceIds } },
      include: { file: { select: { spaceId: true } } },
    });
    if (faces.length === 0) throw notFound("Лица не найдены");
    // Право: загрузка в каждую затронутую хуяпку.
    for (const sid of new Set(faces.map((f) => f.file.spaceId))) {
      await requireSpaceAccess(req, sid, "file:upload");
    }
    let person = await prisma.cloudPerson.findFirst({ where: { name: { equals: parsed.data.name, mode: "insensitive" } } });
    if (!person) {
      person = await prisma.cloudPerson.create({
        data: { name: parsed.data.name, coverFaceId: faces[0]!.id },
      });
    }
    await prisma.cloudFace.updateMany({
      where: { id: { in: parsed.data.faceIds } },
      data: { personId: person.id, assignedBy: "user", matchScore: null },
    });
    if (!person.coverFaceId) {
      await prisma.cloudPerson.update({ where: { id: person.id }, data: { coverFaceId: faces[0]!.id } });
    }
    res.json({ personId: person.id, name: person.name, assigned: faces.length });
  })
);

const assignSchema = z.object({ personId: z.string().min(1).nullable(), faceIds: z.array(z.string()).min(1).max(500) });

/** Привязать/отвязать лица к персоне (personId: null — снять привязку). */
router.post(
  "/assign",
  ah(async (req: Request, res) => {
    const parsed = assignSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw invalid("Нужны personId и faceIds");
    const faces = await prisma.cloudFace.findMany({
      where: { id: { in: parsed.data.faceIds } },
      include: { file: { select: { spaceId: true } } },
    });
    if (faces.length === 0) throw notFound("Лица не найдены");
    for (const sid of new Set(faces.map((f) => f.file.spaceId))) {
      await requireSpaceAccess(req, sid, "file:upload");
    }
    if (parsed.data.personId) {
      const person = await prisma.cloudPerson.findUnique({ where: { id: parsed.data.personId } });
      if (!person) throw notFound("Персона не найдена");
    }
    await prisma.cloudFace.updateMany({
      where: { id: { in: parsed.data.faceIds } },
      data: parsed.data.personId
        ? { personId: parsed.data.personId, assignedBy: "user", matchScore: null }
        : { personId: null, assignedBy: null, matchScore: null },
    });
    res.json({ assigned: faces.length });
  })
);

/** Переименовать персону. */
router.patch(
  "/people/:id",
  ah(async (req: Request, res) => {
    const name = z.string().trim().min(1).max(80).safeParse((req.body ?? {}).name);
    if (!name.success) throw invalid("Нужно имя");
    // Глобальная операция: достаточно быть авторизованным участником Cloud —
    // инстанс семейный, злоумышленнику тут взяться неоткуда.
    const person = await prisma.cloudPerson.update({ where: { id: String(req.params.id) }, data: { name: name.data } });
    res.json({ person: { id: person.id, name: person.name } });
  })
);

/** Пересканировать хуяпку (после установки моделей или смены порога). */
router.post(
  "/rescan",
  ah(async (req: Request, res) => {
    const spaceId = String((req.body ?? {}).spaceId ?? "");
    if (!spaceId) throw invalid("Нужен spaceId");
    await requireSpaceAccess(req, spaceId, "file:upload");
    const files = await prisma.cloudFile.findMany({
      where: { spaceId, kind: "IMAGE", deletedAt: null, status: "READY" },
      select: { id: true },
    });
    for (const f of files) await enqueueFacesJob(f.id, `rescan-${Date.now()}`);
    res.json({ queued: files.length });
  })
);

export default router;
