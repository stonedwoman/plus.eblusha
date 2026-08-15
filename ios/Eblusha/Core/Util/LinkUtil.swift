import Foundation

// Порт `core/util/LinkUtil.kt`.

private let urlRegex = try! NSRegularExpression(
    pattern: #"https?://[^\s<>()\[\]{}"']+"#,
    options: [.caseInsensitive]
)

/// Первый http(s)-URL в тексте (без хвостовой пунктуации) или nil.
/// Превьюшность URL решает сервер; здесь только гейт запроса.
func extractFirstUrl(_ text: String?) -> String? {
    guard let text, !text.isEmpty else { return nil }
    guard let match = urlRegex.firstMatch(
        in: text, range: NSRange(text.startIndex..., in: text)
    ), let range = Range(match.range, in: text) else { return nil }
    let cleaned = String(text[range]).replacingOccurrences(
        of: #"[)\]}.,!?;:]+$"#, with: "", options: .regularExpression
    )
    return cleaned.isEmpty ? nil : cleaned
}
