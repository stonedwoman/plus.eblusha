import AVFoundation
import Combine
import Network
import SwiftUI
import UIKit

// Автопроигрывание коротких видео прямо в ленте: без звука, циклом, только у той плитки,
// которую человек реально видит. Смысл — как в мессенджерах с «оживающей» лентой: короткая
// склейка на 5 секунд читается сразу, без тапа и без модального плеера.
//
// Почему это отдельный файл и отдельный координатор, а не @State внутри плитки:
//  * плееров в ленте должно быть МАЛО (здесь — не больше двух одновременно). Решение
//    «кто играет» глобальное по определению, из одной ячейки его не принять;
//  * видимость ячейки из SwiftUI не видна. Лента — UICollectionView, при прокрутке
//    слои едут без пересборки SwiftUI-дерева, поэтому onGeometryChange молчит. Честную
//    геометрию знает только сам UIView — он и меряет себя в координатах окна;
//  * плеер надо освобождать при уходе плитки с экрана, а @State переживает
//    переиспользование ячейки (та же ловушка, что с resolvedFor в SecretImageView).
//
// Трафик и батарея ограничены жёстко: только несекретное видео с ИЗВЕСТНЫМИ метаданными
// не длиннее 30 с и не тяжелее 8 МБ, по умолчанию — только в незатратной сети (Wi-Fi),
// и всё это выключается одним переключателем в настройках.

// MARK: - Настройка

/// Режим автопроигрывания из настроек. Хранится строкой в UserDefaults: один ключ читают
/// и SettingsView (через @AppStorage), и координатор (напрямую на каждом решении —
/// поэтому выключение срабатывает сразу, без подписок и уведомлений).
enum VideoAutoplayMode: String, CaseIterable, Identifiable {
    /// Никогда: плитка остаётся постером с кнопкой Play.
    case never
    /// Только в незатратной сети — значение по умолчанию.
    case wifi
    /// Всегда, в том числе в сотовой сети.
    case always

    var id: String { rawValue }

    var title: String {
        switch self {
        case .never: return "Никогда"
        case .wifi: return "Только Wi-Fi"
        case .always: return "Всегда"
        }
    }

    /// Ключ UserDefaults. Один на приложение: отсюда его берёт и @AppStorage пикера в
    /// «Профиль → Медиа» (SettingsView.mediaSection), и `current` ниже.
    static let storageKey = "media.videoAutoplay"

    /// Текущее значение. Умолчание — .wifi: трафик пользователя не наш, а на Wi-Fi
    /// оживающая лента ничего не стоит.
    static var current: VideoAutoplayMode {
        guard let raw = UserDefaults.standard.string(forKey: Self.storageKey),
              let mode = VideoAutoplayMode(rawValue: raw)
        else { return .wifi }
        return mode
    }
}

/// Пороги автопроигрывания. Вынесены в одно место: их подбирают глазами на устройстве.
enum InlineVideoLimits {
    /// Тяжелее — не трогаем: у нас нет транскода, оригинал может быть гигабайтным.
    static let maxBytes: Int64 = 8 * 1024 * 1024
    /// Длиннее — это уже «фильм», его смотрят осознанно, по тапу.
    static let maxDurationSec = 30
    /// Старт только когда плитка видна почти целиком.
    static let startVisibleFraction: CGFloat = 0.7
    /// Остановка с запасом (гистерезис): иначе плитка на границе мигала бы старт/стоп.
    static let stopVisibleFraction: CGFloat = 0.35
    /// Сколько плееров живёт одновременно.
    static let maxActive = 2
    /// Как часто пересчитываем видимость. 0.25 с — глазу хватает, процессору не больно.
    static let tickInterval: TimeInterval = 0.25
    /// Смещение плитки между тиками, выше которого считаем, что лента ещё едет.
    static let scrollSettledDelta: CGFloat = 6
    /// Сколько секунд видео буферизуем вперёд — потолок паразитного трафика.
    static let forwardBufferSec: Double = 4
}

extension MessageAttachment {
    /// Годится ли вложение для автопроигрывания в ленте. Метаданные обязаны быть известны:
    /// без длительности и размера мы бы качали кота в мешке (транскода у нас нет, и
    /// «короткое видео» может оказаться получасовым оригиналом с камеры).
    var isInlineAutoplayable: Bool {
        // Секретка по своему url отдаёт ШИФРТЕКСТ — играть его нечем, а расшифровывать
        // весь файл ради автоплея тем более нельзя.
        guard type == "VIDEO", secretNonce == nil else { return false }
        guard let size, size > 0, size <= InlineVideoLimits.maxBytes else { return false }
        guard let durationSec, durationSec > 0, durationSec <= InlineVideoLimits.maxDurationSec else {
            return false
        }
        return true
    }
}

// MARK: - Сеть

/// Наблюдатель за типом сети — один на приложение. Нужен ровно для одного вопроса:
/// «сеть сейчас бесплатная?». NWPathMonitor отвечает честнее, чем «есть ли Wi-Fi»:
/// раздача с телефона и роуминг помечаются expensive/constrained и тоже не считаются.
final class InlineVideoNetwork: @unchecked Sendable {

    static let shared = InlineVideoNetwork()

    private let monitor = NWPathMonitor()
    private let queue = DispatchQueue(label: "org.eblusha.inline-video-network")
    /// Значение читают из главного потока, пишет — очередь монитора: нужен замок.
    private let state = Mutex<Bool>(false)
    private var started = false

    private init() {}

    /// Запускается лениво: пока в ленте нет ни одного видео, монитор не нужен.
    func startIfNeeded() {
        guard !started else { return }
        started = true
        monitor.pathUpdateHandler = { [weak self] path in
            let free = path.status == .satisfied && !path.isExpensive && !path.isConstrained
            self?.state.withLock { $0 = free }
        }
        monitor.start(queue: queue)
    }

    /// Сеть, за которую пользователь не платит помегабайтно.
    var isUnmetered: Bool { state.withLock { $0 } }
}

// MARK: - Координатор

/// Кто из плиток играет. @MainActor: координатор трогает UIView'шки плиток, а те
/// наследуют изоляцию от UIKit. Все его входы и так с главного потока (didMoveToWindow
/// вью и таймер на главном runloop) — поэтому в колбэках достаточно assumeIsolated,
/// без асинхронных прыжков, которые растянули бы решение «что играет» на лишний кадр.
@MainActor
final class InlineVideoCoordinator {

    static let shared = InlineVideoCoordinator()

    /// Стоп-кран для случаев, когда лента формально видна, но автоплей неуместен
    /// (например, идёт запись голосового). Просмотрщик и модальные листы ловятся сами —
    /// плитка под ними считается невидимой.
    var isSuspended = false {
        didSet {
            guard isSuspended != oldValue else { return }
            if isSuspended { stopAll() }
        }
    }

    /// Слабая ссылка на вью + её прошлое положение: по разнице между тиками понимаем,
    /// что лента ещё едет под пальцем, и не начинаем проигрывание на ходу.
    private final class Entry {
        weak var view: InlineVideoHostView?
        var lastMidY: CGFloat = .nan
        init(_ view: InlineVideoHostView) { self.view = view }
    }

    private var entries: [Entry] = []
    private var timer: Timer?
    private var backgroundObserver: NSObjectProtocol?

    private init() {
        // Уход в фон глушит звук сам, но держать декодер живым смысла нет.
        // queue: .main — колбэк гарантированно на главном потоке, поэтому assumeIsolated
        // здесь честен (@Sendable-замыкание само по себе изоляции не наследует).
        backgroundObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.didEnterBackgroundNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.stopAll()
            }
        }
    }

    func register(_ view: InlineVideoHostView) {
        InlineVideoNetwork.shared.startIfNeeded()
        guard !entries.contains(where: { $0.view === view }) else { return }
        entries.append(Entry(view))
        startTimerIfNeeded()
    }

    func unregister(_ view: InlineVideoHostView) {
        entries.removeAll { $0.view === view || $0.view == nil }
        if entries.isEmpty { stopTimer() }
    }

    private func startTimerIfNeeded() {
        guard timer == nil else { return }
        // .common: в default-режиме таймер замирает ровно во время прокрутки — то есть
        // именно тогда, когда решение «что играет» и нужно пересчитывать.
        // Таймер главного runloop'а зовёт блок на главном потоке — assumeIsolated не врёт.
        let created = Timer(timeInterval: InlineVideoLimits.tickInterval, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.tick()
            }
        }
        RunLoop.main.add(created, forMode: .common)
        timer = created
    }

    private func stopTimer() {
        timer?.invalidate()
        timer = nil
    }

    private func stopAll() {
        for entry in entries { entry.view?.deactivate() }
    }

    /// Один проход: померить видимость всех зарегистрированных плиток и раздать роли.
    private func tick() {
        entries.removeAll { $0.view == nil }
        guard !entries.isEmpty else {
            stopTimer()
            return
        }
        guard !isSuspended, Self.autoplayAllowedNow() else {
            stopAll()
            return
        }

        var scrolling = false
        var ranked: [(entry: Entry, fraction: CGFloat, distance: CGFloat, measuredBefore: Bool)] = []
        for entry in entries {
            guard let view = entry.view else { continue }
            let measured = view.measureVisibility()
            // Прошлое положение известно — значит про эту плитку мы можем судить, едет
            // лента или стоит. Плитку, которую видим впервые, не запускаем до следующего
            // тика: иначе на быстрой прокрутке стартовал бы каждый пролетевший ролик.
            let measuredBefore = entry.lastMidY.isFinite
            if measuredBefore, abs(measured.midY - entry.lastMidY) > InlineVideoLimits.scrollSettledDelta {
                scrolling = true
            }
            entry.lastMidY = measured.midY
            ranked.append((entry, measured.fraction, measured.distanceFromCenter, measuredBefore))
        }
        // Ближе к центру экрана — важнее: именно туда смотрят.
        ranked.sort { $0.distance < $1.distance }

        var active = 0
        for item in ranked {
            guard let view = item.entry.view else { continue }
            // Уже играющей плитке хватает половинного порога (гистерезис), новой — полного,
            // и только на остановившейся ленте: старт плеера во время прокрутки — это
            // рывок картинки и лишний декодер на каждый пролетевший ролик.
            let keep = view.isActive && item.fraction >= InlineVideoLimits.stopVisibleFraction
            let start = !view.isActive
                && !scrolling
                && item.measuredBefore
                && item.fraction >= InlineVideoLimits.startVisibleFraction
            if view.isEligible, keep || start, active < InlineVideoLimits.maxActive {
                view.activate()
                active += 1
            } else {
                view.deactivate()
            }
        }
    }

    /// Общие запреты, не зависящие от конкретной плитки.
    private static func autoplayAllowedNow() -> Bool {
        guard UIApplication.shared.applicationState == .active else { return false }
        // В звонке аудиосессией владеет CallManager, и лишний декодер там ни к чему.
        guard AppContainer.shared.callManager.phase == .idle else { return false }
        switch VideoAutoplayMode.current {
        case .never: return false
        case .always: return true
        case .wifi: return InlineVideoNetwork.shared.isUnmetered
        }
    }
}

// MARK: - Вью с плеером

/// Слой автоплея одной плитки. Владеет AVPlayer'ом только пока играет: ушла с экрана —
/// плеер и его буфер освобождаются целиком.
final class InlineVideoHostView: UIView {

    /// Сам слой берём готовый (PlayerLayerView, Features/PhotoViewer/VideoPage.swift):
    /// смысл тот же — видео без хрома AVKit.
    private let layerView = PlayerLayerView()

    private(set) var isActive = false
    /// Плитка в принципе годна для автоплея (решает вызывающий по метаданным).
    private(set) var isEligible = false

    /// Плитка сменилась на другую (ячейка ленты переиспользована) — плеер пересоздаётся.
    private var source: URL?
    private var player: AVPlayer?
    private var cancellables: Set<AnyCancellable> = []
    private var reportedPlaying = false

    /// Наверх: «первый кадр показан» / «видео убрано» — по этому плитка гасит постер.
    var onPlayingChanged: ((Bool) -> Void)?

    override init(frame: CGRect) {
        super.init(frame: frame)
        setup()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        setup()
    }

    private func setup() {
        // Жестов вью не добавляет вовсе: тап по плитке остаётся за SwiftUI (открыть
        // просмотрщик со звуком), а арбитраж жестов ленты не должен ничего замечать.
        isUserInteractionEnabled = false
        backgroundColor = .clear
        layerView.playerLayer.videoGravity = .resizeAspectFill
        addSubview(layerView)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        layerView.frame = bounds
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window == nil {
            InlineVideoCoordinator.shared.unregister(self)
            deactivate()
        } else {
            InlineVideoCoordinator.shared.register(self)
        }
    }

    // MARK: Настройка снаружи

    func configure(url: URL?, eligible: Bool) {
        isEligible = eligible
        if source != url {
            source = url
            // Тот же UIView отдали другому сообщению — прошлое видео должно исчезнуть
            // немедленно, иначе в плитке играет чужой ролик.
            deactivate()
        }
        if !eligible { deactivate() }
    }

    /// SwiftUI сняла вью с экрана (dismantleUIView).
    func tearDownForReuse() {
        InlineVideoCoordinator.shared.unregister(self)
        deactivate()
    }

    // MARK: Измерение видимости

    struct Visibility {
        var fraction: CGFloat
        var midY: CGFloat
        var distanceFromCenter: CGFloat
    }

    /// Какая доля плитки реально видна в окне. Ноль означает «играть нельзя»: плитка за
    /// краем экрана, схлопнута в точку или накрыта модальным экраном (просмотрщик, лист).
    func measureVisibility() -> Visibility {
        let none = Visibility(fraction: 0, midY: .nan, distanceFromCenter: .greatestFiniteMagnitude)
        guard let window, bounds.width > 1, bounds.height > 1, !isCoveredByModal(in: window) else {
            return none
        }
        let frame = convert(bounds, to: window)
        guard frame.width > 1, frame.height > 1 else { return none }
        let visible = frame.intersection(window.bounds)
        guard !visible.isNull, visible.width > 0, visible.height > 0 else {
            return Visibility(fraction: 0, midY: frame.midY, distanceFromCenter: .greatestFiniteMagnitude)
        }
        let fraction = (visible.width * visible.height) / (frame.width * frame.height)
        return Visibility(
            fraction: fraction,
            midY: frame.midY,
            distanceFromCenter: abs(frame.midY - window.bounds.midY)
        )
    }

    /// Поверх чата подняли модальный экран (галерея, QuickLook, лист действий)? Тогда
    /// плитки не видно, даже если геометрически она на месте. Проверка честная: ищем
    /// самый верхний представленный контроллер и смотрим, лежим ли мы внутри него —
    /// если чат сам открыт модально, он этой проверкой не глушится.
    private func isCoveredByModal(in window: UIWindow) -> Bool {
        var topmost: UIViewController?
        var current = window.rootViewController
        while let presented = current?.presentedViewController {
            topmost = presented
            current = presented
        }
        guard let topmost else { return false }
        return !isDescendant(of: topmost.view)
    }

    // MARK: Плеер

    func activate() {
        guard isEligible, let source, window != nil else { return }
        isActive = true
        if let player {
            if player.timeControlStatus == .paused { player.play() }
            return
        }
        Self.keepOtherAudioPlaying()
        let item = AVPlayerItem(url: source)
        // Потолок паразитного трафика: вперёд буферим считанные секунды.
        item.preferredForwardBufferDuration = InlineVideoLimits.forwardBufferSec
        let created = AVPlayer(playerItem: item)
        // Звука в ленте нет ни при каких условиях.
        created.isMuted = true
        // Конец ролика обрабатываем сами (петля), поэтому системное «встать в паузу» снимаем.
        created.actionAtItemEnd = .none
        created.preventsDisplaySleepDuringVideoPlayback = false
        layerView.playerLayer.player = created
        player = created
        observe(item: item, player: created)
        created.play()
    }

    /// Чужая музыка не должна обрываться из-за плитки в ленте. Одного `isMuted` мало:
    /// сессия категории по умолчанию (.soloAmbient) при первом же запуске плеера
    /// становится активной и глушит всё остальное. Переводим её в .ambient — она мешается
    /// с чужим звуком и никогда никого не прерывает.
    ///
    /// Трогаем ТОЛЬКО нетронутую категорию: .playback ставят просмотрщик видео и плеер
    /// голосовых, .playAndRecord — звонок и запись; перебить их значило бы оборвать звук
    /// там, где он нужен по делу.
    private static func keepOtherAudioPlaying() {
        let session = AVAudioSession.sharedInstance()
        guard session.category == .soloAmbient else { return }
        // setActive не зовём: активацией займётся сам плеер, и с .ambient она безобидна.
        try? session.setCategory(.ambient, options: [.mixWithOthers])
    }

    func deactivate() {
        isActive = false
        // Ничего не заводили — и разбирать нечего: координатор зовёт нас на каждом тике,
        // а трогать слой плеера впустую четыре раза в секунду незачем.
        guard player != nil else {
            report(false)
            return
        }
        player?.pause()
        player?.replaceCurrentItem(with: nil)
        player = nil
        layerView.playerLayer.player = nil
        cancellables.removeAll()
        report(false)
    }

    private func observe(item: AVPlayerItem, player: AVPlayer) {
        // Постер убираем ТОЛЬКО когда слой реально готов показать кадр: иначе на стыке
        // мелькает чёрный прямоугольник.
        layerView.playerLayer.publisher(for: \.isReadyForDisplay)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] ready in
                guard let self else { return }
                self.report(ready && self.isActive)
            }
            .store(in: &cancellables)

        // Аудиодорожку глушим не только громкостью: живая дорожка заставляет систему
        // поднять аудиосессию приложения и обрывает чужую музыку, даже когда isMuted.
        item.publisher(for: \.tracks)
            .receive(on: DispatchQueue.main)
            .sink { tracks in
                for track in tracks where track.assetTrack?.mediaType == AVMediaType.audio {
                    track.isEnabled = false
                }
            }
            .store(in: &cancellables)

        // Петля: короткое видео крутится, пока плитка на экране.
        NotificationCenter.default.publisher(for: .AVPlayerItemDidPlayToEndTime, object: item)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in
                guard let self, self.isActive else { return }
                player.seek(to: .zero)
                player.play()
            }
            .store(in: &cancellables)

        // Битый или неподдерживаемый контейнер: молча возвращаемся к постеру, чтобы не
        // держать мёртвый плеер и не пробовать его заново на каждом тике.
        item.publisher(for: \.status)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] status in
                guard status == .failed else { return }
                // Разбирать плеер прямо из его же подписки нельзя: deactivate() рвёт
                // набор подписок, из которого нас сейчас вызвали. Уходим на следующий
                // прогон главной очереди.
                DispatchQueue.main.async {
                    guard let self else { return }
                    self.isEligible = false
                    self.deactivate()
                }
            }
            .store(in: &cancellables)
    }

    /// Наверх сообщаем только смену состояния и только асинхронно: колбэк меняет @State
    /// плитки, а позвать его могут прямо из updateUIView (изменение состояния в проходе
    /// отрисовки SwiftUI не прощает).
    private func report(_ playing: Bool) {
        guard reportedPlaying != playing else { return }
        reportedPlaying = playing
        let callback = onPlayingChanged
        DispatchQueue.main.async { callback?(playing) }
    }
}

/// Мост в SwiftUI. Ничего не решает сам: только отдаёт вью источник и признак годности,
/// а «играть или нет» скажет координатор.
struct InlineVideoLayer: UIViewRepresentable {

    let url: URL?
    let eligible: Bool
    let onPlayingChanged: (Bool) -> Void

    func makeUIView(context: Context) -> InlineVideoHostView {
        let view = InlineVideoHostView()
        view.onPlayingChanged = onPlayingChanged
        view.configure(url: url, eligible: eligible)
        return view
    }

    func updateUIView(_ uiView: InlineVideoHostView, context: Context) {
        uiView.onPlayingChanged = onPlayingChanged
        uiView.configure(url: url, eligible: eligible)
    }

    static func dismantleUIView(_ uiView: InlineVideoHostView, coordinator: ()) {
        uiView.tearDownForReuse()
    }
}
