import { Capacitor, registerPlugin } from '@capacitor/core'

export interface ShowMessageNotificationOptions {
  id: number
  conversationId: string
  senderName: string
  messageText: string
  avatarUrl?: string
}

export interface CancelNotificationsOptions {
  ids: number[]
}

export interface MessageNotificationPlugin {
  show(options: ShowMessageNotificationOptions): Promise<void>
  cancel(options: CancelNotificationsOptions): Promise<void>
  clear(): Promise<void>
}

export type MessageNotificationRuntimeStatus = {
  hasCapacitor: boolean
  hasWindowPlugin: boolean
  isPluginAvailable: boolean
}

export function getMessageNotificationRuntimeStatus(): MessageNotificationRuntimeStatus {
  const capacitor =
    typeof window !== 'undefined' ? ((window as any).Capacitor as any | undefined) : undefined

  const hasWindowPlugin = Boolean(capacitor?.Plugins?.MessageNotification)
  let isPluginAvailable = false

  try {
    isPluginAvailable =
      typeof Capacitor.isPluginAvailable === 'function'
        ? Boolean(Capacitor.isPluginAvailable('MessageNotification'))
        : hasWindowPlugin
  } catch {
    isPluginAvailable = hasWindowPlugin
  }

  return {
    hasCapacitor: Boolean(capacitor),
    hasWindowPlugin,
    isPluginAvailable,
  }
}

const MessageNotification = registerPlugin<MessageNotificationPlugin>('MessageNotification', {
  web: () => import('./message-notification-plugin.web').then((m) => new m.MessageNotificationWeb()),
})

export default MessageNotification

