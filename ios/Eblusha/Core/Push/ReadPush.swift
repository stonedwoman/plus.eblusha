import Foundation

/// Тихий background-пуш «беседу прочитали на другом устройстве» (src/push/apns.ts,
/// kind=read): в нём только conversationId, без текста. Разбор вынесен из PushAppDelegate,
/// чтобы его можно было проверить XCTest без UIApplication.
///
/// Секретные беседы приходят в той же форме — баннеры по ним снимаются так же.
struct ReadPush: Equatable {
    let conversationId: String

    /// nil — это не read-пуш или в нём нет пригодного conversationId. Разбор терпим к
    /// лишним ключам (aps и прочее), но не к пустому id: снимать «все баннеры с пустым
    /// thread-id» нельзя.
    static func parse(_ userInfo: [AnyHashable: Any]) -> ReadPush? {
        guard userInfo["kind"] as? String == "read",
              let id = userInfo["conversationId"] as? String,
              !id.isEmpty
        else { return nil }
        return ReadPush(conversationId: id)
    }
}
