import crypto from "node:crypto";
import prisma from "./prisma";
import { kickUser } from "../realtime/socket";
import logger from "../config/logger";

export type AdminUserRow = {
  id: string;
  username: string;
  displayName: string | null;
  email: string | null;
  eblid: string | null;
  createdAt: string;
  lastSeenAt: string | null;
  effectiveLastSeenAt: string | null;
  status: string;
  bannedAt: string | null;
  bannedReason: string | null;
  deletedAt: string | null;
  deviceCount: number;
  activeDeviceCount: number;
  lastIp: string | null;
  lastCity: string | null;
  lastCountry: string | null;
  lastDeviceSeenAt: string | null;
};

function maxDate(a: Date | null | undefined, b: Date | null | undefined): Date | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return a.getTime() >= b.getTime() ? a : b;
}

function toIso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

export async function listAdminUsers(opts: {
  search?: string;
  limit: number;
  offset: number;
}): Promise<{ total: number; users: AdminUserRow[] }> {
  const search = opts.search?.trim() ?? "";
  const where = search
    ? {
        OR: [
          { username: { contains: search, mode: "insensitive" as const } },
          { displayName: { contains: search, mode: "insensitive" as const } },
          { email: { contains: search, mode: "insensitive" as const } },
          { eblid: { contains: search, mode: "insensitive" as const } },
          { id: { equals: search } },
        ],
      }
    : {};

  const [total, users] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where,
      select: {
        id: true,
        username: true,
        displayName: true,
        email: true,
        eblid: true,
        createdAt: true,
        lastSeenAt: true,
        status: true,
        bannedAt: true,
        bannedReason: true,
        deletedAt: true,
        devices: {
          select: {
            lastSeenAt: true,
            revokedAt: true,
            lastIp: true,
            lastCity: true,
            lastCountry: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
      take: opts.limit,
      skip: opts.offset,
    }),
  ]);

  const rows: AdminUserRow[] = users.map((u) => {
    let devicesMax: Date | null = null;
    let lastDevice: {
      lastSeenAt: Date | null;
      lastIp: string | null;
      lastCity: string | null;
      lastCountry: string | null;
    } | null = null;
    let activeCount = 0;
    for (const d of u.devices) {
      if (!d.revokedAt) activeCount += 1;
      if (d.lastSeenAt && (!devicesMax || d.lastSeenAt.getTime() > devicesMax.getTime())) {
        devicesMax = d.lastSeenAt;
        lastDevice = {
          lastSeenAt: d.lastSeenAt,
          lastIp: d.lastIp ?? null,
          lastCity: d.lastCity ?? null,
          lastCountry: d.lastCountry ?? null,
        };
      }
    }
    const effective = maxDate(u.lastSeenAt, devicesMax);
    return {
      id: u.id,
      username: u.username,
      displayName: u.displayName ?? null,
      email: u.email ?? null,
      eblid: u.eblid ?? null,
      createdAt: u.createdAt.toISOString(),
      lastSeenAt: toIso(u.lastSeenAt),
      effectiveLastSeenAt: toIso(effective),
      status: String(u.status ?? "OFFLINE"),
      bannedAt: toIso(u.bannedAt),
      bannedReason: u.bannedReason ?? null,
      deletedAt: toIso(u.deletedAt),
      deviceCount: u.devices.length,
      activeDeviceCount: activeCount,
      lastIp: lastDevice?.lastIp ?? null,
      lastCity: lastDevice?.lastCity ?? null,
      lastCountry: lastDevice?.lastCountry ?? null,
      lastDeviceSeenAt: toIso(lastDevice?.lastSeenAt ?? null),
    };
  });
  return { total, users: rows };
}

export async function getAdminUserDetails(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      username: true,
      displayName: true,
      email: true,
      eblid: true,
      createdAt: true,
      lastSeenAt: true,
      status: true,
      bannedAt: true,
      bannedReason: true,
      deletedAt: true,
      bio: true,
      avatarUrl: true,
      phone: true,
      updatedAt: true,
      devices: {
        select: {
          id: true,
          name: true,
          platform: true,
          createdAt: true,
          lastSeenAt: true,
          revokedAt: true,
          lastIp: true,
          lastCity: true,
          lastCountry: true,
        },
        orderBy: { lastSeenAt: "desc" },
      },
    },
  });
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName ?? null,
    email: user.email ?? null,
    phone: user.phone ?? null,
    eblid: user.eblid ?? null,
    bio: user.bio ?? null,
    avatarUrl: user.avatarUrl ?? null,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
    lastSeenAt: toIso(user.lastSeenAt),
    status: String(user.status ?? "OFFLINE"),
    bannedAt: toIso(user.bannedAt),
    bannedReason: user.bannedReason ?? null,
    deletedAt: toIso(user.deletedAt),
    devices: user.devices.map((d) => ({
      id: d.id,
      name: d.name,
      platform: d.platform ?? null,
      createdAt: d.createdAt.toISOString(),
      lastSeenAt: toIso(d.lastSeenAt),
      revokedAt: toIso(d.revokedAt),
      lastIp: d.lastIp ?? null,
      lastCity: d.lastCity ?? null,
      lastCountry: d.lastCountry ?? null,
    })),
  };
}

export async function banUser(userId: string, reason: string | null) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!user) return null;
  const updated = await prisma.user.update({
    where: { id: userId },
    data: { bannedAt: new Date(), bannedReason: reason ?? null },
    select: { id: true, bannedAt: true, bannedReason: true },
  });
  // Revoke every refresh token + every device, then disconnect every socket of
  // this user across the cluster. After this, the only way back is unbanUser().
  await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date(), revocationReason: "admin_ban" },
  });
  await prisma.userDevice.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  try {
    kickUser(userId, { reason: "banned" });
  } catch (error) {
    logger.warn({ error, userId }, "kickUser failed during admin ban");
  }
  return updated;
}

export async function unbanUser(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, deletedAt: true },
  });
  if (!user) return null;
  if (user.deletedAt) {
    throw new Error("Cannot unban a deleted account");
  }
  return prisma.user.update({
    where: { id: userId },
    data: { bannedAt: null, bannedReason: null },
    select: { id: true, bannedAt: true },
  });
}

/**
 * "Soft delete" — anonymize PII, revoke every credential, mark deletedAt.
 *
 * We deliberately don't hard-delete the User row because messages, call
 * sessions, contacts and group conversations all reference it without
 * onDelete: Cascade. Hard delete would either fail with FK errors or wipe
 * shared chat history that other users still see.
 *
 * This matches the Telegram/Signal model: account vanishes from search +
 * can't log in, but messages stay readable for the other side.
 */
export async function softDeleteUser(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, deletedAt: true },
  });
  if (!user) return null;
  if (user.deletedAt) return user;

  const now = new Date();
  const tag = crypto.randomBytes(6).toString("hex");
  const tombstoneUsername = `deleted_${tag}`;
  // Hash a fresh random password so credential stuffing can't resurrect the row.
  const randomHash = "!" + crypto.randomBytes(32).toString("hex");

  await prisma.$transaction(async (tx) => {
    await tx.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: now, revocationReason: "admin_delete" },
    });
    await tx.userDevice.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: now },
    });
    await tx.user.update({
      where: { id: userId },
      data: {
        deletedAt: now,
        bannedAt: now,
        bannedReason: "account deleted by admin",
        username: tombstoneUsername,
        displayName: "Deleted account",
        email: null,
        phone: null,
        eblid: null,
        avatarUrl: null,
        bio: null,
        passwordHash: randomHash,
      },
    });
  });
  try {
    kickUser(userId, { reason: "deleted" });
  } catch (error) {
    logger.warn({ error, userId }, "kickUser failed during admin delete");
  }
  return { id: userId, deletedAt: now };
}
