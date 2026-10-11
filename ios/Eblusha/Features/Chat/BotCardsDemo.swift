#if DEBUG
import SwiftUI

/// Стенд карточек бота и «Подумай лучше» без сети и без входа — глазами (скриншотом симулятора)
/// проверить все состояния таймера обещания и «поделиться перепиской» в настоящей ленте:
///
///     xcrun simctl launch <устройство> org.eblusha.plus -connectDemo cards-p1
///
/// Зритель — «Рома» (`me`), обещавший — «Козёл Ебаный» (`vasya`). Время — от момента запуска,
/// карточки тикают по-настоящему. Кнопки отвечают «как сервер» (BotCardsDemoServer): rev + 1,
/// «Вернуть» 2 минуты, «Поделиться» → «читаю…» → через 3 с ответ ниже.
///
/// Таймер: `cards-p1` идёт + последние 60 с · `cards-p2` больше часа (верхняя граница) +
/// опаздывает и продлевал · `cards-p3` пришёл вовремя + опоздал · `cards-p4` отменён («Вернуть») +
/// никто не отметил · `cards-p5` смотрит не спросивший (только «Пришёл») + цитата удалена.
/// Переписка: `cards-s1` ожидает (у спросившего) + ожидает (у остальных) · `cards-s2` неподъёмно ·
/// `cards-s6` читаю (у спросившего и у остальных) · `cards-s3` ответ ниже + доступ закончился · `cards-s4` отказ + не ответил + вопрос удалили
/// · `cards-s5` забыта другим + забрал разрешение. «Подумай лучше»: `cards-think` (группа),
/// `cards-think-chat` («Чат с Еблушей»). Запасной текст: `cards-unknown` (v: 2 и неизвестный тип).
struct BotCardsDemo: View {
    let scenarioId: String

    @StateObject private var vm: ChatViewModel
    @StateObject private var proxy = MessageListProxy()
    private let t0 = Date()

    init(scenarioId: String) {
        self.scenarioId = scenarioId
        _vm = StateObject(wrappedValue: ChatViewModel(
            repo: AppContainer.shared.chatRepository,
            realtime: AppContainer.shared.realtimeClient,
            conversationId: "demo-\(scenarioId)",
            secretRepo: AppContainer.shared.secretRepository
        ))
    }

    var body: some View {
        NavigationStack {
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
            .background(Eb.surface200)
            .navigationTitle(isBotChat ? "Еблуша" : "Кобаны")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    ChatHeaderTitle(model: ChatHeaderModel(
                        conversationId: "demo-\(scenarioId)",
                        title: isBotChat ? "Еблуша" : "Кобаны",
                        isGroup: !isBotChat,
                        peerUserId: isBotChat ? "demo-bot" : nil,
                        peerStatus: "ONLINE",
                        groupSubtitle: isBotChat ? nil : "Рома, Козёл Ебаный, Петя",
                        secretState: nil,
                        isBotChat: isBotChat,
                        botTyping: false
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
            vm.viewerIdOverride = Demo.me
            vm.ui.isGroup = !isBotChat
            vm.ui.isBotChat = isBotChat
            vm.ui.error = nil
            vm.ui.loading = false
            vm.ui.senderAvatars = ["me": nil, "vasya": nil, "petya": nil]
            let server = BotCardsDemoServer(vm: vm)
            vm.cardTransportOverride = { id, action, input in await server.act(id, action, input) }
            vm.ui.messages = Demo(t0: t0).messages(scenarioId)
        }
    }

    private var isBotChat: Bool { scenarioId == "cards-think-chat" }
}

// MARK: - Данные стенда

private struct Demo {
    static let me = "me"
    static let vasya = "vasya"
    static let petya = "petya"
    static let owner = "owner"
    static let bot = "demo-bot"

    let t0: Date

    private func iso(_ offset: TimeInterval) -> String { millisToIso(Int64((t0.timeIntervalSince1970 + offset) * 1000)) }
    private var roma: [String: Any] { ["id": Self.me, "displayName": "Рома"] }
    private var vasyaP: [String: Any] { ["id": Self.vasya, "displayName": "Козёл Ебаный"] }
    private var petyaP: [String: Any] { ["id": Self.petya, "displayName": "Петя"] }

    func human(_ id: String, _ sender: String, _ name: String, _ text: String, at: TimeInterval,
               reply: Message? = nil) -> Message {
        var m = Message(
            id: id, conversationId: "demo", senderId: sender, senderName: name, type: "TEXT", content: text,
            createdAt: Int64((t0.timeIntervalSince1970 + at) * 1000), isMine: sender == Self.me, isSystem: false
        )
        m.receipt = sender == Self.me ? .read : .none
        if let reply {
            m.replyTo = [ReplyInfo(id: reply.id, senderId: reply.senderId, content: reply.content,
                                   createdAt: reply.createdAt, isBot: reply.isBot)]
        }
        return m
    }

    func botText(_ id: String, _ text: String, at: TimeInterval, kind: String = "answer", trigger: String?,
                 reply: Message? = nil, depth: String? = nil) -> Message {
        var m = human(id, Self.bot, "Еблуша", text, at: at, reply: reply)
        m.isBot = true
        m.botKind = kind
        m.botTriggerId = trigger
        m.botDepth = depth
        return m
    }

    /// Карточка — через настоящий разбор конверта (тот же путь, что у ответа сервера).
    func card(_ id: String, at: TimeInterval, type: String, state: String, closed: Bool = false,
              rev: Int = 1, actions: [[String: Any]], data: [String: Any], fallback: String,
              reply: Message? = nil, v: Int = 1) -> Message {
        var m = botText(id, fallback, at: at, kind: "card", trigger: reply?.id, reply: reply)
        let envelope: [String: Any] = [
            "v": v, "type": type, "id": "c-\(id)", "rev": rev, "state": state, "closed": closed,
            "actions": actions, "data": data,
        ]
        m.card = BotCard.parse(JSONValue.from(envelope))
        m.botAskerId = Self.me
        return m
    }

    // MARK: Таймер

    private func promiseData(quote: String, quoteAt: TimeInterval, label: String, start: TimeInterval,
                             deadline: TimeInterval, requester: [String: Any]? = nil,
                             extra: [String: Any] = [:]) -> [String: Any] {
        var data: [String: Any] = [
            "promiser": vasyaP, "requester": requester ?? roma,
            "quote": ["messageId": "m-\(quote.count)", "text": quote, "at": iso(quoteAt), "by": NSNull(), "deleted": false],
            "label": label, "upperBound": false,
            "startAt": iso(start), "deadlineAt": iso(deadline), "originalDeadlineAt": iso(deadline),
            "extensions": [], "promiserZone": NSNull(),
            "cancelBy": [Self.me, Self.owner], "closedAt": NSNull(), "outcome": NSNull(),
            "cancelledBy": NSNull(), "reopen": NSNull(), "reminders": [],
        ]
        for (key, value) in extra { data[key] = value }
        return data
    }

    private var runningActions: [[String: Any]] {
        [["id": "arrived", "who": ["any": true]], ["id": "cancel", "who": ["ids": [Self.me, Self.owner]]]]
    }

    private func promise(_ id: String, at: TimeInterval, quote: String, label: String, start: TimeInterval,
                         deadline: TimeInterval, state: String = "running", actions: [[String: Any]]? = nil,
                         requester: [String: Any]? = nil, extra: [String: Any] = [:]) -> [Message] {
        let promiseMsg = human("p-\(id)", Self.vasya, "Козёл Ебаный", quote, at: start)
        let ask = human("q-\(id)", requester?["id"] as? String ?? Self.me,
                        requester?["displayName"] as? String ?? "Рома", "Еблуша, проконтролируй",
                        at: at - 1, reply: promiseMsg)
        let cardMsg = card(
            id, at: at, type: "promise", state: state, closed: state != "running",
            actions: actions ?? (state == "running" ? runningActions : []),
            data: promiseData(quote: quote, quoteAt: start, label: label, start: start, deadline: deadline,
                              requester: requester, extra: extra),
            fallback: "⏱ Таймер: **Козёл Ебаный** обещал «\(quote)» — жду до \(CardTime.hm(t0.addingTimeInterval(deadline))) МСК.\nЖивой таймер — в новой версии Еблуши.",
            reply: ask
        )
        return [promiseMsg, ask, cardMsg]
    }

    // MARK: Переписка

    private func shareData(asker: [String: Any] = [:], suggest: String = "today", photos: Bool = false,
                           extra: [String: Any] = [:]) -> [String: Any] {
        var data: [String: Any] = [
            "asker": asker.isEmpty ? roma : asker,
            "suggest": ["period": suggest, "photos": photos],
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

    private func share(_ id: String, at: TimeInterval, state: String, asker: [String: Any]? = nil,
                       question: String = "Еблуша, о чём мы тут договорились на субботу?",
                       actions: [[String: Any]] = [], extra: [String: Any] = [:], fallback: String) -> [Message] {
        let askerP = asker ?? roma
        let q = human("q-\(id)", askerP["id"] as! String, askerP["displayName"] as! String, question, at: at - 2)
        let cardMsg = card(id, at: at, type: "share", state: state, closed: !["pending", "granted"].contains(state),
                           actions: actions, data: shareData(asker: askerP, extra: extra), fallback: fallback, reply: q)
        return [q, cardMsg]
    }

    private func pendingActions(_ asker: String) -> [[String: Any]] {
        [["id": "share", "who": ["ids": [asker]], "until": iso(28 * 60)],
         ["id": "decline", "who": ["ids": [asker]], "until": iso(28 * 60)]]
    }

    private var forget: [[String: Any]] { [["id": "forget", "who": ["any": true], "until": iso(42 * 60)]] }

    private func choice(_ period: String, photos: Bool, by: [String: Any]? = nil) -> [String: Any] {
        ["period": period, "photos": photos, "by": by ?? roma, "at": iso(-60)]
    }

    // MARK: Сценарии

    func messages(_ scenario: String) -> [Message] {
        let m = 60.0
        switch scenario {
        case "cards-p1":
            return promise("a", at: -2 * m, quote: "15мин", label: "15 мин", start: -2 * m - 13, deadline: 12 * m + 47)
                + promise("b", at: -60, quote: "в два часа давай", label: "в 14:00", start: -14 * m - 18, deadline: 42,
                          extra: ["promiserZone": "Asia/Krasnoyarsk"])
        case "cards-p2":
            return promise("c", at: -16 * m, quote: "час-полтора и я ваш", label: "час-полтора → 1,5 ч",
                           start: -17 * m - 13, deadline: 72 * m + 47, extra: ["upperBound": true])
                + promise("d", at: -27 * m, quote: "15мин", label: "15 мин", start: -28 * m, deadline: -3 * m - 12,
                          extra: ["extensions": [["at": iso(-14 * m), "from": iso(-13 * m), "to": iso(-3 * m - 12), "label": "ещё 10 мин"]],
                                  "originalDeadlineAt": iso(-13 * m), "reminders": [0]])
        case "cards-p3":
            return promise("e", at: -39 * m, quote: "15мин", label: "15 мин", start: -40 * m, deadline: -25 * m,
                           state: "arrived",
                           extra: ["closedAt": iso(-28 * m),
                                   "outcome": ["kind": "onTime", "arrivedAt": iso(-28 * m), "deltaSec": -180,
                                               "deltaVsOriginalSec": -180, "via": "call", "by": NSNull(), "detail": NSNull()]])
                + promise("f", at: -59 * m, quote: "15мин", label: "15 мин", start: -60 * m, deadline: -35 * m,
                          state: "arrived",
                          extra: ["extensions": [["at": iso(-46 * m), "from": iso(-45 * m), "to": iso(-35 * m), "label": "ещё 10 мин"]],
                                  "closedAt": iso(-28 * m),
                                  "outcome": ["kind": "late", "arrivedAt": iso(-28 * m), "deltaSec": 420,
                                              "deltaVsOriginalSec": 1020, "via": "valheim", "by": NSNull(), "detail": NSNull()]])
        case "cards-p4":
            return promise("g", at: -4 * m, quote: "15мин", label: "15 мин", start: -5 * m, deadline: 10 * m,
                           state: "cancelled",
                           actions: [["id": "reopen", "who": ["ids": [Self.me, Self.owner]], "until": iso(110)]],
                           extra: ["closedAt": iso(-10), "cancelledBy": roma])
                + promise("h", at: -6 * 60 * m - 10 * m, quote: "к 9", label: "к 21:00", start: -7 * 60 * m,
                          deadline: -6 * 60 * m - 2 * m, state: "unresolved", extra: ["closedAt": iso(-2 * m)])
        case "cards-p5":
            return promise("i", at: -m, quote: "через полчаса", label: "30 мин", start: -2 * m, deadline: 28 * m,
                           actions: [["id": "arrived", "who": ["any": true]], ["id": "cancel", "who": ["ids": [Self.petya, Self.owner]]]],
                           requester: petyaP)
                + promise("j", at: -m, quote: "в 21:30", label: "в 21:30", start: -3 * m, deadline: 3 * 60 * m + 25 * m,
                          extra: ["quote": ["messageId": "x", "text": NSNull(), "at": iso(-3 * m), "deleted": true]])
        case "cards-s1":
            return share("s1", at: -m, state: "pending", actions: pendingActions(Self.me),
                         fallback: "🔒 Чтобы ответить, мне нужно почитать переписку этой беседы. **Рома**, поделиться?")
                + share("s2", at: -30, state: "pending", asker: petyaP, question: "Еблуша, что я пропустил?",
                        actions: pendingActions(Self.petya),
                        fallback: "🔒 Чтобы ответить, мне нужно почитать переписку этой беседы. **Петя**, поделиться?")
        case "cards-s2":
            var options = (shareData()["options"] as! [[String: Any]])
            options[2]["enabled"] = false
            options[2]["off"] = "too_big"
            return share("s3", at: -m, state: "pending", actions: pendingActions(Self.me),
                         extra: ["note": "too_big", "options": options, "suggest": ["period": "week", "photos": true]],
                         fallback: "🔒 За всё время выходит слишком много для моего лимита.")
        case "cards-s6":
            return share("s4", at: -20, state: "granted", actions: forget,
                         extra: ["choice": choice("today", photos: true), "until": iso(59 * m)],
                         fallback: "🔒 **Рома** поделился перепиской за сегодня, с фото. Читаю…")
                + share("s4b", at: -10, state: "granted", asker: petyaP, question: "Еблуша, что я пропустил?",
                        actions: forget,
                        extra: ["choice": choice("week", photos: false, by: petyaP), "until": iso(59 * m)],
                        fallback: "🔒 **Петя** поделился перепиской за эту неделю. Читаю…")
        case "cards-s3":
            let shared = share("s5", at: -3 * m, state: "granted", actions: forget,
                               extra: ["choice": choice("today", photos: true), "until": iso(42 * m),
                                       "answerMessageId": "ans-s5", "read": ["messages": 34, "photos": 3]],
                               fallback: "🔒 **Рома** поделился перепиской за сегодня, с фото. Доступ до 15:12 МСК.")
            let answer = botText("ans-s5", "Договорились в субботу в **14:00** у Сани: Петя везёт мангал, Козёл Ебаный — угли.",
                                 at: -2 * m, trigger: shared[0].id, reply: shared[0])
            return shared + [answer]
                + share("s6", at: -m, state: "ended",
                        extra: ["choice": choice("week", photos: false), "until": iso(-90),
                                "endedBy": ["reason": "ended", "by": NSNull(), "at": iso(-90)]],
                        fallback: "🔒 **Рома** делился перепиской за эту неделю. Доступ закончился.")
        case "cards-s4":
            return share("s7", at: -3 * m, state: "declined",
                         extra: ["endedBy": ["reason": "declined", "by": roma, "at": iso(-3 * m)]],
                         fallback: "🔒 **Рома** не стал делиться перепиской.")
                + share("s8", at: -2 * m, state: "expired",
                        extra: ["endedBy": ["reason": "expired", "by": NSNull(), "at": iso(-2 * m)]],
                        fallback: "🔒 **Рома** не ответил — переписку не читаю.")
                + share("s9", at: -m, state: "expired",
                        extra: ["endedBy": ["reason": "question_deleted", "by": NSNull(), "at": iso(-m)]],
                        fallback: "🔒 Вопрос удалили — переписку не читаю.")
        case "cards-s5":
            return share("s10", at: -2 * m, state: "revoked",
                         extra: ["choice": choice("today", photos: false),
                                 "endedBy": ["reason": "revoked", "by": petyaP, "at": iso(-2 * m)]],
                         fallback: "🔒 Переписка забыта · попросил **Петя**.")
                + share("s11", at: -m, state: "revoked",
                        extra: ["choice": choice("all", photos: false),
                                "endedBy": ["reason": "revoked", "by": roma, "at": iso(-m)]],
                        fallback: "🔒 **Рома** забрал разрешение.")
        case "cards-think", "cards-think-chat":
            let chat = scenario == "cards-think-chat"
            // Сверху — ответ, над которым уже попросили подумать (у него только «Уточнить»), и
            // «подумавший» ответ с меткой; внизу — «да/нет» и свежий ответ с обеими кнопками.
            let q2 = human("t-q2", Self.me, "Рома", chat ? "Сколько весит облако?" : "Еблуша, сколько весит облако?", at: -6 * m)
            let a2 = botText("t-a2", "Обычное кучевое облако — около **500 тонн** воды.", at: -6 * m + 6,
                             trigger: q2.id, reply: q2)
            let think = human("t-q3", Self.me, "Рома", ThinkBetter.requestText(inBotChat: chat), at: -5 * m, reply: a2)
            let a3 = botText("t-a3", "Точнее: кучевое облако объёмом 1 км³ держит **около 500–1000 тонн** воды при плотности 0,5–1 г/м³. Прошлый ответ занижал верхнюю границу.",
                             at: -5 * m + 40, trigger: think.id, reply: think, depth: ThinkBetter.deepDepth)
            let confirm = botText("t-c1", "Перезапустить сервер Valheim, когда на нём никого не будет?\n\nОтветь «**да**» на это сообщение.",
                                  at: -3 * m, kind: "confirm", trigger: "x")
            let q1 = human("t-q1", Self.me, "Рома", chat ? "Почему небо синее?" : "Еблуша, почему небо синее?", at: -m)
            let a1 = botText("t-a1", "Из-за **рэлеевского рассеяния**: короткие волны (синие) рассеиваются в атмосфере сильнее длинных.",
                             at: -m + 8, trigger: q1.id, reply: q1)
            return [q2, a2, think, a3, confirm, q1, a1]
        case "cards-unknown":
            let v2 = card("u1", at: -2 * m, type: "promise", state: "running", actions: runningActions,
                          data: promiseData(quote: "15мин", quoteAt: -3 * m, label: "15 мин", start: -3 * m, deadline: 12 * m),
                          fallback: "⏱ Таймер: **Козёл Ебаный** обещал «15мин» — жду до 14:15 МСК.\nЖивой таймер — в новой версии Еблуши.", v: 2)
            let unknown = card("u2", at: -m, type: "poll", state: "open", actions: [], data: ["question": "?"],
                               fallback: "📊 Опрос: куда идём в субботу? Ответь номером.")
            return [v2, unknown]
        default:
            return []
        }
    }
}

// MARK: - «Сервер» стенда

/// Отвечает на действия карточек так, как ответил бы сервер (SPEC.md §7, SPEC-share §7.1): rev + 1,
/// «Вернуть» 2 минуты, «Поделиться» → «читаю…» → через 3 с ответ ниже. Без сети.
@MainActor
private final class BotCardsDemoServer {
    weak var vm: ChatViewModel?

    init(vm: ChatViewModel) { self.vm = vm }

    func act(_ messageId: String, _ action: String, _ input: JSONValue?) async -> CardActOutcome {
        try? await Task.sleep(for: .milliseconds(600))
        guard let vm, let message = vm.ui.messages.first(where: { $0.id == messageId }),
              let card = (vm.cardConfirmed[messageId] ?? message).card
        else { return .failed(status: 404, code: "CARD_NOT_FOUND") }
        let me = CardPerson(id: Demo.me, displayName: "Рома")
        let now = Date()
        var next: BotCard?
        switch card.payload {
        case .promise(let data):
            if let optimistic = PromiseRules.optimistic(card: card, data: data, action: action, viewer: me, now: now) {
                var actions = optimistic.actions
                if action == "reopen" {
                    actions = [BotCardAction(id: "arrived", anyone: true, ids: [], until: nil),
                               BotCardAction(id: "cancel", anyone: false, ids: [Demo.me, Demo.owner], until: nil)]
                } else {
                    actions = [BotCardAction(id: "reopen", anyone: false, ids: [Demo.me, Demo.owner], until: now.addingTimeInterval(120))]
                }
                next = BotCard(v: 1, type: card.type, id: card.id, rev: card.rev + 1, state: optimistic.state,
                               closed: optimistic.closed, actions: actions, payload: optimistic.payload)
            }
        case .share(var data):
            switch action {
            case "share":
                let period = input?["period"]?.stringValue ?? "today"
                data.choice = ShareCardData.Choice(period: period, photos: input?["photos"]?.boolValue ?? false, by: me, at: now)
                data.until = now.addingTimeInterval(3600)
                next = BotCard(v: 1, type: "share", id: card.id, rev: card.rev + 1, state: "granted", closed: false,
                               actions: [BotCardAction(id: "forget", anyone: true, ids: [], until: data.until)],
                               payload: .share(data))
                scheduleAnswer(messageId: messageId, data: data, rev: card.rev + 2)
            case "decline":
                data.endedBy = ShareCardData.Ended(reason: "declined", by: me, at: now)
                next = BotCard(v: 1, type: "share", id: card.id, rev: card.rev + 1, state: "declined", closed: true,
                               actions: [], payload: .share(data))
            case "forget":
                data.endedBy = ShareCardData.Ended(reason: "revoked", by: me, at: now)
                next = BotCard(v: 1, type: "share", id: card.id, rev: card.rev + 1, state: "revoked", closed: true,
                               actions: [], payload: .share(data))
            default:
                break
            }
        case .unknown:
            break
        }
        guard let next else { return .failed(status: 400, code: "CARD_BAD_INPUT") }
        return .done(message: message.withCard(next), card: next, serverNow: now)
    }

    /// «Бот ответил»: ответ ниже вопроса и карточка «ответ ниже ↓ · доступ ещё 60 мин».
    private func scheduleAnswer(messageId: String, data: ShareCardData, rev: Int) {
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(3))
            guard let vm = self?.vm, let message = vm.ui.messages.first(where: { $0.id == messageId }),
                  let card = message.card, let question = message.replyTo.first
            else { return }
            var answer = Message(
                id: "ans-\(messageId)", conversationId: "demo", senderId: Demo.bot, senderName: "Еблуша", type: "TEXT",
                content: "Договорились в субботу в **14:00** у Сани: Петя везёт мангал.",
                createdAt: Int64(Date().timeIntervalSince1970 * 1000), isMine: false, isSystem: false
            )
            answer.isBot = true
            answer.botKind = "answer"
            answer.botTriggerId = question.id
            answer.replyTo = [question]
            vm.insertOrdered(answer)
            var next = data
            next.answerMessageId = answer.id
            if let choice = data.choice, let option = data.option(choice.period) {
                next.read = ShareCardData.Read(messages: option.messages,
                                               photos: choice.photos ? (option.photosUsed ?? option.photos) : 0)
            }
            let updated = BotCard(v: 1, type: "share", id: card.id, rev: rev, state: "granted", closed: false,
                                  actions: card.actions, payload: .share(next))
            vm.replaceCardMessage(message.withCard(updated))
        }
    }
}

// MARK: - JSON из словарей (только стенд)

extension JSONValue {
    static func from(_ any: Any?) -> JSONValue {
        switch any {
        case nil, is NSNull: return .null
        case let value as Bool: return .bool(value)
        case let value as Int: return .number(Double(value))
        case let value as Double: return .number(value)
        case let value as String: return .string(value)
        case let value as [Any]: return .array(value.map { from($0) })
        case let value as [String: Any]: return .object(value.mapValues { from($0) })
        default: return .null
        }
    }
}
#endif
