import XCTest
import Combine
@testable import Eblusha

// Бот «Еблуша» — часть системы (docs/bot-system.md): правила обращения (зеркало сервера),
// режим «Спросить» поля ввода, metadata отправки, разбор isBot из данных сервера, «Чат с
// Еблушей», «Уточнить», карточка карты, «Еблуша печатает…» и безопасное подмножество разметки.
// Без сети: чистые функции и вью-модель поверх подменного транспорта (SecretTestRig).

// MARK: - Правила обращения (src/lib/systemBot.ts)

final class BotAddressTests: XCTestCase {

    func testNamePrefixAddressesBot() {
        XCTAssertEqual(BotAddress.stripNamePrefix("Еблуша, кто на сервере?"), "кто на сервере?")
        XCTAssertEqual(BotAddress.stripNamePrefix("еблуша: привет"), "привет")
        XCTAssertEqual(BotAddress.stripNamePrefix("ЕБЛУША!"), "")
        XCTAssertEqual(BotAddress.stripNamePrefix("Еблуша,"), "")
        // Пробелы и «@» впереди, пробел перед знаком.
        XCTAssertEqual(BotAddress.stripNamePrefix("  @Еблуша , ты тут?"), "ты тут?")
        // ё = е и похожая латиница (e a y b 6 w), как foldHead на сервере.
        XCTAssertNotNil(BotAddress.stripNamePrefix("Ёблуша, привет"))
        XCTAssertNotNil(BotAddress.stripNamePrefix("Eблyшa, привет"))
        XCTAssertNotNil(BotAddress.stripNamePrefix("E6луwa: привет"))
        XCTAssertNotNil(BotAddress.stripNamePrefix("eблуша! привет"))
        // Пробелы JS (\s) — включая U+FEFF и неразрывный.
        XCTAssertNotNil(BotAddress.stripNamePrefix("\u{FEFF}Еблуша, привет"))
        XCTAssertNotNil(BotAddress.stripNamePrefix("\u{00A0}Еблуша, привет"))
    }

    func testNamePrefixDoesNotAddressBot() {
        // Без знака после имени, имя в середине, опечатки — не обращение.
        XCTAssertNil(BotAddress.stripNamePrefix("Еблуша привет"))
        XCTAssertNil(BotAddress.stripNamePrefix("Привет, Еблуша, как дела"))
        XCTAssertNil(BotAddress.stripNamePrefix("Еблушаа, привет"))
        XCTAssertNil(BotAddress.stripNamePrefix("Еблуш, привет"))
        XCTAssertNil(BotAddress.stripNamePrefix("Еблуша"))
        XCTAssertNil(BotAddress.stripNamePrefix(""))
        XCTAssertNil(BotAddress.stripNamePrefix("@@Еблуша, привет"))
    }

    func testCommandPrefix() {
        XCTAssertEqual(BotAddress.stripCommandPrefix("/eb"), "")
        XCTAssertEqual(BotAddress.stripCommandPrefix("/EB сервер"), "сервер")
        XCTAssertEqual(BotAddress.stripCommandPrefix("/еб мир"), "мир")
        XCTAssertEqual(BotAddress.stripCommandPrefix("/ЕБ"), "")
        XCTAssertEqual(BotAddress.stripCommandPrefix("  /Eb  статус  "), "статус")
        XCTAssertEqual(BotAddress.stripCommandPrefix("/eb\nстатус"), "статус")
        XCTAssertNil(BotAddress.stripCommandPrefix("/ebx"))
        XCTAssertNil(BotAddress.stripCommandPrefix("/eбx"))
        // Смесь латиницы и кириллицы сервер не принимает (eb|еб).
        XCTAssertNil(BotAddress.stripCommandPrefix("/eб"))
        XCTAssertNil(BotAddress.stripCommandPrefix("eb сервер"))
        XCTAssertNil(BotAddress.stripCommandPrefix("/e"))
        XCTAssertNil(BotAddress.stripCommandPrefix("скажи /eb"))
    }

    func testAddressesBot() {
        XCTAssertTrue(BotAddress.addressesBot("Еблуша, привет"))
        XCTAssertTrue(BotAddress.addressesBot("/eb помощь"))
        XCTAssertFalse(BotAddress.addressesBot("просто текст"))
        XCTAssertFalse(BotAddress.addressesBot("спасибо Еблуша!"))
    }
}

// MARK: - Режим «Спросить»

final class BotAskStateTests: XCTestCase {
    private let available = ComposerBotContext(askAvailable: true)

    func testTextTriggersAskMode() {
        let state = BotAskState.resolve(context: available, text: "Еблуша, где Саня?", dismissed: false, editing: false)
        XCTAssertTrue(state.active)
        XCTAssertEqual(state.botAsk, true)
        XCTAssertFalse(state.showRefusal)
    }

    func testDismissedPlaqueSendsPlainMessage() {
        // Backspace в начале поля (или тап по плашке): «Еблуша, …» уходит человеку.
        let state = BotAskState.resolve(context: available, text: "Еблуша, ты где?", dismissed: true, editing: false)
        XCTAssertTrue(state.triggered)
        XCTAssertFalse(state.active)
        XCTAssertEqual(state.botAsk, false)
    }

    func testReplyToBotTriggersEvenWithEmptyText() {
        var context = available
        context.replyToBot = true
        let state = BotAskState.resolve(context: context, text: "", dismissed: false, editing: false)
        XCTAssertTrue(state.active)
        XCTAssertEqual(state.botAsk, true)
        // Ответ боту без вопроса — плашку убрали.
        XCTAssertEqual(BotAskState.resolve(context: context, text: "ок", dismissed: true, editing: false).botAsk, false)
    }

    func testOrdinaryTextLeavesMetadataAlone() {
        let state = BotAskState.resolve(context: available, text: "привет", dismissed: false, editing: false)
        XCTAssertEqual(state, .idle)
        // Отказ от плашки без повода ни на что не влияет.
        XCTAssertNil(BotAskState.resolve(context: available, text: "привет", dismissed: true, editing: false).botAsk)
    }

    func testEditingNeverAsks() {
        XCTAssertEqual(BotAskState.resolve(context: available, text: "Еблуша, привет", dismissed: false, editing: true), .idle)
    }

    func testBotChatNeverSendsBotAsk() {
        // В «Чате с Еблушей» всё уходит боту, а botAsk:false наоборот отключил бы его.
        let state = BotAskState.resolve(
            context: ComposerBotContext(isBotChat: true), text: "Еблуша, привет", dismissed: true, editing: false
        )
        XCTAssertEqual(state, .idle)
    }

    func testSecretChatShowsLocalRefusalOnly() {
        let secret = ComposerBotContext(secretRefusal: SystemBotStore.fallbackRefusal)
        let addressed = BotAskState.resolve(context: secret, text: "/eb сервер", dismissed: false, editing: false)
        XCTAssertTrue(addressed.showRefusal)
        XCTAssertFalse(addressed.active)
        XCTAssertNil(addressed.botAsk, "в секретку ничего про бота не уходит")
        XCTAssertFalse(BotAskState.resolve(context: secret, text: "привет", dismissed: false, editing: false).showRefusal)
    }

    func testUnavailableBotIsIgnored() {
        // Сервер без бота (404 на GET /api/bot): плашки нет, metadata не трогаем.
        XCTAssertEqual(BotAskState.resolve(context: .off, text: "Еблуша, привет", dismissed: false, editing: false), .idle)
    }
}

// MARK: - metadata отправки

final class BotSendMetadataTests: XCTestCase {
    private func dict(_ value: JSONValue?) throws -> [String: Any]? {
        guard let value else { return nil }
        let data = try JSONEncoder().encode(value)
        return try JSONSerialization.jsonObject(with: data) as? [String: Any]
    }

    func testNothingToSendKeepsMetadataOut() throws {
        XCTAssertNil(composeSendMetadata(replyBundle: nil, botAsk: nil))
        // Одиночная цитата живёт replyToId, бандла нет.
        XCTAssertNil(composeSendMetadata(
            replyBundle: [ReplyInfo(id: "a", senderId: "u", content: "x")], botAsk: nil
        ))
    }

    func testBotAskFlag() throws {
        XCTAssertEqual(try dict(composeSendMetadata(replyBundle: nil, botAsk: true))?["botAsk"] as? Bool, true)
        XCTAssertEqual(try dict(composeSendMetadata(replyBundle: nil, botAsk: false))?["botAsk"] as? Bool, false)
    }

    func testBundleAndBaseSurviveTogether() throws {
        let bundle = [
            ReplyInfo(id: "a", senderId: "u1", content: "один"),
            ReplyInfo(id: "b", senderId: "", content: nil),
        ]
        let md = try dict(composeSendMetadata(
            replyBundle: bundle, botAsk: true, base: ["duration": .number(3)]
        ))
        XCTAssertEqual(md?["botAsk"] as? Bool, true)
        XCTAssertEqual(md?["duration"] as? Double, 3)
        let rows = md?["replyQuoteBundle"] as? [[String: Any]]
        XCTAssertEqual(rows?.count, 2)
        XCTAssertEqual(rows?.first?["messageId"] as? String, "a")
        XCTAssertEqual(rows?.first?["senderId"] as? String, "u1")
        XCTAssertNil(rows?.last?["senderId"], "пустой senderId не пишется")
        XCTAssertEqual(rows?.last?["preview"] as? String, "")
    }
}

// MARK: - Данные сервера → модель

final class BotMappingTests: XCTestCase {
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

    private func dto(_ json: String) throws -> MessageDto {
        try JSONDecoder().decode(MessageDto.self, from: Data(json.utf8))
    }

    func testBotAnswerIsRecognisedFromServerColumns() throws {
        let repo = ChatRepository(api: rig.api, session: rig.session)
        let message = repo.mapMessage(try dto(#"""
        {"id":"a1","conversationId":"c1","senderId":"bot","type":"TEXT","content":"**Привет**",
         "createdAt":"2026-10-10T10:00:00.000Z","isBot":true,
         "metadata":{"bot":{"v":1,"kind":"answer","triggerMessageId":"q1"}},
         "sender":{"id":"bot","username":"eblusha_bot","displayName":"Еблуша","isBot":true},
         "replyTo":{"id":"q1","content":"Еблуша, привет","senderId":"user-me","isBot":false}}
        """#))
        XCTAssertTrue(message.isBot)
        XCTAssertEqual(message.senderName, "Еблуша")
        XCTAssertEqual(message.botKind, "answer")
        XCTAssertEqual(message.botTriggerId, "q1")
        XCTAssertFalse(message.isMine)
        XCTAssertTrue(message.botCanBeClarified)
        XCTAssertEqual(message.replyTo.first?.isBot, false)
    }

    func testSenderFlagAloneIsEnough() throws {
        // message:notify у старого кода сервера мог нести только sender.isBot.
        let repo = ChatRepository(api: rig.api, session: rig.session)
        let message = repo.mapMessage(try dto(#"""
        {"id":"a2","conversationId":"c1","senderId":"bot","type":"TEXT","content":"x",
         "createdAt":"2026-10-10T10:00:00.000Z",
         "sender":{"id":"bot","username":"eblusha_bot","displayName":"Еблуша","isBot":true}}
        """#))
        XCTAssertTrue(message.isBot)
        XCTAssertNil(message.botKind, "нет metadata.bot — нет и вида (кнопок под ним не будет)")
        XCTAssertFalse(message.botCanBeClarified)
    }

    func testHumanMessagesStayHuman() throws {
        let repo = ChatRepository(api: rig.api, session: rig.session)
        // Сервер вырезает metadata.bot у людей, но даже если она есть — верим только столбцам.
        let message = repo.mapMessage(try dto(#"""
        {"id":"q1","conversationId":"c1","senderId":"user-me","type":"TEXT","content":"Еблуша, привет",
         "createdAt":"2026-10-10T10:00:00.000Z","metadata":{"botAsk":true,"bot":{"kind":"answer"}},
         "sender":{"id":"user-me","username":"me","displayName":"Я"},
         "replyTo":{"id":"a1","content":"ответ","senderId":"bot","isBot":true}}
        """#))
        XCTAssertFalse(message.isBot)
        XCTAssertNil(message.botKind)
        XCTAssertTrue(message.botAsk)
        XCTAssertTrue(message.isMine)
        XCTAssertEqual(message.replyTo.first?.isBot, true, "цитата ответа боту — его сообщение")
    }

    func testOldServerPayloadDecodes() throws {
        let repo = ChatRepository(api: rig.api, session: rig.session)
        let message = repo.mapMessage(try dto(#"""
        {"id":"x","conversationId":"c1","senderId":"peer","type":"TEXT","content":"старое",
         "createdAt":"2026-10-10T10:00:00.000Z","sender":{"id":"peer","username":"peer"}}
        """#))
        XCTAssertFalse(message.isBot)
        XCTAssertFalse(message.botAsk)
    }

    func testListPreviewSignsBotAnswers() throws {
        let botLast = try dto(#"""
        {"id":"a1","conversationId":"c1","senderId":"bot","type":"TEXT","content":"Двое на сервере",
         "createdAt":"2026-10-10T10:00:00.000Z","isBot":true,
         "sender":{"id":"bot","username":"eblusha_bot","displayName":"Еблуша","isBot":true}}
        """#)
        XCTAssertEqual(ChatRepository.listPreview(botLast, inBotChat: false), "Еблуша: Двое на сервере")
        XCTAssertEqual(ChatRepository.listPreview(botLast, inBotChat: true), "Двое на сервере")
        let image = try dto(#"""
        {"id":"a2","conversationId":"c1","senderId":"bot","type":"IMAGE","createdAt":"2026-10-10T10:00:00.000Z","isBot":true}
        """#)
        XCTAssertEqual(ChatRepository.listPreview(image, inBotChat: false), "Еблуша: 📷 Фото")
        let human = try dto(#"""
        {"id":"h","conversationId":"c1","senderId":"peer","type":"TEXT","content":"привет","createdAt":"2026-10-10T10:00:00.000Z"}
        """#)
        XCTAssertEqual(ChatRepository.listPreview(human, inBotChat: false), "привет")
    }

    func testConversationListRecognisesBotChat() async throws {
        rig.server.extraRoute = { method, path, _ in
            guard method == "GET", path == "conversations" else { return nil }
            return (200, FakeServer.data(["conversations": [
                [
                    "unreadCount": 1,
                    "conversation": [
                        "id": "botchat", "isGroup": false, "type": "CLOUD", "isBotChat": true,
                        "participants": [
                            ["userId": "user-me", "user": ["id": "user-me", "username": "me"]],
                            ["userId": "bot", "user": ["id": "bot", "username": "eblusha_bot", "displayName": "Еблуша", "isBot": true]],
                        ],
                        "messages": [[
                            "id": "w1", "conversationId": "botchat", "senderId": "bot", "type": "TEXT",
                            "content": "Привет!", "createdAt": "2026-10-10T10:00:00.000Z", "isBot": true,
                            "sender": ["id": "bot", "username": "eblusha_bot", "displayName": "Еблуша", "isBot": true],
                        ]],
                    ] as [String: Any],
                ],
                [
                    "unreadCount": 0,
                    "conversation": [
                        // Обычная личка двух людей, где последним ответил бот (не участник).
                        "id": "dm", "isGroup": false, "type": "CLOUD",
                        "participants": [
                            ["userId": "user-me", "user": ["id": "user-me", "username": "me"]],
                            ["userId": "peer", "user": ["id": "peer", "username": "peer", "displayName": "Валентина"]],
                        ],
                        "messages": [[
                            "id": "a1", "conversationId": "dm", "senderId": "bot", "type": "TEXT",
                            "content": "Ответ", "createdAt": "2026-10-10T09:00:00.000Z", "isBot": true,
                            "sender": ["id": "bot", "username": "eblusha_bot", "displayName": "Еблуша", "isBot": true],
                        ]],
                    ] as [String: Any],
                ],
            ]]))
        }
        let repo = ChatRepository(api: rig.api, session: rig.session)
        guard case .success(let list) = await repo.listConversations() else {
            return XCTFail("список не загрузился")
        }
        let botChat = try XCTUnwrap(list.first { $0.id == "botchat" })
        XCTAssertTrue(botChat.isBotChat)
        XCTAssertEqual(botChat.title, "Еблуша")
        XCTAssertEqual(botChat.lastMessageText, "Привет!")
        let dm = try XCTUnwrap(list.first { $0.id == "dm" })
        XCTAssertFalse(dm.isBotChat)
        XCTAssertEqual(dm.title, "Валентина")
        XCTAssertEqual(dm.lastMessageText, "Еблуша: Ответ")
        repo.clearLocalData()
    }

    func testTypingPayloadCarriesBotFlag() throws {
        let bot = try JSONDecoder().decode(TypingPayload.self, from: Data(
            #"{"conversationId":"c1","userId":"bot","isTyping":true,"displayName":"Еблуша","isBot":true}"#.utf8
        ))
        XCTAssertTrue(bot.isBot)
        let human = try JSONDecoder().decode(TypingPayload.self, from: Data(
            #"{"conversationId":"c1","userId":"peer","isTyping":true,"displayName":"Валентина"}"#.utf8
        ))
        XCTAssertFalse(human.isBot)
    }
}

// MARK: - Профиль бота и «Чат с Еблушей»

final class SystemBotStoreTests: XCTestCase {
    private var suiteName = ""
    private var defaults: UserDefaults!

    override func setUp() {
        super.setUp()
        suiteName = "eb-bot-tests-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        defaults = nil
        super.tearDown()
    }

    private func response(_ json: String) throws -> SystemBotResponse {
        try JSONDecoder().decode(SystemBotResponse.self, from: Data(json.utf8))
    }

    func testProfileAndSettingsFromServer() throws {
        let store = SystemBotStore(defaults: defaults)
        XCTAssertNil(store.configured)
        XCTAssertFalse(store.isAvailable)
        store.apply(try response(#"""
        {"bot":{"id":"bot1","displayName":"Еблуша","avatarUrl":"/api/files/x","eblid":"7087","bio":"Бот","isBot":true},
         "botChat":{"botChatEnabled":true,"conversationId":"conv-bot"},
         "secretChatRefusal":"Тут не работаю."}
        """#))
        XCTAssertTrue(store.isAvailable)
        XCTAssertEqual(store.profile?.eblid, "7087")
        XCTAssertTrue(store.isBotUser("bot1"))
        XCTAssertFalse(store.isBotUser("peer"))
        XCTAssertFalse(store.isBotUser(nil))
        XCTAssertEqual(store.botChat, BotChatState(enabled: true, conversationId: "conv-bot"))
        XCTAssertEqual(store.secretChatRefusal, "Тут не работаю.")

        // Профиль переживает перезапуск: плашка «Спросить» работает до ответа сервера.
        let restarted = SystemBotStore(defaults: defaults)
        XCTAssertTrue(restarted.isAvailable)
        XCTAssertEqual(restarted.profile?.id, "bot1")
        XCTAssertEqual(restarted.botChat, BotChatState(), "настройку — только с сервера")
    }

    func testSettingsEventAndLogout() throws {
        let store = SystemBotStore(defaults: defaults)
        store.apply(try response(#"{"bot":{"id":"bot1","displayName":null},"botChat":{"botChatEnabled":false,"conversationId":null}}"#))
        XCTAssertEqual(store.profile?.displayName, "Еблуша", "пустое имя — фирменное")
        XCTAssertEqual(store.secretChatRefusal, SystemBotStore.fallbackRefusal)

        store.applySettingsEvent(["botChatEnabled": true, "conversationId": "conv-bot"])
        XCTAssertEqual(store.botChat, BotChatState(enabled: true, conversationId: "conv-bot"))
        // Выключили на другом устройстве: беседы больше нет.
        store.applySettingsEvent(["botChatEnabled": false, "conversationId": "conv-bot"])
        XCTAssertEqual(store.botChat, BotChatState(enabled: false, conversationId: nil))
        // Мусор в событии ничего не ломает.
        store.applySettingsEvent(["botChatEnabled": "да"])
        XCTAssertEqual(store.botChat.enabled, false)

        store.applySettingsEvent(["botChatEnabled": true, "conversationId": "c"])
        store.resetForLogout()
        XCTAssertEqual(store.botChat, BotChatState())
        XCTAssertTrue(store.isAvailable, "профиль бота общий для сервера, выход его не стирает")
    }

    func testStaleGetDoesNotOverrideNewerEvent() throws {
        let store = SystemBotStore(defaults: defaults)
        // GET ушёл при версии 0, пока летел — пришло событие «включено».
        store.applySettingsEvent(["botChatEnabled": true, "conversationId": "conv-bot"])
        store.apply(
            try response(#"{"bot":{"id":"bot1"},"botChat":{"botChatEnabled":false}}"#),
            settingsVersion: 0
        )
        XCTAssertEqual(store.botChat.enabled, true, "ответ GET старше события")
        XCTAssertTrue(store.isAvailable)
    }
}

// MARK: - «Уточнить», карточка карты

final class BotMessageUiTests: XCTestCase {
    private func message(
        _ id: String, bot: Bool, kind: String? = nil, trigger: String? = nil, type: String = "TEXT"
    ) -> Message {
        var m = Message(
            id: id, conversationId: "c", senderId: bot ? "bot" : "peer", senderName: bot ? "Еблуша" : "Валентина",
            type: type, content: "x", createdAt: 0, isMine: false, isSystem: false
        )
        m.isBot = bot
        m.botKind = kind
        m.botTriggerId = trigger
        return m
    }

    func testClarifyButtonOncePerAnswerTargetsFirstPart() {
        let q = message("q", bot: false)
        let a1 = message("a1", bot: true, kind: "answer", trigger: "q")
        let a2 = message("a2", bot: true, kind: "answer", trigger: "q")
        let img = message("a3", bot: true, kind: "answer", trigger: "q", type: "IMAGE")
        let notice = message("n", bot: true, kind: "notice", trigger: "q2")
        let cmd = message("c", bot: true, kind: "command", trigger: "q3")
        let welcome = message("w", bot: true, kind: "welcome")
        let old = message("o", bot: true) // старое сообщение без metadata.bot
        let list = [q, a1, a2, img, notice, cmd, welcome, old]
        let byId = Dictionary(uniqueKeysWithValues: list.map { ($0.id, $0) })
        let targets = MessageListView.botClarifyTargets(list, byId: byId)
        // Кнопка — под последней частью ответа, отвечает она на первую (цитирует вопрос).
        XCTAssertEqual(targets["a3"]?.id, "a1")
        XCTAssertNil(targets["a1"])
        XCTAssertNil(targets["a2"])
        XCTAssertEqual(targets["c"]?.id, "c")
        XCTAssertNil(targets["n"], "у уведомления уточнять нечего")
        XCTAssertNil(targets["w"])
        XCTAssertNil(targets["o"])
        XCTAssertEqual(targets.count, 2)
    }

    func testConfirmButtonsHideAfterMyAnswer() {
        let c1 = message("c1", bot: true, kind: "confirm", trigger: "q1")
        let c2 = message("c2", bot: true, kind: "confirm", trigger: "q2")
        var yes = Message(
            id: "y", conversationId: "c", senderId: "me", senderName: "Я",
            type: "TEXT", content: "да", createdAt: 0, isMine: true, isSystem: false
        )
        yes.replyTo = [ReplyInfo(id: "c1", senderId: "bot", content: "x", isBot: true)]
        var foreign = message("f", bot: false)
        foreign.replyTo = [ReplyInfo(id: "c2", senderId: "bot", content: "x", isBot: true)]
        let answered = MessageListView.botAnsweredConfirms([c1, yes, c2, foreign])
        XCTAssertEqual(answered, ["c1"], "мой ответ прячет кнопки, чужой — нет")
        XCTAssertTrue(MessageListView.botAnsweredConfirms([yes, c1]).isEmpty, "ответ раньше вопроса не в счёт")
    }

    func testConfirmGetsQuickAnswers() {
        XCTAssertTrue(message("c", bot: true, kind: "confirm").botIsConfirm)
        XCTAssertFalse(message("c", bot: false, kind: "confirm").botIsConfirm)
        var deleted = message("c", bot: true, kind: "confirm")
        deleted.deleted = true
        XCTAssertFalse(deleted.botIsConfirm)
    }

    func testMapCardDetection() {
        let card = MessageAttachment(url: "/api/files/k", type: "IMAGE", mime: "image/png", name: "karta-valheim.png")
        XCTAssertTrue(BotMapCard.isMapCard(card, fromBot: true))
        XCTAssertFalse(BotMapCard.isMapCard(card, fromBot: false), "картинку человека не перехватываем")
        let photo = MessageAttachment(url: "/api/files/p", type: "IMAGE", mime: "image/jpeg", name: "photo-1.jpg")
        XCTAssertFalse(BotMapCard.isMapCard(photo, fromBot: true))
        let file = MessageAttachment(url: "/api/files/f", type: "FILE", name: "karta-valheim.png")
        XCTAssertFalse(BotMapCard.isMapCard(file, fromBot: true))
        XCTAssertEqual(BotMapCard.liveMapURL.absoluteString, "https://v.koban.uk/map/")
    }
}

// MARK: - Разметка ответов: безопасное подмножество (chat-scout.md §3)

final class BotMarkdownSubsetTests: XCTestCase {
    private func plain(_ s: AttributedString) -> String { String(s.characters) }

    private func runs(_ s: AttributedString, containing text: String) -> [AttributedString.Runs.Run] {
        s.runs.filter { String(s[$0.range].characters).contains(text) }
    }

    func testInlineMarks() {
        let bold = ChatMarkdown.render("**жирный** и *курсив* и `код`")
        XCTAssertEqual(plain(bold), "жирный и курсив и код")
        XCTAssertTrue(runs(bold, containing: "жирный").allSatisfy { $0.inlinePresentationIntent?.contains(.stronglyEmphasized) == true })
        XCTAssertTrue(runs(bold, containing: "курсив").allSatisfy { $0.inlinePresentationIntent?.contains(.emphasized) == true })
        XCTAssertFalse(runs(bold, containing: "код").isEmpty)
    }

    func testLinksOnlyHttp() {
        let link = ChatMarkdown.render("[живая карта](https://v.koban.uk/map/)")
        XCTAssertEqual(plain(link), "живая карта")
        XCTAssertEqual(link.runs.first?.link, URL(string: "https://v.koban.uk/map/"))
        let bare = ChatMarkdown.render("Карта: https://v.koban.uk/map/")
        XCTAssertTrue(bare.runs.contains { $0.link == URL(string: "https://v.koban.uk/map/") })
        let unsafe = ChatMarkdown.render("[жми](javascript:alert(1))")
        XCTAssertFalse(unsafe.runs.contains { $0.link != nil }, "не http(s) — не ссылка")
    }

    func testBlocks() {
        let text = ChatMarkdown.render("## Сервер\n- Парасюха\n- Саня\n> цитата\n```\nкод блока\n```")
        let out = plain(text)
        XCTAssertFalse(out.contains("##"), "заголовок без решёток")
        XCTAssertTrue(out.contains("•  Парасюха"))
        XCTAssertTrue(out.contains("•  Саня"))
        XCTAssertTrue(out.contains("▎ цитата"))
        XCTAssertTrue(out.contains("код блока"))
        XCTAssertFalse(out.contains("```"))
    }
}

// MARK: - «Еблуша печатает…» и «Уточнить» во вью-модели беседы

@MainActor
final class BotChatViewModelTests: XCTestCase {
    private var rig: SecretTestRig!

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
                return (200, FakeServer.data(["userId": "peer", "localTime": NSNull()]))
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

    private func waitUntil(_ timeout: TimeInterval = 3, _ condition: () -> Bool) async {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() && Date() < deadline {
            try? await Task.sleep(for: .milliseconds(30))
        }
    }

    func testBotTypingIsSeparateFromPeopleAndEndsWithAnswer() async throws {
        let chats = ChatRepository(api: rig.api, session: rig.session)
        let realtime = RealtimeClient(session: rig.session, deviceIdProvider: rig.deviceIds, api: rig.api)
        let vm = ChatViewModel(
            repo: chats, realtime: realtime, conversationId: "c1", secretRepo: rig.repo,
            callCover: Just(false).eraseToAnyPublisher(), foreground: Just(true).eraseToAnyPublisher()
        )
        await waitUntil { vm.autoReadReady }

        // Бот печатает: свой признак, имя собеседника не трогается.
        realtime.events.send(.typing(conversationId: "c1", userId: "bot", isTyping: true, displayName: "Еблуша", isBot: true))
        await waitUntil { vm.ui.botTyping }
        XCTAssertTrue(vm.ui.botTyping)
        XCTAssertNil(vm.ui.typingName)

        // Человек печатает и перестаёт — бот при этом продолжает «печатать».
        realtime.events.send(.typing(conversationId: "c1", userId: "peer", isTyping: true, displayName: "Валентина", isBot: false))
        await waitUntil { vm.ui.typingName != nil }
        XCTAssertEqual(vm.ui.typingName, "Валентина")
        realtime.events.send(.typing(conversationId: "c1", userId: "peer", isTyping: false, displayName: "Валентина", isBot: false))
        await waitUntil { vm.ui.typingName == nil }
        XCTAssertTrue(vm.ui.botTyping)

        // Чужая беседа — мимо.
        realtime.events.send(.typing(conversationId: "other", userId: "bot", isTyping: false, displayName: "Еблуша", isBot: true))
        try? await Task.sleep(for: .milliseconds(100))
        XCTAssertTrue(vm.ui.botTyping)

        // Пришёл ответ бота (от НЕучастника) — «печатает…» гаснет, ответ в ленте как бот.
        let json = #"""
        {"id":"a1","conversationId":"c1","senderId":"bot","type":"TEXT","content":"Готово",
         "createdAt":"2026-10-10T10:00:00.000Z","isBot":true,"metadata":{"bot":{"v":1,"kind":"answer","triggerMessageId":"q1"}},
         "sender":{"id":"bot","username":"eblusha_bot","displayName":"Еблуша","isBot":true}}
        """#
        let dto = try JSONDecoder().decode(MessageDto.self, from: Data(json.utf8))
        realtime.events.send(.messageNew(conversationId: "c1", messageId: "a1", senderId: "bot", message: dto))
        await waitUntil { !vm.ui.botTyping }
        XCTAssertFalse(vm.ui.botTyping)
        let answer = try XCTUnwrap(vm.ui.messages.first { $0.id == "a1" })
        XCTAssertTrue(answer.isBot)
        XCTAssertEqual(answer.senderName, "Еблуша")

        // «Уточнить»: ответ на сообщение бота и сигнал композеру (фокус + плашка).
        let before = vm.ui.clarifyToken
        vm.clarify(answer)
        XCTAssertEqual(vm.ui.replyingTo.map(\.id), ["a1"])
        XCTAssertEqual(vm.ui.clarifyToken, before + 1)
        XCTAssertTrue(vm.ui.replyingTo.last?.isBot == true)
        withExtendedLifetime(vm) {}
    }
}
