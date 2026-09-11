import Foundation
import Combine

/// Готовое состояние звонка ДЛЯ ПЛИТКИ беседы: вью-модель уже свела серверный статус с
/// нашим локальным звонком, чтобы вью не пересчитывала это в `body`.
struct CallTile: Equatable {
    enum Kind: Equatable {
        /// Мы дозваниваемся («Звоним…»).
        case dialing
        /// Звонок идёт прямо сейчас.
        case ongoing
        /// Только что завершился («Завершён N мин назад»).
        case ended
    }

    let kind: Kind
    /// Мы участник звонка (этим или другим своим устройством) — веб показывает
    /// длительность ТОЛЬКО участникам, остальным просто «В ЗВОНКЕ».
    let participating: Bool
    /// Звонок открыт на ЭТОМ устройстве: кнопка не «Подключиться», а «Вернуться».
    let mine: Bool
    let startedAt: Int64?
    let endedAt: Int64?
}

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
        /// Состояние звонков по беседам — зеркало общего CallStatusStore
        /// (Core/Realtime: его читают и шапка беседы, и этот список).
        var calls: [String: CallStatusStore.Entry] = [:]
        /// Беседа, звонок которой открыт на ЭТОМ устройстве (дозвон или разговор).
        var myCallConversationId: String?
        /// Наш звонок уже соединён, а не «Звоним…».
        var myCallActive = false
        /// Начало НАШЕГО разговора — таймер плитки для участника.
        var myCallStartedAt: Int64?
    }

    @Published private(set) var ui = UiState(loading: true)

    private let repo: ChatRepository
    private let realtime: RealtimeClient
    private let contacts: ContactsRepository
    private let secret: SecretRepository

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

    /// Звонки живут в ядре, а не в этом экране: список только читает состояние и просит
    /// подключиться. Берём из контейнера, а не через init, чтобы не менять точку сборки.
    private let callManager = AppContainer.shared.callManager

    /// Сколько после звонка держим в плитке «Завершён …» — столько же, сколько шапка
    /// беседы (ChatHeader.callEndedVisibleMs), иначе список и шапка говорят разное.
    private static let endedCallTTL: Int64 = 5 * 60_000

    init(
        repo: ChatRepository,
        realtime: RealtimeClient,
        contacts: ContactsRepository,
        secret: SecretRepository
    ) {
        self.repo = repo
        self.realtime = realtime
        self.contacts = contacts
        self.secret = secret

        let cached = repo.cachedConversations()
        if !cached.isEmpty {
            ui.loading = false
            ui.conversations = cached
        }
        refresh()

        // Состояние звонков в беседах (call:status / call:status:bulk) — общий стор.
        CallStatusStore.shared.$calls
            .receive(on: DispatchQueue.main)
            .sink { [weak self] calls in self?.ui.calls = calls }
            .store(in: &cancellables)

        // Свой звонок: о нём сервер рассылает тот же call:status, но плитка должна
        // подсветиться сразу, не дожидаясь эха, — и только локальное состояние знает,
        // что оверлей открыт ЗДЕСЬ (кнопка «Вернуться», а не «Подключиться»).
        callManager.$phase
            .combineLatest(callManager.$conversationId, callManager.$activeSince)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] state in
                guard let self else { return }
                let (phase, conversationId, activeSince) = state
                // Входящий звонок плитку не меняет: его показывает оверлей поверх всего.
                let mine = (phase == .idle || phase == .incoming) ? nil : conversationId
                let startedAt = activeSince.map { Int64($0.timeIntervalSince1970 * 1000) }
                self.ui.myCallConversationId = mine
                self.ui.myCallActive = phase.isActive
                self.ui.myCallStartedAt = startedAt
            }
            .store(in: &cancellables)

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

    /// Меню плитки: начать (или переиспользовать) V2-секретный тред с собеседником 1:1.
    func startSecretChat(_ c: Conversation, onOpened: @escaping (ConversationRef) -> Void) {
        guard let peerId = c.otherUserId else { return }
        Task {
            switch await contacts.startSecretConversation(userId: peerId) {
            case .success(let result): onOpened(result.ref)
            case .failure(let message, _): ui.error = message
            }
        }
    }

    /// Отметить беседу прочитанной (у секреток нет квитанций — пропускаем).
    func markConversationRead(_ c: Conversation) {
        guard !c.isSecretV2 else { return }
        Task {
            _ = await repo.markConversationRead(c.id)
            refresh()
        }
    }

    /// Удалить (1:1) / выйти (группа) / закрыть (секретный тред).
    func deleteConversation(_ c: Conversation) {
        Task {
            // Жёсткое удаление секретки осиротило бы её E2EE-транспортные строки —
            // штатный демонтаж это decline → CANCELLED (скрыт на всех устройствах).
            let result: ApiResult<Void>
            if c.isSecretV2 {
                result = await secret.declineInvite(threadId: c.id)
            } else if c.isGroup {
                result = await repo.leaveConversation(c.id)
            } else {
                result = await repo.deleteConversation(c.id)
            }
            switch result {
            case .success:
                realtime.forgetConversation(c.id) // беседы больше нет — комната не нужна
                refresh()
            case .failure(let message, _):
                ui.error = message
            }
        }
    }

    // MARK: - Идущий звонок в беседе

    /// Что показывать про звонок в плитке беседы. Порт приоритетов веба
    /// (ConversationListPane.tsx:328-381): «Звоним...» на дозвоне, «В ЗВОНКЕ: m:ss»
    /// участнику, «В ЗВОНКЕ» остальным, «Завершён N назад» — сразу после звонка.
    func callTile(for conversationId: String) -> CallTile? {
        let entry = ui.calls[conversationId]
        if ui.myCallConversationId == conversationId {
            guard ui.myCallActive else {
                return CallTile(
                    kind: .dialing, participating: true, mine: true,
                    startedAt: nil, endedAt: nil
                )
            }
            return CallTile(
                kind: .ongoing, participating: true, mine: true,
                startedAt: ui.myCallStartedAt ?? entry?.startedAt, endedAt: nil
            )
        }
        guard let entry else { return nil }
        if entry.active {
            // Участник по версии СЕРВЕРА — это мы же, но с другого устройства
            // (веб в этом случае подписывает кнопку «Тоже сюда»).
            let participating = repo.currentUserId().map { entry.participants.contains($0) } ?? false
            return CallTile(
                kind: .ongoing, participating: participating, mine: false,
                startedAt: entry.startedAt, endedAt: nil
            )
        }
        guard let endedAt = entry.endedAt,
              Int64(Date().timeIntervalSince1970 * 1000) - endedAt < Self.endedCallTTL
        else { return nil }
        return CallTile(
            kind: .ended, participating: false, mine: false,
            startedAt: entry.startedAt, endedAt: endedAt
        )
    }

    /// Кнопка плитки: войти в идущий звонок беседы (или вернуться в свой). Логика общая
    /// с кнопками шапки — joinOrStartConversationCall в ChatHeader.swift.
    func joinCall(_ c: Conversation, video: Bool = false) {
        joinOrStartConversationCall(conversationId: c.id, title: c.title, video: video)
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
                // Снапшот идущих звонков (веб-паритет): без него список узнаёт о звонке,
                // только если тот начался при живом сокете. Просим здесь же, потому что
                // именно тут известен актуальный набор бесед — и после реконнекта сюда
                // приводит ресинк по realtime.$connected.
                realtime.requestCallStatuses(list.map { $0.id })
                ui.loading = false
                ui.refreshing = false
                // Порядок задаёт репозиторий (lastMessageAt, а у беседы без сообщений —
                // createdAt), здесь его не пересчитываем: две сортировки разошлись бы.
                ui.conversations = list
            case .failure(let message, _):
                ui.loading = false
                ui.refreshing = false
                ui.error = message
            }
        }
    }
}
