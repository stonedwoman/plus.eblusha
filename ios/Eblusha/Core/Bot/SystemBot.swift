import Foundation
import Combine

// Бот «Еблуша» — часть системы мессенджера (решения владельца 2026-10-10, контракт сервера —
// docs/bot-system.md). Бот НЕ участник бесед: его сообщения приходят от системного пользователя
// (`isBot` из БД), которого нет в `participants`. Здесь — всё, что клиенту нужно знать о боте
// вне конкретного экрана: профиль (GET /api/bot), настройка «Чат с Еблушей», правила обращения
// (зеркало сервера, для плашки «Спросить» в поле ввода) и распознавание карточки карты.

// MARK: - Обращение к боту

/// Правила «это обращение к боту» — построчный порт `stripBotNamePrefix` / `stripBotCommandPrefix`
/// из src/lib/systemBot.ts. Решает всё равно сервер; клиенту они нужны, чтобы честно подсветить
/// режим «Спросить» ровно тогда, когда сервер позовёт бота, и не подсвечивать иначе.
enum BotAddress {

    /// «Еблуша,» / «Еблуша:» / «Еблуша!» в начале (можно с пробелами и «@» впереди; регистр, ё и
    /// похожая латиница не важны) → остаток без пробелов по краям, иначе nil.
    static func stripNamePrefix(_ content: String) -> String? {
        let scalars = Array(content.unicodeScalars)
        var i = 0
        while i < scalars.count, isJSWhitespace(scalars[i]) { i += 1 }
        if i < scalars.count, scalars[i] == "@" { i += 1 }
        // Сервер берёт ровно 6 единиц после префикса (длина «еблуша») — так же и здесь.
        guard i + 6 <= scalars.count else { return nil }
        guard foldHead(string(scalars[i..<(i + 6)])) == "еблуша" else { return nil }
        var j = i + 6
        while j < scalars.count, isJSWhitespace(scalars[j]) { j += 1 }
        guard j < scalars.count, scalars[j] == "," || scalars[j] == ":" || scalars[j] == "!" else { return nil }
        return trimJS(string(scalars[(j + 1)...]))
    }

    /// «/eb …» или «/еб …» (любой регистр), дальше пробел или конец → остаток, иначе nil.
    static func stripCommandPrefix(_ content: String) -> String? {
        let scalars = Array(content.unicodeScalars)
        var i = 0
        while i < scalars.count, isJSWhitespace(scalars[i]) { i += 1 }
        guard i + 3 <= scalars.count, scalars[i] == "/" else { return nil }
        let pair = string(scalars[(i + 1)..<(i + 3)]).lowercased()
        guard pair == "eb" || pair == "еб" else { return nil }
        let j = i + 3
        guard j == scalars.count || isJSWhitespace(scalars[j]) else { return nil }
        return trimJS(string(scalars[j...]))
    }

    /// Текст сам по себе зовёт бота (п. 5 и 6 правил сервера).
    static func addressesBot(_ text: String) -> Bool {
        stripNamePrefix(text) != nil || stripCommandPrefix(text) != nil
    }

    /// Свёртка начала к «еблуша»: регистр, ё и похожая латиница (как foldHead на сервере).
    static func foldHead(_ s: String) -> String {
        let map: [Character: Character] = [
            "e": "е", "a": "а", "y": "у", "6": "б", "b": "б", "w": "ш", "ё": "е",
        ]
        return String(s.lowercased().map { map[$0] ?? $0 })
    }

    /// `\s` регулярных выражений JS — сервер режет пробелы именно ими, а не Unicode-набором Swift
    /// (тот, например, не считает пробелом U+FEFF).
    static func isJSWhitespace(_ s: Unicode.Scalar) -> Bool {
        switch s.value {
        case 0x09...0x0D, 0x20, 0xA0, 0x1680, 0x2000...0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
            return true
        default:
            return false
        }
    }

    private static func trimJS(_ s: String) -> String {
        let scalars = Array(s.unicodeScalars)
        var start = 0
        var end = scalars.count
        while start < end, isJSWhitespace(scalars[start]) { start += 1 }
        while end > start, isJSWhitespace(scalars[end - 1]) { end -= 1 }
        return string(scalars[start..<end])
    }

    private static func string(_ slice: ArraySlice<Unicode.Scalar>) -> String {
        var view = String.UnicodeScalarView()
        view.append(contentsOf: slice)
        return String(view)
    }
}

// MARK: - Режим «Спросить» в поле ввода

/// Что композер знает о боте в открытой беседе. Собирает экран беседы.
struct ComposerBotContext: Equatable {
    /// Режим «Спросить» возможен: бот заведён на сервере, беседа обычная (не секретка и не
    /// «Чат с Еблушей», где боту и так уходит всё).
    var askAvailable = false
    /// Ответ сейчас идёт на сообщение бота (сервер смотрит на последнюю цитату — replyToId).
    var replyToBot = false
    /// Секретный чат при живом боте: на «Еблуша, …» показать этот ЛОКАЛЬНЫЙ отказ (никуда не
    /// уходит — текст секретки сервер не видит). nil — не секретка или бота нет.
    var secretRefusal: String?
    /// «Чат с Еблушей»: плашки нет, в пустом поле — подсказка «Вопрос Еблуше…».
    var isBotChat = false
    /// Счётчик нажатий «Уточнить»: каждое снимает прежний отказ от плашки и ставит фокус в поле.
    var clarifyToken = 0

    static let off = ComposerBotContext()
}

/// Чистая логика плашки «Спросить Еблушу» — что показать и что отправить в `metadata.botAsk`.
/// Отдельно от вью, чтобы правило проверялось тестами, а не глазами.
struct BotAskState: Equatable {
    /// Текст или цитата зовут бота (плашка была бы видна, если её не убрали).
    let triggered: Bool
    /// Плашка видна — сообщение уйдёт боту.
    let active: Bool
    /// Что положить в metadata.botAsk: true — «Спросить», false — плашку убрали Backspace'ом или
    /// тапом (обычное сообщение, даже с «Еблуша,» в начале), nil — бот тут ни при чём.
    let botAsk: Bool?
    /// Секретка: показать локальную строку отказа.
    let showRefusal: Bool

    static let idle = BotAskState(triggered: false, active: false, botAsk: nil, showRefusal: false)

    static func resolve(
        context: ComposerBotContext, text: String, dismissed: Bool, editing: Bool
    ) -> BotAskState {
        // Правка бота не зовёт (сервер ловит только /conversations/send).
        if editing { return .idle }
        if context.secretRefusal != nil {
            return BotAskState(
                triggered: false, active: false, botAsk: nil,
                showRefusal: BotAddress.addressesBot(text)
            )
        }
        // «Чат с Еблушей»: там всё — боту, а botAsk:false наоборот отключил бы его. Не трогаем.
        guard context.askAvailable, !context.isBotChat else { return .idle }
        let triggered = context.replyToBot || BotAddress.addressesBot(text)
        guard triggered else { return .idle }
        return dismissed
            ? BotAskState(triggered: true, active: false, botAsk: false, showRefusal: false)
            : BotAskState(triggered: true, active: true, botAsk: true, showRefusal: false)
    }
}

// MARK: - Карточка карты Valheim

/// Карточка карты — картинка, которую бот прикладывает к ответу (модуль Valheim, render.ts):
/// фрагмент мира с игроками и подписью-ссылкой в углу. Тап по ней открывает ЖИВУЮ карту, а не
/// просмотрщик: сама картинка — снимок, интересно то, что сейчас.
enum BotMapCard {
    /// Публичная живая карта сервера (VALHEIM_PUBLIC_MAP_URL у бота; её же печатает карточка).
    static let liveMapURL = URL(string: "https://v.koban.uk/map/")!

    /// Бот загружает карточку файлом «karta-valheim.png» (originalName вложения).
    static func isMapCard(_ attachment: MessageAttachment, fromBot: Bool) -> Bool {
        guard fromBot, attachment.type == "IMAGE", let name = attachment.name else { return false }
        return name.lowercased().hasPrefix("karta-valheim")
    }
}

// MARK: - Сообщение бота

extension Message {
    /// Под ответом бота — кнопка «Уточнить» (ответ на это сообщение в режиме «Спросить»).
    /// Только ответы модели и команд: у служебных уведомлений и приветствия уточнять нечего.
    var botCanBeClarified: Bool {
        isBot && !deleted && !isMine && (botKind == "answer" || botKind == "command")
    }

    /// Вопрос-подтверждение владельцу («Ответь «да» на это сообщение…»): быстрые «Да»/«Нет».
    var botIsConfirm: Bool { isBot && !deleted && !isMine && botKind == "confirm" }

    /// Ответ «Подумай лучше» (metadata.bot.depth = "deep") — самая мощная модель уже подумала.
    var botIsDeep: Bool { isBot && botDepth == ThinkBetter.deepDepth }
}

// MARK: - «Подумай лучше»

/// Кнопка «Подумай лучше» рядом с «Уточнить» (решение владельца, выпуск с таймером): нажатие СРАЗУ
/// шлёт ответом на ответ бота «Еблуша, подумай лучше» (в «Чате с Еблушей» — «Подумай лучше»), без
/// нового API. Бот берёт исходный вопрос и отвечает заново самой мощной моделью; его ответ
/// помечен metadata.bot.depth = "deep" — под таким кнопки уже нет. Показ — по правилам «Уточнить»:
/// одна на ответ, под последней частью, ответ уходит на первую; у карточек и «да/нет» её нет.
enum ThinkBetter {
    static let deepDepth = "deep"
    static let title = "Подумай лучше"
    /// Метка ответа-«подумал лучше» (если бот сам не начал ею текст).
    static let badge = "🧠 Подумал лучше"

    static func requestText(inBotChat: Bool) -> String {
        inBotChat ? "Подумай лучше" : "Еблуша, подумай лучше"
    }

    /// Текст — просьба подумать лучше (то, что шлёт кнопка, и то, что бот понимает словами).
    static func isRequest(_ text: String?) -> Bool {
        guard let text else { return false }
        let body = (BotAddress.stripNamePrefix(text) ?? text)
            .lowercased()
            .replacingOccurrences(of: "ё", with: "е")
            .trimmingCharacters(in: CharacterSet.whitespacesAndNewlines.union(.punctuationCharacters))
        return ["подумай лучше", "подумай еще", "подумай как следует", "глубже", "подумай глубже"].contains(body)
    }

    /// Где рисовать «Подумай лучше»: там же, где «Уточнить» (`clarifyTargets`: строка → первая
    /// часть ответа), кроме ответов, уже «подумавших лучше», и ответов, где я уже попросил
    /// (иначе второе нажатие тратит дневной лимит самой дорогой модели впустую).
    static func targets(_ messages: [Message], clarifyTargets: [String: Message]) -> [String: Message] {
        guard !clarifyTargets.isEmpty else { return [:] }
        var deepAnswers = Set<String>()
        for message in messages where message.botIsDeep {
            deepAnswers.insert(message.botTriggerId ?? message.id)
        }
        var asked = Set<String>()
        for message in messages where message.isMine && !message.deleted && isRequest(message.content) {
            for reply in message.replyTo { asked.insert(reply.id) }
        }
        var result: [String: Message] = [:]
        for (rowId, target) in clarifyTargets {
            if deepAnswers.contains(target.botTriggerId ?? target.id) || target.botIsDeep { continue }
            if asked.contains(target.id) || asked.contains(rowId) { continue }
            result[rowId] = target
        }
        return result
    }

    /// Строки, над текстом которых нужна метка «🧠 Подумал лучше»: первая часть каждого
    /// «глубокого» ответа, если бот сам не начал текст с 🧠.
    static func badgeIds(_ messages: [Message]) -> Set<String> {
        var seen = Set<String>()
        var result = Set<String>()
        for message in messages where message.botIsDeep && !message.deleted {
            let key = message.botTriggerId ?? message.id
            guard seen.insert(key).inserted else { continue }
            let text = message.content?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if !text.hasPrefix("🧠") { result.insert(message.id) }
        }
        return result
    }
}

// MARK: - Удаление ответа бота

/// «Удалить» у ответа бота (решение владельца 12, docs/bot-system.md): ответ может удалить тот, кто
/// спросил (автор обращения), а в «Чате с Еблушей» — его владелец (единственный человек там). Удаление —
/// для всех, тем же POST /messages/delete, что и своё сообщение; права всё равно проверяет сервер.
/// Правило то же, что у веба (`canDeleteBotReply`, domain/bot/systemBot.ts) и остальных клиентов.
enum BotReplyDeletion {

    /// Кто спросил. Подсказка сервера `metadata.bot.askerId` — если она есть, верим только ей. Без неё
    /// (ответы старше подсказки) — отправитель обращения `metadata.bot.triggerMessageId`, как его
    /// проверяет сервер: из цитаты самого сообщения (первая часть ответа отвечает на обращение), из
    /// загруженной ленты или из цитаты первой части того же ответа (у остальных частей цитаты нет).
    /// У ответа без `triggerMessageId` (старые) обращение — то, на что он отвечает (как у веба).
    /// Цитаты берём только у сообщений бота: их `replyTo` — столбец сервера, а у людей мультиответ
    /// собирается из metadata, которую пишет клиент. nil — не узнать (тогда пункта нет).
    static func askerId(of message: Message, in messages: [Message]) -> String? {
        if let hinted = message.botAskerId, !hinted.isEmpty { return hinted }
        let metaTrigger = message.botTriggerId.flatMap { $0.isEmpty ? nil : $0 }
        guard let trigger = metaTrigger ?? message.replyTo.first?.id, !trigger.isEmpty else { return nil }
        func fromQuote(_ m: Message) -> String? {
            guard m.isBot, let quote = m.replyTo.first(where: { $0.id == trigger }),
                  !quote.senderId.isEmpty else { return nil }
            return quote.senderId
        }
        if let own = fromQuote(message) { return own }
        if let asked = messages.first(where: { $0.id == trigger }), !asked.senderId.isEmpty {
            return asked.senderId
        }
        // Первая часть того же ответа. Её triggerMessageId не сверяем: у удалённой части сервер
        // стирает metadata, а цитата (столбец replyToId) остаётся — и по-прежнему указывает на вопрос.
        guard metaTrigger != nil else { return nil }
        for part in messages {
            if let sender = fromQuote(part) { return sender }
        }
        return nil
    }

    /// Можно ли мне удалить это сообщение бота. Не бот, удалённое, системное — нет (своё сообщение
    /// решает обычное правило `isMine`). `isBotChat` и `messages` — беседы, где лежит сообщение.
    static func canDelete(_ message: Message, myId: String?, isBotChat: Bool, messages: [Message]) -> Bool {
        guard message.isBot, !message.isMine, !message.deleted, !message.isSystem else { return false }
        guard let myId, !myId.isEmpty else { return false }
        if isBotChat { return true }
        return askerId(of: message, in: messages) == myId
    }

    /// Что я могу удалить для всех: своё неудалённое или ответ бота на моё обращение.
    static func canDeleteForAll(_ message: Message, myId: String?, isBotChat: Bool, messages: [Message]) -> Bool {
        if message.isMine { return !message.deleted }
        return canDelete(message, myId: myId, isBotChat: isBotChat, messages: messages)
    }
}

// MARK: - Профиль и настройка

struct BotProfile: Codable, Equatable {
    let id: String
    var displayName: String
    var avatarUrl: String?
    var eblid: String?
    var bio: String?
}

/// «Чат с Еблушей»: включён ли и какая это беседа.
struct BotChatState: Equatable {
    var enabled = false
    var conversationId: String?
}

/// GET /api/bot.
struct SystemBotResponse: Decodable {
    struct Bot: Decodable {
        let id: String
        var displayName: String?
        var avatarUrl: String?
        var eblid: String?
        var bio: String?
    }

    let bot: Bot
    var botChat: BotChatStateDto?
    var secretChatRefusal: String?
}

/// GET/PUT /api/bot/settings и событие bot:settings.
struct BotChatStateDto: Decodable {
    var botChatEnabled: Bool?
    var conversationId: String?

    var state: BotChatState {
        BotChatState(enabled: botChatEnabled ?? false, conversationId: botChatEnabled == true ? conversationId : nil)
    }
}

private struct BotSettingsRequest: Encodable {
    let botChatEnabled: Bool
}

/// Бот глазами клиента: профиль, есть ли он на сервере вообще, настройка «Чат с Еблушей».
///
/// Всё «ботовое» в интерфейсе (плашка «Спросить», переключатель в профиле) показывается ТОЛЬКО
/// при `isAvailable`: на сервере без бота (404 на GET /api/bot — ещё не выложен или бот не
/// заведён) приложение выглядит ровно как раньше. Сами сообщения бота от этого не зависят —
/// их узнают по `isBot` из данных.
///
/// Только главный поток (как LocalTimeService): пишут сюда вью, вью-модели и обработчики сокета.
final class SystemBotStore: ObservableObject {
    static let shared = SystemBotStore()

    /// Отказ для секреток, пока сервер не прислал свой (тот же текст, что BOT_SECRET_REFUSAL).
    static let fallbackRefusal =
        "Еблуша не работает в секретных чатах: их сообщения не видит даже сервер, и боту они не уходят."
    static let displayName = "Еблуша"

    @Published private(set) var profile: BotProfile?
    /// true — бот заведён; false — нет (404) или сервер про бота не знает; nil — не спрашивали.
    @Published private(set) var configured: Bool?
    @Published private(set) var botChat = BotChatState()
    @Published private(set) var secretChatRefusal = SystemBotStore.fallbackRefusal
    /// Идёт PUT настройки — переключатель погашен.
    @Published private(set) var saving = false
    @Published private(set) var error: String?

    private let defaults: UserDefaults
    private var lastLoad: Date?
    private var loading = false
    /// Растёт на каждое изменение настройки (PUT, bot:settings): ответ GET, ушедший раньше,
    /// не должен перетирать то, что пришло, пока он летел.
    private var settingsVersion = 0

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        restore()
    }

    var isAvailable: Bool { configured == true }

    func isBotUser(_ userId: String?) -> Bool {
        guard let userId, let id = profile?.id else { return false }
        return id == userId
    }

    // MARK: Загрузка

    /// Профиль бота и своя настройка. Зовут список чатов (вход, переподключение сокета) и экран
    /// профиля. Без `force` — не чаще раза в 30 с: ответ почти не меняется.
    func load(force: Bool = false) {
        guard AppContainer.shared.sessionStore.currentUserId() != nil, !loading else { return }
        if !force, let lastLoad, Date().timeIntervalSince(lastLoad) < 30 { return }
        loading = true
        let version = settingsVersion
        Task { @MainActor in
            defer { loading = false }
            do {
                let response: SystemBotResponse = try await AppContainer.shared.api.get("bot")
                lastLoad = Date()
                apply(response, settingsVersion: version)
            } catch let http as HTTPError where http.code == 404 {
                // BOT_NOT_CONFIGURED или сервер без ручки: всё «ботовое» прячем.
                lastLoad = Date()
                markUnavailable()
            } catch {
                // Нет сети — остаётся то, что знали (в т.ч. сохранённый профиль).
            }
        }
    }

    /// Ответ GET /api/bot. Отдельно от сети — тестам.
    func apply(_ response: SystemBotResponse, settingsVersion version: Int? = nil) {
        let name = response.bot.displayName?.trimmingCharacters(in: .whitespacesAndNewlines)
        let next = BotProfile(
            id: response.bot.id,
            displayName: (name?.isEmpty == false) ? name! : Self.displayName,
            avatarUrl: response.bot.avatarUrl,
            eblid: response.bot.eblid,
            bio: response.bot.bio
        )
        if profile != next { profile = next }
        if configured != true { configured = true }
        if let refusal = response.secretChatRefusal?.trimmingCharacters(in: .whitespacesAndNewlines), !refusal.isEmpty {
            secretChatRefusal = refusal
        }
        if let chat = response.botChat, version == nil || version == settingsVersion {
            botChat = chat.state
        }
        persist()
    }

    private func markUnavailable() {
        if configured != false { configured = false }
        botChat = BotChatState()
        persist()
    }

    // MARK: Настройка «Чат с Еблушей»

    /// Переключатель в профиле и «Открыть чат с Еблушей» в карточке бота. Оптимистично: значение
    /// меняется сразу, на сбое возвращается. `onDone` получает новое состояние (nil — не вышло).
    func setBotChatEnabled(_ on: Bool, onDone: ((BotChatState?) -> Void)? = nil) {
        guard !saving else {
            onDone?(nil)
            return
        }
        let before = botChat
        botChat.enabled = on
        saving = true
        error = nil
        settingsVersion += 1
        Task { @MainActor in
            defer { saving = false }
            do {
                let dto: BotChatStateDto = try await AppContainer.shared.api.put(
                    "bot/settings", body: BotSettingsRequest(botChatEnabled: on)
                )
                settingsVersion += 1
                botChat = dto.state
                onDone?(dto.state)
            } catch let http as HTTPError {
                botChat = before
                switch http.code {
                case 404:
                    markUnavailable()
                    error = "Бот на этом сервере не настроен"
                case 429:
                    error = "Слишком часто — попробуйте через минуту"
                default:
                    error = "Не удалось сохранить настройку"
                }
                onDone?(nil)
            } catch {
                botChat = before
                self.error = "Нет связи с сервером"
                onDone?(nil)
            }
        }
    }

    /// Сокет `bot:settings` (настройку поменяли здесь или на другом своём устройстве).
    func applySettingsEvent(_ dict: [String: Any]) {
        guard let enabled = dict["botChatEnabled"] as? Bool else { return }
        settingsVersion += 1
        botChat = BotChatState(enabled: enabled, conversationId: enabled ? dict["conversationId"] as? String : nil)
    }

    /// Выход: настройка принадлежала прошлому человеку. Профиль бота общий для сервера — остаётся.
    func resetForLogout() {
        botChat = BotChatState()
        saving = false
        error = nil
        lastLoad = nil
        settingsVersion += 1
    }

    // MARK: Память между запусками

    /// Ключ — по серверу: на зеркале бот может быть свой (или не быть вовсе).
    private var storageKey: String { "eb.bot.profile.\(AppConfig.server.rawValue)" }

    /// Профиль с прошлого запуска: плашка «Спросить» работает сразу, не дожидаясь GET.
    private func restore() {
        guard let data = defaults.data(forKey: storageKey),
              let saved = try? JSONDecoder().decode(BotProfile.self, from: data)
        else { return }
        profile = saved
        configured = true
    }

    private func persist() {
        if configured == true, let profile, let data = try? JSONEncoder().encode(profile) {
            defaults.set(data, forKey: storageKey)
        } else if configured == false {
            defaults.removeObject(forKey: storageKey)
        }
    }
}
