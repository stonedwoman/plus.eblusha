import XCTest
import Combine
@testable import Eblusha

// «Удалить» у ответа бота (решение владельца 12, docs/bot-system.md): ответ бота может удалить тот,
// кто спросил (автор обращения), а в «Чате с Еблушей» — его владелец; удаление для всех, тем же
// POST /messages/delete, что и своё сообщение. Здесь: чистые правила (BotReplyDeletion), разбор
// подсказки сервера metadata.bot.askerId, состав меню и вью-модель беседы поверх подменного
// транспорта (SecretTestRig) — что «Удалить» есть ровно у своих ответов бота и уходит на сервер.

// MARK: - Правила

final class BotReplyDeletionTests: XCTestCase {
    private let me = "user-me"

    private func human(_ id: String, sender: String, replyTo: [ReplyInfo] = []) -> Message {
        var m = Message(
            id: id, conversationId: "c", senderId: sender, senderName: sender == me ? "Я" : "Валентина",
            type: "TEXT", content: "Еблуша, …", createdAt: 0, isMine: sender == me, isSystem: false
        )
        m.replyTo = replyTo
        return m
    }

    private func bot(
        _ id: String, kind: String = "answer", trigger: String?, asker: String? = nil,
        quote: Message? = nil, deleted: Bool = false
    ) -> Message {
        var m = Message(
            id: id, conversationId: "c", senderId: "bot", senderName: "Еблуша",
            type: "TEXT", content: deleted ? nil : "ответ", createdAt: 0, isMine: false, isSystem: false
        )
        m.isBot = true
        m.deleted = deleted
        // У удалённого сервер стирает metadata — вида, обращения и подсказки больше нет.
        m.botKind = deleted ? nil : kind
        m.botTriggerId = deleted ? nil : trigger
        m.botAskerId = deleted ? nil : asker
        if let quote {
            m.replyTo = [ReplyInfo(id: quote.id, senderId: quote.senderId, content: quote.content)]
        }
        return m
    }

    private func can(_ m: Message, in list: [Message], botChat: Bool = false, myId: String? = "user-me") -> Bool {
        BotReplyDeletion.canDelete(m, myId: myId, isBotChat: botChat, messages: list)
    }

    func testAskerDeletesWholeAnswerOthersDoNot() {
        let q = human("q", sender: me)
        let a1 = bot("a1", trigger: "q", quote: q)
        let a2 = bot("a2", trigger: "q") // вторая часть — без цитаты
        let list = [q, a1, a2]
        XCTAssertEqual(BotReplyDeletion.askerId(of: a1, in: list), me)
        XCTAssertEqual(BotReplyDeletion.askerId(of: a2, in: list), me)
        XCTAssertTrue(can(a1, in: list))
        XCTAssertTrue(can(a2, in: list))
        XCTAssertFalse(can(a1, in: list, myId: "peer"), "спросил не он — пункта нет")
        XCTAssertFalse(can(a1, in: list, myId: nil))
    }

    func testLaterPartFindsAskerWithoutQuestionOrFirstPart() {
        let q = human("q", sender: me)
        let a1 = bot("a1", trigger: "q", quote: q)
        let a2 = bot("a2", trigger: "q")
        // Вопрос не загружен (долистали только до ответа) — автора даёт цитата первой части.
        XCTAssertEqual(BotReplyDeletion.askerId(of: a2, in: [a1, a2]), me)
        // Первой части нет (удалена давно и не пришла) — автора даёт сам вопрос в ленте.
        XCTAssertEqual(BotReplyDeletion.askerId(of: a2, in: [q, a2]), me)
        // Ни того, ни другого — не узнать, пункта нет.
        XCTAssertNil(BotReplyDeletion.askerId(of: a2, in: [a2]))
        XCTAssertFalse(can(a2, in: [a2]))
    }

    func testDeletedFirstPartStillLeadsToAsker() {
        // Первую часть удалили: сервер стёр её metadata, но цитата (столбец replyToId) осталась.
        let q = human("q", sender: me)
        let a1 = bot("a1", trigger: "q", quote: q, deleted: true)
        let a2 = bot("a2", trigger: "q")
        XCTAssertNil(a1.botTriggerId)
        XCTAssertEqual(BotReplyDeletion.askerId(of: a2, in: [a1, a2]), me)
        XCTAssertTrue(can(a2, in: [a1, a2]))
        XCTAssertFalse(can(a1, in: [a1, a2]), "удалённое второй раз не удаляется")
    }

    func testServerHintWins() {
        let q = human("q", sender: me)
        // Подсказка сервера говорит «спросил peer» — верим ей, а не цитате.
        let a = bot("a", trigger: "q", asker: "peer", quote: q)
        XCTAssertEqual(BotReplyDeletion.askerId(of: a, in: [q, a]), "peer")
        XCTAssertFalse(can(a, in: [q, a]))
        XCTAssertTrue(can(a, in: [q, a], myId: "peer"))
        // Подсказка без обращения (уведомление по просьбе) — тоже достаточно.
        let notice = bot("n", kind: "notice", trigger: nil, asker: me)
        XCTAssertTrue(can(notice, in: [notice]))
    }

    func testAnswerToSomeoneElseInGroup() {
        let mine = human("q1", sender: me)
        let theirs = human("q2", sender: "peer")
        let toMe = bot("a1", trigger: "q1", quote: mine)
        let toThem = bot("b1", trigger: "q2", quote: theirs)
        let list = [mine, toMe, theirs, toThem]
        XCTAssertTrue(can(toMe, in: list))
        XCTAssertFalse(can(toThem, in: list))
        // Чужое сообщение человека — не удалить; своё — обычное правило.
        XCTAssertFalse(BotReplyDeletion.canDeleteForAll(theirs, myId: me, isBotChat: false, messages: list))
        XCTAssertTrue(BotReplyDeletion.canDeleteForAll(mine, myId: me, isBotChat: false, messages: list))
        XCTAssertTrue(BotReplyDeletion.canDeleteForAll(toMe, myId: me, isBotChat: false, messages: list))
        XCTAssertFalse(BotReplyDeletion.canDeleteForAll(toThem, myId: me, isBotChat: false, messages: list))
    }

    func testOldAnswerWithoutTriggerUsesItsQuote() {
        // Ответ старше metadata.bot.triggerMessageId: обращение — то, на что он отвечает (как у веба).
        let q = human("q", sender: me)
        let old = bot("o", trigger: nil, quote: q)
        XCTAssertEqual(BotReplyDeletion.askerId(of: old, in: [old]), me)
        XCTAssertTrue(can(old, in: [q, old]))
        XCTAssertFalse(can(old, in: [q, old], myId: "peer"))
        // Без цитаты и без обращения — не узнать.
        XCTAssertNil(BotReplyDeletion.askerId(of: bot("n", trigger: nil), in: [q]))
    }

    func testPeopleQuotesAreNotTrusted() {
        // Вопроса и первой части нет, зато человек «цитирует» вопрос мультиответом (его собирает
        // клиент из metadata). По такой цитате автора не определяем.
        let a2 = bot("a2", trigger: "q")
        let forged = human("x", sender: "peer", replyTo: [
            ReplyInfo(id: "q", senderId: me, content: "?"), ReplyInfo(id: "z", senderId: me, content: "?"),
        ])
        XCTAssertNil(BotReplyDeletion.askerId(of: a2, in: [forged, a2]))
        XCTAssertFalse(can(a2, in: [forged, a2]))
    }

    func testBotChatOwnerDeletesAnyBotMessage() {
        let welcome = bot("w", kind: "welcome", trigger: nil)
        let notice = bot("n", kind: "notice", trigger: nil)
        let answer = bot("a", trigger: "q")
        let gone = bot("g", trigger: "q", deleted: true)
        let list = [welcome, notice, answer, gone]
        XCTAssertTrue(can(welcome, in: list, botChat: true))
        XCTAssertTrue(can(notice, in: list, botChat: true))
        XCTAssertTrue(can(answer, in: list, botChat: true))
        XCTAssertFalse(can(gone, in: list, botChat: true))
        XCTAssertFalse(can(welcome, in: list, botChat: true, myId: nil))
        // Вне «Чата с Еблушей» сообщение без обращения и подсказки удалить некому.
        XCTAssertFalse(can(notice, in: list, botChat: false))
    }

    func testOnlyBotMessagesUseTheRule() {
        let peer = human("p", sender: "peer")
        XCTAssertFalse(can(peer, in: [peer], botChat: true), "в чате с ботом чужого человека нет, но правило — только для бота")
        var system = Message(
            id: "s", conversationId: "c", senderId: "bot", senderName: "Еблуша", type: "SYSTEM",
            content: "x", createdAt: 0, isMine: false, isSystem: true
        )
        system.isBot = true
        system.botAskerId = me
        XCTAssertFalse(can(system, in: [system]))
    }

    func testMenuItemFollowsTheDecision() {
        let q = human("q", sender: me)
        let answer = bot("a", trigger: "q", quote: q)
        func ids(_ m: Message, _ canDelete: Bool?) -> [String] {
            messageActionItems(
                message: m, canForward: true, canDelete: canDelete,
                onReply: {}, onCopy: {}, onForward: {}, onEdit: {}, onSelect: {}, onDelete: {}
            ).map(\.id)
        }
        XCTAssertEqual(ids(answer, true).last, "delete", "«Удалить» — последним, как у своего")
        XCTAssertFalse(ids(answer, false).contains("delete"))
        XCTAssertFalse(ids(answer, nil).contains("delete"), "без решения вью-модели — только своё")
        XCTAssertTrue(ids(q, nil).contains("delete"))
        XCTAssertFalse(ids(answer, true).contains("edit"), "править ответ бота нельзя")
    }

    func testGalleryItemFollowsTheDecision() {
        let att = MessageAttachment(url: "u", type: "IMAGE")
        let botImage = PhotoViewerItem(
            id: "a#0", attachment: att, messageId: "a", senderName: "Еблуша", isMine: false,
            createdAt: 0, caption: nil, deletable: true
        )
        XCTAssertTrue(botImage.canDelete)
        let old = PhotoViewerItem(
            messageId: "m", indexInMessage: 0, attachment: att, senderName: "Я", isMine: true,
            createdAt: 0, caption: nil
        )
        XCTAssertTrue(old.canDelete, "без решения — старое правило isMine")
    }
}

// MARK: - Разбор подсказки сервера

final class BotAskerMappingTests: XCTestCase {
    private var rig: SecretTestRig!

    override func setUp() {
        super.setUp()
        rig = SecretTestRig()
    }

    override func tearDown() {
        rig.tearDown()
        rig = nil
        super.tearDown()
    }

    private func map(_ json: String) throws -> Message {
        let repo = ChatRepository(api: rig.api, session: rig.session)
        return repo.mapMessage(try JSONDecoder().decode(MessageDto.self, from: Data(json.utf8)))
    }

    func testAskerHintOnlyFromBotMessages() throws {
        let answer = try map(#"""
        {"id":"a1","conversationId":"c1","senderId":"bot","type":"TEXT","content":"x",
         "createdAt":"2026-10-10T10:00:00.000Z","isBot":true,
         "metadata":{"bot":{"v":1,"kind":"answer","triggerMessageId":"q1","askerId":"user-me"}},
         "sender":{"id":"bot","username":"eblusha_bot","displayName":"Еблуша","isBot":true}}
        """#)
        XCTAssertEqual(answer.botAskerId, "user-me")
        let empty = try map(#"""
        {"id":"a2","conversationId":"c1","senderId":"bot","type":"TEXT","content":"x",
         "createdAt":"2026-10-10T10:00:00.000Z","isBot":true,
         "metadata":{"bot":{"v":1,"kind":"answer","askerId":""}}}
        """#)
        XCTAssertNil(empty.botAskerId)
        let old = try map(#"""
        {"id":"a3","conversationId":"c1","senderId":"bot","type":"TEXT","content":"x",
         "createdAt":"2026-10-10T10:00:00.000Z","isBot":true,"metadata":{"bot":{"v":1,"kind":"answer"}}}
        """#)
        XCTAssertNil(old.botAskerId)
        // У людей metadata.bot сервер вырезает, но даже если она есть — это не подсказка.
        let human = try map(#"""
        {"id":"h","conversationId":"c1","senderId":"peer","type":"TEXT","content":"x",
         "createdAt":"2026-10-10T10:00:00.000Z","metadata":{"bot":{"askerId":"user-me"}}}
        """#)
        XCTAssertNil(human.botAskerId)
    }
}

// MARK: - Вью-модель беседы

@MainActor
final class BotReplyDeletionViewModelTests: XCTestCase {
    private var rig: SecretTestRig!
    /// Что «сервер» уже удалил: следующая выдача истории отдаёт их удалёнными, как настоящий.
    private var deleted: Box<Set<String>>!
    /// Какие id сервер откажется удалять (403, как чужое).
    private var forbidden: Set<String> = []

    override func setUp() async throws {
        rig = SecretTestRig()
        deleted = Box([])
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

    private static let botSender: [String: Any] = ["id": "bot", "username": "eblusha_bot", "displayName": "Еблуша", "isBot": true]

    private func row(
        _ id: String, conv: String, sender: String, text: String, at: Int, bot: [String: Any]? = nil,
        replyTo: (id: String, sender: String)? = nil, deleted: Set<String>
    ) -> [String: Any] {
        var m: [String: Any] = [
            "id": id, "conversationId": conv, "senderId": sender, "type": "TEXT",
            "createdAt": String(format: "2026-10-10T10:00:%02d.000Z", at),
            "sender": sender == "bot" ? Self.botSender : ["id": sender, "username": sender],
        ]
        if sender == "bot" { m["isBot"] = true }
        if deleted.contains(id) {
            // Как сервер после удаления: текст и metadata стёрты, цитата (replyToId) осталась.
            m["deletedAt"] = "2026-10-10T11:00:00.000Z"
        } else {
            m["content"] = text
            if let bot { m["metadata"] = ["bot": bot] }
        }
        if let replyTo {
            m["replyToId"] = replyTo.id
            m["replyTo"] = ["id": replyTo.id, "senderId": replyTo.sender, "content": "?", "isBot": false]
        }
        return m
    }

    /// Маршруты беседы: история (с учётом удалённого), «прочитано», местное время, удаление.
    private func route(conv: String, conversations: [[String: Any]]?, history: @escaping (Set<String>) -> [[String: Any]]) {
        let deleted = self.deleted!
        let forbidden = self.forbidden
        rig.server.extraRoute = { method, path, json in
            switch (method, path) {
            case ("GET", "conversations"):
                guard let conversations else { return nil }
                return (200, FakeServer.data(["conversations": conversations]))
            case ("GET", "conversations/\(conv)/messages"):
                return (200, FakeServer.data(["messages": history(deleted.value), "hasMore": false]))
            case ("POST", "messages/mark-conversation-read"):
                return (200, FakeServer.data(["success": true]))
            case ("GET", "users/peer/local-time"):
                return (200, FakeServer.data(["userId": "peer", "localTime": NSNull()]))
            case ("POST", "messages/delete"):
                let id = ((json as? [String: Any])?["messageId"] as? String) ?? ""
                if forbidden.contains(id) { return (403, FakeServer.data(["message": "Forbidden"])) }
                deleted.value.insert(id)
                return (200, FakeServer.data(["success": true]))
            default:
                return nil
            }
        }
    }

    private func makeVM(_ conv: String) -> (ChatViewModel, RealtimeClient) {
        let chats = ChatRepository(api: rig.api, session: rig.session)
        let realtime = RealtimeClient(session: rig.session, deviceIdProvider: rig.deviceIds, api: rig.api)
        let vm = ChatViewModel(
            repo: chats, realtime: realtime, conversationId: conv, secretRepo: rig.repo,
            callCover: Just(false).eraseToAnyPublisher(), foreground: Just(true).eraseToAnyPublisher()
        )
        return (vm, realtime)
    }

    private var deleteCalls: [String] {
        rig.server.calls("POST", "messages/delete").compactMap { ($0.json as? [String: Any])?["messageId"] as? String }
    }

    func testAskerDeletesBotAnswerOthersAnswersStay() async throws {
        rig.server.addSecretThread("c1", participants: [rig.me, "peer"], type: "DIRECT")
        forbidden = ["b1"]
        route(conv: "c1", conversations: nil) { [unowned self] gone in
            [
                row("q1", conv: "c1", sender: rig.me, text: "Еблуша, погода в Ереване?", at: 1, deleted: gone),
                row("a1", conv: "c1", sender: "bot", text: "Солнечно, +18.", at: 2,
                    bot: ["v": 1, "kind": "answer", "triggerMessageId": "q1"], replyTo: ("q1", rig.me), deleted: gone),
                row("a2", conv: "c1", sender: "bot", text: "Завтра дождь.", at: 3,
                    bot: ["v": 1, "kind": "answer", "triggerMessageId": "q1"], deleted: gone),
                row("q2", conv: "c1", sender: "peer", text: "Еблуша, а в Мельбурне?", at: 4, deleted: gone),
                row("b1", conv: "c1", sender: "bot", text: "Там ночь.", at: 5,
                    bot: ["v": 1, "kind": "answer", "triggerMessageId": "q2", "askerId": "peer"],
                    replyTo: ("q2", "peer"), deleted: gone),
            ]
        }
        let (vm, _) = makeVM("c1")
        await waitUntil { vm.ui.messages.count == 5 }
        func msg(_ id: String) throws -> Message { try XCTUnwrap(vm.ui.messages.first { $0.id == id }) }

        // Меню: мой вопрос и обе части ответа на него — «Удалить»; ответ на чужой вопрос и чужое — нет.
        XCTAssertTrue(vm.canDelete(try msg("q1")))
        XCTAssertTrue(vm.canDelete(try msg("a1")))
        XCTAssertTrue(vm.canDelete(try msg("a2")))
        XCTAssertFalse(vm.canDelete(try msg("q2")))
        XCTAssertFalse(vm.canDelete(try msg("b1")))

        // Мультивыбор: удалится ровно то, что можно.
        vm.startSelection("a1")
        vm.toggleSelect("a2")
        vm.toggleSelect("q2")
        vm.toggleSelect("b1")
        XCTAssertEqual(vm.deletableSelectedCount, 2)
        vm.deleteSelected()
        await waitUntil { (try? msg("a2").deleted) == true }
        XCTAssertEqual(Set(deleteCalls), ["a1", "a2"], "чужое на сервер даже не ушло")
        XCTAssertTrue(try msg("a1").deleted)
        XCTAssertTrue(try msg("a2").deleted)
        XCTAssertFalse(try msg("b1").deleted)
        XCTAssertFalse(try msg("q2").deleted)

        // Сервер отказал (спросил другой) — пузырь возвращается, и это видно, а не молча.
        vm.delete(messageId: "b1")
        await waitUntil { vm.ui.error != nil }
        XCTAssertEqual(vm.ui.error, "Не получилось удалить ответ Еблуши")
        XCTAssertFalse(try msg("b1").deleted)
        withExtendedLifetime(vm) {}
    }

    func testBotChatOwnerDeletesFromMenu() async throws {
        let conversations: [[String: Any]] = [[
            "unreadCount": 0,
            "conversation": [
                "id": "botchat", "isGroup": false, "type": "CLOUD", "isBotChat": true,
                "participants": [
                    ["userId": "user-me", "user": ["id": "user-me", "username": "me"]],
                    ["userId": "bot", "user": Self.botSender],
                ],
                "messages": [],
            ] as [String: Any],
        ]]
        route(conv: "botchat", conversations: conversations) { gone in
            [
                self.row("w1", conv: "botchat", sender: "bot", text: "Привет!", at: 1,
                         bot: ["v": 1, "kind": "welcome"], deleted: gone),
                self.row("n1", conv: "botchat", sender: "bot", text: "Лимит на сегодня исчерпан.", at: 2,
                         bot: ["v": 1, "kind": "notice"], deleted: gone),
            ]
        }
        let (vm, _) = makeVM("botchat")
        await waitUntil { vm.ui.messages.count == 2 && vm.ui.isBotChat }
        XCTAssertTrue(vm.ui.isBotChat)
        let welcome = try XCTUnwrap(vm.ui.messages.first { $0.id == "w1" })
        XCTAssertTrue(vm.canDelete(welcome), "в «Чате с Еблушей» владелец удаляет любое сообщение бота")

        vm.delete(messageId: "w1")
        XCTAssertTrue(vm.ui.messages.first { $0.id == "w1" }?.deleted == true, "пузырь гаснет сразу")
        await waitUntil { self.deleteCalls == ["w1"] }
        XCTAssertEqual(deleteCalls, ["w1"])
        try? await Task.sleep(for: .milliseconds(200))
        XCTAssertNil(vm.ui.error)
        XCTAssertTrue(vm.ui.messages.first { $0.id == "w1" }?.deleted == true, "после перезагрузки — удалено")
        XCTAssertFalse(vm.ui.messages.first { $0.id == "n1" }?.deleted ?? true)
        withExtendedLifetime(vm) {}
    }
}
