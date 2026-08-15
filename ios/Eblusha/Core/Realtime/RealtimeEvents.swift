import Foundation

/// Порт `data/realtime/RealtimeEvents.kt`: типизированные события реального времени.
enum RealtimeEvent {
    /// Сокет заново подключился (реконнект): состояние комнат на сервере обнулилось.
    case socketReconnected
    case messageNew(conversationId: String, messageId: String, senderId: String, message: MessageDto?)
    case messageNotify(conversationId: String, messageId: String, senderId: String, message: MessageDto?)
    case messageUpdate(conversationId: String, messageId: String)
    case messageReaction(conversationId: String, messageId: String)
    case receipts(conversationId: String, messageIds: [String], userId: String?, status: String?)
    case typing(conversationId: String, userId: String, isTyping: Bool, displayName: String?)
    case presence(userId: String, status: String, device: String?)
    case conversationsChanged(conversationId: String, kind: String)

    /// Любое движение по заявкам/друзьям: экран контактов перечитывает списки.
    case contactsChanged(kind: String)
    /// Будильник per-device секретного инбокса — шифртекста НЕ несёт; по приходу тянем инбокс.
    case secretNotify(toDeviceId: String?, msgId: String?)
    /// Собеседник принял секретный чат на ОДНОМ устройстве → создатель ключует ровно его.
    case secretChatAccepted(conversationId: String, peerDeviceId: String)

    case callIncoming(conversationId: String, fromUserId: String, fromName: String, video: Bool)
    case callAccepted(conversationId: String, byUserId: String, video: Bool)
    case callDeclined(conversationId: String, byUserId: String)
    case callEnded(conversationId: String, byUserId: String)
}

// MARK: - Сырые полезные нагрузки Socket.IO

struct CallPeer: Decodable {
    var id: String?
    var name: String?
}

struct CallIncomingPayload: Decodable {
    let conversationId: String
    var from: CallPeer?
    var video: Bool = false

    private enum CodingKeys: String, CodingKey { case conversationId, from, video }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        conversationId = try c.decode(String.self, forKey: .conversationId)
        from = try c.decodeIfPresent(CallPeer.self, forKey: .from)
        video = try c.decodeIfPresent(Bool.self, forKey: .video) ?? false
    }
}

struct CallByPayload: Decodable {
    let conversationId: String
    var by: CallPeer?
    var video: Bool = false

    private enum CodingKeys: String, CodingKey { case conversationId, by, video }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        conversationId = try c.decode(String.self, forKey: .conversationId)
        by = try c.decodeIfPresent(CallPeer.self, forKey: .by)
        video = try c.decodeIfPresent(Bool.self, forKey: .video) ?? false
    }
}

struct MessageEventPayload: Decodable {
    let conversationId: String
    let messageId: String
    let senderId: String
    var message: MessageDto?
}

struct ReceiptsPayload: Decodable {
    let conversationId: String
    var messageIds: [String] = []
    var userId: String?
    var status: String?

    private enum CodingKeys: String, CodingKey { case conversationId, messageIds, userId, status }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        conversationId = try c.decode(String.self, forKey: .conversationId)
        messageIds = try c.decodeIfPresent([String].self, forKey: .messageIds) ?? []
        userId = try c.decodeIfPresent(String.self, forKey: .userId)
        status = try c.decodeIfPresent(String.self, forKey: .status)
    }
}

struct TypingPayload: Decodable {
    let conversationId: String
    let userId: String
    var isTyping: Bool = false
    var displayName: String?

    private enum CodingKeys: String, CodingKey { case conversationId, userId, isTyping, displayName }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        conversationId = try c.decode(String.self, forKey: .conversationId)
        userId = try c.decode(String.self, forKey: .userId)
        isTyping = try c.decodeIfPresent(Bool.self, forKey: .isTyping) ?? false
        displayName = try c.decodeIfPresent(String.self, forKey: .displayName)
    }
}

struct PresencePayload: Decodable {
    let userId: String
    let status: String
    /// С какого устройства человек в сети: "mobile" | "desktop" | "web" (nil — неизвестно).
    var device: String?
}

struct PresenceDeviceItem: Decodable {
    let userId: String
    var device: String?
}

/// Снапшот устройств для только что подключившегося сокета.
struct PresenceDeviceBatch: Decodable {
    var items: [PresenceDeviceItem] = []

    private enum CodingKeys: String, CodingKey { case items }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        items = try c.decodeIfPresent([PresenceDeviceItem].self, forKey: .items) ?? []
    }
}

struct ConversationEventPayload: Decodable {
    let conversationId: String
}

struct SecretNotifyPayload: Decodable {
    var toDeviceId: String?
    var msgId: String?
}

struct SecretChatAcceptedPayload: Decodable {
    let conversationId: String
    let peerDeviceId: String
}
