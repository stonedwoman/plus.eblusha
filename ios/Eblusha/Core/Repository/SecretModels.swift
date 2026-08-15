import Foundation

// Порт доменных типов из `data/repository/SecretRepository.kt` (верх файла) + примитивы
// асинхронной синхронизации, которыми движок секреток заменяет kotlinx Mutex/Semaphore.

/// Результат POST /threads/secret: id треда + принял ли уже собеседник (ACTIVE).
/// Порт `SecretThreadStart`.
struct SecretThreadStart: Equatable {
    let threadId: String
    let active: Bool
}

/// Сообщение секретного треда после локальной расшифровки. Порт `DecryptedSecretMessage`.
struct DecryptedSecretMessage: Identifiable, Equatable {
    let id: String
    let threadId: String
    let senderId: String
    let text: String
    let createdAtMs: Int64
    let isMine: Bool
    /// contentType="attachment": элементы расшифрованного дескриптора (url+nonce гарантированы).
    var attachments: [SecretAttachmentItemDto] = []

    static func == (lhs: DecryptedSecretMessage, rhs: DecryptedSecretMessage) -> Bool {
        // Вложения сравнивать незачем: id секретного сообщения неизменяем (нет правок).
        lhs.id == rhs.id && lhs.text == rhs.text && lhs.createdAtMs == rhs.createdAtMs
            && lhs.attachments.count == rhs.attachments.count
    }
}

/// Страница расшифрованной секретной истории (keyset-курсор, как в обычных чатах).
/// Порт `SecretHistoryPage`.
struct SecretHistoryPage {
    let messages: [DecryptedSecretMessage]
    let hasMore: Bool
    let nextCursor: String?
}

/// Локальное приглашение этого (доверенного) устройства: token для QR + 8-значный код
/// для ручного ввода, TTL 5 минут. Живёт ТОЛЬКО на устройстве-приглашающем, сервер о нём
/// не знает (веб: deviceLinkInvite.ts). Порт `SecretRepository.DeviceLinkInvite`.
struct DeviceLinkInvite: Equatable {
    let token: String
    let code: String
    let expiresAtMs: Int64

    var qrPayload: String { SecretRepository.addDeviceQrPrefix + token }
    var expired: Bool { Int64(Date().timeIntervalSince1970 * 1000) > expiresAtMs }
}

/// Кому мы только что отдали связку ключей (имя устройства знает только сервер) + сколько
/// тредов. Порт `SecretRepository.LinkedDevice`.
struct LinkedDevice: Equatable {
    let name: String
    let threadCount: Int
}

// MARK: - Async-примитивы (замена kotlinx Mutex/Semaphore)

/// Счётный async-семафор: withPermit ограничивает параллелизм, permits=1 даёт мьютекс
/// (роль kotlinx `Mutex.withLock` / `Semaphore.withPermit` в оригинале). Очередь честная
/// (FIFO), пробуждение — через продолжения, без блокировки потоков пула.
final class AsyncSemaphore: @unchecked Sendable {
    private let lock = NSLock()
    private var available: Int
    private var waiters: [CheckedContinuation<Void, Never>] = []

    init(_ permits: Int) {
        precondition(permits > 0, "AsyncSemaphore: permits must be positive")
        available = permits
    }

    func withPermit<T>(_ op: () async throws -> T) async rethrows -> T {
        await acquire()
        defer { release() }
        return try await op()
    }

    private func acquire() async {
        lock.lock()
        if available > 0 {
            available -= 1
            lock.unlock()
            return
        }
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            waiters.append(cont)
            lock.unlock() // замок взят ПЕРЕД withCheckedContinuation — гонки постановки нет
        }
    }

    private func release() {
        lock.lock()
        if waiters.isEmpty {
            available += 1
            lock.unlock()
        } else {
            let next = waiters.removeFirst()
            lock.unlock()
            next.resume()
        }
    }
}
