import Combine
import Foundation
import UIKit
import LiveKit

/// Экран установления звонка: склеивает реальные сигналы звонка (CallManager) и комнаты
/// (CallConnectWatcher) с моделью и темпом показа. Порт того, что на вебе делает
/// CallOverlay вокруг usePacedConnectSignals → withPeerSync → buildConnectView, плюс
/// защёлка «разговор начался» и растворение экрана.
///
/// Только показ. Звонком не управляет: ничего не подключает, не публикует и не завершает —
/// ни параллельной машины состояний, ни таймеров, влияющих на соединение. Единственное
/// действие — «Отменить»/«Закрыть» по нажатию человека, и оно уходит в обычный hangUp.
/// Работает на главном потоке, как и сам CallManager.
final class CallConnectController: ObservableObject {

    @Published private(set) var view: ConnectView
    /// Экран смонтирован (с учётом растворения).
    @Published private(set) var visible = false
    /// Разговор начался — экран растворяется, разговор под ним уже идёт.
    @Published private(set) var leaving = false

    private weak var manager: CallManager?
    private var cancellables = Set<AnyCancellable>()
    private let watcher = CallConnectWatcher()

    // ---- Реальные сигналы звонка --------------------------------------------------
    private var isGroup = false
    /// Собрана ли комната со сквозным шифрованием; nil — комнаты ещё нет.
    private var roomEncrypted: Bool?
    private var hasToken = false
    private var connected = false
    private var muted = false
    private var micUnavailable = false
    private var error: String?
    private var errorTitle: String?
    private var peerTitle: String?
    private var peerAvatarUrl: String?
    private var peerId: String?

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

    /// Звонок один на один идёт со сквозным шифрованием. Пока комнаты нет, так и ждём
    /// (как shouldUseE2ee на вебе); если сервер ключа не выдал — iOS, как и прежде,
    /// собирает обычную комнату, и экран честно перестаёт обещать шифрование.
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

    /// Подключиться не удалось. Закрытие — обычным hangUp по кнопке.
    func fail(title: String, text: String) {
        error = text
        errorTitle = title
        recompute()
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
        case .connecting, .inCall:
            activateIfNeeded()
        case .incoming, .outgoing:
            // Входящий и «Звоним…» остаются своими экранами. Комната при этом может уже
            // подключаться — ступени покажутся в темпе, когда звонок станет активным.
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
        revealWork?.cancel()
        revealWork = nil
        leaveWork?.cancel()
        leaveWork = nil
        watcher.detach()
        isGroup = false
        roomEncrypted = nil
        hasToken = false
        connected = false
        micUnavailable = false
        error = nil
        errorTitle = nil
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
            error = "Собеседник не подтвердил сквозное шифрование. Продолжить без шифрования нельзя."
            errorTitle = nil
        }
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
            micUnavailable: micUnavailable
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
