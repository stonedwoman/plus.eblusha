import Foundation

// Порт `data/remote/dto/AuthDtos.kt`. Имена полей повторяют JSON бэкенда один в один.

struct UserDto: Codable, Equatable {
    let id: String
    let username: String
    var displayName: String?
    var avatarUrl: String?
}

struct Inviter: Codable, Equatable {
    var id: String?
    var username: String?
    var displayName: String?
    var avatarUrl: String?
}

struct LoginRequest: Encodable {
    let username: String
    let password: String
}

struct RegisterRequest: Encodable {
    let username: String
    let displayName: String
    let password: String
    let registrationInviteToken: String
    var email: String?
    var phone: String?
}

struct InviteVerifyRequest: Encodable {
    let code: String
}

struct InviteVerifyResponse: Decodable {
    let registrationInviteToken: String
    var inviter: Inviter?
    var code: String?
    var expiresAt: String?
}

struct BootstrapRequest: Encodable {
    let refreshToken: String
    let client: String
    let deviceId: String
}

/// Ответ /auth/login, /auth/register и /mobile/session/bootstrap.
struct SessionResponse: Decodable {
    let user: UserDto
    let accessToken: String
    let refreshToken: String
    let expiresAt: String
    var sessionId: String?
}

struct LogoutRequest: Encodable {
    let refreshToken: String?
}
