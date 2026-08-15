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

/// «ЧЧ:ММ» по локальному времени (метки в пузырях, «Пропущенный звонок в …»).
func formatClockTime(_ millis: Int64) -> String {
    let formatter = DateFormatter()
    formatter.dateFormat = "HH:mm"
    return formatter.string(from: Date(timeIntervalSince1970: Double(millis) / 1000))
}

/// Веб-паритет: «только что» / «N мин назад» / «N ч назад», полная дата — после суток.
func formatLastSeen(_ millis: Int64) -> String {
    let diffMin = (Int64(Date().timeIntervalSince1970 * 1000) - millis) / 60_000
    switch diffMin {
    case ..<1: return "только что"
    case ..<60: return "\(diffMin) мин назад"
    case ..<(24 * 60): return "\(diffMin / 60) ч назад"
    default:
        let formatter = DateFormatter()
        formatter.dateFormat = "dd.MM.yyyy 'в' HH:mm"
        return formatter.string(from: Date(timeIntervalSince1970: Double(millis) / 1000))
    }
}
