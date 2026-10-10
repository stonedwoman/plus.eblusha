import XCTest
import Combine
@testable import Eblusha

// «Без звука» на iOS: правила (те же тест-векторы, что у сервера — test/conversation-mute-rules.test.ts —
// и у веба/натива/Android), подписи, разбор провода, хранилище со свежестью, действие пользователя
// через подменный сервер, решение Notification Service Extension и значок приложения.

private let NOW: Int64 = 1_791_732_600_000 // 2026-10-11T15:30:00.000Z
private let ME = "me"
private let OTHER = "other"
private let HOUR: Int64 = 3_600_000

final class ConversationMuteRulesTests: XCTestCase {
    private let muted = NOW + HOUR

    func testIsMutedStrictAndExpired() {
        XCTAssertFalse(MuteRules.isMuted(untilMs: nil, nowMs: NOW))
        XCTAssertTrue(MuteRules.isMuted(untilMs: NOW + 1, nowMs: NOW), "now+1ms → заглушено")
        XCTAssertFalse(MuteRules.isMuted(untilMs: NOW, nowMs: NOW), "now → нет (строго)")
        XCTAssertFalse(MuteRules.isMuted(untilMs: NOW - 1, nowMs: NOW), "истёкший срок = не заглушено")
        XCTAssertNil(MuteRules.effectiveUntil(untilMs: NOW - 1, nowMs: NOW))
        XCTAssertEqual(MuteRules.effectiveUntil(untilMs: muted, nowMs: NOW), muted)
    }

    func testForever() {
        // Те же моменты, что у сервера: 2100-01-01 и порог 2099-12-31.
        XCTAssertEqual(MuteRules.foreverMs, Int64(ISO8601DateFormatter().date(from: "2100-01-01T00:00:00Z")!.timeIntervalSince1970 * 1000))
        XCTAssertEqual(MuteRules.foreverFromMs, Int64(ISO8601DateFormatter().date(from: "2099-12-31T00:00:00Z")!.timeIntervalSince1970 * 1000))
        XCTAssertTrue(MuteRules.isMuted(untilMs: MuteRules.foreverMs, nowMs: NOW))
        XCTAssertTrue(MuteRules.isForever(untilMs: MuteRules.foreverMs))
        XCTAssertTrue(MuteRules.isForever(untilMs: MuteRules.foreverFromMs))
        XCTAssertFalse(MuteRules.isForever(untilMs: MuteRules.foreverFromMs - 1))
        XCTAssertFalse(MuteRules.isForever(untilMs: muted))
        XCTAssertFalse(MuteRules.isForever(untilMs: nil))
    }

    private func alert(
        _ until: Int64?, group: Bool, sender: String = OTHER, replyTo: String? = nil,
        callSystem: Bool = false, mentions: [String] = []
    ) -> Bool {
        MuteRules.shouldAlert(
            untilMs: until, nowMs: NOW, isGroup: group, recipientId: ME, senderId: sender,
            replyToSenderId: replyTo, callSystem: callSystem, mentionedUserIds: mentions
        )
    }

    func testNotMutedAlertsEverything() {
        XCTAssertTrue(alert(nil, group: true))
        XCTAssertTrue(alert(nil, group: false))
        XCTAssertTrue(alert(NOW - 1, group: true), "истёкший срок = не заглушено")
        XCTAssertFalse(alert(nil, group: true, sender: ME), "своё сообщение не звенит никогда")
    }

    func testGroupBreakthroughOnlyForRepliesToMe() {
        XCTAssertTrue(alert(muted, group: true, replyTo: ME), "группа + ответ на моё → будить")
        XCTAssertFalse(alert(muted, group: true, replyTo: OTHER), "группа + ответ на чужое → нет")
        XCTAssertTrue(alert(MuteRules.foreverMs, group: true, replyTo: ME), "навсегда — тоже пробивает")
        // Ответ бота на мой вопрос — то же самое: replyTo.senderId == я, отправитель — бот.
        XCTAssertTrue(alert(muted, group: true, sender: "bot", replyTo: ME), "группа + ответ бота на моё → будить")
    }

    func testGroupCallsAndOtherAreSilent() {
        XCTAssertFalse(alert(muted, group: true), "группа + «начал звонок»/обычное → нет")
        XCTAssertFalse(alert(muted, group: true, callSystem: true), "группа + «звонок продлился» → нет")
    }

    func testGroupMentions() {
        XCTAssertTrue(alert(muted, group: true, mentions: [OTHER, ME]))
        XCTAssertFalse(alert(muted, group: true, mentions: [OTHER]))
    }

    func testDirectBotChatAndSecretAreSilentExceptCalls() {
        XCTAssertFalse(alert(muted, group: false, replyTo: ME), "1:1 + ответ на моё → нет")
        XCTAssertFalse(alert(muted, group: false, sender: "bot", replyTo: ME), "«Чат с Еблушей» + ответ бота на моё → нет")
        XCTAssertFalse(alert(muted, group: false), "секретка / обычное → нет")
        XCTAssertTrue(alert(muted, group: false, callSystem: true), "1:1 + запись о звонке → будить")
    }

    func testCallSystemMessage() {
        XCTAssertTrue(MuteRules.isCallSystemMessage(type: "SYSTEM", missed: true, ended: false))
        XCTAssertTrue(MuteRules.isCallSystemMessage(type: "SYSTEM", missed: false, ended: true))
        XCTAssertFalse(MuteRules.isCallSystemMessage(type: "SYSTEM", missed: false, ended: false), "started/участники")
        XCTAssertFalse(MuteRules.isCallSystemMessage(type: "TEXT", missed: true, ended: false))
        XCTAssertFalse(MuteRules.isCallSystemMessage(type: nil, missed: true, ended: true))
    }

    func testNextExpiryAndTotalUnread() {
        XCTAssertEqual(MuteRules.nextExpiry([nil, NOW - 5, NOW + 9_000, NOW + 3_000, MuteRules.foreverMs], nowMs: NOW), NOW + 3_000)
        XCTAssertNil(MuteRules.nextExpiry([nil, MuteRules.foreverMs, NOW], nowMs: NOW), "навсегда и истёкшие таймера не требуют")
        let total = MuteRules.totalUnread([(3, nil), (5, muted), (2, NOW - 1), (4, MuteRules.foreverMs), (-1, nil)], nowMs: NOW)
        XCTAssertEqual(total, 5, "заглушённые не считаются, истёкшие — считаются")
    }

    func testPresetsTexts() {
        XCTAssertEqual(MutePreset.allCases.map(\.rawValue), ["1h", "8h", "1d", "1w", "forever"])
        XCTAssertEqual(MutePreset.allCases.map(\.title), ["1 час", "8 часов", "1 день", "1 неделю", "Навсегда"])
        XCTAssertEqual(MutePreset.allCases.map(\.doneText), [
            "Без звука на 1 час", "Без звука на 8 часов", "Без звука на 1 день", "Без звука на 1 неделю", "Без звука навсегда",
        ])
        XCTAssertEqual(MutePreset.allCases.compactMap(\.durationMs), [3_600_000, 28_800_000, 86_400_000, 604_800_000])
        XCTAssertEqual(MuteText.mute, "Без звука")
        XCTAssertEqual(MuteText.unmute, "Включить звук")
        XCTAssertEqual(MuteText.pickerTitle, "Без звука на…")
        XCTAssertEqual(MuteText.unmuted, "Звук включён")
        XCTAssertEqual(MuteText.failed, "Не удалось изменить звук беседы")
    }
}

final class ConversationMuteLabelTests: XCTestCase {
    private let zone = TimeZone(identifier: "Europe/Bucharest")!

    private func ms(_ iso: String) -> Int64 {
        Int64(ISO8601DateFormatter().date(from: iso)!.timeIntervalSince1970 * 1000)
    }

    private func date(_ iso: String) -> Date { ISO8601DateFormatter().date(from: iso)! }

    func testLabelsTodayTomorrowYear() {
        // Бухарест осенью — UTC+3: 15:30Z = 18:30 местного.
        let now = date("2026-10-11T12:00:00Z")
        XCTAssertEqual(MuteText.until(ms("2026-10-11T15:30:00Z"), now: now, timeZone: zone), "до 18:30")
        XCTAssertEqual(MuteText.until(ms("2026-10-12T15:30:00Z"), now: now, timeZone: zone), "до завтра, 18:30")
        XCTAssertEqual(MuteText.until(ms("2026-10-14T15:30:00Z"), now: now, timeZone: zone), "до 14 окт., 18:30")
        XCTAssertEqual(MuteText.until(ms("2027-10-14T15:30:00Z"), now: now, timeZone: zone), "до 14 окт. 2027, 18:30")
        XCTAssertEqual(MuteText.until(MuteRules.foreverMs, now: now, timeZone: zone), "навсегда")
        XCTAssertEqual(MuteText.tip(ms("2026-10-11T15:30:00Z"), now: now, timeZone: zone), "Без звука до 18:30")
        XCTAssertEqual(MuteText.tip(ms("2026-10-12T15:30:00Z"), now: now, timeZone: zone), "Без звука до завтра, 18:30")
        XCTAssertEqual(MuteText.tip(MuteRules.foreverMs, now: now, timeZone: zone), "Без звука навсегда")
    }

    func testDayAndYearBoundaries() {
        // 23:50 местного: срок «через 20 минут» — уже завтра, 00:10.
        let lateEvening = date("2026-10-11T20:50:00Z")
        XCTAssertEqual(MuteText.until(ms("2026-10-11T21:10:00Z"), now: lateEvening, timeZone: zone), "до завтра, 00:10")
        XCTAssertEqual(MuteText.until(ms("2026-10-11T20:59:00Z"), now: lateEvening, timeZone: zone), "до 23:59")
        // 31 декабря: 1 января — «завтра», 2 января — уже другой год, с годом.
        let newYearsEve = date("2026-12-31T10:00:00Z") // зимой Бухарест — UTC+2
        XCTAssertEqual(MuteText.until(ms("2027-01-01T08:00:00Z"), now: newYearsEve, timeZone: zone), "до завтра, 10:00")
        XCTAssertEqual(MuteText.until(ms("2027-01-02T08:00:00Z"), now: newYearsEve, timeZone: zone), "до 2 янв. 2027, 10:00")
    }

    func testRussianShortMonths() {
        let now = date("2026-01-01T00:00:00Z")
        let utc = TimeZone(identifier: "UTC")!
        let expected = ["янв.", "февр.", "мар.", "апр.", "мая", "июня", "июля", "авг.", "сент.", "окт.", "нояб.", "дек."]
        for (index, month) in expected.enumerated() {
            let iso = String(format: "2026-%02d-15T09:05:00Z", index + 1)
            XCTAssertEqual(MuteText.until(ms(iso), now: now, timeZone: utc), "до 15 \(month), 09:05")
        }
    }
}

final class ConversationMuteWireTests: XCTestCase {
    private func json(_ text: String) -> [String: Any] {
        try! JSONSerialization.jsonObject(with: Data(text.utf8)) as! [String: Any]
    }

    func testEventParse() {
        let on = ConversationMuteEvent.parse(json(#"{"conversationId":"c1","mutedUntil":"2026-10-11T16:30:00.000Z","mutedForever":false,"at":"2026-10-11T15:30:00.012Z","byDeviceId":"dev-2"}"#))
        XCTAssertEqual(on?.conversationId, "c1")
        XCTAssertEqual(on?.untilMs, NOW + HOUR)
        XCTAssertEqual(on?.atMs, NOW + 12)
        XCTAssertEqual(on?.byDeviceId, "dev-2")

        let off = ConversationMuteEvent.parse(json(#"{"conversationId":"c1","mutedUntil":null,"mutedForever":false,"at":"2026-10-11T15:30:00.000Z"}"#))
        XCTAssertNotNil(off)
        XCTAssertNil(off?.untilMs, "null — звук включён")

        let forever = ConversationMuteEvent.parse(json(#"{"conversationId":"c1","mutedUntil":"2100-01-01T00:00:00.000Z","mutedForever":true,"at":"2026-10-11T15:30:00.000Z"}"#))
        XCTAssertEqual(forever?.untilMs, MuteRules.foreverMs)

        XCTAssertNil(ConversationMuteEvent.parse(json(#"{"mutedUntil":null}"#)), "без беседы")
        XCTAssertNil(ConversationMuteEvent.parse(json(#"{"conversationId":"c1"}"#)), "без поля mutedUntil — битое событие")
        XCTAssertNil(ConversationMuteEvent.parse(json(#"{"conversationId":"c1","mutedUntil":"завтра"}"#)), "мусор в сроке")
    }

    func testSnapshotParse() {
        let snap = ConversationMuteSnapshot.parse(json(#"""
        {"items":[{"conversationId":"a","mutedUntil":"2026-10-11T16:30:00.000Z","mutedForever":false},
                  {"conversationId":"b","mutedUntil":"2100-01-01T00:00:00.000Z","mutedForever":true},
                  {"conversationId":"","mutedUntil":"2026-10-11T16:30:00.000Z"},
                  {"conversationId":"c","mutedUntil":"мусор"}],
         "serverNow":"2026-10-11T15:30:00.000Z"}
        """#))
        XCTAssertEqual(snap?.items, ["a": NOW + HOUR, "b": MuteRules.foreverMs])
        XCTAssertEqual(snap?.serverNowMs, NOW)
        XCTAssertNil(ConversationMuteSnapshot.parse(json(#"{"serverNow":"2026-10-11T15:30:00.000Z"}"#)))
    }

    func testListDecodingAndBatch() throws {
        let body = #"""
        {"conversations":[
          {"unreadCount":3,"mutedUntil":"2026-10-11T16:30:00.000Z","mutedForever":false,
           "conversation":{"id":"g1","isGroup":true,"participants":[{"userId":"me"},{"userId":"x"}],"messages":[]}},
          {"unreadCount":2,"mutedUntil":null,"mutedForever":false,
           "conversation":{"id":"d1","isGroup":false,"participants":[],"messages":[]}},
          {"unreadCount":1,"mutedUntil":"2100-01-01T00:00:00.000Z","mutedForever":true,
           "conversation":{"id":"b1","isGroup":false,"participants":[],"messages":[]}}
        ],"serverNow":"2026-10-11T15:30:00.000Z","totalUnread":2}
        """#
        let response = try JSONDecoder().decode(ConversationsResponse.self, from: Data(body.utf8))
        XCTAssertEqual(response.totalUnread, 2)
        XCTAssertEqual(response.serverNow, "2026-10-11T15:30:00.000Z")
        XCTAssertEqual(response.conversations.map(\.hasMuteField), [true, true, true])
        XCTAssertEqual(response.conversations.map(\.muteUntilMs), [NOW + HOUR, nil, MuteRules.foreverMs])

        let batch = ChatRepository.muteBatch(response, owner: ME, requestedAt: Date(timeIntervalSince1970: 1))
        XCTAssertEqual(batch.serverNowMs, NOW)
        XCTAssertEqual(batch.unread, ["g1": 3, "d1": 2, "b1": 1])
        XCTAssertEqual(batch.mutes.count, 3)
        XCTAssertEqual(batch.mutes["d1"], .some(nil), "null от нового сервера — «звук включён», а не «не знаю»")
        XCTAssertEqual(batch.requestedAtMs, 1000)
    }

    func testOldServerListHasNoMuteFields() throws {
        let body = #"{"conversations":[{"unreadCount":1,"conversation":{"id":"g1","isGroup":true}}]}"#
        let response = try JSONDecoder().decode(ConversationsResponse.self, from: Data(body.utf8))
        XCTAssertNil(response.serverNow)
        XCTAssertNil(response.totalUnread)
        XCTAssertFalse(response.conversations[0].hasMuteField)
        let batch = ChatRepository.muteBatch(response, owner: ME, requestedAt: Date())
        XCTAssertTrue(batch.mutes.isEmpty, "старый сервер «Без звука» не трогает")
        XCTAssertNil(batch.serverNowMs)
    }

    func testMessageNotifyMutedField() throws {
        let withField = try JSONDecoder().decode(MessageEventPayload.self, from: Data(
            #"{"conversationId":"c","messageId":"m","senderId":"s","muted":true}"#.utf8))
        XCTAssertEqual(withField.muted, true)
        let old = try JSONDecoder().decode(MessageEventPayload.self, from: Data(
            #"{"conversationId":"c","messageId":"m","senderId":"s"}"#.utf8))
        XCTAssertNil(old.muted, "старый сервер — решает своё правило")
    }

    func testRequestBody() throws {
        let preset = try JSONSerialization.jsonObject(with: JSONEncoder().encode(ConversationMuteRequest(preset: .eightHours))) as? [String: Any]
        XCTAssertEqual(preset?["for"] as? String, "8h")
        XCTAssertNil(preset?["until"])
        let unmute = try JSONSerialization.jsonObject(with: JSONEncoder().encode(ConversationMuteRequest(preset: nil))) as? [String: Any]
        XCTAssertTrue(unmute?["until"] is NSNull, "«Включить звук» — явный until: null")
        XCTAssertNil(unmute?["for"])
    }
}

final class ConversationMuteStoreTests: XCTestCase {
    private var suiteName = ""
    private var defaults: UserDefaults!
    private var clock = Date(timeIntervalSince1970: Double(NOW) / 1000)

    override func setUp() {
        super.setUp()
        suiteName = "eb-mute-tests-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
        clock = Date(timeIntervalSince1970: Double(NOW) / 1000)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        defaults = nil
        super.tearDown()
    }

    private func store(api: APIClient? = nil) -> ConversationMuteStore {
        ConversationMuteStore(defaults: defaults, api: { api }, currentUser: { ME }, now: { [unowned self] in self.clock })
    }

    func testListThenNewerEventThenStaleList() {
        let s = store()
        s.applyList(owner: ME, items: ["g1": NOW + HOUR, "d1": nil], serverNowMs: NOW, requestedAtMs: NOW)
        XCTAssertTrue(s.isMuted("g1"))
        XCTAssertFalse(s.isMuted("d1"))
        XCTAssertEqual(s.label("g1").map { !$0.isEmpty }, true)
        XCTAssertNil(s.label("d1"))

        // Включили звук на другом устройстве.
        s.applyEvent(ConversationMuteEvent(conversationId: "g1", untilMs: nil, atMs: NOW + 5_000, byDeviceId: "pc"))
        XCTAssertFalse(s.isMuted("g1"))
        // Список, ушедший раньше события, его не перетирает.
        s.applyList(owner: ME, items: ["g1": NOW + HOUR], serverNowMs: NOW + 1_000, requestedAtMs: NOW)
        XCTAssertFalse(s.isMuted("g1"), "старый список не возвращает «Без звука»")
        // А более свежий — применяется.
        s.applyList(owner: ME, items: ["g1": NOW + 2 * HOUR], serverNowMs: NOW + 9_000, requestedAtMs: NOW)
        XCTAssertTrue(s.isMuted("g1"))
    }

    func testSnapshotReplacesWholeState() {
        let s = store()
        s.applyList(owner: ME, items: ["a": NOW + HOUR, "b": NOW + HOUR], serverNowMs: NOW, requestedAtMs: NOW)
        // «Включить звук» на «a», пока телефон был без связи: в снапшоте её нет.
        s.applySnapshot(ConversationMuteSnapshot(items: ["b": NOW + HOUR, "c": MuteRules.foreverMs], serverNowMs: NOW + 60_000))
        XCTAssertFalse(s.isMuted("a"), "нет в снапшоте — не заглушено")
        XCTAssertTrue(s.isMuted("b"))
        XCTAssertTrue(s.isMuted("c"))
        XCTAssertEqual(s.label("c"), "навсегда")
        // Снапшот старше события по «c» её не трогает.
        s.applyEvent(ConversationMuteEvent(conversationId: "c", untilMs: nil, atMs: NOW + 120_000, byDeviceId: nil))
        s.applySnapshot(ConversationMuteSnapshot(items: ["b": NOW + HOUR, "c": MuteRules.foreverMs], serverNowMs: NOW + 90_000))
        XCTAssertFalse(s.isMuted("c"))
    }

    func testSetAtSurvivesSameValueAndResetsOnNewValue() {
        var state = MuteSharedState()
        ConversationMuteStore.merge(&state, id: "g", untilMs: NOW + HOUR, asOfMs: NOW, setAtMs: NOW)
        ConversationMuteStore.merge(&state, id: "g", untilMs: NOW + HOUR, asOfMs: NOW + 10, setAtMs: nil)
        XCTAssertEqual(state.entries["g"]?.setAtMs, NOW, "список с тем же сроком момент изменения не теряет")
        ConversationMuteStore.merge(&state, id: "g", untilMs: NOW + 2 * HOUR, asOfMs: NOW + 20, setAtMs: nil)
        XCTAssertNil(state.entries["g"]?.setAtMs, "новое значение без момента — момент неизвестен")
        ConversationMuteStore.merge(&state, id: "g", untilMs: nil, asOfMs: NOW + 5, setAtMs: NOW + 5)
        XCTAssertEqual(state.entries["g"]?.untilMs, NOW + 2 * HOUR, "старое знание не применяется")
    }

    func testExpiryIsComparisonWithNow() {
        let s = store()
        s.applyList(owner: ME, items: ["g": NOW + 1_000], serverNowMs: NOW, requestedAtMs: NOW)
        XCTAssertTrue(s.isMuted("g"))
        clock = clock.addingTimeInterval(1.5)
        let tickBefore = s.tick
        s.refreshClock()
        XCTAssertEqual(s.tick, tickBefore + 1)
        XCTAssertFalse(s.isMuted("g"), "срок истёк — беседа снова звучит, без события и без уборки")
        XCTAssertNil(s.tip("g"))
    }

    func testClockOffsetFromServerNow() {
        let s = store()
        // Телефон отстаёт на 30 с: serverNow = местное + 30 с.
        s.applyList(owner: ME, items: ["g": NOW + 20_000], serverNowMs: NOW + 30_000, requestedAtMs: NOW)
        XCTAssertEqual(s.state.serverOffsetMs, 30_000)
        XCTAssertFalse(s.isMuted("g"), "по часам сервера срок уже прошёл")
    }

    func testPersistsAndOwnerSwitchResets() {
        let s = store()
        s.applyList(owner: ME, items: ["g": NOW + HOUR], serverNowMs: NOW, requestedAtMs: NOW)
        let restarted = store()
        XCTAssertTrue(restarted.isMuted("g"), "переживает перезапуск (и видно расширению)")
        XCTAssertEqual(MuteSharedState.load(from: defaults).owner, ME)
        restarted.applyList(owner: "someone-else", items: [:], serverNowMs: NOW + 1, requestedAtMs: NOW)
        XCTAssertFalse(restarted.isMuted("g"), "другой аккаунт чужих настроек не наследует")
        restarted.resetForLogout()
        XCTAssertEqual(MuteSharedState.load(from: defaults), MuteSharedState())
    }

    func testOldServerListUsesRequestTime() {
        let s = store()
        s.applyEvent(ConversationMuteEvent(conversationId: "g", untilMs: NOW + HOUR, atMs: NOW + 1_000, byDeviceId: nil))
        // Старый сервер полей не шлёт — список ничего не меняет.
        s.applyList(owner: ME, items: [:], serverNowMs: nil, requestedAtMs: NOW + 5_000)
        XCTAssertTrue(s.isMuted("g"))
    }

    // MARK: Действие пользователя

    func testSetMuteSendsPresetAndAppliesResponse() {
        let rig = SecretTestRig()
        defer { rig.tearDown() }
        rig.server.extraRoute = { method, path, _ in
            guard method == "POST", path == "conversations/g1/mute" else { return nil }
            return (200, FakeServer.data([
                "conversationId": "g1", "mutedUntil": "2026-10-11T23:30:00.000Z",
                "mutedForever": false, "serverNow": "2026-10-11T15:30:00.000Z",
            ]))
        }
        let s = store(api: rig.api)
        let done = expectation(description: "mute")
        s.setMute("g1", preset: .eightHours) { ok in
            XCTAssertTrue(ok)
            done.fulfill()
        }
        wait(for: [done], timeout: 5)
        let call = rig.server.calls("POST", "conversations/g1/mute").first
        XCTAssertEqual((call?.json as? [String: Any])?["for"] as? String, "8h", "клиент шлёт пресет, срок считает сервер")
        XCTAssertTrue(s.isMuted("g1"))
        XCTAssertEqual(s.state.entries["g1"]?.setAtMs, NOW, "момент изменения — serverNow ответа")
        XCTAssertEqual(s.toast?.text, "Без звука на 8 часов")
        XCTAssertEqual(s.toast?.isError, false)
        XCTAssertTrue(s.inFlight.isEmpty)
    }

    func testUnmuteSendsExplicitNull() {
        let rig = SecretTestRig()
        defer { rig.tearDown() }
        rig.server.extraRoute = { method, path, _ in
            guard method == "POST", path == "conversations/g1/mute" else { return nil }
            return (200, FakeServer.data([
                "conversationId": "g1", "mutedUntil": NSNull(), "mutedForever": false,
                "serverNow": "2026-10-11T15:31:00.000Z",
            ]))
        }
        let s = store(api: rig.api)
        s.applyList(owner: ME, items: ["g1": MuteRules.foreverMs], serverNowMs: NOW, requestedAtMs: NOW)
        let done = expectation(description: "unmute")
        s.setMute("g1", preset: nil) { _ in done.fulfill() }
        wait(for: [done], timeout: 5)
        let body = rig.server.calls("POST", "conversations/g1/mute").first?.json as? [String: Any]
        XCTAssertTrue(body?["until"] is NSNull)
        XCTAssertFalse(s.isMuted("g1"))
        XCTAssertEqual(s.toast?.text, "Звук включён")
    }

    func testFailureShowsErrorAndKeepsState() {
        let rig = SecretTestRig()
        defer { rig.tearDown() }
        // Старый сервер без ручки — 404 без code.
        let s = store(api: rig.api)
        let done = expectation(description: "fail")
        s.setMute("g1", preset: .hour) { ok in
            XCTAssertFalse(ok)
            done.fulfill()
        }
        wait(for: [done], timeout: 5)
        XCTAssertFalse(s.isMuted("g1"))
        XCTAssertEqual(s.toast?.text, "Не удалось изменить звук беседы")
        XCTAssertEqual(s.toast?.isError, true)
    }
}

final class BadgeAndExtensionTests: XCTestCase {
    private func state(_ entries: [String: MuteEntry], owner: String? = ME) -> MuteSharedState {
        var s = MuteSharedState()
        s.owner = owner
        s.entries = entries
        return s
    }

    private func ledger(_ baseline: [String: Int], at: Int64 = NOW - 60_000) -> BadgeLedger {
        var l = BadgeLedger()
        l.applyList(owner: ME, unread: baseline, atMs: at)
        return l
    }

    private func push(_ conv: String, _ msg: String, sentAt: Int64? = NOW, secret: Bool = false) -> [AnyHashable: Any] {
        var info: [AnyHashable: Any] = ["kind": "message", "conversationId": conv, "messageId": msg, "senderId": "s", "senderName": "Костя"]
        if let sentAt { info["sentAt"] = NSNumber(value: sentAt) }
        if secret { info["secret"] = true }
        return info
    }

    func testLedgerTotalsExcludeMuted() {
        var l = ledger(["g": 3, "d": 2, "z": 0])
        XCTAssertEqual(l.baseline, ["g": 3, "d": 2], "нули не храним")
        XCTAssertTrue(l.addPush(conversationId: "d", messageId: "m1", sentAtMs: NOW))
        XCTAssertFalse(l.addPush(conversationId: "d", messageId: "m1", sentAtMs: NOW), "повтор того же пуша")
        XCTAssertFalse(l.addPush(conversationId: "d", messageId: "old", sentAtMs: NOW - 120_000), "старше списка — уже в базе")
        XCTAssertEqual(l.total { _ in false }, 6)
        XCTAssertEqual(l.total { $0 == "g" }, 3, "заглушённая беседа в общий счётчик не входит")
        // Прочитали «d» до момента m1 включительно.
        l.markRead(conversationId: "d", upToMs: NOW)
        XCTAssertEqual(l.total { _ in false }, 3)
        // Новый список: пуши, которые он уже учёл, уходят.
        XCTAssertTrue(l.addPush(conversationId: "g", messageId: "m2", sentAtMs: NOW + 1_000))
        l.applyList(owner: ME, unread: ["g": 4], atMs: NOW + 2_000)
        XCTAssertEqual(l.total { _ in false }, 4)
    }

    func testLedgerIsBounded() {
        var l = ledger([:])
        for i in 0..<(BadgeLedger.pendingLimit + 20) {
            l.addPush(conversationId: "c\(i % 7)", messageId: "m\(i)", sentAtMs: NOW + Int64(i))
        }
        XCTAssertEqual(l.pending.values.reduce(0) { $0 + $1.count }, BadgeLedger.pendingLimit)
        XCTAssertNil(l.pending.values.first { $0["m0"] != nil }, "выбрасываются самые старые")
    }

    func testExtensionCountsPushAndSetsBadge() {
        let result = PushMuteDecision.decide(
            userInfo: push("d", "m1"), serverBadge: nil,
            state: state([:]), ledger: ledger(["g": 3, "d": 1]), localNowMs: NOW
        )
        XCTAssertFalse(result.silence)
        XCTAssertEqual(result.badge, 5)
        XCTAssertNotNil(result.ledger)
    }

    func testExtensionMutedConversationNotCounted() {
        // Пуш пробился (ответ на моё в заглушённой группе): сервер решил верно — не глушим, но в
        // общий счётчик заглушённая беседа не входит.
        let entries = ["g": MuteEntry(untilMs: NOW + HOUR, asOfMs: NOW - 10_000, setAtMs: NOW - 10_000)]
        let result = PushMuteDecision.decide(
            userInfo: push("g", "m1"), serverBadge: nil,
            state: state(entries), ledger: ledger(["g": 3, "d": 1]), localNowMs: NOW
        )
        XCTAssertFalse(result.silence, "заглушили до сообщения — сервер уже учёл, пуш пробился по праву")
        XCTAssertEqual(result.badge, 1)
        XCTAssertNil(result.ledger)
    }

    func testExtensionSilencesRaceWithMute() {
        // Сообщение создано в NOW, заглушили через 2 с — сервер ставил пуш по старому состоянию.
        let entries = ["g": MuteEntry(untilMs: NOW + HOUR, asOfMs: NOW + 2_000, setAtMs: NOW + 2_000)]
        let result = PushMuteDecision.decide(
            userInfo: push("g", "m1", sentAt: NOW), serverBadge: nil,
            state: state(entries), ledger: ledger([:]), localNowMs: NOW + 3_000
        )
        XCTAssertTrue(result.silence)
        // Без момента изменения (знаем из списка) или без sentAt (старый сервер) — верим серверу.
        let fromList = ["g": MuteEntry(untilMs: NOW + HOUR, asOfMs: NOW + 2_000, setAtMs: nil)]
        XCTAssertFalse(PushMuteDecision.decide(
            userInfo: push("g", "m1"), serverBadge: nil, state: state(fromList), ledger: ledger([:]), localNowMs: NOW
        ).silence)
        XCTAssertFalse(PushMuteDecision.decide(
            userInfo: push("g", "m1", sentAt: nil), serverBadge: nil, state: state(entries), ledger: ledger([:]), localNowMs: NOW
        ).silence)
        // Истёкший срок — не заглушено.
        XCTAssertFalse(PushMuteDecision.decide(
            userInfo: push("g", "m1"), serverBadge: nil, state: state(entries), ledger: ledger([:]), localNowMs: NOW + 2 * HOUR
        ).silence)
    }

    func testExtensionSecretAndServerBadgeAndForeignPushes() {
        let secret = PushMuteDecision.decide(
            userInfo: push("s", "m1", secret: true), serverBadge: nil,
            state: state([:]), ledger: ledger(["g": 2]), localNowMs: NOW
        )
        XCTAssertEqual(secret.badge, 2, "секретки в общий счётчик не входят (как у сервера)")
        XCTAssertNil(secret.ledger)

        let server = PushMuteDecision.decide(
            userInfo: push("d", "m1"), serverBadge: 9,
            state: state([:]), ledger: ledger(["g": 2]), localNowMs: NOW
        )
        XCTAssertEqual(server.badge, 9, "число сервера (APNS_BADGE=on) точнее нашего")

        let loggedOut = PushMuteDecision.decide(
            userInfo: push("d", "m1"), serverBadge: nil,
            state: state([:], owner: nil), ledger: BadgeLedger(), localNowMs: NOW
        )
        XCTAssertNil(loggedOut.badge, "без своего аккаунта значок не трогаем")

        let call = PushMuteDecision.decide(
            userInfo: ["kind": "call", "conversationId": "d"], serverBadge: nil,
            state: state([:]), ledger: ledger(["g": 2]), localNowMs: NOW
        )
        XCTAssertEqual(call, PushMuteDecision.Result(), "звонок и прочее расширение не трогает")
    }

    func testAppBadgeFollowsListReadsAndMute() {
        let suite = "eb-badge-tests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let clock = Date(timeIntervalSince1970: Double(NOW) / 1000)
        let mutes = ConversationMuteStore(defaults: defaults, api: { nil }, currentUser: { ME }, now: { clock })
        var applied: [Int] = []
        let badge = AppBadge(defaults: defaults, mutes: mutes) { applied.append($0) }

        badge.listLoaded(owner: ME, unread: ["g": 3, "d": 2], atMs: NOW)
        XCTAssertEqual(applied.last, 5)
        badge.conversationRead("d", upToMs: NOW + 1_000)
        XCTAssertEqual(applied.last, 3)

        // Заглушили «g» (событие с другого устройства) — значок пересчитывается сам.
        let recomputed = expectation(description: "recompute")
        let watcher = mutes.changes.receive(on: DispatchQueue.main).sink { recomputed.fulfill() }
        mutes.applyEvent(ConversationMuteEvent(conversationId: "g", untilMs: NOW + HOUR, atMs: NOW + 10, byDeviceId: "pc"))
        wait(for: [recomputed], timeout: 2)
        watcher.cancel()
        // Наш подписчик в AppBadge тоже на main — даём ему отработать.
        let settled = expectation(description: "settled")
        DispatchQueue.main.async { settled.fulfill() }
        wait(for: [settled], timeout: 2)
        XCTAssertEqual(applied.last, 0)

        badge.reset()
        XCTAssertEqual(applied.last, 0)
        XCTAssertEqual(BadgeLedger.load(from: defaults), BadgeLedger())
        badge.conversationRead("g", upToMs: nil)
        XCTAssertEqual(applied.last, 0, "после выхода журнал пуст — прочтения ничего не трогают")
    }
}

@MainActor
final class IncomingSoundGateTests: XCTestCase {
    private func settle(_ ms: Int) async {
        try? await Task.sleep(for: .milliseconds(ms))
    }

    func testServerSaysMutedCancelsDeferredLocalSound() async {
        let gate = IncomingSoundGate(deferral: .milliseconds(80))
        var played = 0
        gate.onNew(messageId: "m", localAlert: true) { played += 1 }
        gate.onNotify(messageId: "m", serverMuted: true, localAlert: true) { played += 1 }
        await settle(200)
        XCTAssertEqual(played, 0, "сервер знает свежее «Без звука» — отложенный звук отменён")
    }

    func testServerSaysAlertPlaysOnceEvenIfLocalSaidNo() async {
        let gate = IncomingSoundGate(deferral: .milliseconds(80))
        var played = 0
        // Своё состояние устарело (или ответ на моё в заглушённой группе) — решает сервер.
        gate.onNew(messageId: "m", localAlert: false) { played += 1 }
        gate.onNotify(messageId: "m", serverMuted: false, localAlert: false) { played += 1 }
        await settle(200)
        XCTAssertEqual(played, 1)
    }

    func testNewOnlyEventsPlayAfterDeferral() async {
        // «Пропущенный звонок» приходит только message:new.
        let gate = IncomingSoundGate(deferral: .milliseconds(50))
        var played = 0
        gate.onNew(messageId: "m", localAlert: true) { played += 1 }
        XCTAssertEqual(played, 0)
        await settle(200)
        XCTAssertEqual(played, 1)
        gate.onNew(messageId: "m2", localAlert: false) { played += 1 }
        await settle(150)
        XCTAssertEqual(played, 1, "своё правило сказало «тихо»")
    }

    func testOldServerFallsBackToLocalRule() async {
        let gate = IncomingSoundGate(deferral: .milliseconds(80))
        var played = 0
        gate.onNotify(messageId: "a", serverMuted: nil, localAlert: false) { played += 1 }
        XCTAssertEqual(played, 0)
        gate.onNotify(messageId: "b", serverMuted: nil, localAlert: true) { played += 1 }
        XCTAssertEqual(played, 1)
    }

    func testLateNewAfterServerDecisionIsIgnored() async {
        let gate = IncomingSoundGate(deferral: .milliseconds(50))
        var played = 0
        gate.onNotify(messageId: "m", serverMuted: true, localAlert: true) { played += 1 }
        gate.onNew(messageId: "m", localAlert: true) { played += 1 }
        await settle(150)
        XCTAssertEqual(played, 0)
    }
}
