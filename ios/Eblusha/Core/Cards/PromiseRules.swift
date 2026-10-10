import Foundation

// Таймер обещания («Еблуша, проконтролируй», scratchpad/promise-timer/SPEC.md). Здесь — данные
// карточки (`metadata.card.data` типа `promise`) и чистые правила вида: что зритель видит
// сейчас. Вью (PromiseCardView) только рисует то, что посчитано здесь, — поэтому правила
// проверяются тестами на тех же случаях, что у веба/натива/Android (SPEC.md §14), а не глазами.

struct PromiseCardData: Equatable {
    struct Quote: Equatable {
        var messageId: String?
        var text: String?
        var at: Date?
        /// «со слов Ромы»: цитата не обещавшего, а того, кто попросил (строка или человек).
        var by: String?
        var deleted = false
    }

    struct Extension: Equatable {
        var at: Date?
        var from: Date?
        var to: Date?
        var label: String?
    }

    struct Outcome: Equatable {
        /// onTime (deltaSec ≤ 0) | late (deltaSec > 0)
        var kind: String
        var arrivedAt: Date?
        /// arrivedAt − deadlineAt, секунды (< 0 — запас).
        var deltaSec: Int
        /// От первого срока (если продлевал).
        var deltaVsOriginalSec: Int?
        /// button | self | call | valheim | phrase
        var via: String?
        /// Кто отметил (button/phrase).
        var by: CardPerson?
    }

    let promiser: CardPerson
    var requester: CardPerson?
    var quote: Quote?
    var label: String
    var upperBound = false
    let startAt: Date
    let deadlineAt: Date
    var originalDeadlineAt: Date?
    var extensions: [Extension] = []
    /// Пояс обещавшего — только если он показывает своё местное время (иначе null).
    var promiserZone: String?
    var closedAt: Date?
    var outcome: Outcome?
    var cancelledBy: CardPerson?

    static func parse(_ json: JSONValue?) -> PromiseCardData? {
        guard let json,
              let promiser = CardPerson.parse(json["promiser"]),
              let deadline = json["deadlineAt"]?.dateValue
        else { return nil }
        // Начало кольца позже срока не бывает; без него кольцо считаем от срока минус минута.
        var start = json["startAt"]?.dateValue ?? deadline.addingTimeInterval(-60)
        if start >= deadline { start = deadline.addingTimeInterval(-1) }

        var quote: Quote?
        if let q = json["quote"], case .object = q {
            let byValue = q["by"]
            let by = byValue?.stringValue ?? CardPerson.parse(byValue)?.displayName
            quote = Quote(
                messageId: q["messageId"]?.stringValue,
                text: q["text"]?.stringValue,
                at: q["at"]?.dateValue,
                by: by.flatMap { $0.isEmpty ? nil : $0 },
                deleted: q["deleted"]?.boolValue ?? false
            )
        }
        var outcome: Outcome?
        if let o = json["outcome"], case .object = o, let kind = o["kind"]?.stringValue {
            outcome = Outcome(
                kind: kind,
                arrivedAt: o["arrivedAt"]?.dateValue,
                deltaSec: o["deltaSec"]?.intValue ?? 0,
                deltaVsOriginalSec: o["deltaVsOriginalSec"]?.intValue,
                via: o["via"]?.stringValue,
                by: CardPerson.parse(o["by"])
            )
        }
        let extensions = json["extensions"]?.arrayValue?.map { e in
            Extension(at: e["at"]?.dateValue, from: e["from"]?.dateValue, to: e["to"]?.dateValue,
                      label: e["label"]?.stringValue)
        } ?? []
        return PromiseCardData(
            promiser: promiser,
            requester: CardPerson.parse(json["requester"]),
            quote: quote,
            label: json["label"]?.stringValue ?? "",
            upperBound: json["upperBound"]?.boolValue ?? false,
            startAt: start,
            deadlineAt: deadline,
            originalDeadlineAt: json["originalDeadlineAt"]?.dateValue,
            extensions: extensions,
            promiserZone: json["promiserZone"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 },
            closedAt: json["closedAt"]?.dateValue,
            outcome: outcome,
            cancelledBy: CardPerson.parse(json["cancelledBy"])
        )
    }
}

/// Вид карточки по времени (SPEC.md §4.3).
enum PromiseView: String {
    case running      // идёт
    case lastMinute = "final"  // последние 60 с
    case late         // опаздывает, счёт вверх
    case onTime       // пришёл вовремя
    case lateArrived  // опоздал
    case cancelled
    case unresolved   // никто не отметил приход
}

/// Всё, что рисует карточка таймера, — уже строками.
struct PromiseDisplay: Equatable {
    var view: PromiseView
    /// «попросил Рома»
    var requesterLine: String?
    var name: String
    /// «15мин» в кавычках «» или «(сообщение удалено)».
    var quote: String
    /// «обещал в 14:00»
    var promisedAt: String?
    /// «по местному 21:00» — срок в поясе обещавшего, если его смещение ≠ смещению зрителя.
    var localTime: String?
    /// «продлевал 1 раз»
    var extensionsChip: String?
    /// Крупно: «12:47», «1:12:47», «+03:12», «✓ 14:12», «+7 мин», «—», «?».
    var digits: String
    /// Под цифрами: «осталось», «последняя минута!», «опаздывает», «Таймер отменён · …».
    var caption: String?
    /// Итог прихода: «Пришёл вовремя, запас 3 мин» / «Опоздал на 7 мин».
    var result: String?
    /// Способ и продления: «зашёл в звонок · продлевал 1 раз · от первого срока +17 мин».
    var resultDetail: String?
    /// Справа: «до 14:15», «обещал к 14:15», «срок 14:15», «срок был 14:15».
    var until: String
    var label: String
    /// Оставшаяся доля кольца 0…1 (у закрытых и опоздавших — полное кольцо).
    var progress: Double
    /// Полный срок ≥ часа: отсчёт сразу в виде ч:мм:сс (без сдвига раскладки на границе часа).
    var withHours: Bool
    /// Кнопки зрителя: arrived | cancel | reopen.
    var buttons: [String]
    /// Имя карточки для скринридера — меняется раз в минуту, а не каждую секунду.
    var accessibilityLabel: String
}

enum PromiseRules {

    static func view(state: String, data: PromiseCardData, now: Date) -> PromiseView {
        switch state {
        case "arrived":
            return data.outcome?.kind == "late" || (data.outcome?.deltaSec ?? 0) > 0 ? .lateArrived : .onTime
        case "cancelled":
            return .cancelled
        case "unresolved":
            return .unresolved
        default:
            let left = data.deadlineAt.timeIntervalSince(now)
            if left <= 0 { return .late }
            return left <= 60 ? .lastMinute : .running
        }
    }

    /// Отсчёт: мм:сс до часа, ч:мм:сс от часа (или всегда, если полный срок ≥ часа).
    static func countdown(_ seconds: Int, withHours: Bool) -> String {
        let sec = max(0, seconds)
        let h = sec / 3600, m = (sec % 3600) / 60, s = sec % 60
        if withHours || h > 0 { return "\(h):\(pad(m)):\(pad(s))" }
        return "\(pad(m)):\(pad(s))"
    }

    /// Длительность словами: «42 с», «7 мин», «1 ч», «1 ч 12 мин».
    static func duration(_ seconds: Int) -> String {
        let sec = abs(seconds)
        if sec < 60 { return "\(sec) с" }
        let h = sec / 3600, m = (sec % 3600) / 60
        if h > 0 { return m > 0 ? "\(h) ч \(m) мин" : "\(h) ч" }
        return "\(m) мин"
    }

    /// Итог прихода (SPEC.md §10.1 «Формулировки итога»).
    static func resultText(_ outcome: PromiseCardData.Outcome) -> String {
        if outcome.kind == "late" || outcome.deltaSec > 0 {
            return "Опоздал на \(duration(outcome.deltaSec))"
        }
        let spare = -outcome.deltaSec
        if spare < 1 { return "Секунда в секунду" }
        if spare < 60 { return "Пришёл вовремя, запас меньше минуты" }
        return "Пришёл вовремя, запас \(duration(spare))"
    }

    static func viaText(_ outcome: PromiseCardData.Outcome) -> String? {
        switch outcome.via {
        case "call": return "зашёл в звонок"
        case "valheim": return "зашёл в Valheim"
        case "self": return "отметил сам"
        case "button", "phrase": return outcome.by.map { "отметил \($0.displayName)" } ?? "отметили"
        default: return nil
        }
    }

    /// «продлевал 1 раз / 2 раза / 5 раз».
    static func extensionsText(_ count: Int) -> String? {
        guard count > 0 else { return nil }
        return "продлевал \(count) \(RuPlural.pick(count, "раз", "раза", "раз"))"
    }

    /// «14:15» сегодня, «завтра, 02:00», дальше — «13 окт., 02:00» (время зрителя).
    static func dayAndTime(_ date: Date, now: Date, zone: TimeZone) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        let time = CardTime.hm(date, zone: zone)
        if calendar.isDate(date, inSameDayAs: now) { return time }
        if let tomorrow = calendar.date(byAdding: .day, value: 1, to: now),
           calendar.isDate(date, inSameDayAs: tomorrow) {
            return "завтра, \(time)"
        }
        return "\(CardTime.dayMonth(date, zone: zone)), \(time)"
    }

    static func display(
        card: BotCard, data: PromiseCardData, viewerId: String?, now: Date,
        zone: TimeZone = .current, names: [String: String] = [:]
    ) -> PromiseDisplay {
        let view = Self.view(state: card.state, data: data, now: now)
        let deadline = data.deadlineAt
        // Имя — из свежего кэша беседы, снимок сервера — запасной (SPEC.md §4.2).
        func nameOf(_ person: CardPerson) -> String {
            if let fresh = names[person.id], !fresh.isEmpty { return fresh }
            return person.displayName
        }
        let name = nameOf(data.promiser)
        let withHours = deadline.timeIntervalSince(data.startAt) >= 3600
        let deadlineHM = CardTime.hm(deadline, zone: zone)

        var display = PromiseDisplay(
            view: view,
            requesterLine: data.requester.map { "попросил \(nameOf($0))" },
            name: name,
            quote: quoteText(data.quote),
            promisedAt: (data.quote?.at).map { "обещал в \(CardTime.hm($0, zone: zone))" },
            localTime: localTimeText(data, zone: zone),
            extensionsChip: extensionsText(data.extensions.count),
            digits: "",
            caption: nil,
            result: nil,
            resultDetail: nil,
            until: "",
            label: data.label,
            progress: 1,
            withHours: withHours,
            buttons: card.availableActions(viewer: viewerId, now: now)
                .filter { ["arrived", "cancel", "reopen"].contains($0) },
            accessibilityLabel: ""
        )

        let a11yState: String
        switch view {
        case .running, .lastMinute:
            let left = deadline.timeIntervalSince(now)
            display.digits = countdown(Int(left.rounded(.up)), withHours: withHours)
            display.caption = view == .lastMinute ? "последняя минута!" : "осталось"
            display.until = "до \(dayAndTime(deadline, now: now, zone: zone))"
            let total = deadline.timeIntervalSince(data.startAt)
            display.progress = total > 0 ? min(1, max(0, left / total)) : 0
            let minutes = Int(left / 60)
            a11yState = minutes >= 1
                ? "осталось \(minutes) \(RuPlural.pick(minutes, "минута", "минуты", "минут"))"
                : "осталось меньше минуты"
        case .late:
            // Ровно в срок — уже «+00:00», а не «00:00» две секунды подряд.
            let late = Int(now.timeIntervalSince(deadline).rounded(.down))
            display.digits = "+" + countdown(late, withHours: false)
            display.caption = "опаздывает"
            display.until = "обещал к \(deadlineHM)"
            a11yState = "опаздывает на \(duration(late))"
        case .onTime, .lateArrived:
            let outcome = data.outcome ?? PromiseCardData.Outcome(kind: view == .onTime ? "onTime" : "late", deltaSec: 0)
            if view == .onTime {
                display.digits = "✓ " + (outcome.arrivedAt.map { CardTime.hm($0, zone: zone) } ?? deadlineHM)
            } else {
                display.digits = "+" + duration(outcome.deltaSec)
            }
            display.result = resultText(outcome)
            var detail: [String] = []
            if let via = viaText(outcome) { detail.append(via) }
            if let ext = extensionsText(data.extensions.count) {
                detail.append(ext)
                if let vs = outcome.deltaVsOriginalSec, vs != outcome.deltaSec, vs > 0 {
                    detail.append("от первого срока +\(duration(vs))")
                }
            }
            display.resultDetail = detail.isEmpty ? nil : detail.joined(separator: " · ")
            display.until = "срок \(deadlineHM)"
            a11yState = resultText(outcome)
        case .cancelled:
            display.digits = "—"
            let by = data.cancelledBy.map { " · отменил \(nameOf($0))" } ?? ""
            display.caption = "Таймер отменён\(by)"
            display.until = "срок был \(deadlineHM)"
            a11yState = "таймер отменён"
        case .unresolved:
            display.digits = "?"
            display.caption = "Никто не отметил приход"
            display.until = "срок был \(deadlineHM)"
            a11yState = "никто не отметил приход"
        }
        let quotePart = data.quote?.text.map { " обещал «\($0)»," } ?? ""
        display.accessibilityLabel = "Таймер: \(name)\(quotePart) до \(deadlineHM), \(a11yState)"
        return display
    }

    /// Что сказать скринридеру при смене вида (вежливая живая область, SPEC.md §10.4).
    static func announcement(from old: PromiseView?, to new: PromiseView, data: PromiseCardData, name: String) -> String? {
        guard let old, old != new else { return nil }
        switch new {
        case .lastMinute: return "Осталась минута"
        case .late: return "\(name) опаздывает"
        case .onTime, .lateArrived: return data.outcome.map(resultText)
        case .cancelled: return "Таймер отменён"
        case .unresolved: return "Никто не отметил приход"
        case .running: return nil
        }
    }

    // MARK: Оптимистичный вид (SPEC.md §10.5)

    /// Карточка сразу в целевом виде, пока летит запрос: `rev` прежний, так что ответ сервера
    /// (или событие) с большим `rev` её заменит, а сбой вернёт подтверждённую.
    static func optimistic(card: BotCard, data: PromiseCardData, action: String,
                           viewer: CardPerson?, now: Date) -> BotCard? {
        var next = data
        let reopen = { (until: Date) -> [BotCardAction] in
            guard let viewer else { return [] }
            return [BotCardAction(id: "reopen", anyone: false, ids: [viewer.id], until: until)]
        }
        switch action {
        case "arrived":
            let delta = Int(now.timeIntervalSince(data.deadlineAt).rounded())
            let original = data.originalDeadlineAt ?? data.deadlineAt
            let isSelf = viewer?.id == data.promiser.id
            next.closedAt = now
            next.outcome = PromiseCardData.Outcome(
                kind: delta > 0 ? "late" : "onTime", arrivedAt: now, deltaSec: delta,
                deltaVsOriginalSec: Int(now.timeIntervalSince(original).rounded()),
                via: isSelf ? "self" : "button", by: isSelf ? nil : viewer
            )
            return card.copy(state: "arrived", closed: true, actions: reopen(now.addingTimeInterval(120)),
                             payload: .promise(next))
        case "cancel":
            next.closedAt = now
            next.cancelledBy = viewer
            return card.copy(state: "cancelled", closed: true, actions: reopen(now.addingTimeInterval(120)),
                             payload: .promise(next))
        case "reopen":
            next.closedAt = nil
            next.outcome = nil
            next.cancelledBy = nil
            return card.copy(state: "running", closed: false, actions: [], payload: .promise(next))
        default:
            return nil
        }
    }

    // MARK: Внутреннее

    private static func pad(_ n: Int) -> String { n < 10 ? "0\(n)" : "\(n)" }

    private static func quoteText(_ quote: PromiseCardData.Quote?) -> String {
        guard let quote else { return "" }
        guard !quote.deleted, let text = quote.text, !text.isEmpty else { return "(сообщение удалено)" }
        let base = "«\(text)»"
        return quote.by.map { "\(base) · со слов: \($0)" } ?? base
    }

    /// «по местному 21:00» — если обещавший показывает время и его пояс сейчас другой.
    private static func localTimeText(_ data: PromiseCardData, zone: TimeZone) -> String? {
        guard let id = data.promiserZone, let theirs = TimeZone(identifier: id) else { return nil }
        let at = data.deadlineAt
        guard theirs.secondsFromGMT(for: at) != zone.secondsFromGMT(for: at) else { return nil }
        return "по местному \(CardTime.hm(at, zone: theirs))"
    }
}

// MARK: - Общее для карточек: время и склонение чисел

enum CardTime {
    private static var hmCache: [String: DateFormatter] = [:]
    private static var dmCache: [String: DateFormatter] = [:]
    private static let lock = NSLock()

    /// «ЧЧ:ММ» в данном поясе (24 часа при любых региональных настройках).
    static func hm(_ date: Date, zone: TimeZone = .current) -> String {
        formatter(&hmCache, zone: zone, format: "HH:mm", locale: "en_US_POSIX").string(from: date)
    }

    /// «13 окт.» в данном поясе.
    static func dayMonth(_ date: Date, zone: TimeZone = .current) -> String {
        formatter(&dmCache, zone: zone, format: "d MMM", locale: "ru_RU").string(from: date)
    }

    private static func formatter(_ cache: inout [String: DateFormatter], zone: TimeZone,
                                  format: String, locale: String) -> DateFormatter {
        lock.lock()
        defer { lock.unlock() }
        if let known = cache[zone.identifier] { return known }
        let f = DateFormatter()
        f.locale = Locale(identifier: locale)
        f.timeZone = zone
        f.dateFormat = format
        cache[zone.identifier] = f
        return f
    }
}

enum RuPlural {
    /// 1 сообщение, 2 сообщения, 5 сообщений (11–14 — всегда «многие»).
    static func pick(_ n: Int, _ one: String, _ few: String, _ many: String) -> String {
        let n = abs(n)
        let mod100 = n % 100, mod10 = n % 10
        if (11...14).contains(mod100) { return many }
        if mod10 == 1 { return one }
        if (2...4).contains(mod10) { return few }
        return many
    }

    /// «1 738» — разряды через неразрывный пробел (как в макетах).
    static func grouped(_ n: Int) -> String {
        let digits = String(abs(n))
        var out = ""
        for (i, ch) in digits.enumerated() {
            if i > 0, (digits.count - i) % 3 == 0 { out.append("\u{00A0}") }
            out.append(ch)
        }
        return n < 0 ? "-" + out : out
    }
}
