import SwiftUI

/// Порт `ui/navigation/RootNavHost.kt`: корень приложения, переключающий
/// авторизацию и основной интерфейс по состоянию сессии.
///
/// Пока фаза 1: вместо HomeNavHost — заглушка с профилем и выходом. Подключение
/// сокета, секретных чатов и пушей добавится в свои фазы ровно в тех же точках,
/// что и в Kotlin-оригинале (см. LaunchedEffect(loggedIn) там).
struct RootView: View {
    private let container = AppContainer.shared
    @ObservedObject private var session: SessionStore
    @ObservedObject private var lifecycle = AppLifecycle.shared
    @State private var bootstrapped = false
    /// Идёт разбор сигнала отзыва: connect_error сыплется на каждый реконнект.
    @State private var revocationHandling = false
    /// Идёт выход — второй выход (свой device:revoked, сигнал бутстрапа) поверх не запускаем.
    @State private var loggingOut = false
    /// Досыл секретной очереди при приходе ключа — работает и когда экран беседы закрыт.
    @State private var secretFlusher = SecretOutboxFlusher(
        secret: AppContainer.shared.secretRepository,
        chats: AppContainer.shared.chatRepository
    )

    init() {
        self.session = AppContainer.shared.sessionStore
    }

    private var loggedIn: Bool {
        if case .loggedIn = session.state { return true }
        return false
    }

    var body: some View {
        ZStack {
            Eb.paper.ignoresSafeArea()
            switch session.state {
            case .unknown:
                SplashView()
            case .loggedOut:
                AuthFlowView(container: container)
            case .loggedIn:
                HomeNavView(container: container) {
                    Task { await logout() }
                }
            }

            // Оверлей звонков ПОВЕРХ всего приложения (порт CallScreen поверх RootNavHost).
            if case .loggedIn = session.state {
                CallOverlay(manager: container.callManager)
            }
        }
        .task {
            guard !bootstrapped else { return }
            bootstrapped = true
            container.warmup()
            // На старте меняем сохранённый refresh на свежий access (порт tryBootstrap).
            await container.authRepository.tryBootstrap()
        }
        // Порт LaunchedEffect(loggedIn) из RootNavHost: вход → сокет живёт, выход → умер.
        // Здесь же со временем появятся secretRepository.ensureDeviceBootstrap()/syncInbox()
        // и pushRepository.syncToken() — в этих же точках, как в оригинале.
        .onChange(of: loggedIn) { _, isIn in
            if isIn {
                // Сразу после входа сокет подключаем ПОСЛЕ бутстрапа устройства: бутстрап
                // может сменить id (отозванный/стёртый, X5/H13), а рукопожатие со старым
                // отозванным id сервер отвергнет как DEVICE_REVOKED.
                startAfterLogin(connectFirst: false)
            } else {
                container.realtimeClient.disconnect()
                // Выход по 401 (сеанс отозван) сессию чистит, а флаг «устройство
                // зарегистрировано» — нет; следующий вход тогда пропускал бы
                // /devices/register, и push-токены упирались бы в 404. Регистрация
                // идемпотентна — сбрасываем всегда.
                container.secretKeyStore.clearBootstrapped()
            }
        }
        .onAppear {
            if loggedIn {
                startAfterLogin(connectFirst: true)
            }
        }
        // Глобальные секретные обработчики (порт LaunchedEffect из RootNavHost): работают
        // и когда чат закрыт — иначе ключ принявшему устройству не уедет до открытия чата.
        // Досыл секретной очереди при приходе ключа работает и с закрытым чатом.
        .task(id: loggedIn) {
            guard loggedIn else { return }
            secretFlusher.start()
        }
        .onReceive(container.realtimeClient.events.receive(on: DispatchQueue.main)) { event in
            switch event {
            case .secretNotify:
                // Будильник per-device инбокса: шифртекста не несёт, содержимое тянем сами.
                Task { await container.secretRepository.syncInbox() }
            case .secretChatAccepted(let conversationId, let peerDeviceId):
                // Собеседник принял на ОДНОМ устройстве — создатель ключует ровно его.
                Task {
                    await container.secretRepository.onPeerAccepted(
                        threadId: conversationId, peerDeviceId: peerDeviceId
                    )
                }
            case .deviceRevoked(let deviceId, let viaConnectError):
                Task { await handleDeviceRevoked(deviceId: deviceId, viaConnectError: viaConnectError) }
            default:
                break
            }
        }
        // X5: бутстрап увидел НАШ id отозванным (список устройств, register 409/410 «revoked»):
        // ключи уже стёрты, id сменён — выходим, как по `device:revoked`. Новый id в этой же
        // сессии не регистрируется (SecretRepository.registrationBlocked).
        .onReceive(container.secretRepository.deviceRevokedLocally.receive(on: DispatchQueue.main)) { reason in
            Task { await handleLocalRevocation(reason: reason) }
        }
        // Порт наблюдателя AppLifecycle.foreground: возврат из фона с истёкшим access —
        // проактивный refresh (первый запрос ресинка не ловит 401), и честный
        // presence:state о текущем состоянии.
        .onChange(of: lifecycle.isForeground) { _, foreground in
            guard loggedIn else { return }
            container.realtimeClient.setForeground(foreground)
            if foreground {
                Task {
                    if session.isAccessTokenExpired() {
                        await container.authRepository.tryBootstrap()
                    }
                    // Сервер снимает токен после 410/BadDeviceToken, а система новый
                    // колбэк без причины не шлёт — без пересинхронизации при возврате
                    // на экран телефон молчал бы до переустановки. Upsert идемпотентен.
                    await PushRepository.shared.syncTokens()
                }
            }
        }
        .preferredColorScheme(.dark)
    }

    /// Порядок важен: устройство сначала регистрируется (и, возможно, ротирует id при
    /// 409/отзыве), и только потом ему можно привязывать push-токены — иначе
    /// POST /devices/{id}/push отвечает 404 несуществующему устройству.
    /// connectFirst: холодный старт с живой сессией — сокет не ждёт регистрации (она там
    /// почти всегда уже пройдена); сразу после входа — ждёт (см. onChange(loggedIn)).
    private func startAfterLogin(connectFirst: Bool) {
        if connectFirst { container.realtimeClient.connect() }
        Task {
            await container.secretRepository.ensureDeviceBootstrap()
            if !connectFirst { container.realtimeClient.connect() }
            await container.secretRepository.syncInbox()
            await PushRepository.shared.syncTokens()
            MessageNotifications.shared.requestPermissionAfterLogin()
        }
    }

    /// Выход: пользователем («Выйти») или потому, что это устройство отозвали.
    /// revokeThisDevice: «Выйти» отзывает ЭТО устройство на сервере (как веб и Android) —
    /// после выхода id всё равно меняется (H13), и без отзыва прежняя запись копилась бы
    /// «живым» устройством-зомби: отправители тратили бы на неё OPK, веб просил бы у неё ключ
    /// («Восстановить» спрашивает первые устройства из bundles), «есть другие устройства» врало
    /// бы. При выходе ИЗ-ЗА отзыва устройство уже отозвано — повторно не трогаем.
    private func logout(revokeThisDevice: Bool = true) async {
        guard !loggingOut else { return }
        loggingOut = true
        defer { loggingOut = false }
        // Токен снимаем ДО выхода: после очистки сессии запрос ушёл бы
        // без авторизации, и следующий владелец телефона получал бы
        // чужие уведомления.
        await PushRepository.shared.unregister()
        if revokeThisDevice {
            // Сокет закрываем ДО отзыва: собственный `device:revoked` не должен запустить
            // обработку отзыва поверх выхода. Не дольше 5 с — без сети выход не зависает.
            container.realtimeClient.disconnect()
            await container.devicesRepository.revokeDevice(container.deviceIdProvider.deviceId(), timeoutSeconds: 5)
        }
        await container.authRepository.logout()
        // Стирает ключи секреток и заводит новый id устройства (H13).
        container.clearLocalData()
    }

    /// X5 со стороны бутстрапа: наш id отозван, ключи уже стёрты — выход без повторного отзыва.
    private func handleLocalRevocation(reason: String) async {
        guard loggedIn, !loggingOut else { return }
        NSLog("RootView: this device id is revoked (%@) — keys wiped, logging out", reason)
        container.realtimeClient.disconnect()
        await logout(revokeThisDevice: false)
    }

    /// X5: устройство отозвали («Отключить» с другого устройства, бан аккаунта). Как веб:
    /// стираем ключи секреток и выходим — отозванный телефон не должен ни хранить ключи,
    /// ни воскрешать свой id перерегистрацией. connect_error сначала сверяется со списком
    /// устройств: «id ещё не зарегистрирован» — повод для бутстрапа, а не для выхода.
    private func handleDeviceRevoked(deviceId: String?, viaConnectError: Bool) async {
        guard loggedIn, !revocationHandling, !loggingOut else { return }
        revocationHandling = true
        defer { revocationHandling = false }
        let verdict = await container.secretRepository.revocationVerdict(
            revokedDeviceId: deviceId, viaConnectError: viaConnectError
        )
        switch verdict {
        case .logout:
            NSLog("RootView: this device was revoked — wiping secret keys and logging out")
            container.realtimeClient.disconnect()
            await logout(revokeThisDevice: false)
        case .rebootstrap:
            let before = container.deviceIdProvider.deviceId()
            // Сменённый id переподключает сокет сам (onDeviceIdRotated); тот же — переподключаем
            // здесь: рукопожатие шло, пока сервер этого id ещё не знал.
            if await container.secretRepository.rebootstrapDevice(),
               container.deviceIdProvider.deviceId() == before {
                container.realtimeClient.reconnectForDeviceChange()
            }
        case .ignore:
            break
        }
    }
}

/// Порт SplashScreen — логотип на тёмном фоне, пока сессия поднимается из Keychain.
struct SplashView: View {
    var body: some View {
        EblushaWordmark()
    }
}

/// Порт AuthFlow: логин ↔ регистрация на общей вью-модели.
private struct AuthFlowView: View {
    @StateObject private var vm: AuthViewModel
    @State private var showRegister = false

    init(container: AppContainer) {
        _vm = StateObject(wrappedValue: AuthViewModel(repo: container.authRepository))
    }

    var body: some View {
        NavigationStack {
            LoginView(vm: vm) {
                vm.resetRegister()
                showRegister = true
            }
            .navigationDestination(isPresented: $showRegister) {
                RegisterView(vm: vm) { showRegister = false }
            }
        }
    }
}

/// Корень залогиненного приложения: один стек навигации над списком чатов.
///
/// Список чатов — наш собственный экран: брендовая шапка сверху и панель плиток
/// «Беседа/Контакты» со строкой профиля снизу. Системные вкладки и карандаш в панели
/// пробовали и убрали — стеклянные «пузыри» iOS 26 не вязались с интерфейсом. Остальные
/// экраны пушатся в этот стек и живут с родными панелями навигации и штатной кнопкой «назад».
private struct HomeNavView: View {
    let onLogout: () -> Void

    @StateObject private var listVM: ChatListViewModel
    @State private var path: [HomeRoute] = []

    init(container: AppContainer, onLogout: @escaping () -> Void) {
        self.onLogout = onLogout
        _listVM = StateObject(wrappedValue: ChatListViewModel(
            repo: container.chatRepository,
            realtime: container.realtimeClient,
            contacts: container.contactsRepository,
            secret: container.secretRepository
        ))
    }

    var body: some View {
        NavigationStack(path: $path) {
            ChatListView(
                vm: listVM,
                onOpenChat: { path = [.conversation($0)] },
                onOpenContacts: { path.append(.contacts) },
                onOpenSettings: { path.append(.settings) },
                onNewGroup: { path.append(.newGroup) }
            )
            .navigationDestination(for: HomeRoute.self) { route in
                switch route {
                case .conversation(let conversation):
                    ChatView(conversation: conversation) { path.removeAll() }
                case .newGroup:
                    CreateGroupView(
                        onBack: { path.removeAll() },
                        onCreated: { ref in
                            // Открыть свежесозданную группу сразу после создания.
                            listVM.refresh()
                            open(ref: ref)
                        }
                    )
                case .contacts:
                    ContactsView(onBack: { path.removeAll() }, onOpenConversation: open(ref:))
                case .settings:
                    SettingsView(onBack: { path.removeAll() }, onLogout: onLogout)
                }
            }
        }
        .tint(Eb.brand)
        // Тап по уведомлению о сообщении — открыть ту самую беседу.
        .onReceive(AppLifecycle.shared.$pendingOpen) { target in
            guard let target else { return }
            AppLifecycle.shared.consumePendingOpen()
            open(ref: ConversationRef(id: target.conversationId, title: target.title))
        }
    }

    /// Открыть беседу поверх списка, сбросив всё, что лежало в стеке (контакты, группа).
    private func open(ref: ConversationRef) {
        // Уведомление о беседе, которая уже открыта: не пересоздавать экран — иначе
        // теряются позиция ленты и черновик, а Conversation хешируется по всем полям.
        if case .conversation(let current)? = path.last, current.id == ref.id { return }
        Task { @MainActor in
            let conversation = await AppContainer.shared.chatRepository.resolveRef(ref)
            path = [.conversation(conversation)]
        }
    }
}

/// Маршруты стека над списком чатов.
enum HomeRoute: Hashable {
    case conversation(Conversation)
    case newGroup
    case contacts
    case settings
}

#Preview {
    RootView()
}
