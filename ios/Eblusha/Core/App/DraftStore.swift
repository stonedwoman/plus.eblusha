import Foundation

/// Недописанные сообщения по беседам — порт `feature/chat/DraftStore.kt`.
///
/// Живёт в памяти процесса, как в эталоне: смысл в том, чтобы выход в список чатов и
/// возврат обратно не съедали набранный текст. Переживать перезапуск приложения черновик
/// не обязан (на Android тоже), поэтому ни диска, ни Keychain здесь нет — а заодно
/// недописанное не остаётся на устройстве после выхода из аккаунта.
enum DraftStore {

    // Под замком, а не под @MainActor: чистка зовётся из общего clearLocalData(), который
    // живёт вне главного актора (выход из аккаунта).
    private static let drafts = Mutex<[String: String]>([:])

    static func get(_ conversationId: String) -> String {
        drafts.withLock { $0[conversationId] ?? "" }
    }

    static func set(_ conversationId: String, _ text: String) {
        // Пустой черновик — это отсутствие черновика (порт условия isBlank в Kotlin):
        // иначе словарь копил бы пустые строки по всем открытым когда-либо беседам.
        drafts.withLock { map in
            if text.trimmed().isEmpty {
                map.removeValue(forKey: conversationId)
            } else {
                map[conversationId] = text
            }
        }
    }

    /// Выход из аккаунта: чужие черновики новому владельцу сессии не показываем.
    static func clear() {
        drafts.withLock { $0.removeAll() }
    }
}
