import XCTest
import Combine
@testable import Eblusha

// «Подумай лучше» (решение владельца, выпуск с таймером): кнопка рядом с «Уточнить» — там же и по
// тем же правилам; нажатие сразу шлёт ответ «Еблуша, подумай лучше» (в «Чате с Еблушей» —
// «Подумай лучше»); под ответом с metadata.bot.depth = "deep" кнопки нет.

final class ThinkBetterRulesTests: XCTestCase {

    private func human(_ id: String, mine: Bool = false, text: String = "?", reply: Message? = nil) -> Message {
        var m = Message(id: id, conversationId: "c1", senderId: mine ? "me" : "peer", senderName: mine ? "Я" : "Петя",
                        type: "TEXT", content: text, createdAt: 0, isMine: mine, isSystem: false)
        if let reply { m.replyTo = [ReplyInfo(id: reply.id, senderId: reply.senderId, content: reply.content, isBot: reply.isBot)] }
        return m
    }

    private func bot(_ id: String, kind: String = "answer", trigger: String?, depth: String? = nil,
                     text: String = "ответ") -> Message {
        var m = Message(id: id, conversationId: "c1", senderId: "bot", senderName: "Еблуша", type: "TEXT",
                        content: text, createdAt: 0, isMine: false, isSystem: false)
        m.isBot = true
        m.botKind = kind
        m.botTriggerId = trigger
        m.botDepth = depth
        return m
    }

    private func targets(_ messages: [Message]) -> [String: String] {
        var byId: [String: Message] = [:]
        for m in messages { byId[m.id] = m }
        let clarify = MessageListView.botClarifyTargets(messages, byId: byId)
        return ThinkBetter.targets(messages, clarifyTargets: clarify).mapValues(\.id)
    }

    func testRequestTexts() {
        XCTAssertEqual(ThinkBetter.requestText(inBotChat: false), "Еблуша, подумай лучше")
        XCTAssertEqual(ThinkBetter.requestText(inBotChat: true), "Подумай лучше")
        XCTAssertTrue(BotAddress.addressesBot(ThinkBetter.requestText(inBotChat: false)),
                      "текст сам по себе зовёт бота — дойдёт и у сервера без botAsk")
        for text in ["Еблуша, подумай лучше", "подумай лучше", "Подумай ещё!", "подумай еще", "Еблуша: подумай как следует", "глубже"] {
            XCTAssertTrue(ThinkBetter.isRequest(text), text)
        }
        for text in ["подумай", "подумай лучше про субботу", "Еблуша, кто тут", nil] {
            XCTAssertFalse(ThinkBetter.isRequest(text), text ?? "nil")
        }
    }

    func testShownWhereClarifyIsAndRepliesToFirstPart() {
        let q = human("q1", mine: true, text: "Еблуша, сколько весит облако?")
        let a1 = bot("a1", trigger: "q1")
        let a2 = bot("a2", trigger: "q1")
        XCTAssertEqual(targets([q, a1, a2]), ["a2": "a1"], "одна кнопка — под последней частью, ответ — на первую")
    }

    func testHiddenUnderDeepAnswer() {
        let q = human("q1", mine: true)
        let a = bot("a1", trigger: "q1")
        let think = human("q2", mine: true, text: "Еблуша, подумай лучше", reply: a)
        let deep1 = bot("d1", trigger: "q2", depth: "deep")
        let deep2 = bot("d2", trigger: "q2", depth: "deep")
        let t = targets([q, a, think, deep1, deep2])
        XCTAssertNil(t["d2"], "под «подумал лучше» кнопки нет")
        XCTAssertNil(t["a1"], "я уже попросил подумать над этим ответом")
        XCTAssertEqual(ThinkBetter.badgeIds([q, a, think, deep1, deep2]), ["d1"], "метка — над первой частью")
    }

    func testOthersRequestDoesNotHideMine() {
        let q = human("q1")
        let a = bot("a1", trigger: "q1")
        let theirs = human("q2", mine: false, text: "Еблуша, подумай лучше", reply: a)
        XCTAssertEqual(targets([q, a, theirs])["a1"], "a1")
    }

    func testNotUnderCardsConfirmsOrNotices() {
        let q = human("q1", mine: true)
        let card = bot("k1", kind: "card", trigger: "q1")
        let confirm = bot("c1", kind: "confirm", trigger: "q1")
        let notice = bot("n1", kind: "notice", trigger: "q1")
        XCTAssertTrue(targets([q, card, confirm, notice]).isEmpty)
    }

    func testBadgeSkippedWhenBotMarksTextItself() {
        let deep = bot("d1", trigger: "q2", depth: "deep", text: "🧠 Подумал лучше\n\nТочнее: …")
        XCTAssertTrue(ThinkBetter.badgeIds([deep]).isEmpty)
    }
}

@MainActor
final class ThinkBetterViewModelTests: XCTestCase {
    private var rig: SecretTestRig!

    override func setUp() async throws {
        rig = SecretTestRig()
    }

    override func tearDown() async throws {
        rig.tearDown()
        rig = nil
        PeerLocalTimeStore.shared.clear()
    }

    private func waitUntil(_ timeout: TimeInterval = 3, _ condition: () -> Bool) async {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() && Date() < deadline {
            try? await Task.sleep(for: .milliseconds(30))
        }
    }

    private func route(conv: String, conversations: [[String: Any]]?, history: [[String: Any]]) {
        rig.server.extraRoute = { method, path, _ in
            switch (method, path) {
            case ("GET", "conversations"):
                guard let conversations else { return nil }
                return (200, FakeServer.data(["conversations": conversations]))
            case ("GET", "conversations/\(conv)/messages"):
                return (200, FakeServer.data(["messages": history, "hasMore": false]))
            case ("POST", "messages/mark-conversation-read"):
                return (200, FakeServer.data(["success": true]))
            case ("POST", "conversations/send"):
                return (201, FakeServer.data(["message": [
                    "id": "sent-\(UUID().uuidString)", "conversationId": conv, "senderId": "user-me", "type": "TEXT",
                    "content": "ok", "createdAt": "2026-10-11T11:00:00.000Z",
                ] as [String: Any]]))
            default:
                return nil
            }
        }
    }

    private func answerRow(conv: String) -> [String: Any] {
        [
            "id": "a1", "conversationId": conv, "senderId": "bot", "type": "TEXT", "content": "500 тонн",
            "createdAt": "2026-10-11T10:59:00.000Z", "isBot": true,
            "metadata": ["bot": ["v": 1, "kind": "answer", "triggerMessageId": "q1", "askerId": "user-me"]],
            "sender": ["id": "bot", "username": "eblusha_bot", "displayName": "Еблуша", "isBot": true],
        ]
    }

    private func makeVM(_ conv: String) -> ChatViewModel {
        ChatViewModel(
            repo: ChatRepository(api: rig.api, session: rig.session),
            realtime: RealtimeClient(session: rig.session, deviceIdProvider: rig.deviceIds, api: rig.api),
            conversationId: conv, secretRepo: rig.repo,
            callCover: Just(false).eraseToAnyPublisher(), foreground: Just(true).eraseToAnyPublisher()
        )
    }

    func testSendsReplyWithAskInGroup() async throws {
        rig.server.addSecretThread("g1", participants: [rig.me, "peer"], type: "GROUP")
        route(conv: "g1", conversations: nil, history: [answerRow(conv: "g1")])
        let vm = makeVM("g1")
        await waitUntil { vm.ui.messages.contains { $0.id == "a1" } }
        let answer = try XCTUnwrap(vm.ui.messages.first { $0.id == "a1" })
        vm.thinkBetter(answer)
        await waitUntil { !self.rig.server.calls("POST", "conversations/send").isEmpty }
        let body = try XCTUnwrap(rig.server.calls("POST", "conversations/send").last?.json as? [String: Any])
        XCTAssertEqual(body["content"] as? String, "Еблуша, подумай лучше")
        XCTAssertEqual(body["replyToId"] as? String, "a1")
        XCTAssertEqual((body["metadata"] as? [String: Any])?["botAsk"] as? Bool, true)
        withExtendedLifetime(vm) {}
    }

    func testBotChatSendsShortTextWithoutAskFlag() async throws {
        let conversations: [[String: Any]] = [[
            "unreadCount": 0,
            "conversation": [
                "id": "botchat", "isGroup": false, "type": "CLOUD", "isBotChat": true,
                "participants": [
                    ["userId": "user-me", "user": ["id": "user-me", "username": "me"]],
                    ["userId": "bot", "user": ["id": "bot", "username": "eblusha_bot", "displayName": "Еблуша", "isBot": true]],
                ],
                "messages": [],
            ] as [String: Any],
        ]]
        route(conv: "botchat", conversations: conversations, history: [answerRow(conv: "botchat")])
        let vm = makeVM("botchat")
        await waitUntil { vm.ui.isBotChat && vm.ui.messages.contains { $0.id == "a1" } }
        let answer = try XCTUnwrap(vm.ui.messages.first { $0.id == "a1" })
        vm.thinkBetter(answer)
        await waitUntil { !self.rig.server.calls("POST", "conversations/send").isEmpty }
        let body = try XCTUnwrap(rig.server.calls("POST", "conversations/send").last?.json as? [String: Any])
        XCTAssertEqual(body["content"] as? String, "Подумай лучше")
        XCTAssertEqual(body["replyToId"] as? String, "a1")
        XCTAssertNil((body["metadata"] as? [String: Any])?["botAsk"], "botAsk:false в «Чате с Еблушей» отключил бы бота")
        withExtendedLifetime(vm) {}
    }
}
