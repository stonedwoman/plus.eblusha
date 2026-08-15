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
    @State private var bootstrapped = false

    init() {
        self.session = AppContainer.shared.sessionStore
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

/// Временная «домашняя» до фазы 3: доказывает, что сессия жива и токены работают.
private struct HomePlaceholderView: View {
    let user: SessionStore.StoredUser
    let onLogout: () -> Void

    var body: some View {
        VStack(spacing: Spacing.lg) {
            EblushaWordmark()
            Text("Вы вошли как @\(user.username)")
                .foregroundStyle(Eb.textPrimary)
            if let displayName = user.displayName {
                Text(displayName)
                    .foregroundStyle(Eb.textMuted)
            }
            Button("Выйти", action: onLogout)
                .foregroundStyle(Eb.error)
                .padding(.top, Spacing.xl)
        }
    }
}

#Preview {
    RootView()
}
