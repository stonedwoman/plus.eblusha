import Foundation

/// Порт `data/session/DeviceIdProvider.kt`: стабильный id установки.
///
/// Живёт в UserDefaults отдельно от сессии — переживает выход из аккаунта по 401 (как
/// отдельный DataStore в Android), но не переустановку приложения и не явный «Выйти»:
/// там стираются ключи устройства, и прежний id менять обязательно (H13, см. rotate()).
/// Уходит в заголовок `x-device-id`, в `auth.deviceId` сокета и в E2EE-идентичность.
final class DeviceIdProvider {
    private static let key = "eblusha.device_id"
    /// Id, под которым устройство уже регистрировалось на сервере (/devices/register).
    private static let registeredKey = "eblusha.device_id.registered"
    private let defaults: UserDefaults
    private let lock = NSLock()
    private var cached: String?

    /// `defaults` подменяется только в тестах.
    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    func deviceId() -> String {
        lock.lock()
        defer { lock.unlock() }
        if let cached { return cached }
        if let existing = defaults.string(forKey: Self.key) {
            cached = existing
            return existing
        }
        let generated = UUID().uuidString.lowercased()
        defaults.set(generated, forKey: Self.key)
        cached = generated
        return generated
    }

    /// Новый id установки. Нужен, когда прежний id нельзя (или нельзя честно) продолжать:
    ///  - 409 на /devices/register — id закреплён за другим аккаунтом;
    ///  - устройство отозвано (X5): отозванный id не должен воскресать перерегистрацией;
    ///  - ключи устройства стёрты (выход из аккаунта, H13): под старым id на сервере
    ///    лежат его неизрасходованные one-time prekeys, секретов к которым больше нет —
    ///    пакеты ключей на них не вскрылись бы. Новый id = чистое новое устройство.
    @discardableResult
    func rotate() -> String {
        lock.lock()
        defer { lock.unlock() }
        let generated = UUID().uuidString.lowercased()
        defaults.set(generated, forKey: Self.key)
        cached = generated
        return generated
    }

    /// Устройство с этим id прошло /devices/register.
    func markRegistered(_ id: String) {
        defaults.set(id, forKey: Self.registeredKey)
    }

    /// Регистрировался ли уже этот id (с какой-то идентичностью).
    func wasRegistered(_ id: String) -> Bool {
        defaults.string(forKey: Self.registeredKey) == id
    }
}
