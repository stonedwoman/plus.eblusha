import type { Server as HttpServer } from "http";
import { Server } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import prisma from "../lib/prisma";
import { buildIpLocationFromRaw } from "../lib/ipLocation";
import env from "../config/env";
import { createDedicatedRedisClient, getRedisClient } from "../lib/redis";
import { generateCallE2eeSharedKeyBase64, getCallE2eeKey, getOrCreateCallE2eeKey, setCallE2eeKey } from "../lib/callE2ee";
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
  "receipts:update": (payload: { conversationId: string; messageIds: string[]; userId?: string; status?: "DELIVERED" | "READ" | "SEEN"; receipts?: any[] }) => void;
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
  "conversation:typing_update": (payload: {
    conversationId: string;
    userId: string;
    isTyping: boolean;
    displayName?: string | null;
  }) => void;
  "contacts:request:new": (payload: { contactId: string; from: { id: string; username: string } }) => void;
  "contacts:request:accepted": (payload: { contactId: string }) => void;
  "contacts:request:blocked": (payload: { contactId: string }) => void;
  "contacts:request:rejected": (payload: { contactId: string; friend?: { id: string; username: string; displayName: string | null } }) => void;
  "conversations:new": (payload: { conversationId: string }) => void;
  "conversations:updated": (payload: { conversationId: string; conversation?: any }) => void;
  "conversations:deleted": (payload: { conversationId: string }) => void;
  "call:incoming": (payload: { conversationId: string; from: { id: string; name: string }; video: boolean }) => void;
  "call:accepted": (payload: { conversationId: string; by: { id: string }; video: boolean }) => void;
  "call:declined": (payload: { conversationId: string; by: { id: string } }) => void;
  "call:ended": (payload: { conversationId: string; by: { id: string } }) => void;
  // Sent to the original inviter when the peer simultaneously dialed them
  // (1:1 glare). Purely informational; the peer's client converts its
  // outgoing UI into an incoming modal upon receiving call:incoming.
  "call:glare": (payload: { conversationId: string; with: { id: string } }) => void;
  "call:status": (payload: CallStatusPayload) => void;
  "call:status:bulk": (payload: { statuses: Record<string, CallStatusPayload> }) => void;
  "secret:chat:offer": (payload: { conversationId: string; from: { id: string; name: string; deviceId?: string | null } }) => void;
  "secret:chat:accepted": (payload: { conversationId: string; peerDeviceId: string }) => void;
  "secret:notify": (payload: { toDeviceId: string; msgId: string }) => void;
  "secret:thread:created": (payload: { threadId: string; type: "SECRET" }) => void;
  "device:revoked": (payload: { deviceId: string; reason?: string }) => void;
  "session:new": (payload: { userId: string; deviceId: string; deviceName?: string; platform?: string; lastIp?: string; lastCity?: string; lastCountry?: string; ts: number }) => void;
};

type ClientToServerEvents = {
  "conversation:join": (conversationId: string) => void;
  "conversation:leave": (conversationId: string) => void;
  "conversation:typing": (payload: { conversationId: string; typing: boolean }) => void;
  "typing_start": (conversationId: string) => void;
  "typing_ping": (conversationId: string) => void;
  "typing_stop": (conversationId: string) => void;
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
  // Presence semantics:
  // - connected/online is derived from socket connection presence
  // - active/in-focus is explicit client state (presence:state)
  "presence:state": (payload: {
    active: boolean;
    visibility: "visible" | "hidden";
    source: "web" | "electron" | "mobile";
  }) => void;
  // Backward-compatible alias (legacy clients)
  "presence:focus": (payload: { focused: boolean }) => void;
  "presence:game:update": (payload: { game: PresenceGame }) => void;
  "presence:game:clear": (payload: { reason: PresenceGameClearReason }) => void;
  "presence:game:subscribe": (payload: { peerUserId: string }) => void;
  "presence:game:hello": (payload: { openPeers: string[] }) => void;
};

type InterServerEvents = Record<string, never>;
type SocketData = { userId: string; deviceId?: string };
type CallPresenceSocket = {
  data: SocketData;
  rooms: Set<string>;
  join: (room: string) => Promise<void> | void;
  leave: (room: string) => Promise<void> | void;
};

type CallStatusPayload = {
  conversationId: string;
  active: boolean;
  startedAt?: number;
  elapsedMs?: number;
  participants?: string[];
  isGroup?: boolean;
  aloneSince?: number;
  autoEndAt?: number;
  aloneReminder?: boolean;
};

const userRoom = (userId: string) => `user:${userId}`;
const deviceRoom = (deviceId: string) => `device:${deviceId}`;
const ACTIVE_CALL_PRESENCE_ROOM = "call:presence:active";
const ACTIVE_CALL_CONVERSATION_ROOM_PREFIX = "call:presence:conversation:";
const activeCallConversationRoom = (conversationId: string) => `${ACTIVE_CALL_CONVERSATION_ROOM_PREFIX}${conversationId}`;
const activeCallUserRoom = (userId: string) => `call:presence:user:${userId}`;

const PRESENCE_TTL_SECONDS = 90;
const DEVICE_LASTSEEN_WRITE_THROTTLE_MS = 60_000;
const lastDeviceSeenWriteAt = new Map<string, number>();
const ACTIVITY_TTL_SECONDS = 120;
const PRESENCE_HEARTBEAT_MS = 27_000;
const TYPING_TTL_SECONDS = 6;
// Sweep cadence for catching stale ONLINE/BACKGROUND rows whose disconnect
// handler never ran (backend crash / killed mid-flight / TCP black-hole).
// Picked to be >= PRESENCE_TTL_SECONDS so Redis keys have had a chance to
// expire before we declare a user truly offline.
const PRESENCE_RECONCILE_INTERVAL_MS = 60_000;

type PresenceVisibility = "visible" | "hidden";
type PresenceSource = "web" | "electron" | "mobile";

type RedisPresenceRecord = { online: true; lastPingAt: number };
type RedisActivityRecord = { active: boolean; visibility: PresenceVisibility; updatedAt: number };

const redisPresenceSockKey = (userId: string, socketId: string) =>
  `presence_sock:${userId}:${socketId}`;
const redisActivitySockKey = (userId: string, socketId: string) =>
  `activity_sock:${userId}:${socketId}`;
const redisPresenceSocksKey = (userId: string) => `presence_socks:${userId}`;
const redisActiveSocksKey = (userId: string) => `active_socks:${userId}`;

async function writeAggregatedPresenceRedis(userId: string) {
  // Backward-compat / convenience key (NOT a source of truth).
  // Truth is derived from presence_socks/active_socks.
  try {
    const redis = await getRedisClient();
    const key = `presence:${userId}`;
    const payload: RedisPresenceRecord = { online: true, lastPingAt: Date.now() };
    await redis.set(key, JSON.stringify(payload), { EX: PRESENCE_TTL_SECONDS });
  } catch {
    // ignore redis failures (presence is best-effort)
  }
}

async function writeAggregatedActivityRedis(userId: string, activity: RedisActivityRecord) {
  // Backward-compat / convenience key (NOT a source of truth).
  try {
    const redis = await getRedisClient();
    const key = `activity:${userId}`;
    await redis.set(key, JSON.stringify(activity), { EX: ACTIVITY_TTL_SECONDS });
  } catch {
    // ignore redis failures (presence is best-effort)
  }
}

async function deleteAggregatedPresenceRedis(userId: string) {
  try {
    const redis = await getRedisClient();
    await redis.del(`presence:${userId}`);
  } catch {
    // ignore redis failures
  }
}

async function deleteAggregatedActivityRedis(userId: string) {
  try {
    const redis = await getRedisClient();
    await redis.del(`activity:${userId}`);
  } catch {
    // ignore redis failures
  }
}

async function addSocketPresenceRedis(userId: string, socketId: string) {
  const redis = await getRedisClient();
  await redis
    .multi()
    .sAdd(redisPresenceSocksKey(userId), socketId)
    .expire(redisPresenceSocksKey(userId), PRESENCE_TTL_SECONDS)
    .set(redisPresenceSockKey(userId, socketId), "1", { EX: PRESENCE_TTL_SECONDS })
    .exec();
}

async function refreshSocketPresenceRedis(userId: string, socketId: string) {
  const redis = await getRedisClient();
  await redis
    .multi()
    .expire(redisPresenceSocksKey(userId), PRESENCE_TTL_SECONDS)
    .expire(redisPresenceSockKey(userId, socketId), PRESENCE_TTL_SECONDS)
    .exec();
}

async function upsertSocketActivityRedis(
  userId: string,
  socketId: string,
  activity: { active: boolean; visibility: PresenceVisibility; source: PresenceSource; updatedAt: number }
) {
  const redis = await getRedisClient();
  const activeSetKey = redisActiveSocksKey(userId);
  const activityKey = redisActivitySockKey(userId, socketId);
  const payload: RedisActivityRecord = { active: !!activity.active, visibility: activity.visibility, updatedAt: activity.updatedAt };
  const raw = JSON.stringify({ ...payload, source: activity.source });
  const tx = redis.multi();
  if (payload.active) tx.sAdd(activeSetKey, socketId);
  else tx.sRem(activeSetKey, socketId);
  tx.expire(activeSetKey, ACTIVITY_TTL_SECONDS);
  tx.set(activityKey, raw, { EX: ACTIVITY_TTL_SECONDS });
  await tx.exec();
}

async function removeSocketPresenceAndActivityRedis(userId: string, socketId: string) {
  const redis = await getRedisClient();
  const presenceSetKey = redisPresenceSocksKey(userId);
  const activeSetKey = redisActiveSocksKey(userId);
  const replies = await redis
    .multi()
    .sRem(presenceSetKey, socketId)
    .sRem(activeSetKey, socketId)
    .del(redisPresenceSockKey(userId, socketId))
    .del(redisActivitySockKey(userId, socketId))
    .sCard(presenceSetKey)
    .sCard(activeSetKey)
    .exec();

  const onlineCount = Number((replies as any)?.[4] ?? 0);
  const activeCount = Number((replies as any)?.[5] ?? 0);
  return { onlineCount, activeCount };
}

async function readPresenceAggregateCountsRedis(userId: string): Promise<{ onlineCount: number; activeCount: number } | null> {
  try {
    const redis = await getRedisClient();
    const replies = await redis
      .multi()
      .sCard(redisPresenceSocksKey(userId))
      .sCard(redisActiveSocksKey(userId))
      .exec();
    const onlineCount = Number((replies as any)?.[0] ?? 0);
    const activeCount = Number((replies as any)?.[1] ?? 0);
    return { onlineCount, activeCount };
  } catch {
    return null;
  }
}

const typingStateKey = (conversationId: string, userId: string) => `typing:${conversationId}:${userId}`;

async function setTypingRedis(conversationId: string, userId: string, ttlSeconds: number) {
  try {
    const redis = await getRedisClient();
    await redis.set(typingStateKey(conversationId, userId), "1", { EX: ttlSeconds });
  } catch {
    // fallback to in-memory below
  }
}

async function clearTypingRedis(conversationId: string, userId: string) {
  try {
    const redis = await getRedisClient();
    await redis.del(typingStateKey(conversationId, userId));
  } catch {
    // ignore
  }
}

const typingInMemory = new Map<string, NodeJS.Timeout>();

function setTypingInMemory(
  conversationId: string,
  userId: string,
  io: Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>,
  ttlMs: number
) {
  const key = typingStateKey(conversationId, userId);
  const existing = typingInMemory.get(key);
  if (existing) clearTimeout(existing);
  const timeout = setTimeout(() => {
    typingInMemory.delete(key);
  }, ttlMs);
  typingInMemory.set(key, timeout);
}

function clearTypingInMemory(conversationId: string, userId: string) {
  const key = typingStateKey(conversationId, userId);
  const t = typingInMemory.get(key);
  if (t) {
    clearTimeout(t);
    typingInMemory.delete(key);
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
const callState: Map<string, { inviterId: string; inviterSocketId?: string; accepted: boolean; video: boolean; startedAt?: number }> = new Map();
// Minimum interval between call:invite emits for the same (user, conversation). Legit
// re-invites (reconnect / glare re-delivery) never fire faster than this; a buggy
// reconnect loop or a malicious client cannot hold a callee in a permanent ring.
const CALL_INVITE_MIN_INTERVAL_MS = 2_000;
const lastCallInviteAt: Map<string, number> = new Map();
// Entries are only useful within the throttle window; sweep stale ones so the map
// stays bounded regardless of how many (user, conversation) pairs ever placed a call.
const CALL_INVITE_SWEEP_THRESHOLD = 1_000;
function sweepCallInviteThrottle(now: number): void {
  if (lastCallInviteAt.size < CALL_INVITE_SWEEP_THRESHOLD) return;
  for (const [key, ts] of lastCallInviteAt) {
    if (now - ts >= CALL_INVITE_MIN_INTERVAL_MS) lastCallInviteAt.delete(key);
  }
}
// Grace window: a live 1:1 call must NOT be torn down the instant one party's socket
// blips (cell handoff, tab backgrounded, token refresh). We wait this long for them to
// reconnect and re-join before declaring the call ended for the remaining peer.
const DIRECT_CALL_GRACE_MS = 15_000;
const directCallGraceTimers: Map<string, NodeJS.Timeout> = new Map();
// Server-side no-answer backstop for un-accepted 1:1 calls: if no client ever tears the
// ringing call down (both sides dropped, buggy client), the state must not live forever.
// Set beyond the clients' own ring timeouts (~25–30s) so the server is a pure backstop.
const CALL_RING_TIMEOUT_MS = 60_000;
const callRingTimers: Map<string, NodeJS.Timeout> = new Map();
type ActiveCallInfo = { startedAt: number; participantsByUser: Map<string, Set<string>> };
// Track active group calls: conversationId -> { startedAt: number, participantsByUser: Map<userId, Set<socketId>> }
const activeGroupCalls: Map<string, ActiveCallInfo> = new Map();
// Track active direct calls (1:1): conversationId -> { startedAt: number, participantsByUser: Map<userId, Set<socketId>> }
const activeDirectCalls: Map<string, ActiveCallInfo> = new Map();
const GROUP_ALONE_REMINDER_MS = 2 * 60 * 1000;
const GROUP_ALONE_AUTO_END_MS = 5 * 60 * 1000;
const groupAloneTimers: Map<
  string,
  { aloneSince: number; reminder: NodeJS.Timeout; autoEnd: NodeJS.Timeout; reminded: boolean }
> = new Map();
let statusInterval: NodeJS.Timeout | null = null;

type PresenceStatus = "ONLINE" | "OFFLINE" | "BACKGROUND";
type BroadcastPresenceStatus = PresenceStatus | "IN_CALL";

const broadcastedPresenceByUser: Map<string, BroadcastPresenceStatus> = new Map();
const presenceUpdateQueue: Map<string, Promise<void>> = new Map();
const lastPresenceDbWriteAtByUser: Map<string, number> = new Map();
const lastObservedPresenceByUser: Map<string, PresenceStatus> = new Map();
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

function hasOtherCallConversationRooms(rooms: Iterable<string>, conversationId: string): boolean {
  const currentRoom = activeCallConversationRoom(conversationId);
  for (const room of rooms) {
    if (room !== currentRoom && room.startsWith(ACTIVE_CALL_CONVERSATION_ROOM_PREFIX)) {
      return true;
    }
  }
  return false;
}

async function joinSocketCallPresence(socket: CallPresenceSocket, conversationId: string) {
  const userId = socket.data.userId;
  if (!userId) return;
  await Promise.all([
    Promise.resolve(socket.join(ACTIVE_CALL_PRESENCE_ROOM)),
    Promise.resolve(socket.join(activeCallConversationRoom(conversationId))),
    Promise.resolve(socket.join(activeCallUserRoom(userId))),
  ]);
}

async function leaveSocketCallPresence(socket: CallPresenceSocket, conversationId: string) {
  const userId = socket.data.userId;
  if (!userId) return;
  const shouldKeepUserWidePresence = hasOtherCallConversationRooms(socket.rooms, conversationId);
  const ops: Array<Promise<void>> = [
    Promise.resolve(socket.leave(activeCallConversationRoom(conversationId))),
  ];
  if (!shouldKeepUserWidePresence) {
    ops.push(Promise.resolve(socket.leave(ACTIVE_CALL_PRESENCE_ROOM)));
    ops.push(Promise.resolve(socket.leave(activeCallUserRoom(userId))));
  }
  await Promise.all(ops);
}

async function leaveAllSocketCallPresence(socket: CallPresenceSocket) {
  const userId = socket.data.userId;
  if (!userId) return;
  const conversationRooms = Array.from(socket.rooms).filter((room) =>
    room.startsWith(ACTIVE_CALL_CONVERSATION_ROOM_PREFIX)
  );
  await Promise.all([
    ...conversationRooms.map((room) => Promise.resolve(socket.leave(room))),
    Promise.resolve(socket.leave(ACTIVE_CALL_PRESENCE_ROOM)),
    Promise.resolve(socket.leave(activeCallUserRoom(userId))),
  ]);
}

async function clearConversationCallPresence(io: Server, conversationId: string) {
  const room = activeCallConversationRoom(conversationId);
  try {
    const sockets = await io.in(room).fetchSockets();
    await Promise.all(
      sockets.map((socket) => leaveSocketCallPresence(socket as unknown as CallPresenceSocket, conversationId))
    );
  } catch (error) {
    logger.warn({ error, conversationId }, "Failed to clear call presence rooms");
  }
}

async function markUsersInCallPresence(io: Server, conversationId: string, userIds: string[]) {
  const uniqueUserIds = Array.from(new Set(userIds.filter((id) => typeof id === "string" && id.trim().length > 0)));
  const targetRooms = [ACTIVE_CALL_PRESENCE_ROOM, activeCallConversationRoom(conversationId)];
  try {
    await Promise.all(
      uniqueUserIds.map((userId) =>
        io.in(userRoom(userId)).socketsJoin([...targetRooms, activeCallUserRoom(userId)])
      )
    );
  } catch (error) {
    logger.warn({ error, conversationId, userIds: uniqueUserIds }, "Failed to mark users as in-call across cluster");
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

function getActiveCallInfo(conversationId: string): { info: ActiveCallInfo; isGroup: boolean } | null {
  const groupInfo = activeGroupCalls.get(conversationId);
  if (groupInfo) return { info: groupInfo, isGroup: true };
  const directInfo = activeDirectCalls.get(conversationId);
  if (directInfo) return { info: directInfo, isGroup: false };
  return null;
}

function clearGroupAloneTimer(conversationId: string) {
  const timer = groupAloneTimers.get(conversationId);
  if (!timer) return;
  clearTimeout(timer.reminder);
  clearTimeout(timer.autoEnd);
  groupAloneTimers.delete(conversationId);
}

function isUserInAnyCallLocal(userId: string): boolean {
  for (const info of activeGroupCalls.values()) {
    if (info.participantsByUser.has(userId)) return true;
  }
  for (const info of activeDirectCalls.values()) {
    if (info.participantsByUser.has(userId)) return true;
  }
  return false;
}

async function isUserInAnyCallCluster(io: Server, userId: string): Promise<boolean> {
  try {
    const socketIds = await io.in(activeCallUserRoom(userId)).allSockets();
    return socketIds.size > 0;
  } catch {
    return false;
  }
}

async function isUserInAnyCall(io: Server, userId: string): Promise<boolean> {
  if (isUserInAnyCallLocal(userId)) return true;
  return isUserInAnyCallCluster(io, userId);
}

async function computeBroadcastPresence(io: Server, userId: string, base: PresenceStatus): Promise<BroadcastPresenceStatus> {
  if (base === "OFFLINE") return "OFFLINE";
  if (await isUserInAnyCall(io, userId)) return "IN_CALL";
  return base;
}

function presenceStatusFromCounts(onlineCount: number, activeCount: number): { online: boolean; active: boolean; status: PresenceStatus } {
  const online = onlineCount > 0;
  const active = activeCount > 0;
  const status: PresenceStatus = !online ? "OFFLINE" : active ? "ONLINE" : "BACKGROUND";
  return { online, active, status };
}

async function computePresenceStatusFromRedis(userId: string): Promise<{ online: boolean; active: boolean; status: PresenceStatus } | null> {
  const counts = await readPresenceAggregateCountsRedis(userId);
  if (!counts) return null;
  return presenceStatusFromCounts(counts.onlineCount, counts.activeCount);
}

async function emitEffectivePresence(io: Server, userId: string, baseOverride?: PresenceStatus) {
  const base =
    baseOverride ??
    (await (async () => {
      const agg = await computePresenceStatusFromRedis(userId);
      return agg?.status;
    })());
  if (!base) return;
  const effective = await computeBroadcastPresence(io, userId, base);
  const prev = broadcastedPresenceByUser.get(userId);
  if (prev === effective) return;
  if (effective === "OFFLINE") broadcastedPresenceByUser.delete(userId);
  else broadcastedPresenceByUser.set(userId, effective);
  io.emit("presence:update", { userId, status: effective });
}

function normalizePresenceVisibility(v: unknown): PresenceVisibility | null {
  if (v === "visible" || v === "hidden") return v;
  return null;
}

function normalizePresenceSource(v: unknown): PresenceSource | null {
  if (v === "web" || v === "electron" || v === "mobile") return v;
  return null;
}

function normalizePresenceStatePayload(raw: unknown): { active: boolean; visibility: PresenceVisibility; source: PresenceSource } | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as any;
  const visibility = normalizePresenceVisibility(p.visibility);
  const source = normalizePresenceSource(p.source);
  if (!visibility || !source) return null;
  const active = !!p.active && visibility === "visible";
  return { active, visibility, source };
}

async function persistPresenceToDb(userId: string, status: PresenceStatus) {
  const previous = lastObservedPresenceByUser.get(userId);
  if (previous === status) return;
  lastObservedPresenceByUser.set(userId, status);

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

/**
 * Reconcile DB presence (user.status) against the cluster-wide Redis presence
 * aggregate (presence_socks:<userId>). For every user whose DB status is not
 * OFFLINE but whose Redis presence set is empty, mark them OFFLINE and emit
 * presence:update so clients/admin panels refresh.
 *
 * Why this exists:
 * - Normally, status transitions are driven by socket connect/disconnecting
 *   handlers calling recomputePresenceFromRedis().
 * - If a backend instance is killed (crash / OOM / SIGKILL / forced restart)
 *   while users are online, their disconnecting handler never runs. The Redis
 *   presence keys still expire after PRESENCE_TTL_SECONDS, but nothing
 *   recomputes presence for those users — so user.status stays ONLINE/BACKGROUND
 *   forever (until the user reconnects).
 * - Same staleness can also happen on TCP black-holes or any path that bypasses
 *   the normal disconnect lifecycle.
 *
 * Multi-instance safety: this only marks a user OFFLINE if Redis aggregate is
 * empty cluster-wide. If the user is connected to another instance, their
 * Redis set is non-empty and we leave them alone.
 */
async function reconcileStalePresence(io: Server): Promise<void> {
  let candidates: Array<{ id: string; status: PresenceStatus }>;
  try {
    const rows = await prisma.user.findMany({
      where: { status: { not: "OFFLINE" } },
      select: { id: true, status: true },
    });
    candidates = rows.map((r) => ({ id: r.id, status: r.status as PresenceStatus }));
  } catch (error) {
    logger.warn({ error }, "Presence reconcile: failed to list non-offline users");
    return;
  }

  if (candidates.length === 0) return;

  const stuckUserIds: string[] = [];
  for (const candidate of candidates) {
    try {
      const counts = await readPresenceAggregateCountsRedis(candidate.id);
      // Treat Redis read failure as "do not touch" — better to leave a stale
      // ONLINE than to flap statuses on a transient Redis issue.
      if (!counts) continue;
      if (counts.onlineCount === 0) {
        stuckUserIds.push(candidate.id);
      }
    } catch (error) {
      logger.warn({ error, userId: candidate.id }, "Presence reconcile: Redis lookup failed");
    }
  }

  if (stuckUserIds.length === 0) return;

  try {
    await prisma.user.updateMany({
      where: { id: { in: stuckUserIds }, status: { not: "OFFLINE" } },
      data: { status: "OFFLINE", lastSeenAt: new Date() },
    });
  } catch (error) {
    logger.warn({ error, count: stuckUserIds.length }, "Presence reconcile: bulk DB update failed");
    return;
  }

  for (const userId of stuckUserIds) {
    // Keep in-memory throttling state coherent so subsequent connects/disconnects
    // produce the expected DB writes and broadcasts.
    lastObservedPresenceByUser.set(userId, "OFFLINE");
    lastPresenceDbWriteAtByUser.set(userId, Date.now());
    broadcastedPresenceByUser.delete(userId);
    // Best-effort cleanup of convenience aggregate keys.
    void deleteAggregatedPresenceRedis(userId);
    void deleteAggregatedActivityRedis(userId);
    try {
      io.emit("presence:update", { userId, status: "OFFLINE" });
    } catch (error) {
      logger.warn({ error, userId }, "Presence reconcile: failed to emit presence:update");
    }
  }

  logger.info(
    { reconciled: stuckUserIds.length, scanned: candidates.length },
    "Reconciled stale ONLINE/BACKGROUND user statuses to OFFLINE",
  );
}

function recomputePresenceFromRedis(
  io: Server,
  userId: string,
  opts?: { allowOfflineCleanup?: boolean }
): Promise<void> {
  const previousTask = presenceUpdateQueue.get(userId) ?? Promise.resolve();
  const nextTask = previousTask
    .catch(() => {})
    .then(async () => {
      const agg = await computePresenceStatusFromRedis(userId);
      if (!agg) return;

      // Always emit based on Redis aggregate (never in-memory).
      await emitEffectivePresence(io, userId, agg.status);

      // Maintain convenience aggregate keys. Only delete them when we KNOW the user is offline.
      if (agg.online) {
        void writeAggregatedPresenceRedis(userId);
        void writeAggregatedActivityRedis(userId, {
          active: agg.active,
          visibility: agg.active ? "visible" : "hidden",
          updatedAt: Date.now(),
        });
      } else if (opts?.allowOfflineCleanup) {
        void deleteAggregatedPresenceRedis(userId);
        void deleteAggregatedActivityRedis(userId);
      }

      await persistPresenceToDb(userId, agg.status);
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

  // Recover from any stale ONLINE/BACKGROUND rows that survived the previous
  // process (crash, OOM, forced restart, deploy). Runs in the background so it
  // does not delay accepting connections.
  void reconcileStalePresence(io);
  // Periodic sweep keeps DB in sync with Redis even when disconnect handlers
  // are bypassed at runtime.
  setInterval(() => {
    void reconcileStalePresence(io);
  }, PRESENCE_RECONCILE_INTERVAL_MS).unref?.();

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

  const formatDuration = (startedAt: number) => {
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

  const buildCallStatus = (conversationId: string, opts?: { aloneReminder?: boolean }): CallStatusPayload => {
    const active = getActiveCallInfo(conversationId);
    const now = Date.now();
    if (!active) return { conversationId, active: false };

    const participants = listParticipants(active.info);
    const aloneState = active.isGroup && participants.length === 1 ? groupAloneTimers.get(conversationId) : undefined;
    return {
      conversationId,
      active: true,
      isGroup: active.isGroup,
      startedAt: active.info.startedAt,
      elapsedMs: now - active.info.startedAt,
      participants,
      ...(aloneState
        ? {
            aloneSince: aloneState.aloneSince,
            autoEndAt: aloneState.aloneSince + GROUP_ALONE_AUTO_END_MS,
            ...(opts?.aloneReminder ? { aloneReminder: true } : {}),
          }
        : {}),
    };
  };

  // Helper function to broadcast call status to all conversation participants
  const broadcastCallStatus = (conversationId: string, opts?: { aloneReminder?: boolean }) => {
    io.to(conversationId).emit("call:status", buildCallStatus(conversationId, opts));
  };

  const finishGroupCall = async (conversationId: string, endedByUserId: string, reason: "manual" | "decline" | "empty" | "alone_timeout") => {
    const callInfo = activeGroupCalls.get(conversationId);
    const st = callState.get(conversationId);
    if (!callInfo && !st) {
      clearGroupAloneTimer(conversationId);
      broadcastCallStatus(conversationId);
      return;
    }

    const participantsBeforeClear = callInfo ? listParticipants(callInfo) : [];
    const startedAt = st?.startedAt ?? callInfo?.startedAt ?? Date.now();
    const { elapsedMs, durationText } = formatDuration(startedAt);
    clearGroupAloneTimer(conversationId);
    activeGroupCalls.delete(conversationId);
    callState.delete(conversationId);
    await clearConversationCallPresence(io, conversationId);

    const conv = await prisma.conversation.findUnique({
      where: { id: conversationId },
      include: { participants: true },
    });
    const recipients = conv?.participants.map((p) => p.userId).filter((id) => id !== endedByUserId) ?? [];

    try {
      const content =
        reason === "alone_timeout"
          ? `Звонок продлился ${durationText} и был завершён автоматически`
          : `Звонок продлился ${durationText} и был завершён`;
      const msg = await prisma.message.create({
        data: {
          conversationId,
          senderId: endedByUserId,
          type: "SYSTEM",
          content,
          metadata: { ended: true, video: !!st?.video, duration: elapsedMs, reason } as any,
        },
      });
      io.to(conversationId).emit("message:new", {
        conversationId,
        messageId: msg.id,
        senderId: endedByUserId,
        message: msg,
      });
      for (const rid of recipients) {
        io.to(userRoom(rid)).emit("message:notify", {
          conversationId,
          messageId: msg.id,
          senderId: endedByUserId,
          message: msg,
        });
      }
    } catch (error) {
      logger.warn({ error, conversationId, reason }, "Failed to create group call end message");
    }

    io.to(conversationId).emit("call:ended", { conversationId, by: { id: endedByUserId } });
    broadcastCallStatus(conversationId);
    for (const pid of participantsBeforeClear) {
      void emitEffectivePresence(io, pid);
    }
  };

  const clearDirectCallGraceTimer = (conversationId: string) => {
    const t = directCallGraceTimers.get(conversationId);
    if (t) {
      clearTimeout(t);
      directCallGraceTimers.delete(conversationId);
    }
  };

  const clearCallRingTimer = (conversationId: string) => {
    const t = callRingTimers.get(conversationId);
    if (t) {
      clearTimeout(t);
      callRingTimers.delete(conversationId);
    }
  };

  // Teardown for a live 1:1 call (used by the disconnect grace timer). Only fires if the
  // call is still effectively empty (nobody rejoined during the grace window).
  const endActiveDirectCall = async (conversationId: string, endedByUserId: string) => {
    const info = activeDirectCalls.get(conversationId);
    if (!info) return;
    if (info.participantsByUser.size >= 2) return; // peer rejoined during grace — keep the call alive
    const remainingParticipantIds = listParticipants(info);
    await clearConversationCallPresence(io, conversationId);
    activeDirectCalls.delete(conversationId);
    callState.delete(conversationId);
    clearCallRingTimer(conversationId);
    try {
      const conv = await prisma.conversation.findUnique({
        where: { id: conversationId },
        include: { participants: true },
      });
      for (const p of conv?.participants ?? []) {
        io.to(userRoom(p.userId)).emit("call:ended", { conversationId, by: { id: endedByUserId } });
      }
    } catch (error) {
      logger.warn({ error, conversationId }, "Failed to emit direct call ended after grace");
    }
    for (const pid of remainingParticipantIds) {
      void emitEffectivePresence(io, pid);
    }
    broadcastCallStatus(conversationId);
  };

  const scheduleActiveDirectCallGraceTeardown = (conversationId: string, endedByUserId: string) => {
    if (directCallGraceTimers.has(conversationId)) return;
    const timer = setTimeout(() => {
      directCallGraceTimers.delete(conversationId);
      void endActiveDirectCall(conversationId, endedByUserId);
    }, DIRECT_CALL_GRACE_MS);
    directCallGraceTimers.set(conversationId, timer);
  };

  // Server backstop: cancel an un-accepted 1:1 ringing call that nothing ever cleaned up.
  const scheduleCallRingTimeout = (conversationId: string, inviterId: string) => {
    clearCallRingTimer(conversationId);
    const timer = setTimeout(() => {
      callRingTimers.delete(conversationId);
      void (async () => {
        const st = callState.get(conversationId);
        // Only act on a still-pending invite from the same call. If it was accepted,
        // ended, declined, or replaced, another path already handled it.
        if (!st || st.accepted) return;
        // Safety: never destroy a call that is actually live. A 1:1 can become active via
        // call:room:join (the "join active call" button) WITHOUT a call:accept, leaving
        // st.accepted=false. If both sides are present in the room, treat it as accepted
        // and leave it alone instead of tearing down a healthy call.
        const liveInfo = activeDirectCalls.get(conversationId);
        if (liveInfo && liveInfo.participantsByUser.size >= 2) {
          callState.set(conversationId, { ...st, accepted: true });
          return;
        }
        callState.delete(conversationId);
        activeDirectCalls.delete(conversationId);
        clearDirectCallGraceTimer(conversationId);
        try {
          const conv = await prisma.conversation.findUnique({
            where: { id: conversationId },
            include: { participants: true },
          });
          if (!conv || conv.isGroup) return;
          for (const p of conv.participants) {
            io.to(userRoom(p.userId)).emit("call:ended", { conversationId, by: { id: inviterId } });
          }
          // Record the unanswered call as missed (read for the caller) if the client
          // never did. Guarded by the pending-state check above, so no duplicate.
          try {
            const now = new Date();
            const msg = await prisma.message.create({
              data: {
                conversationId,
                senderId: inviterId,
                type: "SYSTEM",
                content: `Пропущенный звонок ${formatTime(now)}`,
                metadata: { missed: true, video: !!st.video } as any,
              },
            });
            await prisma.messageReceipt.create({ data: { messageId: msg.id, userId: inviterId, status: "READ" } });
            io.to(conversationId).emit("message:new", {
              conversationId,
              messageId: msg.id,
              senderId: inviterId,
              message: msg,
            });
          } catch (error) {
            logger.warn({ error, conversationId }, "Failed to record missed-call on ring timeout");
          }
        } catch (error) {
          logger.warn({ error, conversationId }, "Failed to expire ringing call on timeout");
        }
        for (const p of [inviterId]) void emitEffectivePresence(io, p);
        broadcastCallStatus(conversationId);
      })();
    }, CALL_RING_TIMEOUT_MS);
    callRingTimers.set(conversationId, timer);
  };

  // Grace for an un-accepted 1:1 invite whose inviter's socket dropped: give them a
  // window to reconnect (token refresh / cell handoff) before cancelling the ring, so a
  // transient blip does not orphan callState (which would make the callee's accept a no-op).
  const schedulePendingInviteGraceTeardown = (conversationId: string, deadSocketId: string, inviterId: string) => {
    if (directCallGraceTimers.has(conversationId)) return;
    const timer = setTimeout(() => {
      directCallGraceTimers.delete(conversationId);
      void (async () => {
        const st = callState.get(conversationId);
        // Skip if reconnected/re-invited (inviterSocketId changed), accepted, or replaced.
        if (!st || st.accepted || st.inviterSocketId !== deadSocketId) return;
        callState.delete(conversationId);
        clearCallRingTimer(conversationId);
        try {
          const conv = await prisma.conversation.findUnique({
            where: { id: conversationId },
            include: { participants: true },
          });
          for (const p of conv?.participants ?? []) {
            if (p.userId !== inviterId) {
              io.to(userRoom(p.userId)).emit("call:ended", { conversationId, by: { id: inviterId } });
            }
          }
        } catch (error) {
          logger.warn({ error, conversationId }, "Failed to end pending call after inviter-drop grace");
        }
        broadcastCallStatus(conversationId);
      })();
    }, DIRECT_CALL_GRACE_MS);
    directCallGraceTimers.set(conversationId, timer);
  };

  const syncGroupAloneTimer = (conversationId: string) => {
    const callInfo = activeGroupCalls.get(conversationId);
    const participants = callInfo ? listParticipants(callInfo) : [];
    if (!callInfo || participants.length !== 1) {
      clearGroupAloneTimer(conversationId);
      return;
    }
    if (groupAloneTimers.has(conversationId)) return;

    const aloneSince = Date.now();
    const reminder = setTimeout(() => {
      const current = activeGroupCalls.get(conversationId);
      if (!current || current.participantsByUser.size !== 1) {
        clearGroupAloneTimer(conversationId);
        return;
      }
      const timer = groupAloneTimers.get(conversationId);
      if (timer) timer.reminded = true;
      broadcastCallStatus(conversationId, { aloneReminder: true });
    }, GROUP_ALONE_REMINDER_MS);
    const autoEnd = setTimeout(() => {
      const current = activeGroupCalls.get(conversationId);
      const onlyUserId = current ? listParticipants(current)[0] : undefined;
      if (!current || current.participantsByUser.size !== 1 || !onlyUserId) {
        clearGroupAloneTimer(conversationId);
        return;
      }
      void finishGroupCall(conversationId, onlyUserId, "alone_timeout");
    }, GROUP_ALONE_AUTO_END_MS);

    groupAloneTimers.set(conversationId, { aloneSince, reminder, autoEnd, reminded: false });
    broadcastCallStatus(conversationId);
  };

  // Периодически обновляем elapsedMs для активных звонков (каждую секунду)
  if (!statusInterval) {
    statusInterval = setInterval(() => {
      if (!io) return;
      const conversationIds = new Set([...activeGroupCalls.keys(), ...activeDirectCalls.keys()]);
      for (const conversationId of conversationIds) {
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
      // Reject banned/deleted users at the gate so a stale access token can't
      // keep them online after the admin panel revoked them.
      try {
        const u = await prisma.user.findUnique({
          where: { id: payload.sub },
          select: { bannedAt: true, deletedAt: true },
        });
        if (u && (u.bannedAt || u.deletedAt)) {
          next(new Error(u.deletedAt ? "ACCOUNT_DELETED" : "ACCOUNT_BANNED"));
          return;
        }
      } catch {
        // best-effort; if Prisma fails, fall through to verifyAccessToken/connection
      }
      socket.data.userId = payload.sub;
      const did = typeof (payload as any).did === "string" ? ((payload as any).did as string).trim() : "";
      const verifiedDeviceId = await resolveDeviceId(socket, payload.sub, did ? did : null);
      if (verifiedDeviceId) {
        socket.data.deviceId = verifiedDeviceId;
        next();
        return;
      }
      if (did) {
        const dev = await prisma.userDevice.findUnique({
          where: { id: did },
          select: { userId: true, revokedAt: true },
        });
        if (dev && dev.userId === payload.sub && dev.revokedAt) {
          next(new Error("DEVICE_REVOKED"));
          return;
        }
      }
      next();
    } catch (error) {
      const anyErr = error as any;
      if (anyErr?.code === "DEVICE_REVOKED" || String(anyErr?.message || "") === "DEVICE_REVOKED") {
        next(new Error("DEVICE_REVOKED"));
        return;
      }
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
    // Presence semantics (multi-instance):
    // - online is derived from Redis presence_socks/presence_sock keys (NOT in-memory)
    // - active is derived from Redis active_socks/activity_sock keys (NOT in-memory)
    void (async () => {
      try {
        await addSocketPresenceRedis(userId, socket.id);
        void writeAggregatedPresenceRedis(userId);
      } catch (error) {
        logger.warn({ error, userId }, "Failed to write socket presence to Redis");
      }
      void recomputePresenceFromRedis(io, userId);
    })();

    // Join device room if a verified deviceId is available (extension point for secret transport).
    const verifiedDeviceId = socket.data.deviceId;
    if (verifiedDeviceId) {
      socket.join(deviceRoom(verifiedDeviceId));
      logger.info({ userId, deviceId: verifiedDeviceId }, "Socket joined device room");
      void (async () => {
        try {
          const dev = await prisma.userDevice.findUnique({
            where: { id: verifiedDeviceId },
            select: { name: true, platform: true },
          });
          const xff = socket.handshake.headers?.["x-forwarded-for"];
          const ipRaw =
            (typeof xff === "string" ? xff.split(",")[0]?.trim() : Array.isArray(xff) ? String(xff[0] ?? "").trim() : "") ||
            (typeof (socket.handshake as any)?.address === "string" ? String((socket.handshake as any).address).trim() : "") ||
            "";
          const ipLoc = buildIpLocationFromRaw(ipRaw);
          const payload: { userId: string; deviceId: string; deviceName?: string; platform?: string; lastIp?: string; lastCity?: string; lastCountry?: string; ts: number } = {
            userId,
            deviceId: verifiedDeviceId,
            ts: Date.now(),
          };
          if (dev?.name != null && dev.name !== "") payload.deviceName = dev.name;
          if (dev?.platform != null && dev.platform !== "") payload.platform = dev.platform;
          if (ipLoc?.ip) payload.lastIp = ipLoc.ip;
          if (ipLoc?.city) payload.lastCity = ipLoc.city;
          if (ipLoc?.country) payload.lastCountry = ipLoc.country;
          io.to(userRoom(userId)).emit("session:new", payload);
        } catch {
          // ignore
        }
      })();
      void (async () => {
        try {
          const now = Date.now();
          const last = lastDeviceSeenWriteAt.get(verifiedDeviceId) ?? 0;
          if (now - last < DEVICE_LASTSEEN_WRITE_THROTTLE_MS) return;
          lastDeviceSeenWriteAt.set(verifiedDeviceId, now);
          const xff = socket.handshake.headers?.["x-forwarded-for"];
          const ipRaw =
            (typeof xff === "string" ? xff.split(",")[0]?.trim() : Array.isArray(xff) ? String(xff[0] ?? "").trim() : "") ||
            (typeof (socket.handshake as any)?.address === "string" ? String((socket.handshake as any).address).trim() : "") ||
            "";
          const ipLoc = buildIpLocationFromRaw(ipRaw);
          await prisma.userDevice.update({
            where: { id: verifiedDeviceId },
            data: {
              lastSeenAt: new Date(),
              ...(ipLoc
                ? { lastIp: ipLoc.ip, lastCountry: ipLoc.country ?? null, lastCity: ipLoc.city ?? null }
                : {}),
            },
          });
        } catch {
          // ignore
        }
      })();
    }

    // Redis presence TTL heartbeat (ephemeral).
    const heartbeat = setInterval(() => {
      void (async () => {
        try {
          await refreshSocketPresenceRedis(userId, socket.id);
          void writeAggregatedPresenceRedis(userId);
        } catch {
          // ignore heartbeat failures
        }
      })();
    }, PRESENCE_HEARTBEAT_MS);
    // initial heartbeat write (best-effort)
    void writeAggregatedPresenceRedis(userId);

    // Snapshot: if there are active calls right now, inform this socket so it can render "IN_CALL" immediately.
    void (async () => {
      try {
        const inCallUsers = new Set<string>();
        for (const info of activeGroupCalls.values()) {
          for (const uid of info.participantsByUser.keys()) inCallUsers.add(uid);
        }
        for (const info of activeDirectCalls.values()) {
          for (const uid of info.participantsByUser.keys()) inCallUsers.add(uid);
        }
        const activeCallSockets = await io.in(ACTIVE_CALL_PRESENCE_ROOM).fetchSockets();
        for (const activeSocket of activeCallSockets) {
          const uid = activeSocket.data?.userId;
          if (typeof uid === "string" && uid) {
            inCallUsers.add(uid);
          }
        }
        for (const uid of inCallUsers) {
          const effective = await computeBroadcastPresence(io, uid, "ONLINE");
          if (effective === "IN_CALL") {
            socket.emit("presence:update", { userId: uid, status: "IN_CALL" });
          }
        }
      } catch {
        // ignore snapshot failures
      }
    })();

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

    socket.on("presence:state", (payload) => {
      try {
        const normalized = normalizePresenceStatePayload(payload);
        if (!normalized) return;
        void (async () => {
          const now = Date.now();
          try {
            await upsertSocketActivityRedis(userId, socket.id, { ...normalized, updatedAt: now });
          } catch (error) {
            logger.warn({ error, userId }, "Failed to update socket activity in Redis");
          }
          void recomputePresenceFromRedis(io, userId);
        })();
      } catch (error) {
        logger.warn({ error, userId }, "Failed to handle presence:state");
      }
    });

    socket.on("presence:focus", ({ focused }) => {
      // Legacy clients only report focus boolean. Map it into the new activity model.
      const normalized = { active: !!focused, visibility: focused ? ("visible" as const) : ("hidden" as const), source: "web" as const };
      void (async () => {
        const now = Date.now();
        try {
          await upsertSocketActivityRedis(userId, socket.id, { ...normalized, updatedAt: now });
        } catch (error) {
          logger.warn({ error, userId }, "Failed to update socket activity in Redis (presence:focus)");
        }
        void recomputePresenceFromRedis(io, userId);
      })();
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

    const emitTypingUpdate = (
      conversationId: string,
      uid: string,
      isTyping: boolean,
      displayName?: string | null
    ) => {
      io.to(conversationId).emit("conversation:typing_update", {
        conversationId,
        userId: uid,
        isTyping,
        displayName: displayName ?? null,
      });
    };

    const ensureTypingMembership = async (conversationId: string): Promise<boolean> => {
      const membership = await prisma.conversationParticipant.findFirst({
        where: { userId, conversationId },
      });
      return !!membership;
    };

    socket.on("typing_start", async (conversationId: string) => {
      if (typeof conversationId !== "string" || !conversationId) return;
      if (!(await ensureTypingMembership(conversationId))) return;
      await setTypingRedis(conversationId, userId, TYPING_TTL_SECONDS);
      setTypingInMemory(conversationId, userId, io, TYPING_TTL_SECONDS * 1000);
      emitTypingUpdate(conversationId, userId, true);
      if (process.env.NODE_ENV === "development") {
        logger.info({ conversationId, userId }, "typing_start");
      }
    });

    socket.on("typing_ping", async (conversationId: string) => {
      if (typeof conversationId !== "string" || !conversationId) return;
      if (!(await ensureTypingMembership(conversationId))) return;
      await setTypingRedis(conversationId, userId, TYPING_TTL_SECONDS);
      setTypingInMemory(conversationId, userId, io, TYPING_TTL_SECONDS * 1000);
      emitTypingUpdate(conversationId, userId, true);
      if (process.env.NODE_ENV === "development") {
        logger.info({ conversationId, userId }, "typing_ping");
      }
    });

    socket.on("typing_stop", async (conversationId: string) => {
      if (typeof conversationId !== "string" || !conversationId) return;
      await clearTypingRedis(conversationId, userId);
      clearTypingInMemory(conversationId, userId);
      emitTypingUpdate(conversationId, userId, false);
      if (process.env.NODE_ENV === "development") {
        logger.info({ conversationId, userId }, "typing_stop");
      }
    });

    socket.on("conversation:typing", ({ conversationId, typing }) => {
      if (typeof conversationId !== "string" || !conversationId) return;
      void (async () => {
        if (!(await ensureTypingMembership(conversationId))) return;
        if (typing) {
          await setTypingRedis(conversationId, userId, TYPING_TTL_SECONDS);
          setTypingInMemory(conversationId, userId, io, TYPING_TTL_SECONDS * 1000);
          emitTypingUpdate(conversationId, userId, true);
        } else {
          await clearTypingRedis(conversationId, userId);
          clearTypingInMemory(conversationId, userId);
          emitTypingUpdate(conversationId, userId, false);
        }
      })();
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
      // Rate-limit invites to prevent ring-spam / re-ring loops. Only throttle while a call
      // for this conversation is ALREADY tracked (re-emitting call:incoming resets the
      // callee's ringtone) — a fresh call, or one just ended, is never throttled.
      const inviteThrottleKey = `${userId}:${conversationId}`;
      const nowTs = Date.now();
      if (callState.has(conversationId)) {
        const lastInviteTs = lastCallInviteAt.get(inviteThrottleKey) ?? 0;
        if (nowTs - lastInviteTs < CALL_INVITE_MIN_INTERVAL_MS) {
          logger.info({ conversationId, userId }, "call:invite throttled (too frequent)");
          return;
        }
      }
      sweepCallInviteThrottle(nowTs);
      lastCallInviteAt.set(inviteThrottleKey, nowTs);
      const recipients = conv.participants
        .map((p) => p.userId)
        .filter((id) => id !== userId);
      const caller = await prisma.user.findUnique({ where: { id: userId }, select: { displayName: true, username: true } });
      const name = caller?.displayName ?? caller?.username ?? "пользователь";
      const isGroup = !!conv.isGroup;

      // Убеждаемся, что сокет присоединен к комнате беседы для получения событий
      socket.join(conversationId);

      // ===== 1:1 GLARE DETECTION =====
      // If there is already a pending (not yet accepted) invite for this
      // 1:1 conversation, do NOT overwrite callState / rotate E2EE key /
      // re-broadcast incoming. Otherwise simultaneous mutual call:invite
      // (A→B and B→A in the same tick) would scramble the inviter and
      // generate two different E2EE keys, breaking the call.
      if (!isGroup) {
        const existingState = callState.get(conversationId);
        if (existingState && !existingState.accepted) {
          if (existingState.inviterId === userId) {
            // Same user re-emitted invite (e.g., reconnect / duplicate emit
            // after socket bounce). Idempotently re-deliver call:incoming
            // to peer(s) so they can re-show the modal if they missed it.
            const incomingPayload = { conversationId, from: { id: userId, name }, video: existingState.video };
            for (const rid of recipients) {
              io.to(userRoom(rid)).emit("call:incoming", incomingPayload);
            }
            logger.info({ conversationId, userId }, "1:1 call:invite re-emitted by same inviter, re-delivered call:incoming");
            return;
          }
          // Different user → glare. Resolve by keeping the EXISTING call.
          // Deliver the existing inviter's call:incoming to all of the new
          // inviter's sockets so their client can convert outgoing→incoming.
          try {
            const existingInviter = await prisma.user.findUnique({
              where: { id: existingState.inviterId },
              select: { displayName: true, username: true },
            });
            const inviterName = existingInviter?.displayName ?? existingInviter?.username ?? "пользователь";
            io.to(userRoom(userId)).emit("call:incoming", {
              conversationId,
              from: { id: existingState.inviterId, name: inviterName },
              video: existingState.video,
            });
            // Inform the original inviter that the peer was simultaneously
            // dialing too. Purely informational; their dialing UI continues.
            io.to(userRoom(existingState.inviterId)).emit("call:glare", {
              conversationId,
              with: { id: userId },
            });
          } catch (error) {
            logger.warn({ error, conversationId, userId }, "Failed to deliver glare snapshot");
          }
          logger.info(
            { conversationId, userId, existingInviter: existingState.inviterId },
            "1:1 call:invite glare detected — keeping existing call, no state overwrite",
          );
          return;
        }
      }

      // track call state
      const startedAt = Date.now();
      callState.set(conversationId, { inviterId: userId, inviterSocketId: socket.id, accepted: false, video, startedAt });

      // 1:1 calls: generate a fresh shared E2EE key per call start (stored in Redis with TTL).
      // Do NOT log the key value.
      if (!isGroup && env.E2EE_1TO1) {
        try {
          // Idempotent create-if-absent: repeated invites / glare must NOT regenerate the
          // key, or caller and callee land on different generations -> DECRYPTIONFAILED.
          await getOrCreateCallE2eeKey(conversationId);
        } catch (error) {
          logger.error({ error, conversationId, userId }, "Failed to generate/store call E2EE key");
        }
      }

      // Track whether this invite actually bootstrapped a new group call.
      // Subsequent invites for an already-active group call must NOT reset
      // startedAt nor create a duplicate "started" system message.
      let isFirstGroupInviter = false;
      if (isGroup) {
        const callInfo = activeGroupCalls.get(conversationId);
        if (!callInfo) {
          const info: ActiveCallInfo = { startedAt, participantsByUser: new Map<string, Set<string>>() };
          addParticipant(info, userId, socket.id);
          activeGroupCalls.set(conversationId, info);
          isFirstGroupInviter = true;
        } else {
          // Preserve existing call's startedAt — don't reset on join-as-invite.
          addParticipant(callInfo, userId, socket.id);
        }
        // Update global presence for inviter (IN_CALL override)
        void emitEffectivePresence(io, userId);
      }

      // Создаем системное сообщение о начале звонка только для групповых бесед
      // Для 1:1 бесед не создаем, так как есть входящий звонок с оверлеем и звуком
      // Для уже активного группового звонка повторное приглашение не должно создавать
      // дублирующее системное сообщение "X начал звонок".
      if (isGroup && isFirstGroupInviter) {
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
        // Server-side no-answer backstop so an un-accepted call can't ring/live forever.
        scheduleCallRingTimeout(conversationId, userId);
      }

      if (isGroup) {
        syncGroupAloneTimer(conversationId);
        broadcastCallStatus(conversationId);
      }
    });

    socket.on("call:accept", async ({ conversationId, video }) => {
      const conv = await prisma.conversation.findUnique({
        where: { id: conversationId },
        include: { participants: true },
      });
      if (!conv) return;
      if (!conv.participants.some((p) => p.userId === userId)) {
        logger.warn({ conversationId, userId }, "Non-member call:accept ignored");
        return;
      }
      const recipients = conv.participants.map((p) => p.userId).filter((id) => id !== userId);
      const st = callState.get(conversationId);
      const isGroup = !!conv.isGroup;

      if (!isGroup) {
        if (!st || st.inviterId === userId) {
          logger.info({ conversationId, userId, hasCallState: !!st }, "Ignoring stale or invalid direct call accept");
          broadcastCallStatus(conversationId);
          return;
        }
        callState.set(conversationId, { ...st, accepted: true });
        // Call is answered — cancel the no-answer backstop and any disconnect grace.
        clearCallRingTimer(conversationId);
        clearDirectCallGraceTimer(conversationId);
      } else if (st) {
        callState.set(conversationId, { ...st, accepted: true });
      }

      // For direct (1:1) calls, we treat the call as active starting at accept time,
      // and wire it into presence so everyone sees "IN_CALL" reliably (even though the web client
      // does not emit call:room:join for 1:1).
      if (!isGroup) {
        // Ensure E2EE key exists (defense-in-depth).
        if (env.E2EE_1TO1) {
          try {
            const existing = await getCallE2eeKey(conversationId);
            if (!existing) {
              await setCallE2eeKey(conversationId, generateCallE2eeSharedKeyBase64());
            }
          } catch (error) {
            logger.error({ error, conversationId, userId }, "Failed to ensure call E2EE key");
          }
        }
        const startedAt = st?.startedAt ?? Date.now();
        const info = activeDirectCalls.get(conversationId) ?? { startedAt, participantsByUser: new Map<string, Set<string>>() };
        info.startedAt = startedAt;
        // Track the sockets that are actually involved in this call. Other
        // tabs/devices of the same account must not keep the call alive.
        if (st?.inviterId && st.inviterSocketId) {
          addParticipant(info, st.inviterId, st.inviterSocketId);
        }
        addParticipant(info, userId, socket.id);
        activeDirectCalls.set(conversationId, info);
        await markUsersInCallPresence(io, conversationId, [st?.inviterId ?? "", userId]);
        // Broadcast effective presence for both participants.
        if (st?.inviterId) void emitEffectivePresence(io, st.inviterId);
        void emitEffectivePresence(io, userId);
        broadcastCallStatus(conversationId);
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
      if (!conv.participants.some((p) => p.userId === userId)) {
        logger.warn({ conversationId, userId }, "Non-member call:decline ignored");
        return;
      }
      const recipients = conv.participants.map((p) => p.userId).filter((id) => id !== userId);
      const isGroup = !!conv.isGroup;
      const st = callState.get(conversationId);

      // A direct call may ring on multiple devices of the same account.
      // Once one device has accepted, late auto-decline events from the
      // remaining devices must only dismiss their local UI, not end the live call.
      if (!isGroup && (st?.accepted || activeDirectCalls.has(conversationId))) {
        logger.info({ conversationId, userId }, "Ignoring stale direct call decline after accept");
        return;
      }

      for (const rid of recipients) {
        io.to(userRoom(rid)).emit("call:declined", { conversationId, by: { id: userId } });
      }
      // Also dismiss the ringing UI on the decliner's OWN other devices so a second
      // device does not keep ringing until its local auto-decline timeout.
      socket.to(userRoom(userId)).emit("call:declined", { conversationId, by: { id: userId } });
      if (isGroup) {
        await finishGroupCall(conversationId, st?.inviterId ?? userId, "decline");
        return;
      }

      // Direct (1:1): clear any active-direct-call state and recompute presence for both sides.
      activeDirectCalls.delete(conversationId);
      clearCallRingTimer(conversationId);
      clearDirectCallGraceTimer(conversationId);
      // E2EE key intentionally NOT deleted here: it persists via its TTL so caller and
      // callee never desync on a delete+recreate race (see getOrCreateCallE2eeKey).
      if (st?.inviterId) void emitEffectivePresence(io, st.inviterId);
      void emitEffectivePresence(io, userId);
      broadcastCallStatus(conversationId);

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
      if (!conv.participants.some((p) => p.userId === userId)) {
        logger.warn({ conversationId, userId }, "Non-member call:end ignored");
        return;
      }
      const recipients = conv.participants.map((p) => p.userId).filter((id) => id !== userId);
      const isGroup = !!conv.isGroup;
      if (!isGroup) {
        for (const rid of recipients) {
          io.to(userRoom(rid)).emit("call:ended", { conversationId, by: { id: userId } });
        }
        // Also stop any ringing/overlay on the ender's OWN other devices.
        socket.to(userRoom(userId)).emit("call:ended", { conversationId, by: { id: userId } });
      }
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
      await clearConversationCallPresence(io, conversationId);

      if (isGroup) {
        await finishGroupCall(conversationId, userId, "manual");
        return;
      }

      // Direct (1:1): clear active call presence state
      activeDirectCalls.delete(conversationId);
      clearCallRingTimer(conversationId);
      clearDirectCallGraceTimer(conversationId);
      // E2EE key intentionally NOT deleted here: it persists via its TTL, so a quick
      // re-call or a mid-call socket reconnect reuses the SAME shared key.
      if (st?.inviterId) void emitEffectivePresence(io, st.inviterId);
      void emitEffectivePresence(io, userId);

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

      // A (re)join cancels any pending disconnect-grace teardown for this call: the peer
      // came back within the grace window, so the call must stay alive.
      clearDirectCallGraceTimer(conversationId);

      const isGroup = !!conv.isGroup;
      logger.info({ conversationId, userId, isGroup, participantCount: conv.participants.length }, "call:room:join received");

      // Убеждаемся, что сокет присоединен к комнате беседы для получения событий
      socket.join(conversationId);
      await joinSocketCallPresence(socket as unknown as CallPresenceSocket, conversationId);
      // Track call participation for presence (both group and direct)
      const targetMap = isGroup ? activeGroupCalls : activeDirectCalls;
      
      // Отмечаем звонок как принятый ТОЛЬКО когда присоединился кто-то кроме инициатора.
      // For 1:1 this also covers the "join active call" button (call:room:join with no
      // call:accept): mark accepted AND clear the no-answer ring timer, otherwise the
      // server backstop would later tear down a healthy, connected call.
      const st = callState.get(conversationId);
      if (st && !st.accepted && userId !== st.inviterId) {
        callState.set(conversationId, { ...st, accepted: true });
        clearCallRingTimer(conversationId);
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
            callState.set(conversationId, { inviterId: userId, inviterSocketId: socket.id, accepted: true, video: callVideo, startedAt });
            
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
        syncGroupAloneTimer(conversationId);
        broadcastCallStatus(conversationId);
      } else {
        broadcastCallStatus(conversationId);
      }
      // Update global presence (IN_CALL override) for joining user
      void emitEffectivePresence(io, userId);
    });

    socket.on("call:room:leave", async ({ conversationId }) => {
      await leaveSocketCallPresence(socket as unknown as CallPresenceSocket, conversationId);
      const groupInfo = activeGroupCalls.get(conversationId);
      const directInfo = activeDirectCalls.get(conversationId);
      const callInfo = groupInfo ?? directInfo;
      if (!callInfo) {
        // Если звонок еще не успел инициировать комнату (например, создатель сразу отменил)
        const st = callState.get(conversationId);
        if (st) {
          clearGroupAloneTimer(conversationId);
          callState.delete(conversationId);
          broadcastCallStatus(conversationId);
        }
        void emitEffectivePresence(io, userId);
        logger.info({ conversationId, userId }, "call:room:leave without callInfo — treated as no active participants");
        return;
      }
      
      removeParticipant(callInfo, userId, socket.id);
      
      const remainingUsers = callInfo.participantsByUser.size;
      const isGroup = !!groupInfo;
      const shouldEndCall = isGroup ? remainingUsers === 0 : remainingUsers <= 1;
      if (shouldEndCall) {
        if (isGroup) {
          await finishGroupCall(conversationId, userId, "empty");
        } else {
          const remainingParticipantIds = listParticipants(callInfo);
          await clearConversationCallPresence(io, conversationId);
          activeDirectCalls.delete(conversationId);
          // E2EE key intentionally NOT deleted here: room:leave fires on transient LiveKit
          // reconnects / prior-call teardown and would wipe the key mid-call. TTL handles cleanup.
          try {
            const conv = await prisma.conversation.findUnique({
              where: { id: conversationId },
              include: { participants: true },
            });
            if (conv) {
              for (const p of conv.participants) {
                if (p.userId !== userId) {
                  io.to(userRoom(p.userId)).emit("call:ended", { conversationId, by: { id: userId } });
                }
              }
            }
          } catch (error) {
            logger.warn({ error, conversationId, userId }, "Failed to emit direct call ended on room leave");
          }
          callState.delete(conversationId);
          broadcastCallStatus(conversationId);
          for (const pid of remainingParticipantIds) {
            void emitEffectivePresence(io, pid);
          }
        }
      } else {
        if (isGroup) {
          syncGroupAloneTimer(conversationId);
          broadcastCallStatus(conversationId);
        } else {
          broadcastCallStatus(conversationId);
        }
      }

      // Update global presence for leaving user
      void emitEffectivePresence(io, userId);
    });

    socket.on("call:status:request", async ({ conversationIds }) => {
      if (!Array.isArray(conversationIds) || conversationIds.length === 0) return;

      // Only report call state for conversations the requester actually belongs to —
      // otherwise this is a presence/social-graph oracle (who is in which call, when it
      // started) for arbitrary conversation ids.
      const requested = Array.from(
        new Set(conversationIds.filter((id) => typeof id === "string" && id.trim().length > 0)),
      ).slice(0, 200);
      if (requested.length === 0) return;

      let allowed: Set<string>;
      try {
        const memberships = await prisma.conversationParticipant.findMany({
          where: { userId, conversationId: { in: requested } },
          select: { conversationId: true },
        });
        allowed = new Set(memberships.map((m) => m.conversationId));
      } catch (error) {
        logger.warn({ error, userId }, "Failed to resolve memberships for call:status:request");
        return;
      }

      const statuses: Record<string, CallStatusPayload> = {};
      for (const conversationId of requested) {
        if (!allowed.has(conversationId)) continue;
        statuses[conversationId] = buildCallStatus(conversationId);
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
      await leaveAllSocketCallPresence(socket as unknown as CallPresenceSocket);

      for (const [conversationId, st] of callState.entries()) {
        if (st.accepted || st.inviterSocketId !== socket.id) continue;
        // Un-accepted invite whose inviter's socket just dropped. Do NOT cancel the ring
        // immediately — a transient blip (token refresh / cell handoff) would orphan the
        // call and make the callee's accept a no-op. Give the inviter a grace window to
        // reconnect and re-invite; if they don't, the pending call is ended then.
        // (For group calls the activeGroupCalls sweep below cleans up immediately, and
        // this grace timer then no-ops because callState is already gone.)
        // The E2EE key is intentionally left to its TTL so a reconnect reuses the same key.
        schedulePendingInviteGraceTeardown(conversationId, socket.id, userId);
      }

      // Удаляем пользователя из всех активных звонков
      for (const [conversationId, callInfo] of activeGroupCalls.entries()) {
        if (callInfo.participantsByUser.has(userId)) {
          removeParticipant(callInfo, userId, socket.id);
          if (callInfo.participantsByUser.size === 0) {
            await finishGroupCall(conversationId, userId, "empty");
          } else {
            syncGroupAloneTimer(conversationId);
            broadcastCallStatus(conversationId);
          }
        }
      }

      for (const [conversationId, callInfo] of activeDirectCalls.entries()) {
        if (callInfo.participantsByUser.has(userId)) {
          removeParticipant(callInfo, userId, socket.id);
          if (callInfo.participantsByUser.size <= 1) {
            // CRITICAL: do NOT tear down the live call the instant a socket drops. A
            // transient blip on ONE side (cell handoff, backgrounded tab, token refresh)
            // would otherwise permanently end the call for BOTH parties. Instead, keep the
            // call and give the dropped peer a grace window to reconnect and re-join
            // (web restoreCallPresence / android connectionState observer re-emit
            // call:room:join, which clears this timer). If nobody rejoins within the
            // window, endActiveDirectCall notifies the remaining peer.
            // The E2EE key is left to its TTL so a reconnect reuses the same key.
            scheduleActiveDirectCallGraceTeardown(conversationId, userId);
          }
          broadcastCallStatus(conversationId);
        }
      }

      try {
        await removeSocketPresenceAndActivityRedis(userId, socket.id);
      } catch (error) {
        logger.warn({ error, userId }, "Failed to cleanup socket presence/activity in Redis on disconnect");
      }

      // Important: OFFLINE is allowed only if Redis aggregate shows zero live sockets.
      await recomputePresenceFromRedis(io, userId, { allowOfflineCleanup: true });
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

export function kickDevice(deviceId: string, opts?: { reason?: string }) {
  const id = String(deviceId || "").trim();
  if (!id) return;
  const io = ioInstance;
  if (!io) return;
  try {
    io.to(deviceRoom(id)).emit("device:revoked", { deviceId: id, ...(opts?.reason ? { reason: opts.reason } : {}) });
  } catch {
    // ignore emit failures
  }
  try {
    io.in(deviceRoom(id)).disconnectSockets(true);
  } catch {
    // ignore disconnect failures
  }
}

/**
 * Force-disconnect every socket of a user across all instances (Redis adapter
 * propagates disconnectSockets). Used by the admin panel for ban/delete to
 * make sure the user can't keep transmitting on a still-open socket.
 */
export function kickUser(userId: string, opts?: { reason?: string }) {
  const id = String(userId || "").trim();
  if (!id) return;
  const io = ioInstance;
  if (!io) return;
  const reason = opts?.reason;
  try {
    io.to(userRoom(id)).emit("device:revoked", {
      deviceId: "*",
      ...(reason ? { reason } : {}),
    });
  } catch {
    // ignore emit failures
  }
  try {
    io.in(userRoom(id)).disconnectSockets(true);
  } catch {
    // ignore disconnect failures
  }
}

