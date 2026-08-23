import { Router } from "express";
import type { Request } from "express";
import { z } from "zod";
import prisma from "../../lib/prisma";
import { ah, conflict, invalid, notFound } from "../errors";
import { requireSpaceAccess } from "../acl";
import { folderDto } from "../serialize";
import { recordActivity } from "../activity";
import { emitCloud, spaceRoom } from "../realtime";

/**
 * Папка — сущность метаданных, а не каталог на диске. Физическая раскладка
 * хранилища от неё не зависит вообще (см. src/cloud/paths.ts).
 */
const router = Router();

const MAX_DEPTH = 32;
/** Слеши и управляющие символы в имени папки не нужны никому, кроме атакующего. */
function isSafeName(v: string): boolean {
  if (/[/\\]/.test(v)) return false;
  for (const ch of v) {
    const code = ch.charCodeAt(0);
    if (code < 32 || code === 127) return false;
  }
  return true;
}

const nameSchema = z.string().trim().min(1).max(120).refine(isSafeName, "Недопустимые символы");

async function assertFolderInSpace(folderId: string, spaceId: string) {
  const folder = await prisma.cloudFolder.findFirst({ where: { id: folderId, spaceId, deletedAt: null } });
  if (!folder) throw notFound("Папка не найдена");
  return folder;
}

/** Глубина + защита от превращения дерева в кольцо при перемещении. */
async function assertNoCycle(folderId: string, newParentId: string | null, spaceId: string) {
  if (!newParentId) return;
  if (newParentId === folderId) throw conflict("Папку нельзя вложить в саму себя");
  let cursor: string | null = newParentId;
  for (let depth = 0; depth < MAX_DEPTH && cursor; depth++) {
    if (cursor === folderId) throw conflict("Нельзя переместить папку внутрь её же поддерева");
    const parent: { parentId: string | null } | null = await prisma.cloudFolder.findFirst({
      where: { id: cursor, spaceId },
      select: { parentId: true },
    });
    if (!parent) throw notFound("Родительская папка не найдена");
    cursor = parent.parentId;
  }
  if (cursor) throw conflict("Слишком глубокая вложенность");
}

/** GET /api/cloud/folders?spaceId=&parentId= */
router.get(
  "/",
  ah(async (req: Request, res) => {
    const spaceId = String(req.query.spaceId ?? "");
    if (!spaceId) throw invalid("Нужен spaceId");
    await requireSpaceAccess(req, spaceId, "space:view");
    const parentRaw = req.query.parentId;
    const parentId = parentRaw === undefined || parentRaw === "" || parentRaw === "root" ? null : String(parentRaw);

    const folders = await prisma.cloudFolder.findMany({
      where: { spaceId, parentId, deletedAt: null },
      orderBy: { name: "asc" },
      include: { _count: { select: { files: true, children: true } } },
    });
    res.json({ folders: folders.map(folderDto) });
  })
);

/** Хлебные крошки от корня до папки. */
router.get(
  "/:id/breadcrumbs",
  ah(async (req: Request, res) => {
    const folder = await prisma.cloudFolder.findUnique({ where: { id: String(req.params.id) } });
    if (!folder) throw notFound("Папка не найдена");
    await requireSpaceAccess(req, folder.spaceId, "space:view");

    const chain: { id: string; name: string }[] = [];
    let cursor: string | null = folder.id;
    for (let i = 0; i < MAX_DEPTH && cursor; i++) {
      const cur: { id: string; name: string; parentId: string | null } | null = await prisma.cloudFolder.findUnique({
        where: { id: cursor },
        select: { id: true, name: true, parentId: true },
      });
      if (!cur) break;
      chain.unshift({ id: cur.id, name: cur.name });
      cursor = cur.parentId;
    }
    res.json({ breadcrumbs: chain });
  })
);

const createSchema = z.object({
  spaceId: z.string().min(1),
  parentId: z.string().min(1).nullable().optional(),
  name: nameSchema,
});

router.post(
  "/",
  ah(async (req: Request, res) => {
    const parsed = createSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw invalid("Проверьте имя папки");
    const { spaceId, name } = parsed.data;
    const parentId = parsed.data.parentId ?? null;
    const access = await requireSpaceAccess(req, spaceId, "folder:manage");
    if (parentId) {
      await assertFolderInSpace(parentId, spaceId);
      await assertNoCycle("", parentId, spaceId);
    }
    const folder = await prisma.cloudFolder.create({
      data: { spaceId, parentId, name, createdById: req.cloudUser!.id },
    });
    await recordActivity(spaceId, req.cloudUser!.id, "FOLDER_CREATED", { name });
    await emitCloud("cloud.folder.changed", [spaceRoom(spaceId)], { spaceId, folder: folderDto(folder), action: "created" });
    void access;
    res.status(201).json({ folder: folderDto(folder) });
  })
);

const patchSchema = z.object({
  name: nameSchema.optional(),
  parentId: z.string().min(1).nullable().optional(),
});

router.patch(
  "/:id",
  ah(async (req: Request, res) => {
    const existing = await prisma.cloudFolder.findUnique({ where: { id: String(req.params.id) } });
    if (!existing || existing.deletedAt) throw notFound("Папка не найдена");
    await requireSpaceAccess(req, existing.spaceId, "folder:manage");
    const parsed = patchSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw invalid("Некорректные поля");

    if (parsed.data.parentId !== undefined) {
      if (parsed.data.parentId) await assertFolderInSpace(parsed.data.parentId, existing.spaceId);
      await assertNoCycle(existing.id, parsed.data.parentId ?? null, existing.spaceId);
    }

    const folder = await prisma.cloudFolder.update({
      where: { id: existing.id },
      data: {
        ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
        ...(parsed.data.parentId !== undefined ? { parentId: parsed.data.parentId } : {}),
      },
    });
    if (parsed.data.name && parsed.data.name !== existing.name) {
      await recordActivity(existing.spaceId, req.cloudUser!.id, "FOLDER_RENAMED", { from: existing.name, to: folder.name });
    }
    await emitCloud("cloud.folder.changed", [spaceRoom(existing.spaceId)], {
      spaceId: existing.spaceId,
      folder: folderDto(folder),
      action: "updated",
    });
    res.json({ folder: folderDto(folder) });
  })
);

/** Удаление папки: рекурсивно уносит вложенные папки и файлы в корзину. */
router.delete(
  "/:id",
  ah(async (req: Request, res) => {
    const existing = await prisma.cloudFolder.findUnique({ where: { id: String(req.params.id) } });
    if (!existing || existing.deletedAt) throw notFound("Папка не найдена");
    await requireSpaceAccess(req, existing.spaceId, "folder:manage");

    const ids = await collectSubtree(existing.id, existing.spaceId);
    const now = new Date();
    await prisma.$transaction([
      prisma.cloudFile.updateMany({
        where: { folderId: { in: ids }, deletedAt: null },
        data: { deletedAt: now, deletedById: req.cloudUser!.id },
      }),
      prisma.cloudFolder.updateMany({ where: { id: { in: ids } }, data: { deletedAt: now } }),
    ]);
    await recordActivity(existing.spaceId, req.cloudUser!.id, "FOLDER_DELETED", { name: existing.name });
    await emitCloud("cloud.folder.changed", [spaceRoom(existing.spaceId)], {
      spaceId: existing.spaceId,
      folder: folderDto(existing),
      action: "deleted",
    });
    res.json({ ok: true, folders: ids.length });
  })
);

router.post(
  "/:id/restore",
  ah(async (req: Request, res) => {
    const existing = await prisma.cloudFolder.findUnique({ where: { id: String(req.params.id) } });
    if (!existing || !existing.deletedAt) throw notFound("Папка не найдена");
    await requireSpaceAccess(req, existing.spaceId, "folder:manage");
    // Родителя тоже поднимаем, иначе папка вернётся в невидимое поддерево.
    const chain: string[] = [];
    let cursor: string | null = existing.id;
    for (let i = 0; i < MAX_DEPTH && cursor; i++) {
      const cur: { id: string; parentId: string | null } | null = await prisma.cloudFolder.findUnique({
        where: { id: cursor },
        select: { id: true, parentId: true },
      });
      if (!cur) break;
      chain.push(cur.id);
      cursor = cur.parentId;
    }
    await prisma.cloudFolder.updateMany({ where: { id: { in: chain } }, data: { deletedAt: null } });
    res.json({ ok: true });
  })
);

async function collectSubtree(rootId: string, spaceId: string): Promise<string[]> {
  const out = [rootId];
  let frontier = [rootId];
  for (let depth = 0; depth < MAX_DEPTH && frontier.length; depth++) {
    const children = await prisma.cloudFolder.findMany({
      where: { spaceId, parentId: { in: frontier } },
      select: { id: true },
    });
    frontier = children.map((c) => c.id).filter((id) => !out.includes(id));
    out.push(...frontier);
  }
  return out;
}

export default router;
