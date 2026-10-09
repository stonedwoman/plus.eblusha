import XCTest
@testable import Eblusha

/// Пуш kind=read («беседу прочитали на другом устройстве»): разбор и выбор баннеров на снятие.
/// Без сети и без UNUserNotificationCenter: выбор — чистые функции над слепком уведомления.
final class ReadPushTests: XCTestCase {
    typealias Info = MessageNotifications.DeliveredInfo

    // MARK: - Разбор

    func testParse_readPush() {
        let userInfo: [AnyHashable: Any] = [
            "aps": ["content-available": 1],
            "kind": "read",
            "conversationId": "c1",
        ]
        XCTAssertEqual(ReadPush.parse(userInfo), ReadPush(conversationId: "c1"))
    }

    func testParse_otherKindsAreNotRead() {
        for kind in ["message", "call", "call-cancel", "READ", ""] {
            XCTAssertNil(ReadPush.parse(["kind": kind, "conversationId": "c1"]), kind)
        }
        XCTAssertNil(ReadPush.parse(["conversationId": "c1"]))
    }

    func testParse_badConversationId() {
        XCTAssertNil(ReadPush.parse(["kind": "read"]))
        XCTAssertNil(ReadPush.parse(["kind": "read", "conversationId": ""]))
        XCTAssertNil(ReadPush.parse(["kind": "read", "conversationId": 42]))
    }

    // MARK: - Что снимать

    private let t0 = Date(timeIntervalSince1970: 1_000_000)

    private func info(
        _ id: String, thread: String = "", conv: String? = nil, kind: String? = "message", at: Date? = nil
    ) -> Info {
        Info(identifier: id, threadIdentifier: thread, userInfoConversationId: conv,
             kind: kind, date: at ?? t0)
    }

    func testIdentifiers_matchesThreadOrUserInfoAndAnyKind() {
        let list = [
            info("a", thread: "c1"),
            info("b", conv: "c1"),
            info("call", thread: "c1", kind: "call"),
            info("other", thread: "c2"),
        ]
        XCTAssertEqual(MessageNotifications.identifiers(in: list, forConversation: "c1"), ["a", "b", "call"])
        XCTAssertEqual(MessageNotifications.identifiers(in: list, forConversation: "nope"), [])
    }

    func testStale_removesOnlyReadMessageBannersDeliveredBeforeFetch() {
        let list = [
            info("read-thread", thread: "c1"),
            info("read-userinfo", conv: "c1"),
            info("unread", thread: "c2"),
            info("call-banner", thread: "c1", kind: "call"),
            info("no-kind", thread: "c1", kind: nil),
            info("fresh", thread: "c1", at: t0.addingTimeInterval(5)),
        ]
        let ids = MessageNotifications.staleIdentifiers(
            in: list, readConversations: ["c1"], deliveredBefore: t0
        )
        XCTAssertEqual(ids, ["read-thread", "read-userinfo"])
    }

    func testStale_emptyReadSetRemovesNothing() {
        let list = [info("a", thread: "c1")]
        XCTAssertEqual(
            MessageNotifications.staleIdentifiers(in: list, readConversations: [], deliveredBefore: t0), []
        )
    }
}
