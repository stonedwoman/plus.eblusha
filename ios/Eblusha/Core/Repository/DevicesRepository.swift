import Foundation

/// Порт устройство-ориентированной части `data/remote/DevicesApi.kt` + `data/remote/E2eeApi.kt`
/// и push-обвязки `data/repository/PushRepository.kt` (бэкенд: src/routes/devices.ts, e2ee.ts).
///
/// Регистрация ключей устройства, prekey-бандлы собеседников и push-токены. Методы E2EE —
/// «сырые» (throws): движку секреток (порт SecretRepository) нужен код HTTP-ошибки, в первую
/// очередь 409 на /devices/register. Заголовок x-device-id добавляет сам APIClient.
///
/// Список сеансов для ЭКРАНА настроек уже живёт в ProfileRepository (listDevices/revoke…) —
/// здесь только сырой `list()` для логики E2EE, не дублировать UI-обвязку.
final class DevicesRepository {
    private let api: APIClient
    private let deviceIdProvider: DeviceIdProvider

    init(api: APIClient, deviceIdProvider: DeviceIdProvider) {
        self.api = api
        self.deviceIdProvider = deviceIdProvider
    }

    // MARK: - Регистрация ключей (E2EE-бутстрап)

    /// POST /devices/register: identity + пачка one-time prekeys (идемпотентно для устройства).
    ///
    /// 409 НЕ обрабатывается здесь: это «id установки закреплён за другим аккаунтом»
    /// (device-id переживает logout). ВЫЗЫВАЮЩИЙ обязан сделать deviceIdProvider.rotate(),
    /// повторить register с новым id и переподключить сокет
    /// (RealtimeClient.reconnectForDeviceChange) — иначе secret:notify уходил бы в комнату
    /// старого устройства (см. ensureDeviceBootstrap в Kotlin-оригинале).
    func register(_ body: RegisterDeviceRequest) async throws {
        try await api.postIgnoringResponse("devices/register", body: body)
    }

    /// POST /devices/{deviceId}/prekeys — пополнение пула one-time prekeys
    /// (когда сервер сообщает, что тот иссякает: kind="prekeys_needed").
    func publishPrekeys(deviceId: String, _ body: PublishPrekeysRequest) async throws {
        try await api.postIgnoringResponse("devices/\(deviceId)/prekeys", body: body)
    }

    // MARK: - Ключи собеседников (E2eeApi)

    /// GET /e2ee/prekeys/bundles?userId= — identity-ключи всех устройств пользователя.
    func prekeyBundles(userId: String) async throws -> PrekeyBundlesResponse {
        try await api.get("e2ee/prekeys/bundles", query: [URLQueryItem(name: "userId", value: userId)])
    }

    /// POST /e2ee/prekeys/claim — атомарно забрать один one-time prekey устройства.
    func claimPrekey(deviceId: String) async throws -> ClaimPrekeyResponse {
        try await api.post("e2ee/prekeys/claim", body: ClaimPrekeyRequest(deviceId: deviceId))
    }

    // MARK: - Список устройств

    /// GET /devices — сырой список сеансов аккаунта (для логики E2EE-фанаута).
    func list() async throws -> DevicesListResponse {
        try await api.get("devices")
    }

    /// Есть ли у аккаунта другие (не отозванные) устройства — иначе просить ключи не у кого.
    /// Мягкий, как в оригинале: сбой сети = false, а не ошибка.
    func hasOtherDevices() async -> Bool {
        let me = deviceIdProvider.deviceId()
        guard let response = try? await list() else { return false }
        return response.devices.contains { $0.revokedAt == nil && $0.id != me }
    }

    // MARK: - Push-токены (порт PushRepository: все методы «мягкие»)

    /// POST /devices/{deviceId}/push. Провал НЕ должен мешать логину или бутстрапу ключей —
    /// доставку без пушей по-прежнему везёт постоянный сокет. provider: "apns" — обычные
    /// уведомления, "apns-voip" — токен PushKit для входящих звонков.
    /// ВАЖНО: устройство должно быть уже зарегистрировано (/devices/register), иначе 404.
    @discardableResult
    func registerPushToken(_ token: String, provider: String = "apns") async -> Bool {
        do {
            try await api.postIgnoringResponse(
                "devices/\(deviceIdProvider.deviceId())/push",
                body: PushTokenRequest(token: token, provider: provider)
            )
            return true
        } catch {
            // Мягко: без токена живём на сокете (порт PushRepository.register).
            return false
        }
    }

    /// DELETE /devices/{deviceId}/push — снятие при выходе. ВАЖНО вызывать ДО очистки сессии:
    /// без токена доступа запрос уйдёт неавторизованным, и чужой аккаунт на этом телефоне
    /// продолжил бы получать уведомления.
    @discardableResult
    func unregisterPushToken() async -> Bool {
        do {
            try await api.deleteIgnoringResponse("devices/\(deviceIdProvider.deviceId())/push")
            return true
        } catch {
            return false
        }
    }
}
