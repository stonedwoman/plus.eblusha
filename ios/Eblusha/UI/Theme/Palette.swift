import SwiftUI

// Порт `ui/theme/Color.kt` из eblusha-mobile. Те же дизайн-токены из веб-приложения
// (frontend/src/style.css :root) — это источник правды, компоненты берут их напрямую.
enum Eb {
    static let brand = Color(hex: 0xD97706)        // --brand (основной оранжевый)
    static let brand600 = Color(hex: 0xE38B0A)     // --brand-600 (hover / светлее)
    static let brand700 = Color(hex: 0xB45309)     // --brand-700 (active / темнее)

    static let paper = Color(hex: 0x0F1217)        // --paper (фон приложения)
    static let surface100 = Color(hex: 0x1B1F27)   // --surface-100 (поля ввода, вторичные кнопки)
    static let surface200 = Color(hex: 0x232731)   // --surface-200 (панели, плитки, бары)
    static let surface300 = Color(hex: 0x2B303A)   // --surface-300 (приподнятое / hover)
    static let border = Color(hex: 0x313643)       // --surface-border (тонкий разделитель)
    static let borderStrong = Color(hex: 0x3B414F) // --surface-border-strong (кант плиток)

    static let textPrimary = Color(hex: 0xF1F3F6)  // --text-primary
    static let textMuted = Color(hex: 0x9AA0A8)    // --text-muted

    static let bubbleIn = Color(hex: 0x191D23)     // пузырь входящего сообщения
    static let bubbleOut = Color(hex: 0x303845)    // пузырь исходящего (серый, НЕ оранжевый)

    static let online = Color(hex: 0x22C55E)       // презенс «в сети»
    static let presenceBg = Color(hex: 0xFACC15)   // презенс «в фоне» (веб BACKGROUND)
    static let away = Color(hex: 0xF59E0B)         // презенс «не активен» (веб AWAY)
    static let offline = Color(hex: 0x6B7280)      // презенс оффлайн
    static let error = Color(hex: 0xF87171)        // красный ошибок

    static let logoCream = Color(hex: 0xF4E8C9)    // логотип «Еблуша»
    static let logoB = Color(hex: 0xE25C2A)        // перевёрнутая «Б»
}

/// Порт шкалы отступов (`ui/theme/Spacing`-аналог). Приложение всегда тёмное —
/// как Android-клиент, где EblushaTheme не имеет светлой ветки.
enum Spacing {
    static let xs: CGFloat = 4
    static let sm: CGFloat = 8
    static let md: CGFloat = 12
    static let lg: CGFloat = 16
    static let xl: CGFloat = 24
    static let xxl: CGFloat = 32
}

extension Color {
    /// 0xRRGGBB — как Color(0xFFRRGGBB) в Compose, только без альфы в литерале.
    init(hex: UInt32, opacity: Double = 1) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: opacity
        )
    }
}
