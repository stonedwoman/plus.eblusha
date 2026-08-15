import Foundation

// Порт pairing-части `data/remote/dto/SessionDtos.kt` — серверная привязка нового
// устройства (новое устройство показывает QR/код, доверенное резолвит и гасит).
// Имена JSON-полей повторяют бэкенд один в один (src/routes/devices.ts).
//
// PairingStartResponse уже живёт в SocialDTOs.swift, DevicesListResponse/DeviceDto —
// в ProfileDTOs.swift; здесь только резолв/консьюм (обещаны комментарием ProfileDTOs).

/// POST /devices/pairing/resolve: token из QR ЛИБО короткий код — ровно одно из двух.
struct PairingResolveRequest: Encodable {
    var token: String?
    var code: String?
}

struct PairingResolveResponse: Decodable {
    let token: String
    var code: String?
    let newDevice: PairingDeviceDto
    var expiresAt: String?
}

/// Что за устройство просит привязку (имя/платформу знает только сервер).
struct PairingDeviceDto: Decodable {
    let id: String
    var name: String?
    var platform: String?
    var identityPublicKey: String?
    var createdAt: String?
}

/// POST /devices/pairing/consume — гасит приглашение после отправки ключей (одноразовость).
struct PairingConsumeRequest: Encodable {
    let token: String
}
