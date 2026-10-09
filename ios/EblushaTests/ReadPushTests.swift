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

    func testParse_readAtMillisecondsFromServerClock() {
        // APNs отдаёт число; в userInfo оно приходит NSNumber (Int64 или Double).
        let r1 = ReadPush.parse(["kind": "read", "conversationId": "c1", "readAt": NSNumber(value: Int64(1_700_000_000_500))])
        XCTAssertEqual(r1?.readAt, Date(timeIntervalSince1970: 1_700_000_000.5))
        let r2 = ReadPush.parse(["kind": "read", "conversationId": "c1", "readAt": 1_700_000_000_500.0])
        XCTAssertEqual(r2?.readAt, Date(timeIntervalSince1970: 1_700_000_000.5))
        // граница снятия = момент прочтения + допуск на часы
        XCTAssertEqual(
            r1?.deliveredUpTo, Date(timeIntervalSince1970: 1_700_000_000.5 + ReadPush.clockTolerance)
        )
    }

    func testParse_noOrBadReadAtMeansNoBound() {
        for bad: Any in ["soon", 0, -5, Double.nan, Double.infinity] {
            let r = ReadPush.parse(["kind": "read", "conversationId": "c1", "readAt": bad])
            XCTAssertNotNil(r, "(bad)")
            XCTAssertNil(r?.readAt, "(bad)")
            XCTAssertNil(r?.deliveredUpTo, "(bad)")
        }
        XCTAssertNil(ReadPush.parse(["kind": "read", "conversationId": "c1"])?.deliveredUpTo)
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

    func testIdentifiers_deliveredBeforeKeepsBannersThatCameAfterTheRead() {
        // Баннер сообщения, пришедшего ПОСЛЕ прочтения (read-пуш-хвост опоздал), остаётся.
        let list = [
            info("old", thread: "c1", at: t0.addingTimeInterval(-30)),
            info("edge", thread: "c1", at: t0),
            info("newer", thread: "c1", at: t0.addingTimeInterval(2)),
            info("other-conv", thread: "c2", at: t0.addingTimeInterval(-30)),
        ]
        XCTAssertEqual(
            MessageNotifications.identifiers(in: list, forConversation: "c1", deliveredBefore: t0),
            ["old", "edge"]
        )
        // без границы (чтение на этом же телефоне / старый сервер) снимаются все
        XCTAssertEqual(
            MessageNotifications.identifiers(in: list, forConversation: "c1"),
            ["old", "edge", "newer"]
        )
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
