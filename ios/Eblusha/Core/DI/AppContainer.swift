import Foundation

/// Порт `core/di/AppContainer.kt` — ручной DI-контейнер, один на процесс.
/// В Android он висит на Application; здесь — синглтон, к которому обращаются
/// App-уровень и вью-модели.
final class AppContainer {
    static let shared = AppContainer()

    let sessionStore: SessionStore
    let deviceIdProvider: DeviceIdProvider
    let api: APIClient
    let authRepository: AuthRepository
    let realtimeClient: RealtimeClient
    let chatRepository: ChatRepository
    let contactsRepository: ContactsRepository
    let profileRepository: ProfileRepository
    let liveKitRepository: LiveKitRepository
    let callManager: CallManager
    let devicesRepository: DevicesRepository
    let secretKeyStore: SecretKeyStore
    let secretRepository: SecretRepository

    private init() {
        let session = SessionStore()
        let deviceId = DeviceIdProvider()
        self.sessionStore = session
        self.deviceIdProvider = deviceId
        self.api = APIClient(session: session, deviceIdProvider: deviceId)
        self.authRepository = AuthRepository(api: api, session: session, deviceIdProvider: deviceId)
        self.realtimeClient = RealtimeClient(session: session, deviceIdProvider: deviceId, api: api)
        self.chatRepository = ChatRepository(api: api, session: session)
        self.contactsRepository = ContactsRepository(api: api, session: session)
        self.profileRepository = ProfileRepository(api: api, deviceIdProvider: deviceId, session: session)
        self.liveKitRepository = LiveKitRepository(api: api, session: session)
        // CallManager сам подписывается на realtime.events и AppLifecycle в init —
        // создаём его жадно, чтобы входящие звонки ловились без открытого UI звонка.
        self.callManager = CallManager(
            realtime: realtimeClient,
            liveKit: liveKitRepository,
            session: session,
            chatRepository: chatRepository
        )
        self.devicesRepository = DevicesRepository(api: api, deviceIdProvider: deviceId)
        self.secretKeyStore = SecretKeyStore()
        self.secretRepository = SecretRepository(
            api: api,
            devices: devicesRepository,
            keyStore: secretKeyStore,
            deviceIdProvider: deviceId,
            session: session
        )
        // Рукопожатие сокета несёт deviceId: после ротации (409 на /devices/register)
        // сервер держал бы нас в комнате старого устройства и secret:notify не доходил бы.
        secretRepository.onDeviceIdRotated = { [weak realtimeClient] in
            realtimeClient?.reconnectForDeviceChange()
        }
        // Секретный чат из карточки контакта заводится через ContactsRepository.
        contactsRepository.secretRepository = secretRepository
    }

    /// Порт container.clearLocalData(): при выходе стираем всё локальное.
    func clearLocalData() {
        chatRepository.clearLocalData()
        // Ключи тредов, prekeys, идентичность устройства и расшифрованные вложения.
        secretRepository.clearLocalData()
        PresenceDevices.shared.clear()
    }

    /// Прогрев на старте: поднять сессию из Keychain (порт container.warmup()).
    func warmup() {
        sessionStore.load()
    }
}
