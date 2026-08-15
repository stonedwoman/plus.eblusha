import Foundation
import UIKit
import UserNotifications

/// Уведомления о сообщениях — смысловой порт `service/MessageNotifier.kt`,
/// перевёрнутый под iOS: на Android тело уведомления собирал клиент из
/// `message:notify` живого сокета (пушей у сервера тогда не было), здесь готовый
/// alert-пуш строит сервер (src/push/apns.ts: title = имя отправителя, body =
/// короткая пометка «Фото»/заглушка — ТЕКСТ ПЕРЕПИСКИ ЧЕРЕЗ APPLE НЕ ЛЕТАЕТ),
/// а клиенту остаются две вещи из MessageNotifier:
///  - не показывать уведомление поверх открытого приложения (AppLifecycle);
///  - тап → открыть беседу (порт EXTRA_OPEN_CONVERSATION → requestOpenConversation).
final class MessageNotifications: NSObject, UNUserNotificationCenterDelegate {

    static let shared = MessageNotifications()

    /// Зовётся из PushAppDelegate ДО конца didFinishLaunching: делегат должен стоять
    /// раньше, чем система доставит тап, запустивший приложение, — иначе он теряется.
    func activate() {
        UNUserNotificationCenter.current().delegate = self
        // Регистрация remote notifications нужна и БЕЗ разрешения пользователя:
        // тихий background-пуш call-cancel (alert-токен) доставляется молча и
        // разрешения не требует, а alert-токен без неё не выдаётся вовсе.
        DispatchQueue.main.async {
            UIApplication.shared.registerForRemoteNotifications()
        }
    }

    /// Системный диалог разрешения — ПОСЛЕ логина (аналог запроса POST_NOTIFICATIONS
    /// на Android 13+): просить до входа в аккаунт — верный способ получить отказ.
    func requestPermissionAfterLogin() {
        UNUserNotificationCenter.current().requestAuthorization(
            options: [.alert, .sound, .badge]
        ) { granted, error in
            if let error {
                NSLog("MessageNotifications: запрос разрешения не удался: %@", String(describing: error))
            }
            NSLog("MessageNotifications: уведомления %@", granted ? "разрешены" : "запрещены")
            // Повторная регистрация после выдачи разрешения: токен тот же, но система
            // может дослать его свежим колбэком.
            DispatchQueue.main.async {
                UIApplication.shared.registerForRemoteNotifications()
            }
        }
    }

    // MARK: - UNUserNotificationCenterDelegate

    /// Пуш пришёл, когда приложение НА ЭКРАНЕ. Порт смысла MessageNotifier: внутри
    /// приложения уведомление о сообщении — шум (переписка и так перед глазами,
    /// новое доставит сокет). kind=call тоже глушим: входящим уже звонит
    /// IncomingCallView + CallRinger, второй баннер поверх — какофония.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        let userInfo = notification.request.content.userInfo
        let kind = userInfo["kind"] as? String
        if kind == "message" {
            // willPresent зовётся только у активного приложения, но сверяемся с
            // AppLifecycle честно: сцена может быть на экране, но неактивна (шторка).
            completionHandler(AppLifecycle.shared.isForeground ? [] : [.banner, .list, .sound])
            return
        }
        if kind == "call" || kind == "call-cancel" {
            completionHandler([])
            return
        }
        completionHandler([.banner, .list, .sound])
    }

    /// Тап по уведомлению → открыть беседу (порт tapIntent из MessageNotifier;
    /// title = имя отправителя, как EXTRA_OPEN_TITLE). Потребляет RootView через
    /// AppLifecycle.pendingOpen.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let userInfo = response.notification.request.content.userInfo
        let kind = userInfo["kind"] as? String
        if (kind == "message" || kind == "call"),
           let conversationId = userInfo["conversationId"] as? String {
            let title = (userInfo["senderName"] as? String)
                ?? (userInfo["callerName"] as? String)
                ?? ""
            AppLifecycle.shared.requestOpenConversation(conversationId: conversationId, title: title)
        }
        completionHandler()
    }
}
