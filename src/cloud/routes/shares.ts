import crypto from "node:crypto";
import { Router } from "express";
import type { Request } from "express";
import { z } from "zod";
import bcrypt from "bcrypt";
import prisma from "../../lib/prisma";
import { ah, conflict, invalid, notFound } from "../errors";
import { requireSpaceAccess } from "../acl";
import { recordActivity } from "../activity";
import { writeAudit } from "../audit";
import { spaceDto } from "../serialize";

/**
 * Ссылки двух принципиально разных видов.
 *
 * 1. CloudInvite — приглашение УЧАСТНИКА. Всегда требует входа через Еблушу,
 *    выдаёт роль в Space. Это не ссылка на скачивание.
 * 2. CloudShareLink — публичный read-only доступ. Логина не требует, писать
 *    не разрешает никогда.
 *
 * Секрет ссылки в открытом виде не хранится: в БД лежит sha256, а сам секрет
 * возвращается создателю ровно один раз и живёт во фрагменте URL (#t=...),
 * который браузер не отправляет на сервер и который не попадает в access-логи.
 */
const router = Router();

function newSecret(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function hashSecret(secret: string): string {
  return crypto.createHash("sha256").update(secret).digest("hex");
}

function publicId(): string {
  return crypto.randomBytes(9).toString("base64url");
}

function baseUrl(req: Request): string {
  const configured = process.env.CLOUD_PUBLIC_BASE_URL;
  if (configured) return configured.replace(/\/+$/, "");
  const proto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0] ?? req.protocol;
  return `${proto}://${req.headers.host}`;
}

// ── Приглашения участников ───────────────────────────────────────────────────

const inviteSchema = z.object({
  spaceId: z.string().min(1),
  role: z.enum(["EDITOR", "VIEWER"]).default("EDITOR"),
  maxUses: z.number().int().min(1).max(100).default(1),
  expiresInHours: z.number().int().min(1).max(24 * 90).nullable().optional(),
  note: z.string().trim().max(200).optional(),
});

router.post(
  "/invites",
  ah(async (req: Request, res) => {
    const parsed = inviteSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw invalid("Некорректные параметры приглашения");
    const access = await requireSpaceAccess(req, parsed.data.spaceId, "invites:manage");

    const secret = newSecret();
    const invite = await prisma.cloudInvite.create({
      data: {
        spaceId: access.space.id,
        tokenHash: hashSecret(secret),
        publicId: publicId(),
        role: parsed.data.role,
        maxUses: parsed.data.maxUses,
        expiresAt: parsed.data.expiresInHours ? new Date(Date.now() + parsed.data.expiresInHours * 3600_000) : null,
        createdById: req.cloudUser!.id,
        note: parsed.data.note ?? null,
      },
    });
    await writeAudit(req, "INVITE_CREATED", { spaceId: access.space.id, targetId: invite.id, detail: { role: invite.role } });
    res.status(201).json({
      invite: inviteDto(invite),
      // Секрет отдаётся ОДИН раз — восстановить его потом нельзя даже нам.
      url: `${baseUrl(req)}/cloud/join/${invite.publicId}#t=${secret}`,
    });
  })
);

router.get(
  "/invites",
  ah(async (req: Request, res) => {
    const spaceId = String(req.query.spaceId ?? "");
    if (!spaceId) throw invalid("Нужен spaceId");
    const access = await requireSpaceAccess(req, spaceId, "invites:manage");
    const invites = await prisma.cloudInvite.findMany({
      where: { spaceId: access.space.id, revokedAt: null },
      orderBy: { createdAt: "desc" },
    });
    res.json({ invites: invites.map(inviteDto) });
  })
);

router.delete(
  "/invites/:id",
  ah(async (req: Request, res) => {
    const invite = await prisma.cloudInvite.findUnique({ where: { id: String(req.params.id) } });
    if (!invite) throw notFound("Приглашение не найдено");
    await requireSpaceAccess(req, invite.spaceId, "invites:manage");
    await prisma.cloudInvite.update({ where: { id: invite.id }, data: { revokedAt: new Date() } });
    await writeAudit(req, "INVITE_REVOKED", { spaceId: invite.spaceId, targetId: invite.id });
    res.json({ ok: true });
  })
);

function inviteDto(invite: { id: string; publicId: string; role: string; maxUses: number; useCount: number; expiresAt: Date | null; createdAt: Date; note: string | null }) {
  return {
    id: invite.id,
    publicId: invite.publicId,
    role: invite.role,
    maxUses: invite.maxUses,
    useCount: invite.useCount,
    expiresAt: invite.expiresAt,
    createdAt: invite.createdAt,
    note: invite.note,
  };
}

/** Предпросмотр приглашения после логина: кто зовёт и куда. */
router.post(
  "/invites/:publicId/peek",
  ah(async (req: Request, res) => {
    const { invite, space } = await loadInvite(String(req.params.publicId), String((req.body ?? {}).secret ?? ""));
    const inviter = await prisma.user.findUnique({
      where: { id: invite.createdById },
      select: { id: true, username: true, displayName: true, avatarUrl: true },
    });
    const alreadyMember = await prisma.cloudSpaceMember.findUnique({
      where: { spaceId_userId: { spaceId: space.id, userId: req.cloudUser!.id } },
      select: { role: true },
    });
    res.json({
      space: spaceDto(space),
      role: invite.role,
      inviter,
      alreadyMember: Boolean(alreadyMember) || space.ownerId === req.cloudUser!.id,
    });
  })
);

router.post(
  "/invites/:publicId/accept",
  ah(async (req: Request, res) => {
    const { invite, space } = await loadInvite(String(req.params.publicId), String((req.body ?? {}).secret ?? ""));
    const user = req.cloudUser!;

    if (space.ownerId === user.id) {
      res.json({ ok: true, spaceId: space.id, role: "OWNER" });
      return;
    }
    const existing = await prisma.cloudSpaceMember.findUnique({
      where: { spaceId_userId: { spaceId: space.id, userId: user.id } },
    });
    if (existing) {
      res.json({ ok: true, spaceId: space.id, role: existing.role });
      return;
    }
    if (invite.useCount >= invite.maxUses) throw conflict("Приглашение исчерпано");

    await prisma.$transaction([
      prisma.cloudSpaceMember.create({
        data: { spaceId: space.id, userId: user.id, role: invite.role, invitedById: invite.createdById },
      }),
      prisma.cloudInvite.update({ where: { id: invite.id }, data: { useCount: { increment: 1 } } }),
    ]);
    await recordActivity(space.id, user.id, "MEMBER_ADDED", { name: user.displayName ?? user.username, viaInvite: true });
    await writeAudit(req, "INVITE_ACCEPTED", { spaceId: space.id, targetId: invite.id });
    res.json({ ok: true, spaceId: space.id, role: invite.role });
  })
);

async function loadInvite(pid: string, secret: string) {
  if (!/^[A-Za-z0-9_-]{6,32}$/.test(pid)) throw notFound("Приглашение не найдено");
  const invite = await prisma.cloudInvite.findUnique({ where: { publicId: pid } });
  if (!invite || invite.revokedAt) throw notFound("Приглашение недействительно");
  if (invite.expiresAt && invite.expiresAt < new Date()) throw notFound("Срок приглашения истёк");
  const provided = Buffer.from(hashSecret(secret));
  const expected = Buffer.from(invite.tokenHash);
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    throw notFound("Приглашение недействительно");
  }
  const space = await prisma.cloudSpace.findFirst({ where: { id: invite.spaceId, deletedAt: null } });
  if (!space) throw notFound("Space не найден");
  return { invite, space };
}

// ── Публичные ссылки ─────────────────────────────────────────────────────────

const shareSchema = z.object({
  spaceId: z.string().min(1),
  targetType: z.enum(["SPACE", "FOLDER", "FILE", "SELECTION"]),
  targetId: z.string().min(1).nullable().optional(),
  fileIds: z.array(z.string().min(1)).max(2000).optional(),
  allowPreview: z.boolean().default(true),
  allowDownload: z.boolean().default(true),
  expiresInHours: z.number().int().min(1).max(24 * 365 * 5).nullable().optional(),
  password: z.string().min(4).max(128).nullable().optional(),
  label: z.string().trim().max(120).optional(),
});

router.post(
  "/shares",
  ah(async (req: Request, res) => {
    const parsed = shareSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw invalid("Некорректные параметры ссылки");
    const d = parsed.data;
    const access = await requireSpaceAccess(req, d.spaceId, "shares:manage");

    // Цель обязана лежать внутри этого Space — иначе ссылкой можно было бы
    // «поделиться» чужим файлом, подставив его id.
    if (d.targetType === "FOLDER") {
      if (!d.targetId) throw invalid("Не указана папка");
      const folder = await prisma.cloudFolder.findFirst({ where: { id: d.targetId, spaceId: access.space.id, deletedAt: null } });
      if (!folder) throw notFound("Папка не найдена");
    }
    if (d.targetType === "FILE") {
      if (!d.targetId) throw invalid("Не указан файл");
      const file = await prisma.cloudFile.findFirst({ where: { id: d.targetId, spaceId: access.space.id, deletedAt: null } });
      if (!file) throw notFound("Файл не найден");
    }
    let fileIds: string[] = [];
    if (d.targetType === "SELECTION") {
      const rows = await prisma.cloudFile.findMany({
        where: { id: { in: d.fileIds ?? [] }, spaceId: access.space.id, deletedAt: null },
        select: { id: true },
      });
      fileIds = rows.map((r) => r.id);
      if (fileIds.length === 0) throw invalid("Выбор пуст");
    }

    const secret = newSecret();
    const share = await prisma.cloudShareLink.create({
      data: {
        spaceId: access.space.id,
        targetType: d.targetType,
        targetId: d.targetType === "SELECTION" || d.targetType === "SPACE" ? null : d.targetId ?? null,
        fileIds,
        tokenHash: hashSecret(secret),
        publicId: publicId(),
        allowPreview: d.allowPreview,
        allowDownload: d.allowDownload,
        passwordHash: d.password ? await bcrypt.hash(d.password, 12) : null,
        expiresAt: d.expiresInHours ? new Date(Date.now() + d.expiresInHours * 3600_000) : null,
        createdById: req.cloudUser!.id,
        label: d.label ?? null,
      },
    });

    await recordActivity(access.space.id, req.cloudUser!.id, "SHARE_CREATED", { targetType: d.targetType });
    await writeAudit(req, "SHARE_CREATED", {
      spaceId: access.space.id,
      targetId: share.id,
      detail: { targetType: d.targetType, allowDownload: d.allowDownload, hasPassword: Boolean(d.password) },
    });
    res.status(201).json({
      share: shareDto(share),
      // Секрет во фрагменте: он не уходит в HTTP-запросе, не пишется в логи
      // nginx и не утекает через Referer.
      url: `${baseUrl(req)}/cloud/s/${share.publicId}#t=${secret}`,
    });
  })
);

router.get(
  "/shares",
  ah(async (req: Request, res) => {
    const spaceId = String(req.query.spaceId ?? "");
    if (!spaceId) throw invalid("Нужен spaceId");
    const access = await requireSpaceAccess(req, spaceId, "shares:manage");
    const shares = await prisma.cloudShareLink.findMany({
      where: { spaceId: access.space.id, revokedAt: null },
      orderBy: { createdAt: "desc" },
    });
    res.json({ shares: shares.map(shareDto) });
  })
);

const shareUpdateSchema = z.object({
  allowPreview: z.boolean().optional(),
  allowDownload: z.boolean().optional(),
  expiresInHours: z.number().int().min(1).max(24 * 365 * 5).nullable().optional(),
  label: z.string().trim().max(120).nullable().optional(),
});

router.patch(
  "/shares/:id",
  ah(async (req: Request, res) => {
    const share = await prisma.cloudShareLink.findUnique({ where: { id: String(req.params.id) } });
    if (!share || share.revokedAt) throw notFound("Ссылка не найдена");
    await requireSpaceAccess(req, share.spaceId, "shares:manage");
    const parsed = shareUpdateSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw invalid("Некорректные поля");
    const updated = await prisma.cloudShareLink.update({
      where: { id: share.id },
      data: {
        ...(parsed.data.allowPreview !== undefined ? { allowPreview: parsed.data.allowPreview } : {}),
        ...(parsed.data.allowDownload !== undefined ? { allowDownload: parsed.data.allowDownload } : {}),
        ...(parsed.data.label !== undefined ? { label: parsed.data.label } : {}),
        ...(parsed.data.expiresInHours !== undefined
          ? { expiresAt: parsed.data.expiresInHours ? new Date(Date.now() + parsed.data.expiresInHours * 3600_000) : null }
          : {}),
      },
    });
    res.json({ share: shareDto(updated) });
  })
);

/** Отзыв действует немедленно: активные share-сессии тоже перестают работать. */
router.delete(
  "/shares/:id",
  ah(async (req: Request, res) => {
    const share = await prisma.cloudShareLink.findUnique({ where: { id: String(req.params.id) } });
    if (!share) throw notFound("Ссылка не найдена");
    await requireSpaceAccess(req, share.spaceId, "shares:manage");
    await prisma.cloudShareLink.update({ where: { id: share.id }, data: { revokedAt: new Date() } });
    await recordActivity(share.spaceId, req.cloudUser!.id, "SHARE_REVOKED", {});
    await writeAudit(req, "SHARE_REVOKED", { spaceId: share.spaceId, targetId: share.id });
    res.json({ ok: true });
  })
);

function shareDto(share: {
  id: string;
  publicId: string;
  targetType: string;
  targetId: string | null;
  fileIds: string[];
  allowPreview: boolean;
  allowDownload: boolean;
  passwordHash: string | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  viewCount: number;
  downloadCount: number;
  label: string | null;
}) {
  return {
    id: share.id,
    publicId: share.publicId,
    targetType: share.targetType,
    targetId: share.targetId,
    fileCount: share.fileIds.length,
    allowPreview: share.allowPreview,
    allowDownload: share.allowDownload,
    hasPassword: Boolean(share.passwordHash),
    expiresAt: share.expiresAt,
    revokedAt: share.revokedAt,
    createdAt: share.createdAt,
    viewCount: share.viewCount,
    downloadCount: share.downloadCount,
    label: share.label,
    // Ссылку целиком отдать невозможно: секрета у нас нет. Клиент показывает
    // только «создано» и предлагает выпустить новую, если старая потерялась.
    path: `/cloud/s/${share.publicId}`,
  };
}

export default router;
