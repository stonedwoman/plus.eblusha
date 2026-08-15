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
            case .loggedIn(let user):
                HomePlaceholderView(user: user) {
                    Task { await container.authRepository.logout() }
                }
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
            } else {
                container.realtimeClient.disconnect()
            }
        }
        .onAppear {
            if loggedIn { container.realtimeClient.connect() }
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

/// Временная «домашняя» до фазы 3: доказывает, что сессия и сокет живы.
private struct HomePlaceholderView: View {
    let user: SessionStore.StoredUser
    let onLogout: () -> Void

    @ObservedObject private var realtime = AppContainer.shared.realtimeClient
    @State private var lastEvent = "—"

    var body: some View {
        VStack(spacing: Spacing.lg) {
            EblushaWordmark()
            Text("Вы вошли как @\(user.username)")
                .foregroundStyle(Eb.textPrimary)
            if let displayName = user.displayName {
                Text(displayName)
                    .foregroundStyle(Eb.textMuted)
            }

            HStack(spacing: Spacing.sm) {
                Circle()
                    .fill(realtime.connected ? Eb.online : Eb.offline)
                    .frame(width: 10, height: 10)
                Text(realtime.connected ? "Сокет подключён" : "Сокет не подключён")
                    .font(.footnote)
                    .foregroundStyle(Eb.textMuted)
            }
            Text("Последнее событие: \(lastEvent)")
                .font(.caption.monospaced())
                .foregroundStyle(Eb.textMuted)
                .lineLimit(2)
                .onReceive(realtime.events) { event in
                    lastEvent = String(describing: event).prefix(80).description
                }

            Button("Выйти", action: onLogout)
                .foregroundStyle(Eb.error)
                .padding(.top, Spacing.xl)
        }
        .padding(.horizontal, Spacing.xl)
    }
}

#Preview {
    RootView()
}
