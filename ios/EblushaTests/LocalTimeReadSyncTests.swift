import XCTest
import Combine
@testable import Eblusha

// Местное время собеседника (LocalTime.swift) и read-sync 2 на iOS: сокет conversation:read-self
// (ReadSelfSync.swift) и «прочитано» только с экрана (ChatReadGate). Без сети: чистые функции,
// разбор JSON и вью-модель беседы поверх подменного транспорта (SecretTestRig / FakeServer).

// MARK: - Строка местного времени

final class LocalTimeFormatTests: XCTestCase {
    private func date(_ iso: String) -> Date {
        let f = ISO8601DateFormatter()
        return f.date(from: iso)!
    }

    private func tz(_ id: String) -> TimeZone { TimeZone(identifier: id)! }

    private let krasnoyarsk = LocalTimeInfo(timeZone: "Asia/Krasnoyarsk", city: "Красноярск", offsetMinutes: 420)

    func testOffsetLabel() {
        XCTAssertEqual(LocalTimeFormat.offsetLabel(seconds: 0), "UTC")
        XCTAssertEqual(LocalTimeFormat.offsetLabel(seconds: 7 * 3600), "UTC+7")
        XCTAssertEqual(LocalTimeFormat.offsetLabel(seconds: 5 * 3600 + 1800), "UTC+5:30")
        XCTAssertEqual(LocalTimeFormat.offsetLabel(seconds: 5 * 3600 + 2700), "UTC+5:45")
        XCTAssertEqual(LocalTimeFormat.offsetLabel(seconds: -3 * 3600), "UTC-3")
        XCTAssertEqual(LocalTimeFormat.offsetLabel(seconds: -(9 * 3600 + 1800)), "UTC-9:30")
        XCTAssertEqual(LocalTimeFormat.offsetLabel(seconds: 14 * 3600), "UTC+14")
    }

    func testLine_cityAndTwentyFourHours() {
        // 10:30 UTC = 17:30 в Красноярске; у меня Москва (+3) — время разное, строка есть.
        XCTAssertEqual(
            LocalTimeFormat.line(krasnoyarsk, now: date("2026-10-10T10:30:00Z"), myTimeZone: tz("Europe/Moscow")),
            "17:30, Красноярск"
        )
        // После полудня — 24 ч, без AM/PM.
        XCTAssertEqual(
            LocalTimeFormat.line(krasnoyarsk, now: date("2026-10-10T15:05:59Z"), myTimeZone: tz("Europe/Moscow")),
            "22:05, Красноярск"
        )
    }

    func testLine_sameOffsetMeansNoLine() {
        // Новосибирск и Красноярск — оба UTC+7: время совпадает, город ничего не добавляет.
        XCTAssertNil(LocalTimeFormat.line(krasnoyarsk, now: date("2026-10-10T10:30:00Z"), myTimeZone: tz("Asia/Novosibirsk")))
        XCTAssertNil(LocalTimeFormat.line(krasnoyarsk, now: date("2026-10-10T10:30:00Z"), myTimeZone: tz("Asia/Krasnoyarsk")))
    }

    func testLine_daylightSavingFollowsTheDate() {
        let bucharest = LocalTimeInfo(timeZone: "Europe/Bucharest", city: "Бухарест", offsetMinutes: 180)
        let moscow = tz("Europe/Moscow")
        // Летом Бухарест +3, как Москва — строки нет.
        XCTAssertNil(LocalTimeFormat.line(bucharest, now: date("2026-07-01T12:00:00Z"), myTimeZone: moscow))
        // Зимой Бухарест +2 (а offsetMinutes сервера устарел) — считаем по базе поясов.
        XCTAssertEqual(LocalTimeFormat.line(bucharest, now: date("2026-12-01T12:00:00Z"), myTimeZone: moscow), "14:00, Бухарест")
    }

    func testLine_wrapsAroundMidnight() {
        let tokyo = LocalTimeInfo(timeZone: "Asia/Tokyo", city: "Токио", offsetMinutes: 540)
        XCTAssertEqual(LocalTimeFormat.line(tokyo, now: date("2026-10-10T20:30:00Z"), myTimeZone: tz("UTC")), "05:30, Токио")
        let la = LocalTimeInfo(timeZone: "America/Los_Angeles", city: "Лос-Анджелес", offsetMinutes: -420)
        XCTAssertEqual(LocalTimeFormat.line(la, now: date("2026-10-10T01:15:00Z"), myTimeZone: tz("UTC")), "18:15, Лос-Анджелес")
    }

    func testLine_noCityWritesOffset() {
        let etc = LocalTimeInfo(timeZone: "Etc/GMT-7", city: nil, offsetMinutes: 420)
        XCTAssertEqual(LocalTimeFormat.line(etc, now: date("2026-10-10T10:30:00Z"), myTimeZone: tz("Europe/Moscow")), "17:30, UTC+7")
        let utc = LocalTimeInfo(timeZone: "Etc/UTC", city: nil, offsetMinutes: 0)
        XCTAssertEqual(LocalTimeFormat.line(utc, now: date("2026-10-10T10:30:00Z"), myTimeZone: tz("Europe/Moscow")), "10:30, UTC")
    }

    func testLine_unknownZoneFallsBackToServerOffset() {
        let unknown = LocalTimeInfo(timeZone: "Mars/Olympus_Mons", city: nil, offsetMinutes: 330)
        XCTAssertEqual(LocalTimeFormat.line(unknown, now: date("2026-10-10T10:30:00Z"), myTimeZone: tz("UTC")), "16:00, UTC+5:30")
        // Город сервера пишется и при запасном смещении.
        let unknownCity = LocalTimeInfo(timeZone: "Mars/Olympus_Mons", city: "Олимп", offsetMinutes: -180)
        XCTAssertEqual(LocalTimeFormat.line(unknownCity, now: date("2026-10-10T10:30:00Z"), myTimeZone: tz("UTC")), "07:30, Олимп")
    }

    func testLine_bothCanonicalAndNewNamesAreKnown() {
        // Сервер (ICU) отдаёт канонические старые имена — телефон их знает.
        for id in ["Asia/Calcutta", "Asia/Kolkata", "Europe/Kiev", "Europe/Kyiv"] {
            XCTAssertNotNil(TimeZone(identifier: id), id)
        }
        let kolkata = LocalTimeInfo(timeZone: "Asia/Calcutta", city: "Калькутта", offsetMinutes: 330)
        XCTAssertEqual(LocalTimeFormat.line(kolkata, now: date("2026-10-10T10:30:00Z"), myTimeZone: tz("UTC")), "16:00, Калькутта")
    }

    func testIanaIdentifier() {
        XCTAssertEqual(LocalTimeFormat.ianaIdentifier(tz("Asia/Krasnoyarsk")), "Asia/Krasnoyarsk")
        XCTAssertEqual(LocalTimeFormat.ianaIdentifier(tz("Europe/Bucharest")), "Europe/Bucharest")
        // Пояс из голого смещения: целые часы — Etc с обратным знаком, дробные — не шлём.
        XCTAssertEqual(LocalTimeFormat.ianaIdentifier(TimeZone(secondsFromGMT: 7 * 3600)!), "Etc/GMT-7")
        XCTAssertEqual(LocalTimeFormat.ianaIdentifier(TimeZone(secondsFromGMT: -3 * 3600)!), "Etc/GMT+3")
        XCTAssertNil(LocalTimeFormat.ianaIdentifier(TimeZone(secondsFromGMT: 5 * 3600 + 1800)!))
        XCTAssertTrue(LocalTimeFormat.isRawOffsetIdentifier("GMT+0700"))
        XCTAssertTrue(LocalTimeFormat.isRawOffsetIdentifier("GMT-03:30"))
        XCTAssertTrue(LocalTimeFormat.isRawOffsetIdentifier("UTC+7"))
        XCTAssertFalse(LocalTimeFormat.isRawOffsetIdentifier("GMT"))
        XCTAssertFalse(LocalTimeFormat.isRawOffsetIdentifier("Etc/GMT-7"))
        XCTAssertFalse(LocalTimeFormat.isRawOffsetIdentifier("Asia/Krasnoyarsk"))
    }
}

// MARK: - Разбор ответов сервера

final class LocalTimeDecodingTests: XCTestCase {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(json.utf8))
    }

    func testInfo() throws {
        let full = try decode(LocalTimeInfo.self, #"{"timeZone":"Asia/Krasnoyarsk","city":"Красноярск","offsetMinutes":420}"#)
        XCTAssertEqual(full, LocalTimeInfo(timeZone: "Asia/Krasnoyarsk", city: "Красноярск", offsetMinutes: 420))
        let noCity = try decode(LocalTimeInfo.self, #"{"timeZone":"Etc/GMT-7","city":null,"offsetMinutes":420}"#)
        XCTAssertNil(noCity.city)
        let blankCity = try decode(LocalTimeInfo.self, #"{"timeZone":"Etc/GMT-7","city":"  ","offsetMinutes":420.0}"#)
        XCTAssertNil(blankCity.city)
        XCTAssertEqual(blankCity.offsetMinutes, 420)
        XCTAssertThrowsError(try decode(LocalTimeInfo.self, #"{"city":"X","offsetMinutes":0}"#))
        XCTAssertThrowsError(try decode(LocalTimeInfo.self, #"{"timeZone":"","offsetMinutes":0}"#))
    }

    func testUserBrief_distinguishesAbsentFromNull() throws {
        let absent = try decode(UserBriefDto.self, #"{"id":"u","username":"x"}"#)
        XCTAssertFalse(absent.hasLocalTime)
        XCTAssertNil(absent.localTime)
        let null = try decode(UserBriefDto.self, #"{"id":"u","username":"x","localTime":null}"#)
        XCTAssertTrue(null.hasLocalTime)
        XCTAssertNil(null.localTime)
        let value = try decode(UserBriefDto.self, #"{"id":"u","username":"x","status":"ONLINE","localTime":{"timeZone":"Asia/Tokyo","city":"Токио","offsetMinutes":540}}"#)
        XCTAssertTrue(value.hasLocalTime)
        XCTAssertEqual(value.localTime?.city, "Токио")
        XCTAssertEqual(value.status, "ONLINE")
        // Битый пояс не роняет пользователя (а значит, и весь список бесед).
        let broken = try decode(UserBriefDto.self, #"{"id":"u","username":"x","localTime":{"oops":1}}"#)
        XCTAssertTrue(broken.hasLocalTime)
        XCTAssertNil(broken.localTime)
    }

    func testConversationList_onlyOneToOnePeersAndOnlyWhenServerSaidSomething() throws {
        let json = #"""
        {"conversations":[
          {"unreadCount":0,"conversation":{"id":"d1","isGroup":false,"participants":[
            {"userId":"me","user":{"id":"me","username":"me"}},
            {"userId":"p1","user":{"id":"p1","username":"p1","localTime":{"timeZone":"Asia/Krasnoyarsk","city":"Красноярск","offsetMinutes":420}}}]}},
          {"unreadCount":0,"conversation":{"id":"d2","isGroup":false,"participants":[
            {"userId":"me","user":{"id":"me","username":"me"}},
            {"userId":"p2","user":{"id":"p2","username":"p2","localTime":null}}]}},
          {"unreadCount":0,"conversation":{"id":"d3","isGroup":false,"participants":[
            {"userId":"me","user":{"id":"me","username":"me"}},
            {"userId":"p3","user":{"id":"p3","username":"p3"}}]}},
          {"unreadCount":0,"conversation":{"id":"g1","isGroup":true,"participants":[
            {"userId":"me","user":{"id":"me","username":"me"}},
            {"userId":"p4","user":{"id":"p4","username":"p4","localTime":{"timeZone":"Asia/Tokyo","city":"Токио","offsetMinutes":540}}}]}}
        ]}
        """#
        let response = try decode(ConversationsResponse.self, json)
        let times = ChatRepository.peerLocalTimes(response.conversations.map(\.conversation), meId: "me")
        XCTAssertEqual(Set(times.keys), ["p1", "p2"])
        XCTAssertEqual(times["p1"]??.city, "Красноярск")
        XCTAssertTrue(times.keys.contains("p2"))    // запись есть…
        XCTAssertNil(times["p2"]!)                  // …и она «убрать строку»
        XCTAssertFalse(times.keys.contains("p3"))   // старый сервер: не трогаем
        XCTAssertFalse(times.keys.contains("p4"))   // группа: никогда
    }

    func testUpdateEventAndPeerResponse() throws {
        let set = try decode(LocalTimeUpdatePayload.self, #"{"userId":"p1","localTime":{"timeZone":"Asia/Tokyo","city":"Токио","offsetMinutes":540}}"#)
        XCTAssertEqual(set.userId, "p1")
        XCTAssertEqual(set.localTime?.timeZone, "Asia/Tokyo")
        let cleared = try decode(LocalTimeUpdatePayload.self, #"{"userId":"p1","localTime":null}"#)
        XCTAssertNil(cleared.localTime)
        let peer = try decode(PeerLocalTimeDto.self, #"{"userId":"p1","localTime":null}"#)
        XCTAssertNil(peer.localTime)
        let own = try decode(OwnLocalTimeDto.self, #"{"shareLocalTime":false,"shareLocalTimeAt":1760000000123,"localTime":null}"#)
        XCTAssertFalse(own.shareLocalTime)
        XCTAssertEqual(own.shareLocalTimeAt, 1_760_000_000_123)
        let fresh = try decode(OwnLocalTimeDto.self, #"{"shareLocalTime":true,"shareLocalTimeAt":0,"localTime":{"timeZone":"Europe/Bucharest","city":"Бухарест","offsetMinutes":180}}"#)
        XCTAssertTrue(fresh.shareLocalTime)
        XCTAssertEqual(fresh.localTime?.city, "Бухарест")
    }

    func testStoreAppliesBatchAndRemovesOnNull() {
        let store = PeerLocalTimeStore()
        let info = LocalTimeInfo(timeZone: "Asia/Tokyo", city: "Токио", offsetMinutes: 540)
        store.set(userId: "p1", info)
        // В литерале словаря nil — это значение «убрать строку», а не отсутствие ключа.
        let batch: [String: LocalTimeInfo?] = ["p2": info, "p1": nil]
        XCTAssertEqual(batch.count, 2)
        store.apply(batch)
        XCTAssertNil(store.times["p1"])
        XCTAssertEqual(store.times["p2"], info)
        store.set(userId: "p2", nil)
        XCTAssertTrue(store.times.isEmpty)
    }
}

// MARK: - Своя настройка и отчёт о поясе

final class LocalTimeShareTests: XCTestCase {
    func testMergeKeepsNewest() {
        let off = LocalTimeShareState(share: false, at: 200)
        XCTAssertEqual(LocalTimeShareState.merge(known: nil, incoming: off), off)
        // Старый ack после свежего события не откатывает настройку.
        XCTAssertEqual(LocalTimeShareState.merge(known: off, incoming: .init(share: true, at: 100)), off)
        XCTAssertEqual(LocalTimeShareState.merge(known: off, incoming: .init(share: true, at: 300)), .init(share: true, at: 300))
        // Сервер после потери Redis: {true, 0} не перетирает выключенную настройку.
        XCTAssertEqual(LocalTimeShareState.merge(known: off, incoming: .init(share: true, at: 0)), off)
    }

    func testParseAckAndSettingsEvent() {
        XCTAssertEqual(
            LocalTimeShareState.parse(["ok": true, "timeZone": "Asia/Krasnoyarsk", "shareLocalTime": false, "shareLocalTimeAt": NSNumber(value: Int64(1_760_000_000_000))]),
            LocalTimeShareState(share: false, at: 1_760_000_000_000)
        )
        XCTAssertEqual(LocalTimeShareState.parse(["shareLocalTime": true, "shareLocalTimeAt": 0]), LocalTimeShareState(share: true, at: 0))
        XCTAssertNil(LocalTimeShareState.parse(["ok": false, "error": "invalid_time_zone"]))
    }

    func testReportPayload() {
        let plain = LocalTimeService.reportPayload(zone: TimeZone(identifier: "Asia/Krasnoyarsk")!, stored: nil)
        XCTAssertEqual(plain?["timeZone"] as? String, "Asia/Krasnoyarsk")
        // С сервера ничего не слышали — напоминания нет.
        XCTAssertNil(plain?["shareLocalTime"])
        XCTAssertNil(plain?["shareLocalTimeAt"])
        let reminder = LocalTimeService.reportPayload(
            zone: TimeZone(identifier: "Europe/Bucharest")!, stored: LocalTimeShareState(share: false, at: 1234)
        )
        XCTAssertEqual(reminder?["shareLocalTime"] as? Bool, false)
        XCTAssertEqual(reminder?["shareLocalTimeAt"] as? Int64, 1234)
        // Пояс из голого смещения: целые часы — Etc, дробные — не сообщаем вовсе.
        XCTAssertEqual(LocalTimeService.reportPayload(zone: TimeZone(secondsFromGMT: 7 * 3600)!, stored: nil)?["timeZone"] as? String, "Etc/GMT-7")
        XCTAssertNil(LocalTimeService.reportPayload(zone: TimeZone(secondsFromGMT: 19800)!, stored: nil))
    }

    func testStoredSharePerUserAndMonotonic() {
        let suite = "eb-localtime-tests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let service = LocalTimeService(defaults: defaults)
        XCTAssertNil(service.storedShare(userId: "u1"))
        service.applyServerShare(.init(share: false, at: 100), userId: "u1")
        XCTAssertEqual(service.storedShare(userId: "u1"), .init(share: false, at: 100))
        // Чужой аккаунт на том же телефоне напоминание первого не получает.
        XCTAssertNil(service.storedShare(userId: "u2"))
        service.applyServerShare(.init(share: true, at: 50), userId: "u1")
        XCTAssertEqual(service.storedShare(userId: "u1"), .init(share: false, at: 100))
        service.applyServerShare(.init(share: true, at: 150), userId: "u1")
        XCTAssertEqual(service.storedShare(userId: "u1"), .init(share: true, at: 150))
    }
}

// MARK: - read-self: снятие баннеров по сокету

final class ReadSelfTests: XCTestCase {
    typealias Info = MessageNotifications.DeliveredInfo

    func testParse() {
        let e = ReadSelfEvent.parse([
            "conversationId": "c1", "readAt": NSNumber(value: Int64(1_700_000_000_500)), "byDeviceId": "dev-pc",
        ])
        XCTAssertEqual(e?.conversationId, "c1")
        XCTAssertEqual(e?.readAt, Date(timeIntervalSince1970: 1_700_000_000.5))
        XCTAssertEqual(e?.byDeviceId, "dev-pc")
        XCTAssertEqual(e?.replay, false)
        XCTAssertEqual(e?.deliveredUpTo, Date(timeIntervalSince1970: 1_700_000_000.5 + ReadPush.clockTolerance))

        let replay = ReadSelfEvent.parse(["conversationId": "c2", "readAt": 1_700_000_000_000.0, "replay": true])
        XCTAssertEqual(replay?.replay, true)
        XCTAssertNil(replay?.byDeviceId)
        XCTAssertNil(ReadSelfEvent.parse(["conversationId": "c2", "readAt": 1, "byDeviceId": ""])?.byDeviceId)
    }

    func testParse_withoutReadAtOrIdRemovesNothing() {
        XCTAssertNil(ReadSelfEvent.parse(["conversationId": "c1"]))
        XCTAssertNil(ReadSelfEvent.parse(["conversationId": "c1", "readAt": 0]))
        XCTAssertNil(ReadSelfEvent.parse(["conversationId": "c1", "readAt": "soon"]))
        XCTAssertNil(ReadSelfEvent.parse(["conversationId": "", "readAt": 5]))
        XCTAssertNil(ReadSelfEvent.parse(["readAt": 5]))
    }

    func testBatchSelection_eachConversationItsOwnCutoff() {
        let t0 = Date(timeIntervalSince1970: 1_000_000)
        let list = [
            Info(identifier: "a-old", threadIdentifier: "a", userInfoConversationId: "a", kind: "message", date: t0),
            Info(identifier: "a-new", threadIdentifier: "a", userInfoConversationId: "a", kind: "message", date: t0 + 30),
            Info(identifier: "b-old", threadIdentifier: "", userInfoConversationId: "b", kind: "message", date: t0 + 10),
            Info(identifier: "b-new", threadIdentifier: "", userInfoConversationId: "b", kind: "message", date: t0 + 70),
            Info(identifier: "c", threadIdentifier: "c", userInfoConversationId: "c", kind: "message", date: t0),
            Info(identifier: "a-call", threadIdentifier: "a", userInfoConversationId: "a", kind: "call", date: t0 + 5),
        ]
        let ids = MessageNotifications.identifiers(in: list, upTo: ["a": t0 + 20, "b": t0 + 60])
        // Пришедшее позже прочтения остаётся; чужая беседа не трогается.
        XCTAssertEqual(Set(ids), ["a-old", "a-call", "b-old"])
        XCTAssertTrue(MessageNotifications.identifiers(in: list, upTo: [:]).isEmpty)
    }

    func testLaterCutoffWins() {
        let t0 = Date(timeIntervalSince1970: 1_000_000)
        XCTAssertEqual(ReadSelfBanners.later(nil, t0), t0)
        XCTAssertEqual(ReadSelfBanners.later(t0 + 5, t0), t0 + 5)
        XCTAssertEqual(ReadSelfBanners.later(t0, t0 + 5), t0 + 5)
    }
}

// MARK: - «Прочитано» только с экрана

final class ChatReadGateTests: XCTestCase {
    func testGate() {
        var gate = ChatReadGate(appForeground: true)
        XCTAssertFalse(gate.visible)
        // Экран показан — стала видна.
        XCTAssertTrue(gate.update(screenShown: true))
        XCTAssertTrue(gate.visible)
        XCTAssertFalse(gate.update(screenShown: true))
        // Ушли в фон (звонок держит сокет) — не видна; вернулись — снова «стала».
        XCTAssertFalse(gate.update(appForeground: false))
        XCTAssertFalse(gate.visible)
        XCTAssertTrue(gate.update(appForeground: true))
        // Развёрнутый звонок закрывает беседу, плитка — нет.
        XCTAssertFalse(gate.update(coveredByCall: true))
        XCTAssertFalse(gate.visible)
        XCTAssertTrue(gate.update(coveredByCall: false))
        // Сняли с экрана — не видна даже на переднем плане.
        XCTAssertFalse(gate.update(screenShown: false))
        XCTAssertFalse(gate.visible)
        // В фоне показ экрана ещё не «видна».
        var bg = ChatReadGate(appForeground: false)
        XCTAssertFalse(bg.update(screenShown: true))
        XCTAssertTrue(bg.update(appForeground: true))
    }

    func testCallCovers() {
        XCTAssertFalse(ChatReadGate.callCovers(phase: .idle, minimized: false))
        XCTAssertTrue(ChatReadGate.callCovers(phase: .incoming, minimized: false))
        XCTAssertTrue(ChatReadGate.callCovers(phase: .outgoing, minimized: false))
        XCTAssertTrue(ChatReadGate.callCovers(phase: .inCall, minimized: false))
        XCTAssertFalse(ChatReadGate.callCovers(phase: .inCall, minimized: true))
    }
}

/// Вью-модель беседы целиком: «прочитано» уходит серверу только пока беседа на экране.
@MainActor
final class ChatReadGateViewModelTests: XCTestCase {
    private var rig: SecretTestRig!
    private var cancellables: Set<AnyCancellable> = []

    override func setUp() async throws {
        rig = SecretTestRig()
        rig.server.addSecretThread("c1", participants: [rig.me, "peer"], type: "DIRECT")
        rig.server.extraRoute = { method, path, _ in
            switch (method, path) {
            case ("GET", "conversations/c1/messages"):
                return (200, FakeServer.data(["messages": [], "hasMore": false]))
            case ("POST", "messages/mark-conversation-read"):
                return (200, FakeServer.data(["success": true]))
            case ("GET", "users/peer/local-time"):
                return (200, FakeServer.data([
                    "userId": "peer",
                    "localTime": ["timeZone": "Asia/Krasnoyarsk", "city": "Красноярск", "offsetMinutes": 420],
                ]))
            default:
                return nil
            }
        }
    }

    override func tearDown() async throws {
        rig.tearDown()
        rig = nil
        PeerLocalTimeStore.shared.clear()
    }

    private var markCalls: Int { rig.server.calls("POST", "messages/mark-conversation-read").count }

    private func waitUntil(_ timeout: TimeInterval = 3, _ condition: () -> Bool) async {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() && Date() < deadline {
            try? await Task.sleep(for: .milliseconds(30))
        }
    }

    private func settle(_ seconds: Double = 0.3) async {
        try? await Task.sleep(for: .milliseconds(Int(seconds * 1000)))
    }

    private func incoming(_ realtime: RealtimeClient, _ id: String) throws {
        let json = #"{"id":"\#(id)","conversationId":"c1","senderId":"peer","type":"TEXT","content":"привет","createdAt":"2026-10-10T10:00:00.000Z"}"#
        let dto = try JSONDecoder().decode(MessageDto.self, from: Data(json.utf8))
        realtime.events.send(.messageNew(conversationId: "c1", messageId: id, senderId: "peer", message: dto))
    }

    func testMarksReadOnlyWhileConversationIsOnScreen() async throws {
        let chats = ChatRepository(api: rig.api, session: rig.session)
        let realtime = RealtimeClient(session: rig.session, deviceIdProvider: rig.deviceIds, api: rig.api)
        let foreground = CurrentValueSubject<Bool, Never>(true)
        let cover = CurrentValueSubject<Bool, Never>(false)
        let vm = ChatViewModel(
            repo: chats, realtime: realtime, conversationId: "c1", secretRepo: rig.repo,
            callCover: cover.eraseToAnyPublisher(), foreground: foreground.eraseToAnyPublisher()
        )

        // Лента загрузилась, но экран ещё не показан — «прочитано» не уходит.
        await waitUntil { vm.autoReadReady }
        XCTAssertTrue(vm.autoReadReady)
        try incoming(realtime, "m1")
        await settle()
        XCTAssertEqual(markCalls, 0, "не на экране — не квитируем")

        // Местное время собеседника подтянулось при открытии 1:1.
        await waitUntil { PeerLocalTimeStore.shared.times["peer"] != nil }
        XCTAssertEqual(PeerLocalTimeStore.shared.times["peer"]?.city, "Красноярск")

        // Экран показан — отмечаем сразу всё, что пришло, пока не смотрели.
        vm.onScreenShown(true)
        await waitUntil { markCalls == 1 }
        XCTAssertEqual(markCalls, 1)

        // Входящее в окне троттла ждёт хвоста; звонок развернулся поверх — хвост досылается
        // сразу (человек это сообщение видел), а дальше под звонком ничего не квитируется.
        try incoming(realtime, "m2")
        await settle(0.2)
        XCTAssertEqual(markCalls, 1)
        cover.send(true)
        await waitUntil(1) { markCalls == 2 }
        XCTAssertEqual(markCalls, 2, "хвост досылается при уходе с экрана")
        try incoming(realtime, "m3")
        await settle()
        XCTAssertEqual(markCalls, 2, "под развёрнутым звонком не квитируем")

        // Звонок свернули — беседа снова видна: отметка (через окно троттла).
        cover.send(false)
        await waitUntil { markCalls == 3 }
        XCTAssertEqual(markCalls, 3)

        // Приложение в фоне (звонок держит сокет) — входящее не квитируется.
        foreground.send(false)
        try incoming(realtime, "m4")
        await settle(1.8)
        XCTAssertEqual(markCalls, 3, "из фона не квитируем")

        // Вернулись на передний план — беседа на экране, отмечаем.
        foreground.send(true)
        await waitUntil { markCalls == 4 }
        XCTAssertEqual(markCalls, 4)

        // Экран сняли (ушли в список) — дальше тишина.
        await settle(1.6)
        vm.onDisappear()
        try incoming(realtime, "m5")
        await settle()
        XCTAssertEqual(markCalls, 4, "снятый с экрана чат не квитирует")
        withExtendedLifetime(vm) {}
    }
}
