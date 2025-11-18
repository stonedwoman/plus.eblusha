"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.initSocket = initSocket;
exports.getIO = getIO;
const socket_io_1 = require("socket.io");
const prisma_1 = __importDefault(require("../lib/prisma"));
const jwt_1 = require("../utils/jwt");
const logger_1 = __importDefault(require("../config/logger"));
let ioInstance = null;
// Track call state per conversation to detect missed calls
const callState = new Map();
// Track active group calls: conversationId -> { startedAt: number, participants: Set<string> }
const activeGroupCalls = new Map();
let statusInterval = null;
function initSocket(server) {
    const io = new socket_io_1.Server(server, {
        cors: {
            origin: process.env.CLIENT_URL ?? true,
            credentials: true,
        },
    });
    ioInstance = io;
    // Helper function to format time as "в HH:mm" in server's local timezone
    // Uses system timezone or TZ environment variable if set
    const formatTime = (date = new Date()) => {
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
    const broadcastCallStatus = (conversationId) => {
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
            if (!io)
                return;
            for (const conversationId of activeGroupCalls.keys()) {
                broadcastCallStatus(conversationId);
            }
        }, 1000);
    }
    io.use(async (socket, next) => {
        try {
            const queryToken = (() => {
                const q = socket.handshake.query;
                const t = q?.token;
                if (typeof t === "string")
                    return t;
                if (Array.isArray(t) && typeof t[0] === "string")
                    return t[0];
                return undefined;
            })();
            const token = socket.handshake.auth?.token ?? queryToken;
            if (!token) {
                next(new Error("Unauthorized"));
                return;
            }
            const payload = (0, jwt_1.verifyAccessToken)(token);
            socket.data.userId = payload.sub;
            await prisma_1.default.user.update({
                where: { id: payload.sub },
                data: { status: "ONLINE", lastSeenAt: new Date() },
            });
            next();
        }
        catch (error) {
            logger_1.default.warn({ error }, "Socket auth failed");
            next(new Error("Unauthorized"));
        }
    });
    io.on("connection", (socket) => {
        const userId = socket.data.userId;
        logger_1.default.info({ userId }, "Socket connected");
        // Join personal room to receive direct events
        socket.join(userId);
        io.emit("presence:update", { userId, status: "ONLINE" });
        socket.on("conversation:join", async (conversationId) => {
            const membership = await prisma_1.default.conversationParticipant.findFirst({
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
                const conv = await prisma_1.default.conversation.findUnique({
                    where: { id: conversationId },
                    include: { participants: true },
                });
                if (!conv || !conv.isSecret) {
                    return;
                }
                if (conv.secretStatus === "CANCELLED")
                    return;
                const isMember = conv.participants.some((p) => p.userId === userId);
                if (!isMember)
                    return;
                const device = await prisma_1.default.userDevice.findUnique({
                    where: { id: deviceId },
                    select: { id: true, userId: true, revokedAt: true },
                });
                if (!device || device.userId !== userId || device.revokedAt) {
                    return;
                }
                const updated = await prisma_1.default.conversation.update({
                    where: { id: conversationId },
                    data: {
                        secretStatus: "ACTIVE",
                        secretPeerDeviceId: deviceId,
                    },
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
            }
            catch (error) {
                logger_1.default.error({ error, conversationId, userId }, "Failed to accept secret chat");
            }
        });
        socket.on("secret:chat:decline", async ({ conversationId }) => {
            try {
                const conv = await prisma_1.default.conversation.findUnique({
                    where: { id: conversationId },
                    include: { participants: true },
                });
                if (!conv || !conv.isSecret) {
                    return;
                }
                if (conv.secretStatus === "CANCELLED")
                    return;
                const isMember = conv.participants.some((p) => p.userId === userId);
                if (!isMember)
                    return;
                await prisma_1.default.conversation.update({
                    where: { id: conversationId },
                    data: { secretStatus: "CANCELLED" },
                });
                const recipients = conv.participants.map((p) => p.userId);
                for (const rid of recipients) {
                    io.to(rid).emit("conversations:deleted", { conversationId });
                }
            }
            catch (error) {
                logger_1.default.error({ error, conversationId, userId }, "Failed to decline secret chat");
            }
        });
        socket.on("secret:chat:offer", async ({ conversationId }) => {
            try {
                const conv = await prisma_1.default.conversation.findUnique({
                    where: { id: conversationId },
                    include: { participants: true },
                });
                if (!conv) {
                    logger_1.default.warn({ conversationId, userId }, "Conversation not found in secret:chat:offer");
                    return;
                }
                // Only secret 1:1 conversations are eligible
                const isSecret = conv.isSecret;
                if (!isSecret || conv.isGroup) {
                    logger_1.default.warn({ conversationId, userId, isSecret, isGroup: conv.isGroup }, "Conversation is not a secret 1:1 chat in secret:chat:offer");
                    return;
                }
                const isMember = conv.participants.some((p) => p.userId === userId);
                if (!isMember) {
                    logger_1.default.warn({ conversationId, userId }, "User is not a member of conversation in secret:chat:offer");
                    return;
                }
                const recipient = conv.participants.find((p) => p.userId !== userId);
                if (!recipient) {
                    logger_1.default.warn({ conversationId, userId }, "No recipient found for secret:chat:offer");
                    return;
                }
                const caller = await prisma_1.default.user.findUnique({
                    where: { id: userId },
                    select: { displayName: true, username: true },
                });
                const name = caller?.displayName ?? caller?.username ?? "пользователь";
                io.to(recipient.userId).emit("secret:chat:offer", {
                    conversationId,
                    from: { id: userId, name, deviceId: conv.secretInitiatorDeviceId ?? null },
                });
            }
            catch (error) {
                logger_1.default.error({ error, conversationId, userId }, "Failed to handle secret:chat:offer");
            }
        });
        // emit receipts updates to conversation room when someone marks messages as read
        // We hook into Prisma write in API route, but as a fallback we can expose an event here if needed later
        socket.on("call:invite", async ({ conversationId, video }) => {
            const conv = await prisma_1.default.conversation.findUnique({
                where: { id: conversationId },
                include: { participants: true },
            });
            if (!conv) {
                logger_1.default.warn({ conversationId, userId }, "Conversation not found in call:invite");
                return;
            }
            const isMember = conv.participants.some((p) => p.userId === userId);
            if (!isMember) {
                logger_1.default.warn({ conversationId, userId }, "User is not a member of conversation in call:invite");
                return;
            }
            const recipients = conv.participants
                .map((p) => p.userId)
                .filter((id) => id !== userId);
            const caller = await prisma_1.default.user.findUnique({ where: { id: userId }, select: { displayName: true, username: true } });
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
                    activeGroupCalls.set(conversationId, { startedAt, participants: new Set() });
                }
                else {
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
                    const msg = await prisma_1.default.message.create({
                        data: {
                            conversationId,
                            senderId: userId,
                            type: "SYSTEM",
                            content: `${name} начал ${callTypeText} ${formatTime(now)}`,
                            metadata: { started: true, video },
                        },
                    });
                    // Отправляем событие о новом сообщении всем участникам беседы через комнату
                    io.to(conversationId).emit("message:new", { conversationId, messageId: msg.id, senderId: userId });
                    // Также отправляем message:notify для каждого участника отдельно (кроме отправителя)
                    for (const rid of recipients) {
                        io.to(rid).emit("message:notify", { conversationId, messageId: msg.id, senderId: userId });
                    }
                    logger_1.default.info({ conversationId, userId, video, messageId: msg.id, isGroup, participantsCount: conv.participants.length }, "Call started message created in call:invite");
                }
                catch (error) {
                    logger_1.default.error({ error, conversationId, userId, video, isGroup }, "Failed to create call started message in call:invite");
                }
            }
            // Для 1:1 звонков отправляем событие входящего звонка получателям
            // Для групповых звонков это не нужно, так как они видят активный звонок через call:status
            if (!isGroup) {
                for (const rid of recipients) {
                    io.to(rid).emit("call:incoming", { conversationId, from: { id: userId, name }, video });
                }
            }
            if (isGroup) {
                broadcastCallStatus(conversationId);
            }
        });
        socket.on("call:accept", async ({ conversationId, video }) => {
            const conv = await prisma_1.default.conversation.findUnique({
                where: { id: conversationId },
                include: { participants: true },
            });
            if (!conv)
                return;
            const recipients = conv.participants.map((p) => p.userId).filter((id) => id !== userId);
            const st = callState.get(conversationId);
            if (st)
                callState.set(conversationId, { ...st, accepted: true });
            for (const rid of recipients) {
                io.to(rid).emit("call:accepted", { conversationId, by: { id: userId }, video });
            }
        });
        socket.on("call:decline", async ({ conversationId }) => {
            const conv = await prisma_1.default.conversation.findUnique({
                where: { id: conversationId },
                include: { participants: true },
            });
            if (!conv)
                return;
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
                const durationText = hours > 0
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
                if (st)
                    callState.delete(conversationId);
                activeGroupCalls.delete(conversationId);
                try {
                    const msg = await prisma_1.default.message.create({
                        data: {
                            conversationId,
                            senderId,
                            type: "SYSTEM",
                            content: `Звонок продлился ${durationText} и был завершён`,
                            metadata: { ended: true, video: !!st?.video, duration: elapsedMs },
                        },
                    });
                    io.to(conversationId).emit("message:new", { conversationId, messageId: msg.id, senderId });
                    for (const rid of recipients) {
                        io.to(rid).emit("message:notify", { conversationId, messageId: msg.id, senderId });
                    }
                }
                catch (error) {
                    logger_1.default.warn({ error }, "Failed to create group decline end message");
                }
                io.to(conversationId).emit("call:status", { conversationId, active: false });
                return;
            }
            // treat as missed call if not accepted yet (1:1)
            if (st && !st.accepted) {
                callState.delete(conversationId);
                try {
                    const now = new Date();
                    const msg = await prisma_1.default.message.create({
                        data: {
                            conversationId,
                            senderId: st.inviterId,
                            type: "SYSTEM",
                            content: `Пропущенный звонок ${formatTime(now)}`,
                            metadata: { missed: true, video: !!st.video },
                        },
                    });
                    // Mark as read for inviter only
                    await prisma_1.default.messageReceipt.create({ data: { messageId: msg.id, userId: st.inviterId, status: "READ" } });
                    io.to(conversationId).emit("message:new", { conversationId, messageId: msg.id, senderId: st.inviterId });
                }
                catch (error) {
                    logger_1.default.warn({ error }, "Failed to create missed call message");
                }
            }
        });
        socket.on("call:end", async ({ conversationId }) => {
            const conv = await prisma_1.default.conversation.findUnique({
                where: { id: conversationId },
                include: { participants: true },
            });
            if (!conv)
                return;
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
                const durationText = hours > 0
                    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
                    : `${minutes}:${String(seconds).padStart(2, "0")}`;
                return { elapsedMs, durationText };
            };
            if (isGroup) {
                const { elapsedMs, durationText } = computeDuration();
                try {
                    const msg = await prisma_1.default.message.create({
                        data: {
                            conversationId,
                            senderId: userId,
                            type: "SYSTEM",
                            content: `Звонок продлился ${durationText} и был завершён`,
                            metadata: { ended: true, video: !!st?.video, duration: elapsedMs },
                        },
                    });
                    io.to(conversationId).emit("message:new", { conversationId, messageId: msg.id, senderId: userId });
                    for (const rid of recipients) {
                        io.to(rid).emit("message:notify", { conversationId, messageId: msg.id, senderId: userId });
                    }
                }
                catch (error) {
                    logger_1.default.warn({ conversationId, error }, "Failed to create group call end message");
                }
                activeGroupCalls.delete(conversationId);
                callState.delete(conversationId);
                io.to(conversationId).emit("call:status", { conversationId, active: false });
                return;
            }
            const caller = await prisma_1.default.user.findUnique({ where: { id: userId }, select: { displayName: true, username: true } });
            const name = caller?.displayName ?? caller?.username ?? "пользователь";
            if (st && !st.accepted) {
                // Пропущенный звонок (не был принят)
                callState.delete(conversationId);
                try {
                    const now = new Date();
                    const msg = await prisma_1.default.message.create({
                        data: {
                            conversationId,
                            senderId: st.inviterId,
                            type: "SYSTEM",
                            content: `Пропущенный звонок ${formatTime(now)}`,
                            metadata: { missed: true, video: !!st.video },
                        },
                    });
                    await prisma_1.default.messageReceipt.create({ data: { messageId: msg.id, userId: st.inviterId, status: "READ" } });
                    io.to(conversationId).emit("message:new", { conversationId, messageId: msg.id, senderId: st.inviterId });
                }
                catch { }
            }
            else if (st && st.accepted) {
                // Завершенный активный звонок - создаем сообщение о завершении
                callState.delete(conversationId);
                try {
                    const { elapsedMs, durationText } = computeDuration();
                    const msg = await prisma_1.default.message.create({
                        data: {
                            conversationId,
                            senderId: userId,
                            type: "SYSTEM",
                            content: `Звонок продлился ${durationText} и был завершён`,
                            metadata: { ended: true, video: !!st.video, duration: elapsedMs },
                        },
                    });
                    io.to(conversationId).emit("message:new", { conversationId, messageId: msg.id, senderId: userId });
                    for (const rid of recipients) {
                        io.to(rid).emit("message:notify", { conversationId, messageId: msg.id, senderId: userId });
                    }
                }
                catch (error) {
                    logger_1.default.warn({ error }, "Failed to create call ended message");
                }
            }
            else {
                callState.delete(conversationId);
            }
            broadcastCallStatus(conversationId);
        });
        socket.on("call:room:join", async ({ conversationId, video }) => {
            const conv = await prisma_1.default.conversation.findUnique({
                where: { id: conversationId },
                include: { participants: true },
            });
            if (!conv)
                return;
            const isMember = conv.participants.some((p) => p.userId === userId);
            if (!isMember)
                return;
            const isGroup = !!conv.isGroup;
            logger_1.default.info({ conversationId, userId, isGroup, participantCount: conv.participants.length }, "call:room:join received");
            if (!isGroup)
                return; // Только для групповых звонков
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
                    const caller = await prisma_1.default.user.findUnique({ where: { id: userId }, select: { displayName: true, username: true } });
                    const name = caller?.displayName ?? caller?.username ?? "пользователь";
                    // Используем переданный video или по умолчанию false
                    const callVideo = video ?? false;
                    const startedAt = Date.now();
                    callState.set(conversationId, { inviterId: userId, accepted: true, video: callVideo, startedAt });
                    // Создаем системное сообщение о начале звонка
                    try {
                        const callTypeText = callVideo ? "звонок с видео" : "звонок";
                        const now = new Date();
                        const msg = await prisma_1.default.message.create({
                            data: {
                                conversationId,
                                senderId: userId,
                                type: "SYSTEM",
                                content: `${name} начал ${callTypeText} ${formatTime(now)}`,
                                metadata: { started: true, video: callVideo },
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
                        logger_1.default.info({ conversationId, userId, video: callVideo, messageId: msg.id }, "Call started message created in call:room:join (no callState)");
                    }
                    catch (error) {
                        logger_1.default.error({ error, conversationId, userId, video: callVideo }, "Failed to create call started message in call:room:join");
                    }
                }
                else {
                    // callState существует, значит сообщение уже создано в call:invite
                    logger_1.default.info({ conversationId, userId, hasCallState: true }, "Call state exists, message should already be created in call:invite");
                }
                callInfo = { startedAt: callState.get(conversationId)?.startedAt ?? Date.now(), participants: new Set() };
                activeGroupCalls.set(conversationId, callInfo);
            }
            // На всякий случай повторно читаем обновленную запись (map может вернуть новый объект)
            callInfo = activeGroupCalls.get(conversationId) ?? callInfo;
            if (!callInfo) {
                logger_1.default.warn({ conversationId, userId }, "call:room:join missing callInfo after initialization");
                return;
            }
            callInfo.participants.add(userId);
            logger_1.default.info({ conversationId, userId, isFirstParticipant }, "User added to activeGroupCalls participants");
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
                logger_1.default.info({ conversationId, userId }, "call:room:leave without callInfo — treated as no active participants");
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
                    const msg = await prisma_1.default.message.create({
                        data: {
                            conversationId,
                            senderId: userId,
                            type: "SYSTEM",
                            content: `Звонок продлился ${durationText} и был завершён`,
                            metadata: { ended: true, video: !!st?.video, duration: elapsedMs },
                        },
                    });
                    io.to(conversationId).emit("message:new", { conversationId, messageId: msg.id, senderId: userId });
                    const conv = await prisma_1.default.conversation.findUnique({
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
                    logger_1.default.info({ conversationId, userId, messageId: msg.id, duration: elapsedMs }, "Group call duration message created in call:room:leave");
                    callState.delete(conversationId);
                }
                catch (error) {
                    logger_1.default.warn({ error, conversationId, userId }, "Failed to create call ended message on room leave");
                }
                io.to(conversationId).emit("call:status", {
                    conversationId,
                    active: false,
                });
                logger_1.default.info({ conversationId, userId }, "Call status set to inactive in call:room:leave (no participants remain)");
            }
            else {
                broadcastCallStatus(conversationId);
            }
        });
        socket.on("call:status:request", async ({ conversationIds }) => {
            if (!Array.isArray(conversationIds) || conversationIds.length === 0)
                return;
            const statuses = {};
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
                }
                else {
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
            logger_1.default.info({ userId, reason }, "Socket disconnecting");
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
            // Проверяем, есть ли еще активные соединения для этого пользователя
            // На момент disconnecting сокет еще находится в комнате userId,
            // поэтому проверяем, есть ли там другие сокеты кроме текущего
            const userRoom = io.sockets.adapter.rooms.get(userId);
            const hasOtherConnections = userRoom && userRoom.size > 1;
            // Устанавливаем OFFLINE только если нет других активных соединений
            if (!hasOtherConnections) {
                await prisma_1.default.user.update({
                    where: { id: userId },
                    data: { status: "OFFLINE", lastSeenAt: new Date() },
                });
                io.emit("presence:update", { userId, status: "OFFLINE" });
                logger_1.default.info({ userId }, "User status set to OFFLINE (no active connections)");
            }
            else {
                logger_1.default.info({ userId, activeConnections: userRoom.size - 1 }, "User still has active connections, status remains ONLINE");
            }
        });
        socket.on("disconnect", (reason) => {
            logger_1.default.info({ userId, reason }, "Socket disconnected");
        });
    });
    return io;
}
function getIO() {
    return ioInstance;
}
//# sourceMappingURL=socket.js.map