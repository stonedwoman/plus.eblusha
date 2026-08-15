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
            if foreground && session.isAccessTokenExpired() {
                Task { await container.authRepository.tryBootstrap() }
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

/// Порт HomeNavHost: список чатов + навигация в беседу. Экран беседы, контакты,
/// группы и настройки подключаются своими фазами; выход пока живёт на «Настройках».
private struct HomeNavView: View {
    let onLogout: () -> Void

    @StateObject private var listVM: ChatListViewModel
    @State private var openConversation: Conversation?
    @State private var showContacts = false
    @State private var showSettings = false
    @State private var showNewGroup = false

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
        NavigationStack {
            ChatListView(
                vm: listVM,
                onOpenChat: { openConversation = $0 },
                onOpenContacts: { showContacts = true },
                onOpenSettings: { showSettings = true },
                onNewGroup: { showNewGroup = true }
            )
            .navigationDestination(item: $openConversation) { conversation in
                ChatView(conversation: conversation) { openConversation = nil }
            }
            .navigationDestination(isPresented: $showContacts) {
                ContactsView(
                    onBack: { showContacts = false },
                    onOpenConversation: { ref in
                        showContacts = false
                        Task { @MainActor in
                            openConversation = await AppContainer.shared.chatRepository.resolveRef(ref)
                        }
                    }
                )
                .toolbar(.hidden, for: .navigationBar) // у ContactsView своя шапка с «назад»
            }
            .navigationDestination(isPresented: $showSettings) {
                SettingsView(onBack: { showSettings = false }, onLogout: onLogout)
            }
            .navigationDestination(isPresented: $showNewGroup) {
                CreateGroupView(
                    onBack: { showNewGroup = false },
                    onCreated: { ref in
                        showNewGroup = false
                        // Порт onCreated из HomeNavHost: открыть свежесозданную группу.
                        Task { @MainActor in
                            listVM.refresh()
                            openConversation = await AppContainer.shared.chatRepository.resolveRef(ref)
                        }
                    }
                )
            }
            .toolbar(.hidden, for: .navigationBar)
        }
        // Тап по уведомлению о сообщении — открыть ту самую беседу.
        .onReceive(AppLifecycle.shared.$pendingOpen) { target in
            guard let target else { return }
            AppLifecycle.shared.consumePendingOpen()
            Task { @MainActor in
                openConversation = await AppContainer.shared.chatRepository.resolveRef(
                    ConversationRef(id: target.conversationId, title: target.title)
                )
            }
        }
    }
}


#Preview {
    RootView()
}
