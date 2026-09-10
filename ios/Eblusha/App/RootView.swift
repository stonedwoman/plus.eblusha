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
                    Task {
                        // Токен снимаем ДО выхода: после очистки сессии запрос ушёл бы
                        // без авторизации, и следующий владелец телефона получал бы
                        // чужие уведомления.
                        await PushRepository.shared.unregister()
                        await container.authRepository.logout()
                        container.clearLocalData()
                    }
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
                container.realtimeClient.connect()
                startAfterLogin()
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
                container.realtimeClient.connect()
                startAfterLogin()
            }
        }
        // Глобальные секретные обработчики (порт LaunchedEffect из RootNavHost): работают
        // и когда чат закрыт — иначе ключ принявшему устройству не уедет до открытия чата.
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
            default:
                break
            }
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
    /// 409), и только потом ему можно привязывать push-токены — иначе
    /// POST /devices/{id}/push отвечает 404 несуществующему устройству.
    private func startAfterLogin() {
        Task {
            await container.secretRepository.ensureDeviceBootstrap()
            await container.secretRepository.syncInbox()
            await PushRepository.shared.syncTokens()
            MessageNotifications.shared.requestPermissionAfterLogin()
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
