import Foundation
import Security

/// Порт `data/session/SecretKeyStore.kt`: локальное хранилище ключевого материала секреток —
/// X25519-идентичность этого устройства, секретные половины опубликованных one-time prekeys
/// (нужны, чтобы открыть входящие рукопожатия) и симметричные ключи тредов.
///
/// Android шифрует секреты через Keystore и кладёт в DataStore; на iOS оба слоя заменяет
/// Keychain (отдельный service — ключи секреток живут и чистятся независимо от токенов
/// сессии). kSecAttrAccessibleAfterFirstUnlock: инбокс секреток разбирается и по фоновому
/// пушу, а тот может прийти до разблокировки экрана (но после первой после ребута).
/// Публичные значения/threadId — URL-safe base64, как в вебе; карты хранятся целиком
/// JSON-строкой (read → mutate → write) под общим замком, как в оригинале.
final class SecretKeyStore {
    private enum Keys {
        static let identityPub = "identity_pub"
        static let identitySec = "identity_sec"
        static let prekeySecrets = "prekey_secrets"
        static let threadKeys = "thread_keys"
    }

    // Флаг «устройство зарегистрировано на сервере» — в UserDefaults, НЕ в Keychain:
    // Keychain переживает переустановку приложения, а device-id (UserDefaults) — нет.
    // Переживший флаг с новым device-id молча пропускал бы регистрацию → inbox 400.
    // Сама идентичность в Keychain переустановку пережить КАК РАЗ должна (старые
    // шифртексты остаются читаемыми), а повторный /devices/register идемпотентен.
    private static let bootstrappedKey = "eblusha.secret.bootstrapped"
    private let defaults = UserDefaults.standard

    // Карты пишутся целиком — сериализуем читателей-модификаторов, иначе конкурирующие
    // «импорт ключа + пополнение prekeys» молча теряют одну из сторон. Замок также
    // прикрывает кэш ключей тредов (порт writeMutex + threadKeyCache).
    private let lock = NSLock()

    // Ключи тредов нужны на КАЖДОМ send/decrypt/poll — кэшируем расшифрованную карту,
    // чтобы не платить чтение Keychain + JSON-парсинг всей карты дважды за отправку.
    // Пересобирается из только что записанной истины при каждой записи.
    private var threadKeyCache: [String: Data]?

    // MARK: - Идентичность устройства

    func identity() -> SecretCrypto.KeyPair? {
        guard case .value(let pubData) = SecretKeychain.read(Keys.identityPub),
              case .value(let secData) = SecretKeychain.read(Keys.identitySec),
              let pubStr = String(data: pubData, encoding: .utf8),
              let secStr = String(data: secData, encoding: .utf8),
              let pub = SecretCrypto.b64UrlDecode(pubStr),
              let sec = SecretCrypto.b64UrlDecode(secStr) else { return nil }
        return SecretCrypto.KeyPair(publicKey: pub, secretKey: sec)
    }

    func loadOrCreateIdentity() -> SecretCrypto.KeyPair {
        lock.lock()
        defer { lock.unlock() }
        if let existing = identity() { return existing }
        let kp = SecretCrypto.generateKeyPair()
        SecretKeychain.write(Keys.identityPub, Data(SecretCrypto.b64UrlEncode(kp.publicKey).utf8))
        SecretKeychain.write(Keys.identitySec, Data(SecretCrypto.b64UrlEncode(kp.secretKey).utf8))
        return kp
    }

    // MARK: - Секретные половины one-time prekeys

    /// Домердживает секреты свежесгенерированных prekeys (keyId → секрет) для будущих открытий.
    func addPrekeySecrets(_ secrets: [String: Data]) {
        lock.lock()
        defer { lock.unlock() }
        var current = readMap(Keys.prekeySecrets)
        for (keyId, sec) in secrets { current[keyId] = SecretCrypto.b64UrlEncode(sec) }
        writeMap(Keys.prekeySecrets, current)
    }

    func prekeySecret(_ keyId: String) -> Data? {
        lock.lock()
        defer { lock.unlock() }
        guard let encoded = readMap(Keys.prekeySecrets)[keyId] else { return nil }
        return SecretCrypto.b64UrlDecode(encoded)
    }

    // MARK: - Ключи тредов

    func threadKey(_ threadId: String) -> Data? {
        lock.lock()
        defer { lock.unlock() }
        return threadKeysLocked()[threadId]
    }

    /// Все ключи тредов (для device_link_keys — привязки нового устройства).
    func allThreadKeys() -> [String: Data] {
        lock.lock()
        defer { lock.unlock() }
        return threadKeysLocked()
    }

    func setThreadKey(_ threadId: String, key: Data) {
        lock.lock()
        defer { lock.unlock() }
        var current = readMap(Keys.threadKeys)
        current[threadId] = SecretCrypto.b64UrlEncode(key)
        writeMap(Keys.threadKeys, current)
        // Кэш — из только что записанной истины (не через threadKeysLocked: незачем
        // перечитывать Keychain, который мы сами только что заполнили).
        threadKeyCache = decodeThreadKeys(current)
    }

    /// Слияние связки ключей с привязанного устройства. Существующие ключи НИКОГДА не
    /// перетираются (веб: importSecretThreadKeys с merge) — иначе уже сохранённые шифртексты
    /// этого треда стали бы нечитаемыми. Возвращает число реально добавленных ключей.
    @discardableResult
    func mergeThreadKeys(_ incoming: [String: Data]) -> Int {
        guard !incoming.isEmpty else { return 0 }
        lock.lock()
        defer { lock.unlock() }
        var current = readMap(Keys.threadKeys)
        var added = 0
        for (threadId, key) in incoming {
            let id = threadId.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !id.isEmpty, key.count == SecretCrypto.keyBytes else { continue }
            guard current[id] == nil else { continue }
            current[id] = SecretCrypto.b64UrlEncode(key)
            added += 1
        }
        if added > 0 {
            writeMap(Keys.threadKeys, current)
            threadKeyCache = decodeThreadKeys(current)
        }
        return added
    }

    /// Закрытие секретного чата: ключ уничтоженного треда не должен переживать сам тред.
    func removeThreadKey(_ threadId: String) {
        lock.lock()
        defer { lock.unlock() }
        var current = readMap(Keys.threadKeys)
        if current.removeValue(forKey: threadId) != nil {
            writeMap(Keys.threadKeys, current)
            threadKeyCache = decodeThreadKeys(current)
        }
    }

    // MARK: - Флаг бутстрапа

    func isBootstrapped() -> Bool {
        defaults.bool(forKey: Self.bootstrappedKey)
    }

    func setBootstrapped() {
        defaults.set(true, forKey: Self.bootstrappedKey)
    }

    /// Сброс флага: сервер не знает нашего устройства (inbox 400/403) → бутстрап повторить.
    func clearBootstrapped() {
        defaults.set(false, forKey: Self.bootstrappedKey)
    }

    // MARK: - Полная очистка (logout)

    func clear() {
        // Под замком, кэш обнуляется ПОСЛЕ стирания: несериализованный clear позволил бы
        // конкурентному чтению переналить кэш из ещё не стёртого Keychain (ключи чужого
        // аккаунта остались бы в памяти) или воскресить старую карту через read-modify-write.
        lock.lock()
        defer { lock.unlock() }
        SecretKeychain.remove(Keys.identityPub)
        SecretKeychain.remove(Keys.identitySec)
        SecretKeychain.remove(Keys.prekeySecrets)
        SecretKeychain.remove(Keys.threadKeys)
        defaults.removeObject(forKey: Self.bootstrappedKey)
        threadKeyCache = nil
    }

    // MARK: - Внутренности (вызывать только под lock)

    /// Кэшированная карта ключей тредов. ВРЕМЕННЫЙ сбой чтения (Keychain до первой
    /// разблокировки) НЕ кэшируется как «ключей нет» — иначе все секретки выглядели бы
    /// бесключевыми до перезапуска процесса; запоминается только успешное чтение.
    private func threadKeysLocked() -> [String: Data] {
        if let cached = threadKeyCache { return cached }
        guard let raw = readMapOrNil(Keys.threadKeys) else { return [:] } // сбой чтения: ретрай в следующий раз
        let decoded = decodeThreadKeys(raw)
        threadKeyCache = decoded
        return decoded
    }

    private func decodeThreadKeys(_ raw: [String: String]) -> [String: Data] {
        raw.reduce(into: [:]) { acc, pair in
            if let key = SecretCrypto.b64UrlDecode(pair.value) { acc[pair.key] = key }
        }
    }

    private func readMap(_ key: String) -> [String: String] {
        readMapOrNil(key) ?? [:]
    }

    /// nil = само чтение ПРОВАЛИЛОСЬ (ошибка Keychain/парсинга) — отличие от честно пустого.
    private func readMapOrNil(_ key: String) -> [String: String]? {
        switch SecretKeychain.read(key) {
        case .missing:
            return [:]
        case .failure:
            return nil
        case .value(let data):
            return try? JSONDecoder().decode([String: String].self, from: data)
        }
    }

    private func writeMap(_ key: String, _ map: [String: String]) {
        guard let data = try? JSONEncoder().encode(map) else { return }
        SecretKeychain.write(key, data)
    }
}

/// Keychain-обёртка для СЕКРЕТОК — отдельный service, чтобы clear() ключей не задевал
/// токены сессии (org.eblusha.plus.session) и наоборот. В отличие от KeychainStore
/// различает «записи нет» и «чтение не удалось» — это критично для кэша ключей тредов.
private enum SecretKeychain {
    private static let service = "org.eblusha.plus.secret"

    enum ReadResult {
        case value(Data)
        case missing
        case failure
    }

    static func read(_ key: String) -> ReadResult {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        switch status {
        case errSecSuccess:
            guard let data = result as? Data else { return .failure }
            return .value(data)
        case errSecItemNotFound:
            return .missing
        default:
            // Например errSecInteractionNotAllowed — устройство ещё не разблокировано.
            return .failure
        }
    }

    static func write(_ key: String, _ data: Data) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
        ]
        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var insert = query
            insert.merge(attributes) { _, new in new }
            SecItemAdd(insert as CFDictionary, nil)
        }
    }

    static func remove(_ key: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
        SecItemDelete(query as CFDictionary)
    }
}
