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

// Инициализируем сервис уведомлений при загрузке (только на нативной платформе)
if (typeof window !== 'undefined' && Capacitor.isNativePlatform()) {
  console.log('[Capacitor] Native platform detected, initializing services...')
  const notificationService = getNotificationService()
  notificationService.initialize().catch((error) => {
    console.error('[Capacitor] Failed to initialize notification service:', error)
  })
}

// Экспортируем функции для использования в веб-приложении
export function initializeSocketConnection(wsUrl: string, accessToken: string): void {
  if (!Capacitor.isNativePlatform()) {
    console.warn('[Capacitor] initializeSocketConnection called on web platform')
    return
  }
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
  if (!Capacitor.isNativePlatform()) {
    console.warn('[Capacitor] initializeMessageHandlers called on web platform')
    return () => {}
  }
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
  if (!Capacitor.isNativePlatform()) {
    console.warn('[Capacitor] initializeCallHandlers called on web platform')
    return () => {}
  }
  const callHandler = new CallHandler(callbacks)
  return callHandler.initialize()
}

export function updateSocketToken(token: string): void {
  if (!Capacitor.isNativePlatform()) {
    console.warn('[Capacitor] updateSocketToken called on web platform')
    return
  }
  const socketService = getSocketService()
  socketService.updateToken(token)
}

// Экспортируем сервисы для прямого доступа
export { getSocketService, getNotificationService }

// Экспортируем типы
export * from './types/socket-events'

