import Foundation

// Порт `data/repository/LiveKitRepository.kt`.

/// Зеркало веб-`normalizeLivekitServerUrl`: бэкенд может вернуть незашифрованный
/// `ws://`/`http://` URL (он собирает его на каждый запрос и для мобильного клиента
/// выбирает `ws://`), а через HTTPS-край такой не подключится — принудительно `wss://`.
func normalizeLivekitUrl(_ raw: String) -> String {
    let url = raw.trimmed()
    if url.isEmpty { return url }
    let pageSecure = AppConfig.socketBaseURL.absoluteString.hasPrefix("https://")
    guard let schemeRange = url.range(of: "://") else { return url }
    let rest = String(url[schemeRange.upperBound...])
    if url.hasPrefix("https://") || url.hasPrefix("wss://") {
        return "wss://" + rest
    }
    if url.hasPrefix("http://") || url.hasPrefix("ws://") {
        return (pageSecure ? "wss://" : "ws://") + rest
    }
    return url
}

final class LiveKitRepository {
    private let api: APIClient
    private let session: SessionStore

    init(api: APIClient, session: SessionStore) {
        self.api = api
        self.session = session
    }

    /// Достаёт общий E2EE-ключ 1:1-звонка. nil для групповых/выключенных (сервер 404).
    /// Несколько повторов, потому что вызывающий идёт за ключом сразу после
    /// `call:invite` — а именно invite генерирует и сохраняет ключ на сервере.
    func fetchE2eeKey(conversationId: String) async -> String? {
        for attempt in 0..<3 {
            let response: E2eeKeyResponse? = try? await api.get("calls/\(conversationId)/e2ee-key")
            if let key = response?.key.trimmed(), !key.isEmpty { return key }
            if attempt < 2 { try? await Task.sleep(nanoseconds: 350_000_000) }
        }
        NSLog("CallE2EE: нет e2ee-ключа для %@ (группа/выключено → обычная комната)", conversationId)
        return nil
    }

    /// Имя комнаты — конвенция веб-клиента: `conv-{conversationId}`.
    func fetchToken(conversationId: String) async -> ApiResult<LiveKitTokenResponse> {
        await safeApiCall {
            let user = session.currentUser()
            let name: String? = user.map { u in
                (u.displayName?.isEmpty == false) ? u.displayName! : u.username
            }
            let response: LiveKitTokenResponse = try await api.post(
                "livekit/token",
                body: LiveKitTokenRequest(
                    room: "conv-\(conversationId)",
                    participantName: name,
                    participantMetadata: [
                        "app": "eblusha",
                        "userId": user?.id ?? "",
                        "displayName": name ?? "",
                        "avatarUrl": user?.avatarUrl ?? "",
                    ]
                )
            )
            return LiveKitTokenResponse(token: response.token, url: normalizeLivekitUrl(response.url))
        }
    }
}
