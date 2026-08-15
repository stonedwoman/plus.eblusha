import Foundation
import Combine

/// Порт `data/session/SessionStore.kt`.
///
/// Токены — в Keychain (аналог KeystoreCrypto+DataStore), профиль — в UserDefaults.
/// Как и в оригинале, токены зеркалятся в обычные поля, чтобы сетевой слой читал их
/// синхронно, без ожиданий; `load()` греет этот кеш на старте.
final class SessionStore: ObservableObject {

    struct StoredUser: Equatable {
        let id: String
        let username: String
        var displayName: String?
        var avatarUrl: String?
    }

    enum State: Equatable {
        case unknown
        case loggedOut
        case loggedIn(StoredUser)
    }

    @Published private(set) var state: State = .unknown

    private enum Keys {
        static let access = "access_token"
        static let refresh = "refresh_token"
        static let expires = "expires_at"
        static let userId = "eblusha.session.user_id"
        static let username = "eblusha.session.username"
        static let displayName = "eblusha.session.display_name"
        static let avatar = "eblusha.session.avatar_url"
    }

    private let defaults = UserDefaults.standard
    private let lock = NSLock()
    private var accessToken: String?
    private var refreshToken: String?
    private var accessExpiresAt: Date?

    func currentAccessToken() -> String? { lock.withLock { accessToken } }
    func currentRefreshToken() -> String? { lock.withLock { refreshToken } }
    func currentUserId() -> String? {
        if case .loggedIn(let user) = state { return user.id }
        return nil
    }
    func currentUser() -> StoredUser? {
        if case .loggedIn(let user) = state { return user }
        return nil
    }

    /// Истёк ли access-токен (с запасом skew). Нужно для проактивного refresh перед
    /// открытием сокета: у его рукопожатия, в отличие от HTTP-клиента, нет ротации по 401.
    /// Неизвестный срок — false: сработает реактивный путь (connect_error).
    func isAccessTokenExpired(skew: TimeInterval = 30) -> Bool {
        guard let expires = lock.withLock({ accessExpiresAt }) else { return false }
        return Date() >= expires.addingTimeInterval(-skew)
    }

    /// Поднимает сохранённую сессию; выводит state из .unknown.
    func load() {
        let access = KeychainStore.get(Keys.access)
        let refresh = KeychainStore.get(Keys.refresh)
        let expires = KeychainStore.get(Keys.expires).flatMap(Self.parseISO)
        lock.withLock {
            accessToken = access
            refreshToken = refresh
            accessExpiresAt = expires
        }
        if refresh != nil, let userId = defaults.string(forKey: Keys.userId) {
            state = .loggedIn(StoredUser(
                id: userId,
                username: defaults.string(forKey: Keys.username) ?? "",
                displayName: defaults.string(forKey: Keys.displayName),
                avatarUrl: defaults.string(forKey: Keys.avatar)
            ))
        } else {
            state = .loggedOut
        }
    }

    func save(_ response: SessionResponse) {
        lock.withLock {
            accessToken = response.accessToken
            refreshToken = response.refreshToken
            accessExpiresAt = Self.parseISO(response.expiresAt)
        }
        KeychainStore.set(response.accessToken, for: Keys.access)
        KeychainStore.set(response.refreshToken, for: Keys.refresh)
        KeychainStore.set(response.expiresAt, for: Keys.expires)
        defaults.set(response.user.id, forKey: Keys.userId)
        defaults.set(response.user.username, forKey: Keys.username)
        defaults.set(response.user.displayName, forKey: Keys.displayName)
        defaults.set(response.user.avatarUrl, forKey: Keys.avatar)
        setState(.loggedIn(StoredUser(
            id: response.user.id,
            username: response.user.username,
            displayName: response.user.displayName,
            avatarUrl: response.user.avatarUrl
        )))
    }

    /// Отражает правку профиля в кешированном пользователе (шапка списка чатов, аватары).
    func updateProfile(displayName: String?, avatarUrl: String?) {
        guard case .loggedIn(var user) = state else { return }
        user.displayName = displayName
        user.avatarUrl = avatarUrl
        defaults.set(displayName, forKey: Keys.displayName)
        defaults.set(avatarUrl, forKey: Keys.avatar)
        setState(.loggedIn(user))
    }

    func clear() {
        lock.withLock {
            accessToken = nil
            refreshToken = nil
            accessExpiresAt = nil
        }
        [Keys.access, Keys.refresh, Keys.expires].forEach(KeychainStore.remove)
        [Keys.userId, Keys.username, Keys.displayName, Keys.avatar]
            .forEach(defaults.removeObject(forKey:))
        setState(.loggedOut)
    }

    private func setState(_ new: State) {
        if Thread.isMainThread {
            state = new
        } else {
            DispatchQueue.main.async { self.state = new }
        }
    }

    private static func parseISO(_ raw: String) -> Date? {
        // Бэкенд шлёт ISO с миллисекундами (Date.toISOString), но подстрахуемся и без них.
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = withFraction.date(from: raw) { return date }
        return ISO8601DateFormatter().date(from: raw)
    }
}

private extension NSLock {
    func withLock<T>(_ body: () -> T) -> T {
        lock()
        defer { unlock() }
        return body()
    }
}
