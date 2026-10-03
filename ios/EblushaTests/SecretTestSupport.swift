import Foundation
import XCTest
@testable import Eblusha

// Стенд для проверок секреток без сети: SecretRepository работает поверх настоящего
// APIClient, но транспорт подменён (MockURLProtocol), а «сервер» — FakeServer в памяти.
// Ключи живут в отдельном Keychain-service и отдельном UserDefaults-suite на каждый тест:
// боевое хранилище приложения тесты не трогают. Криптография — настоящая (SecretCrypto),
// пакеты ключей собираются так же, как их собирают веб/Android/iOS-отправители.

// MARK: - Подменный транспорт

final class MockURLProtocol: URLProtocol {
    static var server: FakeServer?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let body = request.httpBody ?? request.httpBodyStream.map(Self.readAll)
        let (status, data) = Self.server?.handle(request, body: body) ?? (500, Data())
        let response = HTTPURLResponse(
            url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    private static func readAll(_ stream: InputStream) -> Data {
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 16 * 1024)
        while stream.hasBytesAvailable {
            let n = stream.read(&buffer, maxLength: buffer.count)
            if n <= 0 { break }
            data.append(buffer, count: n)
        }
        return data
    }
}

// MARK: - Сервер в памяти

final class FakeServer {
    struct Call {
        let method: String
        let path: String
        let query: [String: String]
        let deviceIdHeader: String?
        let json: Any?
    }

    private let lock = NSLock()
    private var _calls: [Call] = []

    /// Сырые элементы инбокса (как их отдаёт /secret/inbox/pull).
    var inbox: [Any] = []
    var pullStatus = 200
    /// Сырые строки истории треда.
    var historyItems: [Any] = []
    /// threadId → (type, участники). Отдаётся через GET /conversations.
    var threads: [String: (type: String, participants: [String])] = [:]
    var conversationsStatus = 200
    /// Устройства НАШЕГО аккаунта (GET /devices).
    var myDevices: [[String: Any]] = []
    var devicesStatus = 200
    /// userId → живые deviceId (GET /e2ee/prekeys/bundles).
    var bundles: [String: [String]] = [:]
    var bundlesStatus = 200
    /// deviceId → prekey, который отдаст claim.
    var claimable: [String: (keyId: String, publicKey: Data)] = [:]
    /// Ответ на /devices/register: статус + тело. По умолчанию — всё принято.
    var registerResponses: [(status: Int, body: [String: Any]?)] = []
    /// Сколько ключей примет /devices/{id}/prekeys (nil — все).
    var publishAcceptLimit: Int?

    var calls: [Call] { lock.withLockT { _calls } }

    func calls(_ method: String, _ path: String) -> [Call] {
        calls.filter { $0.method == method && $0.path == path }
    }

    var ackedIds: [String] {
        calls("POST", "secret/inbox/ack").flatMap { (($0.json as? [String: Any])?["msgIds"] as? [String]) ?? [] }
    }

    /// Конверты, ушедшие через /secret/send.
    var sentEnvelopes: [[String: Any]] {
        calls("POST", "secret/send").flatMap { (($0.json as? [String: Any])?["messages"] as? [[String: Any]]) ?? [] }
    }

    func addSecretThread(_ id: String, participants: [String], type: String = "SECRET") {
        threads[id] = (type, participants)
    }

    func handle(_ request: URLRequest, body: Data?) -> (Int, Data) {
        let url = request.url!
        let fullPath = url.path
        let path = fullPath.range(of: "/api/").map { String(fullPath[$0.upperBound...]) } ?? fullPath
        let method = request.httpMethod ?? "GET"
        var query: [String: String] = [:]
        for item in URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? [] {
            query[item.name] = item.value
        }
        let json = body.flatMap { try? JSONSerialization.jsonObject(with: $0) }
        lock.withLockT {
            _calls.append(Call(
                method: method, path: path, query: query,
                deviceIdHeader: request.value(forHTTPHeaderField: "x-device-id"), json: json
            ))
        }
        return route(method: method, path: path, query: query, json: json)
    }

    private func route(method: String, path: String, query: [String: String], json: Any?) -> (Int, Data) {
        switch (method, path) {
        case ("GET", "secret/inbox/pull"):
            guard pullStatus == 200 else { return (pullStatus, Self.data(["message": "Missing device"])) }
            return (200, Self.data(["deviceId": "x", "messages": lock.withLockT { inbox }]))
        case ("POST", "secret/inbox/ack"):
            let ids = Set(((json as? [String: Any])?["msgIds"] as? [String]) ?? [])
            lock.withLockT {
                inbox.removeAll { item in
                    guard let id = (item as? [String: Any])?["msgId"] as? String else { return false }
                    return ids.contains(id)
                }
            }
            return (200, Self.data(["acked": ids.count]))
        case ("GET", "secret/history"):
            return (200, Self.data(["items": historyItems, "hasMore": false]))
        case ("GET", "conversations"):
            guard conversationsStatus == 200 else { return (conversationsStatus, Data("{}".utf8)) }
            let list: [[String: Any]] = threads.map { id, info in
                [
                    "unreadCount": 0,
                    "conversation": [
                        "id": id,
                        "type": info.type,
                        "isSecret": info.type == "SECRET",
                        "isGroup": false,
                        "participants": info.participants.map { ["userId": $0, "conversationId": id] },
                        "messages": [],
                    ] as [String: Any],
                ]
            }
            return (200, Self.data(["conversations": list]))
        case ("GET", "devices"):
            guard devicesStatus == 200 else { return (devicesStatus, Data("{}".utf8)) }
            return (200, Self.data(["devices": myDevices]))
        case ("GET", "e2ee/prekeys/bundles"):
            guard bundlesStatus == 200 else { return (bundlesStatus, Data("{}".utf8)) }
            let userId = query["userId"] ?? ""
            let list = (bundles[userId] ?? []).map { ["deviceId": $0, "identityPublicKey": "x"] }
            return (200, Self.data(["userId": userId, "bundles": list]))
        case ("POST", "e2ee/prekeys/claim"):
            let deviceId = ((json as? [String: Any])?["deviceId"] as? String) ?? ""
            guard let prekey = claimable[deviceId] else { return (404, Self.data(["message": "No prekeys available"])) }
            return (200, Self.data([
                "deviceId": deviceId,
                "identityKey": "x",
                "prekey": ["keyId": prekey.keyId, "publicKey": SecretCrypto.b64UrlEncode(prekey.publicKey)],
            ]))
        case ("POST", "secret/send"):
            return (201, Self.data(["ok": true]))
        case ("POST", "devices/register"):
            let next = lock.withLockT { registerResponses.isEmpty ? nil : registerResponses.removeFirst() }
            if let next, next.status != 200 {
                return (next.status, Self.data(next.body ?? [:]))
            }
            let keyIds = (((json as? [String: Any])?["prekeys"] as? [[String: Any]]) ?? []).compactMap { $0["keyId"] as? String }
            return (200, Self.data(next?.body ?? ["insertedKeyIds": keyIds]))
        case ("POST", "devices/pairing/consume"):
            return (200, Self.data(["ok": true]))
        default:
            if method == "POST", path.hasPrefix("devices/"), path.hasSuffix("/prekeys") {
                var keyIds = (((json as? [String: Any])?["prekeys"] as? [[String: Any]]) ?? []).compactMap { $0["keyId"] as? String }
                if let limit = publishAcceptLimit { keyIds = Array(keyIds.prefix(limit)) }
                return (200, Self.data(["success": true, "insertedKeyIds": keyIds]))
            }
            return (404, Self.data(["message": "not mocked: \(method) \(path)"]))
        }
    }

    static func data(_ object: Any) -> Data {
        (try? JSONSerialization.data(withJSONObject: object)) ?? Data("{}".utf8)
    }
}

extension NSLock {
    func withLockT<T>(_ body: () throws -> T) rethrows -> T {
        lock()
        defer { unlock() }
        return try body()
    }
}

// MARK: - Стенд

/// Отправитель-«чужое устройство»: собирает пакеты так же, как веб/Android/iOS.
struct FakeDevice {
    let userId: String
    let deviceId: String
    let identity: SecretCrypto.KeyPair

    init(userId: String, deviceId: String) {
        self.userId = userId
        self.deviceId = deviceId
        self.identity = SecretCrypto.generateKeyPair()
    }

    var identityB64: String { SecretCrypto.b64UrlEncode(identity.publicKey) }
}

/// Принятые атрибуты конверта: кодировка base64 у веба стандартная, у Android/iOS — b64url.
enum B64Style { case url, standard }

final class Box<T> {
    private let lock = NSLock()
    private var _value: T
    init(_ value: T) { _value = value }
    var value: T {
        get { lock.withLockT { _value } }
        set { lock.withLockT { _value = newValue } }
    }
}

final class SecretTestRig {
    let me = "user-me"
    let suiteName = "eb-secret-tests-\(UUID().uuidString)"
    let defaults: UserDefaults
    let deviceIds: DeviceIdProvider
    let session = SessionStore()
    let api: APIClient
    let devices: DevicesRepository
    let keyStore: SecretKeyStore
    let repo: SecretRepository
    let server = FakeServer()

    init() {
        defaults = UserDefaults(suiteName: suiteName)!
        deviceIds = DeviceIdProvider(defaults: defaults)
        let sessionJSON = """
        {"user":{"id":"user-me","username":"me"},"accessToken":"test-access","refreshToken":"test-refresh",
         "expiresAt":"2099-01-01T00:00:00.000Z"}
        """
        session.save(try! JSONDecoder().decode(SessionResponse.self, from: Data(sessionJSON.utf8)))
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        api = APIClient(session: session, deviceIdProvider: deviceIds, urlSession: URLSession(configuration: config))
        devices = DevicesRepository(api: api, deviceIdProvider: deviceIds)
        keyStore = SecretKeyStore(service: "org.eblusha.plus.secret.tests.\(UUID().uuidString)", defaults: defaults)
        repo = SecretRepository(api: api, devices: devices, keyStore: keyStore, deviceIdProvider: deviceIds, session: session)
        MockURLProtocol.server = server
    }

    /// Устройство уже зарегистрировано: идентичность есть, бутстрап пройден.
    func bootstrapLocally() {
        _ = keyStore.loadOrCreateIdentity()
        keyStore.setBootstrapped()
        deviceIds.markRegistered(deviceIds.deviceId())
        server.myDevices = [deviceRecord(id: deviceIds.deviceId(), identity: keyStore.identity()!.publicKey)]
    }

    func deviceRecord(id: String, identity: Data, revoked: Bool = false, availablePrekeys: Int = 50, style: B64Style = .url) -> [String: Any] {
        let key = style == .url ? SecretCrypto.b64UrlEncode(identity) : identity.base64EncodedString()
        var record: [String: Any] = [
            "id": id, "userId": me, "name": "dev", "platform": "ios",
            "publicKey": key, "identityPublicKey": key, "availablePrekeys": availablePrekeys,
        ]
        record["revokedAt"] = revoked ? "2026-10-01T00:00:00.000Z" : NSNull()
        return record
    }

    /// Свой one-time prekey, на который отправитель запечатает пакет.
    func makeMyPrekey(_ keyId: String = UUID().uuidString.lowercased()) -> (keyId: String, publicKey: Data) {
        let kp = SecretCrypto.generateKeyPair()
        keyStore.addPrekeySecrets([keyId: kp.secretKey])
        return (keyId, kp.publicKey)
    }

    func tearDown() {
        MockURLProtocol.server = nil
        keyStore.clear()
        session.clear()
        defaults.removePersistentDomain(forName: suiteName)
    }

    // MARK: Конверты

    static func b64(_ data: Data, _ style: B64Style) -> String {
        style == .url ? SecretCrypto.b64UrlEncode(data) : data.base64EncodedString()
    }

    /// key_package так, как его собирает отправитель (sendThreadKeyPackage / createEncryptedKeyPackageToDevice).
    func keyPackageItem(
        msgId: String = UUID().uuidString.lowercased(),
        from sender: FakeDevice,
        senderUserId: String? = nil,
        toDeviceId: String? = nil,
        prekey: (keyId: String, publicKey: Data),
        packageKind: String,
        payload: [String: Any],
        headerThreadId: String?,
        style: B64Style = .url
    ) -> [String: Any] {
        let to = toDeviceId ?? deviceIds.deviceId()
        let shared = SecretCrypto.scalarMult(secret: sender.identity.secretKey, peerPublic: prekey.publicKey)!
        let salt = SecretCrypto.randomBytes(32)
        let info = "eblusha:secret_pkg:\(packageKind):to:\(to):from:\(sender.deviceId):prekey:\(prekey.keyId)"
        let sessionKey = SecretCrypto.hkdfSha256(ikm: shared, salt: salt, info: Data(info.utf8), length: 32)
        let nonce = SecretCrypto.randomNonce()
        let plain = try! JSONSerialization.data(withJSONObject: payload)
        let cipher = SecretCrypto.secretBox(message: plain, nonce: nonce, key: sessionKey)!
        var header: [String: Any] = [
            "kind": "key_package",
            "v": 1,
            "packageKind": packageKind,
            "recipientDeviceId": to,
            "initiatorDeviceId": sender.deviceId,
            "initiatorIdentityKey": Self.b64(sender.identity.publicKey, style),
            "prekeyId": prekey.keyId,
            "handshakeSalt": Self.b64(salt, style),
            "hkdfInfo": info,
            "nonce": Self.b64(nonce, style),
            "alg": "xsalsa20_poly1305+hkdf_sha256",
        ]
        if let headerThreadId { header["threadId"] = headerThreadId }
        return [
            "msgId": msgId,
            "threadId": NSNull(),
            "senderUserId": senderUserId ?? sender.userId,
            "senderDeviceId": sender.deviceId,
            "createdAt": "2026-10-04T10:00:00.000Z",
            "headerJson": header,
            "ciphertext": Self.b64(cipher, style),
            "contentType": "ref",
            "schemaVersion": 1,
        ]
    }

    func threadKeyPayload(threadId: String?, key: Data, kind: String? = "thread_key", style: B64Style = .url) -> [String: Any] {
        var payload: [String: Any] = ["key": Self.b64(key, style), "v": 1, "ts": 1_759_000_000_000]
        if let threadId { payload["threadId"] = threadId }
        if let kind { payload["kind"] = kind }
        return payload
    }

    func deviceLinkPayload(_ keys: [String: Data]) -> [String: Any] {
        var keysObject: [String: Any] = [:]
        for (threadId, key) in keys {
            keysObject[threadId] = ["key": SecretCrypto.b64UrlEncode(key), "createdAt": 1, "version": 1]
        }
        return [
            "threadKeys": ["version": 1, "exportedAt": 1, "keys": keysObject],
            "kind": "device_link_keys", "v": 1, "ts": 1,
        ]
    }

    /// Сообщение треда (kind=msg), зашифрованное ключом треда.
    func msgItem(
        msgId: String = UUID().uuidString.lowercased(),
        threadId: String,
        from senderUserId: String,
        text: String,
        key: Data,
        extraHeader: [String: Any] = [:]
    ) -> [String: Any] {
        let nonce = SecretCrypto.randomNonce()
        let cipher = SecretCrypto.secretBox(message: Data(text.utf8), nonce: nonce, key: key)!
        var header: [String: Any] = ["kind": "msg", "v": 1, "nonce": SecretCrypto.b64UrlEncode(nonce)]
        for (k, v) in extraHeader { header[k] = v }
        return [
            "msgId": msgId,
            "threadId": threadId,
            "senderUserId": senderUserId,
            "senderDeviceId": "dev-\(senderUserId)",
            "createdAt": "2026-10-04T10:00:00.000Z",
            "headerJson": header,
            "ciphertext": SecretCrypto.b64UrlEncode(cipher),
            "contentType": "text",
        ]
    }

    func controlItem(
        msgId: String = UUID().uuidString.lowercased(),
        type: String,
        threadId: String,
        senderUserId: String,
        senderDeviceId: String,
        requesterDeviceId: String?,
        fromDeviceId: String? = nil
    ) -> [String: Any] {
        var header: [String: Any] = ["kind": "control", "v": 1, "type": type, "threadId": threadId]
        if let requesterDeviceId { header["requesterDeviceId"] = requesterDeviceId }
        if let fromDeviceId { header["fromDeviceId"] = fromDeviceId }
        return [
            "msgId": msgId, "threadId": NSNull(), "senderUserId": senderUserId,
            "senderDeviceId": senderDeviceId, "createdAt": "2026-10-04T10:00:00.000Z",
            "headerJson": header, "ciphertext": SecretCrypto.b64UrlEncode(Data("ctrl".utf8)), "contentType": "ref",
        ]
    }

    func linkJoinItem(
        msgId: String = UUID().uuidString.lowercased(),
        senderUserId: String,
        requesterDeviceId: String,
        code: String? = nil,
        token: String? = nil
    ) -> [String: Any] {
        var header: [String: Any] = ["kind": "link_device_join", "v": 1, "requesterDeviceId": requesterDeviceId, "ts": 1]
        if let code { header["code"] = code }
        if let token { header["token"] = token }
        return [
            "msgId": msgId, "threadId": NSNull(), "senderUserId": senderUserId,
            "senderDeviceId": requesterDeviceId, "createdAt": "2026-10-04T10:00:00.000Z",
            "headerJson": header, "ciphertext": SecretCrypto.b64UrlEncode(Data("ctrl".utf8)), "contentType": "ref",
        ]
    }

    /// Вскрыть пакет, который НАШ репозиторий отправил устройству (проверка ответа на key_request).
    static func openSentPackage(_ envelope: [String: Any], prekeySecret: Data) -> [String: Any]? {
        guard let header = envelope["headerJson"] as? [String: Any],
              let identity = (header["initiatorIdentityKey"] as? String).flatMap(SecretCrypto.b64UrlDecode),
              let salt = (header["handshakeSalt"] as? String).flatMap(SecretCrypto.b64UrlDecode),
              let info = header["hkdfInfo"] as? String,
              let nonce = (header["nonce"] as? String).flatMap(SecretCrypto.b64UrlDecode),
              let cipher = (envelope["ciphertext"] as? String).flatMap(SecretCrypto.b64UrlDecode),
              let shared = SecretCrypto.scalarMult(secret: prekeySecret, peerPublic: identity) else { return nil }
        let sessionKey = SecretCrypto.hkdfSha256(ikm: shared, salt: salt, info: Data(info.utf8), length: 32)
        guard let plain = SecretCrypto.secretBoxOpen(cipher: cipher, nonce: nonce, key: sessionKey) else { return nil }
        return (try? JSONSerialization.jsonObject(with: plain)) as? [String: Any]
    }
}
