import Foundation
import Combine
import UIKit
import ImageIO

/// Живая отправка вложения, пришитая к оптимистичному пузырю в ленте: пока файл летит,
/// пузырь показывает прогресс и крестик отмены, а после сбоя остаётся с пометкой и
/// кнопкой повтора. Веб держит такую же запись в pendingByConv (ChatsPage.tsx:5071),
/// только повтора у него нет — призрак просто исчезает с тостом.
struct OutgoingUpload: Equatable {
    /// 0..1 по ВСЕМ файлам сообщения (тот же счёт, что был у полосы над композером).
    var progress: Float = 0
    /// Отправка упала (не отменена) — пузырь ждёт «Повторить» или «Удалить».
    var failed = false
    /// Текст сбоя для подписи/баннера.
    var error: String?
}

/// Что человек нажал на оптимистичном пузыре. Одним входом, чтобы лента передавала
/// действия одним замыканием, а не тремя.
enum OutgoingUploadAction {
    case cancel
    case retry
    case discard
}

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
        /// Прямо сейчас в начало ленты вклеивается страница истории. Лента на это время
        /// переключает якорь размера на низ, иначе вставка сверху сдвигает видимое.
        var prepending = false
        /// Короткая блокировка композера. Веб её почти не знает: там гаснет только правка
        /// (MessagesPane.tsx: disabled={editBusy}) и композер под живой пересылкой, а во
        /// время аплоада переписка продолжается. Здесь флаг остался ровно у этих двух
        /// случаев — отправка пачки пересылки и секретный путь (ChatViewModelSecret);
        /// обычные текст, голосовое и вложения композер больше НЕ запирают: отправляемое
        /// видно пузырём в ленте, а поле ввода свободно.
        var sending = false
        var isGroup = false
        var senderAvatars: [String: String?] = [:]
        var headerAvatarUrl: String?
        /// Подзаголовок ГРУППЫ — перечисление участников. У 1:1 пусто: там строку статуса
        /// шапка считает сама из peerStatus/peerLastSeen/игры (ChatHeader).
        var headerSubtitle: String?
        /// Сырой статус собеседника (ONLINE/BACKGROUND/IN_CALL/OFFLINE…). Именно сырой, а
        /// не готовая подпись: по нему шапка красит и точку присутствия, и текст.
        var peerStatus: String?
        /// Когда собеседника видели последний раз (мс эпохи) — «был(а) онлайн …».
        var peerLastSeen: Int64?
        var messages: [Message] = []
        /// id первого непрочитанного сообщения — над ним лента рисует разделитель
        /// «Непрочитанные сообщения» и на нём же открывается чат. Ставится РОВНО один раз
        /// за визит (см. resolveUnreadAnchorIfNeeded) и дальше не двигается: markRead
        /// уходит сразу после первой страницы, и любой пересчёт стёр бы разделитель.
        var unreadAnchorId: String?
        var hasMore = false
        var nextCursor: String?
        var typingName: String?
        var error: String?
        /// Короткий положительный итог действия («Переслано в «…»»): показывается вместо
        /// молчания, когда сказать надо, но ошибки нет. Гаснет сам (см. showNotice).
        var notice: String?
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
        /// Обычный чат её больше не заполняет: прогресс переехал на сам пузырь в ленте
        /// (см. outgoing), полоса осталась секретному пути до его переезда туда же.
        var uploadProgress: Float?
        /// Отправки вложений, которые прямо сейчас летят (или упали): ключ — id
        /// оптимистичного пузыря в messages. По ним пузырь рисует прогресс, отмену и повтор.
        var outgoing: [String: OutgoingUpload] = [:]
        /// Очередь вложений (веб-паритет: выбранное НЕ отправляется сразу, а встаёт чипами).
        var staged: [OutgoingFile] = []
        /// Отложенная пересылка В ЭТУ беседу (веб forwardComposerDraft): сообщения уже
        /// выбраны, но ещё не ушли — текст композера станет комментарием к ним.
        var forwardDraft: ForwardDraft?
        /// Пуст ли композер. Нужно только плашке пересылки: пока пусто, отправляет она
        /// (у пустого композера вместо стрелки стоит микрофон). Пишется ТОЛЬКО на
        /// переходе пусто/непусто и только при живом черновике — иначе каждое нажатие
        /// клавиши перестраивало бы ленту (ровно то, от чего композер вынесли отдельно).
        var composerEmpty = true
        // --- Секретный тред V2 (имена 1:1 с Kotlin ChatUiState) ---
        /// E2EE-транспорт: без квитанций, реакций и правки (веб-паритет).
        var isSecret = false
        /// Ключ треда на руках — композер реально может шифровать.
        var secretReady = false
        /// Сколько сообщений ждёт прихода ключа создателя (зеркало SecretOutbox
        /// по этой беседе — источник правды там, здесь только число для UI).
        var secretQueued = 0
        /// Счётчик-сигнал «ключ треда приехал, пока экран открыт»: по нему вью даёт
        /// короткую галочку «Готово». Именно счётчик, а не Bool от secretReady: в уже
        /// рабочей секретке secretReady поднимается в initSecret, и галочка вспыхивала бы
        /// при каждом входе, хотя ничего не происходило.
        var secretKeyArrived = 0
        /// Ключи не доехали: код первопричины (веб ROOT_CAUSE, обычно NO_KEYPACKAGE).
        /// nil — ошибки нет. Ставится сторожем ожидания, а не первым сетевым сбоем.
        var secretKeysError: String?
        /// Идёт ручной повтор обмена ключами («Восстановить») — кнопки плашки погашены.
        var secretKeysRetrying = false
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

    /// Кто мы — нужно вью для запоминания выбранных реакций.
    var currentUserId: String? { repo.currentUserId() }

    /// Порядок ленты: по времени, а при совпадении — по id. Без тай-брейка сортировка
    /// пачки одновременных сообщений (альбом, системные строки звонка) не воспроизводима,
    /// и порядок на айфоне расходился с вебом, а иногда менялся после каждой реакции.
    static func olderFirst(_ lhs: Message, _ rhs: Message) -> Bool {
        lhs.createdAt == rhs.createdAt ? lhs.id < rhs.id : lhs.createdAt < rhs.createdAt
    }

    private var typingSent = false
    /// true → аборт текущего аплоада между частями (кнопка «отмена» у полосы прогресса).
    /// Общий флаг остался секретному пути; у обычных отправок отмена поштучная —
    /// их теперь может лететь несколько сразу (cancelledOutgoing).
    var uploadCancelled = false
    /// Чем повторить упавшую отправку: файлы, подпись и цитаты. Лежит ВНЕ UiState нарочно —
    /// это мегабайты, которым нечего делать в публикуемом состоянии экрана.
    private var outgoingPayloads: [String: OutgoingPayload] = [:]
    /// Локальные превью пузырей (tmp-файлы): убираются вместе с пузырём.
    private var outgoingPreviews: [String: [URL]] = [:]
    /// Отменённые отправки. Под замком, потому что читает это фоновый колбэк аплоада,
    /// а пишет главный поток.
    private let cancelledOutgoing = Mutex<Set<String>>([])
    /// Очередь текстовых отправок: запрос больше не запирает композер, но два быстро
    /// набранных сообщения не должны прийти на сервер в обратном порядке.
    private var textSendChain: Task<Void, Never>?
    private var typingHeartbeat: Task<Void, Never>?
    private var typingExpiry: Task<Void, Never>?
    private var lastInputMs: TimeInterval = 0
    private var lastReload: TimeInterval = 0
    private var lastMarkReadMs: TimeInterval = 0
    /// Якорь непрочитанных за этот визит уже посчитан (пусть даже и не нашёлся).
    private var unreadAnchorResolved = false
    /// Серверный счётчик непрочитанных этой беседы, снятый в bootstrap — то есть ДО
    /// первого markRead. Нужен только первому входу, когда своей метки чтения ещё нет.
    private var visitUnreadCount = 0
    /// Отложенный тихий релоад: события в окне троттла больше не теряются.
    private var pendingReload: Task<Void, Never>?
    /// Хвостовой markRead: последняя пачка сообщений не должна остаться непрочитанной.
    private var markReadTrailing: Task<Void, Never>?
    /// Автогашение плашки-итога: держим, чтобы новый итог отменял таймер прошлого.
    private var noticeDismiss: Task<Void, Never>?
    private var prependingReset: Task<Void, Never>?
    private var requestedPreviews: Set<String> = []
    var cancellables: Set<AnyCancellable> = []

    // Стражи пагинации (веб-паритет): флаг ставится синхронно ДО запуска (триггер у
    // верха срабатывает каждый кадр), pagedBack замораживает курсор после листания назад.
    var loadingOlderFlag = false // internal: ChatViewModelJump.loadUntil ждёт параллельную подгрузку
    var pagedBack = false
    // Карантин после НЕУДАЧНОЙ подгрузки назад — иначе мгновенный бесконечный ретрай.
    var lastOlderFailMs: TimeInterval = 0

    // --- Секретный режим (логика — в ChatViewModelSecret.swift) ---
    let secretRepo: SecretRepository
    /// В Kotlin поле @Volatile; здесь класс @MainActor, гонок нет по построению.
    var secretMode = false
    var secretPeers: [String] = []
    /// Идёт досыл очереди SecretOutbox. Флаг нужен потому, что повод сбросить очередь
    /// приходит сразу с нескольких сторон (keyImported, deviceLinked, инбокс-полл,
    /// возврат из фона) — без него одна и та же запись улетала бы дважды.
    var secretFlushing = false
    /// Сторож ожидания ключей: по его срабатыванию экран признаёт, что ключи не доехали
    /// (веб-паритет). Хранится, чтобы приход ключа его отменял, а не гасил плашку задним числом.
    var secretKeysWatchdog: Task<Void, Never>?

    static let pageSize = 80 // веб MESSAGES_PAGE_SIZE
    // >10 МБ уходит чанками (веб-паритет). Потолок — РОВНО серверный (multer limits.fileSize
    // в src/routes/upload.ts + nginx client_max_body_size 1024m): прежние 100 МБ отказывали
    // в том, что браузер с того же телефона отправлял спокойно.
    private static let maxUploadBytes = attachmentSizeLimitBytes
    /// Префикс id оптимистичного пузыря: по нему лента и меню действий отличают ещё не
    /// отправленное от настоящего (у секретной очереди ту же роль играет
    /// SecretOutbox.pendingIdPrefix).
    static let outgoingIdPrefix = "outgoing-"
    private static let olderRetryCooldown: TimeInterval = 4

    /// Сообщение ещё не существует на сервере — пересылать, цитировать и удалять нечего.
    static func isOutgoingId(_ id: String) -> Bool { id.hasPrefix(outgoingIdPrefix) }

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

        // Черновик пересылки лист выбора получателя кладёт ДО перехода сюда, так что
        // забираем его сразу при создании. Плюс подписка: беседа-получатель могла быть
        // уже открыта (тогда экран не пересоздаётся и «сразу» не случится).
        adoptForwardDraftIfAny()
        ForwardDraftStore.shared.$pending
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in self?.adoptForwardDraftIfAny() }
            .store(in: &cancellables)

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
        // Счётчик снимаем ДО load(): дальше пойдёт markRead и серверный unread обнулится.
        visitUnreadCount = meta?.unreadCount ?? 0
        let group = meta?.isGroup ?? false
        ui.isGroup = group
        if group {
            // Групповым пузырям нужны аватары отправителей (история их не несёт).
            ui.senderAvatars = await repo.conversationSenderAvatars(conversationId)
        } else {
            ui.peerUserId = meta?.otherUserId
            ui.peerStatus = meta?.otherStatus
            ui.peerLastSeen = meta?.otherLastSeen
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

        case .messageUpdate(let cid, _), .messageReaction(let cid, _):
            guard cid == conversationId, !secretMode else { return }
            scheduleReload()

        case .receipts(let cid, let messageIds, let userId, let status):
            guard cid == conversationId, !secretMode else { return }
            // Свои же квитанции игнорируем: иначе markRead → receipts → перезагрузка.
            guard userId != repo.currentUserId() else { return }
            // Чужие галочки правим ЛОКАЛЬНО. Полный refetch страницы ради двух галочек
            // пересобирал всю ленту, и при открытии чата, где последнее сообщение своё,
            // прокрутка успевала уехать ниже содержимого — чат выглядел пустым.
            applyReceipts(messageIds: messageIds, status: status)

        case .presence(let userId, let status, _):
            // Живой статус в шапке открытого 1:1 (раньше замерзал на момент открытия).
            // Собеседника берём из ui: он заполнен и в секретке, где initSecret достаёт
            // его из участников треда, а не из meta беседы.
            guard !ui.isGroup, let peer = ui.peerUserId, userId == peer else { return }
            // Момент ухода в офлайн запоминаем сами: сервер lastSeen в событии не шлёт, а
            // без него строка деградировала бы до «оффлайн» вместо «был(а) онлайн только что».
            if status.uppercased() == "OFFLINE", ui.peerStatus?.uppercased() != "OFFLINE" {
                ui.peerLastSeen = Int64(Date().timeIntervalSince1970 * 1000)
            }
            ui.peerStatus = status

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
        dropEchoedOutgoing(page.messages)
        var seen = Set<String>()
        let merged = (page.messages + ui.messages)
            .filter { seen.insert($0.id).inserted }
            .sorted(by: Self.olderFirst)
        // Якорь считаем по ЭТОМУ списку и до присваивания: лента должна увидеть разделитель
        // уже в первом снимке, иначе он появится вторым кадром и дёрнет позицию.
        resolveUnreadAnchorIfNeeded(in: merged)
        ui.messages = merged
        if !pagedBack {
            ui.hasMore = page.hasMore
            ui.nextCursor = page.nextCursor
        }
    }

    /// Граница «отсюда я не читал», замороженная на весь визит (поведение Telegram:
    /// fixedCombinedReadStates снимается с первого окна и переиспользуется).
    ///
    /// Считается РОВНО один раз и только на первой пришедшей странице: markRead() уходит
    /// сразу за ней (load(): applyPageOne → markRead), так что пересчёт позже показал бы
    /// «всё прочитано» и разделитель исчез бы через секунду. Поэтому флаг ставится до всех
    /// проверок — даже когда якоря нет, второй попытки не будет.
    private func resolveUnreadAnchorIfNeeded(in messages: [Message]) {
        guard !unreadAnchorResolved, !secretMode else { return }
        unreadAnchorResolved = true
        // Удалённые лента не показывает — и якорем они быть не могут. Служебные строки
        // («добавил в группу») исключаем тоже: непрочитанными их не считает ни сервер,
        // ни Telegram, а разделитель над такой строкой выглядел бы промахом.
        let visible = messages.filter { !$0.deleted && !$0.isSystem }
        // Меньше двух строк — делить нечего.
        guard visible.count > 1, let newest = visible.last, !newest.isMine else { return }

        let incoming = visible.filter { !$0.isMine }
        var candidate: Message?
        if let mark = Self.readMark(conversationId) {
            // Своя метка точнее серверного счётчика: её ставит markRead() этого устройства,
            // и она не зависит от свежести кеша списка бесед.
            candidate = incoming.first { $0.createdAt > mark }
        } else if visitUnreadCount > 0, visitUnreadCount < incoming.count {
            // Первый вход, метки ещё нет: отсчитываем N чужих сообщений от конца. Если N не
            // меньше числа загруженных чужих — граница старше страницы, якоря не ставим.
            candidate = incoming[incoming.count - visitUnreadCount]
        }
        // Условие Telegram `i != 0`: разделитель на самой первой загруженной строке врёт —
        // непрочитанное началось выше страницы. Тогда вход остаётся обычным, в низ.
        guard let candidate, candidate.id != visible.first?.id else { return }
        ui.unreadAnchorId = candidate.id
    }

    /// Время последнего сообщения, которое это устройство уже квитировало в беседе.
    /// Ключ на беседу, а не общий словарь: пишется из markRead() (то есть часто), и
    /// перезаписывать целиком словарь всех бесед на каждое входящее незачем.
    private static func readMarkKey(_ conversationId: String) -> String {
        "chat.readMark.\(conversationId)"
    }

    private static func readMark(_ conversationId: String) -> Int64? {
        let key = readMarkKey(conversationId)
        guard UserDefaults.standard.object(forKey: key) != nil else { return nil }
        return Int64(UserDefaults.standard.double(forKey: key))
    }

    private static func rememberReadMark(_ conversationId: String, upTo millis: Int64) {
        let key = readMarkKey(conversationId)
        // Метка только растёт: markRead() уходит и когда экран лежит в бэкстеке, а ленту
        // в это время мог подрезать refetch — откат метки вернул бы ложный разделитель.
        if let known = readMark(conversationId), known >= millis { return }
        UserDefaults.standard.set(Double(millis), forKey: key)
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
            let merged = (page.messages + ui.messages)
                .filter { seen.insert($0.id).inserted }
                .sorted(by: Self.olderFirst)
            // Флаг выставляем В ТОМ ЖЕ обновлении, что и сами сообщения: лента читает его,
            // выбирая якорь, а отдельным кадром он бы опоздал.
            ui.prepending = true
            ui.messages = merged
            ui.hasMore = page.hasMore
            ui.nextCursor = page.nextCursor
            fetchMissingPreviews()
            releasePrependingSoon()
            return true
        case .failure(_, let code):
            // Отменённый запрос — не сбой сети: карантин на 4 секунды после него означал,
            // что история переставала догружаться, пока не уедешь вниз и не вернёшься.
            if code != NSURLErrorCancelled {
                lastOlderFailMs = Date().timeIntervalSince1970
            }
            return false
        }
    }

    /// Снимает флаг вклейки через пару кадров. Задача отменяемая: страницы могут идти
    /// подряд (быстрый флик, переход к цитате), и таймер предыдущей страницы гасил бы
    /// якорь посреди вставки следующей — как раз в тот момент, когда высота ещё растёт.
    func releasePrependingSoon() { // internal: зовётся и из секретной ветки
        prependingReset?.cancel()
        prependingReset = Task { @MainActor [weak self] in
            // Страховка на случай, если лента не доложит об устаканивании (экран закрыт,
            // геометрия не меняется). Основной путь — releasePrepending() из ленты.
            try? await Task.sleep(for: .seconds(2))
            guard !Task.isCancelled else { return }
            self?.ui.prepending = false
        }
    }

    /// Лента сообщает: высота контента после вклейки перестала меняться — якорь можно
    /// отпускать. По таймеру это делать нельзя: строки над экраном домеряются лениво,
    /// а картинки в них дорисовываются позже, и снятый раньше времени якорь давал рывок.
    func releasePrepending() {
        guard ui.prepending else { return }
        prependingReset?.cancel()
        ui.prepending = false
    }

    /// Вставка сообщения с сохранением порядка ленты. Просто append нарушал бы
    /// инвариант сортировки: пока летел POST, по сокету могло прийти чужое сообщение
    /// с более поздним временем, и наше вставало бы под ним.
    func insertOrdered(_ message: Message) { // internal: используют ветки отправки
        guard !ui.messages.contains(where: { $0.id == message.id }) else { return }
        if let last = ui.messages.last, Self.olderFirst(message, last) {
            let index = ui.messages.firstIndex { Self.olderFirst(message, $0) } ?? ui.messages.count
            ui.messages.insert(message, at: index)
        } else {
            ui.messages.append(message)
        }
    }

    private func scheduleReload() {
        let sinceLast = Date().timeIntervalSince1970 - lastReload
        guard sinceLast < 0.4 else {
            // Отложенная задача больше не нужна — иначе следом уйдёт второй такой же GET,
            // и более старый ответ мог бы перетереть более свежий.
            pendingReload?.cancel()
            pendingReload = nil
            reloadSilently()
            return
        }
        // Раньше событие внутри окна просто выбрасывалось: правка или реакция собеседника,
        // пришедшая сразу за сообщением, не показывалась до следующего события. Теперь
        // окно только откладывает обновление.
        guard pendingReload == nil else { return }
        pendingReload = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(400))
            self?.pendingReload = nil
            if !Task.isCancelled { self?.reloadSilently() }
        }
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
                // Ключ мог приехать, пока экран лежал в фоне (или прошлый досыл упал на
                // мёртвой сети) — очередь не должна ждать нового сообщения от собеседника.
                flushSecretQueue()
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
        // Своё же эхо может обогнать ответ на POST — тогда оптимистичный пузырь снимаем
        // здесь, иначе одно и то же сообщение секунду висело бы в ленте дважды.
        dropEchoedOutgoing([message])
        // По порядку, а не просто в конец: сообщение из сокета может обогнать соседа по
        // времени, и следующий тихий релоад переставлял бы его на глазах.
        insertOrdered(message)
        ui.typingName = nil
        // Своё же эхо квитировать не нужно — это был лишний запрос на каждое отправленное
        // сообщение и лишний повод серверу прислать нам наши же квитанции.
        if !message.isMine { markRead() }
        fetchMissingPreviews()
    }

    // MARK: - Отправка

    func send(_ text: String) {
        // При живом черновике пересылки кнопка отправки отправляет ПЕРЕСЫЛКУ, а набранное
        // становится комментарием к ней — как в вебе (MessagesPane.tsx:3229-3258), где
        // composer-текст уходит в executeForwardPayloadDelivery(..., comment).
        if ui.forwardDraft != nil {
            setTyping(false)
            sendForwardDraft(comment: text)
            return
        }
        let trimmed = text.trimmed()
        guard !trimmed.isEmpty else { return }
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
        // Плашку цитаты гасим СИНХРОННО: композер свободен сразу, ещё до ответа сервера
        // (в вебе submit тоже ничего не ждёт).
        ui.error = nil
        ui.replyingTo = []
        // Пузырь встаёт в ленту В ТОТ ЖЕ КАДР, а не после оборота к серверу: на медленной
        // сети между нажатием и появлением проходили секунды, и сообщение отправляли
        // второй раз. Приём тот же, что у вложений (insertOutgoingBubble).
        let pendingId = insertPendingText(trimmed, reply: reply)
        enqueueTextSend { [weak self] in
            guard let self else { return }
            switch await self.repo.sendText(
                self.conversationId, text: trimmed, replyToId: replyId, replyBundle: bundle
            ) {
            case .success(let message):
                // Подмена ровно одна: временный уходит, настоящий встаёт на его место.
                // Сообщение могли уже принести сокет или тихий релоад (они снимают пузырь
                // сами, dropEchoedOutgoing) — тогда вставлять нечего.
                self.removeOutgoing(pendingId)
                if !self.ui.messages.contains(where: { $0.id == message.id }) {
                    self.insertOrdered(message)
                }
                // Звук — на ПОДТВЕРЖДЕНИИ отправки, а не на нажатии кнопки: иначе он врал
                // бы про то, чего ещё не случилось.
                ChatSounds.messageSent()
            case .failure(let message, _):
                // Сбой сети НЕ съедает написанное: пузырь снимаем, текст — обратно в поле.
                self.removeOutgoing(pendingId)
                self.ui.error = message
                self.ui.restoredDraft = trimmed
                self.ui.replyingTo = reply
            }
            self.fetchMissingPreviews()
        }
    }

    /// Ставит текстовую отправку в хвост очереди. Отправки идут одна за другой (иначе два
    /// быстрых сообщения могли бы разъехаться по порядку на сервере), но UI при этом не
    /// ждёт ничего: кнопка, скрепка и микрофон остаются живыми — как в вебе.
    private func enqueueTextSend(_ work: @escaping @MainActor () async -> Void) {
        let previous = textSendChain
        textSendChain = Task { @MainActor in
            await previous?.value
            await work()
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

    /// Баннер ошибки закрывается тапом — раньше он висел до конца жизни экрана.
    func clearError() {
        ui.error = nil
    }

    /// Положительный итог действия короткой плашкой: человек должен видеть, что пересылка
    /// дошла, а не догадываться по тишине. Гаснет сама — это не состояние, а сообщение.
    func showNotice(_ text: String) {
        ui.notice = text
        noticeDismiss?.cancel()
        noticeDismiss = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(3))
            guard !Task.isCancelled else { return }
            self?.ui.notice = nil
        }
    }

    func clearNotice() {
        noticeDismiss?.cancel()
        ui.notice = nil
    }

    /// Шлёт все [files] ОДНИМ сообщением (фотоальбом). Веб-капы: 10 фото + 10 файлов.
    ///
    /// Сообщение встаёт в ленту СРАЗУ, до аплоада (веб: pendingByConv, ChatsPage.tsx:5071):
    /// прогресс наливается на самом пузыре, отмена — там же, а композер всё это время
    /// свободен. Возвращает true, если отправка принята (очередь чипов можно чистить);
    /// false — не прошла проверка, и собранное остаётся на месте.
    ///
    /// [onSuccess] нужен только секретному пути, который по-прежнему чистит очередь по
    /// факту успеха (логика в ChatViewModelSecret).
    @discardableResult
    func sendAttachments(
        _ files: [OutgoingFile], caption: String? = nil, onSuccess: (() -> Void)? = nil
    ) -> Bool {
        guard !files.isEmpty else { return false }
        // Веб при живом черновике пересылки вложения из композера не пускает
        // (MessagesPane.tsx:3238-3243): иначе непонятно, что уйдёт — файл или пересылка.
        if ui.forwardDraft != nil {
            ui.error = "Сначала отправьте или отмените пересылку — вложения с ней не уходят"
            return false
        }
        // Гейта «идёт отправка предыдущего» больше нет: в вебе у uploadAndSendAttachments
        // нет стража in-flight, и во время загрузки можно слать дальше. Каждая отправка
        // живёт своим пузырём, поэтому параллельные друг другу не мешают.
        // Сначала картинки (веб-порядок вложений — он задаёт сетку альбома), каждый вид ≤10.
        // Капы ДО проверки размера, чтобы 11-й негабарит не ветировал валидный альбом.
        let imgs = files.filter { $0.mime.hasPrefix("image/") }
        let rest = files.filter { !$0.mime.hasPrefix("image/") }
        let limited = Array(imgs.prefix(10)) + Array(rest.prefix(10))
        if let tooBig = limited.first(where: { Int64($0.bytes.count) > Self.maxUploadBytes }) {
            ui.error = oversizeAttachmentMessage(name: tooBig.name, bytes: Int64(tooBig.bytes.count))
            return false
        }
        // Ответ уходит ВМЕСТЕ с вложением (веб: uploadAndSendAttachments(files, text,
        // replyDraft)). Снимок берём до запроса: плашку гасим сразу, иначе она подхватится
        // к следующему тексту, и тот улетит цитатой на чужое сообщение.
        let reply = ui.replyingTo
        if secretMode {
            // Секретный путь остался со старой механикой (общий uploadCancelled, полоса
            // прогресса, очередь чипов по факту успеха), поэтому ему по-прежнему нужен
            // страж in-flight: двух одновременных аплоадов он не выдержит.
            if ui.sending {
                ui.error = "Подождите — идёт отправка предыдущего сообщения"
                return false
            }
            // E2EE-вложения шифруются ключом треда и уходят непрозрачными блобами.
            uploadCancelled = false
            sendSecretAttachments(limited, caption: caption, replySnapshot: reply, onSuccess: onSuccess)
            return true
        }
        ui.error = nil
        ui.replyingTo = []
        runOutgoing(insertOutgoingBubble(limited, caption: caption, reply: reply))
        return true
    }

    // MARK: - Оптимистичная отправка вложений

    /// Чем повторить отправку после сбоя. Хранится отдельно от ленты: сам пузырь несёт
    /// только то, что видно (превью, подпись, цитаты).
    private struct OutgoingPayload {
        let files: [OutgoingFile]
        let caption: String?
        let reply: [Message]
    }

    /// Оптимистичный пузырь ТЕКСТОВОГО сообщения. В `ui.outgoing` он намеренно не
    /// попадает: там живут отправки с файлами, и их накладка (затемнение с кольцом
    /// прогресса) поверх текста означала бы «идёт загрузка», которой нет. От настоящего
    /// его отличает префикс id — по нему лента гасит меню, свайп-ответ и выбор, а вместо
    /// галочки квитанции рисует часы.
    private func insertPendingText(_ text: String, reply: [Message]) -> String {
        let id = Self.outgoingIdPrefix + UUID().uuidString.lowercased()
        insertOrdered(Message(
            id: id,
            conversationId: conversationId,
            senderId: repo.currentUserId() ?? "",
            senderName: "Вы",
            type: "TEXT",
            content: text,
            createdAt: Int64(Date().timeIntervalSince1970 * 1000),
            isMine: true,
            isSystem: false,
            // Цитаты видны на пузыре сразу — отправляется он именно с ними.
            replyTo: reply.map {
                ReplyInfo(id: $0.id, senderId: $0.senderId, content: $0.content, createdAt: $0.createdAt)
            }
        ))
        return id
    }

    /// Ставит пузырь в ленту ДО аплоада и запоминает, чем его повторить.
    /// Возвращает id временного сообщения — ключ и к ui.outgoing, и к полезной нагрузке.
    private func insertOutgoingBubble(
        _ files: [OutgoingFile], caption: String?, reply: [Message]
    ) -> String {
        let id = Self.outgoingIdPrefix + UUID().uuidString.lowercased()
        let atts = files.map { Self.optimisticAttachment($0) }
        // Тип сообщения — по тому же веб-правилу, что и в аплоаде: все одного вида → этот
        // вид, смесь → FILE. Иначе пузырь перестроился бы при подмене серверным.
        var kinds = Set<String>()
        let types = atts.map(\.type).filter { kinds.insert($0).inserted }
        let trimmedCaption = caption?.trimmed()
        let message = Message(
            id: id,
            conversationId: conversationId,
            senderId: repo.currentUserId() ?? "",
            senderName: "Вы",
            type: types.count == 1 ? types[0] : "FILE",
            content: (trimmedCaption?.isEmpty == false) ? caption : nil,
            createdAt: Int64(Date().timeIntervalSince1970 * 1000),
            isMine: true,
            isSystem: false,
            attachments: atts,
            // Цитаты видны на пузыре сразу — отправляется он именно с ними.
            replyTo: reply.map {
                ReplyInfo(id: $0.id, senderId: $0.senderId, content: $0.content, createdAt: $0.createdAt)
            }
        )
        outgoingPayloads[id] = OutgoingPayload(files: files, caption: caption, reply: reply)
        insertOrdered(message)
        attachLocalPreviews(to: id, files: files)
        return id
    }

    /// Запускает (или повторяет) загрузку пузыря [id]. Прогресс и отмена живут на пузыре,
    /// композер в это время свободен.
    private func runOutgoing(_ id: String) {
        guard let payload = outgoingPayloads[id] else { return }
        ui.outgoing[id] = OutgoingUpload(progress: 0)
        cancelledOutgoing.withLock { $0.remove(id) }
        let replyId = payload.reply.last?.id
        // Мультиответ: все цитаты уходят в metadata.replyQuoteBundle (≥2, как Kotlin/веб).
        let replyBundle: [ReplyInfo]? = payload.reply.count >= 2
            ? payload.reply.map {
                ReplyInfo(id: $0.id, senderId: $0.senderId, content: $0.content, createdAt: $0.createdAt)
            }
            : nil
        Task {
            let result = await repo.sendAttachments(
                conversationId,
                files: payload.files,
                caption: payload.caption,
                replyToId: replyId,
                replyBundle: replyBundle,
                onProgress: { [weak self] done, total in
                    guard total > 0 else { return }
                    let pct = min(max(Float(done) / Float(total), 0), 1)
                    // Колбэк приходит с фонового потока; стейт дросселируем до целых
                    // процентов — иначе ячейка ленты перенастраивалась бы на каждый чанк.
                    Task { @MainActor [weak self] in
                        guard let self, let current = self.ui.outgoing[id] else { return }
                        if Int(pct * 100) != Int(current.progress * 100) {
                            self.ui.outgoing[id]?.progress = pct
                        }
                    }
                },
                isCancelled: { [weak self] in
                    self?.cancelledOutgoing.withLock { $0.contains(id) } ?? true
                }
            )
            cancelledOutgoing.withLock { $0.remove(id) }
            // Пузырь могли снять (отмена, уход с экрана) — тогда результат уже не наш:
            // если отправка всё-таки дошла, сообщение принесут сокет и тихий релоад.
            guard outgoingPayloads[id] != nil else { return }
            switch result {
            case .success(let message):
                // Подмена временного настоящим — одним обновлением, чтобы пузырь не мигал.
                removeOutgoing(id)
                if !ui.messages.contains(where: { $0.id == message.id }) {
                    insertOrdered(message)
                }
                ChatSounds.messageSent()
                fetchMissingPreviews()
            case .failure(let message, _):
                // Пузырь ОСТАЁТСЯ с пометкой: жмёшь «Повторить» — уходит теми же файлами.
                // В вебе призрак просто исчезал с тостом, и сообщение приходилось собирать
                // заново; подпись и цитаты здесь тоже никуда не деваются.
                ui.outgoing[id] = OutgoingUpload(
                    progress: ui.outgoing[id]?.progress ?? 0, failed: true, error: message
                )
                ui.error = message
            }
        }
    }

    /// Единая точка для действий с пузыря (лента передаёт их одним замыканием).
    func handleOutgoing(_ messageId: String, _ action: OutgoingUploadAction) {
        switch action {
        case .cancel: cancelOutgoing(messageId)
        case .retry: retryOutgoing(messageId)
        case .discard: discardOutgoing(messageId)
        }
    }

    /// «Повторить» на упавшем пузыре: та же отправка теми же файлами, тот же пузырь.
    func retryOutgoing(_ messageId: String) {
        guard ui.outgoing[messageId]?.failed == true, outgoingPayloads[messageId] != nil else { return }
        ui.error = nil
        runOutgoing(messageId)
    }

    /// Крестик на летящем пузыре: пузырь уходит сразу (веб снимает призрак в тот же миг),
    /// а загрузка бросается на ближайшей части — серверную сессию аплоад прибирает сам.
    func cancelOutgoing(_ messageId: String) {
        guard ui.outgoing[messageId] != nil else { return }
        // Флаг снимет сама задача, когда закончится: чистить его здесь значило бы отпустить
        // уже отменённый аплоад догружаться до конца.
        cancelledOutgoing.withLock { $0.insert(messageId) }
        removeOutgoing(messageId)
    }

    /// «Удалить» на упавшем пузыре — то же снятие, но грузить уже нечего.
    func discardOutgoing(_ messageId: String) {
        guard ui.outgoing[messageId] != nil else { return }
        removeOutgoing(messageId)
    }

    /// Сервер прислал НАШЕ же сообщение (эхо сокета или тихий релоад) раньше, чем вернулся
    /// ответ на отправку — снимаем оптимистичный пузырь, иначе одно и то же висело бы в
    /// ленте дважды. Сравнивать по id нельзя: временный серверному не родня, поэтому ищем
    /// по составу, и только среди УЖЕ ДОГРУЖЕННЫХ пузырей — пока файл летит, сервер о
    /// сообщении ещё не знает, и похожее сообщение это другое сообщение.
    private func dropEchoedOutgoing(_ incoming: [Message]) {
        guard ui.messages.contains(where: { Self.isOutgoingId($0.id) }) else { return }
        for message in incoming where message.isMine && !Self.isOutgoingId(message.id) {
            // Одно эхо снимает ОДИН пузырь — самый старый из подходящих: две одинаковые
            // отправки подряд иначе схлопнулись бы в одну.
            let match = ui.messages.first { candidate in
                guard Self.isOutgoingId(candidate.id) else { return false }
                // У пузыря с файлами ждём конца загрузки: пока файл летит, сервер о
                // сообщении ещё не знает, и похожее сообщение — это ДРУГОЕ сообщение.
                // У текстового состояния аплоада нет вовсе, и он готов к подмене сразу.
                if let state = ui.outgoing[candidate.id] {
                    guard !state.failed, state.progress >= 1 else { return false }
                }
                return candidate.attachments.count == message.attachments.count
                    && (candidate.content ?? "") == (message.content ?? "")
            }
            guard let match else { continue }
            removeOutgoing(match.id)
        }
    }

    /// Снять пузырь целиком: из ленты, из состояния отправок, из нагрузки повтора, плюс
    /// стереть его временные превью.
    private func removeOutgoing(_ id: String) {
        ui.messages.removeAll { $0.id == id }
        ui.outgoing.removeValue(forKey: id)
        outgoingPayloads.removeValue(forKey: id)
        for url in outgoingPreviews.removeValue(forKey: id) ?? [] {
            try? FileManager.default.removeItem(at: url)
        }
    }

    /// Дорисовывает пузырю локальные превью картинок (в вебе их роль играет blob:-URL).
    /// Отдельным проходом и вне главного потока: пузырь обязан появиться в тот же кадр, а
    /// миниатюра 12-мегапиксельного кадра — это десятки миллисекунд, которые лента
    /// почувствовала бы рывком.
    private func attachLocalPreviews(to id: String, files: [OutgoingFile]) {
        let sources: [(Int, Data)] = files.enumerated().compactMap { index, file in
            file.mime.hasPrefix("image/") ? (index, file.bytes) : nil
        }
        guard !sources.isEmpty else { return }
        Task { @MainActor [weak self] in
            let made: [(Int, URL)] = await Task.detached {
                sources.compactMap { index, bytes in
                    ChatViewModel.writeLocalPreview(bytes).map { (index, $0) }
                }
            }.value
            guard let self, let row = self.ui.messages.firstIndex(where: { $0.id == id }) else {
                // Пузыря уже нет (отмена или успех) — держать файлы превью незачем.
                for (_, url) in made { try? FileManager.default.removeItem(at: url) }
                return
            }
            for (index, url) in made where self.ui.messages[row].attachments.indices.contains(index) {
                let old = self.ui.messages[row].attachments[index]
                // url у вложения — let, поэтому запись пересобираем целиком.
                self.ui.messages[row].attachments[index] = MessageAttachment(
                    url: url.absoluteString,
                    type: old.type,
                    mime: old.mime,
                    name: old.name,
                    size: old.size,
                    width: old.width,
                    height: old.height
                )
            }
            self.outgoingPreviews[id, default: []].append(contentsOf: made.map { $0.1 })
        }
    }

    /// Миниатюра отправляемой картинки во временный файл. Пишем ужатую копию, а не
    /// оригинал: класть на диск вторые мегабайты тех же байт незачем, а пузырю нужен кадр,
    /// а не полное разрешение.
    private nonisolated static func writeLocalPreview(_ bytes: Data) -> URL? {
        guard let source = CGImageSourceCreateWithData(bytes as CFData, nil) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            // Снимок с портретным EXIF иначе лёг бы боком.
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: 1280,
        ]
        guard let cg = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary),
              let jpeg = UIImage(cgImage: cg).jpegData(compressionQuality: 0.8)
        else { return nil }
        // В ту же папку, что и копии выбранного: её подметает pruneOutgoingStaging при
        // следующем выборе файлов, и переживший падение мусор не остаётся навсегда.
        let url = outgoingStagingDirectory()
            .appendingPathComponent("outgoing-preview-\(UUID().uuidString).jpg")
        do {
            try jpeg.write(to: url, options: .atomic)
        } catch {
            return nil
        }
        return url
    }

    /// Вложение оптимистичного пузыря: тип и размеры известны сразу, url появится, когда
    /// допишется локальное превью (до тех пор плитка держит своё место серым фоном).
    private static func optimisticAttachment(_ file: OutgoingFile) -> MessageAttachment {
        let type = attachmentKind(file.mime)
        let dims = type == "IMAGE" ? imageHeaderSize(file.bytes) : nil
        return MessageAttachment(
            url: "",
            type: type,
            mime: file.mime,
            name: file.name,
            size: Int64(file.bytes.count),
            width: dims?.width,
            height: dims?.height
        )
    }

    /// Тот же разбор, что в аплоаде (ChatRepositoryUploads.attachmentTypeFor) — он private,
    /// а пузырю тип нужен ДО отправки.
    private static func attachmentKind(_ mime: String) -> String {
        if mime.hasPrefix("image/") { return "IMAGE" }
        if mime.hasPrefix("video/") { return "VIDEO" }
        if mime.hasPrefix("audio/") { return "AUDIO" }
        return "FILE"
    }

    /// Размеры кадра из ЗАГОЛОВКА файла, без декодирования: плитка обязана встать на своё
    /// место в тот же кадр, и её высота не должна меняться после загрузки картинки.
    private static func imageHeaderSize(_ bytes: Data) -> (width: Int, height: Int)? {
        guard let source = CGImageSourceCreateWithData(bytes as CFData, nil),
              let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = props[kCGImagePropertyPixelWidth] as? Int,
              let height = props[kCGImagePropertyPixelHeight] as? Int,
              width > 0, height > 0
        else { return nil }
        // EXIF-поворот меняет стороны местами: без этого портретный снимок резервировал бы
        // альбомную плитку, и лента прыгнула бы, когда кадр наконец нарисуется.
        let orientation = props[kCGImagePropertyOrientation] as? Int ?? 1
        let rotated = (5...8).contains(orientation)
        return rotated ? (height, width) : (width, height)
    }

    /// Кнопка «отмена» у прогресса: аборт между частями, серверная сессия прибирается.
    func cancelUpload() {
        uploadCancelled = true
    }

    // MARK: - Стейджинг вложений (веб-паритет: выбранное НЕ отправляется сразу)

    /// Пикер вернул файлы: кладём в очередь чипов; лимиты как у альбома (10 фото + 10 файлов).
    /// Кадр из очереди отредактирован — подменяем на месте, порядок альбома сохраняется.
    func replaceStaged(at index: Int, with file: OutgoingFile) {
        guard ui.staged.indices.contains(index) else { return }
        ui.staged[index] = file
    }

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

    /// Отправка очереди с подписью. Чипы уходят СРАЗУ, как в вебе (MessagesPane.tsx:3262):
    /// собранное уже стоит пузырём в ленте, и человек может набирать следующее сообщение,
    /// пока это летит. Отказ на проверке (пересылка, размер) очередь не трогает.
    func sendStaged(_ caption: String?) {
        let files = ui.staged
        guard !files.isEmpty else { return }
        if secretMode {
            // Секретный путь пока без пузыря-призрака: он чистит очередь по факту успеха.
            sendAttachments(files, caption: caption, onSuccess: { [weak self] in self?.ui.staged = [] })
            return
        }
        if sendAttachments(files, caption: caption) {
            ui.staged = []
        } else {
            // Отправку не приняли (живая пересылка, негабарит) — композер уже очистил поле,
            // возвращаем подпись туда же, где её набирали.
            ui.restoredDraft = caption
        }
    }

    /// Отправляет записанный голосовой клип (data — AAC/MP4 из VoiceRecorder) как
    /// AUDIO-сообщение с длительностью и волной.
    func sendVoice(_ data: Data, durationSec: Int, waveform: [Int]) {
        // Гейта «идёт отправка» нет и здесь: в вебе микрофон гаснет только на правке и
        // пересылке (MessagesPane.tsx:3501), а не на время загрузки.
        // Тот же запрет, что у вложений: пока висит черновик пересылки, композер занят ею.
        if ui.forwardDraft != nil {
            ui.error = "Сначала отправьте или отмените пересылку — голосовое с ней не уходит"
            return
        }
        // Голосовое отвечает на цитату так же, как текст и вложения (веб: replyToId +
        // metadata рядом с duration), и гасит плашку сразу после отправки.
        let reply = ui.replyingTo
        let replyId = reply.last?.id
        let replyBundle: [ReplyInfo]? = reply.count >= 2
            ? reply.map { ReplyInfo(id: $0.id, senderId: $0.senderId, content: $0.content, createdAt: $0.createdAt) }
            : nil
        if secretMode {
            sendSecretVoice(data, durationSec: durationSec, waveform: waveform, replySnapshot: reply)
            return
        }
        ui.error = nil
        ui.replyingTo = []
        Task {
            switch await repo.sendVoiceMessage(
                conversationId,
                bytes: data,
                durationSec: durationSec,
                waveform: waveform,
                replyToId: replyId,
                replyBundle: replyBundle
            ) {
            case .success(let message):
                if !ui.messages.contains(where: { $0.id == message.id }) {
                    insertOrdered(message)
                }
            case .failure(let message, _):
                ui.error = message
                // Цитата возвращается на место — повтор уйдёт ответом на то же сообщение.
                ui.replyingTo = reply
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
            case .success:
                // Чат закрыт/удалён — досылать очередь некуда, а держать её на диске
                // значило бы хранить текст уже уничтоженной секретки.
                if secretMode { SecretOutbox.clear(conversationId) }
                onDone()
            case .failure(let message, _): ui.error = message
            }
        }
    }

    func react(_ message: Message, emoji: String) {
        // Оптимистичный пузырь сервер ещё не видел: реакция по временному id ушла бы в
        // никуда и вернулась ошибкой. То же касается правки, удаления, ответа и выбора.
        guard !secretMode, !Self.isOutgoingId(message.id) else { return }
        let mine = message.reactions.first { $0.emoji == emoji }?.mine ?? false
        // Оптимистично: счётчик меняется под пальцем, а не через раундтрип. Сервер
        // подтвердит тем же значением, ошибка — вернёт снимок.
        let snapshot = ui.messages.first { $0.id == message.id }?.reactions
        applyLocalReaction(messageId: message.id, emoji: emoji, add: !mine)
        Task {
            if case .failure = await repo.toggleReaction(
                messageId: message.id, emoji: emoji, currentlyMine: mine
            ) {
                // Именно снимок, а не обратная дельта: пока летел запрос, ленту мог
                // перезалить тихий релоад, и вычитание единицы испортило бы чужие реакции.
                if let snapshot, let index = ui.messages.firstIndex(where: { $0.id == message.id }) {
                    ui.messages[index].reactions = snapshot
                }
            } else {
                reloadSilently()
            }
        }
    }

    /// Галочки доставки/прочтения по сообщениям — без похода в сеть.
    private func applyReceipts(messageIds: [String], status: String?) {
        let state: ReceiptState
        switch (status ?? "").uppercased() {
        case "READ", "SEEN": state = .read
        case "DELIVERED": state = .delivered
        default: return
        }
        let targets = Set(messageIds)
        for index in ui.messages.indices where targets.contains(ui.messages[index].id) {
            let message = ui.messages[index]
            // Только свои: у входящих галочек нет, и «прочитано» их не касается.
            guard message.isMine, !message.deleted else { continue }
            // Назад не откатываем: доставлено не должно затирать прочитано.
            if message.receipt == .read && state == .delivered { continue }
            ui.messages[index].receipt = state
        }
    }

    private func applyLocalReaction(messageId: String, emoji: String, add: Bool) {
        guard let index = ui.messages.firstIndex(where: { $0.id == messageId }) else { return }
        var reactions = ui.messages[index].reactions
        if let position = reactions.firstIndex(where: { $0.emoji == emoji }) {
            let count = reactions[position].count + (add ? 1 : -1)
            if count <= 0 {
                reactions.remove(at: position)
            } else {
                reactions[position] = MessageReaction(emoji: emoji, count: count, mine: add)
            }
        } else if add {
            reactions.append(MessageReaction(emoji: emoji, count: 1, mine: true))
        }
        ui.messages[index].reactions = reactions
    }

    /// Правка текста. [onDone] нужен панели правки в композере: она закрывается только по
    /// успеху, а на сбое остаётся с набранным — иначе поправленный текст пропадал бы молча.
    func edit(messageId: String, content: String, onDone: ((Bool) -> Void)? = nil) {
        guard !secretMode, !Self.isOutgoingId(messageId), !content.trimmed().isEmpty else {
            onDone?(false)
            return
        }
        Task {
            switch await repo.editMessage(messageId: messageId, content: content) {
            case .success:
                reloadSilently()
                onDone?(true)
            case .failure(let message, _):
                // Раньше отказ сервера не показывался вовсе — правка просто «не случалась».
                ui.error = message
                onDone?(false)
            }
        }
    }

    func delete(messageId: String) {
        // Удалить ещё не отправленное — это снять пузырь вместе с его загрузкой.
        if Self.isOutgoingId(messageId) {
            cancelledOutgoing.withLock { $0.insert(messageId) }
            removeOutgoing(messageId)
            return
        }
        guard !secretMode else { return }
        // Помечаем СРАЗУ: лента удалённые не показывает, и пузырь исчезает по нажатию,
        // а не через секунду-две, всё это время показывая исходный текст серым курсивом.
        setDeletedLocally(messageId, deleted: true)
        Task {
            if case .failure = await repo.deleteMessage(messageId: messageId) {
                setDeletedLocally(messageId, deleted: false)
            } else {
                reloadSilently()
            }
        }
    }

    private func setDeletedLocally(_ messageId: String, deleted: Bool) {
        guard let index = ui.messages.firstIndex(where: { $0.id == messageId }) else { return }
        ui.messages[index].deleted = deleted
    }

    // MARK: - Ответ

    /// Ответ на ещё не отправленное невозможен: replyToId указывал бы на временный id.
    func setReply(_ message: Message) {
        guard !Self.isOutgoingId(message.id) else { return }
        ui.replyingTo = [message]
    }
    func clearReply() { ui.replyingTo = [] }

    // MARK: - Мультивыбор (порт startSelection/toggleSelect/... из Kotlin)

    func startSelection(_ messageId: String) {
        guard !Self.isOutgoingId(messageId) else { return }
        ui.selectionMode = true
        ui.selectedIds = [messageId]
    }

    /// Снятая последняя галка режим НЕ гасит. Раньше опустевший выбор схлопывал экран
    /// обратно к композеру, и промах по кружку стоил всего режима; веб так не делает —
    /// toggleMessageMultiSelect правит только список, гасит режим одна «Отмена».
    func toggleSelect(_ messageId: String) {
        guard !Self.isOutgoingId(messageId) else { return }
        var next = ui.selectedIds
        if !next.insert(messageId).inserted { next.remove(messageId) }
        ui.selectionMode = true
        ui.selectedIds = next
    }

    /// Пакетное «выбрать/снять» — для протяжки двумя пальцами (MessageSelectionPanDriver).
    /// Непригодные id отсеиваются поштучно, а не отказом всей пачке: под пальцем мог
    /// оказаться ещё не отправленный пузырь, и из-за него терялся бы весь мазок.
    func setSelected(_ ids: [String], selected: Bool) {
        let usable = ids.filter { !Self.isOutgoingId($0) }
        guard !usable.isEmpty else { return }
        var next = ui.selectedIds
        if selected { next.formUnion(usable) } else { next.subtract(usable) }
        // Режим включает сам жест: протяжка — это второй вход в мультивыбор, наравне с
        // пунктом «Выбрать» в меню сообщения.
        ui.selectionMode = true
        ui.selectedIds = next
    }

    func clearSelection() {
        ui.selectionMode = false
        ui.selectedIds = []
    }

    func selectedMessages() -> [Message] {
        ui.messages.filter { ui.selectedIds.contains($0.id) }
    }

    /// Сколько из выбранного реально удалится: сервер разрешает удалять только СВОИ и
    /// ещё не удалённые (src/routes/messages.ts). Кнопка подписывалась общим числом
    /// выбранных и обещала больше, чем делала: выбрал 7 своих и чужих — исчезнет 3.
    var deletableSelectedCount: Int {
        ui.messages.filter { ui.selectedIds.contains($0.id) && $0.isMine && !$0.deleted }.count
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

    /// Тап по беседе в листе выбора получателя. Ничего НЕ отправляет — как веб
    /// (ChatModals.tsx:2815-2882): складывает черновик пересылки и просит навигацию
    /// открыть беседу-получателя, где к пересылке можно приписать комментарий и только
    /// потом отправить. Раньше пересылка уходила по тапу молча, и об отказе сервера
    /// человек не узнавал.
    func stageForward(targetConversationId: String, messages: [Message]) {
        // Пересылка ИЗ секретки запрещена: forwardMessage ушёл бы в облачный /send открытым
        // текстом + связал бы имя/mime/размер с .enc-блобом на сервере. Но молчать об этом
        // нельзя — веб отказ объясняет.
        if secretMode {
            clearSelection()
            ui.error = "Из секретного чата пересылать нельзя: сообщения не покидают устройство открытыми"
            return
        }
        let list = messages.filter { !$0.isSystem && !$0.deleted }
        clearSelection()
        guard !list.isEmpty else {
            ui.error = "Нечего пересылать: выбраны только системные или удалённые сообщения"
            return
        }
        Task {
            // Название получателя нужно и плашке черновика, и переходу; кеш бесед отвечает
            // сразу, сеть — только при промахе.
            let title = (await repo.conversationMeta(targetConversationId))?.title ?? "беседа"
            ForwardDraftStore.shared.stage(ForwardDraft(
                destinationConversationId: targetConversationId,
                destinationTitle: title,
                messages: list
            ))
            // Переход — тем же одноразовым запросом, которым открывается чат по тапу на
            // уведомление: RootView его уже слушает, новых путей навигации не нужно.
            AppLifecycle.shared.requestOpenConversation(
                conversationId: targetConversationId, title: title
            )
        }
    }

    /// Черновик адресован ЭТОЙ беседе — показываем его у себя. Хранилище при этом НЕ
    /// чистим: черновик снимает отправка или крестик, иначе выброшенный экземпляр
    /// вьюмодели (SwiftUI создаёт их по нескольку) унёс бы пересылку с собой.
    private func adoptForwardDraftIfAny() {
        guard ui.forwardDraft == nil,
              let draft = ForwardDraftStore.shared.draft(for: conversationId)
        else { return }
        ui.forwardDraft = draft
        // Композер восстановит сохранённый черновик молча (без onDraftChanged), поэтому
        // «пусто ли там» спрашиваем у того же хранилища, что и он.
        ui.composerEmpty = DraftStore.get(conversationId).trimmed().isEmpty
    }

    /// Крестик на плашке — «Отменить пересылку» (веб: setForwardComposerDraft(null)).
    func cancelForwardDraft() {
        ui.forwardDraft = nil
        ForwardDraftStore.shared.clear()
    }

    /// Отправка отложенной пересылки одним заходом. Комментарий из композера уходит в
    /// `metadata.forwardComposerCaption` ПЕРВОГО сообщения пачки — ровно как веб
    /// (ChatsPage.tsx:1513-1523), поэтому на обеих платформах он виден в одном пузыре.
    /// Итог обязательно виден: отказ — ошибкой, успех — плашкой «Переслано в «…»».
    func sendForwardDraft(comment: String?) {
        guard let draft = ui.forwardDraft, !ui.sending else { return }
        // Пустая пачка — не повод показывать «Переслано»: черновик просто снимаем.
        guard !draft.messages.isEmpty else {
            ui.forwardDraft = nil
            ForwardDraftStore.shared.clear()
            return
        }
        if secretMode {
            ui.forwardDraft = nil
            ForwardDraftStore.shared.clear()
            ui.error = "Пересылка в секретный чат не поддерживается"
            return
        }
        Task {
            ui.sending = true
            ui.error = nil
            var sent = 0
            var failure: String?
            loop: for (index, message) in draft.messages.enumerated() {
                let result = await repo.forwardMessage(
                    targetConversationId: draft.destinationConversationId,
                    message: message,
                    // Комментарий — только у первого: иначе он повторился бы N раз.
                    composerCaption: index == 0 ? comment : nil
                )
                switch result {
                case .success:
                    sent += 1
                case .failure(let reason, _):
                    // Веб на отказе обрывает пачку (outcome == 'blocked') — не долбим сервер
                    // и не размазываем пересылку по половине сообщений.
                    failure = reason
                    break loop
                }
            }
            ui.sending = false
            if let failure {
                ui.error = sent > 0
                    ? "Переслано \(sent) из \(draft.messages.count): \(failure)"
                    : "Не удалось переслать: \(failure)"
            } else {
                showNotice("Переслано в «\(draft.destinationTitle)»")
            }
            if sent > 0 {
                // Ушедшее не должно уйти повторно, даже если часть пачки упала.
                ui.forwardDraft = nil
                ForwardDraftStore.shared.clear()
                // Комментарий уехал внутри пересылки — в черновике беседы его быть не должно.
                DraftStore.set(conversationId, "")
                reloadSilently()
            }
        }
    }

    /// Немедленная пересылка без перехода и комментария. Остаётся для вызовов, которым
    /// переход не нужен; в отличие от прежней версии результат НЕ теряется: успех —
    /// плашкой «Переслано в «…»», отказ сервера — ошибкой.
    func forward(targetConversationId: String, messages: [Message]) {
        if secretMode {
            clearSelection()
            ui.error = "Из секретного чата пересылать нельзя: сообщения не покидают устройство открытыми"
            return
        }
        let list = messages.filter { !$0.isSystem && !$0.deleted }
        clearSelection()
        guard !list.isEmpty else { return }
        Task {
            let title = (await repo.conversationMeta(targetConversationId))?.title
            var sent = 0
            var failure: String?
            loop: for message in list {
                switch await repo.forwardMessage(
                    targetConversationId: targetConversationId, message: message
                ) {
                case .success:
                    sent += 1
                case .failure(let reason, _):
                    failure = reason
                    break loop
                }
            }
            if let failure {
                ui.error = sent > 0
                    ? "Переслано \(sent) из \(list.count): \(failure)"
                    : "Не удалось переслать: \(failure)"
            } else if let title {
                showNotice("Переслано в «\(title)»")
            } else {
                showNotice("Переслано")
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
        // Баннеры этой беседы снимаем и у секретных чатов — серверный markRead им не нужен.
        MessageNotifications.shared.clearDelivered(conversationId: conversationId)
        guard !secretMode else { return }
        // Метка «досюда дочитано» — для разделителя непрочитанных на СЛЕДУЮЩЕМ входе.
        // Пишем на каждый вызов, включая троттлированные: серверный markRead всё равно
        // квитирует беседу целиком. Оптимистичные пузыри пропускаем — их createdAt идёт
        // с локальных часов и, если те спешат, метка съела бы чужие непрочитанные.
        if let newest = ui.messages.last(where: { !Self.isOutgoingId($0.id) })?.createdAt {
            Self.rememberReadMark(conversationId, upTo: newest)
        }
        // В живом диалоге сообщения идут пачками; без троттла на каждое летел POST,
        // а в ответ прилетали receipts — и всё это во время прокрутки.
        let now = Date().timeIntervalSince1970
        let sinceLast = now - lastMarkReadMs
        guard sinceLast > 1.5 else {
            // Хвост обязателен: сервер квитирует только то, что существует на момент
            // запроса, и без повтора последние сообщения пачки остались бы непрочитанными.
            guard markReadTrailing == nil else { return }
            markReadTrailing = Task { @MainActor [weak self] in
                try? await Task.sleep(for: .seconds(1.5 - sinceLast))
                self?.markReadTrailing = nil
                if !Task.isCancelled { self?.markRead() }
            }
            return
        }
        lastMarkReadMs = now
        Task { _ = await repo.markConversationRead(conversationId) }
    }

    // MARK: - Набор текста

    func onInputChanged(_ text: String) {
        lastInputMs = Date().timeIntervalSince1970
        let empty = text.trimmed().isEmpty
        // В стейт пишем только при живом черновике пересылки и только на переходе
        // пусто/непусто: иначе каждая клавиша перестраивала бы экран вместе с лентой.
        if ui.forwardDraft != nil, empty != ui.composerEmpty {
            ui.composerEmpty = empty
        }
        setTyping(!empty)
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
        markReadTrailing?.cancel()
        pendingReload?.cancel()
        prependingReset?.cancel()
        setTyping(false)
    }
}
