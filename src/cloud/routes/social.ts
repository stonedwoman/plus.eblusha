import { Router } from "express";
import type { Request } from "express";
import { z } from "zod";
import prisma from "../../lib/prisma";
import { ah, forbidden, invalid, notFound } from "../errors";
import { requireFileAccess, requireSpaceAccess } from "../acl";
import { commentDto, userLite } from "../serialize";
import { recordActivity } from "../activity";
import { emitCloud, spaceRoom } from "../realtime";

/**
 * Комментарии, реакции, избранное и лента активности.
 *
 * Тело комментария хранится и отдаётся как plain text. Никакого HTML: клиент
 * рендерит его текстовым узлом, поэтому XSS через комментарий невозможен
 * структурно, а не «потому что мы не забыли экранировать».
 */
const router = Router();

const ALLOWED_EMOJI = ["👍", "❤️", "😂", "😮", "😢"];
const AUTHOR_SELECT = { id: true, username: true, displayName: true, avatarUrl: true } as const;

// ── Комментарии ──────────────────────────────────────────────────────────────

router.get(
  "/comments",
  ah(async (req: Request, res) => {
    const spaceId = String(req.query.spaceId ?? "");
    const fileId = req.query.fileId ? String(req.query.fileId) : null;
    if (!spaceId) throw invalid("Не указана хуяпка");
    await requireSpaceAccess(req, spaceId, "space:view");

    const comments = await prisma.cloudComment.findMany({
      where: { spaceId, ...(fileId ? { fileId } : { fileId: null }) },
      orderBy: { createdAt: "asc" },
      take: 500,
      include: { author: { select: AUTHOR_SELECT } },
    });
    const reactions = await prisma.cloudReaction.findMany({
      where: { targetType: "COMMENT", targetId: { in: comments.map((c) => c.id) } },
      select: { targetId: true, emoji: true, userId: true },
    });
    const grouped = new Map<string, Record<string, number>>();
    const mine = new Map<string, string[]>();
    for (const r of reactions) {
      const bucket = grouped.get(r.targetId) ?? {};
      bucket[r.emoji] = (bucket[r.emoji] ?? 0) + 1;
      grouped.set(r.targetId, bucket);
      if (r.userId === req.cloudUser!.id) mine.set(r.targetId, [...(mine.get(r.targetId) ?? []), r.emoji]);
    }
    res.json({
      comments: comments.map((c) =>
        commentDto(c, { reactions: grouped.get(c.id) ?? {}, myReactions: mine.get(c.id) ?? [] })
      ),
    });
  })
);

const createCommentSchema = z.object({
  spaceId: z.string().min(1),
  fileId: z.string().min(1).nullable().optional(),
  parentCommentId: z.string().min(1).nullable().optional(),
  body: z.string().trim().min(1).max(4000),
  videoTimestampMs: z.number().int().min(0).max(24 * 3600_000).nullable().optional(),
});

router.post(
  "/comments",
  ah(async (req: Request, res) => {
    const parsed = createCommentSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw invalid("Проверьте текст комментария");
    const user = req.cloudUser!;
    const access = await requireSpaceAccess(req, parsed.data.spaceId, "comment:create");

    if (parsed.data.fileId) {
      const file = await prisma.cloudFile.findFirst({
        where: { id: parsed.data.fileId, spaceId: access.space.id, deletedAt: null },
        select: { id: true },
      });
      if (!file) throw notFound("Файл не найден");
    }
    if (parsed.data.parentCommentId) {
      const parent = await prisma.cloudComment.findFirst({
        where: { id: parsed.data.parentCommentId, spaceId: access.space.id },
        select: { id: true },
      });
      if (!parent) throw notFound("Родительский комментарий не найден");
    }

    const comment = await prisma.cloudComment.create({
      data: {
        spaceId: access.space.id,
        fileId: parsed.data.fileId ?? null,
        parentCommentId: parsed.data.parentCommentId ?? null,
        authorId: user.id,
        body: stripControl(parsed.data.body),
        videoTimestampMs: parsed.data.videoTimestampMs ?? null,
      },
      include: { author: { select: AUTHOR_SELECT } },
    });

    await emitCloud("cloud.comment.created", [spaceRoom(access.space.id)], {
      spaceId: access.space.id,
      comment: commentDto(comment),
    });
    await recordActivity(access.space.id, user.id, "COMMENT_CREATED", {
      fileId: comment.fileId,
      preview: comment.body.slice(0, 80),
    });
    res.status(201).json({ comment: commentDto(comment) });
  })
);

router.patch(
  "/comments/:id",
  ah(async (req: Request, res) => {
    const user = req.cloudUser!;
    const existing = await prisma.cloudComment.findUnique({ where: { id: String(req.params.id) } });
    if (!existing || existing.deletedAt) throw notFound("Комментарий не найден");
    await requireSpaceAccess(req, existing.spaceId, "space:view");
    // Править можно только свой текст — даже владельцу Space.
    if (existing.authorId !== user.id) throw forbidden("Можно править только свои комментарии");

    const body = z.string().trim().min(1).max(4000).safeParse((req.body ?? {}).body);
    if (!body.success) throw invalid("Пустой комментарий");
    const comment = await prisma.cloudComment.update({
      where: { id: existing.id },
      data: { body: stripControl(body.data), editedAt: new Date() },
      include: { author: { select: AUTHOR_SELECT } },
    });
    await emitCloud("cloud.comment.updated", [spaceRoom(existing.spaceId)], {
      spaceId: existing.spaceId,
      comment: commentDto(comment),
    });
    res.json({ comment: commentDto(comment) });
  })
);

router.delete(
  "/comments/:id",
  ah(async (req: Request, res) => {
    const user = req.cloudUser!;
    const existing = await prisma.cloudComment.findUnique({ where: { id: String(req.params.id) } });
    if (!existing || existing.deletedAt) throw notFound("Комментарий не найден");
    const access = await requireSpaceAccess(req, existing.spaceId, "space:view");
    // Свой комментарий — автор, чужой — только владелец Space (модерация).
    if (existing.authorId !== user.id && access.role !== "OWNER") throw forbidden("Нет прав на удаление");

    await prisma.cloudComment.update({ where: { id: existing.id }, data: { deletedAt: new Date() } });
    await emitCloud("cloud.comment.deleted", [spaceRoom(existing.spaceId)], {
      spaceId: existing.spaceId,
      commentId: existing.id,
      fileId: existing.fileId,
    });
    res.json({ ok: true });
  })
);

function stripControl(v: string): string {
  let out = "";
  for (const ch of v) {
    const code = ch.charCodeAt(0);
    if (code < 32 && ch !== "\n" && ch !== "\t") continue;
    if (code === 127) continue;
    out += ch;
  }
  return out;
}

// ── Реакции ──────────────────────────────────────────────────────────────────

const reactionSchema = z.object({
  targetType: z.enum(["FILE", "COMMENT"]),
  targetId: z.string().min(1),
  emoji: z.string().min(1).max(8),
});

router.post(
  "/reactions",
  ah(async (req: Request, res) => {
    const parsed = reactionSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw invalid("Некорректная реакция");
    if (!ALLOWED_EMOJI.includes(parsed.data.emoji)) throw invalid("Такая реакция не поддерживается");
    const user = req.cloudUser!;

    let spaceId: string;
    if (parsed.data.targetType === "FILE") {
      const { file } = await requireFileAccess(req, parsed.data.targetId, "reaction:toggle");
      spaceId = file.spaceId;
    } else {
      const comment = await prisma.cloudComment.findUnique({ where: { id: parsed.data.targetId } });
      if (!comment || comment.deletedAt) throw notFound("Комментарий не найден");
      await requireSpaceAccess(req, comment.spaceId, "reaction:toggle");
      spaceId = comment.spaceId;
    }

    // Уникальный ключ (target, user, emoji) не даёт поставить одну и ту же дважды.
    const existing = await prisma.cloudReaction.findUnique({
      where: {
        targetType_targetId_userId_emoji: {
          targetType: parsed.data.targetType,
          targetId: parsed.data.targetId,
          userId: user.id,
          emoji: parsed.data.emoji,
        },
      },
    });
    if (existing) {
      await prisma.cloudReaction.delete({ where: { id: existing.id } });
    } else {
      await prisma.cloudReaction.create({
        data: {
          targetType: parsed.data.targetType,
          targetId: parsed.data.targetId,
          userId: user.id,
          emoji: parsed.data.emoji,
          spaceId,
        },
      });
    }

    const all = await prisma.cloudReaction.findMany({
      where: { targetType: parsed.data.targetType, targetId: parsed.data.targetId },
      select: { emoji: true, userId: true },
    });
    const counts: Record<string, number> = {};
    const mine: string[] = [];
    for (const r of all) {
      counts[r.emoji] = (counts[r.emoji] ?? 0) + 1;
      if (r.userId === user.id) mine.push(r.emoji);
    }
    await emitCloud("cloud.reaction.changed", [spaceRoom(spaceId)], {
      spaceId,
      targetType: parsed.data.targetType,
      targetId: parsed.data.targetId,
      reactions: counts,
    });
    res.json({ reactions: counts, myReactions: mine, removed: Boolean(existing) });
  })
);

router.get(
  "/activity",
  ah(async (req: Request, res) => {
    const spaceId = String(req.query.spaceId ?? "");
    if (!spaceId) throw invalid("Не указана хуяпка");
    await requireSpaceAccess(req, spaceId, "space:view");
    const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);
    const before = req.query.before ? new Date(String(req.query.before)) : null;

    const events = await prisma.cloudActivityEvent.findMany({
      where: { spaceId, ...(before && !Number.isNaN(before.getTime()) ? { createdAt: { lt: before } } : {}) },
      orderBy: { createdAt: "desc" },
      take: limit,
      include: { actor: { select: AUTHOR_SELECT } },
    });
    res.json({
      events: events.map((e) => ({
        id: e.id,
        type: e.type,
        createdAt: e.createdAt,
        payload: e.payload,
        actor: userLite(e.actor),
      })),
    });
  })
);

export default router;
