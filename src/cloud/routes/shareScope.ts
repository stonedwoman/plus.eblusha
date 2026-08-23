import type { CloudShareLink } from "@prisma/client";
import prisma from "../../lib/prisma";

/**
 * Какие именно файлы покрывает публичная ссылка. Считается на сервере при каждом
 * обращении — публичная сессия не носит с собой список прав, а только id ссылки.
 */
export async function resolveShareFileScope(share: CloudShareLink): Promise<Set<string>> {
  if (share.targetType === "FILE" && share.targetId) return new Set([share.targetId]);
  if (share.targetType === "SELECTION") return new Set(share.fileIds);

  if (share.targetType === "FOLDER" && share.targetId) {
    const folderIds = await folderSubtree(share.targetId, share.spaceId);
    const files = await prisma.cloudFile.findMany({
      where: { spaceId: share.spaceId, folderId: { in: folderIds }, deletedAt: null },
      select: { id: true },
      take: 20000,
    });
    return new Set(files.map((f) => f.id));
  }

  const files = await prisma.cloudFile.findMany({
    where: { spaceId: share.spaceId, deletedAt: null },
    select: { id: true },
    take: 20000,
  });
  return new Set(files.map((f) => f.id));
}

export async function folderSubtree(rootId: string, spaceId: string): Promise<string[]> {
  const out = [rootId];
  let frontier = [rootId];
  for (let depth = 0; depth < 32 && frontier.length; depth++) {
    const children = await prisma.cloudFolder.findMany({
      where: { spaceId, parentId: { in: frontier }, deletedAt: null },
      select: { id: true },
    });
    frontier = children.map((c) => c.id).filter((id) => !out.includes(id));
    out.push(...frontier);
  }
  return out;
}

/** Ограничение выборки файлов для share без перечисления тысяч id вручную. */
export async function shareFileWhere(share: CloudShareLink) {
  if (share.targetType === "FILE" && share.targetId) {
    return { spaceId: share.spaceId, id: share.targetId, deletedAt: null };
  }
  if (share.targetType === "SELECTION") {
    return { spaceId: share.spaceId, id: { in: share.fileIds }, deletedAt: null };
  }
  if (share.targetType === "FOLDER" && share.targetId) {
    return { spaceId: share.spaceId, folderId: { in: await folderSubtree(share.targetId, share.spaceId) }, deletedAt: null };
  }
  return { spaceId: share.spaceId, deletedAt: null };
}
