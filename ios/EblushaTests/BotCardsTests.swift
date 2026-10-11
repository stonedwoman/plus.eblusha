import XCTest
import Combine
@testable import Eblusha

// Карточки бота (scratchpad/promise-timer/SPEC-share.md §2, SPEC.md): конверт, права действий,
// правило rev, часы со смещением сервера, вид таймера обещания и «поделиться перепиской» для
// разных зрителей, разбор message:update, вью-модель (замена на месте, оптимизм, откат, 409).
// Векторы — случаи §2.9 SPEC-share и таблицы SPEC.md §10; общие docs/*-vectors.json сервер ещё не
// выложил — когда появятся, их стоит прогнать этим же кодом.

// MARK: - Помощники

/// JSON-значение из словаря (как его прислал бы сервер).
func jv(_ any: Any) -> JSONValue {
    let data = try! JSONSerialization.data(withJSONObject: any, options: [.fragmentsAllowed])
    return try! JSONDecoder().decode(JSONValue.self, from: data)
}

enum CardFixtures {
    /// 11.10.2026 14:00:00 МСК.
    static let t0 = Date(timeIntervalSince1970: 1_791_716_400)
    static let moscow = TimeZone(identifier: "Europe/Moscow")!
    static let roma: [String: Any] = ["id": "roma", "displayName": "Рома"]
    static let vasya: [String: Any] = ["id": "vasya", "displayName": "Козёл Ебаный", "avatarUrl": "/api/files/v.png"]
    static let petya: [String: Any] = ["id": "petya", "displayName": "Петя"]

    static func iso(_ offset: TimeInterval) -> String {
        millisToIso(Int64((t0.timeIntervalSince1970 + offset) * 1000))
    }

    static func promiseData(start: TimeInterval = -60, deadline: TimeInterval = 15 * 60,
                            extra: [String: Any] = [:]) -> [String: Any] {
        var data: [String: Any] = [
            "promiser": vasya, "requester": roma,
            "quote": ["messageId": "m1", "text": "15мин", "at": iso(start), "by": NSNull(), "deleted": false],
            "label": "15 мин", "upperBound": false,
            "startAt": iso(start), "deadlineAt": iso(deadline), "originalDeadlineAt": iso(deadline),
            "extensions": [], "promiserZone": NSNull(), "closedAt": NSNull(), "outcome": NSNull(),
            "cancelledBy": NSNull(), "reminders": [],
        ]
        for (key, value) in extra { data[key] = value }
        return data
    }

    static let runningActions: [[String: Any]] = [
        ["id": "arrived", "who": ["any": true]],
        ["id": "cancel", "who": ["ids": ["roma", "owner"]]],
    ]

    static func envelope(type: String = "promise", rev: Int = 1, state: String = "running", closed: Bool = false,
                         actions: [[String: Any]] = runningActions, data: [String: Any]? = nil, v: Int = 1) -> [String: Any] {
        ["v": v, "type": type, "id": "rec-1", "rev": rev, "state": state, "closed": closed,
         "actions": actions, "data": data ?? promiseData()]
    }

    static func card(_ envelope: [String: Any]) -> BotCard {
        BotCard.parse(jv(envelope))!
    }

    static func shareData(extra: [String: Any] = [:]) -> [String: Any] {
        var data: [String: Any] = [
            "asker": roma,
            "suggest": ["period": "today", "photos": false],
            "options": [
                ["period": "today", "messages": 34, "photos": 3, "enabled": true],
                ["period": "week", "messages": 128, "photos": 18, "enabled": true],
                ["period": "all", "messages": 1738, "photos": 337, "photosUsed": 60, "enabled": true, "capped": false],
            ],
            "note": NSNull(), "choice": NSNull(), "until": NSNull(), "answerMessageId": NSNull(),
            "read": NSNull(), "endedBy": NSNull(),
        ]
        for (key, value) in extra { data[key] = value }
        return data
    }

    static func pendingShareActions(asker: String = "roma") -> [[String: Any]] {
        [["id": "share", "who": ["ids": [asker]], "until": iso(28 * 60)],
         ["id": "decline", "who": ["ids": [asker]], "until": iso(28 * 60)]]
    }

    /// Строка сообщения так, как её отдаёт сервер (история, ответ маршрута, message:update).
    static func botRow(_ id: String, conv: String = "c1", envelope: [String: Any]?, kind: String = "card",
                       content: String = "⏱ Таймер: запасной текст", replyTo: String? = nil,
                       depth: String? = nil) -> [String: Any] {
        var bot: [String: Any] = ["v": 1, "kind": kind, "triggerMessageId": replyTo ?? "q1", "askerId": "user-me"]
        if let depth { bot["depth"] = depth }
        var metadata: [String: Any] = ["bot": bot]
        if let envelope { metadata["card"] = envelope }
        var row: [String: Any] = [
            "id": id, "conversationId": conv, "senderId": "bot", "type": "TEXT", "content": content,
            "createdAt": "2026-10-11T10:59:00.000Z", "isBot": true, "metadata": metadata,
            "sender": ["id": "bot", "username": "eblusha_bot", "displayName": "Еблуша", "isBot": true],
        ]
        if let replyTo {
            row["replyToId"] = replyTo
            row["replyTo"] = ["id": replyTo, "senderId": "user-me", "content": "?", "isBot": false]
        }
        return row
    }

    static func dto(_ row: [String: Any]) -> MessageDto {
        let data = try! JSONSerialization.data(withJSONObject: row)
        return try! JSONDecoder().decode(MessageDto.self, from: data)
    }
}

// MARK: - Конверт (§2.1, §2.9)

final class BotCardEnvelopeTests: XCTestCase {
    typealias F = CardFixtures

    func testParsesEnvelopeAndPromiseData() throws {
        let card = F.card(F.envelope(rev: 3))
        XCTAssertEqual(card.v, 1)
        XCTAssertEqual(card.type, "promise")
        XCTAssertEqual(card.knownType, .promise)
        XCTAssertEqual(card.id, "rec-1")
        XCTAssertEqual(card.rev, 3)
        XCTAssertEqual(card.state, "running")
        XCTAssertFalse(card.closed)
        XCTAssertTrue(card.isRenderable)
        XCTAssertEqual(card.actions.map(\.id), ["arrived", "cancel"])
        guard case .promise(let data) = card.payload else { return XCTFail("нет данных таймера") }
        XCTAssertEqual(data.promiser.id, "vasya")
        XCTAssertEqual(data.promiser.displayName, "Козёл Ебаный")
        XCTAssertEqual(data.promiser.avatarUrl, "/api/files/v.png")
        XCTAssertEqual(data.requester?.displayName, "Рома")
        XCTAssertEqual(data.quote?.text, "15мин")
        XCTAssertEqual(data.deadlineAt, F.t0.addingTimeInterval(900))
        XCTAssertEqual(data.label, "15 мин")
    }

    func testUnknownTypeAndVersionFallBackToText() {
        // Неизвестный тип и v: 2 — конверт разобран (rev нужен порядку), но рисуется запасной текст.
        let poll = F.card(F.envelope(type: "poll", data: ["question": "?"]))
        XCTAssertFalse(poll.isRenderable)
        XCTAssertEqual(poll.rev, 1)
        let v2 = F.card(F.envelope(v: 2))
        XCTAssertFalse(v2.isRenderable)
        // Данные не той формы (нет срока) — тоже текст.
        var broken = F.promiseData()
        broken["deadlineAt"] = NSNull()
        XCTAssertFalse(F.card(F.envelope(data: broken)).isRenderable)
        // Не конверт вовсе.
        XCTAssertNil(BotCard.parse(jv(["foo": 1])))
        XCTAssertNil(BotCard.parse(nil))
    }

    func testActionVisibility() {
        let now = F.t0
        let card = F.card(F.envelope(actions: [
            ["id": "arrived", "who": ["any": true]],
            ["id": "cancel", "who": ["ids": ["roma", "owner"]]],
            ["id": "late", "who": ["any": true], "until": F.iso(-1)],
            ["id": "soon", "who": ["ids": ["roma"]], "until": F.iso(60)],
        ]))
        XCTAssertEqual(card.availableActions(viewer: "roma", now: now), ["arrived", "cancel", "soon"])
        XCTAssertEqual(card.availableActions(viewer: "petya", now: now), ["arrived"], "who.ids без зрителя — скрыто")
        XCTAssertEqual(card.availableActions(viewer: nil, now: now), ["arrived"])
        XCTAssertEqual(card.availableActions(viewer: "roma", now: now.addingTimeInterval(61)), ["arrived", "cancel"],
                       "until прошёл — действие прячется само, без события")
    }

    func testClosedCardKeepsOnlyActionsWithDeadline() {
        let card = F.card(F.envelope(state: "cancelled", closed: true, actions: [
            ["id": "arrived", "who": ["any": true]],
            ["id": "reopen", "who": ["ids": ["roma"]], "until": F.iso(120)],
        ]))
        XCTAssertEqual(card.availableActions(viewer: "roma", now: F.t0), ["reopen"])
        XCTAssertEqual(card.availableActions(viewer: "roma", now: F.t0.addingTimeInterval(121)), [])
    }

    func testRevisionOrderingAcceptsOnlyNewer() {
        // События с rev 3, 2, 4 → итог 4 (SPEC-share §2.9).
        let base = message(rev: 1)
        var shown = base
        for rev in [3, 2, 4] {
            let incoming = message(rev: rev)
            if BotCardRevision.shouldReplace(current: shown, incoming: incoming) { shown = incoming }
        }
        XCTAssertEqual(shown.card?.rev, 4)
        XCTAssertFalse(BotCardRevision.shouldReplace(current: message(rev: 4), incoming: message(rev: 4)), "равный — игнор")
        var deleted = message(rev: 1)
        deleted.deleted = true
        XCTAssertTrue(BotCardRevision.shouldReplace(current: message(rev: 9), incoming: deleted), "удаление — всегда")
    }

    func testPageMergeKeepsNewerCardFromSocket() {
        let page = [message(rev: 2), plain("h1")]
        let merged = BotCardRevision.merge(page: page, existing: [message(rev: 5), plain("h1")])
        XCTAssertEqual(merged.first?.card?.rev, 5, "сокет обогнал REST — на экране остаётся rev 5")
        let newer = BotCardRevision.merge(page: [message(rev: 6)], existing: [message(rev: 5)])
        XCTAssertEqual(newer.first?.card?.rev, 6)
    }

    func testMappingTrustsOnlyBotMessages() {
        let rig = SecretTestRig()
        defer { rig.tearDown() }
        let repo = ChatRepository(api: rig.api, session: rig.session)
        let bot = repo.mapMessage(F.dto(F.botRow("k1", envelope: F.envelope(rev: 2))))
        XCTAssertEqual(bot.botKind, "card")
        XCTAssertEqual(bot.card?.rev, 2)
        XCTAssertNotNil(bot.renderableCard)
        // Подделка: человек с metadata.card — обычный текст.
        var human = F.botRow("h1", envelope: F.envelope())
        human["isBot"] = false
        human["sender"] = ["id": "peer", "username": "peer"]
        human["senderId"] = "peer"
        let fake = repo.mapMessage(F.dto(human))
        XCTAssertNil(fake.card)
        XCTAssertNil(fake.renderableCard)
        // Ответ бота другого вида с ключом card — не карточка.
        let answer = repo.mapMessage(F.dto(F.botRow("a1", envelope: F.envelope(), kind: "answer")))
        XCTAssertNil(answer.renderableCard)
        // Удалённая карточка — ничего не рисуем.
        var gone = F.botRow("k2", envelope: F.envelope())
        gone["deletedAt"] = "2026-10-11T11:00:00.000Z"
        XCTAssertNil(repo.mapMessage(F.dto(gone)).renderableCard)
        // «Подумал лучше».
        let deep = repo.mapMessage(F.dto(F.botRow("d1", envelope: nil, kind: "answer", depth: "deep")))
        XCTAssertEqual(deep.botDepth, "deep")
        XCTAssertTrue(deep.botIsDeep)
    }

    private func message(rev: Int) -> Message {
        var m = Message(id: "k1", conversationId: "c1", senderId: "bot", senderName: "Еблуша", type: "TEXT",
                        content: "x", createdAt: 0, isMine: false, isSystem: false)
        m.isBot = true
        m.botKind = "card"
        m.card = CardFixtures.card(CardFixtures.envelope(rev: rev))
        return m
    }

    private func plain(_ id: String) -> Message {
        Message(id: id, conversationId: "c1", senderId: "peer", senderName: "Петя", type: "TEXT",
                content: "x", createdAt: 0, isMine: false, isSystem: false)
    }
}

// MARK: - message:update (сокет)

final class MessageUpdatePayloadTests: XCTestCase {

    func testDecodesWithoutSenderId() throws {
        // Так сервер шлёт правку/удаление: senderId нет. Прежний разбор выбрасывал такое событие.
        let raw = Data(#"{"conversationId":"c1","messageId":"m1","reason":"deleted"}"#.utf8)
        let payload = try JSONDecoder().decode(MessageUpdatePayload.self, from: raw)
        XCTAssertEqual(payload.conversationId, "c1")
        XCTAssertEqual(payload.messageId, "m1")
        XCTAssertEqual(payload.info.reason, "deleted")
        XCTAssertNil(payload.info.message)
    }

    func testCarriesCardMessageAndServerClock() throws {
        let row = CardFixtures.botRow("k1", envelope: CardFixtures.envelope(rev: 4))
        let object: [String: Any] = [
            "conversationId": "c1", "messageId": "k1", "reason": "card", "cardType": "promise",
            "message": row, "card": CardFixtures.envelope(rev: 4), "serverNow": "2026-10-11T11:00:05.000Z",
        ]
        let payload = try JSONDecoder().decode(
            MessageUpdatePayload.self, from: JSONSerialization.data(withJSONObject: object)
        )
        XCTAssertEqual(payload.info.reason, "card")
        XCTAssertEqual(payload.info.cardType, "promise")
        XCTAssertEqual(payload.info.message?.id, "k1")
        XCTAssertEqual(BotCard.parse(payload.info.card)?.rev, 4)
        XCTAssertEqual(payload.info.serverNow, CardFixtures.t0.addingTimeInterval(5))
        // Часы сервера числом (мс) — тоже понимаем.
        let ms = try JSONDecoder().decode(MessageUpdatePayload.self, from: Data(
            #"{"conversationId":"c1","messageId":"k1","serverNow":1791716405000}"#.utf8))
        XCTAssertEqual(ms.info.serverNow, CardFixtures.t0.addingTimeInterval(5))
    }

    func testBrokenMessageDoesNotDropEvent() throws {
        let raw = Data(#"{"conversationId":"c1","messageId":"m1","reason":"card","message":{"oops":1}}"#.utf8)
        let payload = try JSONDecoder().decode(MessageUpdatePayload.self, from: raw)
        XCTAssertEqual(payload.messageId, "m1")
        XCTAssertNil(payload.info.message)
    }
}

// MARK: - Часы (SPEC.md §10.3, SPEC-share §2.7 п. 4)

@MainActor
final class CardClockTests: XCTestCase {

    func testSkewIsMedianOfThreeAndIgnoredUnderTwoSeconds() {
        var local = CardFixtures.t0
        let clock = CardClock(localNow: { local }, foreground: Just(true).eraseToAnyPublisher())
        clock.noteServerNow(local.addingTimeInterval(1.5))
        XCTAssertEqual(clock.skew, 0, "1,5 с — не применяем")
        clock.noteServerNow(local.addingTimeInterval(10))
        clock.noteServerNow(local.addingTimeInterval(11))
        XCTAssertEqual(clock.skew, 10, accuracy: 0.001, "медиана 1,5 / 10 / 11")
        clock.noteServerNow(local.addingTimeInterval(-100))
        XCTAssertEqual(clock.skew, 10, accuracy: 0.001, "один выброс медиану не сдвигает (10 / 11 / −100)")
        XCTAssertEqual(clock.now(), local.addingTimeInterval(10))
        local = local.addingTimeInterval(5)
        XCTAssertEqual(clock.now(), CardFixtures.t0.addingTimeInterval(15))
        clock.reset()
        XCTAssertEqual(clock.skew, 0)
    }

    func testTickerRunsOnlyWhileVisibleAndInForeground() async {
        let foreground = CurrentValueSubject<Bool, Never>(true)
        let clock = CardClock(foreground: foreground.eraseToAnyPublisher())
        try? await Task.sleep(for: .milliseconds(30))
        let ticker = clock.seconds
        XCTAssertFalse(ticker.isRunning, "нет карточек на экране — часы стоят")
        ticker.subscribe("a")
        ticker.subscribe("b")
        XCTAssertTrue(ticker.isRunning)
        ticker.unsubscribe("a")
        XCTAssertTrue(ticker.isRunning, "ещё одна карточка видна")
        foreground.send(false)
        try? await Task.sleep(for: .milliseconds(50))
        XCTAssertFalse(ticker.isRunning, "приложение в фоне — часы стоят")
        foreground.send(true)
        try? await Task.sleep(for: .milliseconds(50))
        XCTAssertTrue(ticker.isRunning, "вернулись — тикаем снова")
        ticker.unsubscribe("b")
        XCTAssertFalse(ticker.isRunning)
    }

    func testTickIsAlignedToBoundary() async {
        // Проверяем, КОГДА назначен тик, а не когда его доставили: под нагрузкой мака доставка
        // опаздывает, а назначение — детерминированно.
        let clock = CardClock(foreground: Just(true).eraseToAnyPublisher())
        clock.seconds.subscribe("x")
        clock.minutes.subscribe("y")
        guard let second = clock.seconds.nextFireDate, let minute = clock.minutes.nextFireDate else {
            return XCTFail("тикеры не назначены")
        }
        let secFrac = second.timeIntervalSince1970.truncatingRemainder(dividingBy: 1)
        let minFrac = minute.timeIntervalSince1970.truncatingRemainder(dividingBy: 60)
        XCTAssertEqual(secFrac, 0.005, accuracy: 0.03, "секундный тик — сразу после границы секунды")
        XCTAssertEqual(minFrac, 0.005, accuracy: 0.03, "минутный — сразу после границы минуты")
        XCTAssertLessThanOrEqual(second.timeIntervalSinceNow, 1.01)
        // Тик действительно приходит и двигает «сейчас».
        let before = clock.seconds.now
        let deadline = Date().addingTimeInterval(5)
        while clock.seconds.now == before, Date() < deadline {
            try? await Task.sleep(for: .milliseconds(50))
        }
        XCTAssertGreaterThan(clock.seconds.now, before)
        clock.seconds.unsubscribe("x")
        clock.minutes.unsubscribe("y")
        XCTAssertNil(clock.seconds.nextFireDate)
    }
}

// MARK: - Таймер обещания (SPEC.md §4.3, §10)

final class PromiseRulesTests: XCTestCase {
    typealias F = CardFixtures

    private func display(_ envelope: [String: Any], viewer: String? = "roma", at offset: TimeInterval = 0,
                         zone: TimeZone = CardFixtures.moscow, names: [String: String] = [:]) -> PromiseDisplay {
        let card = F.card(envelope)
        guard case .promise(let data) = card.payload else { fatalError("не таймер") }
        return PromiseRules.display(card: card, data: data, viewerId: viewer, now: F.t0.addingTimeInterval(offset),
                                    zone: zone, names: names)
    }

    func testViewByTime() {
        let running = F.envelope(data: F.promiseData(deadline: 61))
        XCTAssertEqual(display(running).view, .running)
        XCTAssertEqual(display(running, at: 1).view, .lastMinute, "ровно 60 с — уже последняя минута")
        XCTAssertEqual(display(running, at: 60.5).view, .lastMinute)
        XCTAssertEqual(display(running, at: 61).view, .late, "в срок — уже опаздывает")
    }

    func testCountdownFormats() {
        XCTAssertEqual(PromiseRules.countdown(767, withHours: false), "12:47")
        XCTAssertEqual(PromiseRules.countdown(4365, withHours: false), "1:12:45")
        XCTAssertEqual(PromiseRules.countdown(600, withHours: true), "0:10:00", "полный срок ≥ часа — сразу ч:мм:сс")
        XCTAssertEqual(PromiseRules.countdown(0, withHours: false), "00:00")
        XCTAssertEqual(PromiseRules.countdown(-5, withHours: false), "00:00")
    }

    func testRunningDisplay() {
        // «15мин» в 13:59, срок 14:15, сейчас 14:02:13 → осталось 12:47.
        let d = display(F.envelope(data: F.promiseData(start: -60, deadline: 15 * 60)), at: 133)
        XCTAssertEqual(d.digits, "12:47")
        XCTAssertEqual(d.caption, "осталось")
        XCTAssertEqual(d.until, "до 14:15")
        XCTAssertEqual(d.label, "15 мин")
        XCTAssertEqual(d.requesterLine, "попросил Рома")
        XCTAssertEqual(d.name, "Козёл Ебаный")
        XCTAssertEqual(d.quote, "«15мин»")
        XCTAssertEqual(d.promisedAt, "обещал в 13:59")
        XCTAssertNil(d.localTime)
        XCTAssertNil(d.extensionsChip)
        XCTAssertEqual(d.progress, 767.0 / 960.0, accuracy: 0.001)
        XCTAssertFalse(d.withHours)
        XCTAssertEqual(d.accessibilityLabel, "Таймер: Козёл Ебаный обещал «15мин», до 14:15, осталось 12 минут")
    }

    func testCeilingCountdownAndExactDeadline() {
        let env = F.envelope(data: F.promiseData(start: -60, deadline: 10))
        XCTAssertEqual(display(env, at: 9.6).digits, "00:01", "остаток округляется вверх")
        XCTAssertEqual(display(env, at: 9.6).caption, "последняя минута!")
        XCTAssertEqual(display(env, at: 10).digits, "+00:00", "ровно в срок — «+00:00», не «00:00» дважды")
        XCTAssertEqual(display(env, at: 10).caption, "опаздывает")
    }

    func testHourLongCountdownUsesHoursFromStart() {
        let env = F.envelope(data: F.promiseData(start: -17 * 60, deadline: 72 * 60 + 47,
                                                  extra: ["label": "час-полтора → 1,5 ч", "upperBound": true]))
        let d = display(env)
        XCTAssertTrue(d.withHours)
        XCTAssertEqual(d.digits, "1:12:47")
        XCTAssertEqual(d.label, "час-полтора → 1,5 ч")
        XCTAssertEqual(display(env, at: 30 * 60).digits, "0:42:47", "и меньше часа — всё равно ч:мм:сс")
    }

    func testLateDisplay() {
        let env = F.envelope(data: F.promiseData(start: -28 * 60, deadline: -192, extra: [
            "extensions": [["at": F.iso(-14 * 60), "from": F.iso(-13 * 60), "to": F.iso(-192), "label": "ещё 10 мин"]],
        ]))
        let d = display(env)
        XCTAssertEqual(d.view, .late)
        XCTAssertEqual(d.digits, "+03:12")
        XCTAssertEqual(d.caption, "опаздывает")
        XCTAssertEqual(d.until, "обещал к 13:56")
        XCTAssertEqual(d.extensionsChip, "продлевал 1 раз")
        XCTAssertEqual(d.progress, 1)
        XCTAssertEqual(d.buttons, ["arrived", "cancel"], "опаздывающего ещё можно отметить")
        XCTAssertEqual(display(env, at: 3600).digits, "+1:03:12")
    }

    func testButtonsByViewer() {
        let env = F.envelope()
        XCTAssertEqual(display(env, viewer: "roma").buttons, ["arrived", "cancel"], "спросивший")
        XCTAssertEqual(display(env, viewer: "owner").buttons, ["arrived", "cancel"], "владелец бота")
        XCTAssertEqual(display(env, viewer: "petya").buttons, ["arrived"], "любой участник — только «Пришёл»")
        XCTAssertEqual(display(env, viewer: "vasya").buttons, ["arrived"], "сам обещавший тоже может отметить")
    }

    func testOnTimeOutcome() {
        let env = F.envelope(state: "arrived", closed: true, actions: [], data: F.promiseData(
            start: -40 * 60, deadline: -25 * 60, extra: [
                "closedAt": F.iso(-28 * 60),
                "outcome": ["kind": "onTime", "arrivedAt": F.iso(-28 * 60), "deltaSec": -180,
                            "deltaVsOriginalSec": -180, "via": "call", "by": NSNull()],
            ]))
        let d = display(env)
        XCTAssertEqual(d.view, .onTime)
        XCTAssertEqual(d.digits, "✓ 13:32")
        XCTAssertEqual(d.result, "Пришёл вовремя, запас 3 мин")
        XCTAssertEqual(d.resultDetail, "зашёл в звонок")
        XCTAssertEqual(d.until, "срок 13:35")
        XCTAssertEqual(d.buttons, [])
    }

    func testLateOutcomeWithExtension() {
        let env = F.envelope(state: "arrived", closed: true, actions: [], data: F.promiseData(
            start: -60 * 60, deadline: -35 * 60, extra: [
                "extensions": [["at": F.iso(-46 * 60), "from": F.iso(-45 * 60), "to": F.iso(-35 * 60), "label": "ещё 10 мин"]],
                "outcome": ["kind": "late", "arrivedAt": F.iso(-28 * 60), "deltaSec": 420,
                            "deltaVsOriginalSec": 1020, "via": "valheim", "by": NSNull()],
            ]))
        let d = display(env)
        XCTAssertEqual(d.view, .lateArrived)
        XCTAssertEqual(d.digits, "+7 мин")
        XCTAssertEqual(d.result, "Опоздал на 7 мин")
        XCTAssertEqual(d.resultDetail, "зашёл в Valheim · продлевал 1 раз · от первого срока +17 мин")
    }

    func testCancelledWithReopenWindow() {
        let env = F.envelope(state: "cancelled", closed: true,
                             actions: [["id": "reopen", "who": ["ids": ["roma", "owner"]], "until": F.iso(110)]],
                             data: F.promiseData(extra: ["cancelledBy": F.roma, "closedAt": F.iso(-10)]))
        let d = display(env)
        XCTAssertEqual(d.view, .cancelled)
        XCTAssertEqual(d.digits, "—")
        XCTAssertEqual(d.caption, "Таймер отменён · отменил Рома")
        XCTAssertEqual(d.until, "срок был 14:15")
        XCTAssertEqual(d.buttons, ["reopen"])
        XCTAssertEqual(display(env, at: 111).buttons, [], "2 минуты прошли — «Вернуть» прячется")
        XCTAssertEqual(display(env, viewer: "petya").buttons, [])
    }

    func testUnresolvedAndDeletedQuote() {
        let env = F.envelope(state: "unresolved", closed: true, actions: [], data: F.promiseData(extra: [
            "quote": ["messageId": "m1", "text": NSNull(), "at": F.iso(-60), "deleted": true],
        ]))
        let d = display(env)
        XCTAssertEqual(d.digits, "?")
        XCTAssertEqual(d.caption, "Никто не отметил приход")
        XCTAssertEqual(d.quote, "(сообщение удалено)")
    }

    func testLocalTimeOnlyWhenZonesDiffer() {
        let env = F.envelope(data: F.promiseData(deadline: 3 * 3600, extra: ["promiserZone": "Asia/Krasnoyarsk"]))
        XCTAssertEqual(display(env).localTime, "по местному 21:00", "москвич видит срок и местное время Васи")
        let krsk = TimeZone(identifier: "Asia/Krasnoyarsk")!
        XCTAssertEqual(display(env, zone: krsk).localTime, nil, "у самого Васи — без «по местному»")
        XCTAssertEqual(display(env, zone: krsk).until, "до 21:00", "время — зрителя")
    }

    func testTomorrowDeadline() {
        let env = F.envelope(data: F.promiseData(deadline: 12 * 3600))
        XCTAssertEqual(display(env).until, "до завтра, 02:00")
    }

    func testFreshNamesWinOverSnapshot() {
        let d = display(F.envelope(), names: ["vasya": "Вася", "roma": "Роман"])
        XCTAssertEqual(d.name, "Вася")
        XCTAssertEqual(d.requesterLine, "попросил Роман")
    }

    func testTextsAndPlurals() {
        XCTAssertEqual(PromiseRules.duration(42), "42 с")
        XCTAssertEqual(PromiseRules.duration(420), "7 мин")
        XCTAssertEqual(PromiseRules.duration(3600), "1 ч")
        XCTAssertEqual(PromiseRules.duration(4320), "1 ч 12 мин")
        func outcome(_ delta: Int, _ via: String? = nil, by: CardPerson? = nil) -> PromiseCardData.Outcome {
            PromiseCardData.Outcome(kind: delta > 0 ? "late" : "onTime", deltaSec: delta, via: via, by: by)
        }
        XCTAssertEqual(PromiseRules.resultText(outcome(0)), "Секунда в секунду")
        XCTAssertEqual(PromiseRules.resultText(outcome(-30)), "Пришёл вовремя, запас меньше минуты")
        XCTAssertEqual(PromiseRules.resultText(outcome(-180)), "Пришёл вовремя, запас 3 мин")
        XCTAssertEqual(PromiseRules.resultText(outcome(42)), "Опоздал на 42 с")
        XCTAssertEqual(PromiseRules.resultText(outcome(4320)), "Опоздал на 1 ч 12 мин")
        XCTAssertEqual(PromiseRules.viaText(outcome(0, "self")), "отметил сам")
        XCTAssertEqual(PromiseRules.viaText(outcome(0, "button", by: CardPerson(id: "roma", displayName: "Рома"))), "отметил Рома")
        XCTAssertEqual(PromiseRules.viaText(outcome(0, "phrase")), "отметили")
        XCTAssertEqual(PromiseRules.extensionsText(1), "продлевал 1 раз")
        XCTAssertEqual(PromiseRules.extensionsText(2), "продлевал 2 раза")
        XCTAssertEqual(PromiseRules.extensionsText(5), "продлевал 5 раз")
        XCTAssertEqual(PromiseRules.extensionsText(11), "продлевал 11 раз")
        XCTAssertEqual(PromiseRules.extensionsText(22), "продлевал 22 раза")
        XCTAssertNil(PromiseRules.extensionsText(0))
    }

    func testOptimisticTransitions() {
        let card = F.card(F.envelope())
        guard case .promise(let data) = card.payload else { return XCTFail() }
        let roma = CardPerson(id: "roma", displayName: "Рома")
        let arrived = PromiseRules.optimistic(card: card, data: data, action: "arrived", viewer: roma,
                                              now: F.t0.addingTimeInterval(12 * 60))!
        XCTAssertEqual(arrived.rev, card.rev, "rev прежний — ответ сервера заменит")
        XCTAssertEqual(arrived.state, "arrived")
        XCTAssertTrue(arrived.closed)
        guard case .promise(let next) = arrived.payload else { return XCTFail() }
        XCTAssertEqual(next.outcome?.via, "button")
        XCTAssertEqual(next.outcome?.by?.displayName, "Рома")
        XCTAssertEqual(next.outcome?.deltaSec, -180)
        XCTAssertEqual(arrived.availableActions(viewer: "roma", now: F.t0.addingTimeInterval(12 * 60 + 5)), ["reopen"])

        let vasya = CardPerson(id: "vasya", displayName: "Козёл Ебаный")
        let selfArrived = PromiseRules.optimistic(card: card, data: data, action: "arrived", viewer: vasya, now: F.t0)!
        guard case .promise(let own) = selfArrived.payload else { return XCTFail() }
        XCTAssertEqual(own.outcome?.via, "self")
        XCTAssertNil(own.outcome?.by)

        let cancelled = PromiseRules.optimistic(card: card, data: data, action: "cancel", viewer: roma, now: F.t0)!
        XCTAssertEqual(cancelled.state, "cancelled")
        guard case .promise(let c) = cancelled.payload else { return XCTFail() }
        XCTAssertEqual(c.cancelledBy?.displayName, "Рома")
        XCTAssertNil(PromiseRules.optimistic(card: card, data: data, action: "share", viewer: roma, now: F.t0))
    }

    func testAnnouncements() {
        let data = PromiseCardData.parse(jv(F.promiseData()))!
        XCTAssertEqual(PromiseRules.announcement(from: .running, to: .lastMinute, data: data, name: "Вася"), "Осталась минута")
        XCTAssertEqual(PromiseRules.announcement(from: .lastMinute, to: .late, data: data, name: "Вася"), "Вася опаздывает")
        XCTAssertNil(PromiseRules.announcement(from: nil, to: .late, data: data, name: "Вася"), "первый показ — молча")
        XCTAssertNil(PromiseRules.announcement(from: .late, to: .late, data: data, name: "Вася"))
    }
}

// MARK: - «Поделиться перепиской» (SPEC-share §6)

final class ShareRulesTests: XCTestCase {
    typealias F = CardFixtures

    private func share(state: String = "pending", closed: Bool = false, actions: [[String: Any]]? = nil,
                       extra: [String: Any] = [:]) -> (BotCard, ShareCardData) {
        let card = F.card(F.envelope(type: "share", state: state, closed: closed,
                                     actions: actions ?? F.pendingShareActions(), data: F.shareData(extra: extra)))
        guard case .share(let data) = card.payload else { fatalError("не share") }
        return (card, data)
    }

    private func display(_ pair: (BotCard, ShareCardData), viewer: String? = "roma", at offset: TimeInterval = 0,
                         selection: ShareSelection? = nil, fallback: String? = nil) -> ShareDisplay {
        ShareRules.display(card: pair.0, data: pair.1, viewerId: viewer, now: F.t0.addingTimeInterval(offset),
                           selection: selection, zone: F.moscow, fallback: fallback)
    }

    func testAskerChoosesWithCountsAndFootnote() {
        let d = display(share())
        XCTAssertEqual(d.mode, .choose)
        XCTAssertEqual(d.question, "Чтобы ответить, мне нужно почитать переписку этой беседы. Поделиться?")
        XCTAssertEqual(d.chips.map(\.title), ["Сегодня", "Эта неделя", "Всё время"])
        XCTAssertEqual(d.chips.map(\.subtitle), ["34 сообщ.", "128 сообщ.", "1\u{00A0}738 сообщ."])
        XCTAssertEqual(d.chips.map(\.selected), [true, false, false], "подсказка бота — выбрана")
        XCTAssertEqual(d.chips[0].accessibilityLabel, "Сегодня, 34 сообщения")
        XCTAssertEqual(d.photos?.count, "(3)")
        XCTAssertEqual(d.photos?.on, false, "галка по умолчанию выключена")
        XCTAssertEqual(d.photos?.accessibilityLabel, "Включать фото, 3 фото")
        XCTAssertEqual(d.shareAccessibility, "Поделиться перепиской за сегодня")
        XCTAssertEqual(d.footnote, "Прочитаю только для этого вопроса и уточнений к нему. Через час забуду. Решаешь только ты.")
        XCTAssertTrue(d.canShare)
        XCTAssertTrue(d.canDecline)
    }

    func testPhotosLabelForCappedPeriod() {
        let d = display(share(), selection: ShareSelection(period: "all", photos: true))
        XCTAssertEqual(d.photos?.count, "(60 последних из 337)")
        XCTAssertEqual(d.photos?.on, true)
        XCTAssertEqual(d.photos?.accessibilityLabel, "Включать фото, 60 фото")
        XCTAssertEqual(d.shareAccessibility, "Поделиться перепиской за всё время")
    }

    func testDefaultSelectionSkipsEmptyAndDisabled() {
        var empty = F.shareData()
        empty["options"] = [
            ["period": "today", "messages": 0, "photos": 0, "enabled": false],
            ["period": "week", "messages": 12, "photos": 0, "enabled": true],
            ["period": "all", "messages": 90, "photos": 4, "enabled": true],
        ]
        empty["suggest"] = ["period": "today", "photos": true]
        let data = ShareCardData.parse(jv(empty))!
        XCTAssertEqual(ShareRules.defaultSelection(data), ShareSelection(period: "week", photos: false),
                       "пустой «сегодня» → следующий непустой; фото в нём нет — галка выключена")
        var big = F.shareData(extra: ["suggest": ["period": "all", "photos": false]])
        var options = big["options"] as! [[String: Any]]
        options[2]["enabled"] = false
        options[2]["off"] = "too_big"
        big["options"] = options
        let wrapped = ShareCardData.parse(jv(big))!
        XCTAssertEqual(ShareRules.defaultSelection(wrapped)?.period, "today", "по кругу к первому доступному")
        XCTAssertEqual(ShareRules.effectiveSelection(wrapped, stored: ShareSelection(period: "all", photos: true))?.period,
                       "today", "выбор на погашенном варианте откатывается")
        // Ревью 11.10: подсказка модели «с фото» галку НЕ включает (по умолчанию выкл., фото включает человек).
        let suggested = ShareCardData.parse(jv(F.shareData(extra: ["suggest": ["period": "week", "photos": true]])))!
        XCTAssertEqual(ShareRules.defaultSelection(suggested), ShareSelection(period: "week", photos: false),
                       "подсказка «неделя с фото» — неделя выбрана, галка выключена")
    }

    func testTooBigNotice() {
        var options = F.shareData()["options"] as! [[String: Any]]
        options[2]["enabled"] = false
        options[2]["off"] = "too_big"
        let d = display(share(extra: ["note": "too_big", "options": options]))
        XCTAssertEqual(d.notice, "За всё время выходит слишком много для моего лимита. Выбери период поменьше.")
        XCTAssertEqual(d.chips[2].subtitle, "слишком много")
        XCTAssertFalse(d.chips[2].enabled)
        XCTAssertEqual(d.chips[2].accessibilityLabel, "Всё время, недоступно: слишком много")
        var budget = options
        budget[1]["enabled"] = false
        budget[1]["off"] = "budget"
        XCTAssertEqual(display(share(extra: ["options": budget])).chips[1].subtitle, "лимит на сегодня")
    }

    func testOthersWaitReadOnly() {
        let d = display(share(), viewer: "petya")
        XCTAssertEqual(d.mode, .waiting)
        XCTAssertTrue(d.chips.isEmpty)
        XCTAssertEqual(d.lines.count, 2)
        XCTAssertEqual(d.lines[0].plainText, "Еблуша просит разрешения почитать переписку этой беседы, чтобы ответить.")
        XCTAssertEqual(d.lines[1], [.plain("Решает "), .bold("Рома"), .plain(" · ждём ещё 28 мин")],
                       "имя не склоняем и выделяем")
        XCTAssertEqual(display(share(), viewer: "petya", at: 27 * 60 + 1).lines[1].plainText, "Решает Рома · ждём ещё 1 мин")
        XCTAssertEqual(display(share(), viewer: "petya", at: 29 * 60).lines[1].plainText, "Решает Рома",
                       "срок вышел, сервер ещё не закрыл — без «ждём»")
        XCTAssertEqual(display(share(), viewer: "roma", at: 29 * 60).mode, .waiting, "спросивший опоздал — выбирать нечего")
    }

    func testReadingAndAnswered() {
        let forget: [[String: Any]] = [["id": "forget", "who": ["any": true], "until": F.iso(42 * 60)]]
        let choice: [String: Any] = ["period": "today", "photos": true, "by": F.roma, "at": F.iso(-60)]
        let reading = display(share(state: "granted", actions: forget, extra: ["choice": choice, "until": F.iso(42 * 60)]),
                              viewer: "petya")
        XCTAssertEqual(reading.mode, .reading)
        XCTAssertEqual(reading.lines[0], [.bold("Рома"), .plain(" поделился перепиской за сегодня, с фото")])
        XCTAssertEqual(reading.detail, "Читаю: 34 сообщения и 3 фото…")
        XCTAssertTrue(reading.canForget, "забыть может любой участник")

        let noPhotos: [String: Any] = ["period": "week", "photos": false, "by": F.roma]
        XCTAssertEqual(display(share(state: "granted", actions: forget, extra: ["choice": noPhotos])).detail,
                       "Читаю: 128 сообщений…")

        let answered = display(share(state: "granted", actions: forget, extra: [
            "choice": choice, "until": F.iso(41 * 60 + 1), "answerMessageId": "ans1",
            "read": ["messages": 34, "photos": 3],
        ]))
        XCTAssertEqual(answered.mode, .answered)
        XCTAssertEqual(answered.answerLink, "Ответ ниже ↓")
        XCTAssertEqual(answered.answerSuffix, " · доступ ещё 42 мин")
        XCTAssertEqual(answered.detail, "Прочитал 34 сообщения и 3 фото.")
    }

    func testFinals() {
        func line(_ state: String, _ extra: [String: Any]) -> String {
            display(share(state: state, closed: true, actions: [], extra: extra)).lines.first!.plainText
        }
        let week: [String: Any] = ["period": "week", "photos": false, "by": F.roma]
        XCTAssertEqual(line("ended", ["choice": week, "endedBy": ["reason": "ended", "at": F.iso(72 * 60)]]),
                       "Рома делился перепиской за эту неделю. Доступ закончился в 15:12.")
        XCTAssertEqual(line("declined", ["endedBy": ["reason": "declined", "by": F.roma]]), "Рома не стал делиться перепиской.")
        XCTAssertEqual(line("expired", ["endedBy": ["reason": "expired"]]), "Рома не ответил — переписку не читаю.")
        XCTAssertEqual(line("expired", ["endedBy": ["reason": "question_deleted"]]), "Вопрос удалили — переписку не читаю.")
        // Тем же текстом, что запасной текст сервера (одинаково на всех клиентах).
        XCTAssertEqual(line("expired", ["endedBy": ["reason": "replaced"]]), "Вопрос сменился — по этой карточке переписку не читаю.")
        XCTAssertEqual(line("expired", ["endedBy": ["reason": "asker_left"]]), "Рома вышел из беседы — переписку не читаю.")
        XCTAssertEqual(line("revoked", ["endedBy": ["reason": "revoked", "by": F.petya]]), "Переписка забыта · попросил Петя.")
        XCTAssertEqual(line("revoked", ["endedBy": ["reason": "revoked", "by": F.roma]]), "Рома забрал разрешение.")
        let unknown = display(share(state: "archived", closed: true, actions: []), fallback: "🔒 Что-то новое")
        XCTAssertEqual(unknown.mode, .finished)
        XCTAssertEqual(unknown.lines.first?.plainText, "🔒 Что-то новое", "состояние новее клиента — текст сервера")
    }

    func testChipsFallBackToColumnWhenNarrow() {
        let chips = display(share()).chips
        XCTAssertFalse(ShareCardView.chipsFitInRow(chips, width: 284), "телефон: «Эта неделя» в ряд не влезет — столбиком")
        XCTAssertTrue(ShareCardView.chipsFitInRow(chips, width: 353), "широкий пузырь (380 макета) — в ряд")
    }

    func testPlurals() {
        XCTAssertEqual(ShareRules.messagesFull(1), "1 сообщение")
        XCTAssertEqual(ShareRules.messagesFull(3), "3 сообщения")
        XCTAssertEqual(ShareRules.messagesFull(5), "5 сообщений")
        XCTAssertEqual(ShareRules.messagesFull(11), "11 сообщений")
        XCTAssertEqual(ShareRules.messagesFull(21), "21 сообщение")
        XCTAssertEqual(ShareRules.messagesFull(1738), "1\u{00A0}738 сообщений")
        XCTAssertEqual(ShareRules.amount(messages: 0, photos: 3), "3 фото")
        XCTAssertEqual(ShareRules.minutesLeft(until: F.t0.addingTimeInterval(41 * 60 + 1), now: F.t0), 42)
        XCTAssertNil(ShareRules.minutesLeft(until: F.t0, now: F.t0))
    }
}

// MARK: - Вью-модель: карточки в ленте

@MainActor
final class BotCardsViewModelTests: XCTestCase {
    typealias F = CardFixtures
    private var rig: SecretTestRig!
    /// Что «сервер» отдаёт историей и как отвечает на действия.
    private var history: Box<[[String: Any]]>!
    private var actResponse: Box<(Int, [String: Any])>!

    override func setUp() async throws {
        rig = SecretTestRig()
        history = Box([])
        actResponse = Box((200, [:]))
        rig.server.addSecretThread("c1", participants: [rig.me, "peer"], type: "GROUP")
        let history = self.history!
        let actResponse = self.actResponse!
        rig.server.extraRoute = { method, path, _ in
            switch (method, path) {
            case ("GET", "conversations/c1/messages"):
                return (200, FakeServer.data(["messages": history.value, "hasMore": false]))
            case ("POST", "messages/mark-conversation-read"):
                return (200, FakeServer.data(["success": true]))
            case ("POST", "conversations/send"):
                return (201, FakeServer.data(["message": F.botRow("sent", envelope: nil, kind: "answer")]))
            default:
                if method == "POST", path.hasPrefix("cards/"), path.hasSuffix("/act") {
                    let (status, body) = actResponse.value
                    return (status, FakeServer.data(body))
                }
                return nil
            }
        }
    }

    override func tearDown() async throws {
        rig.tearDown()
        rig = nil
        CardClock.shared.reset()
        PeerLocalTimeStore.shared.clear()
    }

    private func waitUntil(_ timeout: TimeInterval = 3, _ condition: () -> Bool) async {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() && Date() < deadline {
            try? await Task.sleep(for: .milliseconds(30))
        }
    }

    private func makeVM() -> (ChatViewModel, RealtimeClient) {
        let chats = ChatRepository(api: rig.api, session: rig.session)
        let realtime = RealtimeClient(session: rig.session, deviceIdProvider: rig.deviceIds, api: rig.api)
        let vm = ChatViewModel(
            repo: chats, realtime: realtime, conversationId: "c1", secretRepo: rig.repo,
            callCover: Just(false).eraseToAnyPublisher(), foreground: Just(true).eraseToAnyPublisher()
        )
        return (vm, realtime)
    }

    private func card(_ vm: ChatViewModel, _ id: String = "k1") -> BotCard? {
        vm.ui.messages.first { $0.id == id }?.card
    }

    private var historyCalls: Int { rig.server.calls("GET", "conversations/c1/messages").count }

    /// Таймер, которым можно управлять: «Отменить» — мне (user-me), «Пришёл» — всем.
    private func promiseEnvelope(rev: Int, state: String = "running", closed: Bool = false,
                                 actions: [[String: Any]]? = nil) -> [String: Any] {
        let now = Date()
        var data = F.promiseData()
        data["startAt"] = millisToIso(Int64(now.addingTimeInterval(-60).timeIntervalSince1970 * 1000))
        data["deadlineAt"] = millisToIso(Int64(now.addingTimeInterval(600).timeIntervalSince1970 * 1000))
        return F.envelope(rev: rev, state: state, closed: closed,
                          actions: actions ?? [["id": "arrived", "who": ["any": true]],
                                               ["id": "cancel", "who": ["ids": [rig.me]]]],
                          data: data)
    }

    func testSocketUpdateReplacesCardInPlaceByRev() async throws {
        history.value = [F.botRow("k1", envelope: promiseEnvelope(rev: 1))]
        let (vm, realtime) = makeVM()
        await waitUntil { self.card(vm)?.rev == 1 }
        let loads = historyCalls

        // Новое состояние сокетом — на месте, без перечитывания ленты.
        let rev2 = F.dto(F.botRow("k1", envelope: promiseEnvelope(rev: 2, state: "cancelled", closed: true, actions: [])))
        realtime.events.send(.messageUpdate(conversationId: "c1", messageId: "k1",
                                            info: MessageUpdateInfo(reason: "card", message: rev2)))
        await waitUntil { self.card(vm)?.rev == 2 }
        XCTAssertEqual(card(vm)?.state, "cancelled")

        // Запоздавшее старое — игнор.
        let stale = F.dto(F.botRow("k1", envelope: promiseEnvelope(rev: 1)))
        realtime.events.send(.messageUpdate(conversationId: "c1", messageId: "k1",
                                            info: MessageUpdateInfo(reason: "card", message: stale)))
        // Только карточка, без сообщения — тоже применяется.
        realtime.events.send(.messageUpdate(conversationId: "c1", messageId: "k1",
                                            info: MessageUpdateInfo(reason: "card", card: jv(promiseEnvelope(rev: 3)))))
        await waitUntil { self.card(vm)?.rev == 3 }
        XCTAssertEqual(card(vm)?.state, "running")
        try? await Task.sleep(for: .milliseconds(600))
        XCTAssertEqual(historyCalls, loads, "карточка меняется без GET истории")

        // Перечитывание (по реакции) отдаёт старую страницу — карточка на экране новее и остаётся.
        realtime.events.send(.messageReaction(conversationId: "c1", messageId: "k1"))
        await waitUntil { self.historyCalls > loads }
        try? await Task.sleep(for: .milliseconds(200))
        XCTAssertEqual(card(vm)?.rev, 3)
        withExtendedLifetime(vm) {}
    }

    func testPlainUpdateStillReloads() async throws {
        history.value = [F.botRow("k1", envelope: promiseEnvelope(rev: 1))]
        let (vm, realtime) = makeVM()
        await waitUntil { self.card(vm) != nil }
        let loads = historyCalls
        realtime.events.send(.messageUpdate(conversationId: "c1", messageId: "x", info: MessageUpdateInfo(reason: "edited")))
        await waitUntil { self.historyCalls > loads }
        XCTAssertGreaterThan(historyCalls, loads, "правка обычного сообщения — тихое перечитывание, как раньше")
        withExtendedLifetime(vm) {}
    }

    func testArrivedIsOptimisticThenServerWins() async throws {
        history.value = [F.botRow("k1", envelope: promiseEnvelope(rev: 1))]
        let (vm, _) = makeVM()
        await waitUntil { self.card(vm)?.rev == 1 }
        let done = F.botRow("k1", envelope: promiseEnvelope(rev: 2, state: "arrived", closed: true, actions: []))
        actResponse.value = (200, ["message": done, "serverNow": millisToIso(Int64(Date().timeIntervalSince1970 * 1000))])

        vm.actOnCard(messageId: "k1", action: "arrived")
        XCTAssertEqual(card(vm)?.state, "arrived", "сразу в целевом виде")
        XCTAssertEqual(card(vm)?.rev, 1)
        XCTAssertEqual(vm.ui.cardBusy["k1"], "arrived")
        await waitUntil { self.card(vm)?.rev == 2 }
        XCTAssertNil(vm.ui.cardBusy["k1"])
        XCTAssertEqual(card(vm)?.state, "arrived")
        let body = rig.server.calls("POST", "cards/k1/act").last?.json as? [String: Any]
        XCTAssertEqual(body?["action"] as? String, "arrived")
        XCTAssertNil(vm.ui.error)
        withExtendedLifetime(vm) {}
    }

    func testFailureRollsBackWithText() async throws {
        history.value = [F.botRow("k1", envelope: promiseEnvelope(rev: 1))]
        let (vm, _) = makeVM()
        await waitUntil { self.card(vm)?.rev == 1 }
        actResponse.value = (500, ["message": "boom"])
        vm.actOnCard(messageId: "k1", action: "cancel")
        XCTAssertEqual(card(vm)?.state, "cancelled")
        await waitUntil { vm.ui.error != nil }
        XCTAssertEqual(vm.ui.error, "Не удалось отменить")
        XCTAssertEqual(card(vm)?.state, "running", "откат к подтверждённому")
        XCTAssertNil(vm.ui.cardBusy["k1"])
        withExtendedLifetime(vm) {}
    }

    func testConflictRedrawsSilently() async throws {
        history.value = [F.botRow("k1", envelope: promiseEnvelope(rev: 1))]
        let (vm, _) = makeVM()
        await waitUntil { self.card(vm)?.rev == 1 }
        actResponse.value = (409, ["code": "CARD_CLOSED",
                                   "card": promiseEnvelope(rev: 4, state: "unresolved", closed: true, actions: [])])
        vm.actOnCard(messageId: "k1", action: "arrived")
        await waitUntil { self.card(vm)?.rev == 4 }
        XCTAssertEqual(card(vm)?.state, "unresolved")
        XCTAssertNil(vm.ui.error, "409 — молча перерисовать")
        withExtendedLifetime(vm) {}
    }

    func testShareChoiceGoesToInput() async throws {
        let share = F.envelope(type: "share", state: "pending", actions: [
            ["id": "share", "who": ["ids": [rig.me]], "until": millisToIso(Int64(Date().addingTimeInterval(1800).timeIntervalSince1970 * 1000))],
            ["id": "decline", "who": ["ids": [rig.me]]],
        ], data: F.shareData(extra: ["asker": ["id": rig.me, "displayName": "Я"]]))
        history.value = [F.botRow("k1", envelope: share, replyTo: "q1")]
        let (vm, _) = makeVM()
        await waitUntil { self.card(vm) != nil }
        let message = try XCTUnwrap(vm.ui.messages.first { $0.id == "k1" })
        XCTAssertEqual(vm.shareSelection(for: message), ShareSelection(period: "today", photos: false))
        vm.selectSharePeriod(messageId: "k1", period: "week")
        vm.toggleSharePhotos(messageId: "k1")
        actResponse.value = (403, ["code": "CARD_FORBIDDEN"])
        vm.shareChat(messageId: "k1")
        await waitUntil { vm.ui.error != nil }
        let body = rig.server.calls("POST", "cards/k1/act").last?.json as? [String: Any]
        XCTAssertEqual(body?["action"] as? String, "share")
        XCTAssertEqual((body?["input"] as? [String: Any])?["period"] as? String, "week")
        XCTAssertEqual((body?["input"] as? [String: Any])?["photos"] as? Bool, true)
        XCTAssertEqual(vm.ui.error, "Решает тот, кто спросил")
        XCTAssertEqual(card(vm)?.state, "pending", "у «поделиться» нет оптимизма — карточка как была")
        withExtendedLifetime(vm) {}
    }
}
