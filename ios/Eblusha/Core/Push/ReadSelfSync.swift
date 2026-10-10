import Foundation

/// Сокет-событие `conversation:read-self` {conversationId, readAt, byDeviceId?, replay?}: беседу
/// прочитали на ЛЮБОМ моём устройстве (сервер шлёт его во все мои сокеты, включая читающий), плюс
/// догон `replay:true` при каждом подключении сокета — по всем беседам, прочитанным за сутки.
///
/// Это второй путь к тихому APNs-пушу kind=read (ReadPush). Пуш не доходит до приложения,
/// смахнутого из переключателя, Apple режет частые фоновые пуши, а до секреток раньше
/// добирались только открытием беседы. Сокет живёт, пока приложение на экране или держит
/// звонок, а догон при подключении закрывает всё, что случилось, пока сокета не было.
///
/// Правило то же, что у пуша и у Android/ПК: снимаются только баннеры, показанные НЕ ПОЗЖЕ
/// readAt + допуск на часы. Уведомление о сообщении, пришедшем после прочтения, остаётся.
struct ReadSelfEvent: Equatable {
    let conversationId: String
    /// Момент прочтения по часам сервера.
    let readAt: Date
    /// Какое устройство прочитало (у догона его нет).
    let byDeviceId: String?
    let replay: Bool

    /// Граница: баннеры позже неё ещё не прочитаны.
    var deliveredUpTo: Date { readAt.addingTimeInterval(ReadPush.clockTolerance) }

    /// nil — не событие прочтения. Без readAt не снимаем ничего: без границы можно снять
    /// баннер непрочитанного сообщения (у пуша «нет readAt» значит старый сервер, а у сокета
    /// readAt есть всегда — его отсутствие означает сбой, а не старую версию).
    static func parse(_ dict: [String: Any]) -> ReadSelfEvent? {
        guard let id = dict["conversationId"] as? String, !id.isEmpty else { return nil }
        guard let ms = (dict["readAt"] as? NSNumber)?.doubleValue, ms.isFinite, ms > 0 else { return nil }
        let device = (dict["byDeviceId"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        let replay = (dict["replay"] as? Bool) == true || (dict["replay"] as? NSNumber)?.boolValue == true
        return ReadSelfEvent(
            conversationId: id,
            readAt: Date(timeIntervalSince1970: ms / 1000),
            byDeviceId: device,
            replay: replay
        )
    }
}

/// Сборщик событий read-self в одну проходку по Центру уведомлений: догон при подключении
/// приносит до сотни бесед разом, и на каждую звать getDeliveredNotifications незачем.
/// Только главный поток (обработчики сокета идут на main).
final class ReadSelfBanners {
    static let shared = ReadSelfBanners()

    /// Окно сборки: догон приходит пачкой за десятки миллисекунд.
    static let batchWindow: TimeInterval = 0.3

    /// беседа → самая поздняя граница снятия.
    private var pending: [String: Date] = [:]
    private var scheduled = false

    func enqueue(_ event: ReadSelfEvent) {
        pending[event.conversationId] = Self.later(pending[event.conversationId], event.deliveredUpTo)
        guard !scheduled else { return }
        scheduled = true
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.batchWindow) { [weak self] in
            self?.flush()
        }
    }

    private func flush() {
        let batch = pending
        pending = [:]
        scheduled = false
        guard !batch.isEmpty else { return }
        // Значок: прочитанные (где угодно) беседы выходят из общего счётчика.
        for (conversationId, upTo) in batch {
            AppBadge.shared.conversationRead(conversationId, upToMs: Int64(upTo.timeIntervalSince1970 * 1000))
        }
        MessageNotifications.shared.clearDelivered(upTo: batch) { removed in
            if removed > 0 {
                NSLog("ReadSelf: снято баннеров: %d (бесед: %d)", removed, batch.count)
            }
        }
    }

    /// Граница растёт: пачка «прочитано в 10:00» + «прочитано в 10:05» снимает всё до 10:05.
    static func later(_ a: Date?, _ b: Date) -> Date {
        guard let a else { return b }
        return max(a, b)
    }
}
