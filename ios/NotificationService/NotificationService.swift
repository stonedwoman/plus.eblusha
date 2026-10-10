import Foundation
import UserNotifications

/// Notification Service Extension: через неё проходит каждый alert-пуш о сообщении (сервер ставит
/// `mutable-content: 1`, src/push/apns.ts). Задачи две, обе — по общему с приложением состоянию в
/// группе приложений (MuteSharedState, BadgeLedger):
///  1. «Без звука» (docs/conversation-mute.md). Пуши по заглушённым беседам режет сервер, с правилами
///     пробития, которых здесь не знать (в пуше нет ни isGroup, ни replyTo), — поэтому пришедшему
///     пушу верим. Исключение — гонка: беседу заглушили ПОСЛЕ того, как сообщение создано, и сервер
///     поставил пуш по старому состоянию. Такое уведомление становится тихим: без звука и `passive`
///     (не будит экран, ложится в Центр уведомлений). Совсем убрать его без entitlement фильтрации
///     уведомлений от Apple нельзя.
///  2. Число на значке приложения — непрочитанное без заглушённых бесед. Сервер с APNS_BADGE=on
///     присылает его сам; иначе считаем по журналу: база последнего списка бесед + пуши после него.
///
/// Решение — чистая функция PushMuteDecision (её проверяют XCTest приложения). Здесь только
/// чтение/запись общего домена и выдача содержимого. Расширение живёт в своём процессе с лимитом
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

        let defaults = MuteShared.defaults()
        let result = PushMuteDecision.decide(
            userInfo: content.userInfo,
            serverBadge: request.content.badge?.intValue,
            state: MuteSharedState.load(from: defaults),
            ledger: BadgeLedger.load(from: defaults),
            localNowMs: Int64(Date().timeIntervalSince1970 * 1000)
        )
        if let ledger = result.ledger {
            ledger.save(to: defaults)
        }
        if result.silence {
            content.sound = nil
            content.interruptionLevel = .passive
        }
        if let badge = result.badge {
            content.badge = NSNumber(value: badge)
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
