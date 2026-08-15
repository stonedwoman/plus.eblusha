import Foundation

// Порт `ChatRepository.conversationPeerUserIds` из Kotlin (данные для фанаута секреток).
// Живёт extension'ом в отдельном файле: ChatRepository.swift — общий файл, его не трогаем.
// Private-кэш участников отсюда недоступен, но публичный conversationSenderAvatars отдаёт
// ту же карту userId→avatarUrl (и сам разово дотягивает список бесед, если беседу ещё
// не видели) — семантика Kotlin-оригинала сохраняется 1:1.

extension ChatRepository {
    /// userId всех участников беседы, КРОМЕ себя, — целевой набор устройств-получателей
    /// секретного треда (peerUserIds для SecretRepository.sendText/sendAttachments).
    func conversationPeerUserIds(_ conversationId: String) async -> [String] {
        let me = currentUserId()
        let participants = await conversationSenderAvatars(conversationId)
        return participants.keys.filter { $0 != me }
    }
}
