import UIKit

/// Одна страница просмотрщика фото: UIScrollView с зумом и двухслойный кадр внутри
/// (миниатюра снизу, полноразмер сверху). Файл самодостаточный — не знает ни про store,
/// ни про контроллер, ни про SwiftUI-хром; наружу отдаёт только колбэки и `isZoomed`.
///
/// Почему UIKit, а не SwiftUI-жесты: MagnifyGesture/DragGesture в этом проекте уже дважды
/// ломали прокрутку соседей (пейджер, лента). UIScrollView даёт pinch, панораму, инерцию
/// и bounce «из коробки», а пейджеру и свайпу-закрытию остаётся спросить `isZoomed`.
///
/// Почему два UIImageView в одном контейнере, а не подмена картинки: контейнер получает
/// размер «вписать» из aspect ещё ДО прихода полноразмера, оба слоя занимают ровно его
/// bounds, поэтому кроссфейд thumb → full — это только анимация alpha, без скачка
/// геометрии и без сброса зума, который пользователь мог начать на миниатюре.
final class ZoomableImageView: UIView {

    // MARK: - Публичный API (по контракту)

    /// Кадр перешёл в зум или вернулся из него. Дедуплицировано: зовётся только при смене
    /// состояния, поэтому контроллер может прямо в нём включать/выключать листание.
    var onZoomChanged: ((Bool) -> Void)?

    /// Одиночный тап по кадру (показать/скрыть хром). Срабатывает только после провала
    /// двойного тапа, поэтому приходит с задержкой ~0.3 с — цена отсутствия ложных тапов
    /// перед зумом.
    var onSingleTap: (() -> Void)?

    var isZoomed: Bool { scrollView.zoomScale > 1.01 }

    /// Все жесты страницы разом: pinch, панорама скролл-вью и оба тапа. Контроллер гасит
    /// их на время свайпа-закрытия — иначе второй палец мог бы начать зум прямо во время
    /// полёта кадра, а тап по уезжающему кадру дёргал бы хром. isEnabled = false у
    /// распознавателя ещё и отменяет уже идущий жест, так что «дожать» pinch не выйдет.
    var gesturesEnabled: Bool = true {
        didSet {
            guard gesturesEnabled != oldValue else { return }
            scrollView.pinchGestureRecognizer?.isEnabled = gesturesEnabled
            // Пока кадр вписан, pan и так не начинается (см. ZoomScrollView), но в зуме
            // он живой — без этого флага панорама продолжала бы двигать кадр под полётом.
            scrollView.panGestureRecognizer.isEnabled = gesturesEnabled
            doubleTap.isEnabled = gesturesEnabled
            singleTap.isEnabled = gesturesEnabled
        }
    }

    /// Текущая рамка ВИДИМОЙ части кадра в координатах окна — старт полёта при закрытии.
    /// В зуме контейнер больше экрана, и полёт «всего» увеличенного контейнера начинался бы
    /// с невидимых краёв далеко за bounds — поэтому берём пересечение с видимой областью
    /// скролл-вью (bounds учитывает contentOffset). Пока кадр вписан, пересечение — это
    /// он целиком. Конвертация через скролл-вью проходит всю цепочку transform'ов выше
    /// (сдвиг и масштаб свайпа-закрытия у контроллера), так что рамка — ровно то, что
    /// сейчас на экране. nil, пока вью не в окне или размер ещё не посчитан (не было layout).
    var imageFrameInWindow: CGRect? {
        guard window != nil, zoomContainer.bounds.width > 0, zoomContainer.bounds.height > 0 else {
            return nil
        }
        // frame контейнера — уже с учётом zoom-transform, в системе координат скролл-вью.
        let visible = zoomContainer.frame.intersection(scrollView.bounds)
        guard !visible.isNull, visible.width > 0, visible.height > 0 else {
            // Кадр целиком за пределами bounds (bounce на краю в зуме) — отдаём весь
            // контейнер, чтобы контроллер хоть от чего-то оттолкнулся, а не отменял полёт.
            return zoomContainer.convert(zoomContainer.bounds, to: nil)
        }
        return scrollView.convert(visible, to: nil)
    }

    // MARK: - Дополнение к контракту (internal, для контроллера)

    /// Что сейчас нарисовано: полноразмер, если есть, иначе миниатюра. Для снимка кадра в
    /// анимации открытия/закрытия.
    var currentImage: UIImage? { fullImageView.image ?? thumbImageView.image }

    var hasFullImage: Bool { fullImageView.image != nil }

    /// Размер кадра «вписано» при масштабе 1 (после layout). Контроллеру — чтобы посчитать
    /// целевую рамку для полёта из плитки, не дожидаясь появления на экране.
    var fittedContentSize: CGSize { zoomContainer.bounds.size }

    /// Чистая функция вписывания — та же, что использует вью. Контроллер может посчитать
    /// целевую рамку для стартовой анимации до первого layout.
    static func fittedSize(aspect: CGSize?, in box: CGSize, pixelScale: CGFloat = 1) -> CGSize {
        guard box.width > 0, box.height > 0 else { return .zero }
        guard let aspect, aspect.width > 0, aspect.height > 0 else { return box }
        let ratio = min(box.width / aspect.width, box.height / aspect.height)
        let scale = max(pixelScale, 1)
        // Округляем вниз до пиксельной сетки: кадр никогда не вылезает за box, а разница
        // в полпикселя между сторонами гасится contentMode .scaleAspectFit.
        return CGSize(
            width: (aspect.width * ratio * scale).rounded(.down) / scale,
            height: (aspect.height * ratio * scale).rounded(.down) / scale
        )
    }

    // MARK: - Состояние

    private static let doubleTapZoom: CGFloat = 2.5
    private static let crossfadeDuration: TimeInterval = 0.15
    private static let defaultFailedText = "Не удалось загрузить изображение"

    private let scrollView = ZoomScrollView()
    /// Зумируемое вью: UIScrollView масштабирует его transform, оба слоя лежат внутри.
    private let zoomContainer = ZoomContentView()
    private let thumbImageView = UIImageView()
    private let fullImageView = UIImageView()
    private let spinner = UIActivityIndicatorView(style: .large)
    private let failedBadge = UIView()
    private let failedLabel = UILabel()
    private let doubleTap = UITapGestureRecognizer()
    private let singleTap = UITapGestureRecognizer()

    /// Пропорции из width/height вложения — самый слабый источник, но единственный до
    /// прихода картинок.
    private var attachmentAspect: CGSize?
    /// Пропорции, по которым реально посчитан контейнер. Меняем только при ощутимом
    /// отличии (>1 %), чтобы приход full после thumb не двигал геометрию из-за округлений.
    private var appliedAspect: CGSize?

    /// Размер bounds на момент последнего вписывания: layoutSubviews зовётся часто
    /// (Auto Layout спиннера, старт анимаций), а пересчитывать надо только при смене размера.
    private var lastLayoutSize: CGSize = .zero

    /// Центр видимой области в долях контента (0…1). Обновляется на каждый скролл/зум и
    /// восстанавливается после поворота — так кадр не «уезжает» при смене ориентации.
    private var viewportAnchor = CGPoint(x: 0.5, y: 0.5)

    private var lastReportedZoomed = false
    private var isLoading = false
    private var failedText: String?
    /// Номер текущего кроссфейда: completion устаревшей анимации не должен прятать
    /// миниатюру, если полный кадр к тому моменту уже сняли (setFull(nil)).
    private var crossfadeGeneration = 0

    // MARK: - Инициализация

    override init(frame: CGRect) {
        super.init(frame: frame)
        setup()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        setup()
    }

    private func setup() {
        backgroundColor = .clear

        scrollView.delegate = self
        scrollView.backgroundColor = .clear
        scrollView.showsVerticalScrollIndicator = false
        scrollView.showsHorizontalScrollIndicator = false
        scrollView.decelerationRate = .fast
        // Безопасные зоны не должны сдвигать центрирование: кадр центрируем сами через
        // contentInset, а safe area учитывает хром поверх (SwiftUI).
        scrollView.contentInsetAdjustmentBehavior = .never
        scrollView.bouncesZoom = true
        scrollView.bounces = true
        // alwaysBounce — выключены намеренно, а сам запрет панорамы при вписанном кадре
        // живёт в ZoomScrollView.gestureRecognizerShouldBegin: так вертикальный свайп
        // достаётся жесту закрытия у контроллера, а горизонтальный — пейджеру.
        scrollView.alwaysBounceVertical = false
        scrollView.alwaysBounceHorizontal = false
        scrollView.minimumZoomScale = 1
        scrollView.maximumZoomScale = 3
        // Каждый проход layout скролл-вью (а он идёт покадрово во время анимированного
        // зума — bounds меняются каждый кадр) заново центрирует кадр через inset.
        scrollView.onLayout = { [weak self] in self?.centerContent() }
        addSubview(scrollView)

        for imageView in [thumbImageView, fullImageView] {
            imageView.contentMode = .scaleAspectFit
            imageView.clipsToBounds = true
            imageView.isUserInteractionEnabled = false
            zoomContainer.addSubview(imageView)
        }
        // Полный кадр проявляется поверх миниатюры анимацией alpha — стартует невидимым.
        fullImageView.alpha = 0
        scrollView.addSubview(zoomContainer)

        // Спиннер и подпись ошибки — над скролл-вью, не перехватывают касания.
        spinner.color = .white
        spinner.hidesWhenStopped = true
        spinner.isUserInteractionEnabled = false
        spinner.translatesAutoresizingMaskIntoConstraints = false
        addSubview(spinner)

        failedBadge.backgroundColor = UIColor.black.withAlphaComponent(0.55)
        failedBadge.layer.cornerRadius = 10
        failedBadge.layer.cornerCurve = .continuous
        failedBadge.isUserInteractionEnabled = false
        failedBadge.isHidden = true
        failedBadge.translatesAutoresizingMaskIntoConstraints = false
        failedLabel.font = .systemFont(ofSize: 14, weight: .medium)
        failedLabel.textColor = UIColor.white.withAlphaComponent(0.9)
        failedLabel.textAlignment = .center
        failedLabel.numberOfLines = 0
        failedLabel.translatesAutoresizingMaskIntoConstraints = false
        failedBadge.addSubview(failedLabel)
        addSubview(failedBadge)

        NSLayoutConstraint.activate([
            spinner.centerXAnchor.constraint(equalTo: centerXAnchor),
            spinner.centerYAnchor.constraint(equalTo: centerYAnchor),
            failedBadge.centerXAnchor.constraint(equalTo: centerXAnchor),
            failedBadge.centerYAnchor.constraint(equalTo: centerYAnchor),
            failedBadge.widthAnchor.constraint(lessThanOrEqualTo: widthAnchor, constant: -48),
            failedLabel.topAnchor.constraint(equalTo: failedBadge.topAnchor, constant: 8),
            failedLabel.bottomAnchor.constraint(equalTo: failedBadge.bottomAnchor, constant: -8),
            failedLabel.leadingAnchor.constraint(equalTo: failedBadge.leadingAnchor, constant: 12),
            failedLabel.trailingAnchor.constraint(equalTo: failedBadge.trailingAnchor, constant: -12),
        ])

        // Двойной тап — зум в точку; одиночный ждёт провала двойного, иначе первый тап
        // двойного успевал бы прятать хром.
        doubleTap.addTarget(self, action: #selector(handleDoubleTap(_:)))
        doubleTap.numberOfTapsRequired = 2
        singleTap.addTarget(self, action: #selector(handleSingleTap(_:)))
        singleTap.numberOfTapsRequired = 1
        singleTap.require(toFail: doubleTap)
        scrollView.addGestureRecognizer(doubleTap)
        scrollView.addGestureRecognizer(singleTap)
    }

    // MARK: - Картинки

    /// Пропорции вложения (width/height с сервера). Слабее реального кадра: как только
    /// пришла миниатюра или полноразмер, геометрию считаем по ним.
    func setAspect(_ size: CGSize?) {
        if let size, size.width > 0, size.height > 0 {
            attachmentAspect = size
        } else {
            attachmentAspect = nil
        }
        refreshAspect()
    }

    /// Миниатюра показывается сразу, без анимации — обычно она уже в кэше ленты и это
    /// первый кадр, который видит пользователь.
    func setThumb(_ image: UIImage?) {
        guard image !== thumbImageView.image else { return }
        thumbImageView.image = image
        // Под полностью проявленным полным кадром миниатюра не нужна (сценарий: full пришёл
        // из кэша синхронно, thumb — позже) — не показываем её, чтобы не тратить блендинг.
        thumbImageView.isHidden = fullImageView.image != nil && fullImageView.alpha >= 1
        refreshAspect()
        updateOverlays()
    }

    /// Полноразмер проявляется поверх миниатюры кроссфейдом; геометрия при этом не
    /// меняется (см. заголовок файла), зум и панорама пользователя сохраняются: если
    /// пропорции full совпали с thumb (обычный случай), контейнер вообще не трогаем; если
    /// разошлись больше чем на 1 %, applyFittedLayout переносит масштаб и центр в новую
    /// геометрию через viewportAnchor.
    func setFull(_ image: UIImage?) {
        guard image !== fullImageView.image else { return }
        crossfadeGeneration &+= 1
        let generation = crossfadeGeneration
        fullImageView.layer.removeAllAnimations()

        guard let image else {
            fullImageView.image = nil
            fullImageView.alpha = 0
            thumbImageView.isHidden = false
            refreshAspect()
            updateZoomLimits()
            updateOverlays()
            return
        }

        fullImageView.image = image
        // Полный кадр на руках — прошлая ошибка загрузки неактуальна.
        failedText = nil
        refreshAspect()
        updateZoomLimits()
        updateOverlays()

        // Без окна анимировать нечего: страницу собрали заранее для соседа, её не видно.
        guard window != nil else {
            fullImageView.alpha = 1
            thumbImageView.isHidden = true
            return
        }
        fullImageView.alpha = 0
        UIView.animate(
            withDuration: Self.crossfadeDuration,
            delay: 0,
            options: [.curveEaseOut, .beginFromCurrentState],
            animations: { self.fullImageView.alpha = 1 },
            completion: { [weak self] _ in
                guard let self, self.crossfadeGeneration == generation else { return }
                self.thumbImageView.isHidden = true
            }
        )
    }

    /// Спиннер показывается только пока нет вообще ничего (ни thumb, ни full) и нет ошибки.
    func setLoading(_ on: Bool) {
        isLoading = on
        updateOverlays()
    }

    /// nil — убрать подпись ошибки; строка — показать (пустая → текст по умолчанию).
    func setFailed(_ text: String?) {
        failedText = text.map { $0.isEmpty ? Self.defaultFailedText : $0 }
        updateOverlays()
    }

    // MARK: - Зум

    func resetZoom(animated: Bool) {
        guard scrollView.zoomScale != scrollView.minimumZoomScale else {
            notifyZoomIfChanged()
            return
        }
        scrollView.setZoomScale(scrollView.minimumZoomScale, animated: animated)
        if !animated {
            centerContent()
            trackViewportAnchor()
            notifyZoomIfChanged()
        }
    }

    @objc private func handleDoubleTap(_ recognizer: UITapGestureRecognizer) {
        if isZoomed {
            scrollView.setZoomScale(scrollView.minimumZoomScale, animated: true)
            return
        }
        let target = min(Self.doubleTapZoom, scrollView.maximumZoomScale)
        guard target > scrollView.minimumZoomScale else { return }
        // zoom(to:) принимает прямоугольник в координатах зумируемого вью; location(in:)
        // сама учитывает его transform, поэтому точка под пальцем остаётся под пальцем.
        let point = recognizer.location(in: zoomContainer)
        let size = CGSize(width: scrollView.bounds.width / target, height: scrollView.bounds.height / target)
        let rect = CGRect(
            x: point.x - size.width / 2,
            y: point.y - size.height / 2,
            width: size.width,
            height: size.height
        )
        scrollView.zoom(to: rect, animated: true)
    }

    @objc private func handleSingleTap(_ recognizer: UITapGestureRecognizer) {
        guard recognizer.state == .ended else { return }
        onSingleTap?()
    }

    private func notifyZoomIfChanged() {
        let zoomed = isZoomed
        guard zoomed != lastReportedZoomed else { return }
        lastReportedZoomed = zoomed
        onZoomChanged?(zoomed)
    }

    /// Максимум — 3× или столько, чтобы пиксель кадра стал пикселем экрана (для
    /// даунсэмпленных store'ом кадров это ≈2.5×, поэтому 3 — нижняя планка). Считаем по
    /// полноразмеру: у миниатюры «натуральный» размер меньше экрана и смысла не имеет.
    private func updateZoomLimits() {
        let fitted = zoomContainer.bounds.size
        var maxScale: CGFloat = 3
        if let full = fullImageView.image, fitted.width > 0 {
            let naturalWidthPoints = full.size.width * full.scale / pixelScale
            maxScale = max(3, naturalWidthPoints / fitted.width)
        }
        scrollView.minimumZoomScale = 1
        scrollView.maximumZoomScale = maxScale
        if scrollView.zoomScale > maxScale {
            // Планка опустилась ниже текущего зума (full оказался меньше ожидаемого):
            // ужимаем и сразу перецентрируем — делегат при программном зуме зовётся,
            // но полагаться на это не будем.
            scrollView.zoomScale = maxScale
            centerContent()
        }
    }

    // MARK: - Геометрия

    private var pixelScale: CGFloat {
        max(window?.screen.scale ?? traitCollection.displayScale, 1)
    }

    /// Поворот / смена bounds: пересчитать «вписать» и вернуть тот же центр кадра.
    /// Порядок важен: frame скролл-вью меняем здесь, а его собственный layoutSubviews
    /// (с центрированием) пройдёт после нашего — уже по новой геометрии контейнера.
    override func layoutSubviews() {
        super.layoutSubviews()
        scrollView.frame = bounds
        guard bounds.size != lastLayoutSize else { return }
        // Якорь скопирован ДО пересчёта: внутри applyFittedLayout скролл-вью дёргает
        // делегата, и сохранённое значение на время становится мусором.
        let anchor = viewportAnchor
        lastLayoutSize = bounds.size
        applyFittedLayout(restoring: anchor)
    }

    /// Реальный кадр (full, потом thumb) важнее метаданных вложения; пересчитываем
    /// геометрию только при ощутимом отличии, иначе округления двигали бы кадр на пиксель.
    private func refreshAspect() {
        let candidate = [fullImageView.image?.size, thumbImageView.image?.size, attachmentAspect]
            .compactMap { $0 }
            .first { $0.width > 0 && $0.height > 0 }
        guard !Self.aspectsClose(candidate, appliedAspect) else { return }
        appliedAspect = candidate
        if lastLayoutSize == bounds.size, bounds.width > 0, bounds.height > 0 {
            applyFittedLayout(restoring: viewportAnchor)
        } else {
            // Размер ещё не известен — вписывание посчитает ближайший layoutSubviews.
            setNeedsLayout()
        }
    }

    private static func aspectsClose(_ a: CGSize?, _ b: CGSize?) -> Bool {
        switch (a, b) {
        case (nil, nil):
            return true
        case let (a?, b?):
            guard a.height > 0, b.height > 0 else { return false }
            let ra = a.width / a.height
            let rb = b.width / b.height
            return abs(ra - rb) <= max(ra, rb) * 0.01
        default:
            return false
        }
    }

    /// Задаёт контейнеру размер «вписано» под текущие bounds, сохраняя масштаб и центр.
    private func applyFittedLayout(restoring anchor: CGPoint?) {
        let box = bounds.size
        guard box.width > 0, box.height > 0 else { return }
        let fitted = Self.fittedSize(aspect: appliedAspect, in: box, pixelScale: pixelScale)
        let previousZoom = scrollView.zoomScale

        // Кадр задаём при масштабе 1: frame зумируемого вью — это bounds × transform, и в
        // зуме прямое присваивание frame дало бы неверную геометрию.
        scrollView.zoomScale = 1
        zoomContainer.frame = CGRect(origin: .zero, size: fitted)
        scrollView.contentSize = fitted
        updateZoomLimits()
        scrollView.zoomScale = min(max(previousZoom, scrollView.minimumZoomScale), scrollView.maximumZoomScale)
        centerContent()
        if let anchor {
            restoreViewport(anchor: anchor)
        }
        trackViewportAnchor()
        notifyZoomIfChanged()
    }

    /// Стандартный приём центрирования: пока контент меньше bounds, добираем разницу
    /// contentInset'ом — тогда и bounce, и инерция скролл-вью работают как обычно.
    /// Зовётся и из layoutSubviews скролл-вью (покадрово при анимированном зуме), поэтому
    /// пишем inset только при реальном отличии: присваивание contentInset само помечает
    /// скролл-вью на layout, и без этой проверки получился бы бесконечный цикл layout.
    private func centerContent() {
        let boundsSize = scrollView.bounds.size
        let contentSize = zoomContainer.frame.size
        let dx = max(0, (boundsSize.width - contentSize.width) / 2)
        let dy = max(0, (boundsSize.height - contentSize.height) / 2)
        let inset = UIEdgeInsets(top: dy, left: dx, bottom: dy, right: dx)
        guard inset != scrollView.contentInset else { return }
        scrollView.contentInset = inset
    }

    private func trackViewportAnchor() {
        // Пока размер не пересчитан (идёт поворот), offset относится к старой геометрии —
        // такой якорь портить не будем.
        guard scrollView.bounds.size == lastLayoutSize else { return }
        let content = zoomContainer.frame.size
        guard content.width > 0, content.height > 0 else { return }
        let centerX = scrollView.contentOffset.x + scrollView.bounds.width / 2
        let centerY = scrollView.contentOffset.y + scrollView.bounds.height / 2
        viewportAnchor = CGPoint(x: centerX / content.width, y: centerY / content.height)
    }

    private func restoreViewport(anchor: CGPoint) {
        let box = scrollView.bounds.size
        let content = zoomContainer.frame.size
        let inset = scrollView.contentInset
        let target = CGPoint(
            x: anchor.x * content.width - box.width / 2,
            y: anchor.y * content.height - box.height / 2
        )
        let minX = -inset.left
        let minY = -inset.top
        let maxX = max(minX, content.width - box.width + inset.right)
        let maxY = max(minY, content.height - box.height + inset.bottom)
        scrollView.contentOffset = CGPoint(
            x: min(max(target.x, minX), maxX),
            y: min(max(target.y, minY), maxY)
        )
    }

    // MARK: - Оверлеи

    private func updateOverlays() {
        let hasImage = currentImage != nil
        let showFailed = failedText != nil
        failedLabel.text = failedText
        failedBadge.isHidden = !showFailed
        if isLoading && !hasImage && !showFailed {
            spinner.startAnimating()
        } else {
            spinner.stopAnimating()
        }
    }
}

// MARK: - UIScrollViewDelegate

extension ZoomableImageView: UIScrollViewDelegate {

    func viewForZooming(in scrollView: UIScrollView) -> UIView? {
        zoomContainer
    }

    func scrollViewDidZoom(_ scrollView: UIScrollView) {
        centerContent()
        trackViewportAnchor()
        notifyZoomIfChanged()
    }

    func scrollViewDidEndZooming(_ scrollView: UIScrollView, with view: UIView?, atScale scale: CGFloat) {
        centerContent()
        trackViewportAnchor()
        notifyZoomIfChanged()
    }

    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        trackViewportAnchor()
    }
}

// MARK: - Скролл-вью

/// Скролл-вью страницы. Две обязанности сверх стандартного:
/// 1. Пока кадр вписан, собственная панорама не начинается вовсе — по масштабу, а не по
///    сравнению contentSize с bounds: те отличаются на доли пикселя из-за округления
///    «вписать», и float-равенство то срабатывало, то нет, отбирая свайп у закрытия/пейджера.
///    Порог 1.01 тот же, что у isZoomed, — контроллер и скролл-вью думают одинаково.
/// 2. Каждый проход layout перецентрирует кадр: анимированный setZoomScale/zoom(to:)
///    меняет bounds покадрово (и, значит, зовёт layoutSubviews), а scrollViewDidZoom при
///    анимации приходит один раз с конечным масштабом — без этого inset на конце двойного
///    тапа обновлялся скачком, и кадр «прыгал» в центр.
private final class ZoomScrollView: UIScrollView {

    var onLayout: (() -> Void)?

    override func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        if gestureRecognizer === panGestureRecognizer, zoomScale <= 1.01 {
            return false
        }
        return super.gestureRecognizerShouldBegin(gestureRecognizer)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        onLayout?()
    }
}

// MARK: - Контейнер слоёв

/// Оба слоя всегда занимают весь контейнер: размер меняет только applyFittedLayout при
/// масштабе 1, а зум — это transform контейнера, bounds при нём не трогаются.
private final class ZoomContentView: UIView {
    override func layoutSubviews() {
        super.layoutSubviews()
        for subview in subviews {
            subview.frame = bounds
        }
    }
}
