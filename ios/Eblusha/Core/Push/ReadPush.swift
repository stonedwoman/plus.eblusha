import Foundation

/// Тихий background-пуш «беседу прочитали на другом устройстве» (src/push/apns.ts,
/// kind=read): в нём только conversationId и момент прочтения, без текста. Разбор вынесен из
/// PushAppDelegate, чтобы его можно было проверить XCTest без UIApplication.
///
/// Секретные беседы приходят в той же форме — баннеры по ним снимаются так же.
struct ReadPush: Equatable {
    let conversationId: String
    /// Когда беседу прочитали (часы сервера). nil — старый сервер / сбой Redis: снимаем всё.
    let readAt: Date?

    /// Допуск на расхождение часов телефона и сервера. Баннеры, пришедшие позже `readAt` + допуск,
    /// ещё не прочитаны (пуш — особенно «хвост» дребезга или пуш после обрыва сети — мог прийти
    /// позже прочтения) и остаются в Центре уведомлений.
    static let clockTolerance: TimeInterval = 1.0

    init(conversationId: String, readAt: Date? = nil) {
        self.conversationId = conversationId
        self.readAt = readAt
    }

    /// Баннеры с `date` позже этой границы снимать нельзя. nil — границы нет.
    var deliveredUpTo: Date? { readAt?.addingTimeInterval(Self.clockTolerance) }

    /// nil — это не read-пуш или в нём нет пригодного conversationId. Разбор терпим к
    /// лишним ключам (aps и прочее), но не к пустому id: снимать «все баннеры с пустым
    /// thread-id» нельзя.
    static func parse(_ userInfo: [AnyHashable: Any]) -> ReadPush? {
        guard userInfo["kind"] as? String == "read",
              let id = userInfo["conversationId"] as? String,
              !id.isEmpty
        else { return nil }
        var readAt: Date?
        if let ms = (userInfo["readAt"] as? NSNumber)?.doubleValue, ms.isFinite, ms > 0 {
            readAt = Date(timeIntervalSince1970: ms / 1000)
        }
        return ReadPush(conversationId: id, readAt: readAt)
    }
}
