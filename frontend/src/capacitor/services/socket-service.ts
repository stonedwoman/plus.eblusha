import { io, Socket } from 'socket.io-client'
import type {
  MessageNewPayload,
  MessageNotifyPayload,
  ConversationTypingPayload,
  MessageReactionPayload,
  ReceiptsUpdatePayload,
  ConversationNewPayload,
  ConversationUpdatedPayload,
  ConversationDeletedPayload,
  ConversationMemberRemovedPayload,
  PresenceUpdatePayload,
  ContactRequestPayload,
  ContactAcceptedPayload,
  ContactRemovedPayload,
  ProfileUpdatePayload,
  CallIncomingPayload,
  CallAcceptedPayload,
  CallDeclinedPayload,
  CallEndedPayload,
  CallStatusPayload,
  CallStatusBulkPayload,
  CallInvitePayload,
  CallAcceptPayload,
  CallDeclinePayload,
  CallEndPayload,
  CallRoomJoinPayload,
  CallRoomLeavePayload,
  CallStatusRequestPayload,
  ConversationTypingEmitPayload,
} from '../types/socket-events'

export class SocketService {
  private socket: Socket | null = null
  private wsUrl: string
  private accessToken: string | null = null
  private reconnectAttempts = 0
  private maxReconnectAttempts = 10
  private isManuallyDisconnected = false
  private rawListeners = new Map<string, Set<(payload: unknown) => void>>()

  constructor(wsUrl: string) {
    this.wsUrl = wsUrl
  }

  /**
   * Подключение к Socket.IO с JWT токеном
   */
  connect(token: string): void {
    if (this.socket?.connected) {
      console.log('[SocketService] Already connected')
      return
    }

    // Если сокет существует, но не подключен, пересоздаем его
    if (this.socket && !this.socket.connected) {
      console.log('[SocketService] Reconnecting existing socket...')
      this.socket.disconnect()
      this.socket = null
    }

    this.accessToken = token
    this.isManuallyDisconnected = false

    console.log('[SocketService] Connecting to:', this.wsUrl)
    console.log('[SocketService] Token length:', token?.length || 0)

    this.socket = io(this.wsUrl, {
      autoConnect: false,
      transports: ['websocket', 'polling'], // WebSocket + долгие опросы как запасной вариант
      auth: { token },
      query: { token }, // Дублируем токен в query для совместимости
      // Настройки переподключения для мобильных приложений
      reconnection: true,
      reconnectionAttempts: this.maxReconnectAttempts,
      reconnectionDelay: 1000, // Начальная задержка 1 секунда
      reconnectionDelayMax: 10000, // Максимальная задержка 10 секунд
      randomizationFactor: 0.5, // Добавляем случайность для избежания thundering herd
      timeout: 20000, // Таймаут подключения 20 секунд
      // Увеличиваем интервалы ping/pong для мобильных устройств
      // В Socket.IO v4 эти опции находятся в опциях менеджера
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    
    // Настраиваем ping/pong интервалы через менеджер после создания
    if (this.socket.io) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const manager = this.socket.io as any
      if (manager.opts) {
        manager.opts.pingTimeout = 60000 // 60 секунд для ping timeout (увеличено для фонового режима)
        manager.opts.pingInterval = 25000 // Ping каждые 25 секунд
      }
    }

    this.setupEventHandlers()
    this.attachRawListeners()
    this.socket.connect()
    console.log('[SocketService] Connection initiated')
  }

  /**
   * Отключение от Socket.IO
   */
  disconnect(): void {
    this.isManuallyDisconnected = true
    if (this.socket) {
      this.socket.disconnect()
      this.socket = null
    }
    this.accessToken = null
    this.reconnectAttempts = 0
  }

  /**
   * Переподключение (используется при возобновлении приложения)
   */
  reconnect(): void {
    if (!this.accessToken) {
      console.warn('[SocketService] Cannot reconnect: no access token')
      return
    }
    if (this.socket?.connected) {
      console.log('[SocketService] Already connected, skipping reconnect')
      return
    }
    console.log('[SocketService] Manual reconnect requested')
    this.isManuallyDisconnected = false
    if (this.socket) {
      // Если сокет существует, но не подключен, пытаемся переподключиться
      this.socket.connect()
    } else {
      // Если сокета нет, создаем новое подключение
      this.connect(this.accessToken)
    }
  }

  /**
   * Обновление токена (например, после refresh)
   */
  updateToken(token: string): void {
    this.accessToken = token
    if (this.socket) {
      this.socket.auth = { token }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(this.socket.io.opts as any).query = { token }
    }
  }

  /**
   * Проверка подключения
   */
  isConnected(): boolean {
    return this.socket?.connected ?? false
  }

  ensureConnected(): void {
    if (!this.accessToken) {
      console.warn('[SocketService] Cannot ensure connection: no access token')
      return
    }
    if (!this.socket) {
      console.log('[SocketService] ensureConnected -> socket missing, connecting…')
      this.connect(this.accessToken)
      return
    }
    if (this.socket.connected) {
      return
    }
    const isConnecting = (this.socket as any)?.active ?? false
    if (isConnecting) {
      console.log('[SocketService] ensureConnected -> already connecting')
      return
    }
    console.log('[SocketService] ensureConnected -> reconnecting')
    this.reconnect()
  }

  onRaw<T = unknown>(event: string, callback: (payload: T) => void): () => void {
    const rawCallback = callback as (payload: unknown) => void
    const listeners = this.rawListeners.get(event) ?? new Set<(payload: unknown) => void>()
    const alreadyBound = listeners.has(rawCallback)

    if (!alreadyBound) {
      listeners.add(rawCallback)
      this.rawListeners.set(event, listeners)
      this.socket?.on(event, rawCallback)
    }

    return () => {
      const current = this.rawListeners.get(event)
      current?.delete(rawCallback)
      if (current && current.size === 0) {
        this.rawListeners.delete(event)
      }
      this.socket?.off(event, rawCallback)
    }
  }

  emitRaw(event: string, payload: unknown): void {
    if (!this.socket?.connected) {
      console.warn(`[SocketService] Socket not connected, cannot emit ${event}`)
      return
    }
    this.socket.emit(event, payload)
  }

  /**
   * Настройка обработчиков событий подключения
   */
  private setupEventHandlers(): void {
    if (!this.socket) return

    this.socket.on('connect', () => {
      console.log('[SocketService] ✅ Connected successfully')
      this.reconnectAttempts = 0
    })

    this.socket.on('disconnect', (reason) => {
      console.log('[SocketService] ❌ Disconnected:', reason)
      
      // Если это не ручное отключение и не из-за ошибки сервера, пытаемся переподключиться
      if (!this.isManuallyDisconnected && reason !== 'io server disconnect') {
        console.log('[SocketService] Will attempt to reconnect...')
      }
    })

    this.socket.on('connect_error', (error) => {
      console.error('[SocketService] ❌ Connection error:', error)
      console.error('[SocketService] Error message:', error.message)
      
      // Не увеличиваем счетчик, если это ручное отключение
      if (!this.isManuallyDisconnected) {
        this.reconnectAttempts++
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
          console.error('[SocketService] Max reconnect attempts reached')
          // Не останавливаем переподключение полностью, но логируем
        }
      }
    })

    // Обработка успешного переподключения
    this.socket.io.on('reconnect', (attemptNumber) => {
      console.log(`[SocketService] ✅ Reconnected after ${attemptNumber} attempts`)
      this.reconnectAttempts = 0
    })

    // Обновляем токен при попытках реконнекта
    this.socket.io.on('reconnect_attempt', (attemptNumber) => {
      console.log(`[SocketService] 🔄 Reconnect attempt ${attemptNumber}/${this.maxReconnectAttempts}`)
      if (this.accessToken) {
        this.socket!.auth = { token: this.accessToken }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(this.socket!.io.opts as any).query = { token: this.accessToken }
      }
    })

    // Обработка ошибки переподключения
    this.socket.io.on('reconnect_error', (error) => {
      console.error('[SocketService] ❌ Reconnect error:', error)
    })

    // Обработка окончания попыток переподключения
    this.socket.io.on('reconnect_failed', () => {
      console.error('[SocketService] ❌ Reconnect failed after all attempts')
      // Можно попробовать переподключиться вручную позже
    })
  }

  private attachRawListeners(): void {
    if (!this.socket) return
    for (const [event, listeners] of this.rawListeners.entries()) {
      for (const listener of listeners) {
        this.socket.on(event, listener)
      }
    }
  }

  // ========== Подписки на события (от сервера) ==========

  onMessageNew(callback: (payload: MessageNewPayload) => void): () => void {
    if (!this.socket) return () => {}
    this.socket.on('message:new', callback)
    return () => this.socket?.off('message:new', callback)
  }

  onMessageNotify(callback: (payload: MessageNotifyPayload) => void): () => void {
    if (!this.socket) return () => {}
    this.socket.on('message:notify', callback)
    return () => this.socket?.off('message:notify', callback)
  }

  onConversationTyping(callback: (payload: ConversationTypingPayload) => void): () => void {
    if (!this.socket) return () => {}
    this.socket.on('conversation:typing', callback)
    return () => this.socket?.off('conversation:typing', callback)
  }

  onMessageReaction(callback: (payload: MessageReactionPayload) => void): () => void {
    if (!this.socket) return () => {}
    this.socket.on('message:reaction', callback)
    return () => this.socket?.off('message:reaction', callback)
  }

  onReceiptsUpdate(callback: (payload: ReceiptsUpdatePayload) => void): () => void {
    if (!this.socket) return () => {}
    this.socket.on('receipts:update', callback)
    return () => this.socket?.off('receipts:update', callback)
  }

  onConversationNew(callback: (payload: ConversationNewPayload) => void): () => void {
    if (!this.socket) return () => {}
    this.socket.on('conversations:new', callback)
    return () => this.socket?.off('conversations:new', callback)
  }

  onConversationUpdated(callback: (payload: ConversationUpdatedPayload) => void): () => void {
    if (!this.socket) return () => {}
    this.socket.on('conversations:updated', callback)
    return () => this.socket?.off('conversations:updated', callback)
  }

  onConversationDeleted(callback: (payload: ConversationDeletedPayload) => void): () => void {
    if (!this.socket) return () => {}
    this.socket.on('conversations:deleted', callback)
    return () => this.socket?.off('conversations:deleted', callback)
  }

  onConversationMemberRemoved(callback: (payload: ConversationMemberRemovedPayload) => void): () => void {
    if (!this.socket) return () => {}
    this.socket.on('conversations:member:removed', callback)
    return () => this.socket?.off('conversations:member:removed', callback)
  }

  onPresenceUpdate(callback: (payload: PresenceUpdatePayload) => void): () => void {
    if (!this.socket) return () => {}
    this.socket.on('presence:update', callback)
    return () => this.socket?.off('presence:update', callback)
  }

  onContactRequest(callback: (payload: ContactRequestPayload) => void): () => void {
    if (!this.socket) return () => {}
    this.socket.on('contacts:request:new', callback)
    return () => this.socket?.off('contacts:request:new', callback)
  }

  onContactAccepted(callback: (payload: ContactAcceptedPayload) => void): () => void {
    if (!this.socket) return () => {}
    this.socket.on('contacts:request:accepted', callback)
    return () => this.socket?.off('contacts:request:accepted', callback)
  }

  onContactRemoved(callback: (payload: ContactRemovedPayload) => void): () => void {
    if (!this.socket) return () => {}
    this.socket.on('contacts:removed', callback)
    return () => this.socket?.off('contacts:removed', callback)
  }

  onProfileUpdate(callback: (payload: ProfileUpdatePayload) => void): () => void {
    if (!this.socket) return () => {}
    this.socket.on('profile:update', callback)
    return () => this.socket?.off('profile:update', callback)
  }

  // ========== Звонки ==========

  onCallIncoming(callback: (payload: CallIncomingPayload) => void): () => void {
    return this.onRaw('call:incoming', callback)
  }

  onCallAccepted(callback: (payload: CallAcceptedPayload) => void): () => void {
    return this.onRaw('call:accepted', callback)
  }

  onCallDeclined(callback: (payload: CallDeclinedPayload) => void): () => void {
    return this.onRaw('call:declined', callback)
  }

  onCallEnded(callback: (payload: CallEndedPayload) => void): () => void {
    return this.onRaw('call:ended', callback)
  }

  onCallStatus(callback: (payload: CallStatusPayload) => void): () => void {
    return this.onRaw('call:status', callback)
  }

  onCallStatusBulk(callback: (payload: CallStatusBulkPayload) => void): () => void {
    return this.onRaw('call:status:bulk', callback)
  }

  // ========== Отправка событий (к серверу) ==========

  emitConversationTyping(payload: ConversationTypingEmitPayload): void {
    this.emitRaw('conversation:typing', payload)
  }

  emitCallInvite(payload: CallInvitePayload): void {
    this.emitRaw('call:invite', payload)
  }

  emitCallAccept(payload: CallAcceptPayload): void {
    this.emitRaw('call:accept', payload)
  }

  emitCallDecline(payload: CallDeclinePayload): void {
    this.emitRaw('call:decline', payload)
  }

  emitCallEnd(payload: CallEndPayload): void {
    this.emitRaw('call:end', payload)
  }

  emitCallRoomJoin(payload: CallRoomJoinPayload): void {
    this.emitRaw('call:room:join', payload)
  }

  emitCallRoomLeave(payload: CallRoomLeavePayload): void {
    this.emitRaw('call:room:leave', payload)
  }

  emitCallStatusRequest(payload: CallStatusRequestPayload): void {
    this.emitRaw('call:status:request', payload)
  }

  emitConversationJoin(conversationId: string): void {
    this.emitRaw('conversation:join', conversationId)
  }

  emitPresenceFocus(focused: boolean): void {
    this.emitRaw('presence:focus', { focused })
  }
}

// Singleton instance
let socketServiceInstance: SocketService | null = null

export function getSocketService(wsUrl?: string): SocketService {
  if (!socketServiceInstance) {
    if (!wsUrl) {
      throw new Error('SocketService requires wsUrl for first initialization')
    }
    socketServiceInstance = new SocketService(wsUrl)
  }
  return socketServiceInstance
}

