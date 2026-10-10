import Foundation

/// Порт `data/realtime/RealtimeEvents.kt`: типизированные события реального времени.
enum RealtimeEvent {
    /// Сокет заново подключился (реконнект): состояние комнат на сервере обнулилось.
    case socketReconnected
    case messageNew(conversationId: String, messageId: String, senderId: String, message: MessageDto?)
    case messageNotify(conversationId: String, messageId: String, senderId: String, message: MessageDto?)
    /// `message:update`: правка, удаление, превью ссылки, смена карточки бота. `info` — что сервер
    /// приложил (причина, само сообщение, карточка, его часы); у старого сервера — пусто.
    case messageUpdate(conversationId: String, messageId: String, info: MessageUpdateInfo)
    case messageReaction(conversationId: String, messageId: String)
    case receipts(conversationId: String, messageIds: [String], userId: String?, status: String?)
    /// `isBot` — печатает системный бот «Еблуша» (он не участник беседы).
    case typing(conversationId: String, userId: String, isTyping: Bool, displayName: String?, isBot: Bool)
    case presence(userId: String, status: String, device: String?)
    case conversationsChanged(conversationId: String, kind: String)

    /// Любое движение по заявкам/друзьям: экран контактов перечитывает списки.
    case contactsChanged(kind: String)
    /// Будильник per-device секретного инбокса — шифртекста НЕ несёт; по приходу тянем инбокс.
    case secretNotify(toDeviceId: String?, msgId: String?)
    /// Собеседник принял секретный чат на ОДНОМ устройстве → создатель ключует ровно его.
    case secretChatAccepted(conversationId: String, peerDeviceId: String)
    /// X5: устройство отозвано. `device:revoked` — сервер выгнал комнату устройства
    /// (deviceId) или весь аккаунт ("*": бан/удаление); connect_error `DEVICE_REVOKED`
    /// (viaConnectError) — ни один id рукопожатия не жив, deviceId — тот, с которым мы
    /// стучались. Что делать, решает SecretRepository.revocationVerdict.
    case deviceRevoked(deviceId: String?, viaConnectError: Bool)

    case callIncoming(conversationId: String, fromUserId: String, fromName: String, video: Bool)
    /// `live` — ответ на приглашение в УЖЕ идущий разговор (вход своим вторым устройством),
    /// а не ответ собеседника на новый звонок (сервер, ревью этапа 0 E2EE).
    case callAccepted(conversationId: String, byUserId: String, video: Bool, live: Bool)
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
    /// Только у call:accepted: вход в уже идущий разговор.
    var live: Bool = false

    private enum CodingKeys: String, CodingKey { case conversationId, by, video, live }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        conversationId = try c.decode(String.self, forKey: .conversationId)
        by = try c.decodeIfPresent(CallPeer.self, forKey: .by)
        video = try c.decodeIfPresent(Bool.self, forKey: .video) ?? false
        live = try c.decodeIfPresent(Bool.self, forKey: .live) ?? false
    }
}

struct MessageEventPayload: Decodable {
    let conversationId: String
    let messageId: String
    let senderId: String
    var message: MessageDto?
}

/// Что несёт `message:update` сверх адреса (SPEC-share §2.4):
/// `{ conversationId, messageId, reason, message?, cardType?, card?, serverNow? }`.
struct MessageUpdateInfo {
    var reason: String?
    var message: MessageDto?
    var cardType: String?
    var card: JSONValue?
    var serverNow: Date?

    static let empty = MessageUpdateInfo()
}

/// `message:update`. Отдельно от MessageEventPayload: у этого события НЕТ `senderId` (сервер шлёт
/// `{conversationId, messageId, reason, message?}`), и общий разбор с обязательным senderId молча
/// выбрасывал каждое такое событие — правки и удаления на айфоне не приходили вживую вовсе.
/// Всё, кроме адреса, необязательно и разбирается терпимо: кривое `message` не роняет событие.
struct MessageUpdatePayload: Decodable {
    let conversationId: String
    let messageId: String
    var info = MessageUpdateInfo.empty

    private enum CodingKeys: String, CodingKey {
        case conversationId, messageId, reason, message, cardType, card, serverNow
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        conversationId = try c.decode(String.self, forKey: .conversationId)
        messageId = try c.decode(String.self, forKey: .messageId)
        info = MessageUpdateInfo(
            reason: try? c.decodeIfPresent(String.self, forKey: .reason),
            message: try? c.decodeIfPresent(MessageDto.self, forKey: .message),
            cardType: try? c.decodeIfPresent(String.self, forKey: .cardType),
            card: try? c.decodeIfPresent(JSONValue.self, forKey: .card),
            serverNow: (try? c.decodeIfPresent(JSONValue.self, forKey: .serverNow))?.dateValue
        )
    }
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
    /// «Еблуша печатает…» (сервер шлёт isBot: true вместе с displayName бота).
    var isBot: Bool = false

    private enum CodingKeys: String, CodingKey { case conversationId, userId, isTyping, displayName, isBot }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        conversationId = try c.decode(String.self, forKey: .conversationId)
        userId = try c.decode(String.self, forKey: .userId)
        isTyping = try c.decodeIfPresent(Bool.self, forKey: .isTyping) ?? false
        displayName = try c.decodeIfPresent(String.self, forKey: .displayName)
        isBot = (try? c.decodeIfPresent(Bool.self, forKey: .isBot)) ?? false
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

struct DeviceRevokedPayload: Decodable {
    var deviceId: String?
    var reason: String?
}
