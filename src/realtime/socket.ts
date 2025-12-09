import type { Server as HttpServer } from "http";
import { Server } from "socket.io";
import prisma from "../lib/prisma";
import { verifyAccessToken } from "../utils/jwt";
import logger from "../config/logger";

type ServerToClientEvents = {
  "presence:update": (payload: { userId: string; status: string }) => void;
  "message:new": (payload: { conversationId: string; messageId: string; senderId: string; message?: any }) => void;
  "receipts:update": (payload: { conversationId: string; messageIds: string[] }) => void;
  "message:update": (payload: { conversationId: string; messageId: string; reason: string }) => void;
  "message:notify": (payload: { conversationId: string; messageId: string; senderId: string; message?: any }) => void;
  "message:reaction": (payload: { conversationId: string; messageId: string; senderId: string }) => void;
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
};

type InterServerEvents = Record<string, never>;
type SocketData = { userId: string };

let ioInstance: Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData> | null = null;
// Track call state per conversation to detect missed calls
const callState: Map<string, { inviterId: string; accepted: boolean; video: boolean; startedAt?: number }> = new Map();
// Track active group calls: conversationId -> { startedAt: number, participants: Set<string> }
const activeGroupCalls: Map<string, { startedAt: number; participants: Set<string> }> = new Map();
let statusInterval: NodeJS.Timeout | null = null;

type PresenceStatus = "ONLINE" | "OFFLINE" | "BACKGROUND";

const socketFocusByUser: Map<string, Map<string, boolean>> = new Map();
const persistedPresenceByUser: Map<string, PresenceStatus> = new Map();
const presenceUpdateQueue: Map<string, Promise<void>> = new Map();

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
  if (previous === status) {
    return;
  }
  if (status === "OFFLINE") {
    persistedPresenceByUser.delete(userId);
  } else {
    persistedPresenceByUser.set(userId, status);
  }
  const data: { status: PresenceStatus; lastSeenAt?: Date } = { status };
  data.lastSeenAt = new Date();
  try {
    await prisma.user.update({
      where: { id: userId },
      data,
    });
  } catch (error) {
    logger.warn({ error, userId, status }, "Failed to persist presence state");
    return;
  }
  io.emit("presence:update", { userId, status });
}

function recomputePresence(io: Server, userId: string): Promise<void> {
  const previousTask = presenceUpdateQueue.get(userId) ?? Promise.resolve();
  const nextTask = previousTask
    .catch(() => {})
    .then(async () => {
      const status = computePresenceStatus(userId);
      await persistPresence(io, userId, status);
    });
  presenceUpdateQueue.set(userId, nextTask);
  return nextTask.finally(() => {
    if (presenceUpdateQueue.get(userId) === nextTask) {
      presenceUpdateQueue.delete(userId);
    }
  });
}

export function initSocket(
  server: HttpServer
): Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData> {
  const io = new Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>(server, {
    cors: {
      origin: process.env.CLIENT_URL ?? true,
      credentials: true,
    },
  });

  ioInstance = io;

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
      const participants = Array.from(callInfo.participants);
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

      const payload = verifyAccessToken<{ sub: string }>(token);
      socket.data.userId = payload.sub;
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
    socket.join(userId);
    setSocketFocus(userId, socket.id, true);
    void recomputePresence(io, userId);

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
                io.to(userId).emit("call:incoming", {
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
          io.to(pid).emit("secret:chat:accepted", {
            conversationId,
            peerDeviceId: deviceId,
          });
          io.to(pid).emit("conversations:updated", {
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
          io.to(rid).emit("conversations:deleted", { conversationId });
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
        io.to(recipient.userId).emit("secret:chat:offer", {
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
          activeGroupCalls.set(conversationId, { startedAt, participants: new Set<string>() });
        } else {
          callInfo.startedAt = startedAt;
          callInfo.participants.add(userId);
        }
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
            io.to(rid).emit("message:notify", {
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
          io.to(rid).emit("call:incoming", incomingPayload);
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
      // Отправляем call:accepted получателям звонка
      for (const rid of recipients) {
        io.to(rid).emit("call:accepted", { conversationId, by: { id: userId }, video });
      }
      // Также отправляем call:accepted самому пользователю на другие его устройства
      // Это нужно, чтобы прекратить входящий звонок на других устройствах
      socket.to(userId).emit("call:accepted", { conversationId, by: { id: userId }, video });
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
        io.to(rid).emit("call:declined", { conversationId, by: { id: userId } });
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
            io.to(rid).emit("message:notify", {
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
        io.to(rid).emit("call:ended", { conversationId, by: { id: userId } });
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
            io.to(rid).emit("message:notify", {
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
            io.to(rid).emit("message:notify", {
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
      if (!isGroup) return; // Только для групповых звонков
      
      // Убеждаемся, что сокет присоединен к комнате беседы для получения событий
      socket.join(conversationId);
      
      // Отмечаем звонок как принятый ТОЛЬКО когда присоединился кто-то кроме инициатора
      const st = callState.get(conversationId);
      if (st && !st.accepted && userId !== st.inviterId) {
        callState.set(conversationId, { ...st, accepted: true });
      }
      
      let callInfo = activeGroupCalls.get(conversationId);
      const isFirstParticipant = !callInfo;
      
      if (!callInfo) {
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
                io.to(p.userId).emit("message:notify", { conversationId, messageId: msg.id, senderId: userId });
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
        
        callInfo = { startedAt: callState.get(conversationId)?.startedAt ?? Date.now(), participants: new Set<string>() };
        activeGroupCalls.set(conversationId, callInfo);
      }

      // На всякий случай повторно читаем обновленную запись (map может вернуть новый объект)
      callInfo = activeGroupCalls.get(conversationId) ?? callInfo;
      if (!callInfo) {
        logger.warn({ conversationId, userId }, "call:room:join missing callInfo after initialization");
        return;
      }

      callInfo.participants.add(userId);
      logger.info({ conversationId, userId, isFirstParticipant }, "User added to activeGroupCalls participants");

      // Обновляем состояние звонка для всех участников
      broadcastCallStatus(conversationId);
    });

    socket.on("call:room:leave", async ({ conversationId }) => {
      const callInfo = activeGroupCalls.get(conversationId);
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
      
      callInfo.participants.delete(userId);
      
      if (callInfo.participants.size === 0) {
        activeGroupCalls.delete(conversationId);
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
                io.to(p.userId).emit("message:notify", { conversationId, messageId: msg.id, senderId: userId });
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
      } else {
      broadcastCallStatus(conversationId);
      }
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
            participants: Array.from(callInfo.participants),
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
      
      // Удаляем пользователя из всех активных звонков
      for (const [conversationId, callInfo] of activeGroupCalls.entries()) {
        if (callInfo.participants.has(userId)) {
          callInfo.participants.delete(userId);
          if (callInfo.participants.size === 0) {
            activeGroupCalls.delete(conversationId);
          }
          // Отправляем обновленный статус
          broadcastCallStatus(conversationId);
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
    });
  });

  return io;
}

export function getIO() {
  return ioInstance;
}

