import SwiftUI
import UIKit

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

    // Токены «Центра управления» (Features/Settings): значения — `Themes/Brand.xaml` натива,
    // те же, что у веба и Android. Имена по ролям, а не по оттенкам: светлой темы в приложении
    // нет (RootView: .preferredColorScheme(.dark)), но когда она появится, менять придётся
    // только эти определения.
    static let rail = Color(hex: 0x171A21)         // колонка разделов
    static let field = Color(hex: 0x141820)        // поле ввода, поиск, дорожка сегментов
    static let borderHover = Color(hex: 0x4A5160)  // рамка при нажатии
    /// Мелкий текст, подсказка, плейсхолдер (3,1:1 на плитке — не для смысла). С «Увеличением
    /// контраста» в iOS светлеет до #9AA0A8 (SPEC §5).
    static let textDim = Color(UIColor { traits in
        traits.accessibilityContrast == .high
            ? UIColor(red: 0x9A / 255, green: 0xA0 / 255, blue: 0xA8 / 255, alpha: 1)
            : UIColor(red: 0x6B / 255, green: 0x72 / 255, blue: 0x80 / 255, alpha: 1)
    })
    static let danger = Color(hex: 0xEF4444)       // «!», полоса ошибки, красная кнопка (НЕ `error` #F87171)
    static let dangerHover = Color(hex: 0xDC2626)  // нажатие опасной кнопки
    static let dangerText = Color(hex: 0xFECACA)   // текст ошибки
    static let dangerSoft = Color(hex: 0xFCA5A5)   // опасная текстовая кнопка («Выйти», «Все другие»)
    static let ink = Color(hex: 0x0A0A0A)          // текст на янтаре
    static let ok = Color(hex: 0x86EFAC)           // «Это устройство» (на rgba(34,197,94,.12))
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
