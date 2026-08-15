import Foundation
import Combine

/// Порт `feature/chat/ChatViewModel.kt`.
///
/// Секретный V2-режим (E2EE-транспорт вместо /conversations/*) живёт в расширении
/// ChatViewModelSecret.swift — здесь только его хранимые поля и развилки `secretMode`,
/// потому что extension в Swift не умеет добавлять хранимые свойства.
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
        /// Режим мультивыбора (порт selectionMode/selectedIds из Kotlin UiState).
        var selectionMode = false
        var selectedIds: Set<String> = []
        /// 1:1-собеседник (открытие карточки по шапке; nil для групп).
        var peerUserId: String?
        /// Текст, который надо вернуть в композер после сбоя отправки.
        var restoredDraft: String?
        /// Прогресс аплоада вложений 0..1; nil — аплоад не идёт (полоса в композере).
        var uploadProgress: Float?
        /// Очередь вложений (веб-паритет: выбранное НЕ отправляется сразу, а встаёт чипами).
        var staged: [OutgoingFile] = []
        // --- Секретный тред V2 (имена 1:1 с Kotlin ChatUiState) ---
        /// E2EE-транспорт: без квитанций, реакций и правки (веб-паритет).
        var isSecret = false
        /// Ключ треда на руках — композер реально может шифровать.
        var secretReady = false
        /// Сообщения, ждущие прихода ключа создателя.
        var secretQueued = 0
        /// PENDING-приглашение, которое это устройство должно принять или отклонить.
        var secretInvite = false
        var secretInviteBusy = false
        /// Приглашение отклонено/отменено → экран уходит назад.
        var secretDeclined = false
        /// МЫ создали приглашение — блокировка до принятия собеседником.
        var secretWaiting = false
        // --- Привязка устройства (внутри секретного чата, как в вебе) ---
        /// У аккаунта есть ДРУГИЕ устройства — значит ключ можно попросить у них.
        var hasOtherDevices = false
        /// У этого устройства есть хоть один ключ секретки → оно НЕ новое.
        var hasAnySecretKeys = false
        var linkScanning = false
        var linkCode = ""
        var linkBusy = false
        /// Запрос ушёл на N устройств — ждём подтверждения там.
        var linkRequestedOn: Int?
        var linkError: String?
        /// Мы — доверенное устройство: показываем приглашение (QR + код + остаток TTL).
        var linkInvite: DeviceLinkInvite?
        var linkInviteLeftMs: Int64 = 0
        /// Сколько ключей приехало при удачной привязке (для тоста «готово»).
        var linkedKeys: Int?
        /// Кому мы отдали ключи: имя устройства + число тредов.
        var linkedOut: LinkedDevice?
    }

    @Published var ui = UiState()

    let repo: ChatRepository
    let realtime: RealtimeClient
    let conversationId: String

    private var typingSent = false
    /// true → аборт текущего аплоада между частями (кнопка «отмена» у прогресса).
    var uploadCancelled = false
    private var typingHeartbeat: Task<Void, Never>?
    private var typingExpiry: Task<Void, Never>?
    private var lastInputMs: TimeInterval = 0
    private var lastReload: TimeInterval = 0
    private var requestedPreviews: Set<String> = []
    var cancellables: Set<AnyCancellable> = []

    // Стражи пагинации (веб-паритет): флаг ставится синхронно ДО запуска (триггер у
    // верха срабатывает каждый кадр), pagedBack замораживает курсор после листания назад.
    var loadingOlderFlag = false // internal: ChatViewModelJump.loadUntil ждёт параллельную подгрузку
    var pagedBack = false
    // Карантин после НЕУДАЧНОЙ подгрузки назад — иначе мгновенный бесконечный ретрай.
    var lastOlderFailMs: TimeInterval = 0

    private var peerUserId: String?

    // --- Секретный режим (логика — в ChatViewModelSecret.swift) ---
    let secretRepo: SecretRepository
    /// В Kotlin поле @Volatile; здесь класс @MainActor, гонок нет по построению.
    var secretMode = false
    var secretPeers: [String] = []
    /// Отправки, поставленные в очередь до прихода ключа треда.
    var secretQueue: [String] = []

    static let pageSize = 80 // веб MESSAGES_PAGE_SIZE
    // >10 МБ уходит чанками (веб-паритет); страховочный потолок — 100 МБ (файл в памяти).
    private static let maxUploadBytes = 100 * 1024 * 1024
    private static let olderRetryCooldown: TimeInterval = 4

    init(
        repo: ChatRepository,
        realtime: RealtimeClient,
        conversationId: String,
        secretRepo: SecretRepository
    ) {
        self.repo = repo
        self.realtime = realtime
        self.conversationId = conversationId
        self.secretRepo = secretRepo

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
            await initSecret()
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
        // Секретный режим забирает свои события целиком (порт ранних return'ов Kotlin).
        if handleSecretEvent(event) { return }
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
            guard cid == conversationId, !secretMode else { return }
            appendRealtime(message)

        case .messageUpdate(let cid, _), .messageReaction(let cid, _),
             .receipts(let cid, _, _, _):
            guard cid == conversationId, !secretMode else { return }
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
        if secretMode {
            Task { await loadSecret() }
            return
        }
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
    func claimOlder() -> Bool { // internal: ChatViewModelJump.loadUntil
        if loadingOlderFlag || !ui.hasMore || ui.nextCursor == nil { return false }
        if Date().timeIntervalSince1970 - lastOlderFailMs < Self.olderRetryCooldown { return false }
        loadingOlderFlag = true
        return true
    }

    @discardableResult
    func fetchOlderPage() async -> Bool { // internal: ChatViewModelJump.loadUntil
        if secretMode { return await fetchOlderPageSecret() }
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
        if secretMode {
            Task {
                await secretRepo.syncInbox()
                await loadSecret()
            }
            return
        }
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
        guard !trimmed.isEmpty, !ui.sending else { return }
        setTyping(false)
        if secretMode {
            sendSecret(trimmed)
            return
        }
        let reply = ui.replyingTo
        let replyId = reply.last?.id
        // Мультиответ: все цитаты уходят в metadata.replyQuoteBundle (≥2, как Kotlin/веб).
        let bundle: [ReplyInfo]? = reply.count >= 2
            ? reply.map { ReplyInfo(id: $0.id, senderId: $0.senderId, content: $0.content, createdAt: $0.createdAt) }
            : nil
        Task {
            ui.sending = true
            ui.error = nil
            ui.replyingTo = []
            switch await repo.sendText(
                conversationId, text: trimmed, replyToId: replyId, replyBundle: bundle
            ) {
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

    // MARK: - Вложения и голосовые

    func sendAttachment(bytes: Data, fileName: String, mime: String) {
        sendAttachments([OutgoingFile(bytes: bytes, name: fileName, mime: mime)])
    }

    /// Проблема UI-уровня (например, сбой чтения пикера) — через тот же баннер ошибок.
    func setError(_ message: String) {
        ui.error = message
    }

    /// Шлёт все [files] ОДНИМ сообщением (фотоальбом). Веб-капы: 10 фото + 10 файлов.
    func sendAttachments(_ files: [OutgoingFile], caption: String? = nil, onSuccess: (() -> Void)? = nil) {
        guard !files.isEmpty else { return }
        if ui.sending {
            ui.error = "Подождите — идёт отправка предыдущего сообщения"
            return
        }
        // Сначала картинки (веб-порядок вложений — он задаёт сетку альбома), каждый вид ≤10.
        // Капы ДО проверки размера, чтобы 11-й негабарит не ветировал валидный альбом.
        let imgs = files.filter { $0.mime.hasPrefix("image/") }
        let rest = files.filter { !$0.mime.hasPrefix("image/") }
        let limited = Array(imgs.prefix(10)) + Array(rest.prefix(10))
        if let tooBig = limited.first(where: { $0.bytes.count > Self.maxUploadBytes }) {
            ui.error = "Файл слишком большой (макс. 100 МБ): \(tooBig.name)"
            return
        }
        uploadCancelled = false
        if secretMode {
            // E2EE-вложения шифруются ключом треда и уходят непрозрачными блобами.
            sendSecretAttachments(limited, caption: caption, onSuccess: onSuccess)
            return
        }
        Task {
            ui.sending = true
            ui.error = nil
            ui.uploadProgress = 0
            let r = await repo.sendAttachments(
                conversationId,
                files: limited,
                caption: caption,
                onProgress: { [weak self] done, total in
                    guard total > 0 else { return }
                    let pct = min(max(Float(done) / Float(total), 0), 1)
                    // Колбэк приходит с фонового потока; стейт дросселируем до целых
                    // процентов — иначе рекомпозиции на каждый чанк.
                    Task { @MainActor [weak self] in
                        guard let self else { return }
                        if Int(pct * 100) != Int((self.ui.uploadProgress ?? 0) * 100) {
                            self.ui.uploadProgress = pct
                        }
                    }
                },
                isCancelled: { [weak self] in self?.uploadCancelled ?? true }
            )
            switch r {
            case .success(let message):
                onSuccess?()
                ui.sending = false
                ui.uploadProgress = nil
                if !ui.messages.contains(where: { $0.id == message.id }) {
                    ui.messages.append(message)
                }
            case .failure(let message, _):
                ui.sending = false
                ui.uploadProgress = nil
                if uploadCancelled {
                    // Отмена — не ошибка, но подпись возвращаем: она была частью сообщения.
                    ui.restoredDraft = caption
                } else {
                    ui.error = message
                    ui.restoredDraft = caption
                }
            }
        }
    }

    /// Кнопка «отмена» у прогресса: аборт между частями, серверная сессия прибирается.
    func cancelUpload() {
        uploadCancelled = true
    }

    // MARK: - Стейджинг вложений (веб-паритет: выбранное НЕ отправляется сразу)

    /// Пикер вернул файлы: кладём в очередь чипов; лимиты как у альбома (10 фото + 10 файлов).
    func stageFiles(_ files: [OutgoingFile]) {
        guard !files.isEmpty else { return }
        let merged = ui.staged + files
        let imgs = merged.filter { $0.mime.hasPrefix("image/") }
        let rest = merged.filter { !$0.mime.hasPrefix("image/") }
        let limited = Array(imgs.prefix(10)) + Array(rest.prefix(10))
        if limited.count < merged.count {
            ui.error = "Максимум 10 фото и 10 файлов за раз"
        }
        ui.staged = limited
    }

    func removeStaged(_ index: Int) {
        ui.staged = ui.staged.enumerated().filter { $0.offset != index }.map(\.element)
    }

    func clearStaged() {
        ui.staged = []
    }

    /// Отправка очереди с подписью. Очередь чистится ТОЛЬКО при успехе — сбой/отмена
    /// оставляют чипы на месте (плюс restoredDraft вернёт подпись).
    func sendStaged(_ caption: String?) {
        let files = ui.staged
        guard !files.isEmpty, !ui.sending else { return }
        sendAttachments(files, caption: caption, onSuccess: { [weak self] in self?.ui.staged = [] })
    }

    /// Отправляет записанный голосовой клип (data — AAC/MP4 из VoiceRecorder) как
    /// AUDIO-сообщение с длительностью и волной.
    func sendVoice(_ data: Data, durationSec: Int, waveform: [Int]) {
        guard !ui.sending else { return }
        if secretMode {
            sendSecretVoice(data, durationSec: durationSec, waveform: waveform)
            return
        }
        Task {
            ui.sending = true
            ui.error = nil
            switch await repo.sendVoiceMessage(
                conversationId, bytes: data, durationSec: durationSec, waveform: waveform
            ) {
            case .success(let message):
                ui.sending = false
                if !ui.messages.contains(where: { $0.id == message.id }) {
                    ui.messages.append(message)
                }
            case .failure(let message, _):
                ui.sending = false
                ui.error = message
            }
        }
    }

    // MARK: - Действия

    func markAllRead() {
        guard !secretMode else { return }
        Task { _ = await repo.markConversationRead(conversationId) }
    }

    /// Меню шапки: удалить (1:1) / выйти (группа) / закрыть (секретный) — затем уйти с экрана.
    func deleteOrLeave(onDone: @escaping () -> Void) {
        Task {
            // Жёсткое удаление секретки осиротило бы её E2EE-транспортные строки —
            // штатный демонтаж это decline → CANCELLED (скрыт на всех устройствах).
            let result: ApiResult<Void>
            if secretMode {
                result = await secretRepo.declineInvite(threadId: conversationId)
            } else if ui.isGroup {
                result = await repo.leaveConversation(conversationId)
            } else {
                result = await repo.deleteConversation(conversationId)
            }
            switch result {
            case .success: onDone()
            case .failure(let message, _): ui.error = message
            }
        }
    }

    func react(_ message: Message, emoji: String) {
        guard !secretMode else { return }
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
        guard !secretMode, !content.trimmed().isEmpty else { return }
        Task {
            if case .success = await repo.editMessage(messageId: messageId, content: content) {
                reloadSilently()
            }
        }
    }

    func delete(messageId: String) {
        guard !secretMode else { return }
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

    // MARK: - Мультивыбор (порт startSelection/toggleSelect/... из Kotlin)

    func startSelection(_ messageId: String) {
        ui.selectionMode = true
        ui.selectedIds = [messageId]
    }

    func toggleSelect(_ messageId: String) {
        var next = ui.selectedIds
        if !next.insert(messageId).inserted { next.remove(messageId) }
        if next.isEmpty {
            ui.selectionMode = false
            ui.selectedIds = []
        } else {
            ui.selectedIds = next
        }
    }

    func clearSelection() {
        ui.selectionMode = false
        ui.selectedIds = []
    }

    func selectedMessages() -> [Message] {
        ui.messages.filter { ui.selectedIds.contains($0.id) }
    }

    /// Пакетное удаление выбранных НАШИХ сообщений (серверное удаление — для всех).
    func deleteSelected() {
        if secretMode { clearSelection(); return }
        let ids = ui.messages
            .filter { ui.selectedIds.contains($0.id) && $0.isMine && !$0.deleted }
            .map(\.id)
        clearSelection()
        Task {
            var deleted: Set<String> = []
            for id in ids {
                if case .success = await repo.deleteMessage(messageId: id) { deleted.insert(id) }
            }
            // Помечаем локально: refetch страницы 1 не достаёт долистанные назад.
            ui.messages = ui.messages.map {
                var m = $0
                if deleted.contains(m.id) { m.deleted = true }
                return m
            }
            reloadSilently()
        }
    }

    /// Ответ на ВСЕ выбранные (мультиответ), затем выход из режима выбора.
    func replyToSelected() {
        let msgs = selectedMessages().filter { !$0.isSystem }
        guard !msgs.isEmpty else { return }
        clearSelection()
        ui.replyingTo = msgs
    }

    // MARK: - Пересылка

    /// Пересылает messages в беседу targetConversationId (и снимает выбор, если активен).
    func forward(targetConversationId: String, messages: [Message]) {
        // Пересылка ИЗ секретки запрещена: forwardMessage ушёл бы в облачный /send открытым
        // текстом + связал бы имя/mime/размер с .enc-блобом на сервере.
        if secretMode { clearSelection(); return }
        clearSelection()
        Task {
            for m in messages where !m.isSystem && !m.deleted {
                _ = await repo.forwardMessage(targetConversationId: targetConversationId, message: m)
            }
        }
    }

    // MARK: - Превью ссылок

    /// Зеркало веба: для TEXT со ссылкой без превью просим сервер (по одному разу).
    private func fetchMissingPreviews() {
        guard !secretMode else { return }
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
        guard !secretMode else { return }
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
