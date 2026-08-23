import { Router } from "express";
import type { Request } from "express";
import { z } from "zod";
import prisma from "../../lib/prisma";
import { ah, forbidden, invalid, notFound } from "../errors";
import { getSpaceAccess, listAccessibleSpaceIds, requireSpaceAccess } from "../acl";
import { spaceDto, userLite } from "../serialize";
import { recordActivity } from "../activity";
import { writeAudit } from "../audit";
import { emitCloud, getSpacePresence, spaceRoom, userRoom } from "../realtime";

const router = Router();

const nameSchema = z.string().trim().min(1).max(120);

/** Сводка по Space: сколько фото/видео/прочего и сколько это весит. */
export async function spaceStats(spaceId: string) {
  const rows = await prisma.cloudFile.groupBy({
    by: ["kind"],
    where: { spaceId, deletedAt: null },
    _count: { _all: true },
    _sum: { size: true },
  });
  let photos = 0;
  let videos = 0;
  let others = 0;
  let bytes = 0;
  let files = 0;
  for (const r of rows) {
    const count = r._count._all;
    files += count;
    bytes += Number(r._sum.size ?? 0n);
    if (r.kind === "IMAGE") photos += count;
    else if (r.kind === "VIDEO") videos += count;
    else others += count;
  }
  return { photos, videos, others, bytes, files };
}

async function spaceMembers(spaceId: string) {
  const space = await prisma.cloudSpace.findUnique({
    where: { id: spaceId },
    select: { ownerId: true, owner: { select: { id: true, username: true, displayName: true, avatarUrl: true } } },
  });
  const members = await prisma.cloudSpaceMember.findMany({
    where: { spaceId },
    include: { user: { select: { id: true, username: true, displayName: true, avatarUrl: true } } },
    orderBy: { createdAt: "asc" },
  });
  const out: (ReturnType<typeof userLite> & { role: string })[] = [];
  if (space?.owner) out.push({ ...(userLite(space.owner) as NonNullable<ReturnType<typeof userLite>>), role: "OWNER" });
  for (const m of members) {
    if (m.userId === space?.ownerId) continue;
    out.push({ ...(userLite(m.user) as NonNullable<ReturnType<typeof userLite>>), role: m.role });
  }
  return out;
}

/** GET /api/cloud/spaces — мои Space + те, куда меня позвали. */
router.get(
  "/",
  ah(async (req: Request, res) => {
    const user = req.cloudUser!;
    const ids = await listAccessibleSpaceIds(user.id);
    const spaces = await prisma.cloudSpace.findMany({
      where: { id: { in: ids }, deletedAt: null },
      orderBy: { updatedAt: "desc" },
    });
    const result = await Promise.all(
      spaces.map(async (space) => {
        const [stats, members] = await Promise.all([spaceStats(space.id), spaceMembers(space.id)]);
        // Обложка: явная, иначе самое свежее фото Space.
        let cover = space.coverFileId;
        if (!cover) {
          const latest = await prisma.cloudFile.findFirst({
            where: { spaceId: space.id, deletedAt: null, kind: { in: ["IMAGE", "VIDEO"] }, status: "READY" },
            orderBy: { takenAt: "desc" },
            select: { id: true },
          });
          cover = latest?.id ?? null;
        }
        return spaceDto(space, {
          role: space.ownerId === user.id ? "OWNER" : members.find((m) => m.id === user.id)?.role ?? "VIEWER",
          members,
          stats,
          coverFileId: cover,
        });
      })
    );
    res.json({ spaces: result });
  })
);

const createSchema = z.object({
  name: nameSchema,
  description: z.string().trim().max(2000).optional(),
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
});

router.post(
  "/",
  ah(async (req: Request, res) => {
    const user = req.cloudUser!;
    const parsed = createSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw invalid("Проверьте название Space");
    const count = await prisma.cloudSpace.count({ where: { ownerId: user.id, deletedAt: null } });
    if (count >= 200) throw forbidden("Слишком много Space у одного пользователя");

    const space = await prisma.cloudSpace.create({
      data: {
        name: parsed.data.name,
        description: parsed.data.description ?? null,
        ownerId: user.id,
        dateFrom: parsed.data.dateFrom ?? null,
        dateTo: parsed.data.dateTo ?? null,
      },
    });
    // Владелец тоже участник — так проще считать состав и отдавать списки.
    await prisma.cloudSpaceMember.create({ data: { spaceId: space.id, userId: user.id, role: "OWNER" } });
    await recordActivity(space.id, user.id, "SPACE_CREATED", { name: space.name });
    await writeAudit(req, "SPACE_CREATED", { spaceId: space.id, detail: { name: space.name } });
    res.status(201).json({ space: spaceDto(space, { role: "OWNER", members: await spaceMembers(space.id), stats: await spaceStats(space.id) }) });
  })
);

router.get(
  "/:id",
  ah(async (req: Request, res) => {
    const access = await requireSpaceAccess(req, String(req.params.id), "space:view");
    const [stats, members, presence] = await Promise.all([
      spaceStats(access.space.id),
      spaceMembers(access.space.id),
      getSpacePresence(access.space.id),
    ]);
    res.json({
      space: spaceDto(access.space, { role: access.role, members, stats }),
      presence,
    });
  })
);

const updateSchema = z.object({
  name: nameSchema.optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  coverFileId: z.string().cuid().nullable().optional(),
  dateFrom: z.coerce.date().nullable().optional(),
  dateTo: z.coerce.date().nullable().optional(),
  viewerCanComment: z.boolean().optional(),
});

router.patch(
  "/:id",
  ah(async (req: Request, res) => {
    const access = await requireSpaceAccess(req, String(req.params.id), "space:update");
    const parsed = updateSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw invalid("Некорректные поля");
    const data = parsed.data;

    // viewerCanComment меняет права — это прерогатива владельца.
    if (data.viewerCanComment !== undefined && access.role !== "OWNER") {
      throw forbidden("Настройку комментариев меняет владелец");
    }
    if (data.coverFileId) {
      const file = await prisma.cloudFile.findFirst({
        where: { id: data.coverFileId, spaceId: access.space.id, deletedAt: null },
        select: { id: true },
      });
      if (!file) throw notFound("Файл обложки не найден в этом Space");
    }

    const space = await prisma.cloudSpace.update({
      where: { id: access.space.id },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.description !== undefined ? { description: data.description } : {}),
        ...(data.coverFileId !== undefined ? { coverFileId: data.coverFileId } : {}),
        ...(data.dateFrom !== undefined ? { dateFrom: data.dateFrom } : {}),
        ...(data.dateTo !== undefined ? { dateTo: data.dateTo } : {}),
        ...(data.viewerCanComment !== undefined ? { viewerCanComment: data.viewerCanComment } : {}),
      },
    });
    await recordActivity(space.id, req.cloudUser!.id, "SPACE_UPDATED", { name: space.name });
    await emitCloud("cloud.space.updated", [spaceRoom(space.id)], { space: spaceDto(space) });
    res.json({ space: spaceDto(space, { role: access.role }) });
  })
);

/**
 * Удаление Space: мягкое. Файлы уезжают в корзину и физически исчезнут только
 * после retention — до тех пор всё восстановимо через /restore.
 */
router.delete(
  "/:id",
  ah(async (req: Request, res) => {
    const access = await requireSpaceAccess(req, String(req.params.id), "space:delete");
    const now = new Date();
    await prisma.$transaction([
      prisma.cloudSpace.update({ where: { id: access.space.id }, data: { deletedAt: now } }),
      prisma.cloudFile.updateMany({
        where: { spaceId: access.space.id, deletedAt: null },
        data: { deletedAt: now, deletedById: req.cloudUser!.id },
      }),
    ]);
    await writeAudit(req, "SPACE_DELETED", { spaceId: access.space.id });
    res.json({ ok: true });
  })
);

router.post(
  "/:id/restore",
  ah(async (req: Request, res) => {
    const user = req.cloudUser!;
    const space = await prisma.cloudSpace.findFirst({ where: { id: String(req.params.id), ownerId: user.id } });
    if (!space || !space.deletedAt) throw notFound("Space не найден");
    const deletedAt = space.deletedAt;
    await prisma.$transaction([
      prisma.cloudSpace.update({ where: { id: space.id }, data: { deletedAt: null } }),
      // Возвращаем только то, что уехало в корзину вместе со Space (по метке времени).
      prisma.cloudFile.updateMany({
        where: { spaceId: space.id, deletedAt: { gte: new Date(deletedAt.getTime() - 5000), lte: new Date(deletedAt.getTime() + 5000) } },
        data: { deletedAt: null, deletedById: null },
      }),
    ]);
    res.json({ ok: true });
  })
);

// ── Участники ────────────────────────────────────────────────────────────────

router.get(
  "/:id/members",
  ah(async (req: Request, res) => {
    const access = await requireSpaceAccess(req, String(req.params.id), "space:view");
    res.json({ members: await spaceMembers(access.space.id), presence: await getSpacePresence(access.space.id) });
  })
);

const addMemberSchema = z.object({
  userId: z.string().min(1).max(64),
  role: z.enum(["EDITOR", "VIEWER"]).default("VIEWER"),
});

router.post(
  "/:id/members",
  ah(async (req: Request, res) => {
    const access = await requireSpaceAccess(req, String(req.params.id), "members:manage");
    const parsed = addMemberSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw invalid("Укажите пользователя и роль");
    const target = await prisma.user.findFirst({
      where: { id: parsed.data.userId, deletedAt: null, bannedAt: null },
      select: { id: true, username: true, displayName: true, avatarUrl: true },
    });
    if (!target) throw notFound("Пользователь не найден");
    if (target.id === access.space.ownerId) throw invalid("Владелец уже в Space");

    await prisma.cloudSpaceMember.upsert({
      where: { spaceId_userId: { spaceId: access.space.id, userId: target.id } },
      create: { spaceId: access.space.id, userId: target.id, role: parsed.data.role, invitedById: req.cloudUser!.id },
      update: { role: parsed.data.role },
    });
    await recordActivity(access.space.id, req.cloudUser!.id, "MEMBER_ADDED", {
      name: target.displayName ?? target.username,
    });
    await writeAudit(req, "MEMBER_ADDED", { spaceId: access.space.id, targetId: target.id, detail: { role: parsed.data.role } });
    await emitCloud("cloud.member.joined", [spaceRoom(access.space.id), userRoom(target.id)], {
      spaceId: access.space.id,
      member: { ...userLite(target), role: parsed.data.role },
    });
    res.status(201).json({ members: await spaceMembers(access.space.id) });
  })
);

router.patch(
  "/:id/members/:userId",
  ah(async (req: Request, res) => {
    const access = await requireSpaceAccess(req, String(req.params.id), "members:manage");
    const role = z.enum(["EDITOR", "VIEWER"]).safeParse((req.body ?? {}).role);
    if (!role.success) throw invalid("Недопустимая роль");
    const userId = String(req.params.userId);
    if (userId === access.space.ownerId) throw invalid("Роль владельца менять нельзя");
    await prisma.cloudSpaceMember.update({
      where: { spaceId_userId: { spaceId: access.space.id, userId } },
      data: { role: role.data },
    });
    await recordActivity(access.space.id, req.cloudUser!.id, "MEMBER_ROLE_CHANGED", { role: role.data });
    await writeAudit(req, "MEMBER_ROLE_CHANGED", { spaceId: access.space.id, targetId: userId, detail: { role: role.data } });
    res.json({ members: await spaceMembers(access.space.id) });
  })
);

router.delete(
  "/:id/members/:userId",
  ah(async (req: Request, res) => {
    const user = req.cloudUser!;
    const spaceId = String(req.params.id);
    const userId = String(req.params.userId);
    // Выйти самому можно всегда; удалять других — только владельцу.
    const selfLeave = userId === user.id;
    const access = selfLeave
      ? await getSpaceAccess(user.id, spaceId)
      : await requireSpaceAccess(req, spaceId, "members:manage");
    if (!access) throw notFound("Space не найден");
    if (userId === access.space.ownerId) throw invalid("Владельца исключить нельзя");

    await prisma.cloudSpaceMember.deleteMany({ where: { spaceId, userId } });
    await recordActivity(spaceId, user.id, "MEMBER_REMOVED", { self: selfLeave });
    await writeAudit(req, "MEMBER_REMOVED", { spaceId, targetId: userId });
    await emitCloud("cloud.member.left", [spaceRoom(spaceId), userRoom(userId)], { spaceId, userId });
    res.json({ ok: true });
  })
);

export default router;
