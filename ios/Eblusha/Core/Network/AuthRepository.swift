import Foundation

/// Порт `data/repository/AuthRepository.kt`.
final class AuthRepository {
    private let api: APIClient
    private let session: SessionStore
    private let deviceIdProvider: DeviceIdProvider

    init(api: APIClient, session: SessionStore, deviceIdProvider: DeviceIdProvider) {
        self.api = api
        self.session = session
        self.deviceIdProvider = deviceIdProvider
    }

    func login(username: String, password: String) async -> ApiResult<Void> {
        await safeApiCall {
            let response: SessionResponse = try await api.post(
                "auth/login",
                body: LoginRequest(username: username.trimmed(), password: password),
                authorized: false
            )
            session.save(response)
        }
    }

    func verifyInvite(code: String) async -> ApiResult<InviteVerifyResponse> {
        await safeApiCall {
            try await api.post(
                "auth/register/code/verify",
                body: InviteVerifyRequest(code: code.trimmed()),
                authorized: false
            )
        }
    }

    func register(
        username: String,
        displayName: String,
        password: String,
        inviteToken: String
    ) async -> ApiResult<Void> {
        await safeApiCall {
            let response: SessionResponse = try await api.post(
                "auth/register",
                body: RegisterRequest(
                    username: username.trimmed(),
                    displayName: displayName.trimmed(),
                    password: password,
                    registrationInviteToken: inviteToken
                ),
                authorized: false
            )
            session.save(response)
        }
    }

    /// На старте приложения: обменять сохранённый refresh на свежий access.
    func tryBootstrap() async {
        guard session.currentRefreshToken() != nil else { return }
        let result = await safeApiCall {
            let response: SessionResponse = try await api.post(
                "mobile/session/bootstrap",
                body: BootstrapRequest(
                    refreshToken: session.currentRefreshToken() ?? "",
                    client: "ios-app",
                    deviceId: deviceIdProvider.deviceId()
                ),
                authorized: false
            )
            session.save(response)
        }
        if case .failure(_, let code) = result, code == 401 {
            session.clear()
        }
    }

    func logout() async {
        // refreshToken до clear(): сервер отзывает сессию только по телу запроса
        // (кук мы не шлём) — иначе «Выйти» оставит refresh-сессию живой.
        let refresh = session.currentRefreshToken()
        try? await api.postIgnoringResponse("auth/logout", body: LogoutRequest(refreshToken: refresh))
        session.clear()
    }
}

extension String {
    func trimmed() -> String { trimmingCharacters(in: .whitespacesAndNewlines) }
}
