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
import { requireFileAccess, requireSpaceAccess } from "../acl";
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
const MATCH = Number(process.env.CLOUD_FACE_MATCH ?? 0.38);

/**
 * Мгновенное распространение привязки: пересчитать центроид персоны и
 * привязать ВСЕ похожие непривязанные лица по всей библиотеке. Несколько
 * раундов — свежепривязанные уточняют центроид и дотягивают пограничные.
 * Без этого имя жило только на одном снимке до ближайшего перескана.
 */
async function propagatePerson(personId: string): Promise<number> {
  let total = 0;
  for (let round = 0; round < 3; round++) {
    const anchors = await prisma.cloudFace.findMany({ where: { personId }, select: { embedding: true } });
    if (anchors.length === 0) break;
    const dim = anchors[0]!.embedding.byteLength / 4;
    const sum = new Float64Array(dim);
    for (const a of anchors) {
      const v = new Float32Array(a.embedding.buffer, a.embedding.byteOffset, dim);
      for (let i = 0; i < dim; i++) sum[i]! += v[i]!;
    }
    let norm = 0;
    for (let i = 0; i < dim; i++) norm += (sum[i]! / anchors.length) ** 2;
    norm = Math.sqrt(norm) || 1;
    const centroid = new Float32Array(dim);
    for (let i = 0; i < dim; i++) centroid[i] = sum[i]! / anchors.length / norm;

    const candidates = await prisma.cloudFace.findMany({
      where: { personId: null },
      select: { id: true, embedding: true },
    });
    const hits: { id: string; s: number }[] = [];
    for (const c of candidates) {
      const v = new Float32Array(c.embedding.buffer, c.embedding.byteOffset, dim);
      let s = 0;
      for (let i = 0; i < dim; i++) s += v[i]! * centroid[i]!;
      if (s >= MATCH) hits.push({ id: c.id, s });
    }
    if (hits.length === 0) break;
    for (let i = 0; i < hits.length; i += 200) {
      const chunk = hits.slice(i, i + 200);
      await prisma.$transaction(
        chunk.map((h) =>
          prisma.cloudFace.update({ where: { id: h.id }, data: { personId, assignedBy: "auto", matchScore: h.s } })
        )
      );
    }
    total += hits.length;
  }
  return total;
}

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

    const people = await prisma.cloudPerson.findMany({
      orderBy: { createdAt: "asc" },
      include: { user: { select: { id: true, username: true, displayName: true, avatarUrl: true } } },
    });
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
          // Связанная персона живёт под именем аккаунта: displayName меняется
          // в Еблуше — меняется и здесь, без рассинхрона.
          name: p.user ? p.user.displayName || p.user.username : p.name,
          countInSpace: inSpace.get(p.id) ?? 0,
          cover: cover ? faceDto(cover) : null,
          user: p.user,
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

/**
 * Кандидаты на привязку: ПРИНЯТЫЕ друзья из Еблуши плюс участники общих
 * хуяпок — весь свой круг, а не только соседи по текущему альбому.
 */
router.get(
  "/candidates",
  ah(async (req: Request, res) => {
    const me = req.cloudUser!.id;
    const contacts = await prisma.contact.findMany({
      where: { status: "ACCEPTED", OR: [{ requesterId: me }, { addresseeId: me }] },
      select: {
        requester: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
        addressee: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
      },
    });
    const mates = await prisma.cloudSpaceMember.findMany({
      where: { space: { deletedAt: null, members: { some: { userId: me } } } },
      select: { user: { select: { id: true, username: true, displayName: true, avatarUrl: true } } },
    });
    const seen = new Map<string, { id: string; username: string; displayName: string | null; avatarUrl: string | null }>();
    for (const c of contacts) {
      const other = c.requester.id === me ? c.addressee : c.requester;
      seen.set(other.id, other);
    }
    for (const m of mates) if (m.user.id !== me) seen.set(m.user.id, m.user);
    // Себя — первым: «это я» — самый частый кейс разметки.
    const self = await prisma.user.findUnique({
      where: { id: me },
      select: { id: true, username: true, displayName: true, avatarUrl: true },
    });
    const linked = await prisma.cloudPerson.findMany({ where: { userId: { not: null } }, select: { userId: true } });
    const taken = new Set(linked.map((l) => l.userId));
    const list = [self!, ...[...seen.values()].sort((a, b) => (a.displayName ?? a.username).localeCompare(b.displayName ?? b.username, "ru"))];
    res.json({ candidates: list.map((u) => ({ ...u, linked: taken.has(u.id) })) });
  })
);

/** Лица конкретного снимка — для панели «Сведения» в просмотрщике. */
router.get(
  "/by-file",
  ah(async (req: Request, res) => {
    const fileId = String(req.query.fileId ?? "");
    if (!fileId) throw invalid("Нужен fileId");
    await requireFileAccess(req, fileId, "space:view");
    const faces = await prisma.cloudFace.findMany({
      where: { fileId },
      orderBy: { w: "desc" },
      include: {
        file: { select: { width: true, height: true } },
        person: { include: { user: { select: { id: true, username: true, displayName: true, avatarUrl: true } } } },
      },
    });
    res.json({
      faces: faces.map((f) => ({
        ...faceDto(f),
        person: f.person
          ? {
              id: f.person.id,
              name: f.person.user ? f.person.user.displayName || f.person.user.username : f.person.name,
              user: f.person.user,
            }
          : null,
      })),
    });
  })
);

const nameSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  /** Привязка к аккаунту Еблуши: имя тогда берётся из профиля. */
  userId: z.string().min(1).optional(),
  faceIds: z.array(z.string()).min(1).max(500),
}).refine((v) => v.name || v.userId, { message: "Нужно имя или userId" });

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
    let person = null;
    if (parsed.data.userId) {
      const account = await prisma.user.findUnique({
        where: { id: parsed.data.userId },
        select: { id: true, username: true, displayName: true },
      });
      if (!account) throw notFound("Аккаунт не найден");
      person =
        (await prisma.cloudPerson.findUnique({ where: { userId: account.id } })) ??
        (await prisma.cloudPerson.create({
          data: {
            name: parsed.data.name ?? account.displayName ?? account.username,
            userId: account.id,
            coverFaceId: faces[0]!.id,
          },
        }));
    } else {
      person = await prisma.cloudPerson.findFirst({ where: { name: { equals: parsed.data.name!, mode: "insensitive" } } });
      if (!person) {
        person = await prisma.cloudPerson.create({
          data: { name: parsed.data.name!, coverFaceId: faces[0]!.id },
        });
      }
    }
    await prisma.cloudFace.updateMany({
      where: { id: { in: parsed.data.faceIds } },
      data: { personId: person.id, assignedBy: "user", matchScore: null },
    });
    if (!person.coverFaceId) {
      await prisma.cloudPerson.update({ where: { id: person.id }, data: { coverFaceId: faces[0]!.id } });
    }
    const propagated = await propagatePerson(person.id);
    res.json({ personId: person.id, name: person.name, assigned: faces.length, propagated });
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
    const propagated = parsed.data.personId ? await propagatePerson(parsed.data.personId) : 0;
    res.json({ assigned: faces.length, propagated });
  })
);

const linkSchema = z.object({ userId: z.string().min(1).nullable() });

/** Связать персону с аккаунтом Еблуши (null — отвязать). */
router.post(
  "/people/:id/link",
  ah(async (req: Request, res) => {
    const parsed = linkSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw invalid("Нужен userId");
    const person = await prisma.cloudPerson.findUnique({ where: { id: String(req.params.id) } });
    if (!person) throw notFound("Персона не найдена");
    if (parsed.data.userId) {
      const account = await prisma.user.findUnique({ where: { id: parsed.data.userId }, select: { id: true } });
      if (!account) throw notFound("Аккаунт не найден");
      const taken = await prisma.cloudPerson.findUnique({ where: { userId: parsed.data.userId } });
      if (taken && taken.id !== person.id) throw invalid("Этот аккаунт уже связан с другой персоной");
    }
    const updated = await prisma.cloudPerson.update({
      where: { id: person.id },
      data: { userId: parsed.data.userId },
      include: { user: { select: { id: true, username: true, displayName: true, avatarUrl: true } } },
    });
    res.json({ person: { id: updated.id, name: updated.user ? updated.user.displayName || updated.user.username : updated.name, user: updated.user } });
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
