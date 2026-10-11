import Foundation

// «Поделиться перепиской» (scratchpad/promise-timer/SPEC-share.md §6): бот просит разрешения
// почитать переписку беседы, решает ТОТ, КТО СПРОСИЛ, остальные видят карточку только для
// чтения. Здесь — данные карточки (`metadata.card.data` типа `share`) и чистые правила вида для
// конкретного зрителя. Вью (ShareCardView) рисует посчитанное.

struct ShareCardData: Equatable {
    struct Option: Equatable {
        /// today | week | all
        let period: String
        var messages: Int
        var photos: Int
        /// Сколько фото реально прочитается (≤ 60 последних) — подпись «60 последних из 337».
        var photosUsed: Int?
        var enabled: Bool
        var capped = false
        /// Почему погашен: too_big | budget (nil — пусто или не сказано).
        var off: String?
    }

    struct Choice: Equatable {
        var period: String
        var photos: Bool
        var by: CardPerson?
        var at: Date?
    }

    struct Read: Equatable {
        var messages: Int
        var photos: Int
    }

    struct Ended: Equatable {
        /// declined | expired | revoked | ended | question_deleted | asker_left | replaced
        var reason: String
        var by: CardPerson?
        var at: Date?
    }

    let asker: CardPerson
    var suggestPeriod: String?
    var suggestPhotos = false
    var options: [Option]
    /// «too_big» — бот вернул карточку: выбранный период оказался неподъёмным.
    var note: String?
    var choice: Choice?
    /// Конец окна доступа (granted).
    var until: Date?
    var answerMessageId: String?
    var read: Read?
    var endedBy: Ended?

    static func parse(_ json: JSONValue?) -> ShareCardData? {
        guard let json, let asker = CardPerson.parse(json["asker"]) else { return nil }
        let options = json["options"]?.arrayValue?.compactMap { o -> Option? in
            guard let period = o["period"]?.stringValue, ShareRules.periods.contains(period) else { return nil }
            let off = o["off"]?.stringValue ?? o["off"]?["reason"]?.stringValue
            return Option(
                period: period,
                messages: o["messages"]?.intValue ?? 0,
                photos: o["photos"]?.intValue ?? 0,
                photosUsed: o["photosUsed"]?.intValue,
                enabled: o["enabled"]?.boolValue ?? true,
                capped: o["capped"]?.boolValue ?? false,
                off: off.flatMap { $0.isEmpty ? nil : $0 }
            )
        } ?? []
        var choice: Choice?
        if let c = json["choice"], case .object = c, let period = c["period"]?.stringValue {
            choice = Choice(period: period, photos: c["photos"]?.boolValue ?? false,
                            by: CardPerson.parse(c["by"]), at: c["at"]?.dateValue)
        }
        var read: Read?
        if let r = json["read"], case .object = r {
            read = Read(messages: r["messages"]?.intValue ?? 0, photos: r["photos"]?.intValue ?? 0)
        }
        var ended: Ended?
        if let e = json["endedBy"], case .object = e, let reason = e["reason"]?.stringValue {
            ended = Ended(reason: reason, by: CardPerson.parse(e["by"]), at: e["at"]?.dateValue)
        }
        return ShareCardData(
            asker: asker,
            suggestPeriod: json["suggest"]?["period"]?.stringValue,
            suggestPhotos: json["suggest"]?["photos"]?.boolValue ?? false,
            options: options,
            note: json["note"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 },
            choice: choice,
            until: json["until"]?.dateValue,
            answerMessageId: json["answerMessageId"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 },
            read: read,
            endedBy: ended
        )
    }

    func option(_ period: String) -> Option? { options.first { $0.period == period } }
}

/// Выбор спросившего на карточке до «Поделиться» (живёт во вью-модели беседы, не в ячейке:
/// ячейки ленты переиспользуются).
struct ShareSelection: Equatable {
    var period: String
    var photos: Bool
}

/// Кусок текста карточки: имена людей — жирным (как в макете), остальное обычным.
enum RichPiece: Equatable {
    case plain(String)
    case bold(String)
}

extension Array where Element == RichPiece {
    var plainText: String {
        map { piece in
            switch piece {
            case .plain(let s), .bold(let s): return s
            }
        }.joined()
    }

    /// Для SwiftUI Text: жирное — через inlinePresentationIntent, шрифт задаёт вью.
    var attributed: AttributedString {
        var out = AttributedString()
        for piece in self {
            switch piece {
            case .plain(let s):
                out += AttributedString(s)
            case .bold(let s):
                var bold = AttributedString(s)
                bold.inlinePresentationIntent = .stronglyEmphasized
                out += bold
            }
        }
        return out
    }
}

struct ShareChip: Equatable {
    let period: String
    let title: String
    /// Под названием: «34 сообщ.» или почему погашен («слишком много», «лимит на сегодня»).
    let subtitle: String
    let enabled: Bool
    let selected: Bool
    let accessibilityLabel: String
}

struct SharePhotosToggle: Equatable {
    let enabled: Bool
    let on: Bool
    /// «(3)», «(60 последних из 337)», «(нет фото)».
    let count: String
    let accessibilityLabel: String
}

/// Что видит зритель карточки «поделиться перепиской».
struct ShareDisplay: Equatable {
    enum Mode: Equatable {
        /// Спросивший выбирает (чипы, галка, кнопки).
        case choose
        /// Ждём решения спросившего (остальные — только чтение).
        case waiting
        /// Доступ дан, бот читает.
        case reading
        /// Доступ дан, ответ есть.
        case answered
        /// Финал: серый текст без кнопок.
        case finished
    }

    var mode: Mode
    var question: String?
    /// Янтарная плашка «За всё время выходит слишком много…».
    var notice: String?
    var chips: [ShareChip] = []
    var photos: SharePhotosToggle?
    /// Подпись кнопки «Поделиться» для скринридера: «Поделиться перепиской за сегодня».
    var shareAccessibility: String?
    var footnote: String?
    /// Основные строки (жирные имена — RichPiece.bold).
    var lines: [[RichPiece]] = []
    /// Строка с «Ответ ниже ↓» — ссылка на ответ бота.
    var answerLink: String?
    var answerSuffix: String?
    var detail: String?
    /// Показать «Забыть переписку».
    var canForget = false
    var canShare = false
    var canDecline = false
}

enum ShareRules {
    static let periods = ["today", "week", "all"]

    static func title(_ period: String) -> String {
        switch period {
        case "today": return "Сегодня"
        case "week": return "Эта неделя"
        default: return "Всё время"
        }
    }

    /// «за сегодня», «за эту неделю», «за всё время».
    static func phrase(_ period: String) -> String {
        switch period {
        case "today": return "за сегодня"
        case "week": return "за эту неделю"
        default: return "за всё время"
        }
    }

    static func messagesShort(_ n: Int) -> String { "\(RuPlural.grouped(n)) сообщ." }

    static func messagesFull(_ n: Int) -> String {
        "\(RuPlural.grouped(n)) \(RuPlural.pick(n, "сообщение", "сообщения", "сообщений"))"
    }

    static func offText(_ off: String?) -> String? {
        switch off {
        case "too_big": return "слишком много"
        case "budget": return "лимит на сегодня"
        default: return nil
        }
    }

    /// Можно ли выбрать вариант: сервер не погасил и читать есть что.
    static func selectable(_ option: ShareCardData.Option) -> Bool {
        option.enabled && (option.messages > 0 || option.photos > 0)
    }

    /// Выбор по умолчанию: подсказка бота; пустой или погашенный вариант — следующий непустой.
    static func defaultSelection(_ data: ShareCardData) -> ShareSelection? {
        let ordered = periods.compactMap(data.option)
        guard !ordered.isEmpty else { return nil }
        let start = data.suggestPeriod.flatMap { p in ordered.firstIndex { $0.period == p } } ?? 0
        let rotated = Array(ordered[start...]) + Array(ordered[..<start])
        guard let pick = rotated.first(where: selectable) else { return nil }
        // Галка «Включать фото» по умолчанию выключена ВСЕГДА (решение владельца): фото включает человек,
        // а не подсказка модели (suggest.photos — только в данных; сервер и так шлёт false).
        return ShareSelection(period: pick.period, photos: false)
    }

    /// Выбор зрителя, приведённый к тому, что сейчас допустимо (карточку могли вернуть с
    /// погашенным вариантом — тогда выбор откатывается к умолчанию).
    static func effectiveSelection(_ data: ShareCardData, stored: ShareSelection?) -> ShareSelection? {
        guard let stored, let option = data.option(stored.period), selectable(option) else {
            return defaultSelection(data)
        }
        return ShareSelection(period: stored.period, photos: stored.photos && option.photos > 0)
    }

    static func photosCount(_ option: ShareCardData.Option) -> String {
        if option.photos <= 0 { return "(нет фото)" }
        if let used = option.photosUsed, used < option.photos {
            return "(\(RuPlural.grouped(used)) последних из \(RuPlural.grouped(option.photos)))"
        }
        return "(\(RuPlural.grouped(option.photos)))"
    }

    /// «Читаю: 34 сообщения и 3 фото» / «Прочитал …» — сколько и чего.
    static func amount(messages: Int, photos: Int) -> String {
        switch (messages > 0, photos > 0) {
        case (true, true): return "\(messagesFull(messages)) и \(RuPlural.grouped(photos)) фото"
        case (false, true): return "\(RuPlural.grouped(photos)) фото"
        default: return messagesFull(messages)
        }
    }

    /// Сколько минут осталось до срока (вверх, «ещё 1 мин» до самого конца); nil — срок прошёл.
    static func minutesLeft(until: Date?, now: Date) -> Int? {
        guard let until else { return nil }
        let left = until.timeIntervalSince(now)
        guard left > 0 else { return nil }
        return Int((left / 60).rounded(.up))
    }

    static func display(
        card: BotCard, data: ShareCardData, viewerId: String?, now: Date,
        selection stored: ShareSelection? = nil, zone: TimeZone = .current,
        names: [String: String] = [:], fallback: String? = nil
    ) -> ShareDisplay {
        func nameOf(_ person: CardPerson) -> String {
            if let fresh = names[person.id], !fresh.isEmpty { return fresh }
            return person.displayName
        }
        let asker = nameOf(data.asker)
        let available = card.availableActions(viewer: viewerId, now: now)
        let question = "Чтобы ответить, мне нужно почитать переписку этой беседы. Поделиться?"

        switch card.state {
        case "pending" where available.contains("share"):
            var display = ShareDisplay(mode: .choose, question: question)
            let selection = effectiveSelection(data, stored: stored)
            display.chips = periods.compactMap(data.option).map { option in
                let off = offText(option.off)
                let enabled = selectable(option)
                let subtitle = enabled ? messagesShort(option.messages) : (off ?? messagesShort(option.messages))
                let a11y = enabled
                    ? "\(title(option.period)), \(messagesFull(option.messages))"
                    : "\(title(option.period)), недоступно" + (off.map { ": \($0)" } ?? "")
                return ShareChip(
                    period: option.period, title: title(option.period), subtitle: subtitle,
                    enabled: enabled, selected: selection?.period == option.period, accessibilityLabel: a11y
                )
            }
            if let selection, let option = data.option(selection.period) {
                display.photos = SharePhotosToggle(
                    enabled: option.photos > 0, on: selection.photos, count: photosCount(option),
                    accessibilityLabel: option.photos > 0
                        ? "Включать фото, \(RuPlural.grouped(option.photosUsed.map { min($0, option.photos) } ?? option.photos)) фото"
                        : "Включать фото, фото нет"
                )
                display.shareAccessibility = "Поделиться перепиской \(phrase(selection.period))"
            }
            if data.note == "too_big" {
                let tail = "слишком много для моего лимита. Выбери период поменьше."
                if let big = periods.compactMap(data.option).first(where: { $0.off == "too_big" }) {
                    // «за всё время» → «За всё время выходит…»
                    display.notice = "За \(phrase(big.period).dropFirst(3)) выходит \(tail)"
                } else {
                    display.notice = "Выходит \(tail)"
                }
            }
            display.footnote = "Прочитаю только для этого вопроса и уточнений к нему. Через час забуду. Решаешь только ты."
            display.canShare = selection != nil
            display.canDecline = available.contains("decline")
            return display

        case "pending":
            var display = ShareDisplay(mode: .waiting)
            display.lines = [[.plain("Еблуша просит разрешения почитать переписку этой беседы, чтобы ответить.")]]
            var decides: [RichPiece] = [.plain("Решает "), .bold(asker)]
            if let left = minutesLeft(until: card.action("share")?.until, now: now) {
                decides.append(.plain(" · ждём ещё \(left) мин"))
            }
            display.lines.append(decides)
            return display

        case "granted":
            let shared = sharedPhrase(data)
            let answered = data.answerMessageId != nil
            var display = ShareDisplay(mode: answered ? .answered : .reading)
            display.lines = [[.bold(asker), .plain(" поделился перепиской\(shared)")]]
            display.canForget = available.contains("forget")
            if answered {
                display.answerLink = "Ответ ниже ↓"
                display.answerSuffix = minutesLeft(until: data.until, now: now).map { " · доступ ещё \($0) мин" }
                if let read = data.read {
                    display.detail = "Прочитал \(amount(messages: read.messages, photos: read.photos))."
                }
            } else {
                let option = data.choice.flatMap { data.option($0.period) }
                if let option {
                    let photos = data.choice?.photos == true ? (option.photosUsed.map { min($0, option.photos) } ?? option.photos) : 0
                    display.detail = "Читаю: \(amount(messages: option.messages, photos: photos))…"
                } else {
                    display.detail = "Читаю…"
                }
            }
            return display

        default:
            var display = ShareDisplay(mode: .finished)
            display.lines = [finalLine(card: card, data: data, asker: asker, zone: zone, nameOf: nameOf, fallback: fallback)]
            return display
        }
    }

    /// « за сегодня, с фото» — продолжение «Рома поделился перепиской…».
    private static func sharedPhrase(_ data: ShareCardData) -> String {
        guard let choice = data.choice else { return "" }
        return " \(phrase(choice.period))" + (choice.photos ? ", с фото" : "")
    }

    private static func finalLine(
        card: BotCard, data: ShareCardData, asker: String, zone: TimeZone,
        nameOf: (CardPerson) -> String, fallback: String?
    ) -> [RichPiece] {
        let reason = data.endedBy?.reason
        switch card.state {
        case "ended":
            let at = data.endedBy?.at ?? data.until
            let tail = at.map { " Доступ закончился в \(CardTime.hm($0, zone: zone))." } ?? " Доступ закончился."
            return [.bold(asker), .plain(" делился перепиской\(sharedPhrase(data)).\(tail)")]
        case "declined":
            return [.bold(asker), .plain(" не стал делиться перепиской.")]
        case "expired":
            switch reason {
            case "question_deleted": return [.plain("Вопрос удалили — переписку не читаю.")]
            case "replaced": return [.plain("Вопрос сменился — по этой карточке переписку не читаю.")]
            case "asker_left": return [.bold(asker), .plain(" вышел из беседы — переписку не читаю.")]
            default: return [.bold(asker), .plain(" не ответил — переписку не читаю.")]
            }
        case "revoked":
            if reason == "asker_left" { return [.bold(asker), .plain(" вышел из беседы — переписку забыл.")] }
            guard let by = data.endedBy?.by else { return [.plain("Переписка забыта.")] }
            if by.id == data.asker.id { return [.bold(asker), .plain(" забрал разрешение.")] }
            return [.plain("Переписка забыта · попросил "), .bold(nameOf(by)), .plain(".")]
        default:
            // Состояние новее клиента — показываем запасной текст сервера, а не выдумку.
            return [.plain(fallback ?? "Переписка")]
        }
    }
}
