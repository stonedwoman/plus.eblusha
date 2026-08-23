import type { Request } from "express";
import prisma from "../lib/prisma";
import logger from "../config/logger";

export type CloudAuditAction =
  | "LOGIN"
  | "SPACE_CREATED"
  | "SPACE_DELETED"
  | "MEMBER_ADDED"
  | "MEMBER_REMOVED"
  | "MEMBER_ROLE_CHANGED"
  | "FILE_UPLOADED"
  | "FILE_DELETED"
  | "FILE_RESTORED"
  | "FILE_PURGED"
  | "FILE_SAVED"
  | "SHARE_CREATED"
  | "SHARE_REVOKED"
  | "SHARE_OPENED"
  | "INVITE_CREATED"
  | "INVITE_REVOKED"
  | "INVITE_ACCEPTED"
  | "PERMISSION_DENIED";

/**
 * Аудит значимых действий — отдельно от debug-логов.
 * Секреты (share-токены, куки, пароли) сюда не попадают by design: наружу
 * пишем только идентификаторы и счётчики.
 */
export async function writeAudit(
  req: Request | null,
  action: CloudAuditAction,
  opts: {
    actorId?: string | null;
    spaceId?: string | null;
    targetId?: string | null;
    detail?: Record<string, unknown>;
  } = {}
): Promise<void> {
  try {
    const actorId = opts.actorId ?? (req as { cloudUser?: { id: string } } | null)?.cloudUser?.id ?? null;
    await prisma.cloudAuditEvent.create({
      data: {
        action,
        actorId,
        spaceId: opts.spaceId ?? null,
        targetId: opts.targetId ?? null,
        ip: req?.ip ? String(req.ip).slice(0, 64) : null,
        detail: (opts.detail ?? undefined) as never,
      },
    });
  } catch (err) {
    // Аудит не должен ронять пользовательскую операцию.
    logger.warn({ err, action }, "cloud audit write failed");
  }
}
