import type { CloudSpace, CloudSpaceRole } from "@prisma/client";
import prisma from "../lib/prisma";
import { forbidden, notFound } from "./errors";
import { writeAudit } from "./audit";
import type { Request } from "express";

/**
 * Централизованная авторизация. Ни один route-handler не решает сам, кому что
 * можно: он спрашивает requireSpaceAccess(...). UUID никогда не считается
 * доказательством прав — членство проверяется по БД на каждое действие.
 */
export type CloudAction =
  | "space:view"
  | "space:update"
  | "space:delete"
  | "members:manage"
  | "invites:manage"
  | "shares:manage"
  | "file:upload"
  | "file:update"
  | "file:delete"
  | "file:restore"
  | "file:download"
  | "folder:manage"
  | "comment:create"
  | "comment:moderate"
  | "reaction:toggle";

export type SpaceAccess = {
  space: CloudSpace;
  role: CloudSpaceRole;
  userId: string;
};

const OWNER_ONLY = new Set<CloudAction>([
  "space:delete",
  "members:manage",
  "invites:manage",
  "shares:manage",
  "comment:moderate",
]);

const EDITOR_PLUS = new Set<CloudAction>([
  "space:update",
  "file:upload",
  "file:update",
  "file:delete",
  "file:restore",
  "folder:manage",
]);

export function can(role: CloudSpaceRole, action: CloudAction, space: Pick<CloudSpace, "viewerCanComment">): boolean {
  if (role === "OWNER") return true;
  if (OWNER_ONLY.has(action)) return false;
  if (role === "EDITOR") return true;
  // VIEWER
  switch (action) {
    case "space:view":
    case "file:download":
      return true;
    case "comment:create":
    case "reaction:toggle":
      return space.viewerCanComment;
    default:
      return false;
  }
}

export async function getSpaceAccess(userId: string, spaceId: string): Promise<SpaceAccess | null> {
  const space = await prisma.cloudSpace.findFirst({ where: { id: spaceId, deletedAt: null } });
  if (!space) return null;
  if (space.ownerId === userId) return { space, role: "OWNER", userId };
  const member = await prisma.cloudSpaceMember.findUnique({
    where: { spaceId_userId: { spaceId, userId } },
    select: { role: true },
  });
  if (!member) return null;
  return { space, role: member.role, userId };
}

/**
 * Единственная точка входа для проверки прав на Space.
 * Отсутствие членства отдаём как 404, чтобы не подтверждать существование Space.
 */
export async function requireSpaceAccess(
  req: Request,
  spaceId: string,
  action: CloudAction
): Promise<SpaceAccess> {
  const user = req.cloudUser;
  if (!user) throw forbidden();
  const access = await getSpaceAccess(user.id, spaceId);
  if (!access) throw notFound("Хуяпка не найдена");
  if (!can(access.role, action, access.space)) {
    void writeAudit(req, "PERMISSION_DENIED", {
      spaceId,
      detail: { action, role: access.role },
    });
    throw forbidden(`Роль ${access.role} не может выполнить это действие`);
  }
  return access;
}

/** Файл + проверка прав на его Space одним шагом. */
export async function requireFileAccess(
  req: Request,
  fileId: string,
  action: CloudAction,
  opts: { includeDeleted?: boolean } = {}
) {
  const file = await prisma.cloudFile.findUnique({ where: { id: fileId } });
  if (!file) throw notFound("Файл не найден");
  if (file.deletedAt && !opts.includeDeleted) throw notFound("Файл не найден");
  const access = await requireSpaceAccess(req, file.spaceId, action);
  return { file, access };
}

/** Список id доступных пользователю Space (владелец + участник). */
export async function listAccessibleSpaceIds(userId: string): Promise<string[]> {
  const [owned, member] = await Promise.all([
    prisma.cloudSpace.findMany({ where: { ownerId: userId, deletedAt: null }, select: { id: true } }),
    prisma.cloudSpaceMember.findMany({ where: { userId }, select: { spaceId: true } }),
  ]);
  return Array.from(new Set([...owned.map((s) => s.id), ...member.map((m) => m.spaceId)]));
}
