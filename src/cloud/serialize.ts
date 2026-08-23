import type { CloudComment, CloudFile, CloudFileVariant, CloudFolder, CloudSpace } from "@prisma/client";

/**
 * DTO для API. Наружу не уходит ничего физического: ни storagePath, ни sha256,
 * ни id объекта — только логические идентификаторы CloudFile/CloudSpace.
 */
export type UserLite = { id: string; username: string; displayName: string | null; avatarUrl: string | null };

export function userLite(u: UserLite | null | undefined): UserLite | null {
  if (!u) return null;
  return { id: u.id, username: u.username, displayName: u.displayName, avatarUrl: u.avatarUrl };
}

export type FileDto = ReturnType<typeof fileDto>;

export function fileDto(
  file: CloudFile & { variants?: CloudFileVariant[]; uploader?: UserLite | null },
  opts: { favorite?: boolean; commentCount?: number; reactions?: Record<string, number>; myReactions?: string[]; urlBase?: string } = {}
) {
  const variants = file.variants ?? [];
  const has = (kind: string) => variants.some((v) => v.kind === kind && v.status === "READY");
  const base = opts.urlBase ?? "/api/cloud/files";
  const playbackReady = has("PLAYBACK");

  return {
    id: file.id,
    spaceId: file.spaceId,
    folderId: file.folderId,
    name: file.originalName,
    mime: file.mimeType,
    size: Number(file.size),
    kind: file.kind,
    status: file.status,
    processingError: file.processingError,
    width: file.width,
    height: file.height,
    durationMs: file.durationMs,
    takenAt: file.takenAt,
    takenAtSource: file.takenAtSource,
    createdAt: file.createdAt,
    deletedAt: file.deletedAt,
    latitude: file.latitude,
    longitude: file.longitude,
    cameraMake: file.cameraMake,
    cameraModel: file.cameraModel,
    videoCodec: file.videoCodec,
    audioCodec: file.audioCodec,
    bitrate: file.bitrate,
    metadata: file.metadata ?? null,
    uploader: userLite(file.uploader),
    favorite: opts.favorite ?? false,
    commentCount: opts.commentCount ?? 0,
    reactions: opts.reactions ?? {},
    myReactions: opts.myReactions ?? [],
    urls: {
      thumb: has("THUMB") ? `${base}/${file.id}/thumb` : null,
      preview: has("PREVIEW") ? `${base}/${file.id}/preview` : null,
      poster: has("POSTER") ? `${base}/${file.id}/poster` : null,
      content: `${base}/${file.id}/content`,
      // Оригинал играбелен напрямую → отдаём его, экономя гигабайты на web-версии.
      playback: file.kind === "VIDEO" ? (playbackReady ? `${base}/${file.id}/playback` : file.directPlayable ? `${base}/${file.id}/content` : null) : null,
      download: `${base}/${file.id}/content?download=1`,
    },
    playbackSource: file.kind === "VIDEO" ? (playbackReady ? "derived" : file.directPlayable ? "original" : null) : null,
  };
}

export function spaceDto(
  space: CloudSpace,
  opts: {
    role?: string;
    members?: (UserLite & { role: string })[];
    stats?: { photos: number; videos: number; others: number; bytes: number; files: number };
    coverFileId?: string | null;
  } = {}
) {
  return {
    id: space.id,
    name: space.name,
    description: space.description,
    ownerId: space.ownerId,
    encryptionMode: space.encryptionMode,
    coverFileId: opts.coverFileId ?? space.coverFileId,
    coverUrl: (opts.coverFileId ?? space.coverFileId) ? `/api/cloud/files/${opts.coverFileId ?? space.coverFileId}/thumb` : null,
    dateFrom: space.dateFrom,
    dateTo: space.dateTo,
    viewerCanComment: space.viewerCanComment,
    createdAt: space.createdAt,
    updatedAt: space.updatedAt,
    role: opts.role ?? null,
    members: opts.members ?? [],
    stats: opts.stats ?? null,
  };
}

export function folderDto(folder: CloudFolder & { _count?: { files: number; children: number } }) {
  return {
    id: folder.id,
    spaceId: folder.spaceId,
    parentId: folder.parentId,
    name: folder.name,
    createdAt: folder.createdAt,
    deletedAt: folder.deletedAt,
    fileCount: folder._count?.files ?? 0,
    childCount: folder._count?.children ?? 0,
  };
}

export function commentDto(
  comment: CloudComment & { author?: UserLite | null },
  opts: { reactions?: Record<string, number>; myReactions?: string[] } = {}
) {
  return {
    id: comment.id,
    spaceId: comment.spaceId,
    fileId: comment.fileId,
    parentCommentId: comment.parentCommentId,
    // Тело всегда plain text: рендерим на клиенте как текст, без dangerouslySetInnerHTML.
    body: comment.deletedAt ? null : comment.body,
    videoTimestampMs: comment.videoTimestampMs,
    createdAt: comment.createdAt,
    editedAt: comment.editedAt,
    deletedAt: comment.deletedAt,
    author: userLite(comment.author),
    reactions: opts.reactions ?? {},
    myReactions: opts.myReactions ?? [],
  };
}
