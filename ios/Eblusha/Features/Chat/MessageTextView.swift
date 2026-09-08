import Foundation
import SwiftUI

// Текст TEXT-пузыря. Сам разбор разметки живёт в ChatMarkdown.swift (порт
// `ui/chat/ChatMarkdown.kt`) и кэшируется по строке; здесь остаются только стили.
//
// Ссылка открывается системным переходом в браузер — то же, что LinkAnnotation.Url
// в Compose: Text с AttributedString.link уходит в стандартный openURL окружения.

/// Цвет ссылок. Токена accentSky в палитре нет (и не было в Kotlin/веб-токенах) —
/// эталон красит ссылки brand-bright (ChatMarkdown.kt: LinkColor = 0xFFE38B0A,
/// «ссылки как в вебе»), это ровно Eb.brand600.
let chatLinkColor = Eb.brand600

/// Регекс URL — копия URL_REGEX из ChatMarkdown.kt: жадный захват без хвостовой
/// пунктуации (последний символ не из закрывающего набора).
let chatUrlRegex = try! NSRegularExpression(
    pattern: #"https?://[^\s<>()\[\]]+[^\s<>()\[\].,;:!?'"«»]"#,
    options: [.caseInsensitive]
)

/// Текст сообщения с кликабельными ссылками (замена «глухого» Text(content) в
/// MessageRow.bubble). Стили (font/цвет для deleted) те же, что были у Text.
struct MessageTextView: View {
    let content: String
    var deleted: Bool = false

    var body: some View {
        Text(ChatMarkdown.render(content))
            .font(deleted ? .subheadline.italic() : .subheadline)
            .foregroundStyle(deleted ? Eb.textMuted : Eb.textPrimary)
            .tint(chatLinkColor)
            // .textSelection здесь НЕЛЬЗЯ: системное выделение перехватывает тап и долгое
            // нажатие, а на них висят единственные способы управления строкой —
            // контекстное меню (реакции, ответ, пересылка) и выбор сообщений.
            // Копирование живёт в контекстном меню.
    }
}
