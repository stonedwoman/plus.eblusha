import Foundation

// Модель экрана установления звонка — порт `frontend/src/ui/components/callConnectView.ts`
// один в один: те же этапы, узлы, связи, факты и тексты, тот же темп показа.
//
// Экран — не постановка, а зеркало: каждый этап и каждый факт выводится из реального
// состояния звонка (пропуск получен, ключи готовы, комната подключена, шифрование
// подтверждено, микрофон опубликован, собеседник слышен). Здесь нет таймеров и процентов:
// быстрый этап проскакивает, долгий честно висит. Модель не знает ни про SwiftUI, ни про
// LiveKit — это чистые функции над значениями, как и на вебе.

enum ConnectStepId: String {
    case ring
    case signaling
    case cryptoPrepare = "crypto-prepare"
    case route
    case cryptoEnable = "crypto-enable"
    case publish
    case waitPeer = "wait-peer"
}

enum ConnectStepStatus { case done, active, waiting }
enum ConnectNodeId: String { case you, relay, server, peer }
/// ringing — исходящий вызов: собеседнику звонит, он ещё не ответил.
enum ConnectNodeState { case waiting, active, ready, ringing }
enum ConnectLinkState { case idle, searching, ready }
/// settling — собеседник уже слышен, но у него ещё дорисовывается своя картина подключения.
enum ConnectPeerPresence { case absent, joining, settling, ready }

/// Каким путём легло соединение с сервером звонков — из живой статистики WebRTC.
struct ConnectRoute: Equatable {
    /// true — через ретранслятор, false — напрямую, nil — ещё неизвестно.
    var relayed: Bool?
    var rttMs: Int?
    var relayName: String?
    var relayHost: String?

    static let empty = ConnectRoute(relayed: nil, rttMs: nil, relayName: nil, relayHost: nil)
}

/// Что наблюдатель внутри комнаты сообщает наружу.
struct ConnectProgress: Equatable {
    var micPublished: Bool
    var peerPresence: ConnectPeerPresence
    /// Сколько людей в комнате кроме нас.
    var peerCount: Int
    var peerName: String?
    /// Собеседник дорисовал свою картину (или сигнала от него не ждём) — можно открывать разговор.
    var peerSettled: Bool
    /// Звук собеседника идёт, а шифрование он так и не подтвердил — это уже ошибка E2EE.
    var peerEncryptionTimeout: Bool
    var route: ConnectRoute

    static let empty = ConnectProgress(
        micPublished: false,
        peerPresence: .absent,
        peerCount: 0,
        peerName: nil,
        peerSettled: false,
        peerEncryptionTimeout: false,
        route: .empty
    )
}

struct ConnectPeer: Equatable {
    var presence: ConnectPeerPresence
    var count: Int
    var name: String?
    var id: String?
    var avatarUrl: String?
}

/// Реальные состояния звонка, из которых собирается экран.
struct ConnectSignals: Equatable {
    var isGroup: Bool
    /// Звонок шифруется (разговоры один на один). Ключ сегодня выдаёт сервер — это
    /// «шифрование через сервер», не сквозное.
    var encrypted: Bool
    /// Человек вошёл с выключенным микрофоном — публикации голоса ждать нечего.
    var muted: Bool
    /// Сервер выдал пропуск в комнату.
    var hasToken: Bool
    /// Ключ разговора получен, шифратор готов. Это ещё не включённое шифрование.
    var keysReady: Bool
    /// Соединение с сервером звонков установлено.
    var connected: Bool
    /// Шифрование подтверждено на нашем соединении.
    var e2eeEnabled: Bool
    var micPublished: Bool
    /// Через ретрансляторы не вышло — идёт повторная попытка напрямую.
    var routeSwitching: Bool
    var route: ConnectRoute
    var peer: ConnectPeer
    /// Ошибка, после которой звонок продолжать нельзя.
    var error: String?
    /// Заголовок для ошибки; по умолчанию — про защищённый звонок.
    var errorTitle: String?
    /// Микрофон не удалось получить — входим без него и честно это показываем.
    var micUnavailable: Bool
    /// Исходящий вызов: true — собеседник ещё не ответил, false — ответил (ступень «Ждём
    /// ответа» остаётся в списке сделанной), nil — у звонка не было дозвона.
    var ringing: Bool? = nil
    /// Сколько секунд идёт дозвон — для подписи под заголовком.
    var ringingSeconds: Int? = nil
    /// К ошибке можно предложить «Повторить» (звонок не начат: не удалось включить шифрование).
    var errorRetry: Bool = false
}

struct ConnectStep: Equatable, Identifiable {
    let id: ConnectStepId
    let title: String
    let status: ConnectStepStatus
    let hint: String
}

struct ConnectNode: Equatable, Identifiable {
    let id: ConnectNodeId
    let label: String
    let sub: String?
    let state: ConnectNodeState
    let avatarUrl: String?
    let avatarId: String?
    /// Узел обозначает группу, а не одного человека.
    let group: Bool
    /// Что показать по нажатию на узел.
    let detail: String
}

struct ConnectLink: Equatable {
    let from: ConnectNodeId
    let to: ConnectNodeId
    let state: ConnectLinkState
}

enum ConnectFactId: String { case e2ee, relay, direct, rtt }

struct ConnectFact: Equatable, Identifiable {
    let id: ConnectFactId
    let text: String
}

struct ConnectError: Equatable {
    let title: String
    let text: String
    /// Показать «Повторить» рядом с «Закрыть».
    var retry: Bool = false
}

enum ConnectMode { case connecting, done, error }

struct ConnectView: Equatable {
    let mode: ConnectMode
    let title: String
    let subtitle: String
    let steps: [ConnectStep]
    let nodes: [ConnectNode]
    let links: [ConnectLink]
    let facts: [ConnectFact]
    let error: ConnectError?
    /// Наша часть готова и собеседник слышен — экран можно убирать.
    let ready: Bool
}

private let connectErrorTitle = "Защищённый звонок недоступен"

/// Монотонные часы: перевод системного времени не должен стопорить темп и таймауты.
func connectMonotonicNowMs() -> Double {
    ProcessInfo.processInfo.systemUptime * 1000
}

/// Math.round из JS: половину округляет вверх. Для неотрицательных чисел совпадает с
/// .toNearestOrAwayFromZero, но пишем явно — чтобы не зависеть от знака.
func connectJsRound(_ x: Double) -> Int {
    Int((x + 0.5).rounded(.down))
}

/// В JS пустая строка ложна: `name || 'Собеседник'` на "" берёт запасной вариант, а `??`
/// в Swift пропустил бы пустую строку. Модель портирована один в один — и в этом тоже.
private func nonEmpty(_ s: String?) -> String? {
    guard let s, !s.isEmpty else { return nil }
    return s
}

private func pluralParticipants(_ n: Int) -> String {
    let mod10 = n % 10
    let mod100 = n % 100
    if mod10 == 1 && mod100 != 11 { return "\(n) участник" }
    if mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) { return "\(n) участника" }
    return "\(n) участников"
}

private func formatSeconds(_ total: Int) -> String {
    let m = total / 60
    let sec = total % 60
    return "\(m):\(sec < 10 ? "0" : "")\(sec)"
}

private func relayFact(_ name: String?) -> String {
    guard let name = nonEmpty(name) else { return "Через ретранслятор" }
    if name == "Наш ретранслятор" { return "Через наш ретранслятор" }
    return "Через ретранслятор \(name)"
}

func buildConnectView(_ s: ConnectSignals) -> ConnectView {
    if let error = nonEmpty(s.error) {
        let title = nonEmpty(s.errorTitle) ?? connectErrorTitle
        return ConnectView(
            mode: .error,
            title: title,
            subtitle: "",
            steps: [],
            nodes: [],
            links: [],
            facts: [],
            error: ConnectError(title: title, text: error, retry: s.errorRetry),
            ready: false
        )
    }

    let isGroup = s.isGroup
    let encrypted = s.encrypted
    let dialed = s.ringing != nil
    let ringing = s.ringing == true
    let signalingDone = s.hasToken
    let keysDone = !encrypted || s.keysReady
    let routeDone = s.connected
    let e2eeDone = !encrypted || s.e2eeEnabled
    let micSkipped = s.muted || s.micUnavailable
    let publishDone = micSkipped || s.micPublished
    let localReady = signalingDone && keysDone && routeDone && e2eeDone && publishDone
    // В группе ждать некого, если в комнате пусто: мы первые, остальные подтянутся в
    // обычный интерфейс. Если кто-то уже есть — ждём, пока хоть один станет слышен.
    // Кто в комнате, известно только после подключения — до него ничего не решаем.
    let peerDone = isGroup
        ? s.connected && (s.peer.count == 0 || s.peer.presence == .ready)
        : s.peer.presence == .ready
    let ready = localReady && peerDone

    let rtt: Int? = (s.connected && (s.route.rttMs ?? 0) > 0) ? s.route.rttMs : nil
    let relayShown = s.connected && s.route.relayed == true
    let relayLabel = nonEmpty(s.route.relayName) ?? "Ретранслятор"
    let peerLabel = nonEmpty(s.peer.name) ?? (isGroup ? "Группа" : "Собеседник")

    // Этап активен, когда его предпосылки выполнены, а сам он — ещё нет.
    func status(_ done: Bool, _ gate: Bool) -> ConnectStepStatus {
        done ? .done : (gate ? .active : .waiting)
    }

    var steps: [ConnectStep] = []
    if dialed {
        steps.append(ConnectStep(
            id: .ring,
            title: "Ждём ответа",
            status: ringing ? .active : .done,
            hint: ringing ? "Собеседнику звонит — он ещё не ответил на вызов." : "Собеседник ответил на вызов."
        ))
    }
    steps.append(ConnectStep(
        id: .signaling,
        title: "Согласуем звонок",
        status: status(signalingDone, !ringing),
        hint: signalingDone
            ? "Сервер знает о звонке и выдал нам пропуск в комнату."
            : "Просим у сервера пропуск в комнату звонка."
    ))
    if encrypted {
        steps.append(ConnectStep(
            id: .cryptoPrepare,
            title: "Готовим шифрование",
            status: status(s.keysReady, signalingDone),
            hint: s.keysReady
                ? "Ключ разговора получен, шифратор готов. Само шифрование включится после подключения."
                : "Получаем ключ разговора и готовим шифратор."
        ))
    }
    let routeHint: String
    if routeDone {
        if relayShown {
            let host = nonEmpty(s.route.relayHost).map { " (\($0))" } ?? ""
            routeHint = "Путь к серверу проложен через \(relayLabel)\(host)."
        } else {
            routeHint = "Путь к серверу проложен напрямую, без ретранслятора."
        }
    } else if s.routeSwitching {
        routeHint = "Через ретрансляторы не вышло — пробуем соединиться с сервером напрямую."
    } else {
        routeHint = "Подбираем путь к серверу звонков: через ближайший ретранслятор или напрямую."
    }
    steps.append(ConnectStep(
        id: .route,
        title: "Ищем путь к серверу",
        status: status(routeDone, signalingDone && keysDone),
        hint: routeHint
    ))
    if encrypted {
        steps.append(ConnectStep(
            id: .cryptoEnable,
            title: "Включаем шифрование",
            status: status(s.e2eeEnabled, routeDone),
            hint: s.e2eeEnabled
                ? "Шифрование включено: голос уходит зашифрованным. Ключ разговора выдаёт сервер."
                : "Включаем шифрование на этом соединении и ждём подтверждения."
        ))
    }
    let publishHint: String
    if s.micUnavailable {
        // Веб просит проверить «разрешения браузера»; у нас это системные настройки.
        publishHint = "Не удалось получить доступ к микрофону — вас не будет слышно. Проверьте разрешения в настройках."
    } else if s.muted {
        publishHint = "Вы вошли с выключенным микрофоном: вас не будет слышно, пока не включите его."
    } else if publishDone {
        publishHint = "Ваш голос уходит в звонок."
    } else {
        publishHint = "Отдаём ваш микрофон в звонок. До этого момента вас не слышно."
    }
    steps.append(ConnectStep(
        id: .publish,
        title: s.micUnavailable ? "Микрофон недоступен" : (s.muted ? "Микрофон выключен" : "Передаём ваш голос"),
        status: status(publishDone, routeDone && e2eeDone),
        hint: publishHint
    ))
    let peerHint: String
    if isGroup {
        if s.peer.count == 0 {
            peerHint = s.connected
                ? "В разговоре пока никого нет — вы первые. Остальные появятся по мере подключения."
                : "Кто уже в разговоре, узнаем после подключения к серверу."
        } else {
            peerHint = peerDone ? "Участники слышны." : "Участники в комнате, ждём их звук."
        }
    } else {
        switch s.peer.presence {
        case .ready:
            peerHint = "Собеседник слышен — можно говорить."
        case .settling:
            peerHint = "Собеседник уже слышен, у него дорисовывается картина подключения."
        case .joining:
            peerHint = encrypted
                ? "Собеседник в комнате, ждём его звук и подтверждение шифрования."
                : "Собеседник в комнате, ждём его звук."
        case .absent:
            peerHint = "Собеседник ещё не подключился к комнате звонка."
        }
    }
    steps.append(ConnectStep(
        id: .waitPeer,
        title: isGroup ? "Подключаем участников" : "Ждём собеседника",
        status: status(peerDone, localReady),
        hint: peerHint
    ))

    var title = "Соединение установлено"
    var subtitle = "Начинаем разговор"
    if !ready {
        switch steps.first(where: { $0.status == .active })?.id {
        case .ring:
            title = "Звоним…"
            subtitle = "Ждём ответа собеседника" + (s.ringingSeconds.map { " · \(formatSeconds($0))" } ?? "")
        case .signaling:
            // После дозвона важнее сказать, что собеседник ответил, чем что мы договариваемся.
            title = dialed ? "Собеседник ответил" : "Подключаем звонок…"
            subtitle = "Договариваемся о соединении"
        case .cryptoPrepare:
            title = "Готовим защиту…"
            subtitle = "Подготавливаем шифрование"
        case .route:
            if s.routeSwitching {
                title = "Меняем маршрут…"
                subtitle = "Пробуем соединиться с сервером напрямую"
            } else {
                title = "Прокладываем путь…"
                subtitle = "Ищем соединение с сервером Еблуши"
            }
        case .cryptoEnable:
            title = "Включаем шифрование…"
            subtitle = "Проверяем защищённое соединение"
        case .publish:
            title = "Подключаем микрофон…"
            subtitle = "Готовим передачу вашего голоса"
        case .waitPeer:
            if isGroup {
                title = "Подключаем участников…"
                subtitle = "Ждём звук от участников разговора"
            } else if s.peer.presence == .settling {
                title = "Синхронизируемся…"
                subtitle = "Собеседник вот-вот подключится"
            } else if s.peer.presence == .joining {
                title = "Собеседник подключается…"
                subtitle = encrypted ? "Ждём звук и подтверждение шифрования с той стороны" : "Ждём звук с той стороны"
            } else {
                title = "Ждём собеседника…"
                subtitle = "Собеседник ещё не в комнате звонка"
            }
        case nil:
            title = "Подключаем звонок…"
            subtitle = "Договариваемся о соединении"
        }
    }

    let routeActive = steps.contains { $0.id == .route && $0.status == .active }

    var nodes: [ConnectNode] = []
    let youDetail: String
    if s.micUnavailable {
        youDetail = "Вы. Микрофон недоступен — вас не будет слышно."
    } else if s.muted {
        youDetail = "Вы. Микрофон выключен."
    } else if s.micPublished {
        youDetail = "Вы. Микрофон передаётся в звонок."
    } else {
        youDetail = "Вы. Микрофон ещё не подключён к звонку."
    }
    nodes.append(ConnectNode(
        id: .you, label: "Вы", sub: nil, state: .ready,
        avatarUrl: nil, avatarId: nil, group: false, detail: youDetail
    ))
    if relayShown {
        let host = nonEmpty(s.route.relayHost).map { " (\($0))" } ?? ""
        nodes.append(ConnectNode(
            id: .relay, label: relayLabel, sub: s.route.relayHost, state: .ready,
            avatarUrl: nil, avatarId: nil, group: false,
            detail: "\(relayLabel)\(host): через него идёт ваш путь к серверу."
        ))
    }
    let serverDetail: String
    if s.connected {
        serverDetail = "Сервер Еблуши: соединение установлено\(rtt.map { ", задержка \($0) мс" } ?? "")."
    } else if routeActive {
        serverDetail = "Сервер Еблуши: ищем соединение."
    } else {
        serverDetail = "Сервер Еблуши: ждём своей очереди."
    }
    nodes.append(ConnectNode(
        id: .server,
        label: "Сервер Еблуши",
        sub: rtt.map { "\($0) мс" },
        state: s.connected ? .ready : (routeActive ? .active : .waiting),
        avatarUrl: nil, avatarId: nil, group: false, detail: serverDetail
    ))
    let peerState: ConnectNodeState
    if ringing {
        peerState = .ringing
    } else if isGroup {
        peerState = s.peer.count == 0 ? .waiting : (s.peer.presence == .ready ? .ready : .active)
    } else {
        switch s.peer.presence {
        case .ready: peerState = .ready
        case .joining, .settling: peerState = .active
        case .absent: peerState = .waiting
        }
    }
    let peerNote = " Показан ваш путь к серверу; данные о сети собеседника недоступны."
    let peerDetail: String
    if isGroup {
        if s.peer.count == 0 {
            peerDetail = s.connected
                ? "\(peerLabel): в разговоре пока никого нет."
                : "\(peerLabel): узнаем состав после подключения."
        } else {
            peerDetail = peerState == .ready
                ? "\(peerLabel): участники слышны."
                : "\(peerLabel): подключаем участников."
        }
    } else {
        let base: String
        if peerState == .ringing {
            base = "\(peerLabel): вызываем, ответа пока нет."
        } else if peerState == .ready {
            base = "\(peerLabel): в звонке, звук идёт."
        } else if s.peer.presence == .settling {
            base = "\(peerLabel): почти готов, дорисовывает картину."
        } else if peerState == .active {
            base = "\(peerLabel): подключается."
        } else {
            base = "\(peerLabel): ещё не подключился к звонку."
        }
        peerDetail = base + peerNote
    }
    nodes.append(ConnectNode(
        id: .peer,
        label: peerLabel,
        sub: isGroup ? (s.peer.count > 0 ? pluralParticipants(s.peer.count) : "пока никого") : nil,
        state: peerState,
        avatarUrl: s.peer.avatarUrl,
        avatarId: s.peer.id,
        group: isGroup,
        detail: peerDetail
    ))

    var links: [ConnectLink] = []
    let firstHop: ConnectNodeId = relayShown ? .relay : .server
    links.append(ConnectLink(
        from: .you, to: firstHop,
        state: s.connected ? .ready : (routeActive ? .searching : .idle)
    ))
    if relayShown { links.append(ConnectLink(from: .relay, to: .server, state: .ready)) }
    links.append(ConnectLink(
        from: .server, to: .peer,
        state: peerState == .ready ? .ready : (peerState == .active ? .searching : .idle)
    ))

    var facts: [ConnectFact] = []
    // Честно: ключ личного звонка сегодня выдаёт сервер — это не сквозное шифрование.
    // Группы пока не шифруются вовсе (их шифрование — в 2.0).
    if encrypted && s.e2eeEnabled { facts.append(ConnectFact(id: .e2ee, text: "Шифрование через сервер")) }
    if !encrypted && s.connected { facts.append(ConnectFact(id: .e2ee, text: "Без шифрования")) }
    if relayShown { facts.append(ConnectFact(id: .relay, text: relayFact(s.route.relayName))) }
    if s.connected && s.route.relayed == false { facts.append(ConnectFact(id: .direct, text: "Прямой путь")) }
    if let rtt { facts.append(ConnectFact(id: .rtt, text: "\(rtt) мс до сервера")) }

    return ConnectView(
        mode: ready ? .done : .connecting,
        title: title,
        subtitle: subtitle,
        steps: steps,
        nodes: nodes,
        links: links,
        facts: facts,
        error: nil,
        ready: ready
    )
}

/// Синхронизация с собеседником: его звук уже идёт, но свою картину он ещё дорисовывает —
/// показываем «синхронизируемся», а не готовность, чтобы разговор открылся у обоих разом.
func withPeerSync(_ s: ConnectSignals, peerSettled: Bool) -> ConnectSignals {
    if s.isGroup || peerSettled || s.peer.presence != .ready { return s }
    var out = s
    out.peer.presence = .settling
    return out
}

// MARK: - Темп показа

/// Настоящее подключение часто укладывается в доли секунды, и вместо картины человек
/// видел бы вспышку. Темп не задерживает ни одно реальное событие — звонок под экраном
/// идёт как шёл. Он лишь показывает УЖЕ случившиеся ступени по очереди, каждую не короче
/// одной паузы, так что вся картина занимает около targetTotalMs. Если подключение само
/// идёт медленнее — темп не вмешивается: ни одна ступень не показывается сделанной раньше,
/// чем сделана на самом деле, а откат реальности (обрыв до готовности) отражается сразу.
enum ConnectPacing {
    static let targetTotalMs: Double = 3000
    static let minDwellMs: Double = 400

    /// Ступени в порядке показа; которых в этом звонке нет — пропускаются.
    static func milestoneFlags(_ s: ConnectSignals) -> [Bool] {
        var flags: [Bool] = []
        // Ответ — первая ступень: каскад этапов идёт после него, даже если комната
        // подключилась ещё на дозвоне.
        if let ringing = s.ringing { flags.append(!ringing) }
        flags.append(s.hasToken)
        if s.encrypted { flags.append(s.keysReady) }
        flags.append(s.connected)
        if s.encrypted { flags.append(s.e2eeEnabled) }
        if !s.muted && !s.micUnavailable { flags.append(s.micPublished) }
        if !s.isGroup {
            flags.append(s.peer.presence == .ready)
        } else if s.peer.count > 0 {
            flags.append(s.peer.presence == .ready)
        } else {
            flags.append(s.connected)
        }
        return flags
    }

    /// Сколько ступеней подряд с начала действительно сделаны.
    static func leadingTrue(_ flags: [Bool]) -> Int {
        var n = 0
        while n < flags.count && flags[n] { n += 1 }
        return n
    }

    /// Пауза на ступень. Заключительная пауза «Соединение установлено» — тоже ступень, отсюда +1.
    static func dwellMs(total: Int) -> Double {
        max(minDwellMs, Double(connectJsRound(targetTotalMs / Double(total + 1))))
    }

    /// Сигналы, в которых сделанными показаны только первые [shown] ступеней.
    static func applyPacing(_ s: ConnectSignals, shown: Int) -> ConnectSignals {
        if nonEmpty(s.error) != nil { return s }
        var i = 0
        func next(_ real: Bool) -> Bool {
            let k = i
            i += 1
            return real && k < shown
        }
        var out = s
        if let ringing = s.ringing {
            let answered = next(!ringing)
            out.ringing = ringing || !answered
        }
        out.hasToken = next(s.hasToken)
        if s.encrypted { out.keysReady = next(s.keysReady) }
        out.connected = next(s.connected)
        if s.encrypted { out.e2eeEnabled = next(s.e2eeEnabled) }
        if !(s.muted || s.micUnavailable) { out.micPublished = next(s.micPublished) }
        let waitsForPeer = !s.isGroup || s.peer.count > 0
        // В пустой группе последняя ступень — «узнали, что никого нет», она наступает с подключением.
        let peerShown = waitsForPeer
            ? next(s.peer.presence == .ready)
            : next(s.connected) && s.peer.presence == .ready
        // Собеседник уже слышен, но его ступень ещё не показана — он «подключается».
        if s.peer.presence == .ready && !peerShown { out.peer.presence = .joining }
        return out
    }
}
