import Foundation

// Порт `domain/model/SocialModels.kt` — доменные модели контактов и карточки пользователя.
// DevicePairing/DeviceSession из того же Kotlin-файла относятся к настройкам и устройствам —
// они приедут фазой 6 вместе со своими экранами (добавлять их сюда).

/// Принятый друг или ожидающая заявка.
struct Contact: Identifiable, Equatable {
    let contactId: String
    let user: ChatUser
    let status: String   // ACCEPTED | PENDING | BLOCKED
    /// Ожидающая заявка, ждущая именно НАШЕГО ответа.
    let incoming: Bool

    var id: String { contactId }
}

/// Ссылка на (возможно только что созданную) беседу, готовую к открытию.
struct ConversationRef: Identifiable, Equatable, Hashable {
    let id: String
    let title: String
}

struct UserProfile: Equatable {
    let id: String
    let username: String
    let eblid: String?
    let displayName: String?
    let bio: String?
    let avatarUrl: String?
    let status: String?

    var name: String {
        if let displayName, !displayName.trimmed().isEmpty { return displayName }
        return username
    }
}

/// Публичный мини-профиль для универсальной карточки (username никогда не показывается).
struct UserCardProfile: Equatable {
    let id: String
    let eblid: String?
    let name: String
    let bio: String?
    let avatarUrl: String?
    let avatars: [String]
    let status: String?
    let lastSeenMs: Int64?
    let createdAtMs: Int64?
}

/// Отношение просматриваемого пользователя к нам (управляет кнопкой дружбы карточки).
enum UserRelationKind { case none, friend, incoming, outgoing }

struct UserRelation: Equatable {
    let kind: UserRelationKind
    var contactId: String?

    init(_ kind: UserRelationKind, _ contactId: String? = nil) {
        self.kind = kind
        self.contactId = contactId
    }
}

/// Код регистрации текущего пользователя (можно поделиться) со сроком для обратного отсчёта.
struct InviteCode: Equatable {
    let code: String
    let expiresAtMs: Int64?
}
