import Foundation

/// Порт `data/remote/NetworkModule.kt` + перехватчиков.
///
/// В OkHttp это три перехватчика и Authenticator; здесь — один клиент с двумя режимами:
///  - `authorized: false` — «голый» клиент (только x-device-id) для логина/регистрации/
///    bootstrap, чтобы ротация токена не рекурсила через обработчик 401;
///  - `authorized: true` — bearer + на 401 тихая ротация refresh-токена через
///    /mobile/session/bootstrap и один повтор запроса (порт TokenAuthenticator).
final class APIClient {
    private let session: SessionStore
    private let deviceIdProvider: DeviceIdProvider
    private let urlSession: URLSession
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    /// Единая точка ротации: параллельные 401 сливаются в один bootstrap (порт mutex
    /// из TokenAuthenticator — здесь ту же роль играет actor c общей задачей).
    private let refresher = TokenRefresher()

    init(session: SessionStore, deviceIdProvider: DeviceIdProvider) {
        self.session = session
        self.deviceIdProvider = deviceIdProvider
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 30
        self.urlSession = URLSession(configuration: config)
    }

    // MARK: - Публичные вызовы

    func get<Out: Decodable>(_ path: String, query: [URLQueryItem] = []) async throws -> Out {
        try await request(path: path, method: "GET", query: query, body: Optional<Int>.none)
    }

    func post<In: Encodable, Out: Decodable>(
        _ path: String,
        body: In,
        authorized: Bool = true
    ) async throws -> Out {
        try await request(path: path, method: "POST", body: body, authorized: authorized)
    }

    /// POST без интересующего ответа (logout и подобные).
    func postIgnoringResponse<In: Encodable>(
        _ path: String,
        body: In,
        authorized: Bool = true
    ) async throws {
        _ = try await raw(path: path, method: "POST", query: [], body: body, authorized: authorized)
    }

    func delete<Out: Decodable>(_ path: String) async throws -> Out {
        try await request(path: path, method: "DELETE", query: [], body: Optional<Int>.none)
    }

    // MARK: - Внутренности

    private func request<In: Encodable, Out: Decodable>(
        path: String,
        method: String,
        query: [URLQueryItem] = [],
        body: In?,
        authorized: Bool = true
    ) async throws -> Out {
        let data = try await raw(path: path, method: method, query: query, body: body, authorized: authorized)
        return try decoder.decode(Out.self, from: data)
    }

    private func raw<In: Encodable>(
        path: String,
        method: String,
        query: [URLQueryItem],
        body: In?,
        authorized: Bool = true
    ) async throws -> Data {
        let (data, response) = try await urlSession.data(
            for: makeRequest(path: path, method: method, query: query, body: body, authorized: authorized)
        )
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0

        // Порт TokenAuthenticator: на 401 один общий bootstrap и один повтор.
        if code == 401, authorized, session.currentRefreshToken() != nil {
            let refreshed = try await refresher.refresh(client: self, session: session)
            if refreshed {
                let (retryData, retryResponse) = try await urlSession.data(
                    for: makeRequest(path: path, method: method, query: query, body: body, authorized: true)
                )
                let retryCode = (retryResponse as? HTTPURLResponse)?.statusCode ?? 0
                guard (200..<300).contains(retryCode) else {
                    throw HTTPError(code: retryCode, body: retryData)
                }
                return retryData
            }
        }

        guard (200..<300).contains(code) else {
            throw HTTPError(code: code, body: data)
        }
        return data
    }

    private func makeRequest<In: Encodable>(
        path: String,
        method: String,
        query: [URLQueryItem],
        body: In?,
        authorized: Bool
    ) throws -> URLRequest {
        var url = AppConfig.apiBaseURL.appendingPathComponent(path)
        if !query.isEmpty {
            var components = URLComponents(url: url, resolvingAgainstBaseURL: false)!
            components.queryItems = query
            url = components.url!
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue(deviceIdProvider.deviceId(), forHTTPHeaderField: "x-device-id")
        if authorized, let token = session.currentAccessToken() {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try encoder.encode(body)
        }
        return request
    }

    /// Ротация refresh-токена. Вызывается и из обработчика 401, и проактивно
    /// (AuthRepository.tryBootstrap перед открытием сокета).
    fileprivate func bootstrap() async throws {
        guard let refresh = session.currentRefreshToken() else {
            throw HTTPError(code: 401, body: Data())
        }
        let body = BootstrapRequest(
            refreshToken: refresh,
            client: "ios-app",
            deviceId: deviceIdProvider.deviceId()
        )
        do {
            let rotated: SessionResponse = try await post(
                "mobile/session/bootstrap", body: body, authorized: false
            )
            session.save(rotated)
        } catch let error as HTTPError where error.code == 401 {
            // Refresh отозван — сессия мертва, чистим локально (порт поведения оригинала).
            session.clear()
            throw error
        }
    }
}

/// Один bootstrap на всех: пока ротация идёт, конкурирующие 401 ждут её результата.
private actor TokenRefresher {
    private var inFlight: Task<Bool, Never>?

    func refresh(client: APIClient, session: SessionStore) async -> Bool {
        if let inFlight {
            return await inFlight.value
        }
        let tokenBefore = session.currentAccessToken()
        let task = Task<Bool, Never> {
            // Кто-то уже обновил, пока мы ждали своей очереди — токен сменился, повтор не нужен.
            if let current = session.currentAccessToken(), current != tokenBefore {
                return true
            }
            do {
                try await client.bootstrap()
                return true
            } catch {
                return false
            }
        }
        inFlight = task
        let result = await task.value
        inFlight = nil
        return result
    }
}
