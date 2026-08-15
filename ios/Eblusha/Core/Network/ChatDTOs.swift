import Foundation

// Порт `data/remote/dto/ChatDtos.kt`. Поля повторяют JSON бэкенда один в один.
// JsonElement из kotlinx → JSONValue: metadata бывает объектом произвольной формы.

struct ConversationsResponse: Decodable {
    var conversations: [ConversationListItemDto] = []
}

/// GET /conversations отдаёт строки участника, оборачивающие беседу + непрочитанные.
struct ConversationListItemDto: Decodable {
    let conversation: ConversationDto
    var unreadCount: Int = 0

    private enum CodingKeys: String, CodingKey { case conversation, unreadCount }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        conversation = try c.decode(ConversationDto.self, forKey: .conversation)
        unreadCount = try c.decodeIfPresent(Int.self, forKey: .unreadCount) ?? 0
    }
}

struct ConversationDto: Decodable, Identifiable {
    let id: String
    var title: String?
    var avatarUrl: String?
    var isGroup: Bool = false
    var isSecret: Bool = false
    var type: String?               // "SECRET" = секретный тред V2 (isSecret один матчит и спящую легаси)
    var secretStatus: String?       // PENDING (приглашение) | ACTIVE | CANCELLED
    var secretInitiatorDeviceId: String?
    var secretPeerDeviceId: String? // ЕДИНСТВЕННОЕ устройство, на котором принят секретный чат
    var lastMessageAt: String?
    var createdById: String?
    var participants: [ParticipantDto] = []
    var messages: [MessageDto] = []

    private enum CodingKeys: String, CodingKey {
        case id, title, avatarUrl, isGroup, isSecret, type, secretStatus
        case secretInitiatorDeviceId, secretPeerDeviceId, lastMessageAt, createdById
        case participants, messages
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = try c.decodeIfPresent(String.self, forKey: .title)
        avatarUrl = try c.decodeIfPresent(String.self, forKey: .avatarUrl)
        isGroup = try c.decodeIfPresent(Bool.self, forKey: .isGroup) ?? false
        isSecret = try c.decodeIfPresent(Bool.self, forKey: .isSecret) ?? false
        type = try c.decodeIfPresent(String.self, forKey: .type)
        secretStatus = try c.decodeIfPresent(String.self, forKey: .secretStatus)
        secretInitiatorDeviceId = try c.decodeIfPresent(String.self, forKey: .secretInitiatorDeviceId)
        secretPeerDeviceId = try c.decodeIfPresent(String.self, forKey: .secretPeerDeviceId)
        lastMessageAt = try c.decodeIfPresent(String.self, forKey: .lastMessageAt)
        createdById = try c.decodeIfPresent(String.self, forKey: .createdById)
        participants = try c.decodeIfPresent([ParticipantDto].self, forKey: .participants) ?? []
        messages = try c.decodeIfPresent([MessageDto].self, forKey: .messages) ?? []
    }
}

struct ParticipantDto: Decodable {
    let userId: String
    var role: String?
    var user: UserBriefDto?
}

struct UserBriefDto: Decodable, Equatable {
    let id: String
    let username: String
    var displayName: String?
    var avatarUrl: String?
    var status: String?
    var lastSeenAt: String?
}

struct MessageDto: Decodable, Identifiable {
    let id: String
    let conversationId: String
    let senderId: String
    var type: String = "TEXT"
    var content: String?
    var contentEncV: Int = 0
    var metadata: JSONValue?
    var replyToId: String?
    var deletedAt: String?
    var expiresAt: String?
    let createdAt: String
    var updatedAt: String?
    var sender: UserBriefDto?
    var attachments: [AttachmentDto] = []
    var reactions: [ReactionDto] = []
    var receipts: [ReceiptDto] = []
    var replyTo: ReplyToDto?

    private enum CodingKeys: String, CodingKey {
        case id, conversationId, senderId, type, content, contentEncV, metadata
        case replyToId, deletedAt, expiresAt, createdAt, updatedAt, sender
        case attachments, reactions, receipts, replyTo
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        conversationId = try c.decode(String.self, forKey: .conversationId)
        senderId = try c.decode(String.self, forKey: .senderId)
        type = try c.decodeIfPresent(String.self, forKey: .type) ?? "TEXT"
        content = try c.decodeIfPresent(String.self, forKey: .content)
        contentEncV = try c.decodeIfPresent(Int.self, forKey: .contentEncV) ?? 0
        metadata = try c.decodeIfPresent(JSONValue.self, forKey: .metadata)
        replyToId = try c.decodeIfPresent(String.self, forKey: .replyToId)
        deletedAt = try c.decodeIfPresent(String.self, forKey: .deletedAt)
        expiresAt = try c.decodeIfPresent(String.self, forKey: .expiresAt)
        createdAt = try c.decode(String.self, forKey: .createdAt)
        updatedAt = try c.decodeIfPresent(String.self, forKey: .updatedAt)
        sender = try c.decodeIfPresent(UserBriefDto.self, forKey: .sender)
        attachments = try c.decodeIfPresent([AttachmentDto].self, forKey: .attachments) ?? []
        reactions = try c.decodeIfPresent([ReactionDto].self, forKey: .reactions) ?? []
        receipts = try c.decodeIfPresent([ReceiptDto].self, forKey: .receipts) ?? []
        replyTo = try c.decodeIfPresent(ReplyToDto.self, forKey: .replyTo)
    }
}

struct AttachmentDto: Decodable {
    var id: String?
    let url: String
    var type: String = "FILE"
    var size: Int64?
    var metadata: JSONValue?

    private enum CodingKeys: String, CodingKey { case id, url, type, size, metadata }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decodeIfPresent(String.self, forKey: .id)
        url = try c.decode(String.self, forKey: .url)
        type = try c.decodeIfPresent(String.self, forKey: .type) ?? "FILE"
        size = try c.decodeIfPresent(Int64.self, forKey: .size)
        metadata = try c.decodeIfPresent(JSONValue.self, forKey: .metadata)
    }
}

struct ReactionDto: Decodable {
    let emoji: String
    let userId: String
    var user: UserBriefDto?
}

struct ReceiptDto: Decodable {
    let userId: String
    let status: String
}

struct ReplyToDto: Decodable {
    let id: String
    var content: String?
    let senderId: String
    var createdAt: String?
}

struct MessagesResponse: Decodable {
    var messages: [MessageDto] = []
    var hasMore: Bool = false
    var nextCursor: String?
}

struct SendMessageRequest: Encodable {
    let conversationId: String
    var type: String = "TEXT"
    var content: String?
    var replyToId: String?
    var attachments: [AttachmentReq]?
    var metadata: JSONValue?
}

struct AttachmentReq: Encodable {
    let url: String
    let type: String
    var size: Int64?
    var metadata: AttachmentMetadataReq?
}

struct AttachmentMetadataReq: Encodable {
    var originalName: String?
    var mime: String?
    var objectKey: String?
    var width: Int?
    var height: Int?
}

struct SendMessageResponse: Decodable {
    let message: MessageDto
}

/// POST /api/upload (multipart `file`) → проксируемый URL скачивания + ключ хранилища.
struct UploadResponse: Decodable {
    let url: String
    var path: String?
    var publicUrl: String?
}

/// Аналог kotlinx JsonElement: metadata сообщений — JSON произвольной формы.
enum JSONValue: Codable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null }
        else if let value = try? container.decode(Bool.self) { self = .bool(value) }
        else if let value = try? container.decode(Double.self) { self = .number(value) }
        else if let value = try? container.decode(String.self) { self = .string(value) }
        else if let value = try? container.decode([JSONValue].self) { self = .array(value) }
        else if let value = try? container.decode([String: JSONValue].self) { self = .object(value) }
        else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "не JSON")
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        }
    }

    subscript(key: String) -> JSONValue? {
        if case .object(let dict) = self { return dict[key] }
        return nil
    }

    var stringValue: String? {
        if case .string(let value) = self { return value }
        return nil
    }

    var numberValue: Double? {
        if case .number(let value) = self { return value }
        return nil
    }
}
