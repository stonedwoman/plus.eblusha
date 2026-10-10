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

/** Минимум socket.io-клиента, который нам нужен (подменяется в тестах). */
export type SocketLike = Pick<Socket, "on" | "emit" | "connect" | "disconnect" | "connected" | "active">;
export type SocketFactory = (url: string, opts: Parameters<typeof io>[1]) => SocketLike;

export interface RealtimeOptions {
  connect?: SocketFactory;
  /** Первая пауза перед ручным переподключением, мс (дальше — вдвое, до 2 минут). */
  manualRetryMs?: number;
}

const MANUAL_RETRY_MAX_MS = 120_000;

export class Realtime implements RealtimeOut {
  private socket: SocketLike | null = null;
  private presenceTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private retryMs: number;
  private stopped = false;
  private readonly connectFn: SocketFactory;

  constructor(
    private readonly baseUrl: string,
    private readonly getToken: () => Promise<string>,
    private readonly handlers: RealtimeHandlers,
    private readonly log: Logger,
    private readonly opts: RealtimeOptions = {}
  ) {
    this.connectFn = opts.connect ?? ((url, o) => io(url, o));
    this.retryMs = opts.manualRetryMs ?? 5000;
  }

  get connected(): boolean {
    return this.socket?.connected ?? false;
  }

  /**
   * socket.io-клиент сам переподключается после обрыва связи, но НЕ после отказа сервера:
   * отказ в рукопожатии (middleware: «Unauthorized» — например, токен не обновился, пока backend
   * поднимался) и «io server disconnect». Тогда socket.active === false и без ручного connect()
   * бот оглох бы навсегда. Повторяем сами, с паузой (5 с → … → 2 мин).
   */
  private scheduleManualReconnect(why: string): void {
    if (this.stopped || this.retryTimer || !this.socket) return;
    const delay = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, MANUAL_RETRY_MAX_MS);
    this.log.warn("socket.manual_reconnect", { why, inMs: delay });
    // Таймер НЕ unref: пока сокета нет, других дел у процесса может не быть.
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      const s = this.socket;
      if (!this.stopped && s && !s.connected && !s.active) s.connect();
    }, delay);
  }

  start(): void {
    this.stopped = false;
    const socket = this.connectFn(this.baseUrl, {
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
      this.retryMs = this.opts.manualRetryMs ?? 5000;
      this.sendPresence();
      this.handlers.onConnect();
    });
    socket.on("disconnect", (reason) => {
      this.log.warn("socket.disconnected", { reason });
      this.handlers.onDisconnect();
      // «io server disconnect»: сервер выкинул сокет — сам клиент больше не попробует.
      if (reason !== "io client disconnect" && !socket.active) this.scheduleManualReconnect(String(reason));
    });
    socket.on("connect_error", (e) => {
      this.log.warn("socket.connect_error", { err: e, active: socket.active });
      if (!socket.active) this.scheduleManualReconnect("rejected");
    });

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
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.presenceTimer) clearInterval(this.presenceTimer);
    this.presenceTimer = null;
    this.socket?.disconnect();
    this.socket = null;
  }
}
