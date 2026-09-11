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
///
/// Статус-бар и полоска «домой»: контроллер живёт внутри UIHostingController обёртки
/// (fullScreenCover), и его prefersStatusBarHidden / prefersHomeIndicatorAutoHidden UIKit
/// не спрашивает — реальную работу делают модификаторы SwiftUI в PhotoViewerView
/// (.statusBarHidden(true) и .persistentSystemOverlays по chromeVisible). Здесь их нет.
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
    /// Сколько ждём сброса зума перед полётом в плитку, если UIScrollView так и не
    /// отчитался о конце анимации (страховка; обычно колбэк приходит раньше).
    private static let zoomResetTimeout: TimeInterval = 0.45
    /// Порог закрытия свайпом: по смещению пальца и по скорости отпускания.
    private static let dismissDistance: CGFloat = 120
    private static let dismissVelocity: CGFloat = 800
    /// Масштаб кадра 1 → 0.7 набирается к 300 pt смещения.
    private static let scaleDistance: CGFloat = 300
    /// Гашение фона и хрома — на разных дистанциях и НАМНОГО короче смещения кадра
    /// (было одно общее 240 pt, и первые 100 pt экран почти не отвечал: жест казался
    /// тугим). Числа как у Telegram: фон гаснет к 80 pt, хром — к 50 pt, то есть кадр
    /// «отпускается» сразу, ещё до порога закрытия. Сами пороги закрытия не тронуты:
    /// 120 pt / 800 pt/с и так легче эталона (у него ≈ высота экрана / 4 и 1000 pt/с),
    /// а при меньшем пороге диагональные смахивания начали бы закрывать кадр случайно.
    private static let backdropFadeDistance: CGFloat = 80
    private static let chromeFadeDistance: CGFloat = 50

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
    /// выключить листание в зуме и на время свайпа-закрытия, а также узнать, движется ли
    /// пейджер прямо сейчас. Ищется среди subviews один раз.
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
    /// давно перелистанных страниц, сводя на нет вытеснение в store. Полноразмеры живут
    /// только в store (окно ±1, хвост до ±2) — контроллер их не дублирует.
    private struct WeakPage {
        weak var controller: PhotoViewerPage?
    }

    private var pages: [Int: WeakPage] = [:]
    /// Стартовый индекс после зажима в границы items (координатор мог ошибиться).
    private let startIndex: Int
    private var currentIndex: Int
    /// Размер ОКНА на момент открытия: после поворота оконные координаты плиток врут, и
    /// лететь «в плитку» уже некуда — закрываемся уменьшением. Сравниваем именно окно, а
    /// не view: размер view может отличаться из-за safe area / хостинга, окно — нет.
    private var openedWindowSize: CGSize?
    private var didOpen = false
    /// Анимация открытия закончилась: до этого страницы невидимы (pager.view.alpha = 0),
    /// и видео стартовать не должно — звук шёл бы из ниоткуда.
    private var didFinishOpenAnimation = false
    private var isDismissing = false
    private var didFinishDismiss = false
    /// Идёт анимированный jump (setViewControllers(animated: true)): пейджер заблокирован,
    /// свайп-закрытие и новые jump ждут завершения. Снимается в completion.
    private var isJumping = false
    private var dismissPanActive = false
    /// Страница, которую тянет свайп-закрытие: жесты у неё выключены на время свайпа и
    /// включаются обратно именно у неё — даже если текущая страница к тому моменту
    /// почему-то сменилась.
    private weak var swipePage: PhotoViewerPage?
    /// Смещение кадра на момент начала свайпа (снято с presentation-слоя, если палец
    /// перехватил пружину возврата): новый жест продолжает движение с этого места, а не
    /// прыгает в ноль.
    private var swipeBaseOffset: CGPoint = .zero
    /// Продолжение закрытия, ждущее сброса зума (закрытие кнопкой в зуме).
    private var zoomResetContinuation: (() -> Void)?

    private var storeSubscription: AnyCancellable?

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
        // Важно сделать это ДО layout: у zoomView не должно быть transform, когда
        // контейнер страницы раздаёт ей новые bounds.
        if dismissPanActive {
            dismissPan.isEnabled = false
            dismissPan.isEnabled = true
        }
    }

    // MARK: - Страницы

    private var currentPage: PhotoViewerPage? {
        pager.viewControllers?.first as? PhotoViewerPage
    }

    private func pageController(at index: Int) -> PhotoViewerPage {
        if let existing = pages[index]?.controller { return existing }
        let item = gallery.items[index]
        // Фото и видео — страницы одного пейджера: тем же горизонтальным свайпом с кадра
        // переходишь на видео и обратно, а закрытие, полёт в плитку и арбитраж жестов у них
        // общие — контроллер знает только базовый PhotoViewerPage.
        let page: PhotoViewerPage
        if item.isVideo {
            let video = VideoPageController(index: index, item: item, store: store)
            // Полоса времени не должна заезжать под хром: панель действий 48 pt плюс лента
            // миниатюр (64 + отступы 12), когда кадров в галерее больше одного.
            video.bottomChromeInset = gallery.items.count > 1 ? 48 + 76 : 48
            page = video
        } else {
            page = PhotoPageController(index: index, item: item)
        }
        page.onSingleTap = { [weak self] in
            self?.toggleChrome()
        }
        page.onZoomChanged = { [weak self, weak page] zoomed in
            // Листание выключаем только по текущей странице: соседи зумиться не могут, а их
            // сброс зума при уходе не должен включать пейджер посреди чужого жеста.
            guard let self, let page, page === self.currentPage else { return }
            // Закрытие кнопкой в зуме ждёт, пока кадр вернётся к «вписано» — только тогда
            // копия для полёта получит рамку разумного размера.
            if !zoomed, let continuation = self.zoomResetContinuation {
                self.zoomResetContinuation = nil
                continuation()
            }
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
    private func applyStoreState(to page: PhotoViewerPage) {
        let item = page.item
        page.apply(thumb: store.thumb(for: item), full: store.full(for: item), state: store.state(for: item))
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
        updateCentralPage()
        updatePagingEnabled()
    }

    /// Кто сейчас центральный: только он играет, только его плитка в ленте спрятана и
    /// только у него видны свои кнопки. Воронка одна — её зовут и пейджер
    /// (didFinishAnimating), и прыжок по ленте миниатюр, и конец анимации открытия.
    private func updateCentralPage() {
        let current = pages[currentIndex]?.controller
        for entry in pages.values {
            guard let page = entry.controller, page !== current else { continue }
            // Уехавшее видео обязано замолчать: иначе после листания слышно два трека.
            page.didResignCurrent()
            page.setControlsVisible(false, animated: false)
        }
        current?.setControlsVisible(
            proxy.chromeVisible && !isDismissing && !dismissPanActive, animated: false
        )
        if didFinishOpenAnimation, !isDismissing { current?.didBecomeCurrent() }
        // Плитку-источник в ленте прячем ровно для текущего кадра: под открытым кадром и
        // под летящей копией не должно быть той же картинки.
        gallery.setHiddenTile?(current?.item)
    }

    /// Пейджер движется: палец тянет страницы, идёт инерция после отпускания или
    /// анимированный jump. Спрашиваем сам скролл-вью, а не храним флаг из willTransitionTo:
    /// парный didFinishAnimating приходит не всегда (отменённый в самом начале жест), и
    /// флаг залипал, навсегда блокируя свайп-закрытие и переходы по миниатюрам.
    private var isPagerMoving: Bool {
        if isJumping { return true }
        guard let scrollView = pagerScrollView else { return false }
        return scrollView.isDragging || scrollView.isDecelerating
    }

    /// То же плюс isTracking (палец лежит на пейджере, движения ещё нет) — для jump по
    /// миниатюре: менять страницы под лежащим пальцем нельзя. Для свайпа-закрытия
    /// isTracking не годится: он истинен для любого касания кадра, в том числе того,
    /// из которого свайп и рождается.
    private var isPagerBusy: Bool {
        isPagerMoving || (pagerScrollView?.isTracking ?? false)
    }

    /// Листание живёт, пока кадр не в зуме, не идёт свайп-закрытие и не летит jump. С одним
    /// фото пейджер только бы пружинил у краёв — тоже выключаем.
    private func updatePagingEnabled() {
        let zoomed = currentPage?.isZoomed ?? false
        pagerScrollView?.isScrollEnabled = gallery.items.count > 1
            && !zoomed && !dismissPanActive && !isDismissing && !isJumping
    }

    private func toggleChrome() {
        guard !isDismissing, !dismissPanActive else { return }
        proxy.chromeVisible.toggle()
        // Свои элементы управления страницы (у видео — полоса времени) живут вместе с
        // хромом: тап по кадру убирает с экрана всё разом.
        currentPage?.setControlsVisible(proxy.chromeVisible, animated: true)
    }

    // MARK: - Команды хрома

    private func jump(to index: Int, animated: Bool) {
        guard gallery.items.indices.contains(index), !isDismissing, !dismissPanActive else { return }
        guard index != currentIndex, !isPagerBusy else { return }
        let direction: UIPageViewController.NavigationDirection = index > currentIndex ? .forward : .reverse
        let previous = currentPage
        let target = pageController(at: index)
        previous?.resetZoom(animated: false)

        // Индекс публикуем сразу — лента миниатюр подсвечивает выбранную плитку в момент
        // тапа; цель грузим тоже сразу. А окно предзагрузки (и вытеснение дальних кадров)
        // сдвигаем только по концу анимации: иначе store снял бы полный кадр с уезжающей
        // страницы прямо на глазах.
        currentIndex = index
        if proxy.currentIndex != index {
            proxy.currentIndex = index
        }
        store.ensureLoaded(gallery.items[index])
        // Прыжок по ленте миниатюр — вторая воронка смены центрального кадра: didFinishAnimating
        // о ней не сообщит (currentIndex уже обновлён выше), поэтому зовём сами.
        updateCentralPage()

        if animated {
            // На время анимации пейджер заперт: палец на середине чужого перехода ставит
            // _UIQueuingScrollView в несогласованное состояние (не та страница после).
            isJumping = true
            updatePagingEnabled()
            pager.setViewControllers([target], direction: direction, animated: true) { [weak self] _ in
                guard let self else { return }
                self.isJumping = false
                self.store.prefetch(around: index)
                self.updatePagingEnabled()
                // Известная странность UIPageViewController: после анимированного
                // setViewControllers его внутренняя очередь иногда отстаёт от viewControllers,
                // и следующий свайп показывает не ту страницу. Повторная установка без
                // анимации приводит очередь в порядок; если пользователь уже листает дальше —
                // не трогаем.
                DispatchQueue.main.async { [weak self] in
                    guard let self, self.currentIndex == index, !self.isPagerMoving, !self.isDismissing else { return }
                    self.pager.setViewControllers([target], direction: direction, animated: false)
                }
            }
        } else {
            pager.setViewControllers([target], direction: direction, animated: false)
            store.prefetch(around: index)
            updatePagingEnabled()
        }
    }

    // MARK: - Открытие

    private func openIfNeeded() {
        guard !didOpen, let window = view.window, view.bounds.width > 0, view.bounds.height > 0 else { return }
        didOpen = true
        openedWindowSize = window.bounds.size
        // Страницам нужен реальный layout, чтобы отдать рамку «вписано» под полёт.
        view.layoutIfNeeded()
        if proxy.currentIndex != currentIndex {
            proxy.currentIndex = currentIndex
        }

        if let page = currentPage, let source = frameInView(fromWindow: gallery.sourceFrame, snapshot: true) {
            animateOpen(from: source, page: page)
        } else {
            animateFadeIn()
        }
    }

    /// Окно с момента открытия сменило размер (поворот, Stage Manager): любые оконные
    /// координаты плиток, снятые до этого, уже врут — лететь по ним нельзя.
    private var windowSizeChanged: Bool {
        guard let openedWindowSize, let window = view.window else { return true }
        return openedWindowSize != window.bounds.size
    }

    /// Рамка плитки (в координатах окна) → координаты нашей вью. nil — плитки нет, она вне
    /// экрана или вырождена. `snapshot` — рамка снята заранее (sourceFrame на момент
    /// открытия): такую после смены размера окна использовать нельзя, оконные координаты
    /// уже врут; рамка от sourceFrameProvider снимается прямо сейчас и годится всегда.
    private func frameInView(fromWindow frame: CGRect?, snapshot: Bool) -> CGRect? {
        guard let frame, view.window != nil else { return nil }
        if snapshot, windowSizeChanged { return nil }
        let rect = view.convert(frame, from: nil)
        guard rect.width > 1, rect.height > 1, rect.intersects(view.bounds) else { return nil }
        return rect
    }

    /// Куда лететь при закрытии. Если координатор дал sourceFrameProvider — верим только
    /// ему: он отдаёт актуальную рамку плитки ЭТОГО кадра (лента могла проскроллиться, а
    /// после листания закрывается уже другой кадр), а nil от него значит «плитки на экране
    /// нет» — тогда закрываемся уменьшением, а не летим в устаревшую стартовую рамку.
    /// Провайдера нет — стартовая рамка, но только для стартового кадра: для остальных
    /// она заведомо чужая.
    private func dismissTargetFrame(for page: PhotoViewerPage) -> CGRect? {
        if let provider = gallery.sourceFrameProvider {
            return frameInView(fromWindow: provider(page.item), snapshot: false)
        }
        let fallback: CGRect? = page.index == startIndex ? gallery.sourceFrame : nil
        return frameInView(fromWindow: fallback, snapshot: true)
    }

    private func animateOpen(from source: CGRect, page: PhotoViewerPage) {
        view.isUserInteractionEnabled = false
        let image = page.flightImage
        let target = page.contentFrameInWindow.map { view.convert($0, from: nil) }
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
            self.didFinishOpenAnimation = true
            // Хром поднимаем ДО updateCentralPage: тот раздаёт видимость своих кнопок
            // страницы по текущему proxy.chromeVisible, а revealChrome сначала гасит его —
            // иначе полоса времени видео вспыхнула бы без анимации и раньше остального
            // хрома. Страницы уже видимы, так что центральному видео можно играть.
            self.revealChrome()
            self.updateCentralPage()
            self.updatePagingEnabled()
        }
    }

    private func finishOpen(flight: UIView) {
        pager.view.alpha = 1
        // Копия гаснет поверх уже видимой страницы: если за время полёта подъехал полный
        // кадр, переход миниатюра → полный получается мягким, а не скачком резкости.
        UIView.animate(withDuration: 0.12, animations: { flight.alpha = 0 }) { _ in
            flight.removeFromSuperview()
        }
        // Пока закрытие не началось — иначе кнопка «назад», нажатая в полёте открытия,
        // уже выключила взаимодействие, и включать его обратно нельзя.
        guard !isDismissing else { return }
        view.isUserInteractionEnabled = true
        didFinishOpenAnimation = true
        // Порядок тот же, что в animateFadeIn: сначала хром (он гасит chromeVisible до
        // отложенного проявления), потом раздача видимости и старт видео.
        revealChrome()
        updateCentralPage()
        updatePagingEnabled()
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
            self.currentPage?.setControlsVisible(true, animated: true)
        }
    }

    // MARK: - Закрытие

    private func dismissViewer(velocity: CGPoint) {
        guard !isDismissing else { return }
        isDismissing = true
        endSwipe()
        view.isUserInteractionEnabled = false
        dismissPan.isEnabled = false
        pagerScrollView?.isScrollEnabled = false
        // Хром гаснет своей анимацией (0.2 с) параллельно с уходом кадра.
        proxy.chromeVisible = false
        // Видео замолкает сразу, до полёта кадра: «продолжает играть без звука после
        // свайпа вниз» (так делает Telegram) мы намеренно не переносим.
        for entry in pages.values {
            entry.controller?.prepareForDismiss()
        }

        guard let page = currentPage else {
            animateScaleFade(page: nil)
            return
        }

        // Закрытие кнопкой в зуме: рамка зумированного кадра может быть в разы больше
        // экрана, и копия для полёта такого размера — это отдельный слой на десятки
        // мегабайт плюс рывок. Сначала возвращаем кадр к «вписано» (анимация скролл-вью),
        // а летим уже из нормальной рамки. Скорость пальца здесь неуместна — её нет.
        if page.isZoomed {
            zoomResetContinuation = { [weak self, weak page] in
                guard let self, let page else { return }
                self.performDismissAnimation(page: page, velocity: .zero)
            }
            page.resetZoom(animated: true)
            // Страховка: если UIScrollView не отчитается о конце зума (или кадр уже на
            // пороге 1.01 и колбэк не придёт), закрываемся по таймеру.
            DispatchQueue.main.asyncAfter(deadline: .now() + Self.zoomResetTimeout) { [weak self] in
                guard let self, let continuation = self.zoomResetContinuation else { return }
                self.zoomResetContinuation = nil
                continuation()
            }
            return
        }

        performDismissAnimation(page: page, velocity: velocity)
    }

    private func performDismissAnimation(page: PhotoViewerPage, velocity: CGPoint) {
        guard !didFinishDismiss else { return }
        // Кнопка могла быть нажата, пока кадр ещё пружинит после свайпа: модельные
        // значения уже «на месте», а на экране кадр посреди пути. Снимаем реальное
        // положение с presentation-слоя, чтобы копия стартовала оттуда, где кадр виден.
        settleAnimatedState(page: page)

        let image = page.flightImage
        // Видео летит в плитку и без картинки: у секретного постера нет (сервер шифртекст
        // не раскадровывает), и копия улетает пустой плиткой в цвете подложки — ровно так
        // выглядит и сама плитка в ленте, стык не виден.
        if let target = dismissTargetFrame(for: page),
           let start = page.contentFrameInWindow.map({ view.convert($0, from: nil) }),
           image != nil || page.item.isVideo {
            animateFlyBack(image: image, from: start, to: target, velocity: velocity)
        } else {
            animateScaleFade(page: page)
        }
    }

    /// Переносит в модель то, что сейчас реально на экране (presentation-слой), и снимает
    /// анимации. Нужно всякий раз, когда новое движение перехватывает незавершённое:
    /// палец ловит пружину возврата или кнопка закрытия нажата во время неё. Без этого
    /// removeAllAnimations мгновенно ставит кадр в модельное положение — заметный скачок.
    private func settleAnimatedState(page: PhotoViewerPage) {
        let zoomLayer = page.animatedContent.layer
        if zoomLayer.animationKeys()?.isEmpty == false, let presentation = zoomLayer.presentation() {
            page.animatedContent.transform = presentation.affineTransform()
        }
        if backdrop.layer.animationKeys()?.isEmpty == false, let presentation = backdrop.layer.presentation() {
            backdrop.alpha = CGFloat(presentation.opacity)
        }
        zoomLayer.removeAllAnimations()
        backdrop.layer.removeAllAnimations()
    }

    /// Кадр летит в плитку. Рамка старта снята с живой страницы через imageFrameInWindow —
    /// она уже учитывает сдвиг и масштаб свайпа, поэтому копия подхватывает кадр ровно
    /// там, где он сейчас на экране.
    private func animateFlyBack(image: UIImage?, from start: CGRect, to target: CGRect, velocity: CGPoint) {
        let flight = makeFlightView(image: image)
        flight.frame = start
        flight.backgroundColor = tileBackground.withAlphaComponent(0)
        view.addSubview(flight)
        pager.view.alpha = 0

        // Начальная скорость пружины у UIKit — в долях расстояния в секунду: берём проекцию
        // скорости пальца на направление к плитке. После свайпа кадр не спотыкается на
        // старте анимации, а продолжает движение; при закрытии кнопкой стартует с нуля.
        let dx = target.midX - start.midX
        let dy = target.midY - start.midY
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
            flight.frame = target
            flight.backgroundColor = self.tileBackground
            self.backdrop.alpha = 0
        } completion: { [weak self] _ in
            // Плитку возвращаем ДО снятия копии, а саму копию — следующим витком рунлупа:
            // между «копия снята» и «плитка нарисована» иначе виден кадр пустого места.
            self?.gallery.setHiddenTile?(nil)
            DispatchQueue.main.async {
                flight.removeFromSuperview()
                self?.finishDismiss()
            }
        }
    }

    /// Нет плитки, куда лететь (плитка ушла с экрана, поворот, кадр не загружен) —
    /// уменьшение с затуханием; после свайпа продолжает уже набранные сдвиг и масштаб.
    private func animateScaleFade(page: PhotoViewerPage?) {
        UIView.animate(withDuration: Self.scaleFadeDuration, delay: 0, options: [.curveEaseOut, .beginFromCurrentState]) {
            if let page {
                page.animatedContent.transform = page.animatedContent.transform.scaledBy(x: 0.85, y: 0.85)
            }
            self.pager.view.alpha = 0
            self.backdrop.alpha = 0
        } completion: { [weak self] _ in
            self?.finishDismiss()
        }
    }

    private func finishDismiss() {
        // Один раз: обёртка снимает fullScreenCover, и после этого контроллер — мёртвый
        // объект, которому ничего не должно приходить. Ожидающее продолжение закрытия
        // (сброс зума) на всякий случай снимаем.
        guard !didFinishDismiss else { return }
        didFinishDismiss = true
        // Безусловная страховка от залипшей дыры в ленте: любой путь закрытия (полёт,
        // затухание, поворот, удалённое сообщение) обязан вернуть плитку на место.
        gallery.setHiddenTile?(nil)
        zoomResetContinuation = nil
        storeSubscription = nil
        proxy.jump = nil
        proxy.requestDismiss = nil
        // Экран уже пуст — обёртка снимает fullScreenCover без своей анимации.
        onDismissed()
    }

    // MARK: - Свайп-закрытие

    @objc private func handleDismissPan(_ pan: UIPanGestureRecognizer) {
        switch pan.state {
        case .began:
            // shouldBegin уже отсёк закрытие и пустой пейджер; это страховка от гонки:
            // без swipePage последующие .changed просто игнорируются.
            guard let page = currentPage, !isDismissing else { return }
            // Жест признан после гистерезиса ~10 pt: обнуляем translation, иначе первый
            // .changed рывком сдвинул бы кадр на эти 10 pt.
            pan.setTranslation(.zero, in: view)
            dismissPanActive = true
            swipePage = page
            // Пока кадр тянут, скролл-вью зума и тапы страницы не должны видеть касание:
            // иначе двойной тап или пинч посреди свайпа ломают геометрию.
            page.gesturesEnabled = false
            // Свои кнопки страницы на время свайпа убираем: они плыли бы вместе с кадром.
            page.setControlsVisible(false, animated: true)
            updatePagingEnabled()
            // Если пружина возврата от прошлого свайпа ещё идёт — палец важнее: берём
            // положение с экрана и продолжаем с него.
            settleAnimatedState(page: page)
            let current = page.animatedContent.transform
            swipeBaseOffset = CGPoint(x: current.tx, y: current.ty)

        case .changed:
            guard let page = swipePage, !isDismissing else { return }
            let offset = totalOffset(pan)
            let distance = abs(offset.y)
            let scale = 1 - 0.3 * min(distance / Self.scaleDistance, 1)
            // Кадр идёт за пальцем по обеим осям и уменьшается вокруг своего центра, а фон
            // и хром гаснут заметно быстрее пальца — на 80 и 50 pt соответственно.
            page.animatedContent.transform = CGAffineTransform(translationX: offset.x, y: offset.y)
                .scaledBy(x: scale, y: scale)
            backdrop.alpha = 1 - min(distance / Self.backdropFadeDistance, 1)
            proxy.dismissProgress = min(distance / Self.chromeFadeDistance, 1)

        case .ended, .cancelled, .failed:
            let page = swipePage
            let offset = totalOffset(pan)
            let velocity = pan.velocity(in: view)
            endSwipe()
            guard let page, !isDismissing else { return }
            // По скорости закрываем только если флик сонаправлен смещению: оттянул вниз и
            // резко бросил вверх — это «передумал», кадр возвращается. Сильный обратный
            // флик перевешивает и порог по расстоянию.
            let coDirected = offset.y * velocity.y >= 0
            let strongFlick = abs(velocity.y) > Self.dismissVelocity
            let shouldClose = pan.state == .ended
                && ((abs(offset.y) > Self.dismissDistance && (coDirected || !strongFlick))
                    || (coDirected && strongFlick))
            if shouldClose {
                dismissViewer(velocity: velocity)
            } else {
                snapBack(page: page)
            }

        default:
            break
        }
    }

    /// Смещение кадра = база на момент начала жеста + путь пальца.
    private func totalOffset(_ pan: UIPanGestureRecognizer) -> CGPoint {
        let translation = pan.translation(in: view)
        return CGPoint(x: swipeBaseOffset.x + translation.x, y: swipeBaseOffset.y + translation.y)
    }

    /// Снять состояние свайпа и вернуть странице её жесты — вызывается и по концу жеста,
    /// и при закрытии, чтобы страница не осталась «глухой», если жест оборвали.
    private func endSwipe() {
        dismissPanActive = false
        swipePage?.gesturesEnabled = true
        swipePage = nil
        swipeBaseOffset = .zero
    }

    private func snapBack(page: PhotoViewerPage) {
        UIView.animate(
            withDuration: Self.snapBackDuration,
            delay: 0,
            usingSpringWithDamping: 0.8,
            initialSpringVelocity: 0,
            options: [.beginFromCurrentState, .allowUserInteraction]
        ) {
            page.animatedContent.transform = .identity
            self.backdrop.alpha = 1
        }
        // Сам по себе dismissProgress SwiftUI не анимирует — просим явно, чтобы хром
        // возвращался плавно, а не вспыхивал.
        withAnimation(.easeOut(duration: 0.2)) {
            proxy.dismissProgress = 0
        }
        page.setControlsVisible(proxy.chromeVisible, animated: true)
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
    /// если пейджер не движется. Одновременность с pan пейджера не разрешаем:
    /// когда наш жест начинается, UIKit отменяет чужой, и наоборот.
    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        guard gestureRecognizer === dismissPan else { return true }
        guard !isDismissing, !isPagerMoving, let page = currentPage, !page.isZoomed else { return false }
        // Палец лёг на полосу времени видео — это перемотка, а не закрытие: UISlider ведёт
        // касание сам, и признанный pan просто отменил бы его.
        if page.ignoresDismissPan(at: dismissPan.location(in: page.view)) { return false }
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
        guard let page = viewController as? PhotoViewerPage, page.index > 0 else { return nil }
        return pageController(at: page.index - 1)
    }

    func pageViewController(
        _ pageViewController: UIPageViewController,
        viewControllerAfter viewController: UIViewController
    ) -> UIViewController? {
        guard let page = viewController as? PhotoViewerPage,
              page.index + 1 < gallery.items.count else { return nil }
        return pageController(at: page.index + 1)
    }
}

extension PhotoViewerController: UIPageViewControllerDelegate {

    func pageViewController(
        _ pageViewController: UIPageViewController,
        didFinishAnimating finished: Bool,
        previousViewControllers: [UIViewController],
        transitionCompleted completed: Bool
    ) {
        guard let current = currentPage else { return }
        // Ушедшая страница возвращается к «вписано»: вернувшись к ней, пользователь ждёт
        // целый кадр, а не прошлый зум.
        for case let previous as PhotoViewerPage in previousViewControllers where previous !== current {
            previous.resetZoom(animated: false)
        }
        if completed, current.index != currentIndex {
            pageDidBecomeCurrent(current.index)
        } else {
            updatePagingEnabled()
        }
    }
}

// MARK: - Страница

/// Общий контракт страниц пейджера: фото (PhotoPageController ниже) и видео
/// (VideoPageController в VideoPage.swift). Контроллер знает только базу — поэтому свайп-
/// закрытие, полёт кадра в плитку, арбитраж жестов и переключение страниц у фото и видео
/// одни и те же, а «уметь зум» или «уметь играть» остаётся частным делом страницы.
///
/// Отдельный контроллер на страницу нужен только потому, что UIPageViewController оперирует
/// контроллерами, а не вью.
class PhotoViewerPage: UIViewController {

    let index: Int
    let item: PhotoViewerItem

    /// Одиночный тап по кадру (показать/скрыть хром). Кнопки страницы свои тапы съедают
    /// сами, поэтому в хром они не проходят.
    var onSingleTap: (() -> Void)?
    /// Кадр вошёл в зум или вышел из него — по этому контроллер гасит листание. Видео не
    /// зумится и колбэк не зовёт.
    var onZoomChanged: ((Bool) -> Void)?

    init(index: Int, item: PhotoViewerItem) {
        self.index = index
        self.item = item
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("Страницы просмотрщика создаются только кодом")
    }

    /// Вью, которой контроллер вешает transform свайпа-закрытия и анимации. Именно не
    /// корневая: корнем владеет пейджер (_UIQueuingScrollView присваивает ему frame при
    /// каждом layout, а frame у вью с transform ≠ identity не определён).
    var animatedContent: UIView { view }

    var isZoomed: Bool { false }

    /// Жесты страницы разом: контроллер гасит их на время свайпа-закрытия, чтобы второй
    /// палец не начал зум под летящим кадром.
    var gesturesEnabled: Bool = true {
        didSet {
            guard gesturesEnabled != oldValue else { return }
            gesturesEnabledDidChange()
        }
    }

    func gesturesEnabledDidChange() {}

    func resetZoom(animated: Bool) {}

    /// Картинка для летящей копии: кадр фото либо постер видео. nil — копия летит пустой
    /// плиткой в цвете подложки (так выглядит и сама плитка в ленте).
    var flightImage: UIImage? { nil }

    /// Рамка видимого кадра в координатах окна — старт полёта при закрытии.
    var contentFrameInWindow: CGRect? { nil }

    /// Новое знание store об этом кадре.
    func apply(thumb: UIImage?, full: UIImage?, state: PhotoViewerLoadState) {}

    /// Страница стала центральной / перестала ею быть. На этом видео стартует и встаёт на
    /// паузу; фото не делает ничего.
    func didBecomeCurrent() {}
    func didResignCurrent() {}

    /// Свои элементы управления страницы (у видео — Play и полоса времени) показываются и
    /// гаснут вместе с хромом просмотрщика.
    func setControlsVisible(_ visible: Bool, animated: Bool) {}

    /// Просмотрщик закрывается — остановить воспроизведение до начала полёта кадра.
    func prepareForDismiss() {}

    /// Точка в координатах страницы, из которой свайп-закрытие начинать нельзя (полоса
    /// перемотки видео). Точка — в системе координат `view`.
    func ignoresDismissPan(at point: CGPoint) -> Bool { false }
}

/// Страница с фото: тонкая обёртка над ZoomableImageView.
///
/// Корневая view — пустой контейнер, а zoomView лежит внутри: transform и alpha свайпа
/// вешаются только на zoomView (см. animatedContent в базе).
private final class PhotoPageController: PhotoViewerPage {

    let zoomView = ZoomableImageView()

    override init(index: Int, item: PhotoViewerItem) {
        super.init(index: index, item: item)
        // Пропорции из метаданных вложения: страница занимает верную геометрию до
        // прихода картинок, и полный кадр потом не прыгает.
        zoomView.setAspect(item.aspectSize)
        zoomView.onSingleTap = { [weak self] in self?.onSingleTap?() }
        zoomView.onZoomChanged = { [weak self] zoomed in self?.onZoomChanged?(zoomed) }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("Страницы просмотрщика создаются только кодом")
    }

    override func loadView() {
        let container = PhotoViewerPageContainer()
        container.backgroundColor = .clear
        container.content = zoomView
        container.addSubview(zoomView)
        view = container
    }

    override var animatedContent: UIView { zoomView }

    override var isZoomed: Bool { zoomView.isZoomed }

    override func gesturesEnabledDidChange() {
        zoomView.gesturesEnabled = gesturesEnabled
    }

    override func resetZoom(animated: Bool) {
        zoomView.resetZoom(animated: animated)
    }

    override var flightImage: UIImage? { zoomView.currentImage }

    override var contentFrameInWindow: CGRect? { zoomView.imageFrameInWindow }

    /// setThumb/setFull сравнивают картинку по identity, поэтому повторные вызовы бесплатны.
    override func apply(thumb: UIImage?, full: UIImage?, state: PhotoViewerLoadState) {
        zoomView.setThumb(thumb)
        zoomView.setFull(full)
        zoomView.setFailed(state == .failed && full == nil ? "" : nil)
        // Спиннер сам прячется, как только есть хоть какая-то картинка (ZoomableImageView).
        zoomView.setLoading(state != .failed)
    }
}

/// Контейнер страницы раздаёт содержимому размер через bounds + center, а не frame /
/// autoresizingMask: эти два свойства определены и при transform ≠ identity, поэтому
/// поворот или перекладка пейджера посреди свайпа (пока transform ещё не снят) не
/// портят геометрию кадра. `onLayout` нужен видео: после смены размера страницы ему надо
/// заново вписать кадр и переложить свои кнопки.
final class PhotoViewerPageContainer: UIView {
    weak var content: UIView?
    var onLayout: (() -> Void)?

    override func layoutSubviews() {
        super.layoutSubviews()
        if let content {
            content.bounds = CGRect(origin: .zero, size: bounds.size)
            content.center = CGPoint(x: bounds.midX, y: bounds.midY)
        }
        onLayout?()
    }
}
