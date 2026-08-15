import Foundation

// Порт `data/remote/LiveKitApi.kt` — DTO ручек LiveKit и звонков.
// Имена JSON-полей — общий wire-формат с вебом и Android, менять нельзя.

/// Тело POST `livekit/token`. Имя комнаты — конвенция веб-клиента: `conv-{conversationId}`.
struct LiveKitTokenRequest: Encodable {
    let room: String
    var participantName: String?
    var participantMetadata: [String: String]?
}

struct LiveKitTokenResponse: Decodable {
    let token: String
    let url: String
}

/// Ответ GET `calls/{callId}/e2ee-key` — общий E2EE-ключ 1:1-звонка
/// (callId == conversationId). Для группы/выключенного E2EE сервер отвечает 404.
struct E2eeKeyResponse: Decodable {
    let key: String
}
