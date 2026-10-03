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

    /// Достаёт ключ шифрования звонка один на один. Ключ этот выдаёт сервер — шифрование
    /// «через сервер», не сквозное (настоящее, с ключами устройств, — в 2.0).
    ///
    /// Ни одна ошибка здесь НЕ превращается в «звоним без шифрования»: раньше `try?`
    /// сводил любой сбой (сеть, 403/404/5xx, выключенный на сервере флаг, ключ не той
    /// длины) к nil, а nil — к обычной открытой комнате, и личный звонок молча шёл
    /// незашифрованным. Теперь сбой возвращается причиной, и звонок не начинается.
    /// Группы сюда не ходят вовсе: решение «шифровать или нет» принимает CallManager
    /// по тому, что клиент сам знает о беседе, а не по ответу этой ручки.
    ///
    /// Несколько повторов — на случай сетевой икоты: вызывающий идёт за ключом сразу
    /// после `call:invite`. Отказ доступа (400/401/403) повтором не лечится.
    func fetchE2eeKey(conversationId: String) async -> Result<String, CallKeyFailure> {
        var failure = CallKeyFailure.network
        attempts: for attempt in 0..<3 {
            let result: ApiResult<E2eeKeyResponse> = await safeApiCall {
                try await api.get("calls/\(conversationId)/e2ee-key")
            }
            switch result {
            case .success(let response):
                let key = response.key.trimmed()
                // Паролем для криптора служит сама base64-СТРОКА, но сервер обещает за ней
                // ровно 32 байта. Иное — не наш ключ: звонить с ним нельзя.
                guard Self.isValidCallKey(key) else {
                    NSLog("CallE2EE: сервер вернул ключ неверного вида для %@ — звонок не начат", conversationId)
                    return .failure(.malformed)
                }
                return .success(key)
            case .failure(_, let code):
                failure = CallKeyFailure(code: code)
                if case .server(let status) = failure, [400, 401, 403].contains(status) { break attempts }
            }
            if attempt < 2 { try? await Task.sleep(nanoseconds: 350_000_000) }
        }
        NSLog("CallE2EE: нет ключа шифрования для %@ (%@) — звонок не начат", conversationId, failure.logDescription)
        return .failure(failure)
    }

    /// Ключ звонка — base64 ровно 32 байт.
    static func isValidCallKey(_ key: String) -> Bool {
        guard let decoded = Data(base64Encoded: key) else { return false }
        return decoded.count == 32
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

/// Почему не удалось получить ключ шифрования личного звонка. Любая причина означает
/// одно: звонок не начинается (открытого звонка один на один не бывает).
enum CallKeyFailure: Error, Equatable {
    /// Нет связи с сервером или он не ответил.
    case network
    /// Сервер ответил ошибкой: 404 (ключа нет / шифрование выключено), 403, 5xx…
    case server(Int)
    /// Сервер прислал не то, что обещал: не JSON, без ключа или ключ не 32 байта.
    case malformed

    /// Из кода ApiResult: отрицательные — ошибки URLSession (сеть, отмена), nil — разбор ответа.
    init(code: Int?) {
        guard let code else {
            self = .malformed
            return
        }
        self = code < 100 ? .network : .server(code)
    }

    /// Для журнала: только класс причины, никаких данных ключа.
    var logDescription: String {
        switch self {
        case .network: return "сеть"
        case .server(let code): return "HTTP \(code)"
        case .malformed: return "неверный ответ"
        }
    }

    /// Что сказать человеку под заголовком «Не удалось включить шифрование — звонок не начат».
    var userText: String {
        let tail = " Без шифрования личный звонок не начинается — попробуйте ещё раз."
        switch self {
        case .network:
            return "Не удалось получить ключ шифрования: нет связи с сервером." + tail
        case .server(403):
            return "Сервер отказал в ключе шифрования для этого звонка (ошибка 403)." + tail
        case .server(404):
            return "Сервер не выдал ключ шифрования для этого звонка (ошибка 404)." + tail
        case .server(let code) where code >= 500:
            return "Сервер не смог выдать ключ шифрования (ошибка \(code))." + tail
        case .server(let code):
            return "Сервер не выдал ключ шифрования (ошибка \(code))." + tail
        case .malformed:
            return "Сервер прислал ключ шифрования неверного вида." + tail
        }
    }
}
