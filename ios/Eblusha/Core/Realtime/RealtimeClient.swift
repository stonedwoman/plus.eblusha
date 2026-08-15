import Foundation
import Combine
import SocketIO

/// Порт `data/realtime/RealtimeClient.kt` — канал Socket.IO.
///
/// Рукопожатие несёт JWT + deviceId. В отличие от HTTP-клиента, у сокета нет ротации
/// токена по 401: протухший access на старте давал бы вечный `connect_error: Unauthorized`
/// и молча убивал весь реалтайм (звонки не звонят, сообщения не приходят). Поэтому токен
/// обновляем и проактивно (перед подключением, если он заведомо истёк), и реактивно
/// (на Unauthorized-рукопожатии), пересобирая сокет со свежим токеном — менять auth
/// у живого менеджера бесполезно, как и в socket.io-client-java.
final class RealtimeClient: ObservableObject {

    let events = PassthroughSubject<RealtimeEvent, Never>()
    @Published private(set) var connected = false

    private let session: SessionStore
    private let deviceIdProvider: DeviceIdProvider
    private let api: APIClient

    private var manager: SocketManager?
    private var socket: SocketIOClient?
    private var socketToken: String?
    private var refreshing = false
    private var authRetries = 0
    private let maxAuthRetries = 3

    /// Комнаты живут на СОЕДИНЕНИИ: после реконнекта их надо переприсоединить, иначе
    /// typing/receipts молча умирают. Как веб, комнаты НЕ покидаем при закрытии экрана.
    private var joinedConversations = Set<String>()

    private let queue = DispatchQueue.main

    init(session: SessionStore, deviceIdProvider: DeviceIdProvider, api: APIClient) {
        self.session = session
        self.deviceIdProvider = deviceIdProvider
        self.api = api
    }

    func connect() {
        guard session.currentRefreshToken() != nil else { return }
        if socket?.status == .connected { return }
        Task { await openSocket(proactiveRefresh: true) }
    }

    /// Пересобирает сокет с ТЕКУЩИМ device-id. Нужен после ротации id (409 на регистрации
    /// устройства): без переподключения сервер оставил бы нас в комнате старого устройства.
    func reconnectForDeviceChange() {
        guard session.currentRefreshToken() != nil else { return }
        Task { await openSocket(proactiveRefresh: false) }
    }

    /// Добывает рабочий access-токен (обновив, если заведомо истёк) и (пере)собирает сокет.
    private func openSocket(proactiveRefresh: Bool) async {
        var token = session.currentAccessToken()
        if proactiveRefresh && (token == nil || session.isAccessTokenExpired()) {
            token = await refreshAccessToken(stale: token) ?? session.currentAccessToken()
        }
        guard let token else {
            NSLog("RealtimeClient: нет access-токена, не подключаюсь")
            return
        }
        await MainActor.run { rebuildSocket(token: token) }
    }

    @MainActor
    private func rebuildSocket(token: String) {
        teardownSocket()

        let manager = SocketManager(
            socketURL: AppConfig.socketBaseURL,
            config: [
                .log(false),
                .compress,
                .reconnects(true),
                .reconnectWait(1),
                .reconnectWaitMax(5),
            ]
        )
        let socket = manager.defaultSocket
        self.manager = manager
        self.socket = socket
        self.socketToken = token

        socket.on(clientEvent: .connect) { [weak self] _, _ in
            guard let self else { return }
            self.connected = true
            self.authRetries = 0
            // Реконнект в фоне НЕ должен объявлять нас «в сети» — честно сообщаем
            // текущее состояние приложения.
            self.setForeground(AppLifecycle.shared.isForeground)
            // Переприсоединяем комнаты — сервер их забыл вместе со старым соединением.
            for id in self.joinedConversations {
                socket.emit("conversation:join", id)
            }
            // И говорим слушателям (CallManager): членство в комнате звонка тоже забыто —
            // повторный call:room:join в 15-секундном грейсе отменяет снос звонка.
            self.events.send(.socketReconnected)
        }
        socket.on(clientEvent: .disconnect) { [weak self] _, _ in
            self?.connected = false
        }
        socket.on(clientEvent: .error) { [weak self] data, _ in
            let message = data.first.map { String(describing: $0) } ?? ""
            if message.localizedCaseInsensitiveContains("Unauthorized") {
                self?.onAuthError()
            }
        }
        socket.on(clientEvent: .reconnectAttempt) { [weak self] _, _ in
            // Порт EVENT_RECONNECT_ATTEMPT: если токен успел смениться (HTTP-клиент
            // обновил), реконнект со старым payload обречён — пересобираем сокет.
            guard let self else { return }
            if let latest = self.session.currentAccessToken(), latest != self.socketToken {
                self.rebuildSocket(token: latest)
            }
        }

        bind(socket, "message:new", MessageEventPayload.self) {
            .messageNew(conversationId: $0.conversationId, messageId: $0.messageId, senderId: $0.senderId, message: $0.message)
        }
        bind(socket, "message:notify", MessageEventPayload.self) {
            .messageNotify(conversationId: $0.conversationId, messageId: $0.messageId, senderId: $0.senderId, message: $0.message)
        }
        bind(socket, "message:update", MessageEventPayload.self) {
            .messageUpdate(conversationId: $0.conversationId, messageId: $0.messageId)
        }
        bind(socket, "message:reaction", MessageEventPayload.self) {
            .messageReaction(conversationId: $0.conversationId, messageId: $0.messageId)
        }
        bind(socket, "receipts:update", ReceiptsPayload.self) {
            .receipts(conversationId: $0.conversationId, messageIds: $0.messageIds, userId: $0.userId, status: $0.status)
        }
        bind(socket, "conversation:typing_update", TypingPayload.self) {
            .typing(conversationId: $0.conversationId, userId: $0.userId, isTyping: $0.isTyping, displayName: $0.displayName)
        }
        bind(socket, "presence:update", PresencePayload.self) { payload in
            // Карту устройств держим отдельно от событий (см. PresenceDevices).
            PresenceDevices.shared.update(userId: payload.userId, device: payload.device)
            return .presence(userId: payload.userId, status: payload.status, device: payload.device)
        }
        socket.on("presence:device:snapshot:batch") { data, _ in
            // Снапшот при подключении: без него иконки у тех, кто уже сидел в сети,
            // появились бы только после их следующей смены статуса.
            guard let batch: PresenceDeviceBatch = Self.decode(data) else { return }
            PresenceDevices.shared.updateAll(batch.items.map { ($0.userId, $0.device) })
        }
        bind(socket, "secret:notify", SecretNotifyPayload.self) {
            .secretNotify(toDeviceId: $0.toDeviceId, msgId: $0.msgId)
        }
        bind(socket, "secret:chat:accepted", SecretChatAcceptedPayload.self) {
            .secretChatAccepted(conversationId: $0.conversationId, peerDeviceId: $0.peerDeviceId)
        }
        // Заявки в друзья живут вживую: payload не разбираем — экран просто перечитывает
        // списки. on() напрямую: у части событий payload может быть пустым.
        for event in ["contacts:request:new", "contacts:request:accepted", "contacts:request:rejected", "contacts:removed"] {
            socket.on(event) { [weak self] _, _ in
                let kind = event.replacingOccurrences(of: "contacts:", with: "")
                self?.events.send(.contactsChanged(kind: kind))
            }
        }

        bind(socket, "conversations:new", ConversationEventPayload.self) {
            .conversationsChanged(conversationId: $0.conversationId, kind: "new")
        }
        bind(socket, "conversations:updated", ConversationEventPayload.self) {
            .conversationsChanged(conversationId: $0.conversationId, kind: "updated")
        }
        bind(socket, "conversations:deleted", ConversationEventPayload.self) {
            .conversationsChanged(conversationId: $0.conversationId, kind: "deleted")
        }

        bind(socket, "call:incoming", CallIncomingPayload.self) {
            .callIncoming(conversationId: $0.conversationId, fromUserId: $0.from?.id ?? "", fromName: $0.from?.name ?? "", video: $0.video)
        }
        bind(socket, "call:accepted", CallByPayload.self) {
            .callAccepted(conversationId: $0.conversationId, byUserId: $0.by?.id ?? "", video: $0.video)
        }
        bind(socket, "call:declined", CallByPayload.self) {
            .callDeclined(conversationId: $0.conversationId, byUserId: $0.by?.id ?? "")
        }
        bind(socket, "call:ended", CallByPayload.self) {
            .callEnded(conversationId: $0.conversationId, byUserId: $0.by?.id ?? "")
        }

        socket.connect(withPayload: [
            "token": token,
            "deviceId": deviceIdProvider.deviceId(),
        ])
    }

    /// Рукопожатие отвергнуто как Unauthorized — access протух. Обновляем (сливая
    /// конкурентные попытки) и пересобираем сокет. Ограниченные повторы защищают от
    /// шторма Unauthorized при мёртвом refresh-токене.
    private func onAuthError() {
        if refreshing { return }
        if authRetries >= maxAuthRetries {
            NSLog("RealtimeClient: всё ещё Unauthorized после %d попыток; сдаюсь до следующего connect()", authRetries)
            return
        }
        refreshing = true
        authRetries += 1
        let stale = socketToken
        Task {
            defer { self.refreshing = false }
            if let fresh = await refreshAccessToken(stale: stale), fresh != stale {
                await MainActor.run { self.rebuildSocket(token: fresh) }
            }
        }
    }

    /// Ротация access-токена через /mobile/session/bootstrap. Зеркало HTTP-варианта:
    /// если другой путь уже продвинул токен — используем его, не тратя refresh.
    /// Однозначный 401 чистит сессию.
    private func refreshAccessToken(stale: String?) async -> String? {
        if let current = session.currentAccessToken(), current != stale {
            return current
        }
        guard let refresh = session.currentRefreshToken() else { return nil }
        do {
            let rotated: SessionResponse = try await api.post(
                "mobile/session/bootstrap",
                body: BootstrapRequest(
                    refreshToken: refresh,
                    client: "ios-app",
                    deviceId: deviceIdProvider.deviceId()
                ),
                authorized: false
            )
            session.save(rotated)
            return rotated.accessToken
        } catch let error as HTTPError {
            if error.code == 401 { session.clear() }
            NSLog("RealtimeClient: обновление токена не удалось, HTTP %d", error.code)
            return nil
        } catch {
            NSLog("RealtimeClient: обновление токена не удалось: %@", String(describing: error))
            return nil
        }
    }

    // MARK: - Комнаты и исходящие события

    func joinConversation(_ conversationId: String) {
        queue.async {
            if self.joinedConversations.insert(conversationId).inserted {
                self.socket?.emit("conversation:join", conversationId)
            }
        }
    }

    /// Мягкий выход: только при реальном удалении беседы (не при закрытии экрана).
    func forgetConversation(_ conversationId: String) {
        queue.async {
            self.joinedConversations.remove(conversationId)
            self.socket?.emit("conversation:leave", conversationId)
        }
    }

    func setForeground(_ active: Bool) {
        socket?.emit("presence:state", [
            "active": active,
            "visibility": active ? "visible" : "hidden",
            "source": "mobile",
        ] as [String: Any])
    }

    func sendTyping(conversationId: String, typing: Bool) {
        emitObject("conversation:typing", ["conversationId": conversationId, "typing": typing])
    }

    func inviteCall(conversationId: String, video: Bool) {
        emitObject("call:invite", ["conversationId": conversationId, "video": video])
    }

    func acceptCall(conversationId: String, video: Bool) {
        emitObject("call:accept", ["conversationId": conversationId, "video": video])
    }

    func declineCall(conversationId: String) {
        emitObject("call:decline", ["conversationId": conversationId])
    }

    func endCall(conversationId: String) {
        emitObject("call:end", ["conversationId": conversationId])
    }

    func joinCallRoom(conversationId: String, video: Bool) {
        emitObject("call:room:join", ["conversationId": conversationId, "video": video])
    }

    func leaveCallRoom(conversationId: String) {
        emitObject("call:room:leave", ["conversationId": conversationId])
    }

    func disconnect() {
        queue.async {
            self.teardownSocket()
            self.socketToken = nil
            self.connected = false
        }
    }

    // MARK: - Внутренности

    private func teardownSocket() {
        socket?.removeAllHandlers()
        socket?.disconnect()
        manager?.disconnect()
        socket = nil
        manager = nil
    }

    private func emitObject(_ event: String, _ payload: [String: Any]) {
        socket?.emit(event, payload)
    }

    /// Подписка с декодированием первого аргумента события в Codable-структуру.
    private func bind<T: Decodable>(
        _ socket: SocketIOClient,
        _ event: String,
        _ type: T.Type,
        _ mapper: @escaping (T) -> RealtimeEvent?
    ) {
        socket.on(event) { [weak self] data, _ in
            guard let self, let payload: T = Self.decode(data) else { return }
            if let mapped = mapper(payload) {
                self.events.send(mapped)
            }
        }
    }

    /// Socket.IO отдаёт [Any]; первый элемент — словарь события. Прогоняем его через
    /// JSONSerialization → JSONDecoder, чтобы жить в тех же Codable-типах, что и REST.
    private static func decode<T: Decodable>(_ data: [Any]) -> T? {
        guard let first = data.first,
              JSONSerialization.isValidJSONObject(first),
              let raw = try? JSONSerialization.data(withJSONObject: first) else { return nil }
        do {
            return try JSONDecoder().decode(T.self, from: raw)
        } catch {
            NSLog("RealtimeClient: не смог разобрать payload: %@", String(describing: error))
            return nil
        }
    }
}
