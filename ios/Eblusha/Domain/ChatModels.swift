import Foundation

// Порт `domain/model/ChatModels.kt` — доменные модели, которыми живёт UI.

enum ReceiptState: String, Codable {
    case none = "NONE"
    case sent = "SENT"
    case delivered = "DELIVERED"
    case read = "READ"
}

struct MessageReaction: Codable, Equatable {
    let emoji: String
    let count: Int
    let mine: Bool
}

/// Цитата, на которую указывает ответ (по одной на цитату). Имя отправителя резолвит UI.
struct ReplyInfo: Equatable {
    let id: String
    let senderId: String
    let content: String?
    var createdAt: Int64?
}

/// Происхождение пересылки из `metadata.forwardFrom` (совместимо с вебом по проводу).
struct ForwardInfo: Equatable {
    let authorName: String
    var sourceChatTitle: String?
    var isGroupSource = false
    var directChatPeerName: String?
    var originalCreatedAt: Int64?
}

/// Серверное Open Graph-превью первой ссылки (`metadata.linkPreview`).
struct LinkPreview: Equatable {
    let url: String
    var title: String?
    var description: String?
    var imageUrl: String?
    var siteName: String?
}

struct MessageAttachment: Codable, Equatable {
    let url: String
    let type: String // IMAGE | VIDEO | AUDIO | FILE
    var mime: String?
    var name: String?
    var size: Int64?
    var width: Int?
    var height: Int?
    /// Кадр-постер видео (metadata.posterKey); nil — постера нет.
    var posterUrl: String?
    /// E2EE: nonce файла — url отдаёт шифртекст, расшифровать ключом треда secretThreadId.
    var secretNonce: String?
    var secretThreadId: String?
}

struct ChatUser: Identifiable, Equatable {
    let id: String
    let username: String
    let displayName: String?
    let avatarUrl: String?
    var online = false

    var name: String {
        if let displayName, !displayName.isEmpty { return displayName }
        return username
    }
}

struct Conversation: Identifiable, Equatable, Hashable {
    let id: String
    let isGroup: Bool
    let isSecret: Bool
    let title: String
    let avatarUrl: String?
    let lastMessageText: String?
    let lastMessageAt: Int64?
    let unreadCount: Int
    var online: Bool
    var otherUserId: String?
    var otherLastSeen: Int64?
    /// ПОЛНЫЙ статус собеседника (ONLINE/BACKGROUND/AWAY/IN_CALL/OFFLINE): одного
    /// `online` мало — BACKGROUND схлопывался в false и плитка врала «был(а) онлайн».
    var otherStatus: String?
    var type: String?        // "SECRET" = E2EE-тред (V2); у легаси-секреток другой тип
    var createdById: String? // секретные треды: ключ треда генерирует ТОЛЬКО создатель
    var secretStatus: String?       // PENDING (приглашение) | ACTIVE | CANCELLED
    var secretPeerDeviceId: String?

    /// V2-секретка — E2EE через секретный транспорт; НИКОГДА не различать по isSecret одному.
    var isSecretV2: Bool { type?.caseInsensitiveCompare("SECRET") == .orderedSame }
    /// Секретное приглашение, которое собеседник ещё не принял.
    var isSecretPending: Bool {
        isSecretV2 && secretStatus?.caseInsensitiveCompare("PENDING") == .orderedSame
    }
}

struct Message: Identifiable, Equatable {
    let id: String
    let conversationId: String
    let senderId: String
    let senderName: String
    var senderAvatarUrl: String?
    let type: String
    let content: String?
    let createdAt: Int64
    let isMine: Bool
    let isSystem: Bool
    var edited = false
    var deleted = false
    var reactions: [MessageReaction] = []
    var receipt: ReceiptState = .none
    var attachments: [MessageAttachment] = []
    /// Цитаты, на которые отвечает сообщение (0 — нет, 1 — одна, ≥2 — мультиответ).
    var replyTo: [ReplyInfo] = []
    /// Не-nil, когда сообщение переслано (рисуется конверт пересылки + цитата оригинала).
    var forwardFrom: ForwardInfo?
    /// Длительность голосового в секундах (`metadata.duration`); nil для не-аудио.
    var audioDurationSec: Int?
    /// Предрассчитанные амплитуды (0..100) волны голосового (`metadata.waveform`).
    var waveform: [Int]?
    /// Open Graph-превью первой ссылки, когда сервер его разрешил.
    var linkPreview: LinkPreview?
}
