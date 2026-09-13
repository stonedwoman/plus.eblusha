import CryptoKit
import Foundation

/// Кэш расшифровок голосовых: шифрованный, с недельным сроком жизни.
///
/// Зачем шифровать, если файл и так лежит в песочнице: расшифровка — это содержимое
/// переписки открытым текстом, в том числе из секретных чатов, где сам звук хранится
/// только зашифрованным. Оставить её лежать простым JSON означало бы завести обходную
/// дорожку вокруг E2EE. Ключ — в Keychain, привязан к устройству и доступен лишь после
/// разблокировки; сам файл вдобавок помечен полной защитой данных.
///
/// Срок — 7 дней: повторно открытый через пару дней чат не заставляет распознавать
/// заново, но чужая речь текстом не копится годами.
/// Не изолирован главным актором намеренно: чистка зовётся из `clearLocalData()` при
/// выходе, а тот работает вне акторов. Состояние защищено замком — как в SecretKeyStore.
final class TranscriptStore: @unchecked Sendable {
    static let shared = TranscriptStore()

    private let lock = NSLock()

    private struct Entry: Codable {
        let text: String
        /// Когда расшифровали (мс) — по этой метке и истекает срок.
        let createdAtMs: Int64
    }

    private static let ttl: TimeInterval = 7 * 24 * 60 * 60
    private static let keychainKey = "eblusha.transcripts.key"

    private var entries: [String: Entry] = [:]
    private var loaded = false

    private var fileURL: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Eblusha", isDirectory: true)
        try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        return base.appendingPathComponent("transcripts.bin")
    }

    private init() {}

    /// Готовая расшифровка вложения или nil. Ключ — `MessageAttachment.url`: он одинаков
    /// у всех показов вложения и у секретных не зависит от имени расшифрованного файла.
    func text(for key: String) -> String? {
        lock.lock()
        defer { lock.unlock() }
        loadIfNeeded()
        guard let entry = entries[key] else { return nil }
        guard !isExpired(entry) else {
            entries[key] = nil
            persist()
            return nil
        }
        return entry.text
    }

    func save(_ text: String, for key: String) {
        lock.lock()
        defer { lock.unlock() }
        loadIfNeeded()
        entries[key] = Entry(text: text, createdAtMs: Int64(Date().timeIntervalSince1970 * 1000))
        persist()
    }

    /// Выход из аккаунта и закрытие секретки не должны оставлять расшифровки на диске.
    func clear() {
        lock.lock()
        defer { lock.unlock() }
        entries = [:]
        loaded = true
        try? FileManager.default.removeItem(at: fileURL)
    }

    // MARK: - Хранение

    private func isExpired(_ entry: Entry) -> Bool {
        let age = Date().timeIntervalSince1970 - Double(entry.createdAtMs) / 1000
        return age > Self.ttl
    }

    private func loadIfNeeded() {
        guard !loaded else { return }
        loaded = true
        guard
            let blob = try? Data(contentsOf: fileURL),
            let key = existingKey(),
            let box = try? AES.GCM.SealedBox(combined: blob),
            let plain = try? AES.GCM.open(box, using: key),
            let decoded = try? JSONDecoder().decode([String: Entry].self, from: plain)
        else {
            // Ключ пересоздан, файл побит, версия формата другая — кэш просто пуст.
            // Терять тут нечего: расшифровку всегда можно получить заново.
            entries = [:]
            return
        }
        // Просроченное выбрасываем сразу при загрузке, а не по обращению: иначе текст
        // недельной давности лежал бы на диске до тех пор, пока о нём не вспомнят.
        entries = decoded.filter { !isExpired($0.value) }
        if entries.count != decoded.count { persist() }
    }

    private func persist() {
        guard let key = orCreateKey() else { return }
        guard
            let plain = try? JSONEncoder().encode(entries),
            let sealed = try? AES.GCM.seal(plain, using: key).combined
        else { return }
        try? sealed.write(to: fileURL, options: [.atomic, .completeFileProtection])
    }

    // MARK: - Ключ

    private func existingKey() -> SymmetricKey? {
        guard
            let stored = KeychainStore.get(Self.keychainKey),
            let raw = Data(base64Encoded: stored)
        else { return nil }
        return SymmetricKey(data: raw)
    }

    private func orCreateKey() -> SymmetricKey? {
        if let key = existingKey() { return key }
        let fresh = SymmetricKey(size: .bits256)
        let raw = fresh.withUnsafeBytes { Data($0) }
        KeychainStore.set(raw.base64EncodedString(), for: Self.keychainKey)
        return fresh
    }
}
