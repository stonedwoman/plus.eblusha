import AVFoundation
import Combine
import SwiftUI
import UIKit

// Страница галереи с видео (контракт: файл 5 просмотрщика). Видео живёт в ТОМ ЖЕ пейджере,
// что и фото: тем же горизонтальным свайпом с кадра переходишь на видео, тем же свайпом
// вниз закрываешь, и закрытие так же летит в плитку чата. Всё общее делает база
// PhotoViewerPage (PhotoViewerController.swift) — здесь только плеер и его кнопки.
//
// Почему поток, а не «скачать и показать»: прокси /api/files отвечает Accept-Ranges и 206,
// поэтому AVPlayer тянет байты по мере воспроизведения — 40-мегабайтное видео начинает
// играть сразу, а не после нескольких секунд чёрного экрана. Секретное видео стримить
// нельзя в принципе: по его url лежит ШИФРТЕКСТ, и оно сначала расшифровывается в файл
// (store.videoSource), ровно как секретное голосовое в SecretVoiceMessagePlayer.

final class VideoPageController: PhotoViewerPage {

    // MARK: - Константы

    /// Высота полосы времени и её отступ от края кадра.
    private static let controlsHeight: CGFloat = 36
    private static let controlsMargin: CGFloat = 8
    /// Кнопка Play: крупнее плиточной (54 pt в ленте) — на весь экран она читается хуже.
    private static let playButtonSide: CGFloat = 64
    private static let fadeDuration: TimeInterval = 0.2
    private static let posterFadeDuration: TimeInterval = 0.15
    /// Пропорции, когда сервер не отдал width/height: 16/9 — та же догадка, что у плитки
    /// видео в ленте (MessageAttachment.videoDisplaySize). Настоящий размер приедет от
    /// плеера (presentationSize) и перекроет её.
    private static let fallbackAspect = CGSize(width: 16, height: 9)
    private static let glyphConfig = UIImage.SymbolConfiguration(pointSize: 26, weight: .bold)

    // MARK: - Зависимости и настройки

    /// Запас снизу под хром просмотрщика (панель действий и лента миниатюр) — его знает
    /// только контроллер, поэтому он же его и ставит.
    var bottomChromeInset: CGFloat = 48

    private let store: PhotoViewerImageStore
    private let playback = VideoStreamPlayback()

    // MARK: - Вью

    /// Цель transform свайпа-закрытия: страница целиком, кадр внутри неё по центру.
    private let content = UIView()
    private let posterView = UIImageView()
    private let playerView = PlayerLayerView()
    private let controls = UIView()
    private let positionLabel = UILabel()
    private let durationLabel = UILabel()
    private let slider = UISlider()
    private let playButton = UIButton(type: .custom)
    private let spinner = UIActivityIndicatorView(style: .large)
    private let failedBadge = UIView()
    private let failedLabel = UILabel()
    private let singleTap = UITapGestureRecognizer()

    // MARK: - Состояние

    /// Рамка кадра внутри content: из неё стартует полёт при закрытии.
    private var videoRect: CGRect = .zero
    /// Пропорции, по которым вписан кадр: метаданные вложения → постер → настоящий размер
    /// от плеера (последний точнее всего).
    private var aspect: CGSize?
    /// Источник уже просили (у секретного это расшифровка — второй раз не запускаем).
    private var didRequestSource = false
    private var didLoadSource = false
    private var sourceFailed = false
    private var isCurrent = false
    /// Хром просмотрщика виден (тап по кадру его переключает).
    private var chromeVisible = false
    /// Страница уходит с экрана — прятать вообще всё.
    private var forceHidden = false
    /// Уже применённые непрозрачности полосы и кнопки — см. applyControlsVisibility.
    /// Начальные значения повторяют разметку: полоса спрятана, кнопка Play видна.
    private var appliedBarAlpha: CGFloat = 0
    private var appliedButtonAlpha: CGFloat = 1
    /// На кнопке сейчас «пауза». Держим флагом, чтобы не пересобирать картинку кнопки
    /// пять раз в секунду: позиция приходит каждые 0.2 с, а иконка меняется редко.
    private var playButtonShowsPause = false
    private var cancellables: Set<AnyCancellable> = []

    // MARK: - Инициализация

    init(index: Int, item: PhotoViewerItem, store: PhotoViewerImageStore) {
        self.store = store
        self.aspect = item.aspectSize
        super.init(index: index, item: item)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("Страницы просмотрщика создаются только кодом")
    }

    override func loadView() {
        let container = PhotoViewerPageContainer()
        container.backgroundColor = .clear
        container.content = content
        container.addSubview(content)
        // Контейнер раздаёт content размер через bounds + center (frame при transform не
        // определён), а нам после этого надо заново вписать кадр и переложить кнопки.
        container.onLayout = { [weak self] in self?.layoutContent() }
        view = container
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        content.backgroundColor = .clear

        // Постер лежит под слоем плеера и гаснет, когда тот готов показать первый кадр:
        // без него страница была бы чёрной всё время буферизации, а полёту из плитки было
        // бы нечем лететь.
        posterView.contentMode = .scaleAspectFill
        posterView.clipsToBounds = true
        posterView.backgroundColor = UIColor(Eb.surface300)
        content.addSubview(posterView)

        playerView.backgroundColor = .clear
        playerView.playerLayer.videoGravity = .resizeAspect
        playerView.playerLayer.player = playback.player
        content.addSubview(playerView)

        spinner.color = .white
        spinner.hidesWhenStopped = true
        spinner.isUserInteractionEnabled = false
        // Раскладка здесь ручная (frame), поэтому спиннеру нужен собственный размер —
        // без sizeToFit он остался бы нулевым и невидимым.
        spinner.sizeToFit()
        content.addSubview(spinner)

        failedBadge.backgroundColor = UIColor.black.withAlphaComponent(0.55)
        failedBadge.layer.cornerRadius = 10
        failedBadge.layer.cornerCurve = .continuous
        failedBadge.isUserInteractionEnabled = false
        failedBadge.isHidden = true
        failedLabel.font = .systemFont(ofSize: 14, weight: .medium)
        failedLabel.textColor = UIColor.white.withAlphaComponent(0.9)
        failedLabel.textAlignment = .center
        failedLabel.numberOfLines = 2
        failedBadge.addSubview(failedLabel)
        content.addSubview(failedBadge)

        playButton.backgroundColor = UIColor.black.withAlphaComponent(0.45)
        playButton.tintColor = .white
        playButton.layer.cornerRadius = Self.playButtonSide / 2
        playButton.layer.borderWidth = 1
        playButton.layer.borderColor = UIColor.white.withAlphaComponent(0.25).cgColor
        playButton.setImage(UIImage(systemName: "play.fill", withConfiguration: Self.glyphConfig), for: .normal)
        playButton.addTarget(self, action: #selector(handlePlayTap), for: .touchUpInside)
        playButton.accessibilityLabel = "Воспроизвести"
        content.addSubview(playButton)

        setUpControls()

        // Тап по кадру переключает хром — как у фото. Свои кнопки тап не получают (см.
        // gestureRecognizer(_:shouldReceive:)), иначе распознаватель отменял бы их касание.
        singleTap.addTarget(self, action: #selector(handleSingleTap))
        singleTap.delegate = self
        content.addGestureRecognizer(singleTap)

        // Первый показанный кадр — сигнал убрать постер: между ними не должно быть черноты.
        playerView.playerLayer.publisher(for: \.isReadyForDisplay)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] ready in
                guard let self, ready, self.posterView.alpha > 0 else { return }
                UIView.animate(withDuration: Self.posterFadeDuration) { self.posterView.alpha = 0 }
            }
            .store(in: &cancellables)

        playback.onChange = { [weak self] in self?.syncFromPlayback() }
        syncFromPlayback()
    }

    private func setUpControls() {
        controls.backgroundColor = UIColor.black.withAlphaComponent(0.4)
        controls.layer.cornerRadius = 10
        controls.layer.cornerCurve = .continuous
        controls.alpha = 0
        content.addSubview(controls)

        for label in [positionLabel, durationLabel] {
            label.font = .monospacedDigitSystemFont(ofSize: 12, weight: .medium)
            label.textColor = .white
            controls.addSubview(label)
        }
        positionLabel.textAlignment = .left
        durationLabel.textAlignment = .right

        slider.minimumTrackTintColor = .white
        slider.maximumTrackTintColor = UIColor.white.withAlphaComponent(0.3)
        // Свой бегунок: системный великоват для полосы в 36 pt и перекрывает трек.
        slider.setThumbImage(Self.thumbImage(diameter: 10), for: .normal)
        slider.setThumbImage(Self.thumbImage(diameter: 14), for: .highlighted)
        slider.addTarget(self, action: #selector(handleScrubBegan), for: [.touchDown])
        slider.addTarget(self, action: #selector(handleScrubChanged), for: [.valueChanged])
        slider.addTarget(
            self,
            action: #selector(handleScrubEnded),
            for: [.touchUpInside, .touchUpOutside, .touchCancel]
        )
        slider.accessibilityLabel = "Позиция видео"
        controls.addSubview(slider)
    }

    /// Белый круг для бегунка — рисуем сами, чтобы не тащить ассет.
    private static func thumbImage(diameter: CGFloat) -> UIImage {
        let size = CGSize(width: diameter, height: diameter)
        return UIGraphicsImageRenderer(size: size).image { context in
            UIColor.white.setFill()
            context.cgContext.fillEllipse(in: CGRect(origin: .zero, size: size))
        }
    }

    // MARK: - Геометрия

    private var pixelScale: CGFloat {
        max(view.window?.screen.scale ?? traitCollection.displayScale, 1)
    }

    private func layoutContent() {
        let box = content.bounds.size
        guard box.width > 0, box.height > 0 else { return }
        // Та же функция вписывания, что у фото, — кадр видео и кадр картинки занимают на
        // экране одно и то же место, и переход между страницами не дёргает геометрию.
        let fitted = ZoomableImageView.fittedSize(
            aspect: aspect ?? Self.fallbackAspect, in: box, pixelScale: pixelScale
        )
        videoRect = CGRect(
            x: ((box.width - fitted.width) / 2).rounded(),
            y: ((box.height - fitted.height) / 2).rounded(),
            width: fitted.width,
            height: fitted.height
        )
        posterView.frame = videoRect
        playerView.frame = videoRect
        spinner.center = CGPoint(x: videoRect.midX, y: videoRect.midY)
        playButton.bounds = CGRect(
            origin: .zero,
            size: CGSize(width: Self.playButtonSide, height: Self.playButtonSide)
        )
        playButton.center = CGPoint(x: videoRect.midX, y: videoRect.midY)

        let badgeWidth = min(box.width - 48, 320)
        failedBadge.frame = CGRect(
            x: ((box.width - badgeWidth) / 2).rounded(),
            y: (videoRect.midY + Self.playButtonSide).rounded(),
            width: badgeWidth,
            height: 44
        )
        failedLabel.frame = failedBadge.bounds.insetBy(dx: 12, dy: 6)

        layoutControls(in: box)
    }

    /// Полоса времени живёт у нижнего края кадра, но не заезжает под хром просмотрщика:
    /// у портретного видео кадр доходит почти до низа экрана, где стоит панель действий.
    private func layoutControls(in box: CGSize) {
        let reserve = bottomChromeInset + view.safeAreaInsets.bottom + Self.controlsMargin
        let bottom = max(
            min(videoRect.maxY - Self.controlsMargin, box.height - reserve),
            Self.controlsHeight + Self.controlsMargin
        )
        let width = max(160, min(videoRect.width - 2 * Self.controlsMargin, box.width - 32))
        controls.frame = CGRect(
            x: ((box.width - width) / 2).rounded(),
            y: (bottom - Self.controlsHeight).rounded(),
            width: width,
            height: Self.controlsHeight
        )
        let labelWidth: CGFloat = 42
        positionLabel.frame = CGRect(x: 8, y: 0, width: labelWidth, height: Self.controlsHeight)
        durationLabel.frame = CGRect(
            x: controls.bounds.width - labelWidth - 8,
            y: 0,
            width: labelWidth,
            height: Self.controlsHeight
        )
        slider.frame = CGRect(
            x: positionLabel.frame.maxX + 6,
            y: 0,
            width: max(0, durationLabel.frame.minX - positionLabel.frame.maxX - 12),
            height: Self.controlsHeight
        )
    }

    // MARK: - Контракт страницы

    override var animatedContent: UIView { content }

    /// Копии для полёта отдаём постер: свой кадр из AVPlayerLayer снять нельзя (слой не
    /// рисуется в контекст), а в плитке чата лежит ровно этот же постер — стык не виден.
    override var flightImage: UIImage? { posterView.image }

    override var contentFrameInWindow: CGRect? {
        guard view.window != nil, videoRect.width > 1, videoRect.height > 1 else { return nil }
        return content.convert(videoRect, to: nil)
    }

    override func apply(thumb: UIImage?, full: UIImage?, state: PhotoViewerLoadState) {
        let poster = full ?? thumb
        guard poster !== posterView.image else { return }
        posterView.image = poster
        // Пропорции постера лучше догадки 16/9, когда метаданных у вложения нет.
        if aspect == nil, let poster, poster.size.width > 0, poster.size.height > 0 {
            aspect = poster.size
            view.setNeedsLayout()
        }
        updateOverlays()
    }

    override func didBecomeCurrent() {
        guard !isCurrent, !forceHidden else { return }
        isCurrent = true
        ensureSource()
        // Стартуем сами, как только страница стала центральной: в плитку видео тыкают
        // чтобы смотреть, а не чтобы нажать Play второй раз.
        playback.play()
        syncFromPlayback()
    }

    override func didResignCurrent() {
        guard isCurrent else { return }
        isCurrent = false
        // Пролистнули дальше — звук обязан замолчать, иначе слышно два трека. Позиция
        // сохраняется: вернёшься на страницу и продолжишь с того же места.
        playback.pause()
        syncFromPlayback()
    }

    override func prepareForDismiss() {
        isCurrent = false
        forceHidden = true
        playback.pause()
        // Анимированно: хром просмотрщика гаснет за 0.2 с, и полоса времени обязана уйти
        // вместе с ним, а не пропасть кадром раньше.
        applyControlsVisibility(animated: true)
    }

    override func setControlsVisible(_ visible: Bool, animated: Bool) {
        chromeVisible = visible
        applyControlsVisibility(animated: animated)
    }

    override func gesturesEnabledDidChange() {
        // Жесты гасит контроллер на время свайпа-закрытия: тогда прячем и свои кнопки —
        // они плыли бы вместе с кадром.
        applyControlsVisibility(animated: true)
    }

    override func ignoresDismissPan(at point: CGPoint) -> Bool {
        guard controls.alpha > 0.01 else { return false }
        // Точку переводим через convert: у content во время догорающей пружины возврата
        // может быть transform, и голое вычитание origin врало бы.
        let local = content.convert(point, from: view)
        return controls.frame.insetBy(dx: -8, dy: -8).contains(local)
    }

    // MARK: - Источник

    /// Источник просим один раз: у обычного видео это готовый потоковый URL, у секретного —
    /// расшифровка в файл, и повторять её на каждый тап нельзя.
    private func ensureSource() {
        guard !didRequestSource else { return }
        didRequestSource = true
        Task { @MainActor [weak self] in
            guard let self else { return }
            let source = await self.store.videoSource(for: self.item)
            guard let source else {
                self.sourceFailed = true
                self.updateOverlays()
                return
            }
            self.didLoadSource = true
            self.playback.load(url: source)
            self.syncFromPlayback()
        }
    }

    // MARK: - Кнопки

    @objc private func handleSingleTap() {
        onSingleTap?()
    }

    @objc private func handlePlayTap() {
        // Нажать Play могли до того, как приехал источник (секретное ещё расшифровывается) —
        // плеер это запомнит и сыграет сам, как только сможет.
        ensureSource()
        playback.toggle()
        syncFromPlayback()
    }

    @objc private func handleScrubBegan() {
        playback.isScrubbing = true
    }

    @objc private func handleScrubChanged() {
        // Пока палец на бегунке, время показываем сразу, не дожидаясь плеера.
        let duration = playback.snapshot.durationSec
        positionLabel.text = formatRecordTime(Int64(Double(slider.value) * duration * 1000))
    }

    @objc private func handleScrubEnded() {
        playback.isScrubbing = false
        playback.seek(toFraction: Double(slider.value))
    }

    // MARK: - Синхронизация с плеером

    private func syncFromPlayback() {
        let snapshot = playback.snapshot
        // Настоящий размер кадра важнее метаданных: у многих видео width/height нет вовсе,
        // и без этого кадр так и остался бы вписанным в догадку 16/9.
        if snapshot.naturalSize.width > 0,
           !Self.aspectsClose(snapshot.naturalSize, aspect) {
            aspect = snapshot.naturalSize
            view.setNeedsLayout()
        }
        let duration = snapshot.durationSec
        if !playback.isScrubbing {
            slider.value = duration > 0 ? Float(min(max(snapshot.positionSec / duration, 0), 1)) : 0
            positionLabel.text = formatRecordTime(Int64(max(snapshot.positionSec, 0) * 1000))
        }
        durationLabel.text = formatRecordTime(Int64(max(duration, 0) * 1000))
        slider.isEnabled = duration > 0
        if snapshot.playing != playButtonShowsPause {
            playButtonShowsPause = snapshot.playing
            let icon = snapshot.playing ? "pause.fill" : "play.fill"
            playButton.setImage(UIImage(systemName: icon, withConfiguration: Self.glyphConfig), for: .normal)
            playButton.accessibilityLabel = snapshot.playing ? "Пауза" : "Воспроизвести"
        }
        updateOverlays()
        applyControlsVisibility(animated: false)
    }

    private func updateOverlays() {
        let snapshot = playback.snapshot
        let failed = sourceFailed || snapshot.failed
        // Спиннер — только когда действительно нечего показать: идёт расшифровка/резолв
        // источника или плеер ждёт байтов из сети.
        let waiting = isCurrent && !failed
            && (!didLoadSource || snapshot.waiting || (snapshot.playing && !snapshot.ready))
        if waiting { spinner.startAnimating() } else { spinner.stopAnimating() }
        failedBadge.isHidden = !failed
        failedLabel.text = (item.isSecret && sourceFailed)
            ? "Не удалось расшифровать видео"
            : "Не удалось воспроизвести видео"
        playButton.isHidden = failed
    }

    /// Полоса времени видна вместе с хромом, а кнопка Play — ещё и когда видео стоит:
    /// иначе на паузе со спрятанным хромом нечем его запустить.
    ///
    /// Повтор с теми же числами не делает НИЧЕГО: syncFromPlayback зовёт это на каждый тик
    /// позиции (пять раз в секунду), и голое присваивание alpha обрывало бы начатое
    /// затухание — хром прыгал бы в конец анимации посреди проявления.
    private func applyControlsVisibility(animated: Bool) {
        let suppressed = forceHidden || !gesturesEnabled
        let barAlpha: CGFloat = (!suppressed && chromeVisible) ? 1 : 0
        let buttonAlpha: CGFloat = (!suppressed && (chromeVisible || !playback.snapshot.playing)) ? 1 : 0
        guard barAlpha != appliedBarAlpha || buttonAlpha != appliedButtonAlpha else { return }
        appliedBarAlpha = barAlpha
        appliedButtonAlpha = buttonAlpha
        let apply = {
            self.controls.alpha = barAlpha
            self.playButton.alpha = buttonAlpha
        }
        guard animated else {
            apply()
            return
        }
        UIView.animate(
            withDuration: Self.fadeDuration,
            delay: 0,
            options: [.curveEaseOut, .beginFromCurrentState],
            animations: apply
        )
    }

    /// Пропорции считаем «теми же» при расхождении до 1 % — иначе округления присланного
    /// размера гоняли бы вписывание туда-сюда.
    private static func aspectsClose(_ a: CGSize, _ b: CGSize?) -> Bool {
        guard let b, a.height > 0, b.height > 0 else { return false }
        let ra = a.width / a.height
        let rb = b.width / b.height
        return abs(ra - rb) <= max(ra, rb) * 0.01
    }
}

// MARK: - Жесты

extension VideoPageController: UIGestureRecognizerDelegate {

    /// Тап по своим кнопкам — их дело: распознаватель на контейнере иначе отменил бы
    /// касание у UIButton и у UISlider (тот ведёт касание сам, без жеста).
    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        guard gestureRecognizer === singleTap else { return true }
        let point = touch.location(in: content)
        if playButton.alpha > 0.01, playButton.frame.contains(point) { return false }
        if controls.alpha > 0.01, controls.frame.insetBy(dx: -8, dy: -8).contains(point) { return false }
        return true
    }
}

// MARK: - Слой плеера

/// Вью, у которой слой — AVPlayerLayer: единственный способ показать видео без AVKit-плеера
/// с его собственным (и неотключаемым) хромом.
final class PlayerLayerView: UIView {
    override class var layerClass: AnyClass { AVPlayerLayer.self }
    /// Приведение безопасно: слой создаёт сама UIKit по layerClass выше.
    var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
}

// MARK: - Плеер

/// Плеер страницы видео. Намеренно НЕ @MainActor: deinit обязан снять периодический
/// наблюдатель времени и остановить звук, а изолированному классу из deinit это недоступно —
/// тот же приём, что у VoicePlayback в VoiceMessage.swift. Все колбэки приходят на главной
/// очереди (receive(on:) и queue: .main), поэтому страница трогает UIKit из главного потока.
final class VideoStreamPlayback {

    /// Что рисовать странице. Одна структура, а не пять @Published: страница обновляет
    /// кнопки и полосу целиком, и промежуточные состояния ей не нужны.
    struct Snapshot {
        var ready = false
        var failed = false
        var playing = false
        /// Плеер ждёт данных из сети — показываем спиннер.
        var waiting = false
        var finished = false
        var positionSec: Double = 0
        var durationSec: Double = 0
        var naturalSize: CGSize = .zero
    }

    private(set) var snapshot = Snapshot()
    /// Состояние изменилось — странице пора обновить кнопки и полосу.
    var onChange: (() -> Void)?
    /// Пользователь ведёт бегунок: позицию из плеера в это время не пишем.
    var isScrubbing = false

    let player = AVPlayer()

    private var item: AVPlayerItem?
    private var timeObserver: Any?
    private var cancellables: Set<AnyCancellable> = []
    /// Play нажали до появления источника — сыграть, как только он появится.
    private var playWhenReady = false

    init() {
        observePlayer()
    }

    deinit {
        // Наблюдатель времени снимается ДО смерти плеера — так требует AVFoundation.
        if let timeObserver { player.removeTimeObserver(timeObserver) }
        player.pause()
    }

    // MARK: Публичное API

    /// Первый и единственный источник страницы: поток по URL прокси либо локальный файл
    /// расшифрованного секретного видео.
    func load(url: URL) {
        guard item == nil else { return }
        let playerItem = AVPlayerItem(url: url)
        item = playerItem
        player.replaceCurrentItem(with: playerItem)
        observe(item: playerItem)
        // Позиция для полосы времени. 0.2 с достаточно: бегунок движется плавно, а будить
        // главный поток чаще смысла нет.
        timeObserver = player.addPeriodicTimeObserver(
            forInterval: CMTime(seconds: 0.2, preferredTimescale: 600),
            queue: .main
        ) { [weak self] time in
            guard let self, time.isNumeric, !self.isScrubbing else { return }
            self.snapshot.positionSec = max(0, time.seconds)
            self.onChange?()
        }
        if playWhenReady {
            playWhenReady = false
            startPlayback()
        }
    }

    func play() {
        activatePlaybackSession()
        guard item != nil else {
            // Источник ещё готовится (секретное видео расшифровывается) — запомним.
            playWhenReady = true
            onChange?()
            return
        }
        startPlayback()
    }

    func pause() {
        playWhenReady = false
        player.pause()
        snapshot.playing = false
        snapshot.waiting = false
        onChange?()
    }

    func toggle() {
        if snapshot.playing || playWhenReady {
            pause()
        } else {
            play()
        }
    }

    func seek(toFraction fraction: Double) {
        guard snapshot.durationSec > 0 else { return }
        let target = max(0, min(fraction, 1)) * snapshot.durationSec
        snapshot.positionSec = target
        snapshot.finished = false
        // Нулевые допуски: иначе плеер прыгает на ближайший ключевой кадр и бегунок
        // «не слушается» пальца.
        player.seek(
            to: CMTime(seconds: target, preferredTimescale: 600),
            toleranceBefore: .zero,
            toleranceAfter: .zero
        )
        onChange?()
    }

    // MARK: Внутреннее

    private func startPlayback() {
        // Доигравшее видео Play должен начинать заново, а не молчать.
        if snapshot.finished {
            snapshot.finished = false
            snapshot.positionSec = 0
            player.seek(to: .zero)
        }
        player.play()
        snapshot.playing = true
        onChange?()
    }

    private func observePlayer() {
        // timeControlStatus — единственный честный источник «играет / ждёт данных / стоит»:
        // rate врёт при буферизации (он уже 1, а картинка стоит).
        player.publisher(for: \.timeControlStatus)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] status in
                guard let self else { return }
                self.snapshot.playing = status != .paused
                self.snapshot.waiting = status == .waitingToPlayAtSpecifiedRate
                self.onChange?()
            }
            .store(in: &cancellables)

        // Уход в фон: без режима background audio система всё равно остановит звук, но
        // состояние кнопок должно сойтись с реальностью.
        NotificationCenter.default.publisher(for: UIApplication.didEnterBackgroundNotification)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in self?.pause() }
            .store(in: &cancellables)
    }

    private func observe(item: AVPlayerItem) {
        item.publisher(for: \.status)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] status in
                guard let self else { return }
                switch status {
                case .readyToPlay:
                    self.snapshot.ready = true
                    self.snapshot.failed = false
                case .failed:
                    self.snapshot.ready = false
                    self.snapshot.failed = true
                    self.snapshot.playing = false
                    self.playWhenReady = false
                default:
                    break
                }
                self.onChange?()
            }
            .store(in: &cancellables)

        // Длительность у потока приезжает не сразу и может уточниться.
        item.publisher(for: \.duration)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] duration in
                guard let self, duration.isNumeric, duration.seconds > 0 else { return }
                self.snapshot.durationSec = duration.seconds
                self.onChange?()
            }
            .store(in: &cancellables)

        // Настоящий размер кадра — для вписывания страницы (метаданных часто нет).
        item.publisher(for: \.presentationSize)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] size in
                guard let self, size.width > 0, size.height > 0 else { return }
                self.snapshot.naturalSize = size
                self.onChange?()
            }
            .store(in: &cancellables)

        NotificationCenter.default.publisher(for: .AVPlayerItemDidPlayToEndTime, object: item)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in
                guard let self else { return }
                self.player.pause()
                self.snapshot.finished = true
                self.snapshot.playing = false
                self.snapshot.waiting = false
                self.onChange?()
            }
            .store(in: &cancellables)
    }

    /// Категория .playback: видео слышно и с включённым беззвучным — так же ведут себя
    /// голосовые в этом проекте и медиа в вебе.
    private func activatePlaybackSession() {
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
        try? AVAudioSession.sharedInstance().setActive(true)
    }
}
