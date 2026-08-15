import Foundation
import Combine

/// Порт `feature/chat/ChatViewModel.kt` — обычные (несекретные) беседы.
///
/// Секретный V2-режим здесь не портирован: он целиком зависит от SecretRepository
/// (фаза секретных чатов) — открытие секретки показывает заглушку. Вложения и
/// голосовые добавятся вместе с композером вложений.
@MainActor
final class ChatViewModel: ObservableObject {

    struct UiState {
        var loading = true
        var loadingOlder = false
        var sending = false
        var isGroup = false
        var senderAvatars: [String: String?] = [:]
        var headerAvatarUrl: String?
        var headerSubtitle: String?
        var messages: [Message] = []
        var hasMore = false
        var nextCursor: String?
        var typingName: String?
        var error: String?
        /// Ответ: 1 (одиночный) или ≥2 (мультиответ) цитируемых сообщений.
        var replyingTo: [Message] = []
        /// 1:1-собеседник (открытие карточки по шапке; nil для групп).
        var peerUserId: String?
        /// Текст, который надо вернуть в композер после сбоя отправки.
        var restoredDraft: String?
        /// Секретная беседа V2 — экран показывает заглушку до фазы секретных чатов.
        var isSecretStub = false
    }

    @Published private(set) var ui = UiState()

    private let repo: ChatRepository
    private let realtime: RealtimeClient
    private let conversationId: String

    private var typingSent = false
    private var typingHeartbeat: Task<Void, Never>?
    private var typingExpiry: Task<Void, Never>?
    private var lastInputMs: TimeInterval = 0
    private var lastReload: TimeInterval = 0
    private var requestedPreviews: Set<String> = []
    private var cancellables: Set<AnyCancellable> = []

    // Стражи пагинации (веб-паритет): флаг ставится синхронно ДО запуска (триггер у
    // верха срабатывает каждый кадр), pagedBack замораживает курсор после листания назад.
    private var loadingOlderFlag = false
    private var pagedBack = false
    // Карантин после НЕУДАЧНОЙ подгрузки назад — иначе мгновенный бесконечный ретрай.
    private var lastOlderFailMs: TimeInterval = 0

    private var peerUserId: String?

    private static let pageSize = 80 // веб MESSAGES_PAGE_SIZE
    private static let olderRetryCooldown: TimeInterval = 4

    init(repo: ChatRepository, realtime: RealtimeClient, conversationId: String) {
        self.repo = repo
        self.realtime = realtime
        self.conversationId = conversationId

        realtime.joinConversation(conversationId)

        Task { await bootstrap() }

        // Ресинк открытого чата после реконнекта сокета.
        var wasConnected = realtime.connected
        realtime.$connected
            .receive(on: DispatchQueue.main)
            .sink { [weak self] connected in
                if connected && !wasConnected { self?.resyncAfterResume() }
                wasConnected = connected
            }
            .store(in: &cancellables)

        // Возврат приложения на экран — той же дорогой.
        AppLifecycle.shared.$isForeground
            .removeDuplicates()
            .dropFirst()
            .receive(on: DispatchQueue.main)
            .sink { [weak self] foreground in
                if foreground { self?.resyncAfterResume() }
            }
            .store(in: &cancellables)

        realtime.events
            .receive(on: DispatchQueue.main)
            .sink { [weak self] event in self?.handle(event) }
            .store(in: &cancellables)
    }

    private func bootstrap() async {
        let meta = await repo.conversationMeta(conversationId)
        if meta?.isSecretV2 == true {
            ui.loading = false
            ui.isSecretStub = true
            ui.headerSubtitle = "🔒 секретный чат"
            return
        }
        let group = meta?.isGroup ?? false
        ui.isGroup = group
        if group {
            // Групповым пузырям нужны аватары отправителей (история их не несёт).
            ui.senderAvatars = await repo.conversationSenderAvatars(conversationId)
        } else {
            peerUserId = meta?.otherUserId
            ui.peerUserId = peerUserId
        }
        let header = await repo.conversationHeader(conversationId)
        ui.headerAvatarUrl = header.avatarUrl
        ui.headerSubtitle = header.subtitle
        load()
    }

    private func handle(_ event: RealtimeEvent) {
        switch event {
        case .typing(let cid, let userId, let isTyping, let displayName):
            guard cid == conversationId, userId != repo.currentUserId() else { return }
            ui.typingName = isTyping ? (displayName ?? "печатает") : nil
            // TTL: потерянный typing=false не должен вешать «печатает…» навсегда.
            typingExpiry?.cancel()
            if isTyping {
                typingExpiry = Task { [weak self] in
                    try? await Task.sleep(for: .seconds(6))
                    if !Task.isCancelled { self?.ui.typingName = nil }
                }
            }

        case .messageNew(let cid, _, _, let message), .messageNotify(let cid, _, _, let message):
            guard cid == conversationId, !ui.isSecretStub else { return }
            appendRealtime(message)

        case .messageUpdate(let cid, _), .messageReaction(let cid, _),
             .receipts(let cid, _, _, _):
            guard cid == conversationId, !ui.isSecretStub else { return }
            scheduleReload()

        case .presence(let userId, let status, _):
            // Живой статус в шапке открытого 1:1 (раньше замерзал на момент открытия).
            if !ui.isGroup, userId == peerUserId {
                ui.headerSubtitle = presenceHeaderLabel(status)
            }

        default:
            break
        }
    }

    // MARK: - Загрузка и пагинация

    func load() {
        guard !ui.isSecretStub else { return }
        Task {
            ui.loading = ui.messages.isEmpty
            ui.error = nil
            switch await repo.history(conversationId, limit: Self.pageSize) {
            case .success(let page):
                applyPageOne(page)
                ui.loading = false
                markRead()
                fetchMissingPreviews()
            case .failure(let message, _):
                ui.loading = false
                ui.error = message
            }
        }
    }

    /// Свежая страница 1 ВЛИВАЕТСЯ в ленту, а не заменяет её (веб-паритет): долистанная
    /// назад история переживает refetch, свежие копии выигрывают дедуп, мета пагинации
    /// не сбрасывается после листания назад.
    private func applyPageOne(_ page: MessagesPage) {
        var seen = Set<String>()
        let merged = (page.messages + ui.messages)
            .filter { seen.insert($0.id).inserted }
            .sorted { $0.createdAt < $1.createdAt }
        ui.messages = merged
        if !pagedBack {
            ui.hasMore = page.hasMore
            ui.nextCursor = page.nextCursor
        }
    }

    /// Следующая СТАРШАЯ страница, приклеивается сверху.
    func loadOlder() {
        guard claimOlder() else { return }
        Task { await fetchOlderPage() }
    }

    /// Синхронный захват права «грузим назад» — до запуска задачи, иначе двойная загрузка.
    private func claimOlder() -> Bool {
        if loadingOlderFlag || !ui.hasMore || ui.nextCursor == nil { return false }
        if Date().timeIntervalSince1970 - lastOlderFailMs < Self.olderRetryCooldown { return false }
        loadingOlderFlag = true
        return true
    }

    @discardableResult
    private func fetchOlderPage() async -> Bool {
        ui.loadingOlder = true
        defer {
            ui.loadingOlder = false
            loadingOlderFlag = false
        }
        switch await repo.history(conversationId, cursor: ui.nextCursor, limit: Self.pageSize) {
        case .success(let page):
            pagedBack = true
            var seen = Set<String>()
            ui.messages = (page.messages + ui.messages)
                .filter { seen.insert($0.id).inserted }
                .sorted { $0.createdAt < $1.createdAt }
            ui.hasMore = page.hasMore
            ui.nextCursor = page.nextCursor
            fetchMissingPreviews()
            return true
        case .failure:
            lastOlderFailMs = Date().timeIntervalSince1970
            return false
        }
    }

    private func scheduleReload() {
        if Date().timeIntervalSince1970 - lastReload < 0.4 { return }
        reloadSilently()
    }

    private func reloadSilently() {
        lastReload = Date().timeIntervalSince1970
        Task {
            if case .success(let page) = await repo.history(conversationId, limit: Self.pageSize) {
                applyPageOne(page)
                fetchMissingPreviews()
            }
        }
    }

    /// Ресинк после реконнекта/возврата: тихий refetch БЕЗ markRead — экран может лежать
    /// в бэкстеке, авто-квитирование оттуда рисовало бы ложные «прочитано».
    private func resyncAfterResume() {
        guard !ui.isSecretStub else { return }
        reloadSilently()
    }

    private func appendRealtime(_ dto: MessageDto?) {
        guard let dto else {
            reloadSilently()
            return
        }
        let message = repo.mapMessage(dto)
        guard !ui.messages.contains(where: { $0.id == message.id }) else { return }
        ui.messages.append(message)
        ui.typingName = nil
        markRead()
        fetchMissingPreviews()
    }

    // MARK: - Отправка

    func send(_ text: String) {
        let trimmed = text.trimmed()
        guard !trimmed.isEmpty, !ui.sending, !ui.isSecretStub else { return }
        setTyping(false)
        let reply = ui.replyingTo
        let replyId = reply.last?.id
        Task {
            ui.sending = true
            ui.error = nil
            ui.replyingTo = []
            switch await repo.sendText(conversationId, text: trimmed, replyToId: replyId) {
            case .success(let message):
                ui.sending = false
                if !ui.messages.contains(where: { $0.id == message.id }) {
                    ui.messages.append(message)
                }
            case .failure(let message, _):
                // Сбой сети НЕ съедает написанное.
                ui.sending = false
                ui.error = message
                ui.restoredDraft = trimmed
                ui.replyingTo = reply
            }
            fetchMissingPreviews()
        }
    }

    /// Композер забрал восстановленный после сбоя текст.
    func consumeRestoredDraft() {
        ui.restoredDraft = nil
    }

    // MARK: - Действия

    func markAllRead() {
        guard !ui.isSecretStub else { return }
        Task { _ = await repo.markConversationRead(conversationId) }
    }

    /// Меню шапки: удалить (1:1) / выйти (группа) — затем уйти с экрана.
    func deleteOrLeave(onDone: @escaping () -> Void) {
        Task {
            let result: ApiResult<Void> = ui.isGroup
                ? await repo.leaveConversation(conversationId)
                : await repo.deleteConversation(conversationId)
            switch result {
            case .success: onDone()
            case .failure(let message, _): ui.error = message
            }
        }
    }

    func react(_ message: Message, emoji: String) {
        guard !ui.isSecretStub else { return }
        let mine = message.reactions.first { $0.emoji == emoji }?.mine ?? false
        Task {
            if case .success = await repo.toggleReaction(
                messageId: message.id, emoji: emoji, currentlyMine: mine
            ) {
                reloadSilently()
            }
        }
    }

    func edit(messageId: String, content: String) {
        guard !ui.isSecretStub, !content.trimmed().isEmpty else { return }
        Task {
            if case .success = await repo.editMessage(messageId: messageId, content: content) {
                reloadSilently()
            }
        }
    }

    func delete(messageId: String) {
        guard !ui.isSecretStub else { return }
        Task {
            if case .success = await repo.deleteMessage(messageId: messageId) {
                // Помечаем локально: refetch страницы 1 не достаёт долистанные назад.
                ui.messages = ui.messages.map {
                    var m = $0
                    if m.id == messageId { m.deleted = true }
                    return m
                }
                reloadSilently()
            }
        }
    }

    // MARK: - Ответ

    func setReply(_ message: Message) { ui.replyingTo = [message] }
    func clearReply() { ui.replyingTo = [] }

    // MARK: - Превью ссылок

    /// Зеркало веба: для TEXT со ссылкой без превью просим сервер (по одному разу).
    private func fetchMissingPreviews() {
        guard !ui.isSecretStub else { return }
        let candidates = ui.messages.filter {
            $0.type == "TEXT" && !$0.deleted && $0.linkPreview == nil &&
                !requestedPreviews.contains($0.id) && extractFirstUrl($0.content) != nil
        }.suffix(8)
        for m in candidates {
            requestedPreviews.insert(m.id)
            Task {
                guard case .success(let updated) = await repo.fetchLinkPreview(messageId: m.id),
                      let preview = updated.linkPreview else { return }
                ui.messages = ui.messages.map {
                    var msg = $0
                    if msg.id == m.id { msg.linkPreview = preview }
                    return msg
                }
            }
        }
    }

    private func markRead() {
        guard !ui.isSecretStub else { return }
        Task { _ = await repo.markConversationRead(conversationId) }
    }

    // MARK: - Набор текста

    func onInputChanged(_ text: String) {
        lastInputMs = Date().timeIntervalSince1970
        setTyping(!text.trimmed().isEmpty)
    }

    private func setTyping(_ typing: Bool) {
        guard typing != typingSent else { return }
        typingSent = typing
        realtime.sendTyping(conversationId: conversationId, typing: typing)
        if typing { startTypingHeartbeat() }
    }

    /// Серверный typing живёт ~6 с: пока печатают — typing=true каждые 2 с (как веб),
    /// при простое >3 с — typing=false.
    private func startTypingHeartbeat() {
        guard typingHeartbeat == nil else { return }
        typingHeartbeat = Task { [weak self] in
            while let self, self.typingSent {
                try? await Task.sleep(for: .seconds(2))
                if Task.isCancelled { break }
                guard self.typingSent else { break }
                if Date().timeIntervalSince1970 - self.lastInputMs > 3 {
                    self.setTyping(false)
                } else {
                    self.realtime.sendTyping(conversationId: self.conversationId, typing: true)
                }
            }
            self?.typingHeartbeat = nil
        }
    }

    /// Уход с экрана: погасить typing. Комнату НЕ покидаем (веб-паритет).
    func onDisappear() {
        setTyping(false)
    }
}
