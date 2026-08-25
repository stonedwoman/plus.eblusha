import type { Server } from "socket.io";

// Сокеты мессенджера типизированы своими событиями; namespace Cloud живёт рядом,
// поэтому принимаем Server как есть и храним пользователя в socket.data.
type AnyServer = Server<any, any, any, any>;
import logger from "../config/logger";
import { createDedicatedRedisClient, getRedisClient } from "../lib/redis";
import prisma from "../lib/prisma";
import { getSpaceAccess } from "./acl";
import { parseSessionIdFromCookieHeader, readCloudSession } from "./auth/session";

/**
 * Realtime поверх существующего Socket.IO + Redis-адаптера. Отдельный namespace
 * /cloud, чтобы не смешиваться с событиями мессенджера.
 *
 * Комнаты: user:<userId> (личные события), space:<spaceId> (общие).
 * Через сокет ходит ТОЛЬКО состояние — никаких файлов.
 *
 * Медиа-воркер живёт в отдельном процессе, поэтому события он публикует в
 * Redis-канал, а серверный процесс их ретранслирует (тот же приём, что и у
 * MESSAGE_UPDATE_CHANNEL в мессенджере).
 */
export const CLOUD_EVENT_CHANNEL = "cloud:events";
const PRESENCE_TTL_SECONDS = 75;

export type CloudEventName =
  | "cloud.upload.updated"
  | "cloud.file.created"
  | "cloud.file.processing"
  | "cloud.file.ready"
  | "cloud.file.updated"
  | "cloud.file.deleted"
  | "cloud.file.restored"
  | "cloud.comment.created"
  | "cloud.comment.updated"
  | "cloud.comment.deleted"
  | "cloud.reaction.changed"
  | "cloud.member.joined"
  | "cloud.member.left"
  | "cloud.presence.changed"
  | "cloud.activity.created"
  | "cloud.space.updated"
  | "cloud.folder.changed"
  | "cloud.storage.updated";

type CloudEnvelope = {
  event: CloudEventName;
  rooms: string[];
  payload: unknown;
};

export const spaceRoom = (spaceId: string) => `space:${spaceId}`;
export const userRoom = (userId: string) => `user:${userId}`;

let namespaceRef: ReturnType<AnyServer["of"]> | null = null;

/** Публикация события. Работает и из backend, и из cloud-worker. */
export async function emitCloud(event: CloudEventName, rooms: string[], payload: unknown): Promise<void> {
  if (rooms.length === 0) return;
  try {
    const redis = await getRedisClient();
    await redis.publish(CLOUD_EVENT_CHANNEL, JSON.stringify({ event, rooms, payload } satisfies CloudEnvelope));
  } catch (err) {
    logger.warn({ err, event }, "cloud realtime publish failed");
  }
}

export function emitCloudSync(event: CloudEventName, rooms: string[], payload: unknown): void {
  void emitCloud(event, rooms, payload);
}

async function presenceSnapshot(spaceId: string): Promise<{ userId: string; since: number }[]> {
  const redis = await getRedisClient();
  const key = `cloud:presence:${spaceId}`;
  const cutoff = Date.now() - PRESENCE_TTL_SECONDS * 1000;
  await redis.zRemRangeByScore(key, 0, cutoff);
  const raw = await redis.zRangeWithScores(key, 0, -1);
  return raw.map((r) => ({ userId: r.value, since: Number(r.score) }));
}

async function markPresent(spaceId: string, userId: string): Promise<void> {
  const redis = await getRedisClient();
  const key = `cloud:presence:${spaceId}`;
  await redis.zAdd(key, [{ score: Date.now(), value: userId }]);
  await redis.expire(key, PRESENCE_TTL_SECONDS * 4);
}

async function clearPresence(spaceId: string, userId: string): Promise<void> {
  const redis = await getRedisClient();
  await redis.zRem(`cloud:presence:${spaceId}`, userId);
}

export async function initCloudRealtime(io: AnyServer): Promise<void> {
  const nsp = io.of("/cloud");
  namespaceRef = nsp;

  nsp.use(async (socket, next) => {
    try {
      const sid = parseSessionIdFromCookieHeader(socket.handshake.headers.cookie);
      if (!sid) return next(new Error("unauthorized"));
      const record = await readCloudSession(sid);
      if (!record) return next(new Error("unauthorized"));
      const user = await prisma.user.findUnique({
        where: { id: record.userId },
        select: { id: true, username: true, displayName: true, avatarUrl: true, bannedAt: true, deletedAt: true },
      });
      if (!user || user.deletedAt || user.bannedAt) return next(new Error("unauthorized"));
      (socket.data as Record<string, unknown>).cloudUser = {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
      };
      next();
    } catch (err) {
      next(err as Error);
    }
  });

  nsp.on("connection", (socket) => {
    const user = socket.data.cloudUser as { id: string; username: string; displayName: string | null; avatarUrl: string | null };
    void socket.join(userRoom(user.id));
    const joined = new Set<string>();

    const leaveSpace = async (spaceId: string) => {
      if (!joined.has(spaceId)) return;
      joined.delete(spaceId);
      await socket.leave(spaceRoom(spaceId));
      // Если у пользователя открыты ещё вкладки этого Space — присутствие сохраняем.
      const sockets = await nsp.in(spaceRoom(spaceId)).fetchSockets();
      const stillHere = sockets.some((s) => (s.data.cloudUser as { id: string } | undefined)?.id === user.id);
      if (!stillHere) {
        await clearPresence(spaceId, user.id);
        void emitCloud("cloud.presence.changed", [spaceRoom(spaceId)], {
          spaceId,
          users: await presenceSnapshot(spaceId),
        });
      }
    };

    socket.on("space:join", async (spaceId: unknown, ack?: (r: unknown) => void) => {
      try {
        if (typeof spaceId !== "string" || !spaceId) return;
        const access = await getSpaceAccess(user.id, spaceId);
        if (!access) {
          ack?.({ ok: false });
          return;
        }
        joined.add(spaceId);
        await socket.join(spaceRoom(spaceId));
        await markPresent(spaceId, user.id);
        const users = await presenceSnapshot(spaceId);
        void emitCloud("cloud.presence.changed", [spaceRoom(spaceId)], { spaceId, users });
        ack?.({ ok: true, users });
      } catch (err) {
        logger.warn({ err }, "cloud space:join failed");
        ack?.({ ok: false });
      }
    });

    socket.on("space:leave", (spaceId: unknown) => {
      if (typeof spaceId === "string") void leaveSpace(spaceId);
    });

    socket.on("presence:ping", async () => {
      for (const spaceId of joined) await markPresent(spaceId, user.id);
    });

    socket.on("disconnect", () => {
      for (const spaceId of Array.from(joined)) void leaveSpace(spaceId);
    });
  });

  // Мост Redis → Socket.IO: события от cloud-worker и от других инстансов.
  const sub = await createDedicatedRedisClient();
  await sub.subscribe(CLOUD_EVENT_CHANNEL, (raw) => {
    try {
      const env = JSON.parse(raw || "{}") as CloudEnvelope;
      if (!env.event || !Array.isArray(env.rooms)) return;
      // Канал слушает КАЖДЫЙ инстанс, поэтому рассылаем строго локальным сокетам:
      // обычный nsp.to() ушёл бы через Redis-адаптер на все инстансы и продублировал
      // событие столько раз, сколько их запущено.
      nsp.local.to(env.rooms).emit(env.event, env.payload);
    } catch (err) {
      logger.warn({ err }, "cloud realtime bridge parse failed");
    }
  });

  logger.info("Eblusha Cloud realtime namespace /cloud ready");
}

export function getCloudNamespace() {
  return namespaceRef;
}

export async function getSpacePresence(spaceId: string) {
  return presenceSnapshot(spaceId);
}
