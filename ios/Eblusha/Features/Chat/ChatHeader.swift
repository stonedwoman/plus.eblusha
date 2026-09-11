import SwiftUI
import Combine

// Шапка беседы целиком — порт шапки веба (`chats/render/MessagesPane.tsx:440-620` для
// 1:1 и `:305-330` для группы) плюс `formatPresence` из `ChatsPage.tsx:5903-5928`.
//
// Раньше вся шапка жила внутри ChatView (headerToolbar/headerTitle) и знала о собеседнике
// ровно одну строку `ui.headerSubtitle`, которую посчитал репозиторий. Из-за этого в шапке
// пропадали три вещи, которые на вебе видно всегда: «был(а) онлайн …» у офлайн-собеседника,
// игровое присутствие и идущий в беседе звонок. Здесь они собраны в одном месте, потому что
// все три — это ОДНА строка статуса с приоритетами (звонок → игра → присутствие), и считать
// её кусками в двух файлах значит гарантированно разойтись.
//
// Данные шапка берёт сама, а не через ChatViewModel:
//  - presence:update приходит ВСЕМ сокетам (не только по беседе), поэтому подписка живёт
//    прямо во вью — иначе строку пришлось бы тащить через UiState ради одной подписи;
//  - игру держит общее хранилище PresenceGames (ниже), а звонки — CallStatusStore
//    (Core/Realtime); оба наполняет RealtimeClient, и читают их и шапка, и список чатов.

// MARK: - Игровое присутствие (события presence:game*)

/// Карта «кто во что играет» (веб-`presenceGameByUserId`), по образцу PresenceDevices:
/// плоское общее хранилище, которое пишет realtime-слой и читают независимые экраны.
///
/// Храним ТОЛЬКО название игры: картинка игры в шапке — чисто десктопная вещь
/// (MessagesPane.tsx:618 гасит её при isMobile), а steamAppId нужен только ей.
///
/// Сервер сам держит TTL 60 с и рассылает `presence:game` с `game: null`, когда игра
/// кончилась (src/realtime/socket.ts:505-545), поэтому клиентского таймера здесь нет.
/// Единственный случай, когда карта может протухнуть, — разрыв сокета: снапшот при
/// подключении перечисляет только ИГРАЮЩИХ, и «переставшие» останутся висеть. Поэтому
/// realtime-слой обязан звать clear() на каждом connect, ДО прихода снапшота.
final class PresenceGames: ObservableObject {
    static let shared = PresenceGames()

    /// userId → название игры
    @Published private(set) var games: [String: String] = [:]

    func update(userId: String, game: String?) {
        onMain {
            if let game, !game.isEmpty {
                if self.games[userId] != game { self.games[userId] = game }
            } else if self.games[userId] != nil {
                self.games.removeValue(forKey: userId)
            }
        }
    }

    func updateAll(_ items: [(userId: String, game: String?)]) {
        guard !items.isEmpty else { return }
        onMain {
            var next = self.games
            for (userId, game) in items {
                if let game, !game.isEmpty {
                    next[userId] = game
                } else {
                    next.removeValue(forKey: userId)
                }
            }
            if next != self.games { self.games = next }
        }
    }

    func clear() {
        onMain {
            if !self.games.isEmpty { self.games = [:] }
        }
    }

    private func onMain(_ body: @escaping () -> Void) {
        if Thread.isMainThread { body() } else { DispatchQueue.main.async(execute: body) }
    }
}

/// Сырое событие `presence:game` / `presence:game:snapshot`.
struct PresenceGamePayload: Decodable {
    let userId: String
    var game: PresenceGameDto?

    private enum CodingKeys: String, CodingKey { case userId, game }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        userId = try c.decode(String.self, forKey: .userId)
        // game: null — «перестал играть», это нормальный пейлоад, а не сбой.
        game = try c.decodeIfPresent(PresenceGameDto.self, forKey: .game)
    }
}

/// Батч `presence:game:snapshot:batch`.
struct PresenceGameBatch: Decodable {
    var items: [PresenceGamePayload] = []

    private enum CodingKeys: String, CodingKey { case items }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        items = try c.decodeIfPresent([PresenceGamePayload].self, forKey: .items) ?? []
    }
}

struct PresenceGameDto: Decodable {
    var name = ""

    private enum CodingKeys: String, CodingKey { case name }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? ""
    }

    /// Пустое имя игрой не считаем — показывать «Играет в » нечего.
    var domain: String? { name.isEmpty ? nil : name }
}

// MARK: - Состояние звонка в беседе
//
// Карту «в какой беседе идёт звонок» держит CallStatusStore (Core/Realtime/CallStatusStore):
// событие call:status одно на всё приложение, и второй такой же карты быть не должно.
// Шапка читает её напрямую, а не через ChatListViewModel: списка в стеке может уже не быть.
private func headerNowMs() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }

/// Единственный вход в звонок беседы для списка и шапки: свой свёрнутый — развернуть,
/// чужой идущий — присоединиться, иначе позвонить.
///
/// Присоединение идёт тем же `startOutgoing`, что и обычный звонок. Веб на этом месте
/// делает startOutgoing+joinCallRoom без `call:invite` (MessagesPane.tsx:1034-1097), но на
/// iOS отдельного входа «без приглашения» нет, а выдумывать его нельзя: фаза `.outgoing` —
/// это то, по чему CallKitController докладывает системе исходящий звонок
/// (CallKitController.onPhaseChange), и без неё звонок остался бы без системной сессии
/// (нет аудио в фоне, нет записи в «Недавних»). Сервер повторное приглашение по ЖИВОМУ
/// звонку не размножает: группе не сбрасывает startedAt и не пишет второе системное
/// сообщение (socket.ts:2212-2232), 1:1-участнику отвечает call:accepted (socket.ts:2075-2083).
func joinOrStartConversationCall(conversationId: String, title: String, video: Bool) {
    let manager = AppContainer.shared.callManager
    if manager.conversationId == conversationId, manager.phase != .idle {
        // Свой звонок в этой же беседе (в том числе входящий и свёрнутый): «подключаться»
        // некуда — возвращаем оверлей.
        manager.expand()
        return
    }
    // Заняты разговором в другой беседе: молча не выдёргиваем человека из него.
    guard manager.phase == .idle else { return }
    manager.startOutgoing(conversationId: conversationId, title: title, video: video)
}

// MARK: - Тексты статуса

/// Порт `formatPresence` (ChatsPage.tsx:5903-5928): «В сети» / «В фоне» / «В звонке» /
/// «Играет в X» / «В звонке и в X» / «был(а) онлайн …» / «оффлайн».
///
/// Ключевое отличие от прежнего `presenceHeaderLabel`: строка есть ВСЕГДА. Пустой
/// подзаголовок у офлайн-собеседника читался как «статус не загрузился».
func formatPeerPresence(status: String?, lastSeenMs: Int64?, game: String?) -> String {
    let raw = status?.uppercased()
    if let game, !game.isEmpty {
        if raw == "IN_CALL" { return "В звонке и в \(game)" }
        if raw == "ONLINE" || raw == "BACKGROUND" { return "Играет в \(game)" }
    }
    switch raw {
    case "ONLINE": return "В сети"
    case "BACKGROUND": return "В фоне"
    case "IN_CALL": return "В звонке"
    default:
        guard let lastSeenMs else { return "оффлайн" }
        return "был(а) онлайн \(formatLastSeen(lastSeenMs))"
    }
}

/// Порт ветки завершённого звонка из шапки веба (MessagesPane.tsx:538-552).
func formatCallEndedLabel(_ endedAtMs: Int64) -> String {
    let diffMin = (headerNowMs() - endedAtMs) / 60_000
    if diffMin < 1 { return "Завершён только что" }
    if diffMin < 60 { return "Завершён \(diffMin) мин назад" }
    let diffHours = diffMin / 60
    if diffHours < 24 { return "Завершён \(diffHours) ч назад" }
    // Дальше суток формат совпадает с «был(а) онлайн»: «Завершён 10.09.2026 в 22:13».
    return "Завершён \(formatLastSeen(endedAtMs))"
}

/// Сколько после завершения держим в шапке «Завершён …» (веб — те же 5 минут).
private let callEndedVisibleMs: Int64 = 5 * 60_000

// MARK: - Модель шапки

/// Всё, что шапке нужно знать о беседе. Собирается в ChatView одной строкой, чтобы
/// перечисление полей не расползалось по вью.
struct ChatHeaderModel {
    let conversationId: String
    var title = ""
    var avatarUrl: String?
    var isGroup = false
    /// Собеседник 1:1 (nil у групп) — по нему берутся присутствие и игра.
    var peerUserId: String?
    /// Живой статус собеседника (ChatViewModel держит его по presence:update).
    var peerStatus: String?
    /// Когда собеседника видели в последний раз (мс эпохи).
    var peerLastSeen: Int64?
    /// Кто печатает (имя в группе, любое непустое значение в 1:1).
    var typingName: String?
    /// Подзаголовок группы — перечисление участников (ui.headerSubtitle).
    var groupSubtitle: String?
    /// Состояние защиты секретки; nil — беседа не секретная.
    var secretState: SecretProtectionState?
}

// MARK: - Центр панели навигации

/// Аватар + название + строка статуса. Приоритет строки повторяет веб:
/// «печатает…» → секретный чип → состояние звонка → присутствие (или состав группы).
struct ChatHeaderTitle: View {
    let model: ChatHeaderModel
    /// Тап по всей связке: 1:1 — карточка собеседника, группа — участники и настройки.
    var onTap: () -> Void = {}

    @ObservedObject private var games = PresenceGames.shared
    @ObservedObject private var calls = CallStatusStore.shared
    @ObservedObject private var callManager = AppContainer.shared.callManager

    var body: some View {
        HStack(spacing: 8) {
            avatar
            VStack(alignment: .leading, spacing: 1) {
                Text(model.title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                subtitle
            }
        }
        // Цель нажатия — вся связка, а не только аватар: в панели он мелкий.
        .contentShape(Rectangle())
        .onTapGesture(perform: onTap)
    }

    // MARK: Аватар с индикатором

    /// Порт шапочного Avatar веба (MessagesPane.tsx:451-466): точка присутствия здесь была
    /// всегда, а на iOS пропадала — статус читался только текстом, и офлайн выглядел
    /// ровно как «не загрузилось».
    private var avatar: some View {
        ZStack(alignment: .bottomTrailing) {
            AvatarView(name: model.title, avatarUrl: model.avatarUrl, size: 34)
            if model.isGroup {
                // У группы присутствия нет: показываем только идущий звонок (как веб,
                // который ставит групповому аватару presence=IN_CALL).
                if callState?.active == true {
                    ChatHeaderCallDot()
                }
            } else if peerGame != nil {
                // Играющий собеседник получает геймпад ВМЕСТО точки при любом базовом
                // статусе — как avatarPresenceForUser на вебе (ChatsPage.tsx:5931-5939).
                GamePresenceBadge(inCall: model.peerStatus?.uppercased() == "IN_CALL")
            } else {
                PresenceBadge(
                    userId: model.peerUserId,
                    status: model.peerStatus,
                    ringSize: 14,
                    dotSize: 9,
                    // Кольцо под цвет фона экрана, как в строке списка чатов.
                    ringColor: Eb.paper
                )
            }
        }
    }

    // MARK: Строка статуса

    @ViewBuilder
    private var subtitle: some View {
        if let typing = model.typingName {
            Text(model.isGroup ? "\(typing) печатает…" : "печатает…")
                .font(.caption)
                .foregroundStyle(Eb.brand)
                .lineLimit(1)
        } else if let secretState = model.secretState {
            // В секретке подпись — чип состояния защиты (он важнее присутствия).
            SecretHeaderStatusChip(state: secretState)
        } else if myCallPhase != nil || callState?.active == true {
            callLine
        } else if let endedAt = callState?.endedAt,
                  headerNowMs() - endedAt < callEndedVisibleMs {
            Text(formatCallEndedLabel(endedAt))
                .font(.caption)
                .foregroundStyle(Eb.textMuted)
                .lineLimit(1)
        } else if model.isGroup {
            if let groupSubtitle = model.groupSubtitle, !groupSubtitle.isEmpty {
                Text(groupSubtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        } else {
            Text(formatPeerPresence(
                status: model.peerStatus,
                lastSeenMs: model.peerLastSeen,
                game: peerGame
            ))
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(1)
        }
    }

    /// «В ЗВОНКЕ» всем и «В ЗВОНКЕ: m:ss» тем, кто в звонке сидит (веб-паритет: чужую
    /// длительность не показываем — по ней видно, кто с кем и как долго говорит).
    /// Таймер тикает, только пока строка на экране.
    @ViewBuilder
    private var callLine: some View {
        if let phase = myCallPhase {
            // Свой звонок описываем своим же состоянием: серверный call:status про наш
            // дозвон ещё молчит, и «В ЗВОНКЕ» вместо «Звоним…» было бы прямым обманом.
            if phase == .outgoing {
                callText("Звоним…")
            } else if phase == .incoming {
                callText("Входящий звонок…")
            } else if let since = callManager.activeSince {
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    callText("В ЗВОНКЕ: " + callDurationLabel(since: since, now: context.date))
                }
            } else {
                callText("В ЗВОНКЕ")
            }
        } else if joinedByServer, let startedAt = callState?.startedAt {
            // Мы в этом звонке, но с ДРУГОГО устройства: длительность берём серверную.
            TimelineView(.periodic(from: .now, by: 1)) { context in
                callText(
                    "В ЗВОНКЕ: " + callDurationLabel(
                        since: Date(timeIntervalSince1970: Double(startedAt) / 1000),
                        now: context.date
                    )
                )
            }
        } else {
            callText("В ЗВОНКЕ")
        }
    }

    /// Оранжевый — единственный способ подсветить идущий звонок в системной панели:
    /// залить саму панель, как это делает веб, нельзя без своей шапки.
    private func callText(_ value: String) -> some View {
        HStack(spacing: 4) {
            Text(value)
            if let game = peerGame, !model.isGroup {
                Text("· \(game)")
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
        }
        .font(.caption.weight(.semibold))
        // Тот же оранжевый, что у строки звонка в плитке списка, — одно состояние, один цвет.
        .foregroundStyle(Eb.brand600)
        .lineLimit(1)
    }

    // MARK: Производные

    private var callState: CallStatusStore.Entry? { calls.calls[model.conversationId] }

    /// Фаза НАШЕГО звонка, если он идёт именно в этой беседе (иначе nil).
    private var myCallPhase: CallPhase? {
        guard callManager.conversationId == model.conversationId, callManager.phase != .idle
        else { return nil }
        return callManager.phase
    }

    /// Название игры собеседника; nil — данных нет, и никакой строки об играх в шапке
    /// не появляется (пустой подписи вместо статуса быть не должно).
    private var peerGame: String? {
        guard let peerUserId = model.peerUserId else { return nil }
        return games.games[peerUserId]
    }

    /// Сервер видит нас в участниках звонка — значит, мы в нём с другого своего
    /// устройства (веб в этом случае подписывает кнопку «Тоже сюда»).
    private var joinedByServer: Bool {
        guard let me = AppContainer.shared.sessionStore.currentUserId(),
              let state = callState, state.active else { return false }
        return state.participants.contains(me)
    }
}

// MARK: - Значки на аватаре шапки

/// Геймпад вместо точки присутствия — порт Avatar.tsx:247-270. Красный, если человек
/// ещё и в звонке (веб красит IN_CALL тем же #ef4444).
struct GamePresenceBadge: View {
    var inCall = false
    var ringSize: CGFloat = 14
    var ringColor: Color = Eb.paper

    var body: some View {
        ZStack {
            Circle().fill(Eb.surface100)
            Circle().strokeBorder(ringColor, lineWidth: 2)
            Image(systemName: "gamecontroller.fill")
                .resizable()
                .scaledToFit()
                .frame(width: ringSize - 6, height: ringSize - 6)
                .foregroundStyle(inCall ? ebCallRed : Eb.online)
        }
        .frame(width: ringSize, height: ringSize)
        // Та же геометрия, что у PresenceBadge: юго-восток значка — в угол квадрата аватара.
        .offset(x: ringSize * 0.146, y: ringSize * 0.146)
    }
}

/// Красная точка «в беседе идёт звонок» — для группового аватара, у которого присутствия нет.
struct ChatHeaderCallDot: View {
    var ringSize: CGFloat = 14
    var ringColor: Color = Eb.paper

    var body: some View {
        ZStack {
            Circle().strokeBorder(ringColor, lineWidth: 2)
            Circle().fill(ebCallRed).frame(width: ringSize - 5, height: ringSize - 5)
        }
        .frame(width: ringSize, height: ringSize)
        .offset(x: ringSize * 0.146, y: ringSize * 0.146)
    }
}

// MARK: - Кнопки звонка в панели

/// Правая группа панели: пока звонка нет — «видео» и «трубка» как раньше; когда в беседе
/// УЖЕ идёт звонок, они превращаются в «Подключиться» (порт MessagesPane.tsx:1034-1097).
/// Раньше единственная трубка всегда начинала свой вызов и в 1:1 перезванивала человеку,
/// который и так сидит в комнате.
struct ChatHeaderCallButtons: View {
    let conversationId: String
    /// Начать новый звонок (video).
    var onStart: (Bool) -> Void
    /// Войти в уже идущий звонок (video).
    var onJoin: (Bool) -> Void
    /// Развернуть свой свёрнутый звонок.
    var onExpand: () -> Void

    @ObservedObject private var calls = CallStatusStore.shared
    @ObservedObject private var callManager = AppContainer.shared.callManager

    var body: some View {
        // Одним HStack, а не отдельными ToolbarItem: набор кнопок меняется на ходу, и
        // тасовать элементы самой панели — верный способ получить прыжки вёрстки.
        HStack(spacing: 16) {
            if mine {
                // Свой звонок в этой беседе: трубка тут ни при чём — вернуть оверлей.
                Button(action: onExpand) {
                    Image(systemName: "arrow.up.left.and.arrow.down.right")
                }
                .accessibilityLabel("Развернуть звонок")
            } else if isActive {
                Button {
                    onJoin(true)
                } label: {
                    Image(systemName: "video.fill")
                }
                .accessibilityLabel(joinedByServer ? "Видео сюда" : "Подключиться с видео")
                Button {
                    onJoin(false)
                } label: {
                    Image(systemName: "phone.fill")
                }
                .accessibilityLabel(joinedByServer ? "Тоже сюда" : "Подключиться")
            } else {
                Button {
                    onStart(true)
                } label: {
                    Image(systemName: "video")
                }
                .accessibilityLabel("Видеозвонок")
                Button {
                    onStart(false)
                } label: {
                    Image(systemName: "phone")
                }
                .accessibilityLabel("Позвонить")
            }
        }
        // Заняты разговором в ДРУГОЙ беседе — не выдёргиваем человека из него нажатием.
        .disabled(busyElsewhere)
        // Залитые значки и оранжевый — только у присоединения: это другое действие, чем
        // «позвонить», и в вебе оно тоже подписано отдельной кнопкой.
        .foregroundStyle(isActive && !mine ? Eb.brand600 : Color.accentColor)
    }

    /// Звонок в этой беседе идёт по версии сервера.
    private var isActive: Bool { calls.calls[conversationId]?.active == true }

    /// Наш звонок — именно в этой беседе (в том числе на дозвоне и свёрнутый).
    private var mine: Bool {
        callManager.conversationId == conversationId && callManager.phase != .idle
    }

    /// Мы в этом звонке, но с другого своего устройства (веб: «Тоже сюда»).
    private var joinedByServer: Bool {
        guard let me = AppContainer.shared.sessionStore.currentUserId(),
              let state = calls.calls[conversationId], state.active else { return false }
        return state.participants.contains(me)
    }

    private var busyElsewhere: Bool {
        callManager.phase != .idle && callManager.conversationId != conversationId
    }
}
