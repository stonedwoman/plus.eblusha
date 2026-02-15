import type { Server as HttpServer } from "http";
import { Server } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import prisma from "../lib/prisma";
import env from "../config/env";
import { createDedicatedRedisClient, getRedisClient } from "../lib/redis";
import { MESSAGE_UPDATE_CHANNEL } from "./events";
import { verifyAccessToken } from "../utils/jwt";
import logger from "../config/logger";
import { decGauge, incGauge } from "../obs/metrics";

type PresenceGame = {
  discordAppId: string;
  name: string;
  steamAppId?: string | number;
  startedAt: number;
  imageUrl?: string | null;
};

type PresenceGameClearReason = "no_game" | "privacy_off";

type ServerToClientEvents = {
  "presence:update": (payload: { userId: string; status: string }) => void;
  "presence:game": (payload: { userId: string; ts: number; game: PresenceGame | null; reason?: PresenceGameClearReason }) => void;
  "presence:game:snapshot": (payload: { userId: string; ts: number; game: PresenceGame | null; reason?: PresenceGameClearReason }) => void;
  "presence:game:snapshot:batch": (payload: { items: { userId: string; ts: number; game: PresenceGame | null; reason?: PresenceGameClearReason }[] }) => void;
  "message:new": (payload: { conversationId: string; messageId: string; senderId: string; message?: any }) => void;
  "receipts:update": (payload: { conversationId: string; messageIds: string[] }) => void;
  "message:update": (payload: { conversationId: string; messageId: string; reason: string; message?: any }) => void;
  "message:notify": (payload: { conversationId: string; messageId: string; senderId: string; message?: any }) => void;
  "message:reaction": (payload: { conversationId: string; messageId: string; senderId: string }) => void;
  "availability:updated": (payload: { conversationId: string; userId: string }) => void;
  "availability:proposals:updated": (payload: { conversationId: string; proposalId?: string }) => void;
  "contacts:removed": (payload: { contactId: string }) => void;
  "profile:update": (payload: { userId: string; avatarUrl?: string | null; displayName?: string | null }) => void;
  "conversation:typing": (payload: {
    conversationId: string;
    userId: string;
    typing: boolean;
  }) => void;
  "contacts:request:new": (payload: { contactId: string; from: { id: string; username: string } }) => void;
  "contacts:request:accepted": (payload: { contactId: string }) => void;
  "contacts:request:blocked": (payload: { contactId: string }) => void;
  "conversations:new": (payload: { conversationId: string }) => void;
  "conversations:updated": (payload: { conversationId: string; conversation?: any }) => void;
  "conversations:deleted": (payload: { conversationId: string }) => void;
  "call:incoming": (payload: { conversationId: string; from: { id: string; name: string }; video: boolean }) => void;
  "call:accepted": (payload: { conversationId: string; by: { id: string }; video: boolean }) => void;
  "call:declined": (payload: { conversationId: string; by: { id: string } }) => void;
  "call:ended": (payload: { conversationId: string; by: { id: string } }) => void;
  "call:status": (payload: { conversationId: string; active: boolean; startedAt?: number; elapsedMs?: number; participants?: string[] }) => void;
  "call:status:bulk": (payload: { statuses: Record<string, { active: boolean; startedAt?: number; elapsedMs?: number; participants?: string[] }> }) => void;
  "secret:chat:offer": (payload: { conversationId: string; from: { id: string; name: string; deviceId?: string | null } }) => void;
  "secret:chat:accepted": (payload: { conversationId: string; peerDeviceId: string }) => void;
};

type ClientToServerEvents = {
  "conversation:join": (conversationId: string) => void;
  "conversation:leave": (conversationId: string) => void;
  "conversation:typing": (payload: { conversationId: string; typing: boolean }) => void;
  "call:invite": (payload: { conversationId: string; video: boolean }) => void;
  "call:accept": (payload: { conversationId: string; video: boolean }) => void;
  "call:decline": (payload: { conversationId: string }) => void;
  "call:end": (payload: { conversationId: string }) => void;
  "call:room:join": (payload: { conversationId: string; video?: boolean }) => void;
  "call:room:leave": (payload: { conversationId: string }) => void;
  "call:status:request": (payload: { conversationIds: string[] }) => void;
  "secret:chat:offer": (payload: { conversationId: string }) => void;
  "secret:chat:accept": (payload: { conversationId: string; deviceId: string }) => void;
  "secret:chat:decline": (payload: { conversationId: string }) => void;
  "presence:focus": (payload: { focused: boolean }) => void;
  "presence:game:update": (payload: { game: PresenceGame }) => void;
  "presence:game:clear": (payload: { reason: PresenceGameClearReason }) => void;
  "presence:game:subscribe": (payload: { peerUserId: string }) => void;
  "presence:game:hello": (payload: { openPeers: string[] }) => void;
};

type InterServerEvents = Record<string, never>;
type SocketData = { userId: string; deviceId?: string };

const userRoom = (userId: string) => `user:${userId}`;
const deviceRoom = (deviceId: string) => `device:${deviceId}`;

const PRESENCE_TTL_SECONDS = 90;
const PRESENCE_HEARTBEAT_MS = 27_000;
const TYPING_TTL_SECONDS = 8;

async function writePresenceRedis(userId: string, status: string) {
  try {
    const redis = await getRedisClient();
    const key = `presence:${userId}`;
    if (status === "OFFLINE") {
      await redis.del(key);
    } else {
      await redis.set(key, status, { EX: PRESENCE_TTL_SECONDS });
    }
  } catch {
    // ignore redis failures (presence is best-effort)
  }
}

async function writeTypingRedis(conversationId: string, userId: string, typing: boolean) {
  try {
    const redis = await getRedisClient();
    const key = `typing:${conversationId}:${userId}`;
    if (typing) {
      await redis.set(key, "1", { EX: TYPING_TTL_SECONDS });
    } else {
      await redis.del(key);
    }
  } catch {
    // ignore redis failures
  }
}

function parseHandshakeDeviceId(handshake: any): string | null {
  const raw = handshake?.auth && typeof handshake.auth === "object" ? (handshake.auth as any).deviceId : undefined;
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  if (!v) return null;
  if (v.length > 128) return null;
  return v;
}

function parseHandshakeDeviceIdFromQueryDevOnly(handshake: any): string | null {
  // Security: query params are not a trusted source of truth. This is a dev-only escape hatch.
  if (env.NODE_ENV !== "development") return null;
  if (!env.ALLOW_DEVICE_QUERY) return null;
  const raw = handshake?.query && typeof handshake.query === "object" ? (handshake.query as any).deviceId : undefined;
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  if (!v) return null;
  if (v.length > 128) return null;
  return v;
}

async function resolveDeviceId(socket: any, userId: string, jwtDid: string | null): Promise<string | null> {
  const candidates: Array<{ source: string; deviceId: string }> = [];
  if (jwtDid) candidates.push({ source: "jwt.did", deviceId: jwtDid });

  const fromAuth = parseHandshakeDeviceId(socket.handshake);
  if (fromAuth) candidates.push({ source: "handshake.auth.deviceId", deviceId: fromAuth });

  const fromQueryDev = parseHandshakeDeviceIdFromQueryDevOnly(socket.handshake);
  if (fromQueryDev) candidates.push({ source: "handshake.query.deviceId(dev_only)", deviceId: fromQueryDev });

  for (const c of candidates) {
    try {
      const device = await prisma.userDevice.findUnique({
        where: { id: c.deviceId },
        select: { id: true, userId: true, revokedAt: true },
      });
      if (!device || device.userId !== userId || device.revokedAt) {
        logger.warn({ userId, deviceId: c.deviceId, source: c.source }, "Socket deviceId rejected");
        continue;
      }
      return c.deviceId;
    } catch (error) {
      logger.warn({ error, userId, deviceId: c.deviceId, source: c.source }, "Socket deviceId verification failed");
      continue;
    }
  }
  return null;
}

let ioInstance: Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData> | null = null;
// Track call state per conversation to detect missed calls
const callState: Map<string, { inviterId: string; accepted: boolean; video: boolean; startedAt?: number }> = new Map();
type ActiveCallInfo = { startedAt: number; participantsByUser: Map<string, Set<string>> };
// Track active group calls: conversationId -> { startedAt: number, participantsByUser: Map<userId, Set<socketId>> }
const activeGroupCalls: Map<string, ActiveCallInfo> = new Map();
// Track active direct calls (1:1): conversationId -> { startedAt: number, participantsByUser: Map<userId, Set<socketId>> }
const activeDirectCalls: Map<string, ActiveCallInfo> = new Map();
let statusInterval: NodeJS.Timeout | null = null;

type PresenceStatus = "ONLINE" | "OFFLINE" | "BACKGROUND";
type BroadcastPresenceStatus = PresenceStatus | "IN_CALL";

const socketFocusByUser: Map<string, Map<string, boolean>> = new Map();
const persistedPresenceByUser: Map<string, PresenceStatus> = new Map();
const broadcastedPresenceByUser: Map<string, BroadcastPresenceStatus> = new Map();
const presenceUpdateQueue: Map<string, Promise<void>> = new Map();
const lastPresenceDbWriteAtByUser: Map<string, number> = new Map();
const PRESENCE_DB_MIN_INTERVAL_MS = 2 * 60 * 1000;

const PRESENCE_GAME_TTL_MS = 60_000;
const presenceGameByUser: Map<string, { game: PresenceGame; ts: number; timeout: NodeJS.Timeout }> = new Map();

function broadcastPresenceGame(io: Server, payload: { userId: string; ts: number; game: PresenceGame | null; reason?: PresenceGameClearReason }) {
  io.emit("presence:game", payload);
}

function getPresenceGameSnapshotPayload(userId: string): { userId: string; ts: number; game: PresenceGame | null; reason?: PresenceGameClearReason } {
  const entry = presenceGameByUser.get(userId);
  if (!entry) return { userId, ts: Date.now(), game: null, reason: "no_game" };
  // Lazy TTL enforcement (defense-in-depth): prevent returning stale presence if timer didn't fire.
  const age = Date.now() - entry.ts;
  if (age > PRESENCE_GAME_TTL_MS) {
    try { clearTimeout(entry.timeout); } catch {}
    presenceGameByUser.delete(userId);
    return { userId, ts: Date.now(), game: null, reason: "no_game" };
  }
  return { userId, ts: entry.ts, game: entry.game };
}

function setPresenceGame(io: Server, userId: string, game: PresenceGame) {
  const ts = Date.now();
  const prev = presenceGameByUser.get(userId);
  if (prev) clearTimeout(prev.timeout);
  const timeout = setTimeout(() => {
    const cur = presenceGameByUser.get(userId);
    if (!cur) return;
    // Only expire the latest update we scheduled.
    if (cur.ts !== ts) return;
    presenceGameByUser.delete(userId);
    broadcastPresenceGame(io, { userId, ts: Date.now(), game: null, reason: "no_game" });
  }, PRESENCE_GAME_TTL_MS);
  presenceGameByUser.set(userId, { game, ts, timeout });
  broadcastPresenceGame(io, { userId, ts, game });
}

function clearPresenceGame(io: Server, userId: string, reason: PresenceGameClearReason) {
  const prev = presenceGameByUser.get(userId);
  if (prev) clearTimeout(prev.timeout);
  presenceGameByUser.delete(userId);
  broadcastPresenceGame(io, { userId, ts: Date.now(), game: null, reason });
}

function addAllCurrentSockets(info: ActiveCallInfo, userId: string) {
  const sockets = socketFocusByUser.get(userId);
  if (!sockets || sockets.size === 0) return;
  for (const socketId of sockets.keys()) {
    addParticipant(info, userId, socketId);
  }
}

function addParticipant(info: ActiveCallInfo, userId: string, socketId: string) {
  const existing = info.participantsByUser.get(userId) ?? new Set<string>();
  existing.add(socketId);
  info.participantsByUser.set(userId, existing);
}

function removeParticipant(info: ActiveCallInfo, userId: string, socketId: string) {
  const existing = info.participantsByUser.get(userId);
  if (!existing) return;
  existing.delete(socketId);
  if (existing.size === 0) {
    info.participantsByUser.delete(userId);
  } else {
    info.participantsByUser.set(userId, existing);
  }
}

function listParticipants(info: ActiveCallInfo): string[] {
  return Array.from(info.participantsByUser.keys());
}

function isUserInAnyCall(userId: string): boolean {
  for (const info of activeGroupCalls.values()) {
    if (info.participantsByUser.has(userId)) return true;
  }
  for (const info of activeDirectCalls.values()) {
    if (info.participantsByUser.has(userId)) return true;
  }
  return false;
}

function computeBroadcastPresence(userId: string, base: PresenceStatus): BroadcastPresenceStatus {
  if (base === "OFFLINE") return "OFFLINE";
  if (isUserInAnyCall(userId)) return "IN_CALL";
  return base;
}

function emitEffectivePresence(io: Server, userId: string, baseOverride?: PresenceStatus) {
  const base = baseOverride ?? (persistedPresenceByUser.get(userId) ?? computePresenceStatus(userId));
  const effective = computeBroadcastPresence(userId, base);
  const prev = broadcastedPresenceByUser.get(userId);
  if (prev === effective) return;
  if (effective === "OFFLINE") broadcastedPresenceByUser.delete(userId);
  else broadcastedPresenceByUser.set(userId, effective);
  io.emit("presence:update", { userId, status: effective });
}

function setSocketFocus(userId: string, socketId: string, focused: boolean) {
  const current = socketFocusByUser.get(userId) ?? new Map<string, boolean>();
  current.set(socketId, focused);
  socketFocusByUser.set(userId, current);
}

function removeSocketFocus(userId: string, socketId: string) {
  const current = socketFocusByUser.get(userId);
  if (!current) return;
  current.delete(socketId);
  if (current.size === 0) {
    socketFocusByUser.delete(userId);
  }
}

function computePresenceStatus(userId: string): PresenceStatus {
  const entries = socketFocusByUser.get(userId);
  if (!entries || entries.size === 0) return "OFFLINE";
  const hasFocused = Array.from(entries.values()).some(Boolean);
  return hasFocused ? "ONLINE" : "BACKGROUND";
}

async function persistPresence(io: Server, userId: string, status: PresenceStatus) {
  const previous = persistedPresenceByUser.get(userId);
  if (previous === status) return;

  // Keep in-memory base presence for realtime immediately.
  if (status === "OFFLINE") persistedPresenceByUser.delete(userId);
  else persistedPresenceByUser.set(userId, status);

  // Broadcast effective status (IN_CALL overrides base ONLINE/BACKGROUND) even if we skip DB write.
  emitEffectivePresence(io, userId, status);

  // Reduce Postgres writes: only persist on OFFLINE, on OFFLINE->ONLINE transitions,
  // or at most once per interval for ONLINE/BACKGROUND flips.
  const now = Date.now();
  const lastWriteAt = lastPresenceDbWriteAtByUser.get(userId) ?? 0;
  const shouldWrite =
    status === "OFFLINE" ||
    previous === undefined ||
    previous === "OFFLINE" ||
    now - lastWriteAt > PRESENCE_DB_MIN_INTERVAL_MS;
  if (!shouldWrite) return;

  const data: { status: PresenceStatus; lastSeenAt?: Date } = { status };
  if (status === "OFFLINE") data.lastSeenAt = new Date();

  try {
    await prisma.user.update({ where: { id: userId }, data });
    lastPresenceDbWriteAtByUser.set(userId, now);
  } catch (error) {
    logger.warn({ error, userId, status }, "Failed to persist presence state");
  }
}

function recomputePresence(io: Server, userId: string): Promise<void> {
  const previousTask = presenceUpdateQueue.get(userId) ?? Promise.resolve();
  const nextTask = previousTask
    .catch(() => {})
    .then(async () => {
      const status = computePresenceStatus(userId);
      void writePresenceRedis(userId, status);
      await persistPresence(io, userId, status);
    });
  presenceUpdateQueue.set(userId, nextTask);
  return nextTask.finally(() => {
    if (presenceUpdateQueue.get(userId) === nextTask) {
      presenceUpdateQueue.delete(userId);
    }
  });
}

export async function initSocket(
  server: HttpServer
): Promise<Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>> {
  const io = new Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>(server, {
    cors: {
      origin: env.CLIENT_URL ?? true,
      credentials: true,
    },
  });

  ioInstance = io;

  // Multi-instance Socket.IO: Redis adapter is required.
  const pubClient = await createDedicatedRedisClient();
  const subClient = pubClient.duplicate();
  subClient.on("error", (err) => {
    logger.error({ err }, "Redis (sub) error");
  });
  await subClient.connect();
  io.adapter(createAdapter(pubClient, subClient));
  logger.info({ redisUrl: env.REDIS_URL }, "Socket.IO Redis adapter enabled");

  // Bridge worker-originated message updates into Socket.IO rooms.
  const eventsSub = await createDedicatedRedisClient();
  await eventsSub.subscribe(MESSAGE_UPDATE_CHANNEL, (raw) => {
    try {
      const payload = JSON.parse(raw || "{}") as {
        conversationId?: string;
        messageId?: string;
        reason?: string;
        message?: unknown;
      };
      if (!payload.conversationId || !payload.messageId || !payload.reason) return;
      io.to(payload.conversationId).emit("message:update", {
        conversationId: payload.conversationId,
        messageId: payload.messageId,
        reason: payload.reason,
        ...(payload.message !== undefined ? { message: payload.message } : {}),
      });
    } catch {
      // ignore malformed payloads
    }
  });

  // Helper function to format time as "в HH:mm" in server's local timezone
  // Uses system timezone or TZ environment variable if set
  const formatTime = (date: Date = new Date()): string => {
    // Use toLocaleTimeString without timeZone to use system's local timezone
    // This respects TZ environment variable if set, otherwise uses system timezone
    const timeStr = date.toLocaleTimeString('ru-RU', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      // Don't specify timeZone - let it use system's local timezone
    });
    return `в ${timeStr}`;
  };

  // Helper function to broadcast call status to all conversation participants
  const broadcastCallStatus = (conversationId: string) => {
    const callInfo = activeGroupCalls.get(conversationId);
    const now = Date.now();
    
    if (callInfo) {
      const elapsedMs = now - callInfo.startedAt;
      const participants = listParticipants(callInfo);
      io.to(conversationId).emit("call:status", {
        conversationId,
        active: true,
        startedAt: callInfo.startedAt,
        elapsedMs,
        participants,
      });
      return;
    }

      // Звонок не активен
      io.to(conversationId).emit("call:status", {
        conversationId,
        active: false,
      });
  };

  // Периодически обновляем elapsedMs для активных звонков (каждую секунду)
  if (!statusInterval) {
    statusInterval = setInterval(() => {
      if (!io) return;
      for (const conversationId of activeGroupCalls.keys()) {
          broadcastCallStatus(conversationId);
      }
    }, 1000);
  }

  io.use(async (socket, next) => {
    try {
      const queryToken = ((): string | undefined => {
        const q = socket.handshake.query as Record<string, unknown> | undefined;
        const t = q?.token;
        if (typeof t === "string") return t;
        if (Array.isArray(t) && typeof t[0] === "string") return t[0];
        return undefined;
      })();

      const token = (socket.handshake.auth?.token as string | undefined) ?? queryToken;
      if (!token) {
        next(new Error("Unauthorized"));
        return;
      }

      const payload = verifyAccessToken<{ sub: string; did?: string }>(token);
      socket.data.userId = payload.sub;
      const did = typeof (payload as any).did === "string" ? ((payload as any).did as string).trim() : "";
      const verifiedDeviceId = await resolveDeviceId(socket, payload.sub, did ? did : null);
      if (verifiedDeviceId) socket.data.deviceId = verifiedDeviceId;
      next();
    } catch (error) {
      logger.warn({ error }, "Socket auth failed");
      next(new Error("Unauthorized"));
    }
  });

  io.on("connection", (socket) => {
    const userId = socket.data.userId;
    logger.info({ userId }, "Socket connected");
    // Join personal room to receive direct events
    socket.join(userRoom(userId));
    incGauge("sockets_connected", 1);
    setSocketFocus(userId, socket.id, true);
    void recomputePresence(io, userId);

    // Join device room if a verified deviceId is available (extension point for secret transport).
    const verifiedDeviceId = socket.data.deviceId;
    if (verifiedDeviceId) {
      socket.join(deviceRoom(verifiedDeviceId));
      logger.info({ userId, deviceId: verifiedDeviceId }, "Socket joined device room");
    }

    // Redis presence TTL heartbeat (ephemeral).
    const heartbeat = setInterval(() => {
      const status = computePresenceStatus(userId);
      void writePresenceRedis(userId, status);
    }, PRESENCE_HEARTBEAT_MS);
    // initial write
    void writePresenceRedis(userId, computePresenceStatus(userId));

    // Snapshot: if there are active calls right now, inform this socket so it can render "IN_CALL" immediately.
    try {
      const inCallUsers = new Set<string>();
      for (const info of activeGroupCalls.values()) {
        for (const uid of info.participantsByUser.keys()) inCallUsers.add(uid);
      }
      for (const info of activeDirectCalls.values()) {
        for (const uid of info.participantsByUser.keys()) inCallUsers.add(uid);
      }
      for (const uid of inCallUsers) {
        const base = persistedPresenceByUser.get(uid) ?? computePresenceStatus(uid);
        const effective = computeBroadcastPresence(uid, base);
        if (effective === "IN_CALL") {
          socket.emit("presence:update", { userId: uid, status: "IN_CALL" });
        }
      }
    } catch {
      // ignore snapshot failures
    }

    // Snapshot: send current "playing game" presences to the connecting socket.
    try {
      for (const [uid, entry] of presenceGameByUser.entries()) {
        socket.emit("presence:game", { userId: uid, ts: entry.ts, game: entry.game });
      }
    } catch {
      // ignore snapshot failures
    }

    // Проверяем активные звонки при подключении
    // Если пользователю звонили, пока он был офлайн, отправляем событие входящего звонка
    // Используем небольшую задержку, чтобы убедиться, что сокет полностью готов
    setTimeout(() => {
      void (async () => {
        try {
          // Получаем все беседы пользователя
          const conversations = await prisma.conversation.findMany({
            where: {
              participants: {
                some: { userId },
              },
            },
            include: {
              participants: true,
            },
          });

          for (const conv of conversations) {
            const callSt = callState.get(conv.id);
            if (!callSt) continue;
            
            // Если звонок еще не принят и пользователь не является инициатором
            if (!callSt.accepted && callSt.inviterId !== userId) {
              const isGroup = !!conv.isGroup;
              // Для 1:1 звонков отправляем событие входящего звонка
              if (!isGroup) {
                // Убеждаемся, что сокет присоединен к комнате беседы
                socket.join(conv.id);
                
                const inviter = await prisma.user.findUnique({
                  where: { id: callSt.inviterId },
                  select: { displayName: true, username: true },
                });
                const name = inviter?.displayName ?? inviter?.username ?? "пользователь";
                io.to(userRoom(userId)).emit("call:incoming", {
                  conversationId: conv.id,
                  from: { id: callSt.inviterId, name },
                  video: callSt.video,
                });
              }
            }
          }
        } catch (error) {
          logger.error({ error, userId }, "Failed to check active calls on connection");
        }
      })();
    }, 100);

    socket.on("presence:focus", ({ focused }) => {
      setSocketFocus(userId, socket.id, !!focused);
      void recomputePresence(io, userId);
    });

    socket.on("presence:game:update", ({ game }) => {
      try {
        if (!game || typeof game !== "object") return;
        if (process.env.DEBUG_GAME_PRESENCE === "1") {
          // eslint-disable-next-line no-console
          console.log("[presence_game] <- presence:game:update", JSON.stringify({ game }, null, 2));
        }
        const name = (game as any).name;
        const discordAppId = (game as any).discordAppId;
        const startedAt = (game as any).startedAt;
        if (typeof name !== "string" || name.trim().length === 0) return;
        if (typeof discordAppId !== "string" || discordAppId.trim().length === 0) return;
        if (typeof startedAt !== "number" || !Number.isFinite(startedAt)) return;
        // sanitize optional fields
        const steamAppIdRaw = (game as any).steamAppId;
        const steamAppId =
          typeof steamAppIdRaw === "string"
            ? steamAppIdRaw
            : typeof steamAppIdRaw === "number" && Number.isFinite(steamAppIdRaw)
              ? String(steamAppIdRaw)
              : undefined;
        const imageUrlRaw = (game as any).imageUrl;
        const imageUrl = typeof imageUrlRaw === "string" ? imageUrlRaw : (imageUrlRaw == null ? null : undefined);
        setPresenceGame(io, userId, {
          discordAppId: discordAppId.trim(),
          name: name.trim(),
          startedAt,
          ...(steamAppId ? { steamAppId: steamAppId.trim() } : {}),
          ...(imageUrl !== undefined ? { imageUrl } : {}),
        });
      } catch (error) {
        logger.warn({ error, userId }, "Failed to handle presence:game:update");
      }
    });

    socket.on("presence:game:clear", ({ reason }) => {
      const r: PresenceGameClearReason = reason === "privacy_off" ? "privacy_off" : "no_game";
      clearPresenceGame(io, userId, r);
    });

    // Game presence as state: allow clients to request snapshots when they are ready to consume them.
    socket.on("presence:game:subscribe", ({ peerUserId }) => {
      try {
        if (typeof peerUserId !== "string" || peerUserId.trim().length === 0) return;
        const uid = peerUserId.trim();
        const payload = getPresenceGameSnapshotPayload(uid);
        if (process.env.DEBUG_GAME_PRESENCE === "1") {
          // eslint-disable-next-line no-console
          console.log("[presence_game] <- presence:game:subscribe", JSON.stringify({ peerUserId: uid }, null, 2));
          // eslint-disable-next-line no-console
          console.log("[presence_game] -> presence:game:snapshot", JSON.stringify(payload, null, 2));
        }
        socket.emit("presence:game:snapshot", payload);
      } catch (error) {
        logger.warn({ error, userId }, "Failed to handle presence:game:subscribe");
      }
    });

    socket.on("presence:game:hello", ({ openPeers }) => {
      try {
        const peers = Array.isArray(openPeers) ? openPeers.filter((v) => typeof v === "string").map((v) => v.trim()).filter(Boolean) : [];
        const uniquePeers: string[] = [];
        const seen = new Set<string>();
        for (const p of peers) {
          if (seen.has(p)) continue;
          seen.add(p);
          uniquePeers.push(p);
          if (uniquePeers.length >= 50) break;
        }
        const items = uniquePeers.map((uid) => getPresenceGameSnapshotPayload(uid));
        if (process.env.DEBUG_GAME_PRESENCE === "1") {
          // eslint-disable-next-line no-console
          console.log("[presence_game] <- presence:game:hello", JSON.stringify({ openPeers: uniquePeers }, null, 2));
          // eslint-disable-next-line no-console
          console.log("[presence_game] -> presence:game:snapshot:batch", JSON.stringify({ items }, null, 2));
        }
        socket.emit("presence:game:snapshot:batch", { items });
      } catch (error) {
        logger.warn({ error, userId }, "Failed to handle presence:game:hello");
      }
    });

    socket.on("conversation:join", async (conversationId) => {
      const membership = await prisma.conversationParticipant.findFirst({
        where: { userId, conversationId },
      });
      if (!membership) {
        return;
      }
      socket.join(conversationId);
    });

    socket.on("conversation:leave", (conversationId) => {
      socket.leave(conversationId);
    });

    socket.on("conversation:typing", ({ conversationId, typing }) => {
      void writeTypingRedis(conversationId, userId, !!typing);
      socket
        .to(conversationId)
        .emit("conversation:typing", { conversationId, userId, typing });
    });

    socket.on("secret:chat:accept", async ({ conversationId, deviceId }) => {
      try {
        const conv = await prisma.conversation.findUnique({
          where: { id: conversationId },
          include: { participants: true },
        });
        if (!conv || !(conv as any).isSecret) {
          return;
        }
        if ((conv as any).secretStatus === "CANCELLED") return;
        const isMember = conv.participants.some((p) => p.userId === userId);
        if (!isMember) return;
        const device = await (prisma as any).userDevice.findUnique({
          where: { id: deviceId },
          select: { id: true, userId: true, revokedAt: true },
        });
        if (!device || device.userId !== userId || device.revokedAt) {
          return;
        }
        const updated = await prisma.conversation.update({
          where: { id: conversationId },
          data: {
            secretStatus: "ACTIVE",
            secretPeerDeviceId: deviceId,
          } as any,
          include: { participants: true },
        });
        const participantIds = updated.participants.map((p) => p.userId);
        for (const pid of participantIds) {
          io.to(userRoom(pid)).emit("secret:chat:accepted", {
            conversationId,
            peerDeviceId: deviceId,
          });
          io.to(userRoom(pid)).emit("conversations:updated", {
            conversationId,
            conversation: updated,
          });
        }
      } catch (error) {
        logger.error({ error, conversationId, userId }, "Failed to accept secret chat");
      }
    });

    socket.on("secret:chat:decline", async ({ conversationId }) => {
      try {
        const conv = await prisma.conversation.findUnique({
          where: { id: conversationId },
          include: { participants: true },
        });
        if (!conv || !(conv as any).isSecret) {
          return;
        }
        if ((conv as any).secretStatus === "CANCELLED") return;
        const isMember = conv.participants.some((p) => p.userId === userId);
        if (!isMember) return;

        await prisma.conversation.update({
          where: { id: conversationId },
          data: { secretStatus: "CANCELLED" } as any,
        });

        const recipients = conv.participants.map((p) => p.userId);
        for (const rid of recipients) {
          io.to(userRoom(rid)).emit("conversations:deleted", { conversationId });
        }
      } catch (error) {
        logger.error({ error, conversationId, userId }, "Failed to decline secret chat");
      }
    });

    socket.on("secret:chat:offer", async ({ conversationId }) => {
      try {
        const conv = await prisma.conversation.findUnique({
          where: { id: conversationId },
          include: { participants: true },
        });
        if (!conv) {
          logger.warn({ conversationId, userId }, "Conversation not found in secret:chat:offer");
          return;
        }
        // Only secret 1:1 conversations are eligible
        const isSecret = (conv as any).isSecret as boolean | undefined;
        if (!isSecret || conv.isGroup) {
          logger.warn({ conversationId, userId, isSecret, isGroup: conv.isGroup }, "Conversation is not a secret 1:1 chat in secret:chat:offer");
          return;
        }
        const isMember = conv.participants.some((p) => p.userId === userId);
        if (!isMember) {
          logger.warn({ conversationId, userId }, "User is not a member of conversation in secret:chat:offer");
          return;
        }
        const recipient = conv.participants.find((p) => p.userId !== userId);
        if (!recipient) {
          logger.warn({ conversationId, userId }, "No recipient found for secret:chat:offer");
          return;
        }
        const caller = await prisma.user.findUnique({
          where: { id: userId },
          select: { displayName: true, username: true },
        });
        const name = caller?.displayName ?? caller?.username ?? "пользователь";
        io.to(userRoom(recipient.userId)).emit("secret:chat:offer", {
          conversationId,
          from: { id: userId, name, deviceId: (conv as any).secretInitiatorDeviceId ?? null },
        });
      } catch (error) {
        logger.error({ error, conversationId, userId }, "Failed to handle secret:chat:offer");
      }
    });

    // emit receipts updates to conversation room when someone marks messages as read
    // We hook into Prisma write in API route, but as a fallback we can expose an event here if needed later

    socket.on("call:invite", async ({ conversationId, video }) => {
      const conv = await prisma.conversation.findUnique({
        where: { id: conversationId },
        include: { participants: true },
      });
      if (!conv) {
        logger.warn({ conversationId, userId }, "Conversation not found in call:invite");
        return;
      }
      const isMember = conv.participants.some((p) => p.userId === userId);
      if (!isMember) {
        logger.warn({ conversationId, userId }, "User is not a member of conversation in call:invite");
        return;
      }
      const recipients = conv.participants
        .map((p) => p.userId)
        .filter((id) => id !== userId);
      const caller = await prisma.user.findUnique({ where: { id: userId }, select: { displayName: true, username: true } });
      const name = caller?.displayName ?? caller?.username ?? "пользователь";
      const isGroup = !!conv.isGroup;
      
      // Убеждаемся, что сокет присоединен к комнате беседы для получения событий
      socket.join(conversationId);
      
      // track call state
      const startedAt = Date.now();
      callState.set(conversationId, { inviterId: userId, accepted: false, video, startedAt });

      if (isGroup) {
        const callInfo = activeGroupCalls.get(conversationId);
        if (!callInfo) {
          const info: ActiveCallInfo = { startedAt, participantsByUser: new Map<string, Set<string>>() };
          addParticipant(info, userId, socket.id);
          activeGroupCalls.set(conversationId, info);
        } else {
          callInfo.startedAt = startedAt;
          addParticipant(callInfo, userId, socket.id);
        }
        // Update global presence for inviter (IN_CALL override)
        emitEffectivePresence(io, userId);
      }
      
      // Создаем системное сообщение о начале звонка только для групповых бесед
      // Для 1:1 бесед не создаем, так как есть входящий звонок с оверлеем и звуком
      if (isGroup) {
        try {
          const callTypeText = video ? "звонок с видео" : "звонок";
          const now = new Date();
          const msg = await prisma.message.create({
            data: {
              conversationId,
              senderId: userId,
              type: "SYSTEM",
              content: `${name} начал ${callTypeText} ${formatTime(now)}`,
              metadata: { started: true, video } as any,
            },
          });
          // Отправляем событие о новом сообщении всем участникам беседы через комнату
          io.to(conversationId).emit("message:new", {
            conversationId,
            messageId: msg.id,
            senderId: userId,
            message: msg,
          });
          // Также отправляем message:notify для каждого участника отдельно (кроме отправителя)
          for (const rid of recipients) {
            io.to(userRoom(rid)).emit("message:notify", {
              conversationId,
              messageId: msg.id,
              senderId: userId,
              message: msg,
            });
          }
          logger.info(
            { conversationId, userId, video, messageId: msg.id, isGroup, participantsCount: conv.participants.length },
            "Call started message created in call:invite",
          );
        } catch (error) {
          logger.error({ error, conversationId, userId, video, isGroup }, "Failed to create call started message in call:invite");
        }
      }
      
      // Для 1:1 звонков отправляем событие входящего звонка получателям
      // Для групповых звонков это не нужно, так как они видят активный звонок через call:status
      if (!isGroup) {
        const incomingPayload = { conversationId, from: { id: userId, name }, video };
        for (const rid of recipients) {
          io.to(userRoom(rid)).emit("call:incoming", incomingPayload);
        }
      }

      if (isGroup) {
        broadcastCallStatus(conversationId);
      }
    });

    socket.on("call:accept", async ({ conversationId, video }) => {
      const conv = await prisma.conversation.findUnique({
        where: { id: conversationId },
        include: { participants: true },
      });
      if (!conv) return;
      const recipients = conv.participants.map((p) => p.userId).filter((id) => id !== userId);
      const st = callState.get(conversationId);
      if (st) callState.set(conversationId, { ...st, accepted: true });
      const isGroup = !!conv.isGroup;

      // For direct (1:1) calls, we treat the call as active starting at accept time,
      // and wire it into presence so everyone sees "IN_CALL" reliably (even though the web client
      // does not emit call:room:join for 1:1).
      if (!isGroup) {
        const startedAt = st?.startedAt ?? Date.now();
        const info = activeDirectCalls.get(conversationId) ?? { startedAt, participantsByUser: new Map<string, Set<string>>() };
        info.startedAt = startedAt;
        // Add all currently connected sockets for both parties (works for multi-tab / multi-device).
        if (st?.inviterId) {
          addAllCurrentSockets(info, st.inviterId);
        }
        addAllCurrentSockets(info, userId);
        activeDirectCalls.set(conversationId, info);
        // Broadcast effective presence for both participants.
        if (st?.inviterId) emitEffectivePresence(io, st.inviterId);
        emitEffectivePresence(io, userId);
      }
      // Отправляем call:accepted получателям звонка
      for (const rid of recipients) {
        io.to(userRoom(rid)).emit("call:accepted", { conversationId, by: { id: userId }, video });
      }
      // Также отправляем call:accepted самому пользователю на другие его устройства
      // Это нужно, чтобы прекратить входящий звонок на других устройствах
      socket.to(userRoom(userId)).emit("call:accepted", { conversationId, by: { id: userId }, video });
    });

    socket.on("call:decline", async ({ conversationId }) => {
      const conv = await prisma.conversation.findUnique({
        where: { id: conversationId },
        include: { participants: true },
      });
      if (!conv) return;
      const recipients = conv.participants.map((p) => p.userId).filter((id) => id !== userId);
      const isGroup = !!conv.isGroup;
      const st = callState.get(conversationId);
      const callInfo = activeGroupCalls.get(conversationId);

      const computeDuration = () => {
        const startedAt = callInfo?.startedAt ?? st?.startedAt ?? Date.now();
        const elapsedMs = Math.max(0, Date.now() - startedAt);
        const totalSec = Math.max(0, Math.floor(elapsedMs / 1000));
        const hours = Math.floor(totalSec / 3600);
        const minutes = Math.floor((totalSec % 3600) / 60);
        const seconds = totalSec % 60;
        const durationText =
          hours > 0
            ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
            : `${minutes}:${String(seconds).padStart(2, "0")}`;
        return { elapsedMs, durationText };
      };
      for (const rid of recipients) {
        io.to(userRoom(rid)).emit("call:declined", { conversationId, by: { id: userId } });
      }
      if (isGroup) {
        const { elapsedMs, durationText } = computeDuration();
        const senderId = st?.inviterId ?? userId;
        if (st) callState.delete(conversationId);
        activeGroupCalls.delete(conversationId);
        try {
          const msg = await prisma.message.create({
            data: {
              conversationId,
              senderId,
              type: "SYSTEM",
              content: `Звонок продлился ${durationText} и был завершён`,
              metadata: { ended: true, video: !!st?.video, duration: elapsedMs } as any,
            },
          });
          io.to(conversationId).emit("message:new", {
            conversationId,
            messageId: msg.id,
            senderId,
            message: msg,
          });
          for (const rid of recipients) {
            io.to(userRoom(rid)).emit("message:notify", {
              conversationId,
              messageId: msg.id,
              senderId,
              message: msg,
            });
          }
        } catch (error) {
          logger.warn({ error }, "Failed to create group decline end message");
        }
        io.to(conversationId).emit("call:status", { conversationId, active: false });
        return;
      }

      // Direct (1:1): clear any active-direct-call state and recompute presence for both sides.
      activeDirectCalls.delete(conversationId);
      if (st?.inviterId) emitEffectivePresence(io, st.inviterId);
      emitEffectivePresence(io, userId);

      // treat as missed call if not accepted yet (1:1)
      if (st && !st.accepted) {
        callState.delete(conversationId);
        try {
          const now = new Date();
          const msg = await prisma.message.create({
            data: {
              conversationId,
              senderId: st.inviterId,
              type: "SYSTEM",
              content: `Пропущенный звонок ${formatTime(now)}`,
              metadata: { missed: true, video: !!st.video } as any,
            },
          });
          // Mark as read for inviter only
          await prisma.messageReceipt.create({ data: { messageId: msg.id, userId: st.inviterId, status: "READ" } });
          io.to(conversationId).emit("message:new", {
            conversationId,
            messageId: msg.id,
            senderId: st.inviterId,
            message: msg,
          });
        } catch (error) {
          logger.warn({ error }, "Failed to create missed call message");
        }
      }
    });

    socket.on("call:end", async ({ conversationId }) => {
      const conv = await prisma.conversation.findUnique({
        where: { id: conversationId },
        include: { participants: true },
      });
      if (!conv) return;
      const recipients = conv.participants.map((p) => p.userId).filter((id) => id !== userId);
      for (const rid of recipients) {
        io.to(userRoom(rid)).emit("call:ended", { conversationId, by: { id: userId } });
      }
      
      const isGroup = !!conv.isGroup;
      const st = callState.get(conversationId);
      const callInfo = activeGroupCalls.get(conversationId);

      const computeDuration = () => {
        const startedAt = callInfo?.startedAt ?? st?.startedAt ?? Date.now();
        const elapsedMs = Math.max(0, Date.now() - startedAt);
        const totalSec = Math.max(0, Math.floor(elapsedMs / 1000));
        const hours = Math.floor(totalSec / 3600);
        const minutes = Math.floor((totalSec % 3600) / 60);
        const seconds = totalSec % 60;
        const durationText =
          hours > 0
            ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
            : `${minutes}:${String(seconds).padStart(2, "0")}`;
        return { elapsedMs, durationText };
      };

      if (isGroup) {
        const { elapsedMs, durationText } = computeDuration();
        try {
          const msg = await prisma.message.create({
            data: {
              conversationId,
              senderId: userId,
              type: "SYSTEM",
              content: `Звонок продлился ${durationText} и был завершён`,
              metadata: { ended: true, video: !!st?.video, duration: elapsedMs } as any,
            },
          });
          io.to(conversationId).emit("message:new", {
            conversationId,
            messageId: msg.id,
            senderId: userId,
            message: msg,
          });
          for (const rid of recipients) {
            io.to(userRoom(rid)).emit("message:notify", {
              conversationId,
              messageId: msg.id,
              senderId: userId,
              message: msg,
            });
          }
        } catch (error) {
          logger.warn({ conversationId, error }, "Failed to create group call end message");
        }
        activeGroupCalls.delete(conversationId);
        callState.delete(conversationId);
        io.to(conversationId).emit("call:status", { conversationId, active: false });
        return;
      }

      // Direct (1:1): clear active call presence state
      activeDirectCalls.delete(conversationId);
      if (st?.inviterId) emitEffectivePresence(io, st.inviterId);
      emitEffectivePresence(io, userId);

      const caller = await prisma.user.findUnique({ where: { id: userId }, select: { displayName: true, username: true } });
      const name = caller?.displayName ?? caller?.username ?? "пользователь";

      if (st && !st.accepted) {
        // Пропущенный звонок (не был принят)
        callState.delete(conversationId);
        try {
          const now = new Date();
          const msg = await prisma.message.create({
            data: {
              conversationId,
              senderId: st.inviterId,
              type: "SYSTEM",
              content: `Пропущенный звонок ${formatTime(now)}`,
              metadata: { missed: true, video: !!st.video } as any,
            },
          });
          await prisma.messageReceipt.create({ data: { messageId: msg.id, userId: st.inviterId, status: "READ" } });
          io.to(conversationId).emit("message:new", {
            conversationId,
            messageId: msg.id,
            senderId: st.inviterId,
            message: msg,
          });
        } catch {}
      } else if (st && st.accepted) {
        // Завершенный активный звонок - создаем сообщение о завершении
        callState.delete(conversationId);
        try {
          const { elapsedMs, durationText } = computeDuration();

          const msg = await prisma.message.create({
            data: {
              conversationId,
              senderId: userId,
              type: "SYSTEM",
              content: `Звонок продлился ${durationText} и был завершён`,
              metadata: { ended: true, video: !!st.video, duration: elapsedMs } as any,
            },
          });
          io.to(conversationId).emit("message:new", {
            conversationId,
            messageId: msg.id,
            senderId: userId,
            message: msg,
          });
          for (const rid of recipients) {
            io.to(userRoom(rid)).emit("message:notify", {
              conversationId,
              messageId: msg.id,
              senderId: userId,
              message: msg,
            });
          }
        } catch (error) {
          logger.warn({ error }, "Failed to create call ended message");
        }
      } else {
        callState.delete(conversationId);
      }

      broadcastCallStatus(conversationId);
    });

    socket.on("call:room:join", async ({ conversationId, video }) => {
      const conv = await prisma.conversation.findUnique({
        where: { id: conversationId },
        include: { participants: true },
      });
      if (!conv) return;
      const isMember = conv.participants.some((p) => p.userId === userId);
      if (!isMember) return;
      
      const isGroup = !!conv.isGroup;
      logger.info({ conversationId, userId, isGroup, participantCount: conv.participants.length }, "call:room:join received");

      // Убеждаемся, что сокет присоединен к комнате беседы для получения событий
      socket.join(conversationId);
      // Track call participation for presence (both group and direct)
      const targetMap = isGroup ? activeGroupCalls : activeDirectCalls;
      
      // Отмечаем звонок как принятый ТОЛЬКО когда присоединился кто-то кроме инициатора
      const st = callState.get(conversationId);
      if (isGroup && st && !st.accepted && userId !== st.inviterId) {
        callState.set(conversationId, { ...st, accepted: true });
      }
      
      let callInfo = targetMap.get(conversationId);
      const isFirstParticipant = !callInfo;
      
      if (!callInfo) {
        // Initialize call info if needed
        // For group calls we may need to create the "call started" message (if call:invite wasn't called).
        if (isGroup) {
          // Первый участник - начинаем звонок
          // ВАЖНО: Для групп сообщение должно создаваться либо в call:invite, либо здесь
          // Если callState существует, значит call:invite уже был вызван и сообщение создано
          // Если callState не существует, значит создатель сразу присоединился без call:invite - создаем сообщение здесь
          if (!st) {
            const caller = await prisma.user.findUnique({ where: { id: userId }, select: { displayName: true, username: true } });
            const name = caller?.displayName ?? caller?.username ?? "пользователь";
            // Используем переданный video или по умолчанию false
            const callVideo = video ?? false;
            const startedAt = Date.now();
            callState.set(conversationId, { inviterId: userId, accepted: true, video: callVideo, startedAt });
            
            // Создаем системное сообщение о начале звонка
            try {
              const callTypeText = callVideo ? "звонок с видео" : "звонок";
              const now = new Date();
              const msg = await prisma.message.create({
                data: {
                  conversationId,
                  senderId: userId,
                  type: "SYSTEM",
                  content: `${name} начал ${callTypeText} ${formatTime(now)}`,
                  metadata: { started: true, video: callVideo } as any,
                },
              });
              // Отправляем событие о новом сообщении всем участникам беседы через комнату
              io.to(conversationId).emit("message:new", { conversationId, messageId: msg.id, senderId: userId });
              // Также отправляем message:notify для всех участников (кроме отправителя)
              for (const p of conv.participants) {
                if (p.userId !== userId) {
                  io.to(userRoom(p.userId)).emit("message:notify", { conversationId, messageId: msg.id, senderId: userId });
                }
              }
              logger.info({ conversationId, userId, video: callVideo, messageId: msg.id }, "Call started message created in call:room:join (no callState)");
            } catch (error) {
              logger.error({ error, conversationId, userId, video: callVideo }, "Failed to create call started message in call:room:join");
            }
          } else {
            // callState существует, значит сообщение уже создано в call:invite
            logger.info({ conversationId, userId, hasCallState: true }, "Call state exists, message should already be created in call:invite");
          }
        }

        callInfo = { startedAt: callState.get(conversationId)?.startedAt ?? Date.now(), participantsByUser: new Map<string, Set<string>>() };
        targetMap.set(conversationId, callInfo);
      }

      // На всякий случай повторно читаем обновленную запись (map может вернуть новый объект)
      callInfo = targetMap.get(conversationId) ?? callInfo;
      if (!callInfo) {
        logger.warn({ conversationId, userId }, "call:room:join missing callInfo after initialization");
        return;
      }

      addParticipant(callInfo, userId, socket.id);
      logger.info({ conversationId, userId, isFirstParticipant }, "User added to activeGroupCalls participants");

      // Обновляем состояние звонка для всех участников (только для групповых)
      if (isGroup) {
        broadcastCallStatus(conversationId);
      }
      // Update global presence (IN_CALL override) for joining user
      emitEffectivePresence(io, userId);
    });

    socket.on("call:room:leave", async ({ conversationId }) => {
      const groupInfo = activeGroupCalls.get(conversationId);
      const directInfo = activeDirectCalls.get(conversationId);
      const callInfo = groupInfo ?? directInfo;
      if (!callInfo) {
        // Если звонок еще не успел инициировать комнату (например, создатель сразу отменил)
        const st = callState.get(conversationId);
        if (st) {
          callState.delete(conversationId);
          io.to(conversationId).emit("call:status", {
            conversationId,
            active: false,
          });
        }
        logger.info({ conversationId, userId }, "call:room:leave without callInfo — treated as no active participants");
        return;
      }
      
      removeParticipant(callInfo, userId, socket.id);
      
      const remainingUsers = callInfo.participantsByUser.size;
      const isGroup = !!groupInfo;
      if (remainingUsers === 0) {
        if (isGroup) activeGroupCalls.delete(conversationId);
        else activeDirectCalls.delete(conversationId);
        if (isGroup) {
          try {
            const st = callState.get(conversationId);
            const startedAt = st?.startedAt ?? callInfo.startedAt;
            const elapsedMs = Math.max(0, Date.now() - (startedAt ?? Date.now()));
            const totalSec = Math.max(0, Math.floor(elapsedMs / 1000));
            const hours = Math.floor(totalSec / 3600);
            const minutes = Math.floor((totalSec % 3600) / 60);
            const seconds = totalSec % 60;
            const durationText = hours > 0
              ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
              : `${minutes}:${String(seconds).padStart(2, "0")}`;

            const msg = await prisma.message.create({
              data: {
                conversationId,
                senderId: userId,
                type: "SYSTEM",
                content: `Звонок продлился ${durationText} и был завершён`,
                metadata: { ended: true, video: !!st?.video, duration: elapsedMs } as any,
              },
            });

            io.to(conversationId).emit("message:new", { conversationId, messageId: msg.id, senderId: userId });

            const conv = await prisma.conversation.findUnique({
              where: { id: conversationId },
              include: { participants: true },
            });
            if (conv) {
              for (const p of conv.participants) {
                if (p.userId !== userId) {
                  io.to(userRoom(p.userId)).emit("message:notify", { conversationId, messageId: msg.id, senderId: userId });
                }
              }
            }

            logger.info({ conversationId, userId, messageId: msg.id, duration: elapsedMs }, "Group call duration message created in call:room:leave");
            callState.delete(conversationId);
          } catch (error) {
            logger.warn({ error, conversationId, userId }, "Failed to create call ended message on room leave");
          }

          io.to(conversationId).emit("call:status", {
            conversationId,
            active: false,
          });
          logger.info({ conversationId, userId }, "Call status set to inactive in call:room:leave (no participants remain)");
        }
      } else {
        if (isGroup) {
          broadcastCallStatus(conversationId);
        }
      }

      // Update global presence for leaving user
      emitEffectivePresence(io, userId);
    });

    socket.on("call:status:request", async ({ conversationIds }) => {
      if (!Array.isArray(conversationIds) || conversationIds.length === 0) return;
      
      const statuses: Record<string, { active: boolean; startedAt?: number; elapsedMs?: number; participants?: string[] }> = {};
      const now = Date.now();
      
      for (const conversationId of conversationIds) {
        const callInfo = activeGroupCalls.get(conversationId);
        if (callInfo) {
          const elapsedMs = now - callInfo.startedAt;
          statuses[conversationId] = {
            active: true,
            startedAt: callInfo.startedAt,
            elapsedMs,
            participants: listParticipants(callInfo),
          };
        } else {
          statuses[conversationId] = {
            active: false,
          };
        }
      }
      
      socket.emit("call:status:bulk", { statuses });
    });

    // Используем disconnecting вместо disconnect, чтобы проверить комнату до того,
    // как сокет покинет все комнаты (disconnect срабатывает после выхода из комнат)
    socket.on("disconnecting", async (reason) => {
      logger.info({ userId, reason }, "Socket disconnecting");
      try {
        clearInterval(heartbeat);
      } catch {}
      
      // Удаляем пользователя из всех активных звонков
      for (const [conversationId, callInfo] of activeGroupCalls.entries()) {
        if (callInfo.participantsByUser.has(userId)) {
          removeParticipant(callInfo, userId, socket.id);
          if (callInfo.participantsByUser.size === 0) {
            activeGroupCalls.delete(conversationId);
          }
          // Отправляем обновленный статус
          broadcastCallStatus(conversationId);
        }
      }

      for (const [conversationId, callInfo] of activeDirectCalls.entries()) {
        if (callInfo.participantsByUser.has(userId)) {
          removeParticipant(callInfo, userId, socket.id);
          if (callInfo.participantsByUser.size === 0) {
            activeDirectCalls.delete(conversationId);
          }
        }
      }

      removeSocketFocus(userId, socket.id);
      const remainingConnections = socketFocusByUser.get(userId)?.size ?? 0;
      await recomputePresence(io, userId);
      if (remainingConnections === 0) {
        logger.info({ userId }, "User status set to OFFLINE (no active connections)");
      } else {
        const aggregatedStatus = computePresenceStatus(userId);
        logger.info({ userId, activeConnections: remainingConnections, aggregatedStatus }, "User still has active connections, status recomputed");
      }
    });
    
    socket.on("disconnect", (reason) => {
      logger.info({ userId, reason }, "Socket disconnected");
      decGauge("sockets_connected", 1);
    });
  });

  return io;
}

export function getIO() {
  return ioInstance;
}

