/**
 * Главный файл для инициализации всех сервисов
 * Этот файл должен быть подключен в веб-приложении (frontend)
 */

import { getSocketService } from './services/socket-service'
import { getNotificationService } from './services/notification-service'
import { MessageHandler } from './services/message-handler'
import { CallHandler } from './services/call-handler'
import { App } from '@capacitor/app'
import { Capacitor } from '@capacitor/core'

// Проверяем, что мы на нативной платформе
const isNative = Capacitor.isNativePlatform()

if (isNative) {
  console.log('[Capacitor] Native platform detected, initializing services...')

  // Инициализируем сервис уведомлений
  const notificationService = getNotificationService()
  notificationService.initialize().catch((error) => {
    console.error('[Capacitor] Failed to initialize notification service:', error)
  })

  // Экспортируем функции для использования в веб-приложении
  export function initializeSocketConnection(wsUrl: string, accessToken: string): void {
    const socketService = getSocketService(wsUrl)
    socketService.connect(accessToken)
  }

  export function initializeMessageHandlers(callbacks: {
    onMessageReceived?: (payload: any) => void
    onConversationUpdated?: (conversationId: string) => void
    onTypingUpdate?: (conversationId: string, userId: string, typing: boolean) => void
    isConversationActive?: (conversationId: string) => boolean
    getConversationInfo?: (conversationId: string) => Promise<{
      title?: string
      avatarUrl?: string
      senderName?: string
    } | null>
  }): () => void {
    const messageHandler = new MessageHandler(callbacks)
    return messageHandler.initialize()
  }

  export function initializeCallHandlers(callbacks: {
    onIncomingCall?: (payload: any) => void
    onCallAccepted?: (payload: any) => void
    onCallDeclined?: (payload: any) => void
    onCallEnded?: (payload: any) => void
    onCallStatusUpdate?: (conversationId: string, status: any) => void
    getConversationInfo?: (conversationId: string) => Promise<{
      title?: string
      avatarUrl?: string
      isGroup?: boolean
    } | null>
  }): () => void {
    const callHandler = new CallHandler(callbacks)
    return callHandler.initialize()
  }

  export function updateSocketToken(token: string): void {
    const socketService = getSocketService()
    socketService.updateToken(token)
  }

  // Экспортируем сервисы для прямого доступа
  export { getSocketService, getNotificationService }
} else {
  console.log('[Capacitor] Web platform, skipping native services')
}

// Экспортируем типы
export * from './types/socket-events'

