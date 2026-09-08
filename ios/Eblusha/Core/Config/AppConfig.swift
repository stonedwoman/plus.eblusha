import Foundation

/// Адреса бэкенда.
///
/// Раньше адрес приезжал только из конфигурации сборки (debug → ru.eblusha.org,
/// release → eblusha.org) и менялся лишь пересборкой. Теперь источник выбирается в
/// настройках прямо на устройстве: одна и та же сборка ходит и в основной, и в
/// зеркальный контур.
///
/// Смена источника — это смена мира: токены сессии, идентификатор устройства и ключи
/// секретных чатов принадлежат конкретному серверу. Поэтому переключение выполняется
/// только через выход из аккаунта (см. настройки).
enum AppConfig {

    /// Куда ходит приложение. Значения — origin без завершающего слэша.
    enum Server: String, CaseIterable, Identifiable, Sendable {
        case main
        case mirror

        var id: String { rawValue }

        var origin: String {
            switch self {
            case .main: return "https://eblusha.org"
            case .mirror: return "https://ru.eblusha.org"
            }
        }

        var title: String {
            switch self {
            case .main: return "eblusha.org"
            case .mirror: return "ru.eblusha.org"
            }
        }

        var subtitle: String {
            switch self {
            case .main: return "Основной"
            case .mirror: return "Зеркало"
            }
        }
    }

    private static let storageKey = "eblusha.server"

    /// Выбранный источник. По умолчанию — тот, что зашила конфигурация сборки.
    static var server: Server {
        get {
            if let raw = UserDefaults.standard.string(forKey: storageKey),
               let stored = Server(rawValue: raw) {
                return stored
            }
            return buildDefault
        }
        set {
            guard newValue != server else { return }
            UserDefaults.standard.set(newValue.rawValue, forKey: storageKey)
            // Кэш разбора медиа-адресов держит прежний origin — иначе картинки после
            // переключения продолжали бы запрашиваться со старого сервера.
            resetMediaUrlCache()
        }
    }

    /// База REST API. Всегда заканчивается на «/», иначе относительные пути склеятся неверно.
    static var apiBaseURL: URL {
        URL(string: server.origin + "/api/") ?? URL(string: "https://eblusha.org/api/")!
    }

    /// Origin для Socket.IO и LiveKit-токенов.
    static var socketBaseURL: URL {
        URL(string: server.origin) ?? URL(string: "https://eblusha.org")!
    }

    /// Значение из Info.plist (его подставляет конфигурация сборки, см. ios/project.yml).
    private static var buildDefault: Server {
        let raw = (Bundle.main.object(forInfoDictionaryKey: "EblushaWsBaseURL") as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return raw.contains("ru.eblusha.org") ? .mirror : .main
    }
}
