/**
 * socket.io под токеном бота (src/realtime/socket.ts на сервере).
 *
 * - Бот сидит в комнате user:<botId> автоматически: туда приходят message:notify с полным
 *   сообщением по всем его беседам, conversations:*, contacts:request:new, secret:*, call:incoming.
 *   В комнаты бесед (conversation:join) бот НЕ входит: чужие правки/реакции ему не нужны,
 *   а typing_* сервер принимает от любого участника и без входа в комнату.
 * - Токен проверяется только при рукопожатии, поэтому auth передаём функцией: после
 *   переподключения уйдёт свежий токен.
 * - Все emit с объектом-аргументом шлём объектом (пустой emit роняет обработчики с деструктуризацией).
 * - presence:state раз в минуту, иначе статус «в фоне» (TTL активности 120 с).
 */
import { io, type Socket } from "socket.io-client";
import type { Logger } from "../log";
import type { EbMessage } from "./types";

export interface RealtimeHandlers {
  onMessage(p: { conversationId: string; messageId: string; senderId: string; message?: EbMessage }): void;
  onConversationsChanged(p: { conversationId: string; kind: "new" | "updated" | "deleted" }): void;
  onSecretThread(p: { conversationId: string; fromUserId?: string }): void;
  onContactRequest(p: { contactId: string; fromUserId: string }): void;
  onIncomingCall(p: { conversationId: string; fromUserId: string }): void;
  onConnect(): void;
  onDisconnect(): void;
}

/** Что ядро шлёт обратно. Интерфейс — ради заглушек в тестах. */
export interface RealtimeOut {
  typingStart(conversationId: string): void;
  typingPing(conversationId: string): void;
  typingStop(conversationId: string): void;
  declineCall(conversationId: string): void;
}

export class Realtime implements RealtimeOut {
  private socket: Socket | null = null;
  private presenceTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly getToken: () => Promise<string>,
    private readonly handlers: RealtimeHandlers,
    private readonly log: Logger
  ) {}

  get connected(): boolean {
    return this.socket?.connected ?? false;
  }

  start(): void {
    const socket = io(this.baseUrl, {
      path: "/socket.io/",
      transports: ["websocket"],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 30_000,
      auth: (cb) => {
        this.getToken()
          .then((token) => cb({ token }))
          .catch((e: unknown) => {
            this.log.warn("socket.token_failed", { err: e as Error });
            cb({ token: "" });
          });
      },
    });
    this.socket = socket;

    socket.on("connect", () => {
      this.log.info("socket.connected");
      this.sendPresence();
      this.handlers.onConnect();
    });
    socket.on("disconnect", (reason) => {
      this.log.warn("socket.disconnected", { reason });
      this.handlers.onDisconnect();
    });
    socket.on("connect_error", (e) => this.log.warn("socket.connect_error", { err: e }));

    socket.on("message:notify", (p: { conversationId: string; messageId: string; senderId: string; message?: EbMessage }) => {
      if (!p || typeof p.conversationId !== "string") return;
      this.handlers.onMessage(p);
    });
    socket.on("conversations:new", (p: { conversationId?: string }) => {
      if (p?.conversationId) this.handlers.onConversationsChanged({ conversationId: p.conversationId, kind: "new" });
    });
    socket.on("conversations:updated", (p: { conversationId?: string }) => {
      if (p?.conversationId) this.handlers.onConversationsChanged({ conversationId: p.conversationId, kind: "updated" });
    });
    socket.on("conversations:deleted", (p: { conversationId?: string }) => {
      if (p?.conversationId) this.handlers.onConversationsChanged({ conversationId: p.conversationId, kind: "deleted" });
    });
    socket.on("secret:thread:created", (p: { threadId?: string }) => {
      if (p?.threadId) this.handlers.onSecretThread({ conversationId: p.threadId });
    });
    socket.on("secret:chat:offer", (p: { conversationId?: string; from?: { id?: string } }) => {
      if (p?.conversationId) {
        this.handlers.onSecretThread({
          conversationId: p.conversationId,
          ...(p.from?.id ? { fromUserId: p.from.id } : {}),
        });
      }
    });
    socket.on("contacts:request:new", (p: { contactId?: string; from?: { id?: string } }) => {
      if (p?.contactId && p.from?.id) this.handlers.onContactRequest({ contactId: p.contactId, fromUserId: p.from.id });
    });
    socket.on("call:incoming", (p: { conversationId?: string; from?: { id?: string } }) => {
      if (p?.conversationId) this.handlers.onIncomingCall({ conversationId: p.conversationId, fromUserId: p.from?.id ?? "" });
    });

    this.presenceTimer = setInterval(() => this.sendPresence(), 60_000);
    this.presenceTimer.unref?.();
  }

  private sendPresence(): void {
    this.socket?.emit("presence:state", { active: true, visibility: "visible", source: "web" });
  }

  typingStart(conversationId: string): void {
    this.socket?.emit("typing_start", conversationId);
  }
  typingPing(conversationId: string): void {
    this.socket?.emit("typing_ping", conversationId);
  }
  typingStop(conversationId: string): void {
    this.socket?.emit("typing_stop", conversationId);
  }
  declineCall(conversationId: string): void {
    this.socket?.emit("call:decline", { conversationId });
  }

  stop(): void {
    if (this.presenceTimer) clearInterval(this.presenceTimer);
    this.presenceTimer = null;
    this.socket?.disconnect();
    this.socket = null;
  }
}
