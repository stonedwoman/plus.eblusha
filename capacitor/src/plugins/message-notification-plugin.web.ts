import type {
  CancelNotificationsOptions,
  MessageNotificationPlugin,
  ShowMessageNotificationOptions,
} from './message-notification-plugin'

export class MessageNotificationWeb implements MessageNotificationPlugin {
  async show(options: ShowMessageNotificationOptions): Promise<void> {
    console.log('[MessageNotificationWeb] show', options)
  }

  async cancel(options: CancelNotificationsOptions): Promise<void> {
    console.log('[MessageNotificationWeb] cancel', options)
  }

  async clear(): Promise<void> {
    console.log('[MessageNotificationWeb] clear')
  }
}

