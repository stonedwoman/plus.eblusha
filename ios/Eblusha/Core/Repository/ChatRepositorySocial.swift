import Foundation

// Порт sharedGroupsWith / existingDirectWith из `data/repository/ChatRepository.kt` —
// блок «Общие беседы» и переключение «Написать» → «К беседе» карточки пользователя.
//
// Приватная карта участников (participantAvatars) из другого файла недоступна — extension
// ходит через публичный conversationSenderAvatars(), который сам лениво обновляет список,
// если беседы ещё не видел (та же самопочинка, что в Kotlin-оригинале).

extension ChatRepository {

    /// Группы, общие с пользователем — блок «Общие беседы» карточки.
    func sharedGroupsWith(_ userId: String) async -> [Conversation] {
        // Порт `if (participantAvatars.isEmpty()) listConversations()`: холодный старт без
        // кеша — один сетевой рефреш, дальше всё резолвится из кеша.
        if cachedConversations().isEmpty { _ = await listConversations() }
        var shared: [Conversation] = []
        for c in cachedConversations() where c.isGroup {
            if await conversationSenderAvatars(c.id).keys.contains(userId) {
                shared.append(c)
            }
        }
        return shared
    }

    /// Существующая НЕсекретная 1:1 с пользователем — переключает «Написать» в «К беседе».
    func existingDirectWith(_ userId: String) async -> Conversation? {
        if cachedConversations().isEmpty { _ = await listConversations() }
        return cachedConversations().first {
            !$0.isGroup && !$0.isSecret && !$0.isSecretV2 && $0.otherUserId == userId
        }
    }

    /// Разворачивает ConversationRef в полноценную беседу для ChatView: из кеша репозитория
    /// (conversationMeta сам разово обновит список), с фолбэком на минимальную 1:1-заглушку —
    /// свежесозданный DM мог ещё не приехать в выдачу списка.
    func resolveRef(_ ref: ConversationRef) async -> Conversation {
        if let known = await conversationMeta(ref.id) { return known }
        return Conversation(
            id: ref.id, isGroup: false, isSecret: false, title: ref.title,
            avatarUrl: nil, lastMessageText: nil, lastMessageAt: nil, unreadCount: 0,
            online: false, otherUserId: nil, otherLastSeen: nil, otherStatus: nil,
            type: nil, createdById: nil, secretStatus: nil, secretPeerDeviceId: nil
        )
    }
}
