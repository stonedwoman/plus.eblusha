import type { Prisma } from "@prisma/client";
import prisma from "../lib/prisma";
import { fileDto } from "./serialize";

/**
 * Выборки файлов. Вынесены отдельно, потому что ими пользуются и приватный API,
 * и публичная share-галерея — правила сортировки и пагинации должны совпадать.
 *
 * Пагинация курсорная: галерея на несколько тысяч файлов не должна тянуть всё
 * разом ни в SQL, ни в браузер.
 */
export type FileListView = "timeline" | "files" | "map" | "trash" | "favorites" | "recent";

export type FileListParams = {
  spaceId: string;
  viewerId: string;
  view: FileListView;
  folderId?: string | null;
  kind?: "IMAGE" | "VIDEO" | "AUDIO" | "DOCUMENT" | "OTHER" | undefined;
  q?: string | undefined;
  uploaderId?: string | undefined;
  from?: Date | undefined;
  to?: Date | undefined;
  fileIds?: string[] | undefined;
  cursor?: string | undefined;
  limit: number;
};

type Cursor = { k: string; id: string };

function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c)).toString("base64url");
}

function decodeCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Cursor;
    if (typeof parsed.k === "string" && typeof parsed.id === "string") return parsed;
  } catch {
    // битый курсор — просто начинаем сначала
  }
  return null;
}

const FILE_INCLUDE = {
  variants: true,
  uploader: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
} satisfies Prisma.CloudFileInclude;

export async function listFiles(params: FileListParams) {
  const { spaceId, view, viewerId } = params;
  const limit = Math.min(Math.max(params.limit, 1), 200);

  const where: Prisma.CloudFileWhereInput = { spaceId };
  where.deletedAt = view === "trash" ? { not: null } : null;

  if (view === "files" && params.folderId !== undefined) where.folderId = params.folderId;
  if (view === "map") where.AND = [{ latitude: { not: null } }, { longitude: { not: null } }];
  if (view === "favorites") where.favorites = { some: { userId: viewerId } };
  if (params.kind) where.kind = params.kind;
  if (params.uploaderId) where.uploaderId = params.uploaderId;
  if (params.fileIds?.length) where.id = { in: params.fileIds };
  if (params.from || params.to) {
    where.takenAt = {
      ...(params.from ? { gte: params.from } : {}),
      ...(params.to ? { lte: params.to } : {}),
    };
  }
  if (params.q?.trim()) {
    const q = params.q.trim().slice(0, 120);
    where.originalName = { contains: q, mode: "insensitive" };
  }

  // timeline/map/recent — по времени съёмки (не загрузки!), files — по имени.
  const byName = view === "files";
  const cursor = decodeCursor(params.cursor);
  if (cursor) {
    if (byName) {
      where.OR = [{ originalName: { gt: cursor.k } }, { originalName: cursor.k, id: { gt: cursor.id } }];
    } else {
      const at = new Date(cursor.k);
      where.OR = [{ takenAt: { lt: at } }, { takenAt: at, id: { lt: cursor.id } }];
    }
  }

  const orderBy: Prisma.CloudFileOrderByWithRelationInput[] = byName
    ? [{ originalName: "asc" }, { id: "asc" }]
    : view === "trash" || view === "recent"
      ? [{ createdAt: "desc" }, { id: "desc" }]
      : [{ takenAt: "desc" }, { id: "desc" }];

  const rows = await prisma.cloudFile.findMany({
    where,
    orderBy,
    take: limit + 1,
    include: FILE_INCLUDE,
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  const nextCursor =
    hasMore && last
      ? encodeCursor({
          k: byName ? last.originalName : (view === "trash" || view === "recent" ? last.createdAt : last.takenAt).toISOString(),
          id: last.id,
        })
      : null;

  const social = await socialFor(page.map((f) => f.id), viewerId);
  return {
    files: page.map((f) =>
      fileDto(f, {
        favorite: social.favorites.has(f.id),
        commentCount: social.comments.get(f.id) ?? 0,
        reactions: social.reactions.get(f.id) ?? {},
        myReactions: social.mine.get(f.id) ?? [],
      })
    ),
    nextCursor,
  };
}

/** Избранное/комментарии/реакции для набора файлов — одним пакетом, без N+1. */
export async function socialFor(fileIds: string[], viewerId: string | null) {
  const empty = {
    favorites: new Set<string>(),
    comments: new Map<string, number>(),
    reactions: new Map<string, Record<string, number>>(),
    mine: new Map<string, string[]>(),
  };
  if (fileIds.length === 0) return empty;

  const [favorites, comments, reactions] = await Promise.all([
    viewerId
      ? prisma.cloudFavorite.findMany({ where: { userId: viewerId, fileId: { in: fileIds } }, select: { fileId: true } })
      : Promise.resolve([]),
    prisma.cloudComment.groupBy({
      by: ["fileId"],
      where: { fileId: { in: fileIds }, deletedAt: null },
      _count: { _all: true },
    }),
    prisma.cloudReaction.findMany({
      where: { targetType: "FILE", targetId: { in: fileIds } },
      select: { targetId: true, emoji: true, userId: true },
    }),
  ]);

  const out = {
    favorites: new Set(favorites.map((f) => f.fileId)),
    comments: new Map<string, number>(),
    reactions: new Map<string, Record<string, number>>(),
    mine: new Map<string, string[]>(),
  };
  for (const c of comments) if (c.fileId) out.comments.set(c.fileId, c._count._all);
  for (const r of reactions) {
    const bucket = out.reactions.get(r.targetId) ?? {};
    bucket[r.emoji] = (bucket[r.emoji] ?? 0) + 1;
    out.reactions.set(r.targetId, bucket);
    if (viewerId && r.userId === viewerId) {
      out.mine.set(r.targetId, [...(out.mine.get(r.targetId) ?? []), r.emoji]);
    }
  }
  return out;
}

export async function loadFileWithSocial(fileId: string, viewerId: string | null) {
  const file = await prisma.cloudFile.findUnique({ where: { id: fileId }, include: FILE_INCLUDE });
  if (!file) return null;
  const social = await socialFor([file.id], viewerId);
  return fileDto(file, {
    favorite: social.favorites.has(file.id),
    commentCount: social.comments.get(file.id) ?? 0,
    reactions: social.reactions.get(file.id) ?? {},
    myReactions: social.mine.get(file.id) ?? [],
  });
}
