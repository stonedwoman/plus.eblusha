import { LocalNotifications } from '@capacitor/local-notifications'
import { App } from '@capacitor/app'
import { Capacitor } from '@capacitor/core'
import MessageNotification from '../plugins/message-notification-plugin'
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

type NotificationKind = 'message-plugin' | 'message-local' | 'call'

export class NotificationService {
  private notificationIds = new Set<number>()
  private notificationSources = new Map<number, NotificationKind>()
  private conversationNotifications = new Map<string, number>() // conversationId -> notificationId
  private isAppActive = true
  private isDocumentVisible = typeof document === 'undefined' ? true : !document.hidden
  private useMessagePlugin = false
  private appStateWarningLogged = false
  private hasInitialAppState = false

  /**
   * Инициализация сервиса уведомлений
   */
  async initialize(): Promise<void> {
    console.log('[NotificationService] 🚀 Initializing notification service...')
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

    const platform = typeof Capacitor.getPlatform === 'function' ? Capacitor.getPlatform() : 'web'
    const isNativePlatform =
      typeof Capacitor.isNativePlatform === 'function' ? Capacitor.isNativePlatform() : platform !== 'web'
    const pluginAvailable =
      typeof Capacitor.isPluginAvailable === 'function' ? Capacitor.isPluginAvailable('MessageNotification') : false

    this.useMessagePlugin = isNativePlatform && pluginAvailable
    console.log('[NotificationService] MessageNotification plugin available:', this.useMessagePlugin)

    if (platform === 'android') {
      await this.configureChannels()
    }

    try {
      const initialState = await App.getState()
      this.isAppActive = initialState.isActive
      this.hasInitialAppState = true
      console.log('[NotificationService] Initial app state:', initialState.isActive ? 'active' : 'background')
    } catch (error) {
      this.hasInitialAppState = true
      console.warn('[NotificationService] Failed to read initial app state, using default "active" state', error)
    }

    if (typeof document !== 'undefined') {
      this.isDocumentVisible = !document.hidden
      document.addEventListener('visibilitychange', () => {
        this.isDocumentVisible = !document.hidden
        console.log(
          '[NotificationService] Document visibility changed:',
          this.isDocumentVisible ? 'visible' : 'hidden'
        )
        if (this.isDocumentVisible && this.isAppActive) {
          this.onAppBecameActive()
        }
      })
    }

    // Обработчик открытия приложения по уведомлению
    App.addListener('appStateChange', (state) => {
      this.isAppActive = state.isActive
      this.hasInitialAppState = true
      console.log('[NotificationService] appStateChange event:', state.isActive ? 'active' : 'background')
      if (state.isActive) {
        // Приложение стало активным - можно обновить UI
        this.onAppBecameActive()
      }
    })

    App.addListener('pause', () => {
      this.isAppActive = false
      this.hasInitialAppState = true
      console.log('[NotificationService] pause event received, marking app as background')
    })

    App.addListener('resume', () => {
      this.isAppActive = true
      this.hasInitialAppState = true
      console.log('[NotificationService] resume event received, marking app as active')
      this.onAppBecameActive()
    })

    // Обработчик клика по уведомлению
    LocalNotifications.addListener('localNotificationActionPerformed', (notification) => {
      const extra = notification.notification.extra as any
      if (extra?.conversationId) {
        console.log('[NotificationService] Notification clicked, opening conversation:', extra.conversationId)
        // Открываем беседу через intent (будет обработано в MainActivity)
        // Это будет сделано через нативный код или через App plugin
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
    const inForeground = await this.isInForeground()
    console.log(
      '[NotificationService] Foreground status:',
      inForeground ? 'active' : 'background',
      JSON.stringify({
        appActive: this.isAppActive,
        documentVisible: this.isDocumentVisible,
      })
    )
    if (inForeground) {
      // Приложение активно - не показываем уведомление
      // (сообщение уже видно на экране)
      console.log('[NotificationService] App is active, skipping notification')
      return
    }

    const conversationId = payload.conversationId
    const notificationId = Date.now() % 2147483647 // Максимальный ID для Android

    const existingId = this.conversationNotifications.get(conversationId)
    if (existingId) {
      await this.cancelMessageNotifications([existingId])
    }

    const title = senderName || 'Новое сообщение'
    const body = messageText || 'У вас новое сообщение'

    console.log('[NotificationService] 📤 Scheduling notification:', {
      notificationId,
      title,
      body,
      conversationId,
    })
    
    await this.pushNativeNotification({
      id: notificationId,
      conversationId,
      senderId: payload.senderId,
      messageId: payload.messageId,
      title,
      body,
      avatarUrl,
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
          channelId: 'calls',
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
    this.notificationSources.set(notificationId, 'call')
    return notificationId
  }

  /**
   * Отменить уведомление о звонке
   */
  async cancelCallNotification(notificationId: number): Promise<void> {
    await LocalNotifications.cancel({ notifications: [{ id: notificationId }] })
    this.notificationIds.delete(notificationId)
    this.notificationSources.delete(notificationId)
  }

  /**
   * Отменить все уведомления для беседы
   */
  async cancelConversationNotifications(conversationId: string): Promise<void> {
    const notificationId = this.conversationNotifications.get(conversationId)
    if (notificationId) {
      await this.cancelMessageNotifications([notificationId])
      this.notificationIds.delete(notificationId)
      this.notificationSources.delete(notificationId)
      this.conversationNotifications.delete(conversationId)
    }
  }

  /**
   * Очистить все уведомления
   */
  async clearAll(): Promise<void> {
    const messageIds: number[] = []
    const callIds: number[] = []

    for (const id of this.notificationIds) {
      const kind = this.notificationSources.get(id)
      if (kind === 'call') {
        callIds.push(id)
      } else {
        messageIds.push(id)
      }
    }

    await this.cancelMessageNotifications(messageIds)

    if (callIds.length > 0) {
      await LocalNotifications.cancel({
        notifications: callIds.map((id) => ({ id })),
      })
    }

    this.notificationIds.clear()
    this.notificationSources.clear()
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

  private async pushNativeNotification(options: {
    id: number
    conversationId: string
    senderId?: string
    messageId?: string
    title: string
    body: string
    avatarUrl?: string
  }): Promise<void> {
    try {
      const delivery = await this.scheduleMessageNotification(options)
      this.notificationIds.add(options.id)
      this.notificationSources.set(options.id, delivery === 'plugin' ? 'message-plugin' : 'message-local')
      this.conversationNotifications.set(options.conversationId, options.id)
      console.log(
        '[NotificationService] ✅ Native notification shown via',
        delivery === 'plugin' ? 'MessageNotification plugin' : 'LocalNotifications'
      )
    } catch (error) {
      console.error('[NotificationService] ❌ Failed to show native notification:', error)
    }
  }

  private async scheduleMessageNotification(options: {
    id: number
    conversationId: string
    title: string
    body: string
    avatarUrl?: string
    senderId?: string
    messageId?: string
  }): Promise<'plugin' | 'local'> {
    if (this.useMessagePlugin) {
      try {
        await MessageNotification.show({
          id: options.id,
          conversationId: options.conversationId,
          senderName: options.title,
          messageText: options.body,
          avatarUrl: options.avatarUrl,
        })
        return 'plugin'
      } catch (error) {
        console.warn(
          '[NotificationService] ⚠️ MessageNotification plugin failed, falling back to LocalNotifications',
          error
        )
        this.useMessagePlugin = false
      }
    }

    await this.scheduleViaLocalNotifications(options)
    return 'local'
  }

  private async scheduleViaLocalNotifications(options: {
    id: number
    conversationId: string
    title: string
    body: string
    avatarUrl?: string
    senderId?: string
    messageId?: string
  }): Promise<void> {
    await LocalNotifications.schedule({
      notifications: [
        {
          title: options.title,
          body: options.body,
          largeBody: options.body.length > 120 ? options.body : undefined,
          id: options.id,
          channelId: 'messages',
          sound: undefined, // Без звука для сообщений
          ongoing: false,
          autoCancel: true,
          extra: {
            conversationId: options.conversationId,
            messageId: options.messageId,
            senderId: options.senderId,
            avatarUrl: options.avatarUrl,
          },
          actionTypeId: 'MESSAGE',
        },
      ],
    })
  }

  private async configureChannels(): Promise<void> {
    const platform = typeof Capacitor.getPlatform === 'function' ? Capacitor.getPlatform() : 'web'
    if (platform !== 'android') {
      return
    }

    try {
      await LocalNotifications.createChannel({
        id: 'messages',
        name: 'Сообщения',
        description: 'Уведомления о новых сообщениях',
        importance: 4,
        visibility: 1,
        lights: true,
        vibration: true,
      })

      await LocalNotifications.createChannel({
        id: 'calls',
        name: 'Звонки',
        description: 'Входящие звонки',
        importance: 5,
        visibility: 1,
        sound: 'ring.mp3',
        vibration: true,
      })

      console.log('[NotificationService] ✅ Notification channels configured')
    } catch (error) {
      console.warn('[NotificationService] ⚠️ Failed to configure notification channels', error)
    }
  }

  private async cancelMessageNotifications(ids: number[]): Promise<void> {
    if (ids.length === 0) {
      return
    }

    const pluginIds: number[] = []
    const localIds: number[] = []

    ids.forEach((id) => {
      const kind = this.notificationSources.get(id)
      if (kind === 'message-plugin') {
        pluginIds.push(id)
      } else {
        localIds.push(id)
      }
    })

    if (pluginIds.length > 0) {
      try {
        await MessageNotification.cancel({ ids: pluginIds })
      } catch (error) {
        console.warn('[NotificationService] ⚠️ Failed to cancel plugin notifications', error)
      }
    }

    if (localIds.length > 0) {
      await LocalNotifications.cancel({
        notifications: localIds.map((id) => ({ id })),
      })
    }
  }

  private async isInForeground(): Promise<boolean> {
    try {
      const state = await App.getState()
      this.isAppActive = state.isActive
      this.hasInitialAppState = true
      this.appStateWarningLogged = false
    } catch (error) {
      if (!this.appStateWarningLogged) {
        console.warn(
          '[NotificationService] ⚠️ Failed to get current App state, falling back to cached value',
          error
        )
        this.appStateWarningLogged = true
      }
      this.hasInitialAppState = true
    }

    if (typeof document !== 'undefined') {
      this.isDocumentVisible = !document.hidden
    }

    return this.isAppActive && this.isDocumentVisible
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

