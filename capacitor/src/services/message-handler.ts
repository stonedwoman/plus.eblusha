import { getSocketService } from './socket-service'
import { getNotificationService } from './notification-service'
import type {
  MessageNewPayload,
  MessageNotifyPayload,
  ConversationTypingPayload,
  MessageReactionPayload,
  ReceiptsUpdatePayload,
} from '../types/socket-events'

export interface MessageHandlerCallbacks {
  onMessageReceived?: (payload: MessageNewPayload) => void
  onConversationUpdated?: (conversationId: string) => void
  onTypingUpdate?: (conversationId: string, userId: string, typing: boolean) => void
  isConversationActive?: (conversationId: string) => boolean
  getConversationInfo?: (conversationId: string) => Promise<{
    title?: string
    avatarUrl?: string
    senderName?: string
  } | null>
}

export class MessageHandler {
  private socketService = getSocketService()
  private notificationService = getNotificationService()
  private callbacks: MessageHandlerCallbacks
  private typingTimers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(callbacks: MessageHandlerCallbacks) {
    this.callbacks = callbacks
  }

  /**
   * Инициализация обработчиков сообщений
   */
  initialize(): () => void {
    const unsubscribers: Array<() => void> = []

    // message:new - новое сообщение в беседе
    const unsubscribeNew = this.socketService.onMessageNew(async (payload) => {
      console.log('[MessageHandler] message:new:', payload)

      const isActive = this.callbacks.isConversationActive?.(payload.conversationId) ?? false

      if (isActive) {
        // Беседа активна - добавляем сообщение в UI
        this.callbacks.onMessageReceived?.(payload)
      } else {
        // Беседа не активна - обновляем список бесед
        this.callbacks.onConversationUpdated?.(payload.conversationId)
      }
    })
    unsubscribers.push(unsubscribeNew)

    // message:notify - уведомление о новом сообщении
    const unsubscribeNotify = this.socketService.onMessageNotify(async (payload) => {
      console.log('[MessageHandler] message:notify:', payload)

      const isActive = this.callbacks.isConversationActive?.(payload.conversationId) ?? false

      // Если беседа не активна или приложение в фоне - показываем уведомление
      if (!isActive) {
        await this.handleMessageNotification(payload)
      }

      // Если это текущая беседа и есть полное сообщение - добавляем в кэш
      if (isActive && payload.message) {
        this.callbacks.onMessageReceived?.(payload as MessageNewPayload)
      }

      // Обновляем список бесед
      this.callbacks.onConversationUpdated?.(payload.conversationId)
    })
    unsubscribers.push(unsubscribeNotify)

    // conversation:typing - кто-то печатает
    const unsubscribeTyping = this.socketService.onConversationTyping((payload) => {
      console.log('[MessageHandler] conversation:typing:', payload)

      // Очищаем предыдущий таймер
      const key = `${payload.conversationId}_${payload.userId}`
      const existingTimer = this.typingTimers.get(key)
      if (existingTimer) {
        clearTimeout(existingTimer)
      }

      if (payload.typing) {
        // Показываем индикатор печати
        this.callbacks.onTypingUpdate?.(payload.conversationId, payload.userId, true)

        // Автоматически скрываем через 2 секунды
        const timer = setTimeout(() => {
          this.callbacks.onTypingUpdate?.(payload.conversationId, payload.userId, false)
          this.typingTimers.delete(key)
        }, 2000)
        this.typingTimers.set(key, timer)
      } else {
        // Сразу скрываем
        this.callbacks.onTypingUpdate?.(payload.conversationId, payload.userId, false)
        this.typingTimers.delete(key)
      }
    })
    unsubscribers.push(unsubscribeTyping)

    // message:reaction - реакция на сообщение
    const unsubscribeReaction = this.socketService.onMessageReaction(async (payload) => {
      console.log('[MessageHandler] message:reaction:', payload)

      const isActive = this.callbacks.isConversationActive?.(payload.conversationId) ?? false

      if (isActive) {
        // Обновляем сообщение в UI
        if (payload.message) {
          this.callbacks.onMessageReceived?.(payload as MessageNewPayload)
        }
      } else {
        // Обновляем список бесед
        this.callbacks.onConversationUpdated?.(payload.conversationId)
      }
    })
    unsubscribers.push(unsubscribeReaction)

    // receipts:update - обновление статусов доставки/прочтения
    const unsubscribeReceipts = this.socketService.onReceiptsUpdate((payload) => {
      console.log('[MessageHandler] receipts:update:', payload)

      const isActive = this.callbacks.isConversationActive?.(payload.conversationId) ?? false

      if (isActive) {
        // Обновляем статусы сообщений в UI
        // TODO: Реализовать обновление статусов
      }
    })
    unsubscribers.push(unsubscribeReceipts)

    // Возвращаем функцию для отписки
    return () => {
      unsubscribers.forEach((unsub) => unsub())
      // Очищаем таймеры
      this.typingTimers.forEach((timer) => clearTimeout(timer))
      this.typingTimers.clear()
    }
  }

  /**
   * Обработка уведомления о новом сообщении
   */
  private async handleMessageNotification(payload: MessageNotifyPayload | MessageNewPayload): Promise<void> {
    try {
      // Получаем информацию о беседе и отправителе
      const conversationInfo = await this.callbacks.getConversationInfo?.(payload.conversationId)

      // Формируем текст сообщения
      let messageText = 'Новое сообщение'
      if (payload.message) {
        if (payload.message.content) {
          messageText = payload.message.content
        } else if (payload.message.attachments?.length) {
          const attachment = payload.message.attachments[0]
          if (attachment.type === 'IMAGE') {
            messageText = '📷 Фото'
          } else {
            messageText = '📎 Файл'
          }
        }
      }

      // Показываем уведомление
      await this.notificationService.showMessageNotification(
        payload,
        messageText,
        conversationInfo?.senderName || conversationInfo?.title,
        conversationInfo?.avatarUrl
      )
    } catch (error) {
      console.error('[MessageHandler] Error handling message notification:', error)
    }
  }

  /**
   * Отправка события "печатает"
   */
  sendTyping(conversationId: string, typing: boolean): void {
    this.socketService.emitConversationTyping({ conversationId, typing })
  }
}

