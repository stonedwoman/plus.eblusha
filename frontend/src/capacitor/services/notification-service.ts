import { LocalNotifications } from '@capacitor/local-notifications'
import { App } from '@capacitor/app'
import { Capacitor } from '@capacitor/core'
import type { MessageNotifyPayload, MessageNewPayload } from '../types/socket-events'

export interface NotificationData {
  id: string
  title: string
  body: string
  conversationId: string
  messageId?: string
  senderId?: string
  avatarUrl?: string
}

export class NotificationService {
  private notificationIds = new Set<number>()
  private conversationNotifications = new Map<string, number>() // conversationId -> notificationId

  /**
   * Инициализация сервиса уведомлений
   */
  async initialize(): Promise<void> {
    console.log('[NotificationService] 🚀 Initializing notification service...')
    console.log('[NotificationService] Platform:', Capacitor.getPlatform())
    console.log('[NotificationService] Is native:', Capacitor.isNativePlatform())
    
    // Проверяем доступность плагина
    if (!Capacitor.isPluginAvailable('LocalNotifications')) {
      console.error('[NotificationService] ❌ LocalNotifications plugin is not available on this platform')
      return
    }
    
    try {
      // Запрашиваем разрешение на уведомления
      const permission = await LocalNotifications.checkPermissions()
      console.log('[NotificationService] Current permission:', permission.display)
      if (permission.display !== 'granted') {
        console.log('[NotificationService] Requesting notification permission...')
        const result = await LocalNotifications.requestPermissions()
        console.log('[NotificationService] Permission result:', result.display)
        if (result.display !== 'granted') {
          console.warn('[NotificationService] ❌ Notification permission not granted')
          return
        }
      }
      console.log('[NotificationService] ✅ Notification permission granted')
    } catch (error) {
      console.error('[NotificationService] ❌ Error initializing notifications:', error)
      return
    }

    // Обработчик клика по уведомлению
    LocalNotifications.addListener('localNotificationActionPerformed', (notification) => {
      const data = notification.notification.extra as NotificationData | undefined
      if (data?.conversationId) {
        // Открываем приложение и переходим к беседе
        this.handleNotificationClick(data)
      }
    })

    // Обработчик открытия приложения по уведомлению
    App.addListener('appStateChange', (state) => {
      if (state.isActive) {
        // Приложение стало активным - можно обновить UI
        this.onAppBecameActive()
      }
    })
  }

  /**
   * Показать уведомление о новом сообщении
   */
  async showMessageNotification(
    payload: MessageNotifyPayload | MessageNewPayload,
    messageText?: string,
    senderName?: string,
    avatarUrl?: string
  ): Promise<void> {
    console.log('[NotificationService] 📨 showMessageNotification called:', {
      conversationId: payload.conversationId,
      messageId: payload.messageId,
      senderId: payload.senderId,
      messageText,
      senderName,
    })
    
    // Проверяем, активно ли приложение
    const appState = await App.getState()
    console.log('[NotificationService] App state:', appState.isActive ? 'active' : 'background')
    if (appState.isActive) {
      // Приложение активно - не показываем уведомление
      // (сообщение уже видно на экране)
      console.log('[NotificationService] App is active, skipping notification')
      return
    }

    const notificationId = Date.now() % 2147483647 // Максимальный ID для Android
    const conversationId = payload.conversationId

    // Если уже есть уведомление для этой беседы, обновляем его
    const existingId = this.conversationNotifications.get(conversationId)
    if (existingId) {
      // Обновляем существующее уведомление (группировка)
      await this.updateConversationNotification(
        existingId,
        conversationId,
        messageText || 'Новое сообщение',
        senderName || 'Кто-то',
        avatarUrl
      )
      return
    }

    // Создаем новое уведомление
    const title = senderName || 'Новое сообщение'
    const body = messageText || 'У вас новое сообщение'

    console.log('[NotificationService] 📤 Scheduling notification:', {
      notificationId,
      title,
      body,
      conversationId,
    })
    
    // Проверяем доступность плагина перед использованием
    if (!Capacitor.isPluginAvailable('LocalNotifications')) {
      console.error('[NotificationService] ❌ LocalNotifications plugin is not available')
      return
    }
    
    try {
      await LocalNotifications.schedule({
        notifications: [
          {
            title,
            body,
            id: notificationId,
            sound: 'notify.mp3', // Звук уведомления
            attachments: avatarUrl
              ? [
                  {
                    id: 'avatar',
                    url: avatarUrl,
                  },
                ]
              : undefined,
            extra: {
              conversationId,
              messageId: payload.messageId,
              senderId: payload.senderId,
              avatarUrl,
            } as NotificationData,
            actionTypeId: 'MESSAGE',
            // Группировка уведомлений по беседе
            group: `conversation_${conversationId}`,
            groupSummary: false,
          },
        ],
      })
      
      console.log('[NotificationService] ✅ Notification scheduled successfully')
      this.notificationIds.add(notificationId)
      this.conversationNotifications.set(conversationId, notificationId)
    } catch (error) {
      console.error('[NotificationService] ❌ Error scheduling notification:', error)
    }
  }

  /**
   * Обновить уведомление беседы (для группировки)
   */
  private async updateConversationNotification(
    notificationId: number,
    conversationId: string,
    latestMessage: string,
    senderName: string,
    avatarUrl?: string
  ): Promise<void> {
    // В Android можно обновить уведомление, создав новое с тем же ID
    await LocalNotifications.schedule({
      notifications: [
        {
          title: senderName,
          body: latestMessage,
          id: notificationId,
          sound: undefined, // Не проигрываем звук при обновлении
          extra: {
            conversationId,
            senderId: undefined,
            avatarUrl,
          } as NotificationData,
          actionTypeId: 'MESSAGE',
          group: `conversation_${conversationId}`,
          groupSummary: false,
        },
      ],
    })
  }

  /**
   * Показать уведомление о входящем звонке
   */
  async showIncomingCallNotification(
    conversationId: string,
    callerName: string,
    isVideo: boolean,
    avatarUrl?: string
  ): Promise<number> {
    const notificationId = Date.now() % 2147483647
    const callType = isVideo ? 'видеозвонок' : 'звонок'

    await LocalNotifications.schedule({
      notifications: [
        {
          title: `Входящий ${callType}`,
          body: `${callerName} звонит вам`,
          id: notificationId,
          sound: 'ring.mp3', // Рингтон
          ongoing: true, // Постоянное уведомление (нельзя смахнуть)
          extra: {
            conversationId,
            callType: isVideo ? 'video' : 'audio',
            callerName,
            avatarUrl,
          },
          actionTypeId: 'INCOMING_CALL',
        },
      ],
    })

    this.notificationIds.add(notificationId)
    return notificationId
  }

  /**
   * Отменить уведомление о звонке
   */
  async cancelCallNotification(notificationId: number): Promise<void> {
    await LocalNotifications.cancel({
      notifications: [{ id: notificationId }],
    })
    this.notificationIds.delete(notificationId)
  }

  /**
   * Отменить все уведомления для беседы
   */
  async cancelConversationNotifications(conversationId: string): Promise<void> {
    const notificationId = this.conversationNotifications.get(conversationId)
    if (notificationId) {
      await LocalNotifications.cancel({
        notifications: [{ id: notificationId }],
      })
      this.notificationIds.delete(notificationId)
      this.conversationNotifications.delete(conversationId)
    }
  }

  /**
   * Очистить все уведомления
   */
  async clearAll(): Promise<void> {
    const ids = Array.from(this.notificationIds)
    if (ids.length > 0) {
      await LocalNotifications.cancel({
        notifications: ids.map((id) => ({ id })),
      })
    }
    this.notificationIds.clear()
    this.conversationNotifications.clear()
  }

  /**
   * Обработчик клика по уведомлению
   */
  private handleNotificationClick(data: NotificationData): void {
    // Это будет обработано в основном приложении
    // Можно использовать Capacitor App plugin для навигации
    console.log('[NotificationService] Notification clicked:', data)
    // TODO: Открыть беседу в приложении
  }

  /**
   * Обработчик активации приложения
   */
  private onAppBecameActive(): void {
    // Приложение стало активным - можно обновить UI
    // Очищаем уведомления, так как пользователь уже видит сообщения
    console.log('[NotificationService] App became active')
  }
}

// Singleton instance
let notificationServiceInstance: NotificationService | null = null

export function getNotificationService(): NotificationService {
  if (!notificationServiceInstance) {
    notificationServiceInstance = new NotificationService()
  }
  return notificationServiceInstance
}

