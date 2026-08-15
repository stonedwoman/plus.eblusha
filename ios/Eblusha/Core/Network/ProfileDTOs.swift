import Foundation

// Порт остатка `data/remote/dto/SessionDtos.kt` — активные сеансы (устройства)
// для экрана настроек. Имена JSON-полей повторяют бэкенд один в один.
//
// Профильные DTO из SocialDtos.kt (MeResponse, UserProfileDto, UpdateProfileRequest,
// UserCardResponse/UserCardDto, PairingStartResponse, RegisterCodeResponse) уже живут
// в SocialDTOs.swift — здесь их НЕТ (не дублировать!). DTO серверного pairing-резолва
// (PairingResolveRequest/Response, PairingConsumeRequest) приедут с портом E2EE-линковки.
//
// Ручка-источник (порт `DevicesApi.kt`): GET /devices → DevicesListResponse.

struct DevicesListResponse: Decodable {
    var devices: [DeviceDto] = []

    private enum CodingKeys: String, CodingKey { case devices }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        devices = try c.decodeIfPresent([DeviceDto].self, forKey: .devices) ?? []
    }
}

struct DeviceDto: Decodable {
    let id: String
    var name: String?
    var platform: String?
    var createdAt: String?
    var lastSeenAt: String?
    var revokedAt: String?
    var lastIp: String?
    var lastCountry: String?
    var lastCity: String?
    var signedPreKey: JSONValue? // наличие => ключи E2EE готовы
    var availablePrekeys: Int?
}
