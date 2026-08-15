import Foundation
import Combine

/// Порт `feature/chat/ChatListViewModel.kt`.
///
/// Отличия от Kotlin-оригинала: без UpdateManager (обновления на iOS — TestFlight/App
/// Store), секретные чаты и контакты подключатся своими фазами.
@MainActor
final class ChatListViewModel: ObservableObject {

    struct UiState {
        var loading = false
        var refreshing = false
        var conversations: [Conversation] = []
        /// Беседы, где прямо сейчас кто-то печатает («печатает…» в строке плитки).
        var typingConversations: Set<String> = []
        var error: String?
        /// НАШЕ присутствие (ONLINE/BACKGROUND/AWAY/IN_CALL/OFFLINE) для своей строки.
        var selfPresence = "OFFLINE"
    }

    @Published private(set) var ui = UiState(loading: true)

    private let repo: ChatRepository
    private let realtime: RealtimeClient

    private var lastRefresh: TimeInterval = 0
    private var pendingRefresh: Task<Void, Never>?
    /// Серверное представление НАШЕГО присутствия (эхо presence:update о себе).
    private var myPresence: String?
    private var socketConnected = false
    private var cancellables: Set<AnyCancellable> = []

    private static let refreshDebounce: TimeInterval = 0.8
    private static let typingTTL: TimeInterval = 4 // веб-паритет: индикатор гаснет сам

    // conversationId → момент последнего typing=true.
    private var typingRows: [String: TimeInterval] = [:]
    private var typingSweep: Task<Void, Never>?

    init(repo: ChatRepository, realtime: RealtimeClient) {
        self.repo = repo
        self.realtime = realtime

        let cached = repo.cachedConversations()
        if !cached.isEmpty {
            ui.loading = false
            ui.conversations = cached
        }
        refresh()

        // Свой статус следует за сокетом только как ФОЛБЭК (connected-but-unconfirmed →
        // BACKGROUND). На обрыве myPresence НЕ чистим (веб-паритет): краткий реконнект не
        // должен мигать OFFLINE.
        realtime.$connected
            .receive(on: DispatchQueue.main)
            .sink { [weak self] connected in
                guard let self else { return }
                // Ресинк после реконнекта: пока сокет лежал, события не доходили.
                if connected && !self.socketConnected { self.scheduleRefresh() }
                self.socketConnected = connected
                self.recomputeSelfPresence()
            }
            .store(in: &cancellables)

        // Возврат в приложение: refetch списка (веб: syncAfterResume).
        AppLifecycle.shared.$isForeground
            .removeDuplicates()
            .dropFirst()
            .receive(on: DispatchQueue.main)
            .sink { [weak self] foreground in
                if foreground { self?.scheduleRefresh() }
            }
            .store(in: &cancellables)

        realtime.events
            .receive(on: DispatchQueue.main)
            .sink { [weak self] event in
                self?.handle(event)
            }
            .store(in: &cancellables)
    }

    private func handle(_ event: RealtimeEvent) {
        switch event {
        case .typing(let conversationId, let userId, let isTyping, _):
            guard userId != repo.currentUserId() else { return }
            if isTyping {
                typingRows[conversationId] = Date().timeIntervalSince1970
                bumpTyping()
                scheduleTypingSweep()
            } else {
                typingRows.removeValue(forKey: conversationId)
                bumpTyping()
            }

        case .presence(let userId, let status, _):
            if userId == repo.currentUserId() {
                // Сервер эхом сообщает наш статус: ONLINE в активном окне / BACKGROUND в фоне.
                myPresence = status
                recomputeSelfPresence()
            } else {
                let online = status == "ONLINE" || status == "IN_CALL"
                ui.conversations = ui.conversations.map { c in
                    guard c.otherUserId == userId else { return c }
                    var updated = c
                    // Полный статус сохраняем: схлопывание BACKGROUND в online=false
                    // заставляло плитки врать «был(а) онлайн».
                    updated.online = online
                    updated.otherStatus = status
                    return updated
                }
            }

        case .messageNew, .messageNotify, .conversationsChanged, .secretChatAccepted:
            scheduleRefresh()

        default:
            break
        }
    }

    /// Последний известный статус побеждает; только неизвестный падает на фолбэк сокета.
    private func recomputeSelfPresence() {
        ui.selfPresence = myPresence ?? (socketConnected ? "BACKGROUND" : "OFFLINE")
    }

    // MARK: - «Печатает…» в списке

    private func bumpTyping() {
        let now = Date().timeIntervalSince1970
        ui.typingConversations = Set(
            typingRows.filter { now - $0.value < Self.typingTTL }.keys
        )
    }

    /// Одна отложенная «уборка»: гасит индикатор, если typing=false потерялся.
    private func scheduleTypingSweep() {
        guard typingSweep == nil else { return }
        typingSweep = Task { [weak self] in
            while let self, !self.typingRows.isEmpty {
                try? await Task.sleep(for: .seconds(1))
                if Task.isCancelled { break }
                let now = Date().timeIntervalSince1970
                self.typingRows = self.typingRows.filter { now - $0.value < Self.typingTTL }
                self.bumpTyping()
            }
            self?.typingSweep = nil
        }
    }

    /// Дебаунс с ХВОСТОВЫМ запуском: события внутри окна 800 мс сливаются в один
    /// отложенный refresh, а не выбрасываются.
    private func scheduleRefresh() {
        let elapsed = Date().timeIntervalSince1970 - lastRefresh
        if elapsed > Self.refreshDebounce {
            refresh()
            return
        }
        guard pendingRefresh == nil else { return }
        pendingRefresh = Task { [weak self] in
            try? await Task.sleep(for: .seconds(Self.refreshDebounce - elapsed))
            self?.pendingRefresh = nil
            if !Task.isCancelled { self?.refresh() }
        }
    }

    // MARK: - Действия меню плитки

    /// Отметить беседу прочитанной (у секреток нет квитанций — пропускаем).
    func markConversationRead(_ c: Conversation) {
        guard !c.isSecretV2 else { return }
        Task {
            _ = await repo.markConversationRead(c.id)
            refresh()
        }
    }

    /// Удалить (1:1) / выйти (группа). Секретки — фазой секретных чатов.
    func deleteConversation(_ c: Conversation) {
        Task {
            let result: ApiResult<Void> = c.isGroup
                ? await repo.leaveConversation(c.id)
                : await repo.deleteConversation(c.id)
            switch result {
            case .success:
                realtime.forgetConversation(c.id) // беседы больше нет — комната не нужна
                refresh()
            case .failure(let message, _):
                ui.error = message
            }
        }
    }

    func refresh() {
        lastRefresh = Date().timeIntervalSince1970
        Task {
            ui.loading = ui.conversations.isEmpty
            ui.refreshing = !ui.conversations.isEmpty
            ui.error = nil
            switch await repo.listConversations() {
            case .success(let list):
                // Членство во всех комнатах бесед (веб-паритет): иначе сервер не шлёт
                // conversation:typing_update на экран списка.
                list.forEach { realtime.joinConversation($0.id) }
                ui.loading = false
                ui.refreshing = false
                ui.conversations = list
            case .failure(let message, _):
                ui.loading = false
                ui.refreshing = false
                ui.error = message
            }
        }
    }
}
