import Foundation

// Порт `core/util/Time*.kt` — разбор ISO-времени бэкенда и форматирование.

private let isoWithFraction: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
}()
private let isoPlain = ISO8601DateFormatter()

/// ISO-строка бэкенда → миллисекунды эпохи; nil, если строка кривая.
func parseIsoToMillis(_ iso: String?) -> Int64? {
    guard let iso, !iso.isEmpty else { return nil }
    let date = isoWithFraction.date(from: iso) ?? isoPlain.date(from: iso)
    return date.map { Int64($0.timeIntervalSince1970 * 1000) }
}

func millisToIso(_ millis: Int64) -> String {
    isoWithFraction.string(from: Date(timeIntervalSince1970: Double(millis) / 1000))
}

// Форматтеры создаются ОДИН раз: DateFormatter стоит дорого, а время стоит под каждым
// сообщением — в ленте это был постоянный налог на плавность прокрутки.
// timeZone — autoupdatingCurrent: иначе после перелёта время под сообщениями осталось бы
// в старом поясе до перезапуска. Локаль POSIX — чтобы «HH:mm» не превращалось в AM/PM
// при 12-часовых региональных настройках.
private let clockFormatter: DateFormatter = {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.timeZone = TimeZone.autoupdatingCurrent
    f.dateFormat = "HH:mm"
    return f
}()
private let fullDateFormatter: DateFormatter = {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.timeZone = TimeZone.autoupdatingCurrent
    f.dateFormat = "dd.MM.yyyy 'в' HH:mm"
    return f
}()
private let dayFormatter: DateFormatter = {
    let f = DateFormatter()
    f.dateFormat = "d MMMM"
    f.locale = Locale(identifier: "ru_RU")
    f.timeZone = TimeZone.autoupdatingCurrent
    return f
}()

/// «ЧЧ:ММ» по локальному времени (метки в пузырях, «Пропущенный звонок в …»).
func formatClockTime(_ millis: Int64) -> String {
    clockFormatter.string(from: Date(timeIntervalSince1970: Double(millis) / 1000))
}

/// День сообщения для разделителя в ленте: «Сегодня» / «Вчера» / «7 сентября».
func formatMessageDay(_ millis: Int64) -> String {
    let date = Date(timeIntervalSince1970: Double(millis) / 1000)
    let calendar = Calendar.current
    if calendar.isDateInToday(date) { return "Сегодня" }
    if calendar.isDateInYesterday(date) { return "Вчера" }
    return dayFormatter.string(from: date)
}

/// Номер дня эпохи по местному времени — по нему лента решает, где ставить разделитель.
func localDayIndex(_ millis: Int64) -> Int {
    let date = Date(timeIntervalSince1970: Double(millis) / 1000)
    return Calendar.current.ordinality(of: .day, in: .era, for: date) ?? 0
}

/// Веб-паритет: «только что» / «N мин назад» / «N ч назад», полная дата — после суток.
func formatLastSeen(_ millis: Int64) -> String {
    let diffMin = (Int64(Date().timeIntervalSince1970 * 1000) - millis) / 60_000
    switch diffMin {
    case ..<1: return "только что"
    case ..<60: return "\(diffMin) мин назад"
    case ..<(24 * 60): return "\(diffMin / 60) ч назад"
    default:
        return fullDateFormatter.string(from: Date(timeIntervalSince1970: Double(millis) / 1000))
    }
}
