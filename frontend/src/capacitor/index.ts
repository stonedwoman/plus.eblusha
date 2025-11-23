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
  console.log('[Capacitor] ✅ Native platform detected, initializing services...')
  console.log('[Capacitor] Platform:', Capacitor.getPlatform())
  console.log('[Capacitor] Plugins:', (Capacitor as any).Plugins ? Object.keys((Capacitor as any).Plugins) : 'not loaded')
  const notificationService = getNotificationService()
  notificationService.initialize().then(() => {
    console.log('[Capacitor] ✅ Notification service initialized successfully')
  }).catch((error) => {
    console.error('[Capacitor] ❌ Failed to initialize notification service:', error)
    console.error('[Capacitor] Error stack:', error?.stack)
  })
} else {
  console.log('[Capacitor] Web platform detected, skipping native initialization')
}

// Экспортируем функции для использования в веб-приложении
export async function initializeSocketConnection(wsUrl: string, accessToken: string): Promise<void> {
  console.log('[Capacitor] initializeSocketConnection called, isNative:', Capacitor.isNativePlatform())
  if (!Capacitor.isNativePlatform()) {
    console.warn('[Capacitor] initializeSocketConnection called on web platform')
    return
  }
  console.log('[Capacitor] Creating SocketService with URL:', wsUrl)
  const socketService = getSocketService(wsUrl)
  console.log('[Capacitor] Connecting socket with token length:', accessToken?.length || 0)
  socketService.connect(accessToken)

  // Обработка событий жизненного цикла приложения - регистрируем асинхронно
  console.log('[Capacitor] About to call setupAppLifecycleHandlers...')
  try {
    await setupAppLifecycleHandlers(socketService)
    console.log('[Capacitor] ✅ setupAppLifecycleHandlers completed successfully')
  } catch (error) {
    console.error('[Capacitor] ❌ setupAppLifecycleHandlers failed:', error)
  }
}

// Хранилище для обработчиков жизненного цикла
let lifecycleHandlers: Array<{ remove: () => Promise<void> }> = []

/**
 * Настройка обработчиков событий жизненного цикла приложения
 */
async function setupAppLifecycleHandlers(socketService: ReturnType<typeof getSocketService>): Promise<void> {
  console.log('[Capacitor] Setting up app lifecycle handlers...')
  
  // Очищаем старые обработчики, если они есть
  lifecycleHandlers.forEach(handler => handler.remove().catch(() => {}))
  lifecycleHandlers = []
  
  try {
    // Обработчик appStateChange - регистрируем синхронно с await
    const appStateChangeListener = await App.addListener('appStateChange', (state) => {
      console.log('[Capacitor] 🔄 App state changed:', state.isActive ? 'active' : 'background')
      
      if (state.isActive) {
        // Приложение стало активным - проверяем соединение и переподключаемся при необходимости
        console.log('[Capacitor] ✅ App resumed, checking socket connection...')
        // Небольшая задержка перед проверкой соединения, чтобы дать время системе восстановить сеть
        setTimeout(() => {
          const isConnected = socketService.isConnected()
          console.log('[Capacitor] Socket connection status:', isConnected)
          if (!isConnected) {
            console.log('[Capacitor] 🔌 Socket not connected, attempting to reconnect...')
            socketService.reconnect()
          } else {
            console.log('[Capacitor] ✅ Socket already connected')
          }
        }, 1500)
      } else {
        // Приложение ушло в фон - соединение должно продолжать работать
        console.log('[Capacitor] ⏸️ App paused, maintaining socket connection in background')
        // Socket.IO должен продолжать работать в фоне благодаря настройкам pingTimeout/pingInterval
      }
    })
    lifecycleHandlers.push(appStateChangeListener)
    console.log('[Capacitor] ✅ appStateChange listener registered and saved')

    // Дополнительная обработка события resume для надежности
    const resumeListener = await App.addListener('resume', () => {
      console.log('[Capacitor] 🔄 App resumed event received')
      // Небольшая задержка перед проверкой соединения, чтобы дать время системе восстановить сеть
      setTimeout(() => {
        const isConnected = socketService.isConnected()
        console.log('[Capacitor] Socket connection status after resume:', isConnected)
        if (!isConnected) {
          console.log('[Capacitor] 🔌 Socket not connected after resume, reconnecting...')
          socketService.reconnect()
        } else {
          console.log('[Capacitor] ✅ Socket still connected after resume')
        }
      }, 1500)
    })
    lifecycleHandlers.push(resumeListener)
    console.log('[Capacitor] ✅ resume listener registered and saved')

    // Также обрабатываем событие pause для логирования
    const pauseListener = await App.addListener('pause', () => {
      console.log('[Capacitor] ⏸️ App paused event received - maintaining background connection')
      // Socket.IO продолжит работать в фоне благодаря настройкам
    })
    lifecycleHandlers.push(pauseListener)
    console.log('[Capacitor] ✅ pause listener registered and saved')

    console.log('[Capacitor] ✅ All app lifecycle handlers registered successfully (3 listeners)')
  } catch (error) {
    console.error('[Capacitor] ❌ Failed to register app lifecycle handlers:', error)
  }
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
  console.log('[Capacitor] initializeMessageHandlers called, isNative:', Capacitor.isNativePlatform())
  if (!Capacitor.isNativePlatform()) {
    console.warn('[Capacitor] initializeMessageHandlers called on web platform')
    return () => {}
  }
  console.log('[Capacitor] Creating MessageHandler')
  const messageHandler = new MessageHandler(callbacks)
  const unsubscribe = messageHandler.initialize()
  console.log('[Capacitor] ✅ MessageHandler initialized')
  return unsubscribe
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

