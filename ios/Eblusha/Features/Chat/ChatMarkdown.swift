import SwiftUI

/// Разметка сообщений — порт `ui/chat/ChatMarkdown.kt`.
///
/// До этого на iOS был только поиск голых ссылок, и сообщение, написанное с веба или
/// Android, приезжало сырым текстом: «**важно**», «~~зачёркнуто~~», «`код`». Теперь
/// разбираем тот же набор, что и эталон: блоки (```код```, «> цитата», списки,
/// заголовки) и инлайн (жирный, курсив, зачёркнутый, код, ссылки).
///
/// Результат кэшируется по исходной строке: раньше `NSRegularExpression` и сборка
/// `AttributedString` крутились на КАЖДЫЙ проход тела ячейки, то есть на каждое событие
/// в чате умножалось на число видимых пузырей.
enum ChatMarkdown {

    private static let cache = Mutex<[String: AttributedString]>([:])
    private static let cacheLimit = 400

    static func render(_ text: String) -> AttributedString {
        if let hit = cache.withLock({ $0[text] }) { return hit }
        let value = parse(text)
        cache.withLock { map in
            if map.count >= cacheLimit { map.removeAll() }
            map[text] = value
        }
        return value
    }

    // MARK: - Блоки

    private static func parse(_ text: String) -> AttributedString {
        var out = AttributedString()
        var inCodeBlock = false
        var codeBuffer: [String] = []
        let lines = text.components(separatedBy: "\n")

        func flushCode() {
            guard !codeBuffer.isEmpty else { return }
            var block = AttributedString(codeBuffer.joined(separator: "\n"))
            block.font = .system(.footnote, design: .monospaced)
            block.foregroundColor = Eb.textPrimary
            block.backgroundColor = Color.white.opacity(0.07)
            out += block
            codeBuffer = []
        }

        for (index, line) in lines.enumerated() {
            let trimmed = line.trimmingCharacters(in: .whitespaces)

            if trimmed.hasPrefix("```") {
                if inCodeBlock { flushCode() }
                inCodeBlock.toggle()
                continue
            }
            if inCodeBlock {
                codeBuffer.append(line)
                continue
            }
            if index > 0, !out.characters.isEmpty {
                out += AttributedString("\n")
            }
            out += renderBlockLine(trimmed, raw: line)
        }
        if inCodeBlock { flushCode() }
        return out
    }

    private static func renderBlockLine(_ trimmed: String, raw: String) -> AttributedString {
        // Цитата: «> текст» — приглушённая, с полоской-символом (вертикальной линии в
        // AttributedString нет, эталон рисует её тем же приёмом).
        if trimmed.hasPrefix(">") {
            let body = String(trimmed.dropFirst()).trimmingCharacters(in: .whitespaces)
            var quote = inline(body)
            quote.foregroundColor = Eb.textMuted
            return AttributedString("▎ ") + quote
        }
        // Заголовки «# », «## », «### » — жирным, размер по глубине.
        if trimmed.hasPrefix("#") {
            let hashes = trimmed.prefix { $0 == "#" }.count
            if hashes <= 3, trimmed.count > hashes, trimmed[trimmed.index(trimmed.startIndex, offsetBy: hashes)] == " " {
                let body = String(trimmed.dropFirst(hashes + 1))
                var head = inline(body)
                head.font = .system(hashes == 1 ? .headline : .subheadline, weight: .bold)
                return head
            }
        }
        // Списки «- », «* », «• »
        for marker in ["- ", "* ", "• "] where trimmed.hasPrefix(marker) {
            return AttributedString("•  ") + inline(String(trimmed.dropFirst(marker.count)))
        }
        return inline(raw)
    }

    // MARK: - Инлайн

    /// Один проход по строке: парные маркеры, markdown-ссылки и голые url.
    private static func inline(_ text: String) -> AttributedString {
        var out = AttributedString()
        var plain = ""
        var index = text.startIndex

        func flushPlain() {
            guard !plain.isEmpty else { return }
            out += linkify(plain)
            plain = ""
        }

        while index < text.endIndex {
            let rest = text[index...]

            // [текст](url)
            if rest.first == "[", let link = parseMarkdownLink(rest) {
                flushPlain()
                var piece = styled(link.label)
                if let url = URL(string: link.url) {
                    piece.link = url
                    piece.foregroundColor = chatLinkColor
                    piece.underlineStyle = Text.LineStyle.single
                }
                out += piece
                index = text.index(index, offsetBy: link.length)
                continue
            }

            var matched = false
            for marker in Self.markers where rest.hasPrefix(marker.token) {
                let afterOpen = text.index(index, offsetBy: marker.token.count)
                guard afterOpen < text.endIndex,
                      let closeRange = text.range(of: marker.token, range: afterOpen..<text.endIndex)
                else { continue }
                let body = String(text[afterOpen..<closeRange.lowerBound])
                guard !body.isEmpty else { continue }
                flushPlain()
                out += marker.apply(body)
                index = closeRange.upperBound
                matched = true
                break
            }
            if matched { continue }

            plain.append(text[index])
            index = text.index(after: index)
        }
        flushPlain()
        return out
    }

    /// Парные маркеры в порядке проверки: двойные раньше одинарных, иначе «**» съест «*».
    private static let markers: [InlineMarker] = [
        InlineMarker(token: "**") { body in
            var piece = ChatMarkdown.styled(body)
            piece.inlinePresentationIntent = .stronglyEmphasized
            return piece
        },
        InlineMarker(token: "__") { body in
            var piece = ChatMarkdown.styled(body)
            piece.inlinePresentationIntent = .stronglyEmphasized
            return piece
        },
        InlineMarker(token: "~~") { body in
            var piece = ChatMarkdown.styled(body)
            piece.strikethroughStyle = Text.LineStyle.single
            return piece
        },
        InlineMarker(token: "`") { body in
            var piece = AttributedString(body)
            piece.font = .system(.footnote, design: .monospaced)
            piece.backgroundColor = Color.white.opacity(0.07)
            return piece
        },
        InlineMarker(token: "*") { body in
            var piece = ChatMarkdown.styled(body)
            piece.inlinePresentationIntent = .emphasized
            return piece
        },
        InlineMarker(token: "_") { body in
            var piece = ChatMarkdown.styled(body)
            piece.inlinePresentationIntent = .emphasized
            return piece
        },
    ]

    private struct InlineMarker {
        let token: String
        let apply: (String) -> AttributedString
    }

    /// Вложенная разметка внутри маркера (жирный курсив и т.п.) плюс ссылки.
    fileprivate static func styled(_ body: String) -> AttributedString {
        linkify(body)
    }

    /// Голые url превращаются в ссылки — порт appendLink из ChatMarkdown.kt.
    private static func linkify(_ text: String) -> AttributedString {
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
            if let url = URL(string: urlText) {
                link.link = url
                link.foregroundColor = chatLinkColor
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

    private static func parseMarkdownLink(_ rest: Substring) -> (label: String, url: String, length: Int)? {
        guard rest.first == "[", let labelEnd = rest.firstIndex(of: "]") else { return nil }
        let afterLabel = rest.index(after: labelEnd)
        guard afterLabel < rest.endIndex, rest[afterLabel] == "(",
              let urlEnd = rest[afterLabel...].firstIndex(of: ")")
        else { return nil }
        let label = String(rest[rest.index(after: rest.startIndex)..<labelEnd])
        let url = String(rest[rest.index(after: afterLabel)..<urlEnd])
        guard !label.isEmpty, !url.isEmpty else { return nil }
        return (label, url, rest.distance(from: rest.startIndex, to: urlEnd) + 1)
    }
}
