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

/// Ответ GET `calls/{callId}/e2ee-key` — общий ключ шифрования 1:1-звонка
/// (callId == conversationId). Ключ выдаёт сервер: это шифрование через сервер, не
/// сквозное. Для группы сервер отвечает 404, но группы сюда и не ходят; для личного
/// звонка любой сбой этой ручки означает «звонок не начат», а не открытую комнату.
struct E2eeKeyResponse: Decodable {
    let key: String
}
