import Foundation

// Порт DTO действий над сообщениями/беседами (`data/remote/dto/MessageActionDtos.kt`
// и запросы из ChatApi.kt).

struct ReactionRequest: Encodable {
    let messageId: String
    let emoji: String
}

struct MessageIdRequest: Encodable {
    let messageId: String
}

struct UpdateMessageRequest: Encodable {
    let messageId: String
    let content: String
}

struct MarkReadRequest: Encodable {
    let conversationId: String
}

struct AddParticipantsRequest: Encodable {
    let participantIds: [String]
}

struct UpdateConversationRequest: Encodable {
    var title: String?
    var avatarUrl: String?
}

struct CreateConversationRequest: Encodable {
    let participantIds: [String]
    var title: String?
    var isGroup: Bool?
    var isSecret: Bool?
    var initiatorDeviceId: String?
}

struct CreateConversationResponse: Decodable {
    let conversation: ConversationDto
    var duplicated: Bool?
}
