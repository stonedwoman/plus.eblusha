import { getSocketService } from './socket-service'
import { getNotificationService } from './notification-service'
import { App } from '@capacitor/app'
import { Capacitor } from '@capacitor/core'
import IncomingCall from '../plugins/incoming-call-plugin'
import type {
  CallIncomingPayload,
  CallAcceptedPayload,
  CallDeclinedPayload,
  CallEndedPayload,
  CallStatusPayload,
  CallStatusBulkPayload,
} from '../types/socket-events'

export interface CallHandlerCallbacks {
  onIncomingCall?: (payload: CallIncomingPayload) => void
  onCallAccepted?: (payload: CallAcceptedPayload) => void
  onCallDeclined?: (payload: CallDeclinedPayload) => void
  onCallEnded?: (payload: CallEndedPayload) => void
  onCallStatusUpdate?: (conversationId: string, status: CallStatusPayload) => void
  getConversationInfo?: (conversationId: string) => Promise<{
    title?: string
    avatarUrl?: string
    isGroup?: boolean
  } | null>
}

export class CallHandler {
  private socketService = getSocketService()
  private notificationService = getNotificationService()
  private callbacks: CallHandlerCallbacks
  private activeIncomingCalls = new Map<string, CallIncomingPayload>() // conversationId -> call data
  private callNotificationIds = new Map<string, number>() // conversationId -> notificationId
  private autoDeclineTimers = new Map<string, NodeJS.Timeout>() // conversationId -> timer

  constructor(callbacks: CallHandlerCallbacks) {
    this.callbacks = callbacks
  }

  /**
   * Инициализация обработчиков звонков
   */
  initialize(): () => void {
    const unsubscribers: Array<() => void> = []

    // call:incoming - входящий звонок (1:1)
    const unsubscribeIncoming = this.socketService.onCallIncoming(async (payload) => {
      console.log('[CallHandler] call:incoming:', payload)

      this.activeIncomingCalls.set(payload.conversationId, payload)

      // Показываем нативный экран входящего звонка
      await this.handleIncomingCall(payload)

      // Автоматический decline через 25 секунд
      const timer = setTimeout(() => {
        console.log('[CallHandler] Auto-declining call after 25 seconds')
        this.declineCall(payload.conversationId)
      }, 25000)
      this.autoDeclineTimers.set(payload.conversationId, timer)

      this.callbacks.onIncomingCall?.(payload)
    })
    unsubscribers.push(unsubscribeIncoming)

    // call:accepted - звонок принят
    const unsubscribeAccepted = this.socketService.onCallAccepted((payload) => {
      console.log('[CallHandler] call:accepted:', payload)

      // Очищаем таймер авто-decline
      const timer = this.autoDeclineTimers.get(payload.conversationId)
      if (timer) {
        clearTimeout(timer)
        this.autoDeclineTimers.delete(payload.conversationId)
      }

      // Закрываем экран входящего звонка
      await this.closeIncomingCallScreen(payload.conversationId)

      // Открываем экран звонка (LiveKit)
      this.callbacks.onCallAccepted?.(payload)
    })
    unsubscribers.push(unsubscribeAccepted)

    // call:declined - звонок отклонен
    const unsubscribeDeclined = this.socketService.onCallDeclined((payload) => {
      console.log('[CallHandler] call:declined:', payload)

      // Очищаем таймер авто-decline
      const timer = this.autoDeclineTimers.get(payload.conversationId)
      if (timer) {
        clearTimeout(timer)
        this.autoDeclineTimers.delete(payload.conversationId)
      }

      // Закрываем экран входящего звонка
      await this.closeIncomingCallScreen(payload.conversationId)

      this.callbacks.onCallDeclined?.(payload)
    })
    unsubscribers.push(unsubscribeDeclined)

    // call:ended - звонок завершен
    const unsubscribeEnded = this.socketService.onCallEnded((payload) => {
      console.log('[CallHandler] call:ended:', payload)

      // Очищаем таймер авто-decline
      const timer = this.autoDeclineTimers.get(payload.conversationId)
      if (timer) {
        clearTimeout(timer)
        this.autoDeclineTimers.delete(payload.conversationId)
      }

      // Закрываем экран входящего звонка
      await this.closeIncomingCallScreen(payload.conversationId)

      this.callbacks.onCallEnded?.(payload)
    })
    unsubscribers.push(unsubscribeEnded)

    // call:status - статус группового звонка
    const unsubscribeStatus = this.socketService.onCallStatus((payload) => {
      console.log('[CallHandler] call:status:', payload)

      this.callbacks.onCallStatusUpdate?.(payload.conversationId, payload)
    })
    unsubscribers.push(unsubscribeStatus)

    // call:status:bulk - массовый запрос статусов
    const unsubscribeStatusBulk = this.socketService.onCallStatusBulk((payload) => {
      console.log('[CallHandler] call:status:bulk:', payload)

      for (const [conversationId, status] of Object.entries(payload.statuses)) {
        this.callbacks.onCallStatusUpdate?.(conversationId, status)
      }
    })
    unsubscribers.push(unsubscribeStatusBulk)

    // Возвращаем функцию для отписки
    return () => {
      unsubscribers.forEach((unsub) => unsub())
      // Очищаем таймеры
      this.autoDeclineTimers.forEach((timer) => clearTimeout(timer))
      this.autoDeclineTimers.clear()
    }
  }

  /**
   * Обработка входящего звонка
   */
  private async handleIncomingCall(payload: CallIncomingPayload): Promise<void> {
    try {
      // Получаем информацию о беседе
      const conversationInfo = await this.callbacks.getConversationInfo?.(payload.conversationId)

      // Показываем уведомление о входящем звонке (с full-screen intent)
      const notificationId = await this.notificationService.showIncomingCallNotification(
        payload.conversationId,
        payload.from.name || conversationInfo?.title || 'Неизвестный',
        payload.video,
        conversationInfo?.avatarUrl
      )

      this.callNotificationIds.set(payload.conversationId, notificationId)

      // Открываем нативный экран входящего звонка
      // Это будет сделано через Capacitor plugin или напрямую через нативный код
      await this.openIncomingCallScreen(payload)
    } catch (error) {
      console.error('[CallHandler] Error handling incoming call:', error)
    }
  }

  /**
   * Открыть нативный экран входящего звонка
   */
  private async openIncomingCallScreen(payload: CallIncomingPayload): Promise<void> {
    if (!Capacitor.isNativePlatform()) {
      return
    }

    try {
      const conversationInfo = await this.callbacks.getConversationInfo?.(payload.conversationId)
      
      await IncomingCall.showIncomingCall({
        conversationId: payload.conversationId,
        callerName: payload.from.name || conversationInfo?.title || 'Неизвестный',
        isVideo: payload.video,
        avatarUrl: conversationInfo?.avatarUrl,
      })
    } catch (error) {
      console.error('[CallHandler] Error opening incoming call screen:', error)
    }
  }

  /**
   * Закрыть экран входящего звонка
   */
  private async closeIncomingCallScreen(conversationId: string): Promise<void> {
    // Отменяем уведомление
    const notificationId = this.callNotificationIds.get(conversationId)
    if (notificationId) {
      await this.notificationService.cancelCallNotification(notificationId)
      this.callNotificationIds.delete(conversationId)
    }

    // Удаляем из активных звонков
    this.activeIncomingCalls.delete(conversationId)

    // Закрываем нативный экран
    if (Capacitor.isNativePlatform()) {
      try {
        await IncomingCall.closeIncomingCall()
      } catch (error) {
        console.error('[CallHandler] Error closing incoming call screen:', error)
      }
    }
  }

  /**
   * Принять звонок
   */
  acceptCall(conversationId: string, video: boolean): void {
    const call = this.activeIncomingCalls.get(conversationId)
    if (!call) {
      console.warn('[CallHandler] No active incoming call for:', conversationId)
      return
    }

    // Очищаем таймер авто-decline
    const timer = this.autoDeclineTimers.get(conversationId)
    if (timer) {
      clearTimeout(timer)
      this.autoDeclineTimers.delete(conversationId)
    }

    // Отправляем событие на сервер
    this.socketService.emitCallAccept({ conversationId, video })

    // Закрываем экран входящего звонка
    this.closeIncomingCallScreen(conversationId)
  }

  /**
   * Отклонить звонок
   */
  declineCall(conversationId: string): void {
    // Очищаем таймер авто-decline
    const timer = this.autoDeclineTimers.get(conversationId)
    if (timer) {
      clearTimeout(timer)
      this.autoDeclineTimers.delete(conversationId)
    }

    // Отправляем событие на сервер
    this.socketService.emitCallDecline({ conversationId })

    // Закрываем экран входящего звонка
    this.closeIncomingCallScreen(conversationId)
  }

  /**
   * Завершить звонок
   */
  endCall(conversationId: string): void {
    this.socketService.emitCallEnd({ conversationId })
  }

  /**
   * Присоединиться к групповому звонку
   */
  joinCallRoom(conversationId: string, video?: boolean): void {
    this.socketService.emitCallRoomJoin({ conversationId, video })
  }

  /**
   * Выйти из группового звонка
   */
  leaveCallRoom(conversationId: string): void {
    this.socketService.emitCallRoomLeave({ conversationId })
  }

  /**
   * Запросить статусы звонков
   */
  requestCallStatuses(conversationIds: string[]): void {
    this.socketService.emitCallStatusRequest({ conversationIds })
  }
}

