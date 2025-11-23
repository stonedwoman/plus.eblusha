import { registerPlugin } from '@capacitor/core'

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

const MessageNotification = registerPlugin<MessageNotificationPlugin>('MessageNotification', {
  web: () => import('./message-notification-plugin.web').then((m) => new m.MessageNotificationWeb()),
})

export default MessageNotification

