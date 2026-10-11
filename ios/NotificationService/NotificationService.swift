import Foundation
import UserNotifications

/// Notification Service Extension: через неё проходит каждый alert-пуш о сообщении (сервер ставит
/// `mutable-content: 1`, src/push/apns.ts). Задача — «Без звука» (docs/conversation-mute.md) по общему
/// с приложением состоянию в группе приложений (MuteSharedState). Пуши по заглушённым беседам режет
/// сервер, с правилами пробития, которых здесь не знать (в пуше нет ни isGroup, ни replyTo), — поэтому
/// пришедшему пушу верим. Исключение — гонка: беседу заглушили ПОСЛЕ того, как сообщение создано, и
/// сервер поставил пуш по старому состоянию. Такое уведомление становится тихим: без звука и `passive`
/// (не будит экран, ложится в Центр уведомлений). Совсем убрать его без entitlement фильтрации
/// уведомлений от Apple нельзя.
///
/// Число на значке расширение не трогает: `aps.badge` ставит сервер (и только устройствам, которым он
/// ведёт значок, src/push/badge.ts) — оно остаётся в содержимом как пришло. Своё число по пушам здесь
/// не посчитать: прочтения на других устройствах до выгруженного приложения не доходят.
///
/// Решение — чистая функция PushMuteDecision (её проверяют XCTest приложения). Здесь только
/// чтение общего домена и выдача содержимого. Расширение живёт в своём процессе с лимитом
/// памяти ~24 МБ: никаких зависимостей приложения сюда не тянем.
final class NotificationService: UNNotificationServiceExtension {
    private var contentHandler: ((UNNotificationContent) -> Void)?
    private var bestAttempt: UNMutableNotificationContent?

    override func didReceive(
        _ request: UNNotificationRequest,
        withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
    ) {
        guard let content = request.content.mutableCopy() as? UNMutableNotificationContent else {
            contentHandler(request.content)
            return
        }
        self.contentHandler = contentHandler
        bestAttempt = content

        let result = PushMuteDecision.decide(
            userInfo: content.userInfo,
            state: MuteSharedState.load(from: MuteShared.defaults()),
            localNowMs: Int64(Date().timeIntervalSince1970 * 1000)
        )
        if result.silence {
            content.sound = nil
            content.interruptionLevel = .passive
        }
        contentHandler(content)
        self.contentHandler = nil
    }

    /// Время вышло (система даёт ~30 с; нам хватает миллисекунд) — отдаём то, что успели.
    override func serviceExtensionTimeWillExpire() {
        if let contentHandler, let bestAttempt {
            contentHandler(bestAttempt)
        }
        contentHandler = nil
    }
}
