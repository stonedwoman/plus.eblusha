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

    private init() {
        let session = SessionStore()
        let deviceId = DeviceIdProvider()
        self.sessionStore = session
        self.deviceIdProvider = deviceId
        self.api = APIClient(session: session, deviceIdProvider: deviceId)
        self.authRepository = AuthRepository(api: api, session: session, deviceIdProvider: deviceId)
        self.realtimeClient = RealtimeClient(session: session, deviceIdProvider: deviceId, api: api)
    }

    /// Прогрев на старте: поднять сессию из Keychain (порт container.warmup()).
    func warmup() {
        sessionStore.load()
    }
}
