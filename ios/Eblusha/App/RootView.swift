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

/// Корень залогиненного приложения: три вкладки, у каждой свой стек навигации.
///
/// Раньше был один стек со своими шапками на каждом экране и плитками «Беседа/Контакты»
/// над списком. Теперь — родная структура iOS: вкладки внизу, системные панели с крупными
/// заголовками и поиском, штатная кнопка «назад». Идентичность остаётся в палитре
/// (акцент `Eb.brand`, тёмные поверхности), пузырях и логотипе, а не в самодельных шапках.
private struct HomeNavView: View {
    let onLogout: () -> Void

    @StateObject private var listVM: ChatListViewModel
    @State private var tab: HomeTab = .chats
    /// Стек вкладки «Чаты»: беседа и создание группы живут здесь.
    @State private var chatPath: [ChatRoute] = []

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
        TabView(selection: $tab) {
            Tab("Чаты", systemImage: "bubble.left.and.bubble.right.fill", value: HomeTab.chats) {
                chatsTab
            }
            // Сумма непрочитанных на бейдже вкладки; ноль бейдж прячет сам.
            .badge(listVM.ui.conversations.reduce(0) { $0 + $1.unreadCount })

            Tab("Контакты", systemImage: "person.2.fill", value: HomeTab.contacts) {
                NavigationStack {
                    ContactsView(onBack: nil, onOpenConversation: open(ref:))
                }
            }

            Tab("Профиль", systemImage: "person.crop.circle.fill", value: HomeTab.profile) {
                NavigationStack {
                    SettingsView(onBack: nil, onLogout: onLogout)
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

    private var chatsTab: some View {
        NavigationStack(path: $chatPath) {
            ChatListView(
                vm: listVM,
                onOpenChat: { chatPath = [.conversation($0)] },
                onNewGroup: { chatPath.append(.newGroup) }
            )
            .navigationDestination(for: ChatRoute.self) { route in
                Group {
                    switch route {
                    case .conversation(let conversation):
                        ChatView(conversation: conversation) { chatPath.removeAll() }
                    case .newGroup:
                        CreateGroupView(
                            onBack: { chatPath.removeAll() },
                            onCreated: { ref in
                                // Открыть свежесозданную группу сразу после создания.
                                listVM.refresh()
                                open(ref: ref)
                            }
                        )
                    }
                }
                // Внутри беседы панель вкладок мешает композеру — как в Сообщениях и Telegram.
                .toolbar(.hidden, for: .tabBar)
            }
        }
    }

    /// Открыть беседу по ссылке из любой вкладки: переключаемся на «Чаты» и кладём её в стек.
    private func open(ref: ConversationRef) {
        Task { @MainActor in
            let conversation = await AppContainer.shared.chatRepository.resolveRef(ref)
            tab = .chats
            chatPath = [.conversation(conversation)]
        }
    }
}

private enum HomeTab: Hashable {
    case chats, contacts, profile
}

/// Маршруты стека вкладки «Чаты».
enum ChatRoute: Hashable {
    case conversation(Conversation)
    case newGroup
}

#Preview {
    RootView()
}
