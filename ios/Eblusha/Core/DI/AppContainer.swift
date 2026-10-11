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
        // Повторная регистрация устройства (ре-бутстрап после 400/403 инбокса, ротация
        // id) создаёт новую запись без push-токенов — переносим их сразу, не дожидаясь
        // следующего логина или холодного старта.
        secretRepository.onDeviceBootstrapped = {
            Task { await PushRepository.shared.syncTokens() }
        }
        // Секретный чат из карточки контакта заводится через ContactsRepository.
        contactsRepository.secretRepository = secretRepository
        // «Без звука» и значок приложения по списку бесед и по прочтению. Только замыкания: сами
        // хранилища берут AppContainer.shared, и трогать их из этого init нельзя (рекурсия
        // инициализации синглтона).
        chatRepository.onListLoaded = { batch in
            let mutes = ConversationMuteStore.shared
            mutes.applyList(
                owner: batch.owner, items: batch.mutes,
                serverNowMs: batch.serverNowMs, requestedAtMs: batch.requestedAtMs
            )
            AppBadge.shared.listLoaded(
                owner: batch.owner, unread: batch.unread,
                atMs: batch.serverNowMs ?? (batch.requestedAtMs + mutes.state.serverOffsetMs)
            )
        }
        chatRepository.onConversationRead = { conversationId in
            AppBadge.shared.conversationRead(conversationId)
        }
    }

    /// Порт container.clearLocalData(): при выходе стираем всё локальное.
    func clearLocalData() {
        DraftStore.clear()
        // Неотправленный текст секреток лежит на диске (ключ треда может ехать минутами) —
        // новому владельцу сессии он не достаётся.
        SecretOutbox.clear()
        chatRepository.clearLocalData()
        // Ключи тредов, prekeys, идентичность устройства и расшифрованные вложения.
        secretRepository.clearLocalData()
        // Расшифровки голосовых — это содержимое переписки открытым текстом (в том числе
        // из секреток), поэтому логаут их стирает вместе со всем остальным.
        TranscriptStore.shared.clear()
        PresenceDevices.shared.clear()
        // Игры и звонки — такое же присутствие: новому владельцу сессии показывать,
        // кто во что играл и где шёл звонок, нельзя.
        PresenceGames.shared.clear()
        CallStatusStore.shared.clear()
        // Местное время собеседников прошлой сессии и её настройка в памяти (сама настройка
        // хранится по userId и чужому аккаунту не достаётся).
        PeerLocalTimeStore.shared.clear()
        LocalTimeService.shared.resetForLogout()
        // Настройка «Чат с Еблушей» принадлежала прошлой сессии (профиль бота — общий для сервера).
        SystemBotStore.shared.resetForLogout()
        // «Без звука» и журнал значка — настройки прошлой сессии; значок гаснет.
        ConversationMuteStore.shared.resetForLogout()
        AppBadge.shared.reset()
    }

    /// Прогрев на старте: поднять сессию из Keychain (порт container.warmup()).
    func warmup() {
        // Идемпотентно: зовут и PushAppDelegate (старт по VoIP-пушу, когда сцены ещё нет),
        // и RootView.task. Повторное чтение Keychain безвредно, но лишнее — гейт по флагу.
        guard !warmedUp else { return }
        warmedUp = true
        sessionStore.load()
        // Значок слушает «Без звука» с первой секунды: событие и истечение срока, случившиеся до
        // первого списка бесед, тоже меняют число.
        _ = AppBadge.shared
    }

    private var warmedUp = false
}
