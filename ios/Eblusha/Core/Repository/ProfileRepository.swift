import Foundation

// Порт `data/repository/ProfileRepository.kt` + модели настроек/устройств из
// `domain/model/SocialModels.kt` (DevicePairing, DeviceSession — остальная часть того
// файла уже портирована в Domain/SocialModels.swift контактами: UserProfile, InviteCode).
//
// В Kotlin репозиторий собран из четырёх Retrofit-интерфейсов (StatusApi, DevicesApi,
// InviteApi, UploadApi); здесь их роль играет общий APIClient — пути и тела те же.

/// Короткоживущий QR/код для привязки другого устройства к этому аккаунту.
struct DevicePairing: Equatable {
    let token: String
    let code: String?
    let expiresAt: String?

    /// Строка, кодируемая в QR, который сканирует другое устройство.
    var qrPayload: String { "EBLUSHA_LINK_DEVICE:\(token)" }
}

/// Активный сеанс (привязанное устройство), показываемый в профиле.
struct DeviceSession: Identifiable, Equatable {
    let id: String
    let name: String
    let platform: String?
    let location: String?
    let ip: String?
    let lastSeenMs: Int64?
    let keysReady: Bool
    let isCurrent: Bool
}

final class ProfileRepository {
    private let api: APIClient
    private let deviceIdProvider: DeviceIdProvider
    private let session: SessionStore

    init(api: APIClient, deviceIdProvider: DeviceIdProvider, session: SessionStore) {
        self.api = api
        self.deviceIdProvider = deviceIdProvider
        self.session = session
    }

    func me() async -> ApiResult<UserProfile> {
        await safeApiCall {
            let response: MeResponse = try await api.get("status/me")
            return toDomain(response.user)
        }
    }

    func updateProfile(
        displayName: String?,
        bio: String?,
        avatarUrl: String?
    ) async -> ApiResult<UserProfile> {
        await safeApiCall {
            let response: MeResponse = try await api.patch(
                "status/me",
                body: UpdateProfileRequest(displayName: displayName, bio: bio, avatarUrl: avatarUrl)
            )
            let updated = toDomain(response.user)
            // Держим кешированного пользователя сессии (нижняя строка «я» в списке
            // чатов, аватары) в синхроне с правкой.
            session.updateProfile(displayName: updated.displayName, avatarUrl: updated.avatarUrl)
            return updated
        }
    }

    /// Ручной статус присутствия (ONLINE/AWAY/DND/OFFLINE) — PATCH /status/me, веб-паритет.
    func updateStatus(_ status: String) async -> ApiResult<UserProfile> {
        await safeApiCall {
            let response: MeResponse = try await api.patch(
                "status/me", body: UpdateProfileRequest(status: status)
            )
            return toDomain(response.user)
        }
    }

    /// Загружает байты аватара и возвращает прокси-URL для сохранения через `updateProfile`.
    func uploadAvatar(bytes: Data, mime: String) async -> ApiResult<String> {
        await safeApiCall {
            // Тот же multipart-путь `file`, что и у вложений (порт UploadApi.upload;
            // имя части — "avatar", как в Kotlin-оригинале).
            let uploaded: UploadResponse = try await api.uploadMultipart(
                "upload", fileName: "avatar", mime: mime, data: bytes
            )
            return uploaded.url
        }
    }

    func startDevicePairing() async -> ApiResult<DevicePairing> {
        await safeApiCall {
            let r: PairingStartResponse = try await api.postEmpty("devices/pairing/start")
            return DevicePairing(token: r.token, code: r.code, expiresAt: r.expiresAt)
        }
    }

    func inviteCode() async -> ApiResult<InviteCode> {
        await safeApiCall {
            let r: RegisterCodeResponse = try await api.get("auth/register/code")
            return toDomain(r)
        }
    }

    func refreshInviteCode() async -> ApiResult<InviteCode> {
        await safeApiCall {
            let r: RegisterCodeResponse = try await api.postEmpty("auth/register/code/refresh")
            return toDomain(r)
        }
    }

    func listSessions() async -> ApiResult<[DeviceSession]> {
        await safeApiCall {
            let currentId = deviceIdProvider.deviceId()
            let response: DevicesListResponse = try await api.get("devices")
            return response.devices
                .filter { $0.revokedAt == nil }
                .map { toDomain($0, currentDeviceId: currentId) }
                .sorted { a, b in
                    // Текущее устройство первым, дальше — по свежести активности.
                    if a.isCurrent != b.isCurrent { return a.isCurrent }
                    return (a.lastSeenMs ?? 0) > (b.lastSeenMs ?? 0)
                }
        }
    }

    func revokeSession(deviceId: String) async -> ApiResult<Void> {
        await safeApiCall { try await api.deleteIgnoringResponse("devices/\(deviceId)") }
    }

    func revokeOtherSessions() async -> ApiResult<Void> {
        await safeApiCall {
            let _: EmptyResponse = try await api.postEmpty("devices/revoke-others")
        }
    }

    // MARK: - Маппинг DTO → домен (порт toDomain из Kotlin)

    private func toDomain(_ r: RegisterCodeResponse) -> InviteCode {
        InviteCode(code: r.code, expiresAtMs: parseIsoToMillis(r.expiresAt))
    }

    private func toDomain(_ dto: DeviceDto, currentDeviceId: String) -> DeviceSession {
        func nonBlank(_ s: String?) -> String? {
            guard let s, !s.trimmed().isEmpty else { return nil }
            return s
        }
        let locParts = [dto.lastCity, dto.lastCountry].compactMap(nonBlank)
        return DeviceSession(
            id: dto.id,
            name: nonBlank(dto.name) ?? nonBlank(dto.platform) ?? "Устройство",
            platform: dto.platform,
            location: locParts.isEmpty ? nil : locParts.joined(separator: ", "),
            ip: dto.lastIp,
            lastSeenMs: parseIsoToMillis(dto.lastSeenAt ?? dto.createdAt),
            keysReady: dto.signedPreKey != nil || (dto.availablePrekeys ?? 0) > 0,
            isCurrent: dto.id == currentDeviceId
        )
    }

    private func toDomain(_ dto: UserProfileDto) -> UserProfile {
        UserProfile(
            id: dto.id,
            username: dto.username,
            eblid: dto.eblid,
            displayName: dto.displayName,
            bio: dto.bio,
            avatarUrl: dto.avatarUrl,
            status: dto.status
        )
    }
}

// MARK: - PATCH (недостающий режим базового APIClient)

/// Базовый APIClient умеет только GET/POST/DELETE с JSON-телом; его приватные
/// внутренности из другого файла недоступны, поэтому PATCH собирается из тех же
/// кирпичей заново: AppConfig.apiBaseURL + токен и deviceId из AppContainer
/// (тот же приём, что у multipart в ChatRepositoryUploads).
extension APIClient {

    func patch<In: Encodable, Out: Decodable>(_ path: String, body: In) async throws -> Out {
        let encoded = try JSONEncoder().encode(body)
        func build() -> URLRequest {
            var request = URLRequest(url: AppConfig.apiBaseURL.appendingPathComponent(path))
            request.httpMethod = "PATCH"
            request.setValue(
                AppContainer.shared.deviceIdProvider.deviceId(), forHTTPHeaderField: "x-device-id"
            )
            if let token = AppContainer.shared.sessionStore.currentAccessToken() {
                request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            }
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = encoded
            return request
        }
        // Порт TokenAuthenticator для путей мимо базового клиента: на 401 —
        // одна тихая ротация токена и один повтор ([build] зовётся заново,
        // чтобы подцепить свежий Bearer).
        let (data, response) = try await URLSession.shared.data(for: build())
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        if code == 401, AppContainer.shared.sessionStore.currentRefreshToken() != nil {
            await AppContainer.shared.authRepository.tryBootstrap()
            let (retryData, retryResponse) = try await URLSession.shared.data(for: build())
            let retryCode = (retryResponse as? HTTPURLResponse)?.statusCode ?? 0
            guard (200..<300).contains(retryCode) else {
                throw HTTPError(code: retryCode, body: retryData)
            }
            return try JSONDecoder().decode(Out.self, from: retryData)
        }
        guard (200..<300).contains(code) else {
            throw HTTPError(code: code, body: data)
        }
        return try JSONDecoder().decode(Out.self, from: data)
    }
}
