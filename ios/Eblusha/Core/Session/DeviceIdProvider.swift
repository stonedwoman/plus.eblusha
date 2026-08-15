import Foundation

/// Порт `data/session/DeviceIdProvider.kt`: стабильный id установки.
///
/// Живёт в UserDefaults отдельно от сессии — переживает выход из аккаунта (как
/// отдельный DataStore в Android), но не переустановку приложения. Уходит в заголовок
/// `x-device-id`, в `auth.deviceId` сокета и позже — в E2EE-идентичность устройства.
final class DeviceIdProvider {
    private static let key = "eblusha.device_id"
    private let defaults = UserDefaults.standard
    private let lock = NSLock()
    private var cached: String?

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

    /// Новый id установки. Нужен ровно в одном случае: 409 на /devices/register —
    /// текущий id закреплён за другим аккаунтом (id переживает logout). Без ротации
    /// E2EE-бутстрап не пройдёт никогда. (См. комментарий в Kotlin-оригинале.)
    func rotate() -> String {
        lock.lock()
        defer { lock.unlock() }
        let generated = UUID().uuidString.lowercased()
        defaults.set(generated, forKey: Self.key)
        cached = generated
        return generated
    }
}
