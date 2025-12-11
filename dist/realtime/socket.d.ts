import type { Server as HttpServer } from "http";
import { Server } from "socket.io";
type ServerToClientEvents = {
    "presence:update": (payload: {
        userId: string;
        status: string;
    }) => void;
    "message:new": (payload: {
        conversationId: string;
        messageId: string;
        senderId: string;
        message?: any;
    }) => void;
    "receipts:update": (payload: {
        conversationId: string;
        messageIds: string[];
    }) => void;
    "message:update": (payload: {
        conversationId: string;
        messageId: string;
        reason: string;
    }) => void;
    "message:notify": (payload: {
        conversationId: string;
        messageId: string;
        senderId: string;
        message?: any;
    }) => void;
    "message:reaction": (payload: {
        conversationId: string;
        messageId: string;
        senderId: string;
    }) => void;
    "contacts:removed": (payload: {
        contactId: string;
    }) => void;
    "profile:update": (payload: {
        userId: string;
        avatarUrl?: string | null;
        displayName?: string | null;
    }) => void;
    "conversation:typing": (payload: {
        conversationId: string;
        userId: string;
        typing: boolean;
    }) => void;
    "contacts:request:new": (payload: {
        contactId: string;
        from: {
            id: string;
            username: string;
        };
    }) => void;
    "contacts:request:accepted": (payload: {
        contactId: string;
    }) => void;
    "contacts:request:blocked": (payload: {
        contactId: string;
    }) => void;
    "conversations:new": (payload: {
        conversationId: string;
    }) => void;
    "conversations:updated": (payload: {
        conversationId: string;
        conversation?: any;
    }) => void;
    "conversations:deleted": (payload: {
        conversationId: string;
    }) => void;
    "call:incoming": (payload: {
        conversationId: string;
        from: {
            id: string;
            name: string;
        };
        video: boolean;
    }) => void;
    "call:accepted": (payload: {
        conversationId: string;
        by: {
            id: string;
        };
        video: boolean;
    }) => void;
    "call:declined": (payload: {
        conversationId: string;
        by: {
            id: string;
        };
    }) => void;
    "call:ended": (payload: {
        conversationId: string;
        by: {
            id: string;
        };
    }) => void;
    "call:status": (payload: {
        conversationId: string;
        active: boolean;
        startedAt?: number;
        elapsedMs?: number;
        participants?: string[];
    }) => void;
    "call:status:bulk": (payload: {
        statuses: Record<string, {
            active: boolean;
            startedAt?: number;
            elapsedMs?: number;
            participants?: string[];
        }>;
    }) => void;
    "secret:chat:offer": (payload: {
        conversationId: string;
        from: {
            id: string;
            name: string;
            deviceId?: string | null;
        };
    }) => void;
    "secret:chat:accepted": (payload: {
        conversationId: string;
        peerDeviceId: string;
    }) => void;
};
type ClientToServerEvents = {
    "conversation:join": (conversationId: string) => void;
    "conversation:leave": (conversationId: string) => void;
    "conversation:typing": (payload: {
        conversationId: string;
        typing: boolean;
    }) => void;
    "call:invite": (payload: {
        conversationId: string;
        video: boolean;
    }) => void;
    "call:accept": (payload: {
        conversationId: string;
        video: boolean;
    }) => void;
    "call:decline": (payload: {
        conversationId: string;
    }) => void;
    "call:end": (payload: {
        conversationId: string;
    }) => void;
    "call:room:join": (payload: {
        conversationId: string;
        video?: boolean;
    }) => void;
    "call:room:leave": (payload: {
        conversationId: string;
    }) => void;
    "call:status:request": (payload: {
        conversationIds: string[];
    }) => void;
    "secret:chat:offer": (payload: {
        conversationId: string;
    }) => void;
    "secret:chat:accept": (payload: {
        conversationId: string;
        deviceId: string;
    }) => void;
    "secret:chat:decline": (payload: {
        conversationId: string;
    }) => void;
    "presence:focus": (payload: {
        focused: boolean;
    }) => void;
};
type InterServerEvents = Record<string, never>;
type SocketData = {
    userId: string;
};
export declare function initSocket(server: HttpServer): Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;
export declare function getIO(): Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData> | null;
export {};
//# sourceMappingURL=socket.d.ts.map