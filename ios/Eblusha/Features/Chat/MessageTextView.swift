import Foundation
import SwiftUI

// Мини-порт линкования из `ui/chat/ChatMarkdown.kt` (appendLink + URL_REGEX): текст
// TEXT-пузыря с кликабельными http(s)-ссылками. Полный маркдаун (жирный/курсив/код/
// таблицы) — отдельной фазой; здесь только ссылки, самый частый кейс.
//
// Ссылка открывается системным переходом в браузер — то же, что LinkAnnotation.Url
// в Compose: Text с AttributedString.link уходит в стандартный openURL окружения.

/// Цвет ссылок. Токена accentSky в палитре нет (и не было в Kotlin/веб-токенах) —
/// эталон красит ссылки brand-bright (ChatMarkdown.kt: LinkColor = 0xFFE38B0A,
/// «ссылки как в вебе»), это ровно Eb.brand600.
private let chatLinkColor = Eb.brand600

/// Регекс URL — копия URL_REGEX из ChatMarkdown.kt: жадный захват без хвостовой
/// пунктуации (последний символ не из закрывающего набора).
private let chatUrlRegex = try! NSRegularExpression(
    pattern: #"https?://[^\s<>()\[\]]+[^\s<>()\[\].,;:!?'"«»]"#,
    options: [.caseInsensitive]
)

/// Текст сообщения с кликабельными ссылками (замена «глухого» Text(content) в
/// MessageRow.bubble). Стили (font/цвет для deleted) те же, что были у Text.
struct MessageTextView: View {
    let content: String
    var deleted: Bool = false

    var body: some View {
        Text(linkified)
            .font(deleted ? .subheadline.italic() : .subheadline)
            .foregroundStyle(deleted ? Eb.textMuted : Eb.textPrimary)
            .tint(chatLinkColor)
    }

    /// Порт appendInline-ветки голых url: текст режется на прогоны «обычный/ссылка»,
    /// ссылки получают .link + цвет + подчёркивание (LINK_STYLES из ChatMarkdown.kt).
    private var linkified: AttributedString {
        let text = content
        var out = AttributedString()
        var cursor = text.startIndex
        let fullRange = NSRange(text.startIndex..., in: text)
        for match in chatUrlRegex.matches(in: text, range: fullRange) {
            guard let range = Range(match.range, in: text) else { continue }
            if cursor < range.lowerBound {
                out += AttributedString(String(text[cursor..<range.lowerBound]))
            }
            let urlText = String(text[range])
            var link = AttributedString(urlText)
            // iOS 17+: URL(string:) сам процентно кодирует кириллицу/пробелы в пути —
            // кривой остаток просто остаётся некликабельным текстом (не падаем).
            if let url = URL(string: urlText) {
                link.link = url
                link.foregroundColor = chatLinkColor
                // Тип явно: `.single` есть и у NSUnderlineStyle (UIKit-скоуп), и у
                // Text.LineStyle (SwiftUI) — без типа компилятор видит неоднозначность.
                link.underlineStyle = Text.LineStyle.single
            }
            out += link
            cursor = range.upperBound
        }
        if cursor < text.endIndex {
            out += AttributedString(String(text[cursor...]))
        }
        return out
    }
}
