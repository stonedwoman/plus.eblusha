import Combine
import Foundation
import UIKit
import LiveKit

/// Экран установления звонка: склеивает реальные сигналы звонка (CallManager) и комнаты
/// (CallConnectWatcher) с моделью и темпом показа. Порт того, что на вебе делает
/// CallOverlay вокруг usePacedConnectSignals → withPeerSync → buildConnectView, плюс
/// защёлка «разговор начался» и растворение экрана.
///
/// Экран поднимается с началом исходящего вызова: у 1:1 первая ступень — «Ждём ответа»
/// (дозвон), у групп дозвона нет — там сразу этапы подключения, как на вебе. Комната у iOS
/// подключается ещё на дозвоне (как на Android), поэтому локальные этапы не гейтятся:
/// ответ — первая веха темпа, и каскад этапов всё равно идёт после него.
///
/// Только показ. Звонком не управляет: ничего не подключает, не публикует и не завершает —
/// ни параллельной машины состояний, ни таймеров, влияющих на соединение. Единственное
/// действие — «Отменить»/«Закрыть» по нажатию человека, и оно уходит в обычный hangUp.
/// Что собеседник не подтвердил шифрование, экран только сообщает (onPeerEncryptionFailure) —
/// как с этим быть звонку, решает CallManager.
/// Работает на главном потоке, как и сам CallManager.
final class CallConnectController: ObservableObject {

    @Published private(set) var view: ConnectView
    /// Экран смонтирован (с учётом растворения).
    @Published private(set) var visible = false
    /// Разговор начался — экран растворяется, разговор под ним уже идёт.
    @Published private(set) var leaving = false
    /// Когда начался дозвон (монотонные мс) — от него считается фаза колец вокруг
    /// собеседника. Своего гудка у iOS нет, так что фазу больше не к чему привязать.
    @Published private(set) var ringStartedAt: Double?
    /// Номер попытки: растёт на каждом сбросе. Экран привязан к нему, чтобы «Повторить»
    /// показывал новый вызов с чистого листа (секундомер, нажатые кнопки), даже если
    /// SwiftUI не успел снять старый экран между сбросом и новым вызовом.
    @Published private(set) var attempt = 0

    /// Собеседник так и не подтвердил шифрование — ошибка уже на экране.
    var onPeerEncryptionFailure: (() -> Void)?

    private weak var manager: CallManager?
    private var cancellables = Set<AnyCancellable>()
    private let watcher = CallConnectWatcher()

    // ---- Реальные сигналы звонка --------------------------------------------------
    private var isGroup = false
    /// Собрана ли комната с шифрованием; nil — комнаты ещё нет.
    private var roomEncrypted: Bool?
    private var hasToken = false
    private var connected = false
    private var muted = false
    private var micUnavailable = false
    private var error: String?
    private var errorTitle: String?
    /// К ошибке есть «Повторить».
    private var errorRetry = false
    private var peerTitle: String?
    private var peerAvatarUrl: String?
    private var peerId: String?
    /// Идёт дозвон: собеседнику звонит, он ещё не ответил.
    private var dialing = false
    /// У звонка был дозвон: после ответа ступень «Ждём ответа» остаётся сделанной.
    private var hadDial = false
    private var dialTickWork: DispatchWorkItem?

    // ---- Показ ------------------------------------------------------------------
    /// Звонок стал активным для нас — экран поднят.
    private var active = false
    /// Разговор начался и картина дорисована. Защёлка: до конца звонка экран не вернётся.
    private var mediaReady = false
    /// Сколько ступеней показано (usePacedConnectSignals.revealed).
    private var revealed = 0
    private var lastRevealAt: Double = 0
    private var revealWork: DispatchWorkItem?
    private var leaveWork: DispatchWorkItem?

    /// Звонок один на один всегда шифруется: без ключа CallManager комнату не собирает
    /// вовсе («звонок не начат»), открытой личной комнаты не бывает. Обычная комната —
    /// только у групп (их шифрование — в 2.0).
    private var encrypted: Bool { !isGroup && (roomEncrypted ?? true) }

    init() {
        view = buildConnectView(Self.idleSignals)
    }

    /// Подписка на фазу и микрофон звонка. Зовётся один раз из CallManager.init.
    func bind(to manager: CallManager) {
        self.manager = manager
        watcher.onChange = { [weak self] in self?.recompute() }
        manager.$phase
            .removeDuplicates()
            .sink { [weak self] phase in self?.phaseChanged(phase) }
            .store(in: &cancellables)
        manager.$micOn
            .removeDuplicates()
            .sink { [weak self] on in
                self?.muted = !on
                self?.recompute()
            }
            .store(in: &cancellables)
    }

    // MARK: - Реальные события звонка (зовёт CallManager там, где они случаются)

    /// Исходящий вызов: группа ли и как называется беседа, известно сразу — из открытой
    /// беседы. Кеш бесед придёт позже (configure), а экран дозвона нужен в тот же кадр:
    /// иначе группа на миг показала бы «Звоним…».
    func outgoingStarting(isGroup: Bool, title: String) {
        self.isGroup = isGroup
        peerTitle = title
        watcher.setSync(!isGroup)
    }

    /// Кто на том конце — из кеша бесед. Приходит параллельно с подключением.
    func configure(isGroup: Bool, title: String?, avatarUrl: String?, peerId: String?) {
        self.isGroup = isGroup
        peerTitle = title
        peerAvatarUrl = avatarUrl
        self.peerId = peerId
        watcher.setSync(!isGroup)
        recompute()
    }

    /// Сервер выдал пропуск в комнату.
    func tokenReceived() {
        hasToken = true
        recompute()
    }

    /// Комната собрана (с ключом разговора, если он есть) — наблюдатель встаёт внутрь неё.
    func roomCreated(_ room: Room, encrypted: Bool) {
        roomEncrypted = encrypted
        watcher.attach(room: room, encrypted: encrypted, sync: !isGroup)
        recompute()
    }

    /// Соединение с сервером звонков установлено.
    func roomConnected() {
        connected = true
        recompute()
    }

    /// Микрофон не дали — входим без него и честно это показываем. Это не ошибка.
    func markMicUnavailable() {
        micUnavailable = true
        recompute()
    }

    /// Подключиться не удалось. Закрытие — обычным hangUp по кнопке; `retry` добавляет
    /// «Повторить» (звонок не начат из-за шифрования — его можно набрать заново).
    func fail(title: String, text: String, retry: Bool = false) {
        error = text
        errorTitle = title
        errorRetry = retry
        // Дозвона больше нет: таймер под «Звоним…» не нужен.
        dialing = false
        recompute()
    }

    /// «Повторить» на экране «звонок не начат»: новый вызов в ту же беседу.
    func retry() {
        manager?.retryAfterEncryptionFailure()
    }

    /// «Отменить» / «Закрыть»: существующий путь завершения. Повторные нажатия гасит
    /// сам экран, а hangUp по уже завершённому звонку безвреден.
    func cancel() {
        manager?.hangUp()
    }

    // MARK: - Фаза

    private func phaseChanged(_ phase: CallPhase) {
        switch phase {
        case .idle:
            resetAll()
        case .outgoing:
            // Экран — с первой секунды вызова, вместо отдельного «Звоним…».
            dialing = true
            hadDial = true
            if ringStartedAt == nil { ringStartedAt = connectMonotonicNowMs() }
            activateIfNeeded()
        case .connecting, .inCall:
            // Ответили (или приняли входящий): «Ждём ответа» становится сделанной.
            dialing = false
            if active { recompute() } else { activateIfNeeded() }
        case .incoming:
            // Входящий остаётся своим экраном. Комната при этом может уже подключаться —
            // ступени покажутся в темпе, когда звонок станет активным.
            break
        }
    }

    private func activateIfNeeded() {
        guard !active, !mediaReady else { return }
        active = true
        visible = true
        leaving = false
        // Темп начинается с нуля в момент появления экрана (resetKey на вебе).
        revealed = 0
        lastRevealAt = connectMonotonicNowMs()
        recompute()
    }

    private func resetAll() {
        attempt += 1
        revealWork?.cancel()
        revealWork = nil
        leaveWork?.cancel()
        leaveWork = nil
        dialTickWork?.cancel()
        dialTickWork = nil
        dialing = false
        hadDial = false
        ringStartedAt = nil
        watcher.detach()
        isGroup = false
        roomEncrypted = nil
        hasToken = false
        connected = false
        micUnavailable = false
        error = nil
        errorTitle = nil
        errorRetry = false
        peerTitle = nil
        peerAvatarUrl = nil
        peerId = nil
        active = false
        mediaReady = false
        revealed = 0
        visible = false
        leaving = false
        view = buildConnectView(Self.idleSignals)
    }

    // MARK: - Сборка экрана

    private func recompute() {
        let progress = watcher.progress
        // Звук собеседника идёт, а замочек так и не загорелся — продолжать без шифрования
        // нельзя. Как на вебе, ошибка защёлкивается: позднее подтверждение её не снимает.
        if encrypted && progress.peerEncryptionTimeout && error == nil {
            error = "Собеседник не подтвердил шифрование. Продолжить без шифрования нельзя."
            errorTitle = nil
            errorRetry = false
            // Асинхронно: мы внутри пересчёта, а реакция звонка сама меняет то, что он читает.
            DispatchQueue.main.async { [weak self] in self?.onPeerEncryptionFailure?() }
        }
        // Дозвон есть только у 1:1. Пока звонит — true, после ответа — false (ступень
        // остаётся сделанной), у звонка без дозвона — nil.
        let ringing: Bool? = isGroup ? nil : (dialing ? true : (hadDial ? false : nil))
        let ringingSeconds: Int? = ringing == true
            ? ringStartedAt.map { max(0, Int((connectMonotonicNowMs() - $0) / 1000)) }
            : nil
        let signals = ConnectSignals(
            isGroup: isGroup,
            encrypted: encrypted,
            muted: muted,
            hasToken: hasToken,
            keysReady: roomEncrypted == true,
            connected: connected,
            // Своя дорожка подтверждает шифрование сама. Без неё (микрофон не дали)
            // подтверждением служит расшифрованная чужая: ключ разговора на нашем
            // соединении реально работает, а ждать отчёта несуществующей дорожки вечно нельзя.
            e2eeEnabled: watcher.localEncryptionOk || (micUnavailable && watcher.remoteDecryptionOk),
            micPublished: progress.micPublished,
            // Отката «через ретранслятор → напрямую», как на вебе, у iOS нет.
            routeSwitching: false,
            route: progress.route,
            peer: ConnectPeer(
                presence: progress.peerPresence,
                count: progress.peerCount,
                name: isGroup ? peerTitle : (progress.peerName ?? peerTitle ?? manager?.title),
                id: peerId,
                avatarUrl: peerAvatarUrl
            ),
            error: error,
            errorTitle: errorTitle,
            micUnavailable: micUnavailable,
            ringing: ringing,
            ringingSeconds: ringingSeconds,
            errorRetry: errorRetry
        )

        // Темп показа (usePacedConnectSignals): реальные ступени показываются по очереди,
        // каждая не раньше, чем сделана, и не чаще раза в dwell.
        let flags = ConnectPacing.milestoneFlags(signals)
        let total = flags.count
        let realCount = ConnectPacing.leadingTrue(flags)
        let dwell = ConnectPacing.dwellMs(total: total)
        let goal = realCount == total ? total + 1 : realCount
        // Откат реальности отражается сразу.
        if revealed > goal { revealed = goal }
        let shown = min(revealed, goal)
        let settled = active && shown > total

        let paced = ConnectPacing.applyPacing(signals, shown: shown)
        // Пока собеседник дорисовывает свою картину, показываем «синхронизируемся»:
        // разговор открывается у обоих разом.
        let presented = withPeerSync(paced, peerSettled: progress.peerSettled)
        let next = buildConnectView(presented)
        if next != view { view = next }

        watcher.setLocal(settled: settled, audio: !muted && !micUnavailable)
        scheduleDialTick(ringing: ringing == true)

        // Разговор начался и картина дорисована — защёлкиваем.
        if active && !mediaReady && next.ready && settled {
            latch()
            return
        }
        scheduleReveal(goal: goal, dwell: dwell)
    }

    private func scheduleReveal(goal: Int, dwell: Double) {
        revealWork?.cancel()
        revealWork = nil
        guard active, !mediaReady, revealed < goal else { return }
        let wait = max(0, lastRevealAt + dwell - connectMonotonicNowMs())
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.active, !self.mediaReady else { return }
            self.lastRevealAt = connectMonotonicNowMs()
            self.revealed += 1
            self.recompute()
        }
        revealWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + wait / 1000, execute: work)
    }

    /// Таймер под «Звоним…» — раз в секунду, ровно на границе секунды от начала вызова.
    private func scheduleDialTick(ringing: Bool) {
        dialTickWork?.cancel()
        dialTickWork = nil
        guard ringing, let start = ringStartedAt else { return }
        let elapsed = connectMonotonicNowMs() - start
        // +5 мс: сработав чуть раньше границы, таймер показал бы ту же секунду ещё раз.
        let wait = 1000 - elapsed.truncatingRemainder(dividingBy: 1000) + 5
        let work = DispatchWorkItem { [weak self] in self?.recompute() }
        dialTickWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + wait / 1000, execute: work)
    }

    /// Экран растворяется, а не пропадает рывком (220 мс, как на вебе); при «меньше
    /// движения» — сразу. Наблюдатель снимается вместе с экраном: рукопожатие и опрос
    /// пути нужны, только пока он виден.
    private func latch() {
        mediaReady = true
        revealWork?.cancel()
        revealWork = nil
        leaving = true
        leaveWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.mediaReady else { return }
            self.visible = false
            self.leaving = false
            self.watcher.detach()
        }
        leaveWork = work
        let delay = UIAccessibility.isReduceMotionEnabled ? 0 : 0.22
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }

    private static let idleSignals = ConnectSignals(
        isGroup: false,
        encrypted: false,
        muted: false,
        hasToken: false,
        keysReady: false,
        connected: false,
        e2eeEnabled: false,
        micPublished: false,
        routeSwitching: false,
        route: .empty,
        peer: ConnectPeer(presence: .absent, count: 0, name: nil, id: nil, avatarUrl: nil),
        error: nil,
        errorTitle: nil,
        micUnavailable: false
    )
}
