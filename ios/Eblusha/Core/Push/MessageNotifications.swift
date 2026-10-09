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

    /// Снять доставленные уведомления беседы — при её прочтении в приложении ИЛИ на другом
    /// устройстве (тихий пуш kind=read, PushAppDelegate). Сервер группирует пуши по
    /// thread-id = conversationId; без этого после чтения чата баннеры висели бы в Центре
    /// уведомлений, пока их не смахнут руками.
    /// deliveredBefore — граница по времени прихода баннера: пришедшие ПОЗЖЕ не снимаем (read-пуш
    /// мог опоздать, и за это время в беседе появилось непрочитанное сообщение). nil — снять все.
    /// completion — сколько снято; зовётся ВСЕГДА (и когда снимать нечего): фоновый пуш
    /// обязан дёрнуть completionHandler в окне, которое даёт система.
    func clearDelivered(
        conversationId: String, deliveredBefore: Date? = nil, completion: ((Int) -> Void)? = nil
    ) {
        let center = UNUserNotificationCenter.current()
        center.getDeliveredNotifications { list in
            let ids = Self.identifiers(
                in: list.map(DeliveredInfo.init),
                forConversation: conversationId,
                deliveredBefore: deliveredBefore
            )
            if !ids.isEmpty {
                center.removeDeliveredNotifications(withIdentifiers: ids)
            }
            completion?(ids.count)
        }
    }

    /// Возврат в приложение: снять баннеры бесед, которые к этому моменту прочитаны (пуш
    /// kind=read мог не дойти — приложение выгружено пользователем, нет сети, Apple
    /// придушила фоновые пуши). readConversationIds — беседы с unreadCount == 0 из свежего
    /// списка бесед; deliveredBefore — момент НАЧАЛА запроса списка: баннер, пришедший после
    /// него, список мог ещё не учесть, и его снимать нельзя.
    func clearDeliveredForRead(_ readConversationIds: Set<String>, deliveredBefore: Date) {
        guard !readConversationIds.isEmpty else { return }
        let center = UNUserNotificationCenter.current()
        center.getDeliveredNotifications { list in
            let ids = Self.staleIdentifiers(
                in: list.map(DeliveredInfo.init),
                readConversations: readConversationIds,
                deliveredBefore: deliveredBefore
            )
            if !ids.isEmpty {
                center.removeDeliveredNotifications(withIdentifiers: ids)
            }
        }
    }

    /// Слепок доставленного уведомления: выбор «что снять» — чистая функция над ним, чтобы
    /// его можно было проверить XCTest без UNUserNotificationCenter (UNNotification руками
    /// не построить).
    struct DeliveredInfo: Equatable {
        let identifier: String
        let threadIdentifier: String
        /// userInfo["conversationId"] — запасной признак на случай пуша без thread-id.
        let userInfoConversationId: String?
        let kind: String?
        let date: Date

        init(identifier: String, threadIdentifier: String, userInfoConversationId: String?,
             kind: String?, date: Date) {
            self.identifier = identifier
            self.threadIdentifier = threadIdentifier
            self.userInfoConversationId = userInfoConversationId
            self.kind = kind
            self.date = date
        }

        init(_ n: UNNotification) {
            let content = n.request.content
            self.init(
                identifier: n.request.identifier,
                threadIdentifier: content.threadIdentifier,
                userInfoConversationId: content.userInfo["conversationId"] as? String,
                kind: content.userInfo["kind"] as? String,
                date: n.date
            )
        }

        func belongs(to conversationId: String) -> Bool {
            threadIdentifier == conversationId || userInfoConversationId == conversationId
        }
    }

    /// Все уведомления беседы — любого вида (в том числе баннер звонка): прочтение чата
    /// закрывает и их. deliveredBefore != nil — только пришедшие не позже этой границы.
    static func identifiers(
        in list: [DeliveredInfo], forConversation conversationId: String, deliveredBefore: Date? = nil
    ) -> [String] {
        list.filter { n in
            n.belongs(to: conversationId) && (deliveredBefore.map { n.date <= $0 } ?? true)
        }.map(\.identifier)
    }

    /// Устаревшие баннеры сообщений: беседа прочитана, а баннер пришёл не позже начала
    /// запроса списка. Только kind=message — баннер звонка и прочее чужая логика прочтения.
    static func staleIdentifiers(
        in list: [DeliveredInfo], readConversations: Set<String>, deliveredBefore: Date
    ) -> [String] {
        list.filter { n in
            n.kind == "message"
                && n.date <= deliveredBefore
                && (readConversations.contains(n.threadIdentifier)
                    || n.userInfoConversationId.map { readConversations.contains($0) } == true)
        }.map(\.identifier)
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
            // Секретное сообщение: содержимого в пуше нет, оно лежит в per-device инбоксе —
            // тянем его сразу, чтобы чат открылся уже с текстом.
            let secret = (userInfo["secret"] as? Bool) == true
                || (userInfo["secret"] as? NSNumber)?.boolValue == true
                || (userInfo["secret"] as? String) == "true"
            if secret {
                Task { await AppContainer.shared.secretRepository.syncInbox() }
            }
            AppLifecycle.shared.requestOpenConversation(conversationId: conversationId, title: title)
        }
        completionHandler()
    }
}
