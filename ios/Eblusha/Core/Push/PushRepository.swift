import Foundation

/// Порт `data/repository/PushRepository.kt` (FCM → APNs).
///
/// Отличие платформы: у iOS-клиента ДВА токена вместо одного FCM —
///  - alert-токен (didRegisterForRemoteNotificationsWithDeviceToken) — сообщения
///    и тихий background-пуш call-cancel; регистрируется как provider `apns`;
///  - VoIP-токен из PushKit — звонки: только он гарантированно будит убитое
///    приложение; регистрируется как provider `apns-voip`.
///
/// Все методы «мягкие», как в Kotlin-оригинале: токена может не быть (симулятор,
/// нет сети до APNs, пользователь запретил уведомления) — и это НЕ ошибка, доставку
/// онлайн-клиенту по-прежнему везёт постоянный сокет. Ни один сбой отсюда не должен
/// мешать входу в аккаунт или бутстрапу ключей — наружу исключения не выпускаем.
final class PushRepository {

    /// Синглтон в стиле AppLifecycle: AppContainer не редактируем, а до репозитория
    /// должны дотягиваться и PushAppDelegate, и PKPushRegistryDelegate, и RootView.
    static let shared = PushRepository(
        api: AppContainer.shared.api,
        session: AppContainer.shared.sessionStore,
        deviceIdProvider: AppContainer.shared.deviceIdProvider
    )

    private let api: APIClient
    private let session: SessionStore
    private let deviceIdProvider: DeviceIdProvider

    // Системные колбэки выдают токены КОГДА захотят — часто до логина (PushKit отдаёт
    // кэшированный токен сразу после установки desiredPushTypes). Кешируем и шлём,
    // когда syncTokens() позовут в правильной точке: ПОСЛЕ ensureDeviceBootstrap,
    // потому что /devices/{id}/push отвечает 404 незарегистрированному устройству.
    private let lock = NSLock()
    private var alertTokenValue: String?
    private var voipTokenValue: String?

    init(api: APIClient, session: SessionStore, deviceIdProvider: DeviceIdProvider) {
        self.api = api
        self.session = session
        self.deviceIdProvider = deviceIdProvider
    }

    // MARK: - Приём токенов от системы

    /// Из `application(_:didRegisterForRemoteNotificationsWithDeviceToken:)`.
    /// Система может выдавать токен повторно при каждом registerForRemoteNotifications —
    /// пере-регистрация на сервере идемпотентна (upsert по deviceId).
    func updateAlertToken(_ deviceToken: Data) {
        lock.lock()
        alertTokenValue = Self.hex(deviceToken)
        lock.unlock()
        Task { await syncTokens() }
    }

    /// Из `pushRegistry(_:didUpdate:for:)` (PushKit).
    func updateVoipToken(_ token: Data) {
        lock.lock()
        voipTokenValue = Self.hex(token)
        lock.unlock()
        Task { await syncTokens() }
    }

    /// Из `pushRegistry(_:didInvalidatePushTokenFor:)`: токен мёртв, слать его серверу
    /// больше нельзя. Сервер сам снимет его при первой неудачной доставке (410 Gone).
    func invalidateVoipToken() {
        lock.lock()
        voipTokenValue = nil
        lock.unlock()
    }

    // MARK: - Синхронизация с сервером

    /// Взять текущие токены и отдать серверу. Вызывается после логина (СТРОГО после
    /// SecretRepository.ensureDeviceBootstrap — см. RootView) и при смене любого токена.
    ///
    /// ВАЖНО (ограничение бэкенда на сегодня): UserDevice хранит ОДИН pushToken на
    /// устройство, второй POST перезатирает первый. Поэтому порядок фиксированный:
    /// voip первым, alert ПОСЛЕДНИМ — до появления второго слота на сервере выигрывают
    /// сообщения (звонки доедут alert-fallback'ом с priority 10, см. src/push/apns.ts),
    /// а после правки бэкенда (отдельный pushVoipToken) порядок станет безразличен.
    func syncTokens() async {
        // Без сессии некуда: bearer не подставится и сервер ответит 401. Порт проверки
        // PushTokens.configured — «нет предпосылок → тихо выходим».
        guard session.currentRefreshToken() != nil else { return }
        let (voip, alert) = currentTokens()
        if let voip { await register(token: voip, provider: "apns-voip") }
        if let alert { await register(token: alert, provider: "apns") }
    }

    private func currentTokens() -> (voip: String?, alert: String?) {
        lock.lock()
        defer { lock.unlock() }
        return (voipTokenValue, alertTokenValue)
    }

    private func register(token: String, provider: String) async {
        do {
            try await api.postIgnoringResponse(
                "devices/\(deviceIdProvider.deviceId())/push",
                body: PushTokenRequest(token: token, provider: provider)
            )
        } catch {
            // 404 здесь — устройство ещё не прошло /devices/register (бутстрап ключей
            // не успел); не ошибка: следующий syncTokens доедет. Порт Log.i из Kotlin.
            NSLog("PushRepository: push token not registered: %@", String(describing: error))
        }
    }

    /// Снятие при выходе. ВАЖНО вызывать ДО очистки сессии: без токена доступа запрос
    /// уйдёт без авторизации, и чужой аккаунт на этом телефоне продолжил бы получать
    /// уведомления. (Дословный порт предупреждения из Kotlin-оригинала.)
    func unregister() async {
        do {
            let _: OkResponse = try await api.delete("devices/\(deviceIdProvider.deviceId())/push")
        } catch {
            NSLog("PushRepository: push token not unregistered: %@", String(describing: error))
        }
        // Локальные токены НЕ выбрасываем: у APNs, в отличие от FCM, нет deleteToken —
        // токен принадлежит установке приложения, и следующий логин зарегистрирует
        // его заново тем же значением.
    }

    // MARK: - Wire-формат

    /// Тело POST /devices/{deviceId}/push — байт-в-байт с Android PushTokenRequest.
    private struct PushTokenRequest: Encodable {
        let token: String
        let provider: String
    }

    /// Ответ `{ ok: true }` обоих push-эндпоинтов.
    private struct OkResponse: Decodable {
        var ok: Bool?
    }

    /// APNs-токен — сырые байты; на сервер уходит канонический lowercase-hex
    /// (ровно то, что кладут в `/3/device/{token}`).
    private static func hex(_ data: Data) -> String {
        data.map { String(format: "%02x", $0) }.joined()
    }
}
