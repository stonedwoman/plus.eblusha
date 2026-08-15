import Foundation

// Порт `data/remote/dto/SocialDtos.kt`. Имена JSON-полей повторяют бэкенд один в один —
// это общая совместимость с вебом. CreateConversationRequest/CreateConversationResponse
// уже живут в ActionDTOs.swift — здесь их НЕТ (не дублировать!).

// MARK: - Контакты

struct ContactsResponse: Decodable {
    var contacts: [ContactDto] = []

    private enum CodingKeys: String, CodingKey { case contacts }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        contacts = try c.decodeIfPresent([ContactDto].self, forKey: .contacts) ?? []
    }
}

struct ContactDto: Decodable {
    let id: String
    var status: String?    // ACCEPTED | PENDING | BLOCKED
    var direction: String? // incoming | outgoing
    var friend: UserBriefDto?
}

struct UserSearchResponse: Decodable {
    var results: [UserBriefDto] = []

    private enum CodingKeys: String, CodingKey { case results }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        results = try c.decodeIfPresent([UserBriefDto].self, forKey: .results) ?? []
    }
}

/// Карточка пользователя добавляет по userId (логина она не видит); поиск — по identifier.
struct AddContactRequest: Encodable {
    var identifier: String?
    var userId: String?
}

struct ContactActionResponse: Decodable {
    var contact: ContactDto?
}

struct RespondContactRequest: Encodable {
    let contactId: String
    let action: String // accept | reject | block
}

struct RemoveContactRequest: Encodable {
    let contactId: String
}

// MARK: - Карточка пользователя (GET /users/:id)

struct UserCardResponse: Decodable {
    let user: UserCardDto
}

/// Публичный мини-профиль ДРУГОГО пользователя. Сервер сознательно не отдаёт `username`
/// (это секрет входа — риск подбора пароля); идентичность — EBLID.
struct UserCardDto: Decodable {
    let id: String
    var eblid: String?
    var displayName: String?
    var bio: String?
    var avatarUrl: String?
    var avatars: [String] = [] // текущий + прошлые аватары, свежие первыми
    var status: String?
    var lastSeenAt: String?
    var createdAt: String?

    private enum CodingKeys: String, CodingKey {
        case id, eblid, displayName, bio, avatarUrl, avatars, status, lastSeenAt, createdAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        eblid = try c.decodeIfPresent(String.self, forKey: .eblid)
        displayName = try c.decodeIfPresent(String.self, forKey: .displayName)
        bio = try c.decodeIfPresent(String.self, forKey: .bio)
        avatarUrl = try c.decodeIfPresent(String.self, forKey: .avatarUrl)
        avatars = try c.decodeIfPresent([String].self, forKey: .avatars) ?? []
        status = try c.decodeIfPresent(String.self, forKey: .status)
        lastSeenAt = try c.decodeIfPresent(String.self, forKey: .lastSeenAt)
        createdAt = try c.decodeIfPresent(String.self, forKey: .createdAt)
    }
}

// MARK: - Профиль / статус

struct MeResponse: Decodable {
    let user: UserProfileDto
}

struct UserProfileDto: Decodable {
    let id: String
    let username: String
    var eblid: String?
    var displayName: String?
    var bio: String?
    var avatarUrl: String?
    var status: String?
    var lastSeenAt: String?
}

struct UpdateProfileRequest: Encodable {
    var displayName: String?
    var bio: String?
    var status: String?
    var avatarUrl: String?
}

// MARK: - Привязка устройства (QR-линковка)

struct PairingStartResponse: Decodable {
    let token: String
    var code: String?
    var newDeviceId: String?
    var expiresAt: String?
}

// MARK: - Код регистрации

/// Порт RegisterCodeResponse из `data/remote/dto/SessionDtos.kt` — нужен карточке
/// «Код регистрации» на экране контактов. При порте остальной части SessionDtos
/// (фаза 6, настройки/устройства) НЕ объявлять заново — тип уже здесь.
struct RegisterCodeResponse: Decodable {
    let code: String
    var expiresAt: String?
    var digits: Int?
}
