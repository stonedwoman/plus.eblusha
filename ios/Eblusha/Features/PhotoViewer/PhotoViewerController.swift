import Combine
import SwiftUI
import UIKit

/// Сердце просмотрщика фото (контракт: файл 3): чёрный фон, пейджер с зазором между
/// страницами, жесты и анимации открытия «из плитки» и закрытия «в плитку». Хром (шапка,
/// подпись, лента миниатюр, панель действий) рисует SwiftUI поверх — контроллер о нём
/// знает только через PhotoViewerProxy: публикует индекс, видимость и прогресс закрытия,
/// а принимает команды jump / requestDismiss.
///
/// Почему UIKit: на одном экране живут три жеста — листание, зум и свайп-закрытие, и
/// SwiftUI-жесты в этом проекте уже ломали прокрутку соседей. UIPageViewController и
/// UIScrollView зума договариваются между собой сами (скролл-вью, которому некуда
/// прокручиваться, проваливает свой pan), а свайп-закрытие вклинивается через делегата,
/// проверяя направление ДО начала жеста.
///
/// Изоляция: UIViewController уже @MainActor, подкласс наследует её — отдельной пометки
/// не нужно, а store и proxy (оба @MainActor) вызываются напрямую.
final class PhotoViewerController: UIViewController {

    // MARK: - Константы

    /// Зазор между страницами — как в Telegram: соседний кадр не прилипает к текущему.
    private static let interPageSpacing: CGFloat = 20
    /// Скругление плитки в чате (ChatView.attachmentImage: RoundedRectangle(cornerRadius: 10)).
    private static let tileCornerRadius: CGFloat = 10
    private static let openDuration: TimeInterval = 0.38
    private static let fadeInDuration: TimeInterval = 0.2
    private static let flyBackDuration: TimeInterval = 0.3
    private static let scaleFadeDuration: TimeInterval = 0.22
    private static let snapBackDuration: TimeInterval = 0.35
    /// Порог закрытия свайпом: по смещению пальца и по скорости отпускания.
    private static let dismissDistance: CGFloat = 120
    private static let dismissVelocity: CGFloat = 800
    /// Масштаб кадра 1 → 0.7 набирается к 300 pt смещения, гашение фона/хрома — к 240 pt.
    private static let scaleDistance: CGFloat = 300
    private static let progressDistance: CGFloat = 240

    // MARK: - Зависимости

    private let gallery: PhotoViewerGallery
    private let store: PhotoViewerImageStore
    private let proxy: PhotoViewerProxy
    private let onDismissed: () -> Void

    // MARK: - Вью

    /// Чёрный фон; его alpha — единственное, что гасится при свайпе, сама view прозрачна:
    /// обёртка показана через fullScreenCover с прозрачным фоном, и чат под нами виден,
    /// пока кадр вырастает из плитки.
    private let backdrop = UIView()
    private let pager: UIPageViewController
    /// Подложка плитки в чате (ChatView.plainAttachmentImage: background(Eb.surface100)) —
    /// копия кадра стартует и приземляется ровно в таком виде, чтобы стык с лентой не был виден.
    private let tileBackground = UIColor(Eb.surface100)

    /// Внутренний UIScrollView пейджера (_UIQueuingScrollView) — единственный способ
    /// выключить листание в зуме и на время свайпа-закрытия. Ищется среди subviews один раз.
    private lazy var pagerScrollView: UIScrollView? = pager.view.subviews
        .compactMap { $0 as? UIScrollView }
        .first

    private lazy var dismissPan: UIPanGestureRecognizer = {
        let pan = UIPanGestureRecognizer(target: self, action: #selector(handleDismissPan(_:)))
        pan.delegate = self
        // Второй палец — это пинч зума, а не продолжение свайпа.
        pan.maximumNumberOfTouches = 1
        return pan
    }()

    // MARK: - Состояние

    /// Слабые ссылки на живые страницы: пейджер сам держит текущую и соседей, а нам нужно
    /// только обновлять их по сигналу store. Сильный кэш держал бы декодированные кадры
    /// давно перелистанных страниц, сводя на нет вытеснение в store.
    private struct WeakPage {
        weak var controller: PhotoPageController?
    }

    private var pages: [Int: WeakPage] = [:]
    /// Стартовый индекс после зажима в границы items (координатор мог ошибиться).
    private let startIndex: Int
    private var currentIndex: Int
    /// Размер вью на момент открытия: после поворота оконные координаты sourceFrame врут,
    /// и лететь «в плитку» уже некуда — закрываемся уменьшением.
    private var openedSize: CGSize?
    private var didOpen = false
    private var isDismissing = false
    /// Пейджер в середине перехода (жестом или по jump) — свайп-закрытие и новые jump ждут.
    private var isTransitioning = false
    private var dismissPanActive = false

    private var storeSubscription: AnyCancellable?
    private var chromeSubscription: AnyCancellable?

    // MARK: - Инициализация

    init(
        gallery: PhotoViewerGallery,
        store: PhotoViewerImageStore,
        proxy: PhotoViewerProxy,
        onDismissed: @escaping () -> Void
    ) {
        self.gallery = gallery
        self.store = store
        self.proxy = proxy
        self.onDismissed = onDismissed
        let count = gallery.items.count
        let start = count == 0 ? 0 : min(max(gallery.startIndex, 0), count - 1)
        self.startIndex = start
        self.currentIndex = start
        self.pager = UIPageViewController(
            transitionStyle: .scroll,
            navigationOrientation: .horizontal,
            options: [.interPageSpacing: Self.interPageSpacing]
        )
        super.init(nibName: nil, bundle: nil)

        proxy.jump = { [weak self] index, animated in
            self?.jump(to: index, animated: animated)
        }
        proxy.requestDismiss = { [weak self] in
            self?.dismissViewer(velocity: .zero)
        }
        // Хром должен появиться ПОСЛЕ анимации открытия. Прячем его через dismissProgress,
        // а не chromeVisible: смену chromeVisible хром анимирует (.easeOut 0.2), и первое же
        // изменение дало бы видимое затухание поверх вырастающего кадра; dismissProgress
        // применяется мгновенно. Обратно поднимаем в revealChrome().
        // PhotoViewerView уже ставит 1 при создании proxy (мы здесь внутри
        // makeUIViewController, публиковать из обновления SwiftUI нельзя) — присваиваем
        // только если обёртка другая и значение не выставлено.
        if proxy.dismissProgress != 1 {
            proxy.dismissProgress = 1
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("PhotoViewerController создаётся только кодом")
    }

    // MARK: - Жизненный цикл

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear
        // Просмотрщик всегда тёмный, какой бы ни была системная тема.
        overrideUserInterfaceStyle = .dark

        backdrop.backgroundColor = .black
        backdrop.alpha = 0
        backdrop.frame = view.bounds
        backdrop.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(backdrop)

        pager.dataSource = self
        pager.delegate = self
        pager.view.backgroundColor = .clear
        addChild(pager)
        pager.view.frame = view.bounds
        pager.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(pager.view)
        pager.didMove(toParent: self)
        // До конца анимации открытия страницы невидимы: вместо них летит копия кадра.
        pager.view.alpha = 0

        if gallery.items.indices.contains(currentIndex) {
            pager.setViewControllers([pageController(at: currentIndex)], direction: .forward, animated: false)
        }
        updatePagingEnabled()

        view.addGestureRecognizer(dismissPan)

        // objectWillChange приходит ДО мутации store; receive(on:) откладывает обработку на
        // следующий проход главной очереди, когда новые thumb/full уже на месте.
        storeSubscription = store.objectWillChange
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in self?.refreshPages() }
        chromeSubscription = proxy.$chromeVisible
            .removeDuplicates()
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in self?.setNeedsUpdateOfHomeIndicatorAutoHidden() }

        // Предзагрузку запускаем на следующем витке: viewDidLoad может выполняться внутри
        // обновления SwiftUI, а store при старте загрузки публикует objectWillChange —
        // публикация из обновления даёт «Publishing changes from within view updates» и
        // непредсказуемую перерисовку хрома.
        Task { @MainActor [weak self] in
            guard let self, !self.isDismissing else { return }
            self.store.prefetch(around: self.currentIndex)
        }
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        setNeedsStatusBarAppearanceUpdate()
        openIfNeeded()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        // Страховка на случай, если SwiftUI-контейнер задержит viewDidAppear: открываемся
        // на первом layout в окне — геометрия к этому моменту уже известна.
        if view.window != nil {
            openIfNeeded()
        }
    }

    override func viewWillTransition(to size: CGSize, with coordinator: UIViewControllerTransitionCoordinator) {
        super.viewWillTransition(to: size, with: coordinator)
        // Поворот посреди свайпа: жест отменяем (переключение isEnabled шлёт .cancelled),
        // кадр пружиной вернётся на место, а страницы пересчитают вписывание сами.
        if dismissPanActive {
            dismissPan.isEnabled = false
            dismissPan.isEnabled = true
        }
    }

    override var prefersStatusBarHidden: Bool { true }

    override var preferredStatusBarUpdateAnimation: UIStatusBarAnimation { .fade }

    /// Полоска «домой» прячется вместе с хромом — как в системном просмотре Фото.
    override var prefersHomeIndicatorAutoHidden: Bool { !proxy.chromeVisible }

    // MARK: - Страницы

    private var currentPage: PhotoPageController? {
        pager.viewControllers?.first as? PhotoPageController
    }

    private func pageController(at index: Int) -> PhotoPageController {
        if let existing = pages[index]?.controller { return existing }
        let page = PhotoPageController(index: index, item: gallery.items[index])
        page.zoomView.onSingleTap = { [weak self] in
            self?.toggleChrome()
        }
        page.zoomView.onZoomChanged = { [weak self, weak page] _ in
            // Листание выключаем только по текущей странице: соседи зумиться не могут, а их
            // сброс зума при уходе не должен включать пейджер посреди чужого жеста.
            guard let self, let page, page === self.currentPage else { return }
            self.updatePagingEnabled()
        }
        // Заодно чистим записи об уже отпущенных страницах — словарь не растёт.
        pages = pages.filter { $0.value.controller != nil }
        pages[index] = WeakPage(controller: page)
        applyStoreState(to: page)
        return page
    }

    /// Переносит текущее знание store о кадре на страницу. setThumb/setFull сравнивают
    /// картинку по identity, поэтому повторные вызовы бесплатны.
    private func applyStoreState(to page: PhotoPageController) {
        let item = page.item
        let full = store.full(for: item)
        let thumb = store.thumb(for: item)
        let state = store.state(for: item)
        page.zoomView.setThumb(thumb)
        page.zoomView.setFull(full)
        page.zoomView.setFailed(state == .failed && full == nil ? "" : nil)
        // Спиннер сам прячется, как только есть хоть какая-то картинка (ZoomableImageView).
        page.zoomView.setLoading(state != .failed)
    }

    private func refreshPages() {
        for entry in pages.values {
            if let page = entry.controller {
                applyStoreState(to: page)
            }
        }
    }

    private func pageDidBecomeCurrent(_ index: Int) {
        currentIndex = index
        if proxy.currentIndex != index {
            proxy.currentIndex = index
        }
        store.prefetch(around: index)
        updatePagingEnabled()
    }

    /// Листание живёт, пока кадр не в зуме и не идёт свайп-закрытие. С одним фото пейджер
    /// только бы пружинил у краёв — тоже выключаем.
    private func updatePagingEnabled() {
        let zoomed = currentPage?.zoomView.isZoomed ?? false
        pagerScrollView?.isScrollEnabled = gallery.items.count > 1 && !zoomed && !dismissPanActive && !isDismissing
    }

    private func toggleChrome() {
        guard !isDismissing, !dismissPanActive else { return }
        proxy.chromeVisible.toggle()
    }

    // MARK: - Команды хрома

    private func jump(to index: Int, animated: Bool) {
        guard gallery.items.indices.contains(index), !isDismissing, !dismissPanActive else { return }
        guard index != currentIndex, !isTransitioning else { return }
        let direction: UIPageViewController.NavigationDirection = index > currentIndex ? .forward : .reverse
        let previous = currentPage
        let target = pageController(at: index)
        previous?.zoomView.resetZoom(animated: false)

        // Индекс публикуем сразу — лента миниатюр подсвечивает выбранную плитку в момент
        // тапа; цель грузим тоже сразу. А окно предзагрузки (и вытеснение дальних кадров)
        // сдвигаем только по концу анимации: иначе store снял бы полный кадр с уезжающей
        // страницы прямо на глазах.
        currentIndex = index
        if proxy.currentIndex != index {
            proxy.currentIndex = index
        }
        store.ensureLoaded(gallery.items[index])

        if animated {
            isTransitioning = true
            pager.setViewControllers([target], direction: direction, animated: true) { [weak self] _ in
                guard let self else { return }
                self.isTransitioning = false
                self.store.prefetch(around: index)
                self.updatePagingEnabled()
                // Известная странность UIPageViewController: после анимированного
                // setViewControllers его внутренняя очередь иногда отстаёт от viewControllers,
                // и следующий свайп показывает не ту страницу. Повторная установка без
                // анимации приводит очередь в порядок; если пользователь уже листает дальше —
                // не трогаем.
                DispatchQueue.main.async { [weak self] in
                    guard let self, self.currentIndex == index, !self.isTransitioning, !self.isDismissing else { return }
                    self.pager.setViewControllers([target], direction: direction, animated: false)
                }
            }
        } else {
            pager.setViewControllers([target], direction: direction, animated: false)
            store.prefetch(around: index)
        }
        updatePagingEnabled()
    }

    // MARK: - Открытие

    private func openIfNeeded() {
        guard !didOpen, view.window != nil, view.bounds.width > 0, view.bounds.height > 0 else { return }
        didOpen = true
        openedSize = view.bounds.size
        // Страницам нужен реальный layout, чтобы отдать рамку «вписано» под полёт.
        view.layoutIfNeeded()
        if proxy.currentIndex != currentIndex {
            proxy.currentIndex = currentIndex
        }

        if let page = currentPage, let source = sourceFrameInView() {
            animateOpen(from: source, page: page)
        } else {
            animateFadeIn()
        }
    }

    /// Рамка плитки в координатах нашей вью. nil — плитки нет, она вне экрана или размер
    /// экрана с момента открытия изменился (оконные координаты после поворота уже врут).
    private func sourceFrameInView() -> CGRect? {
        guard let frame = gallery.sourceFrame, view.window != nil else { return nil }
        if let openedSize, openedSize != view.bounds.size { return nil }
        let rect = view.convert(frame, from: nil)
        guard rect.width > 1, rect.height > 1, rect.intersects(view.bounds) else { return nil }
        return rect
    }

    private func animateOpen(from source: CGRect, page: PhotoPageController) {
        view.isUserInteractionEnabled = false
        let image = page.zoomView.currentImage
        let target = page.zoomView.imageFrameInWindow.map { view.convert($0, from: nil) }
            ?? Self.fitRect(aspect: image?.size ?? page.item.aspectSize, in: pager.view.frame)

        // Копия стартует ровно как плитка в чате: вписанная картинка на подложке surface100
        // со скруглением 10 — первый кадр анимации неотличим от ленты.
        let flight = makeFlightView(image: image)
        flight.frame = source
        flight.backgroundColor = tileBackground
        flight.layer.cornerRadius = Self.tileCornerRadius
        view.addSubview(flight)

        Self.animateCornerRadius(of: flight, from: Self.tileCornerRadius, to: 0, duration: Self.openDuration)
        // Фон — отдельной, не пружинной анимацией: пружина с недодемпфированием заходила бы
        // за 1 и мигала бы на границе.
        UIView.animate(withDuration: 0.25, delay: 0, options: [.curveEaseOut]) {
            self.backdrop.alpha = 1
        }
        UIView.animate(
            withDuration: Self.openDuration,
            delay: 0,
            usingSpringWithDamping: 0.86,
            initialSpringVelocity: 0.4,
            options: []
        ) {
            flight.frame = target
            // К прозрачному того же оттенка: к .clear UIKit интерполирует через чёрный.
            flight.backgroundColor = self.tileBackground.withAlphaComponent(0)
        } completion: { [weak self] _ in
            self?.finishOpen(flight: flight)
        }
    }

    private func animateFadeIn() {
        view.isUserInteractionEnabled = false
        UIView.animate(withDuration: Self.fadeInDuration, delay: 0, options: [.curveEaseOut]) {
            self.pager.view.alpha = 1
            self.backdrop.alpha = 1
        } completion: { [weak self] _ in
            guard let self else { return }
            self.view.isUserInteractionEnabled = true
            self.updatePagingEnabled()
            self.revealChrome()
        }
    }

    private func finishOpen(flight: UIView) {
        pager.view.alpha = 1
        // Копия гаснет поверх уже видимой страницы: если за время полёта подъехал полный
        // кадр, переход миниатюра → полный получается мягким, а не скачком резкости.
        UIView.animate(withDuration: 0.12, animations: { flight.alpha = 0 }) { _ in
            flight.removeFromSuperview()
        }
        view.isUserInteractionEnabled = true
        updatePagingEnabled()
        revealChrome()
    }

    /// Показать хром после открытия. В init он спрятан через dismissProgress = 1 (это
    /// значение SwiftUI не анимирует — нет мигания). Проявить хочется плавно, а анимируется
    /// только chromeVisible, поэтому два шага: сначала опускаем progress при погашенном
    /// chromeVisible (итоговая непрозрачность остаётся 0), затем, когда SwiftUI это точно
    /// применил, включаем chromeVisible — получается чистое проявление за 0.2 с.
    private func revealChrome() {
        guard !isDismissing else { return }
        proxy.chromeVisible = false
        proxy.dismissProgress = 0
        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 50_000_000)
            guard let self, !self.isDismissing, !self.dismissPanActive else { return }
            self.proxy.chromeVisible = true
        }
    }

    // MARK: - Закрытие

    private func dismissViewer(velocity: CGPoint) {
        guard !isDismissing else { return }
        isDismissing = true
        dismissPanActive = false
        view.isUserInteractionEnabled = false
        dismissPan.isEnabled = false
        pagerScrollView?.isScrollEnabled = false
        // Хром гаснет своей анимацией (0.2 с) параллельно с уходом кадра.
        proxy.chromeVisible = false

        let page = currentPage
        if currentIndex == startIndex,
           let page,
           let image = page.zoomView.currentImage,
           let source = sourceFrameInView(),
           let start = page.zoomView.imageFrameInWindow.map({ view.convert($0, from: nil) }) {
            animateFlyBack(image: image, from: start, to: source, velocity: velocity)
        } else {
            animateScaleFade(page: page)
        }
    }

    /// Кадр летит в плитку. Рамка старта снята с живой страницы через imageFrameInWindow —
    /// она уже учитывает сдвиг и масштаб свайпа (и зум, если закрывают кнопкой в зуме),
    /// поэтому копия подхватывает кадр ровно там, где он сейчас на экране.
    private func animateFlyBack(image: UIImage, from start: CGRect, to source: CGRect, velocity: CGPoint) {
        let flight = makeFlightView(image: image)
        flight.frame = start
        flight.backgroundColor = tileBackground.withAlphaComponent(0)
        view.addSubview(flight)
        pager.view.alpha = 0

        // Начальная скорость пружины у UIKit — в долях расстояния в секунду: берём проекцию
        // скорости пальца на направление к плитке. После свайпа кадр не спотыкается на
        // старте анимации, а продолжает движение; при закрытии кнопкой стартует с нуля.
        let dx = source.midX - start.midX
        let dy = source.midY - start.midY
        let distanceSquared = dx * dx + dy * dy
        let springVelocity: CGFloat = distanceSquared > 1
            ? min(max((velocity.x * dx + velocity.y * dy) / distanceSquared, 0), 8)
            : 0

        Self.animateCornerRadius(of: flight, from: 0, to: Self.tileCornerRadius, duration: Self.flyBackDuration)
        UIView.animate(
            withDuration: Self.flyBackDuration,
            delay: 0,
            usingSpringWithDamping: 1,
            initialSpringVelocity: springVelocity,
            options: []
        ) {
            flight.frame = source
            flight.backgroundColor = self.tileBackground
            self.backdrop.alpha = 0
        } completion: { [weak self] _ in
            flight.removeFromSuperview()
            self?.finishDismiss()
        }
    }

    /// Нет плитки, куда лететь (не стартовый кадр, поворот, кадр не загружен) —
    /// уменьшение с затуханием; после свайпа продолжает уже набранные сдвиг и масштаб.
    private func animateScaleFade(page: PhotoPageController?) {
        UIView.animate(withDuration: Self.scaleFadeDuration, delay: 0, options: [.curveEaseOut, .beginFromCurrentState]) {
            if let page {
                page.zoomView.transform = page.zoomView.transform.scaledBy(x: 0.85, y: 0.85)
            }
            self.pager.view.alpha = 0
            self.backdrop.alpha = 0
        } completion: { [weak self] _ in
            self?.finishDismiss()
        }
    }

    private func finishDismiss() {
        // Экран уже пуст — обёртка снимает fullScreenCover без своей анимации.
        onDismissed()
    }

    // MARK: - Свайп-закрытие

    @objc private func handleDismissPan(_ pan: UIPanGestureRecognizer) {
        guard let page = currentPage, !isDismissing else { return }
        let translation = pan.translation(in: view)

        switch pan.state {
        case .began:
            dismissPanActive = true
            updatePagingEnabled()
            // Если пружина возврата от прошлого свайпа ещё идёт — палец важнее.
            page.zoomView.layer.removeAllAnimations()
            backdrop.layer.removeAllAnimations()

        case .changed:
            let distance = abs(translation.y)
            let scale = 1 - 0.3 * min(distance / Self.scaleDistance, 1)
            let progress = min(distance / Self.progressDistance, 1)
            // Кадр идёт за пальцем по обеим осям и уменьшается вокруг своего центра.
            page.zoomView.transform = CGAffineTransform(translationX: translation.x, y: translation.y)
                .scaledBy(x: scale, y: scale)
            backdrop.alpha = 1 - progress
            proxy.dismissProgress = progress

        case .ended, .cancelled, .failed:
            dismissPanActive = false
            let velocity = pan.velocity(in: view)
            let shouldClose = pan.state == .ended
                && (abs(translation.y) > Self.dismissDistance || abs(velocity.y) > Self.dismissVelocity)
            if shouldClose {
                dismissViewer(velocity: velocity)
            } else {
                snapBack(page: page)
            }

        default:
            break
        }
    }

    private func snapBack(page: PhotoPageController) {
        UIView.animate(
            withDuration: Self.snapBackDuration,
            delay: 0,
            usingSpringWithDamping: 0.8,
            initialSpringVelocity: 0,
            options: [.beginFromCurrentState, .allowUserInteraction]
        ) {
            page.zoomView.transform = .identity
            self.backdrop.alpha = 1
        }
        // Сам по себе dismissProgress SwiftUI не анимирует — просим явно, чтобы хром
        // возвращался плавно, а не вспыхивал.
        withAnimation(.easeOut(duration: 0.2)) {
            proxy.dismissProgress = 0
        }
        updatePagingEnabled()
    }

    // MARK: - Вспомогательное

    /// Копия кадра для полёта — обычный UIImageView, а не снапшот страницы: снапшот
    /// зумированного скролл-вью был бы обрезан по экрану и не умел бы менять пропорции.
    private func makeFlightView(image: UIImage?) -> UIImageView {
        let flight = UIImageView(image: image)
        flight.contentMode = .scaleAspectFit
        flight.clipsToBounds = true
        flight.layer.cornerCurve = .continuous
        flight.isUserInteractionEnabled = false
        return flight
    }

    /// cornerRadius анимируем явно через CABasicAnimation: в блоке UIView.animate это
    /// работает не на всех версиях, а промах даёт резкий скачок углов в конце полёта.
    private static func animateCornerRadius(of view: UIView, from: CGFloat, to: CGFloat, duration: TimeInterval) {
        let animation = CABasicAnimation(keyPath: "cornerRadius")
        animation.fromValue = from
        animation.toValue = to
        animation.duration = duration
        animation.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        view.layer.cornerRadius = to
        view.layer.add(animation, forKey: "cornerRadius")
    }

    /// Вписать пропорции в прямоугольник по центру (запасной расчёт цели полёта, если
    /// страница ещё не отдала свою рамку).
    private static func fitRect(aspect: CGSize?, in box: CGRect) -> CGRect {
        guard let aspect, aspect.width > 0, aspect.height > 0, box.width > 0, box.height > 0 else { return box }
        let ratio = min(box.width / aspect.width, box.height / aspect.height)
        let size = CGSize(width: aspect.width * ratio, height: aspect.height * ratio)
        return CGRect(
            x: box.midX - size.width / 2,
            y: box.midY - size.height / 2,
            width: size.width,
            height: size.height
        )
    }
}

// MARK: - Жесты

extension PhotoViewerController: UIGestureRecognizerDelegate {

    /// Свайп-закрытие берётся за дело только при явно вертикальном движении и только
    /// если пейджер ещё не начал листать. Одновременность с pan пейджера не разрешаем:
    /// когда наш жест начинается, UIKit отменяет чужой, и наоборот.
    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        guard gestureRecognizer === dismissPan else { return true }
        guard !isDismissing, !isTransitioning, let page = currentPage, !page.zoomView.isZoomed else { return false }
        if let pagerPan = pagerScrollView?.panGestureRecognizer,
           pagerPan.state == .began || pagerPan.state == .changed {
            return false
        }
        let velocity = dismissPan.velocity(in: view)
        return abs(velocity.y) > abs(velocity.x) * 1.5
    }
}

// MARK: - Пейджер: данные и делегат

extension PhotoViewerController: UIPageViewControllerDataSource {

    func pageViewController(
        _ pageViewController: UIPageViewController,
        viewControllerBefore viewController: UIViewController
    ) -> UIViewController? {
        guard let page = viewController as? PhotoPageController, page.index > 0 else { return nil }
        return pageController(at: page.index - 1)
    }

    func pageViewController(
        _ pageViewController: UIPageViewController,
        viewControllerAfter viewController: UIViewController
    ) -> UIViewController? {
        guard let page = viewController as? PhotoPageController,
              page.index + 1 < gallery.items.count else { return nil }
        return pageController(at: page.index + 1)
    }
}

extension PhotoViewerController: UIPageViewControllerDelegate {

    func pageViewController(
        _ pageViewController: UIPageViewController,
        willTransitionTo pendingViewControllers: [UIViewController]
    ) {
        isTransitioning = true
    }

    func pageViewController(
        _ pageViewController: UIPageViewController,
        didFinishAnimating finished: Bool,
        previousViewControllers: [UIViewController],
        transitionCompleted completed: Bool
    ) {
        isTransitioning = false
        guard let current = currentPage else { return }
        // Ушедшая страница возвращается к «вписано»: вернувшись к ней, пользователь ждёт
        // целый кадр, а не прошлый зум.
        for case let previous as PhotoPageController in previousViewControllers where previous !== current {
            previous.zoomView.resetZoom(animated: false)
        }
        if completed, current.index != currentIndex {
            pageDidBecomeCurrent(current.index)
        } else {
            updatePagingEnabled()
        }
    }
}

// MARK: - Страница

/// Страница пейджера: тонкая обёртка над ZoomableImageView, знает свой индекс и кадр.
/// Отдельный контроллер нужен только потому, что UIPageViewController оперирует
/// контроллерами, а не вью.
private final class PhotoPageController: UIViewController {

    let index: Int
    let item: PhotoViewerItem
    let zoomView = ZoomableImageView()

    init(index: Int, item: PhotoViewerItem) {
        self.index = index
        self.item = item
        super.init(nibName: nil, bundle: nil)
        // Пропорции из метаданных вложения: страница занимает верную геометрию до
        // прихода картинок, и полный кадр потом не прыгает.
        zoomView.setAspect(item.aspectSize)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("PhotoPageController создаётся только кодом")
    }

    override func loadView() {
        view = zoomView
    }
}
