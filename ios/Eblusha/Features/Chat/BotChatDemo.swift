#if DEBUG
import SwiftUI

/// Стенд бота «Еблуша» без сети и без входа — чтобы глазами (скриншотом симулятора) проверить
/// пузыри бота, «Уточнить», карточку карты, «печатает…» и режим «Спросить» в поле ввода:
///
///     xcrun simctl launch <устройство> org.eblusha.plus -connectDemo bot
///
/// Сценарии:
/// - `bot` — группа: обращение, ответ бота частями (текст с разметкой + карточка карты),
///   «Уточнить» под последней частью, 👍 бота на «спасибо», «Еблуша печатает…» в шапке;
/// - `bot-dm` — личка двух людей: ответ бота с «Б» и «бот», хотя бот не участник;
/// - `bot-chat` — «Чат с Еблушей»: шапка «бот», приветствие, вопрос-подтверждение «Да»/«Нет»;
/// - `bot-ask` — в поле «Еблуша, …»: плашка «Еблуша» и кнопка «Спросить»;
/// - `bot-reply` — ответ на сообщение бота с пустым полем: плашка и подсказка «Вопрос Еблуше…»;
/// - `bot-secret` — секретка: плашки нет, локальная строка отказа;
/// - `bot-card` — карточка бота (тап по «Б» или по шапке «Чата с Еблушей»).
struct BotChatDemo: View {
    let scenarioId: String

    /// Настоящая вью-модель и настоящая лента (UICollectionView + UIHostingConfiguration): стенд
    /// показывает ровно ту вёрстку, что увидит человек. Сеть ей не нужна — сообщения кладутся в
    /// состояние напрямую, а её собственная загрузка без входа просто молча падает.
    @StateObject private var vm: ChatViewModel
    @StateObject private var proxy = MessageListProxy()

    init(scenarioId: String) {
        self.scenarioId = scenarioId
        Self.seedBot()
        DraftStore.set(Self.conversationId(scenarioId), Self.draft(scenarioId))
        _vm = StateObject(wrappedValue: ChatViewModel(
            repo: AppContainer.shared.chatRepository,
            realtime: AppContainer.shared.realtimeClient,
            conversationId: Self.conversationId(scenarioId),
            secretRepo: AppContainer.shared.secretRepository
        ))
    }

    var body: some View {
        if scenarioId == "bot-card" {
            // Карточка бота: «Б», «бот», EBLID, «Открыть чат с Еблушей» — без дружбы и звонков.
            UserCardSheet(
                seed: UserCardSeed(userId: Self.botId, name: "Еблуша", avatarUrl: nil, isBot: true),
                onOpenConversation: { _ in },
                onDismiss: {}
            )
            .preferredColorScheme(.dark)
        } else {
            chat
        }
    }

    private var chat: some View {
        NavigationStack {
            VStack(spacing: 0) {
                MessageListView(
                    vm: vm,
                    proxy: proxy,
                    isLoading: false,
                    pinToken: 0,
                    sendToken: 0,
                    onForward: { _ in },
                    onOpenImage: { _, _, _ in },
                    onOpenSender: { _ in },
                    onOpenAttachment: { _ in },
                    onEdit: { _ in },
                    onPickReaction: { _ in },
                    onLongPress: { _ in },
                    onQuickReact: { _ in },
                    quickSlots: ReactionFavorites.defaults
                )
                ChatComposer(
                    conversationId: Self.conversationId(scenarioId),
                    staged: [],
                    uploadProgress: nil,
                    replyingTo: vm.ui.replyingTo,
                    sending: false,
                    restoredDraft: nil,
                    onClearReply: { vm.clearReply() },
                    onRemoveStaged: { _ in },
                    onCancelUpload: {},
                    onStageFiles: { _ in },
                    onError: { _ in },
                    onDraftChanged: { _ in },
                    onSend: { _, _ in },
                    onSendStaged: { _, _ in },
                    onSendVoice: { _, _, _, _ in },
                    onReplaceStaged: { _, _ in },
                    onConsumeRestoredDraft: {},
                    onFocusChanged: { _ in },
                    onHeightChanged: { _ in },
                    bot: composerBot
                )
            }
            .background(Eb.surface200)
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    ChatHeaderTitle(model: ChatHeaderModel(
                        conversationId: Self.conversationId(scenarioId),
                        title: title,
                        isGroup: isGroup,
                        peerUserId: isGroup ? nil : (scenarioId == "bot-chat" ? Self.botId : "demo-peer"),
                        peerStatus: "ONLINE",
                        groupSubtitle: isGroup ? "Валентина, Костя, Саша" : nil,
                        secretState: scenarioId == "bot-secret" ? .ready : nil,
                        isBotChat: scenarioId == "bot-chat",
                        botTyping: vm.ui.botTyping
                    ))
                }
            }
        }
        .tint(Eb.brand)
        .preferredColorScheme(.dark)
        .task {
            // Своя загрузка вью-модели (без входа) падает быстро — даём ей отработать и кладём
            // переписку стенда поверх.
            let deadline = Date().addingTimeInterval(4)
            while vm.ui.error == nil, Date() < deadline {
                try? await Task.sleep(for: .milliseconds(100))
            }
            vm.ui.isGroup = isGroup
            vm.ui.isBotChat = scenarioId == "bot-chat"
            vm.ui.isSecret = scenarioId == "bot-secret"
            vm.ui.error = nil
            vm.ui.loading = false
            vm.ui.botTyping = scenarioId == "bot"
            vm.ui.messages = demoMessages
            if scenarioId == "bot-reply", let answer = demoMessages.first(where: { $0.botCanBeClarified }) {
                vm.clarify(answer)
            }
        }
    }

    // MARK: - Данные стенда

    private static let botId = "demo-bot"

    private static func conversationId(_ scenario: String) -> String { "demo-\(scenario)" }

    private static func draft(_ scenario: String) -> String {
        switch scenario {
        case "bot-ask": return "Еблуша, где сейчас Саня?"
        case "bot-secret": return "Еблуша, привет"
        default: return ""
        }
    }

    /// Бот «заведён на сервере» — как после GET /api/bot.
    private static func seedBot() {
        let json = #"{"bot":{"id":"demo-bot","displayName":"Еблуша","eblid":"7087","bio":"Бот мессенджера.","isBot":true},"botChat":{"botChatEnabled":true,"conversationId":"demo-bot-chat"},"secretChatRefusal":"Еблуша не работает в секретных чатах: их сообщения не видит даже сервер, и боту они не уходят."}"#
        if let response = try? JSONDecoder().decode(SystemBotResponse.self, from: Data(json.utf8)) {
            SystemBotStore.shared.apply(response)
        }
    }

    private var isGroup: Bool { scenarioId == "bot" }

    private var title: String {
        switch scenarioId {
        case "bot": return "Кобаны"
        case "bot-chat": return "Еблуша"
        default: return "Валентина"
        }
    }

    private var composerBot: ComposerBotContext {
        switch scenarioId {
        case "bot-secret":
            return ComposerBotContext(secretRefusal: SystemBotStore.shared.secretChatRefusal)
        case "bot-chat":
            return ComposerBotContext(isBotChat: true)
        default:
            let replyToBot = vm.ui.replyingTo.last?.isBot == true
            return ComposerBotContext(askAvailable: true, replyToBot: replyToBot, clarifyToken: vm.ui.clarifyToken)
        }
    }

    private var demoMessages: [Message] {
        let t0: Int64 = 1_760_000_000_000
        func human(_ id: String, _ text: String, mine: Bool = false, at: Int64, ask: Bool = false,
                   reactions: [MessageReaction] = []) -> Message {
            var m = Message(
                id: id, conversationId: "demo", senderId: mine ? "me" : "peer-a",
                senderName: mine ? "Вы" : "Валентина", type: "TEXT", content: text,
                createdAt: t0 + at, isMine: mine, isSystem: false
            )
            m.botAsk = ask
            m.reactions = reactions
            m.receipt = mine ? .read : .none
            return m
        }
        func bot(_ id: String, _ text: String?, kind: String, trigger: String?, at: Int64,
                 reply: Message? = nil, attachments: [MessageAttachment] = []) -> Message {
            var m = Message(
                id: id, conversationId: "demo", senderId: Self.botId, senderName: "Еблуша",
                type: attachments.isEmpty ? "TEXT" : "IMAGE", content: text,
                createdAt: t0 + at, isMine: false, isSystem: false
            )
            m.isBot = true
            m.botKind = kind
            m.botTriggerId = trigger
            m.attachments = attachments
            if let reply {
                m.replyTo = [ReplyInfo(id: reply.id, senderId: reply.senderId, content: reply.content, createdAt: reply.createdAt)]
            }
            return m
        }
        let mapCard = MessageAttachment(
            url: "", type: "IMAGE", mime: "image/png", name: "karta-valheim.png",
            size: 120_000, width: 960, height: 600
        )

        switch scenarioId {
        case "bot-chat":
            let welcome = bot("w1", "Привет! Я — **Еблуша**, бот этого мессенджера.\n\n- Здесь можно писать мне без обращения.\n- В любой обычной беседе позови: «Еблуша, …» или `/eb …`.\n- В секретных чатах я не работаю.", kind: "welcome", trigger: nil, at: 0)
            let ask = human("q1", "перезапусти сервер, когда все выйдут", mine: true, at: 60_000, ask: true)
            let confirm = bot("c1", "Перезапустить сервер Valheim, когда на нём никого не будет?\n\nОтветь «**да**» на это сообщение в течение 5 мин.", kind: "confirm", trigger: "q1", at: 65_000, reply: ask)
            return [welcome, ask, confirm]
        case "bot":
            let q = human("q1", "Еблуша, кто сейчас на сервере?", at: 0, ask: true)
            let a1 = bot("a1", "**На сервере двое:**\n- Парасюха — Луга, у дома\n- Саня — Чёрный лес, у портала «Шахта»\n\nДень 214, вечер. [живая карта](https://v.koban.uk/map/)", kind: "answer", trigger: "q1", at: 9_000, reply: q)
            let a2 = bot("a2", nil, kind: "answer", trigger: "q1", at: 10_000, attachments: [mapCard])
            let thanks = human("t1", "спасибо!", at: 30_000, reactions: [MessageReaction(emoji: "👍", count: 1, mine: false)])
            let mine = human("m1", "а я где?", mine: true, at: 40_000)
            return [q, a1, a2, thanks, mine]
        default:
            let q = human("q1", "/eb что на ужин в Valheim?", mine: true, at: 0, ask: true)
            let a = bot("a1", "Из того, что у вас в сундуках: **суп из репы** и `жареное мясо`.\n\n> Мёд уже кончился.", kind: "answer", trigger: "q1", at: 7_000, reply: q)
            var peer = human("p1", "Ну и **ладно**.\n\n> А мёд кто доел?\nВторая строка", at: 20_000)
            peer.replyTo = [ReplyInfo(id: q.id, senderId: q.senderId, content: q.content, createdAt: q.createdAt)]
            return [q, a, peer]
        }
    }
}
#endif
