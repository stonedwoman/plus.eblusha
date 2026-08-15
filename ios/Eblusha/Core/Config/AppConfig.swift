import Foundation

/// Порт `core/config/AppConfig.kt`.
///
/// В Android адреса приезжают из `buildConfigField`, здесь — из Info.plist, куда их
/// подставляет конфигурация сборки (см. ios/project.yml). Смысл тот же: debug смотрит
/// на ru.eblusha.org, release — на eblusha.org, и ни один адрес не зашит в код.
enum AppConfig {

    /// База REST API. Всегда заканчивается на «/», иначе относительные пути склеятся неверно.
    static let apiBaseURL: URL = url(for: "EblushaApiBaseURL", fallback: "https://eblusha.org/api/")

    /// Origin для Socket.IO и LiveKit-токенов.
    static let socketBaseURL: URL = url(for: "EblushaWsBaseURL", fallback: "https://eblusha.org")

    private static func url(for key: String, fallback: String) -> URL {
        let raw = (Bundle.main.object(forInfoDictionaryKey: key) as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        // Пустая строка возможна, если подстановка build setting не сработала —
        // в этом случае честнее уехать на прод, чем падать при старте.
        guard let raw, !raw.isEmpty, let parsed = URL(string: raw) else {
            return URL(string: fallback)!
        }
        return parsed
    }
}
