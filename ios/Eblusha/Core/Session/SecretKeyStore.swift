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
        /// keyId → мс создания секрета (строкой). Нужен, чтобы срезать самые старые секреты,
        /// когда их копится больше разумного (H04: выкачанные чужими claim'ами OPK).
        static let prekeyCreated = "prekey_created"
        /// keyId → мс, когда секретом вскрыли пакет. Через сутки такой секрет удаляется:
        /// OPK одноразовый, но веб умеет отдать один claim двум параллельным пакетам и
        /// переотправить не ack-нутый — поэтому не сразу.
        static let prekeyUsed = "prekey_used"
        static let threadKeys = "thread_keys"
        /// threadId → прежние ключи треда через запятую (b64url запятых не содержит),
        /// новые первыми. Ключ треда меняется автоматически (решение владельца), но
        /// история, зашифрованная прежним ключом, должна оставаться читаемой.
        static let previousThreadKeys = "thread_keys_prev"
    }

    /// Сколько прежних ключей треда держим для расшифровки старой истории.
    static let maxPreviousKeys = 4
    /// Потолок секретов OPK. Сервер держит ≤250 невыданных на устройство и выдаёт самые
    /// старые первыми, так что невыданные — всегда самые свежие; всё сверх потолка —
    /// давно выданные кому-то и не пришедшие пакеты. Честное устройство до него не дорастает.
    static let maxPrekeySecrets = 1000
    /// Сколько живёт секрет OPK после того, как им вскрыли пакет.
    static let usedPrekeyGraceMs: Int64 = 24 * 60 * 60 * 1000
    /// Отметка секретов, записанных версиями ДО отметок времени. Их порядок неизвестен (карта —
    /// словарь в JSON), а старые сборки добавляли +50 на КАЖДЫЙ prekeys_needed без учёта
    /// insertedKeyIds — среди них и ещё не выданные сервером OPK. Под потолок они не попадают,
    /// уходят только по «вскрыт + сутки».
    static let legacyPrekeyMark = "legacy"

    // Флаг «устройство зарегистрировано на сервере» — в UserDefaults, НЕ в Keychain:
    // Keychain переживает переустановку приложения, а device-id (UserDefaults) — нет.
    // Переживший флаг с новым device-id молча пропускал бы регистрацию → inbox 400.
    // Сама идентичность в Keychain переустановку пережить КАК РАЗ должна (старые
    // шифртексты остаются читаемыми), а повторный /devices/register идемпотентен.
    private let bootstrappedKey: String
    private let defaults: UserDefaults
    private let keychain: SecretKeychain

    // Карты пишутся целиком — сериализуем читателей-модификаторов, иначе конкурирующие
    // «импорт ключа + пополнение prekeys» молча теряют одну из сторон. Замок также
    // прикрывает кэш ключей тредов (порт writeMutex + threadKeyCache).
    private let lock = NSLock()

    // Ключи тредов нужны на КАЖДОМ send/decrypt/poll — кэшируем расшифрованную карту,
    // чтобы не платить чтение Keychain + JSON-парсинг всей карты дважды за отправку.
    // Пересобирается из только что записанной истины при каждой записи.
    private var threadKeyCache: [String: Data]?

    /// `service`/`defaults` подменяются только в тестах: боевое хранилище — один service
    /// на приложение, и тесты не должны его трогать.
    init(service: String = "org.eblusha.plus.secret", defaults: UserDefaults = .standard) {
        self.keychain = SecretKeychain(service: service)
        self.defaults = defaults
        self.bootstrappedKey = service == "org.eblusha.plus.secret"
            ? "eblusha.secret.bootstrapped"
            : "eblusha.secret.bootstrapped.\(service)"
    }

    // MARK: - Идентичность устройства

    enum IdentityState: Equatable {
        case present
        case missing
        /// Keychain не ответил (например, до первой разблокировки после ребута). Это НЕ
        /// «идентичности нет»: создать новую поверх — значит разойтись с сервером.
        case unavailable
    }

    func identityState() -> IdentityState {
        switch (keychain.read(Keys.identityPub), keychain.read(Keys.identitySec)) {
        case (.value, .value): return identity() == nil ? .missing : .present
        case (.failure, _), (_, .failure): return .unavailable
        default: return .missing
        }
    }

    func identity() -> SecretCrypto.KeyPair? {
        guard case .value(let pubData) = keychain.read(Keys.identityPub),
              case .value(let secData) = keychain.read(Keys.identitySec),
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
        keychain.write(Keys.identityPub, Data(SecretCrypto.b64UrlEncode(kp.publicKey).utf8))
        keychain.write(Keys.identitySec, Data(SecretCrypto.b64UrlEncode(kp.secretKey).utf8))
        return kp
    }

    // MARK: - Секретные половины one-time prekeys

    /// Домердживает секреты свежесгенерированных prekeys (keyId → секрет) для будущих открытий.
    func addPrekeySecrets(_ secrets: [String: Data], nowMs: Int64 = SecretKeyStore.nowMs()) {
        guard !secrets.isEmpty else { return }
        lock.lock()
        defer { lock.unlock() }
        // Сбой чтения ≠ пустая карта: запись «пустая + новые» стёрла бы все прежние секреты.
        guard var current = readMapOrNil(Keys.prekeySecrets),
              var created = readMapOrNil(Keys.prekeyCreated) else { return }
        for (keyId, sec) in secrets {
            current[keyId] = SecretCrypto.b64UrlEncode(sec)
            created[keyId] = String(nowMs)
        }
        writeMap(Keys.prekeySecrets, current)
        writeMap(Keys.prekeyCreated, created)
    }

    func prekeySecret(_ keyId: String) -> Data? {
        lock.lock()
        defer { lock.unlock() }
        guard let encoded = readMap(Keys.prekeySecrets)[keyId] else { return nil }
        return SecretCrypto.b64UrlDecode(encoded)
    }

    func prekeySecretCount() -> Int {
        lock.lock()
        defer { lock.unlock() }
        return readMap(Keys.prekeySecrets).count
    }

    /// Убирает секреты: опубликованные, но не принятые сервером (вне insertedKeyIds), и
    /// сгенерированные под провалившуюся регистрацию.
    func removePrekeySecrets<S: Sequence>(_ keyIds: S) where S.Element == String {
        lock.lock()
        defer { lock.unlock() }
        guard var current = readMapOrNil(Keys.prekeySecrets) else { return }
        var created = readMap(Keys.prekeyCreated)
        var used = readMap(Keys.prekeyUsed)
        var changed = false
        for keyId in keyIds {
            if current.removeValue(forKey: keyId) != nil { changed = true }
            created.removeValue(forKey: keyId)
            used.removeValue(forKey: keyId)
        }
        guard changed else { return }
        writeMap(Keys.prekeySecrets, current)
        writeMap(Keys.prekeyCreated, created)
        writeMap(Keys.prekeyUsed, used)
    }

    /// Секретом вскрыли пакет (ack ушёл) — удалится через usedPrekeyGraceMs.
    func markPrekeysUsed<S: Sequence>(_ keyIds: S, nowMs: Int64 = SecretKeyStore.nowMs()) where S.Element == String {
        lock.lock()
        defer { lock.unlock() }
        guard var used = readMapOrNil(Keys.prekeyUsed) else { return }
        var changed = false
        for keyId in keyIds where used[keyId] == nil {
            used[keyId] = String(nowMs)
            changed = true
        }
        if changed { writeMap(Keys.prekeyUsed, used) }
    }

    /// Чистка секретов OPK (H04): использованные дольше суток назад и всё сверх потолка,
    /// начиная с самых старых. Потолок считается только по секретам с отметкой времени
    /// (записаны этой версией: порядок отметок = порядок выдачи сервером). Секреты без
    /// отметки (записаны до неё) получают метку `legacyPrekeyMark` и потолком НЕ режутся:
    /// раньше они получали одну отметку «сейчас» и при count > cap уходили в порядке
    /// случайных UUID — вместе с ещё не выданными сервером, после чего пакеты на них
    /// не вскрывались. Возвращает число удалённых.
    @discardableResult
    func prunePrekeySecrets(
        nowMs: Int64 = SecretKeyStore.nowMs(),
        cap: Int = SecretKeyStore.maxPrekeySecrets
    ) -> Int {
        lock.lock()
        defer { lock.unlock() }
        guard var current = readMapOrNil(Keys.prekeySecrets),
              var created = readMapOrNil(Keys.prekeyCreated),
              var used = readMapOrNil(Keys.prekeyUsed) else { return 0 }
        var removed = 0
        var createdChanged = false
        for keyId in current.keys where created[keyId] == nil {
            created[keyId] = Self.legacyPrekeyMark
            createdChanged = true
        }
        for (keyId, at) in used {
            guard let atMs = Int64(at), nowMs - atMs > Self.usedPrekeyGraceMs else { continue }
            if current.removeValue(forKey: keyId) != nil { removed += 1 }
            created.removeValue(forKey: keyId)
            used.removeValue(forKey: keyId)
        }
        let dated: [(keyId: String, at: Int64)] = current.keys.compactMap { keyId in
            Int64(created[keyId] ?? "").map { (keyId, $0) }
        }
        if dated.count > cap {
            let oldestFirst = dated.sorted { ($0.at, $0.keyId) < ($1.at, $1.keyId) }.map(\.keyId)
            for keyId in oldestFirst.prefix(dated.count - cap) {
                current.removeValue(forKey: keyId)
                created.removeValue(forKey: keyId)
                used.removeValue(forKey: keyId)
                removed += 1
            }
        }
        // Отметки для ключей, которых уже нет, не копим.
        for keyId in created.keys where current[keyId] == nil { created.removeValue(forKey: keyId) }
        for keyId in used.keys where current[keyId] == nil { used.removeValue(forKey: keyId) }
        if removed > 0 {
            writeMap(Keys.prekeySecrets, current)
            writeMap(Keys.prekeyUsed, used)
        }
        if removed > 0 || createdChanged {
            writeMap(Keys.prekeyCreated, created)
        }
        return removed
    }

    #if DEBUG
    /// Только для тестов: хранилище в том виде, в каком его оставили версии до отметок
    /// времени секретов OPK (карты prekey_created не было).
    func dropPrekeyCreationMarksForTests() {
        lock.lock()
        defer { lock.unlock() }
        writeMap(Keys.prekeyCreated, [:])
    }
    #endif

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

    /// Ключи для РАСШИФРОВКИ: текущий первым, затем прежние (после смены ключа треда
    /// история, запечатанная старым, остаётся читаемой).
    func threadKeysForDecrypt(_ threadId: String) -> [Data] {
        lock.lock()
        defer { lock.unlock() }
        var keys: [Data] = []
        if let current = threadKeysLocked()[threadId] { keys.append(current) }
        for key in previousKeysLocked(threadId) where !keys.contains(key) { keys.append(key) }
        return keys
    }

    func previousThreadKeys(_ threadId: String) -> [Data] {
        lock.lock()
        defer { lock.unlock() }
        return previousKeysLocked(threadId)
    }

    /// Ключ, выпущенный САМИМ устройством (создатель треда). Для входящих ключей —
    /// только replaceThreadKey: он не теряет прежний.
    func setThreadKey(_ threadId: String, key: Data) {
        // Второй рубеж после importKeyPackage: в хранилище не должно попасть ничего,
        // чем нельзя шифровать — иначе тред «отравлен» и переживает перезапуск.
        guard key.count == SecretCrypto.keyBytes else {
            NSLog("SecretKeyStore: отклонён ключ треда %@ негодной длины %d", threadId, key.count)
            return
        }
        lock.lock()
        defer { lock.unlock() }
        guard var current = readMapOrNil(Keys.threadKeys) else { return }
        current[threadId] = SecretCrypto.b64UrlEncode(key)
        writeMap(Keys.threadKeys, current)
        // Кэш — из только что записанной истины (не через threadKeysLocked: незачем
        // перечитывать Keychain, который мы сами только что заполнили).
        threadKeyCache = decodeThreadKeys(current)
    }

    enum ThreadKeyChange: Equatable {
        case added
        case unchanged
        /// Был другой ключ: он ушёл в прежние (для расшифровки истории).
        case replaced
        /// Негодный ключ или Keychain не ответил — ничего не записано.
        case rejected
    }

    /// Входящий ключ треда от ПРОВЕРЕННОГО участника (H01). Смена ключа — автоматическая
    /// (решение владельца), но прежний ключ не выбрасывается: он нужен старой истории.
    @discardableResult
    func replaceThreadKey(_ threadId: String, key: Data) -> ThreadKeyChange {
        guard key.count == SecretCrypto.keyBytes else { return .rejected }
        lock.lock()
        defer { lock.unlock() }
        guard var current = readMapOrNil(Keys.threadKeys),
              var previous = readMapOrNil(Keys.previousThreadKeys) else { return .rejected }
        let encoded = SecretCrypto.b64UrlEncode(key)
        let existing = current[threadId]
        if existing == encoded { return .unchanged }
        var change = ThreadKeyChange.added
        var prevList = (previous[threadId] ?? "").split(separator: ",").map(String.init)
        prevList.removeAll { $0 == encoded } // вернувшийся прежний ключ снова становится текущим
        if let existing {
            prevList.removeAll { $0 == existing }
            prevList.insert(existing, at: 0)
            change = .replaced
        }
        prevList = Array(prevList.prefix(Self.maxPreviousKeys))
        current[threadId] = encoded
        if prevList.isEmpty {
            previous.removeValue(forKey: threadId)
        } else {
            previous[threadId] = prevList.joined(separator: ",")
        }
        writeMap(Keys.threadKeys, current)
        writeMap(Keys.previousThreadKeys, previous)
        threadKeyCache = decodeThreadKeys(current)
        return change
    }

    /// Слияние связки ключей с привязанного устройства. Существующие ключи НИКОГДА не
    /// перетираются (веб: importSecretThreadKeys с merge) — иначе уже сохранённые шифртексты
    /// этого треда стали бы нечитаемыми. Возвращает число реально добавленных ключей.
    @discardableResult
    func mergeThreadKeys(_ incoming: [String: Data]) -> Int {
        guard !incoming.isEmpty else { return 0 }
        lock.lock()
        defer { lock.unlock() }
        guard var current = readMapOrNil(Keys.threadKeys) else { return 0 }
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
        var previous = readMap(Keys.previousThreadKeys)
        if previous.removeValue(forKey: threadId) != nil {
            writeMap(Keys.previousThreadKeys, previous)
        }
    }

    // MARK: - Флаг бутстрапа

    func isBootstrapped() -> Bool {
        defaults.bool(forKey: bootstrappedKey)
    }

    func setBootstrapped() {
        defaults.set(true, forKey: bootstrappedKey)
    }

    /// Сброс флага: сервер не знает нашего устройства (inbox 400/403) → бутстрап повторить.
    func clearBootstrapped() {
        defaults.set(false, forKey: bootstrappedKey)
    }

    // MARK: - Полная очистка (logout, отзыв устройства)

    func clear() {
        // Под замком, кэш обнуляется ПОСЛЕ стирания: несериализованный clear позволил бы
        // конкурентному чтению переналить кэш из ещё не стёртого Keychain (ключи чужого
        // аккаунта остались бы в памяти) или воскресить старую карту через read-modify-write.
        lock.lock()
        defer { lock.unlock() }
        keychain.remove(Keys.identityPub)
        keychain.remove(Keys.identitySec)
        keychain.remove(Keys.prekeySecrets)
        keychain.remove(Keys.prekeyCreated)
        keychain.remove(Keys.prekeyUsed)
        keychain.remove(Keys.threadKeys)
        keychain.remove(Keys.previousThreadKeys)
        defaults.removeObject(forKey: bootstrappedKey)
        threadKeyCache = nil
    }

    static func nowMs() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }

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

    private func previousKeysLocked(_ threadId: String) -> [Data] {
        (readMap(Keys.previousThreadKeys)[threadId] ?? "")
            .split(separator: ",")
            .compactMap { SecretCrypto.b64UrlDecode(String($0)) }
            .filter { $0.count == SecretCrypto.keyBytes }
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
        switch keychain.read(key) {
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
        keychain.write(key, data)
    }
}

/// Keychain-обёртка для СЕКРЕТОК — отдельный service, чтобы clear() ключей не задевал
/// токены сессии (org.eblusha.plus.session) и наоборот. В отличие от KeychainStore
/// различает «записи нет» и «чтение не удалось» — это критично для кэша ключей тредов.
private struct SecretKeychain {
    let service: String

    enum ReadResult {
        case value(Data)
        case missing
        case failure
    }

    func read(_ key: String) -> ReadResult {
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

    func write(_ key: String, _ data: Data) {
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

    func remove(_ key: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
        SecItemDelete(query as CFDictionary)
    }
}
