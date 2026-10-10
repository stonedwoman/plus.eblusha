import Foundation

// «Без звука» для бесед — чистые правила. Порт src/lib/conversationMuteRules.ts сервера
// (контракт — docs/conversation-mute.md). Те же правила и тест-векторы повторяют веб, ПК-натив и
// Android; здесь — iOS (EblushaTests/ConversationMuteTests.swift).
//
// Файл ОБЩИЙ для приложения и Notification Service Extension (project.yml, таргет
// EblushaNotificationService): только Foundation, никаких UIKit/SwiftUI и синглтонов приложения —
// расширению их не затащить (лимит памяти ~24 МБ и свой процесс).
//
// Время — миллисекунды эпохи по часам СЕРВЕРА: `mutedUntil` ставит сервер по своим часам («1 час»
// считается от его now). Где известно смещение часов телефона, сравнивать надо с поправленным now
// (ConversationMuteStore.nowMs).

/// Значение и правило «будить ли».
enum MuteRules {
    /// «Навсегда» — 2100-01-01T00:00:00.000Z (так его пишет сервер).
    static let foreverMs: Int64 = 4_102_444_800_000
    /// С этого момента срок — «навсегда» (2099-12-31T00:00Z): запас на часы, которые сравнивают сами.
    static let foreverFromMs: Int64 = 4_102_358_400_000

    /// Заглушено ли в момент nowMs: until > now (строго). nil — звук включён.
    static func isMuted(untilMs: Int64?, nowMs: Int64) -> Bool {
        guard let untilMs else { return false }
        return untilMs > nowMs
    }

    /// «Навсегда».
    static func isForever(untilMs: Int64?) -> Bool {
        guard let untilMs else { return false }
        return untilMs >= foreverFromMs
    }

    /// Действующий срок: истёкший → nil (сервер ничего не стирает — истечение есть сравнение с now).
    static func effectiveUntil(untilMs: Int64?, nowMs: Int64) -> Int64? {
        isMuted(untilMs: untilMs, nowMs: nowMs) ? untilMs : nil
    }

    /// Системная запись о звонке 1:1, которая пробивает «Без звука»: «Пропущенный звонок» (missed) и
    /// «Звонок продлился…» (ended). «Начал звонок» (started) и записи об участниках — нет.
    static func isCallSystemMessage(type: String?, missed: Bool, ended: Bool) -> Bool {
        type == "SYSTEM" && (missed || ended)
    }

    /// Будить ли получателя этим сообщением (звук в приложении; пуш решает сервер тем же правилом).
    /// Как в Telegram:
    ///  - своё сообщение — нет (эхо сокета);
    ///  - не заглушено — да;
    ///  - группа: ответ на МОЁ сообщение (в т.ч. ответ бота на мой вопрос) или @упоминание меня — да;
    ///  - 1:1, «Чат с Еблушей», секретка: только записи о звонке (звонок 1:1 «Без звука» не глушит);
    ///  - остальное — нет.
    /// «Группа» — только серверный флаг `isGroup`, без эвристик по числу участников: иначе клиент
    /// разошёлся бы с сервером.
    static func shouldAlert(
        untilMs: Int64?,
        nowMs: Int64,
        isGroup: Bool,
        recipientId: String?,
        senderId: String?,
        replyToSenderId: String? = nil,
        callSystem: Bool = false,
        mentionedUserIds: [String] = []
    ) -> Bool {
        if let recipientId, let senderId, senderId == recipientId { return false }
        guard isMuted(untilMs: untilMs, nowMs: nowMs) else { return true }
        if isGroup {
            guard let recipientId, !recipientId.isEmpty else { return false }
            if replyToSenderId == recipientId { return true }
            if mentionedUserIds.contains(recipientId) { return true }
            return false
        }
        return callSystem
    }

    /// Ближайший неистёкший срок, не «навсегда» — по нему ставится ОДИН таймер истечения.
    static func nextExpiry(_ untils: [Int64?], nowMs: Int64) -> Int64? {
        untils.compactMap { $0 }
            .filter { $0 > nowMs && !isForever(untilMs: $0) }
            .min()
    }

    /// Общий счётчик (значок приложения): сумма непрочитанного по НЕзаглушённым беседам.
    static func totalUnread(_ items: [(unread: Int, untilMs: Int64?)], nowMs: Int64) -> Int {
        items.reduce(0) { sum, item in
            isMuted(untilMs: item.untilMs, nowMs: nowMs) ? sum : sum + max(0, item.unread)
        }
    }
}

/// Сроки «Без звука». Клиент шлёт серверу пресет (`{for: "1h"}`), а не момент: срок считается по
/// часам сервера, и неверные часы телефона не превратят «1 час» в «0 минут».
enum MutePreset: String, CaseIterable, Identifiable {
    case hour = "1h"
    case eightHours = "8h"
    case day = "1d"
    case week = "1w"
    case forever = "forever"

    var id: String { rawValue }

    /// Вариант в подменю и в листе выбора срока.
    var title: String {
        switch self {
        case .hour: return "1 час"
        case .eightHours: return "8 часов"
        case .day: return "1 день"
        case .week: return "1 неделю"
        case .forever: return "Навсегда"
        }
    }

    /// Подтверждение после действия.
    var doneText: String {
        switch self {
        case .forever: return "Без звука навсегда"
        default: return "Без звука на \(title)"
        }
    }

    /// Длительность по часам сервера (для тестов и подсказок); у «Навсегда» — nil.
    var durationMs: Int64? {
        switch self {
        case .hour: return 3_600_000
        case .eightHours: return 28_800_000
        case .day: return 86_400_000
        case .week: return 604_800_000
        case .forever: return nil
        }
    }
}

/// Подписи — одинаковые на всех платформах (docs/conversation-mute.md §7).
enum MuteText {
    /// Пункт меню незаглушённой беседы; он же доступное имя значка.
    static let mute = "Без звука"
    /// Пункт меню заглушённой беседы.
    static let unmute = "Включить звук"
    /// Короткая подпись свайпа «включить звук» (полная в свайп не помещается).
    static let unmuteShort = "Звук"
    /// Заголовок листа выбора срока.
    static let pickerTitle = "Без звука на…"
    static let cancel = "Отмена"
    static let unmuted = "Звук включён"
    static let failed = "Не удалось изменить звук беседы"

    /// Короткие месяцы в родительном падеже — ровно как в контракте (у DateFormatter ru «июн.»/«июл.»).
    static let months = ["янв.", "февр.", "мар.", "апр.", "мая", "июня", "июля", "авг.", "сент.", "окт.", "нояб.", "дек."]

    /// Срок по местному времени устройства: «до 18:30» / «до завтра, 18:30» / «до 14 окт., 18:30» /
    /// «до 14 окт. 2027, 18:30» / «навсегда».
    static func until(_ untilMs: Int64, now: Date, timeZone: TimeZone = .current) -> String {
        if MuteRules.isForever(untilMs: untilMs) { return "навсегда" }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let date = Date(timeIntervalSince1970: Double(untilMs) / 1000)
        let parts = calendar.dateComponents([.year, .month, .day, .hour, .minute], from: date)
        let time = String(format: "%02d:%02d", parts.hour ?? 0, parts.minute ?? 0)
        if calendar.isDate(date, inSameDayAs: now) { return "до \(time)" }
        if let tomorrow = calendar.date(byAdding: .day, value: 1, to: now),
           calendar.isDate(date, inSameDayAs: tomorrow) {
            return "до завтра, \(time)"
        }
        let month = months[max(0, min(11, (parts.month ?? 1) - 1))]
        let day = parts.day ?? 1
        if calendar.component(.year, from: now) == parts.year {
            return "до \(day) \(month), \(time)"
        }
        return "до \(day) \(month) \(parts.year ?? 0), \(time)"
    }

    /// Подсказка значка: «Без звука до 18:30» / «Без звука навсегда».
    static func tip(_ untilMs: Int64, now: Date, timeZone: TimeZone = .current) -> String {
        "\(mute) \(until(untilMs, now: now, timeZone: timeZone))"
    }
}
