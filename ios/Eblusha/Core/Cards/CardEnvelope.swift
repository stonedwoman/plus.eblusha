import Foundation

// Карточки бота (Bot Cards v1, scratchpad/promise-timer/SPEC-share.md §2): сообщение бота, чьё
// состояние меняет ТОЛЬКО сервер, а клиент рисует по типу. Два типа на одном конверте —
// таймер обещания (`promise`, SPEC.md) и «поделиться перепиской» (`share`, SPEC-share.md).
//
// Конверт (`Message.metadata`):
//   bot:  { v: 1, kind: "card", triggerMessageId, askerId }
//   card: { v: 1, type, id, rev, state, closed, actions: [{id, who: {any}|{ids}, until?}], data }
//
// Правила клиента (§2.7), одинаковые на четырёх платформах:
//   1. рисовать карточку, только если isBot && bot.kind == "card" && card.v == 1 и тип известен —
//      иначе обычный пузырь бота с `content` (сервер переписывает его запасным текстом);
//   2. `rev` меньше или равный своему — игнорировать (REST и сокет приходят в любом порядке);
//   3. действие видно, если его `who` пускает зрителя и `until` (по часам сервера) не прошёл;
//      у закрытой карточки (`closed`) остаются только действия со сроком («Вернуть»).
// Права всё равно проверяет сервер: клиент только не показывает лишнего.

/// Человек в данных карточки (снимок сервера: имя на момент события).
struct CardPerson: Equatable {
    let id: String
    var displayName: String
    var avatarUrl: String?

    static func parse(_ json: JSONValue?) -> CardPerson? {
        guard let id = json?["id"]?.stringValue, !id.isEmpty else { return nil }
        let name = json?["displayName"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines)
        return CardPerson(
            id: id,
            displayName: (name?.isEmpty == false) ? name! : "Участник",
            avatarUrl: json?["avatarUrl"]?.stringValue
        )
    }
}

/// Действие карточки, которое сейчас можно сделать, и кому.
struct BotCardAction: Equatable {
    let id: String
    /// `who.any` — любой участник беседы.
    let anyone: Bool
    /// `who.ids` — только перечисленные.
    let ids: [String]
    /// До какого момента (часы сервера). nil — без срока.
    let until: Date?

    func allows(_ viewerId: String?) -> Bool {
        if anyone { return true }
        guard let viewerId, !viewerId.isEmpty else { return false }
        return ids.contains(viewerId)
    }

    static func parse(_ json: JSONValue) -> BotCardAction? {
        guard let id = json["id"]?.stringValue, !id.isEmpty else { return nil }
        let who = json["who"]
        let ids = who?["ids"]?.arrayValue?.compactMap(\.stringValue) ?? []
        return BotCardAction(
            id: id,
            anyone: who?["any"]?.boolValue == true,
            ids: ids,
            until: json["until"]?.dateValue
        )
    }
}

/// Известные типы карточек. Неизвестный тип рисуется запасным текстом.
enum BotCardType: String {
    case promise
    case share
}

/// Разобранные данные типа. `.unknown` — тип неизвестен или данные не той формы (тогда запасной текст).
enum BotCardPayload: Equatable {
    case promise(PromiseCardData)
    case share(ShareCardData)
    case unknown
}

struct BotCard: Equatable {
    static let supportedVersion = 1

    let v: Int
    let type: String
    /// id записи типа (PromiseTimer.id / BotShare.id) — для журналов.
    let id: String
    let rev: Int
    let state: String
    let closed: Bool
    let actions: [BotCardAction]
    let payload: BotCardPayload

    /// Рисовать ли карточку: своя версия конверта и данные разобрались.
    var isRenderable: Bool { v == Self.supportedVersion && payload != .unknown }

    var knownType: BotCardType? { BotCardType(rawValue: type) }

    func action(_ id: String) -> BotCardAction? { actions.first { $0.id == id } }

    /// Что этот зритель может сделать сейчас (по часам сервера). Порядок — как прислал сервер.
    func availableActions(viewer: String?, now: Date) -> [String] {
        actions.compactMap { action in
            // Закрытая карточка: только действия со сроком (вроде «Вернуть» 2 минуты).
            if closed, action.until == nil { return nil }
            if let until = action.until, now >= until { return nil }
            return action.allows(viewer) ? action.id : nil
        }
    }

    /// Копия с другим состоянием — оптимистичный вид до ответа сервера (`rev` тот же: любой
    /// ответ или событие сервера с большим `rev` его заменит).
    func copy(state: String? = nil, closed: Bool? = nil, actions: [BotCardAction]? = nil,
              payload: BotCardPayload? = nil) -> BotCard {
        BotCard(
            v: v, type: type, id: id, rev: rev,
            state: state ?? self.state,
            closed: closed ?? self.closed,
            actions: actions ?? self.actions,
            payload: payload ?? self.payload
        )
    }

    /// `metadata.card` → карточка. nil — это не конверт вовсе (нет `rev`/`type`); карточка с
    /// чужой версией или неизвестным типом разбирается (её `rev` нужен порядку событий), но
    /// `isRenderable == false` — рисуется запасной текст.
    static func parse(_ json: JSONValue?) -> BotCard? {
        guard let json, case .object = json,
              let type = json["type"]?.stringValue, !type.isEmpty,
              let rev = json["rev"]?.intValue
        else { return nil }
        let v = json["v"]?.intValue ?? 0
        let state = json["state"]?.stringValue ?? ""
        let actions = json["actions"]?.arrayValue?.compactMap(BotCardAction.parse) ?? []
        var payload = BotCardPayload.unknown
        if v == supportedVersion {
            switch BotCardType(rawValue: type) {
            case .promise:
                if let data = PromiseCardData.parse(json["data"]) { payload = .promise(data) }
            case .share:
                if let data = ShareCardData.parse(json["data"]) { payload = .share(data) }
            case nil:
                break
            }
        }
        return BotCard(
            v: v, type: type, id: json["id"]?.stringValue ?? "", rev: rev, state: state,
            closed: json["closed"]?.boolValue ?? false, actions: actions, payload: payload
        )
    }
}

// MARK: - Сообщение с карточкой

extension Message {
    /// Карточка, которую надо нарисовать вместо текста (правило 1 §2.7). nil — обычный пузырь.
    var renderableCard: BotCard? {
        guard isBot, !deleted, !isSystem, botKind == "card", let card, card.isRenderable else { return nil }
        return card
    }

    /// Сообщение с новой карточкой (событие без `message`: текст остаётся прежним — его видят
    /// только старые клиенты, новые рисуют карточку).
    func withCard(_ card: BotCard) -> Message {
        var copy = self
        copy.card = card
        return copy
    }
}

/// Правило `rev` (§2.7 п. 2): что выигрывает — то, что уже на экране, или пришедшее.
enum BotCardRevision {
    /// Заменять ли `current` на `incoming` (одно и то же сообщение). Не карточки, удаление и
    /// исчезновение конверта — всегда (решает обычная логика ленты); карточки — только при
    /// строго большем `rev`.
    static func shouldReplace(current: Message, incoming: Message) -> Bool {
        if incoming.deleted { return true }
        guard let old = current.card?.rev, let new = incoming.card?.rev else { return true }
        return new > old
    }

    /// Свежая страница истории вливается в ленту (applyPageOne): сообщение из страницы
    /// побеждает, кроме карточки, чей `rev` на экране уже новее (сокет обогнал REST).
    static func merge(page: [Message], existing: [Message]) -> [Message] {
        guard existing.contains(where: { $0.card != nil }) else { return page }
        var byId: [String: Message] = [:]
        for message in existing where message.card != nil { byId[message.id] = message }
        return page.map { incoming in
            guard let current = byId[incoming.id] else { return incoming }
            return shouldReplace(current: current, incoming: incoming) ? incoming : current
        }
    }
}

// MARK: - Разбор JSON

extension JSONValue {
    var boolValue: Bool? {
        if case .bool(let value) = self { return value }
        return nil
    }

    var arrayValue: [JSONValue]? {
        if case .array(let value) = self { return value }
        return nil
    }

    var intValue: Int? {
        guard case .number(let value) = self, value.isFinite else { return nil }
        return Int(value.rounded())
    }

    /// Время сервера: ISO-строка (как везде в API) или миллисекунды эпохи числом.
    var dateValue: Date? {
        switch self {
        case .string(let iso):
            return parseIsoToMillis(iso).map { Date(timeIntervalSince1970: Double($0) / 1000) }
        case .number(let value):
            guard value.isFinite, value > 0 else { return nil }
            // Секунды эпохи сюда не ходят, но и миллисекунды отличаются от них на порядки.
            return Date(timeIntervalSince1970: value > 100_000_000_000 ? value / 1000 : value)
        default:
            return nil
        }
    }
}
