import SwiftUI
import UIKit

/// Лента переписки.
///
/// Раньше здесь был SwiftUI-`ScrollView` с `LazyVStack`. От него пришлось отказаться:
/// у него нет ни детерминированной позиции, ни способа вставить страницу истории без
/// рывка. Всё держалось на догадках — прицел по невидимому маркеру, роли якорей,
/// повторные `scrollTo` — и лента то прыгала, то открывалась пустой, то переставала
/// липнуть к низу.
///
/// Теперь под лентой `UICollectionView` с diffable-источником, а содержимое ячеек
/// по-прежнему рисует SwiftUI (`UIHostingConfiguration`), так что вид сообщений остался
/// прежним. Взамен появились три вещи, которых в SwiftUI просто нет:
///
///  * позиция считается арифметикой (`contentOffset` против `contentSize`), а не
///    угадывается по геометрии;
///  * страница истории вклеивается со сдвигом `contentOffset` ровно на прирост высоты —
///    видимое место не двигается вообще;
///  * прокрутка родная, ей не мешают жесты внутри ячеек.
struct MessageListView: View {

    @ObservedObject var vm: ChatViewModel
    let pinToken: Int
    let sendToken: Int
    let onForward: (Message) -> Void
    let onOpenImage: ([MessageAttachment], Int) -> Void
    let onOpenSender: (Message) -> Void
    let onOpenAttachment: (MessageAttachment) -> Void
    let onEdit: (Message) -> Void
    let onPickReaction: (Message) -> Void
    let onLongPress: (Message) -> Void
    let quickSlots: [String]

    @StateObject private var proxy = MessageListProxy()
    @State private var jumpTask: Task<Void, Never>?
    @State private var jumpNotice: String?

    var body: some View {
        MessageListRepresentable(
            rows: rows,
            proxy: proxy,
            actions: MessageRowActions(
                onQuoteTap: { jumpToQuote($0) },
                onTap: { message in if vm.ui.selectionMode { vm.toggleSelect(message.id) } },
                onLongPress: onLongPress,
                onForward: onForward,
                onOpenImage: onOpenImage,
                onOpenSender: onOpenSender,
                onOpenAttachment: onOpenAttachment,
                onReply: { vm.setReply($0) },
                onReact: { message, emoji in vm.react(message, emoji: emoji) },
                onPickReaction: onPickReaction,
                onEdit: onEdit,
                onDelete: { vm.delete(messageId: $0.id) },
                decryptSecretAttachment: vm.ui.isSecret ? { await vm.decryptSecretAttachment($0) } : nil
            ),
            onReachedTop: { loadOlderIfPossible() },
            onPrependHandled: { vm.releasePrepending() }
        )
        .overlay(alignment: .top) {
            if let notice = jumpNotice ?? (vm.ui.loadingOlder ? "Загружаем…" : nil) {
                Text(notice)
                    .font(.footnote)
                    .foregroundStyle(Eb.textMuted)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 5)
                    .background(Eb.surface200.opacity(0.95), in: Capsule())
                    .padding(.top, 6)
                    .transition(.opacity)
            }
        }
        .overlay(alignment: .bottomTrailing) { scrollDownButton }
        .animation(.easeOut(duration: 0.15), value: vm.ui.loadingOlder)
        .onChange(of: pinToken) { _, _ in
            // Клавиатура и рост композера: возвращаем низ, только если там и были.
            guard proxy.atBottom else { return }
            proxy.scrollToBottom(animated: false)
        }
        .onChange(of: sendToken) { _, _ in
            // Своё сообщение обязано оказаться на виду, даже если читали историю.
            proxy.followNextMessage = true
            proxy.scrollToBottom(animated: true)
        }
        .onDisappear { jumpTask?.cancel() }
    }

    // MARK: - Модель строк

    /// Строки считаются один раз за проход: соседи по «рану» и разделители дней.
    private var rows: [MessageRowModel] {
        // Удалённые не показываем — как в вебе.
        let messages = vm.ui.messages.filter { !$0.deleted }
        guard !messages.isEmpty else { return [] }
        // Смещение часового пояса берём один раз: Calendar на каждое сообщение стоил
        // дороже всего остального в этом проходе.
        let tzOffset = Int64(TimeZone.current.secondsFromGMT())
        func dayIndex(_ millis: Int64) -> Int64 { (millis / 1000 + tzOffset) / 86_400 }

        var names: [String: String] = [:]
        for message in messages where !message.senderName.isEmpty {
            names[message.senderId] = message.senderName
        }

        return messages.enumerated().map { index, message in
            let earlier = index > 0 ? messages[index - 1] : nil
            let later = index + 1 < messages.count ? messages[index + 1] : nil
            let newDay = earlier.map { dayIndex($0.createdAt) != dayIndex(message.createdAt) } ?? true
            return MessageRowModel(
                message: message,
                isGroup: vm.ui.isGroup,
                senderAvatarUrl: vm.ui.senderAvatars[message.senderId] ?? nil,
                senderNames: names,
                isFirstInRun: !continuesRun(earlier, message),
                isLastInRun: !continuesRun(message, later),
                dayHeader: newDay ? formatMessageDay(message.createdAt) : nil,
                selectionMode: vm.ui.selectionMode,
                selected: vm.ui.selectedIds.contains(message.id),
                highlighted: message.id == proxy.highlightedId,
                quickSlots: quickSlots
            )
        }
    }

    private var scrollDownButton: some View {
        Button {
            jumpTask?.cancel()
            jumpNotice = nil
            proxy.scrollToBottom(animated: true)
        } label: {
            Image(systemName: "chevron.down")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 40, height: 40)
                .background(Eb.brand, in: Circle())
                .shadow(color: .black.opacity(0.3), radius: 6, y: 2)
        }
        .buttonStyle(.plain)
        .padding(.trailing, 14)
        .padding(.bottom, 12)
        .opacity(proxy.showScrollDown ? 1 : 0)
        .animation(.easeOut(duration: 0.15), value: proxy.showScrollDown)
        .allowsHitTesting(proxy.showScrollDown)
    }

    // MARK: - Подгрузка истории и переход к цитате

    private func loadOlderIfPossible() {
        guard !proxy.jumping, vm.ui.hasMore, !vm.ui.loadingOlder, !vm.ui.prepending else { return }
        vm.loadOlder()
    }

    /// Сервер умеет только «страницу назад по курсору», поэтому оригинал старше
    /// загруженного достаётся страницами, а потом лента прыгает к нему по индексу.
    private func jumpToQuote(_ targetId: String) {
        jumpTask?.cancel()
        jumpTask = Task { @MainActor in
            proxy.jumping = true
            proxy.highlightedId = nil
            defer {
                proxy.jumping = false
                jumpNotice = nil
            }
            var found = vm.ui.messages.contains { $0.id == targetId }
            if !found {
                jumpNotice = "Ищем сообщение…"
                found = await vm.loadUntil(messageId: targetId)
            }
            if Task.isCancelled { return }
            guard found else {
                jumpNotice = "Сообщение не найдено"
                try? await Task.sleep(for: .seconds(1.5))
                return
            }
            jumpNotice = nil
            // Кадр на применение снимка, затем точный прыжок по индексу.
            try? await Task.sleep(for: .milliseconds(60))
            proxy.scrollToMessage(targetId)
            proxy.highlightedId = targetId
            try? await Task.sleep(for: .seconds(1.6))
            if proxy.highlightedId == targetId { proxy.highlightedId = nil }
        }
    }
}

// MARK: - Модель строки и действия

/// Всё, что нужно ячейке для отрисовки. Equatable — чтобы понимать, изменилась ли строка
/// и надо ли её переконфигурировать.
struct MessageRowModel: Identifiable, Equatable {
    let message: Message
    let isGroup: Bool
    let senderAvatarUrl: String?
    let senderNames: [String: String]
    let isFirstInRun: Bool
    let isLastInRun: Bool
    let dayHeader: String?
    let selectionMode: Bool
    let selected: Bool
    let highlighted: Bool
    let quickSlots: [String]

    var id: String { message.id }
}

/// Замыкания живут в контроллере и не участвуют в сравнении строк — иначе каждая ячейка
/// считалась бы изменившейся на каждом проходе.
struct MessageRowActions {
    let onQuoteTap: (String) -> Void
    let onTap: (Message) -> Void
    let onLongPress: (Message) -> Void
    let onForward: (Message) -> Void
    let onOpenImage: ([MessageAttachment], Int) -> Void
    let onOpenSender: (Message) -> Void
    let onOpenAttachment: (MessageAttachment) -> Void
    let onReply: (Message) -> Void
    let onReact: (Message, String) -> Void
    let onPickReaction: (Message) -> Void
    let onEdit: (Message) -> Void
    let onDelete: (Message) -> Void
    let decryptSecretAttachment: ((MessageAttachment) async -> URL?)?
}

/// Мост между SwiftUI-обёрткой и UIKit-контроллером: наружу отдаёт состояние для кнопки
/// «вниз» и подсветку, внутрь — команды прокрутки.
@MainActor
final class MessageListProxy: ObservableObject {
    /// Лента у последнего сообщения.
    @Published var atBottom = true
    /// Кнопку «вниз» показываем, только когда есть куда листать И мы не внизу.
    @Published var showScrollDown = false
    /// Подсветка после перехода по цитате.
    @Published var highlightedId: String?
    /// Идёт переход к цитате: подгрузка истории на это время молчит.
    var jumping = false
    /// Следующее пришедшее сообщение утягивает ленту вниз независимо от позиции.
    var followNextMessage = false

    var scrollToBottomAction: ((Bool) -> Void)?
    var scrollToMessageAction: ((String) -> Void)?

    func scrollToBottom(animated: Bool) { scrollToBottomAction?(animated) }
    func scrollToMessage(_ id: String) { scrollToMessageAction?(id) }
}

// MARK: - UIKit-лента

private struct MessageListRepresentable: UIViewControllerRepresentable {

    let rows: [MessageRowModel]
    let proxy: MessageListProxy
    let actions: MessageRowActions
    let onReachedTop: () -> Void
    let onPrependHandled: () -> Void

    func makeUIViewController(context: Context) -> MessageListController {
        let controller = MessageListController()
        controller.actions = actions
        controller.proxy = proxy
        controller.onReachedTop = onReachedTop
        controller.onPrependHandled = onPrependHandled
        proxy.scrollToBottomAction = { [weak controller] animated in
            controller?.scrollToBottom(animated: animated)
        }
        proxy.scrollToMessageAction = { [weak controller] id in
            controller?.scroll(to: id)
        }
        return controller
    }

    func updateUIViewController(_ controller: MessageListController, context: Context) {
        controller.actions = actions
        controller.onReachedTop = onReachedTop
        controller.onPrependHandled = onPrependHandled
        controller.apply(rows: rows)
    }
}

/// Контроллер ленты: коллекция, источник и вся арифметика позиции.
@MainActor
final class MessageListController: UIViewController {

    var actions: MessageRowActions?
    var proxy: MessageListProxy?
    var onReachedTop: (() -> Void)?
    var onPrependHandled: (() -> Void)?

    /// Насколько близко к низу считается «мы внизу» — примерно один пузырь.
    private static let bottomThreshold: CGFloat = 80
    /// За сколько экранов до верха просить следующую страницу истории.
    private static let topTriggerScreens: CGFloat = 1.5

    private var collectionView: UICollectionView!
    private var dataSource: UICollectionViewDiffableDataSource<Int, String>!
    private var rows: [MessageRowModel] = []
    private var rowsById: [String: MessageRowModel] = [:]
    /// Первый непустой снимок уже применён и лента поставлена на низ.
    private var didInitialLayout = false
    /// Расстояние от точки просмотра до низа содержимого, снятое ДО вклейки страницы.
    private var pendingPrependAnchor: CGFloat?
    /// Высота вью в прошлой раскладке: по её изменению видно выезд клавиатуры.
    private var lastBoundsHeight: CGFloat = 0
    /// Были ли мы внизу ДО изменения раскладки. Считать после уже поздно: клавиатура
    /// сжала вьюпорт, и позиция формально перестала быть «низом».
    private var wasAtBottomBeforeLayout = true
    /// Базовый верхний отступ ленты.
    private static let basePadding: CGFloat = 8
    /// Свайп-ответ: порог срабатывания и предел протяжки (как в прежней версии).
    private static let replyThreshold: CGFloat = 56
    private static let replyMaxDrag: CGFloat = 84

    /// Строка, которую сейчас тянут вбок.
    private var swipingIndexPath: IndexPath?
    /// Стрелка ответа, проявляющаяся за пузырём по мере протяжки.
    private lazy var replyIndicator: UIImageView = {
        let image = UIImage(systemName: "arrowshape.turn.up.left.fill")
        let view = UIImageView(image: image)
        view.tintColor = UIColor(Eb.brand)
        view.alpha = 0
        view.isUserInteractionEnabled = false
        return view
    }()

    override func viewDidLoad() {
        super.viewDidLoad()
        setUpCollectionView()
        setUpDataSource()
    }

    private func setUpCollectionView() {
        var configuration = UICollectionLayoutListConfiguration(appearance: .plain)
        configuration.showsSeparators = false
        configuration.backgroundColor = .clear
        let layout = UICollectionViewCompositionalLayout.list(using: configuration)

        collectionView = UICollectionView(frame: .zero, collectionViewLayout: layout)
        collectionView.backgroundColor = .clear
        // До первой установки позиции лента невидима: иначе на долю секунды виден кадр,
        // где она стоит наверху, а следом рывок к последнему сообщению.
        collectionView.alpha = 0
        collectionView.delegate = self
        collectionView.alwaysBounceVertical = true
        collectionView.keyboardDismissMode = .interactive
        // Ячейки сами по себе не выделяются: выбор сообщений живёт в нашем UI.
        collectionView.allowsSelection = false
        collectionView.contentInsetAdjustmentBehavior = .never
        collectionView.contentInset = UIEdgeInsets(top: 8, left: 0, bottom: 8, right: 0)
        collectionView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(collectionView)
        collectionView.addSubview(replyIndicator)

        // Свайп-ответ живёт на самой коллекции, а не на каждой ячейке: начинается только
        // при явно горизонтальном движении и идёт одновременно с прокруткой, поэтому
        // палец на сообщении по-прежнему листает ленту.
        let replyPan = UIPanGestureRecognizer(target: self, action: #selector(handleReplyPan(_:)))
        replyPan.delegate = self
        collectionView.addGestureRecognizer(replyPan)
        NSLayoutConstraint.activate([
            collectionView.topAnchor.constraint(equalTo: view.topAnchor),
            collectionView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            collectionView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            collectionView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])
    }

    private func setUpDataSource() {
        let registration = UICollectionView.CellRegistration<UICollectionViewListCell, String> {
            [weak self] cell, _, id in
            guard let self, let model = self.rowsById[id] else { return }
            cell.backgroundConfiguration = .clear()
            // Ячейка могла приехать из переиспользования со сдвигом от свайпа.
            cell.contentView.transform = .identity
            cell.contentConfiguration = UIHostingConfiguration {
                MessageCell(model: model, actions: self.actions)
            }
            // Отступы задаёт сам пузырь — системные поля списка тут лишние.
            .margins(.all, 0)
        }

        dataSource = UICollectionViewDiffableDataSource<Int, String>(collectionView: collectionView) {
            view, indexPath, id in
            view.dequeueConfiguredReusableCell(using: registration, for: indexPath, item: id)
        }
    }

    // MARK: - Применение снимка

    func apply(rows newRows: [MessageRowModel]) {
        let previous = rows
        guard previous != newRows else { return }
        rows = newRows
        rowsById = Dictionary(uniqueKeysWithValues: newRows.map { ($0.id, $0) })
        // Пустая переписка: показывать нечего, но и прятать ленту незачем.
        if newRows.isEmpty { reveal() }

        let wasAtBottom = isAtBottom
        let follow = proxy?.followNextMessage ?? false
        // Вставка сверху: запоминаем расстояние до низа ДО применения, чтобы после
        // вклейки вернуть ровно ту же точку — видимое место не сдвинется вовсе.
        if isPrepend(previous: previous, next: newRows) {
            collectionView.layoutIfNeeded()
            pendingPrependAnchor = collectionView.contentSize.height - collectionView.contentOffset.y
        }

        var snapshot = NSDiffableDataSourceSnapshot<Int, String>()
        snapshot.appendSections([0])
        snapshot.appendItems(newRows.map(\.id))
        // Переконфигурируем только изменившиеся строки: правка, реакция, галочки,
        // подсветка, режим выбора.
        var previousById: [String: MessageRowModel] = [:]
        for row in previous { previousById[row.id] = row }
        let changed = newRows.compactMap { row -> String? in
            guard let old = previousById[row.id] else { return nil }
            return old == row ? nil : row.id
        }
        if !changed.isEmpty { snapshot.reconfigureItems(changed) }

        let isFirst = !didInitialLayout && !newRows.isEmpty
        let countChanged = previous.count != newRows.count
        dataSource.apply(snapshot, animatingDifferences: false) { [weak self] in
            guard let self else { return }
            if let anchor = self.pendingPrependAnchor {
                self.pendingPrependAnchor = nil
                self.collectionView.layoutIfNeeded()
                let target = self.collectionView.contentSize.height - anchor
                self.collectionView.setContentOffset(CGPoint(x: 0, y: target), animated: false)
                self.onPrependHandled?()
            } else if isFirst {
                self.didInitialLayout = true
                self.scrollToBottom(animated: false)
                // Повторная доводка: ячейки досчитывают высоту после первой раскладки.
                // Показываем ленту только после неё — тогда открытие выглядит как сразу
                // готовый экран, без промежуточных кадров.
                DispatchQueue.main.async { [weak self] in
                    self?.scrollToBottom(animated: false)
                    self?.reveal()
                }
            } else if follow {
                self.proxy?.followNextMessage = false
                self.scrollToBottom(animated: true)
            } else if wasAtBottom, countChanged {
                self.scrollToBottom(animated: true)
            }
            self.updateTopInsetForShortContent()
            self.updatePosition()
        }
    }

    /// Страница истории — это когда сверху появились новые строки, а прежняя первая
    /// строка осталась в списке.
    private func isPrepend(previous: [MessageRowModel], next: [MessageRowModel]) -> Bool {
        guard let oldFirst = previous.first, next.count > previous.count else { return false }
        guard let newIndex = next.firstIndex(where: { $0.id == oldFirst.id }) else { return false }
        return newIndex > 0
    }

    // MARK: - Позиция

    /// Короткую переписку веб и Android показывают прижатой к НИЗУ, а коллекция по
    /// умолчанию кладёт её сверху. Дотягиваем верхним отступом на недостающую высоту.
    private func updateTopInsetForShortContent() {
        let contentHeight = collectionView.collectionViewLayout.collectionViewContentSize.height
        let free = collectionView.bounds.height - contentHeight - Self.basePadding
        let top = max(Self.basePadding, free)
        guard abs(collectionView.contentInset.top - top) > 0.5 else { return }
        let wasAtBottom = isAtBottom
        collectionView.contentInset.top = top
        if wasAtBottom { scrollToBottom(animated: false) }
    }

    private var maxOffset: CGFloat {
        collectionView.contentSize.height + collectionView.contentInset.bottom
            - collectionView.bounds.height
    }

    private var isAtBottom: Bool {
        guard collectionView != nil else { return true }
        return collectionView.contentOffset.y >= maxOffset - Self.bottomThreshold
    }

    private var canScroll: Bool {
        maxOffset > -collectionView.contentInset.top + 1
    }

    /// Позиция «самый низ» с учётом отступов.
    private var bottomOffset: CGFloat {
        max(maxOffset, -collectionView.contentInset.top)
    }

    func scrollToBottom(animated: Bool) {
        guard !rows.isEmpty else { return }
        collectionView.layoutIfNeeded()
        // Ниже содержимого уехать невозможно: цель ограничена снизу верхним отступом.
        collectionView.setContentOffset(CGPoint(x: 0, y: bottomOffset), animated: animated)
        if !animated { updatePosition() }
    }

    func scroll(to messageId: String) {
        guard let index = rows.firstIndex(where: { $0.id == messageId }) else { return }
        collectionView.scrollToItem(
            at: IndexPath(item: index, section: 0), at: .centeredVertically, animated: true
        )
    }

    // MARK: - Свайп-ответ

    @objc private func handleReplyPan(_ recognizer: UIPanGestureRecognizer) {
        switch recognizer.state {
        case .began:
            let point = recognizer.location(in: collectionView)
            guard let indexPath = collectionView.indexPathForItem(at: point),
                  indexPath.item < rows.count,
                  !rows[indexPath.item].message.isSystem,
                  !rows[indexPath.item].selectionMode
            else {
                swipingIndexPath = nil
                return
            }
            swipingIndexPath = indexPath
            layoutReplyIndicator(for: indexPath)

        case .changed:
            guard let indexPath = swipingIndexPath,
                  let cell = collectionView.cellForItem(at: indexPath),
                  indexPath.item < rows.count
            else { return }
            // Входящие тянутся вправо, свои — влево (свои пузыри прижаты к правому краю).
            let isMine = rows[indexPath.item].message.isMine
            let raw = recognizer.translation(in: collectionView).x
            let dx = isMine
                ? min(max(raw, -Self.replyMaxDrag), 0)
                : min(max(raw, 0), Self.replyMaxDrag)
            cell.contentView.transform = CGAffineTransform(translationX: dx, y: 0)
            replyIndicator.alpha = min(abs(dx) / Self.replyThreshold, 1)

        case .ended, .cancelled, .failed:
            guard let indexPath = swipingIndexPath else { return }
            swipingIndexPath = nil
            let cell = collectionView.cellForItem(at: indexPath)
            let dx = cell?.contentView.transform.tx ?? 0
            let triggered = recognizer.state == .ended && abs(dx) >= Self.replyThreshold
            UIView.animate(withDuration: 0.22) {
                cell?.contentView.transform = .identity
                self.replyIndicator.alpha = 0
            }
            if triggered, indexPath.item < rows.count {
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                actions?.onReply(rows[indexPath.item].message)
            }

        default:
            break
        }
    }

    /// Стрелка встаёт у того края строки, к которому она поедет.
    private func layoutReplyIndicator(for indexPath: IndexPath) {
        guard indexPath.item < rows.count,
              let attributes = collectionView.layoutAttributesForItem(at: indexPath)
        else { return }
        let isMine = rows[indexPath.item].message.isMine
        let size: CGFloat = 22
        let x = isMine ? attributes.frame.maxX - size - 14 : attributes.frame.minX + 14
        replyIndicator.frame = CGRect(
            x: x, y: attributes.frame.midY - size / 2, width: size, height: size
        )
        replyIndicator.alpha = 0
        collectionView.bringSubviewToFront(replyIndicator)
    }

    /// Показать ленту после того, как позиция выставлена.
    private func reveal() {
        guard collectionView.alpha < 1 else { return }
        UIView.animate(withDuration: 0.12) { self.collectionView.alpha = 1 }
    }

    private func updatePosition() {
        guard let proxy, collectionView != nil else { return }
        let atBottom = isAtBottom
        if proxy.atBottom != atBottom { proxy.atBottom = atBottom }
        let show = canScroll && !atBottom
        if proxy.showScrollDown != show { proxy.showScrollDown = show }
    }

    override func viewWillLayoutSubviews() {
        super.viewWillLayoutSubviews()
        // Снимаем позицию ДО раскладки: после того, как клавиатура сожмёт вьюпорт,
        // «мы внизу» уже не определить.
        if view.bounds.height == lastBoundsHeight { wasAtBottomBeforeLayout = isAtBottom }
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        // Страховка: что бы ни случилось со снимком, невидимой лента не останется.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in self?.reveal() }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        updateTopInsetForShortContent()
        let height = view.bounds.height
        defer { lastBoundsHeight = height }
        guard didInitialLayout, height != lastBoundsHeight else { return }
        // Высота изменилась — выехала клавиатура или вырос композер. Были внизу — там и
        // остаёмся, иначе последнее сообщение уезжает под панель ввода.
        if wasAtBottomBeforeLayout { scrollToBottom(animated: false) }
    }
}

extension MessageListController: UIGestureRecognizerDelegate {

    /// Жест берётся за дело ТОЛЬКО при явно горизонтальном движении. Иначе прокрутка
    /// ленты снова оказалась бы заложником свайпа — ровно та беда, из-за которой жест
    /// пришлось временно убрать.
    func gestureRecognizerShouldBegin(_ recognizer: UIGestureRecognizer) -> Bool {
        guard let pan = recognizer as? UIPanGestureRecognizer,
              pan.view === collectionView, pan !== collectionView.panGestureRecognizer
        else { return true }
        let velocity = pan.velocity(in: collectionView)
        return abs(velocity.x) > abs(velocity.y) * 1.5
    }

    /// Идём рядом с прокруткой, а не вместо неё.
    func gestureRecognizer(
        _ recognizer: UIGestureRecognizer,
        shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer
    ) -> Bool {
        true
    }
}

extension MessageListController: UICollectionViewDelegate {

    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        updatePosition()
        // Следующая страница — за полтора экрана до верха, а не в упор к нему.
        guard didInitialLayout, !rows.isEmpty else { return }
        if scrollView.contentOffset.y < scrollView.bounds.height * Self.topTriggerScreens {
            onReachedTop?()
        }
    }
}

/// Содержимое ячейки: тот же SwiftUI-вид сообщения, что и прежде, плюс разделитель дня.
private struct MessageCell: View {

    let model: MessageRowModel
    let actions: MessageRowActions?

    var body: some View {
        VStack(spacing: 0) {
            if let day = model.dayHeader {
                Text(day)
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(Eb.textMuted)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 3)
                    .background(Eb.surface200, in: Capsule())
                    .padding(.vertical, 8)
            }
            MessageRow(
                m: model.message,
                isGroup: model.isGroup,
                senderAvatarUrl: model.senderAvatarUrl,
                senderNames: model.senderNames,
                isFirstInRun: model.isFirstInRun,
                isLastInRun: model.isLastInRun,
                selectionMode: model.selectionMode,
                selected: model.selected,
                highlighted: model.highlighted,
                onQuoteTap: { actions?.onQuoteTap($0) },
                onTap: { actions?.onTap(model.message) },
                onStartSelect: {},
                onForward: { actions?.onForward(model.message) },
                onOpenImage: { images, index in actions?.onOpenImage(images, index) },
                onOpenSender: { actions?.onOpenSender(model.message) },
                decryptSecretAttachment: actions?.decryptSecretAttachment,
                onOpenAttachment: { actions?.onOpenAttachment($0) },
                onReply: { actions?.onReply(model.message) },
                onReact: { actions?.onReact(model.message, $0) },
                onPickReaction: { actions?.onPickReaction(model.message) },
                onLongPress: { actions?.onLongPress(model.message) },
                quickSlots: model.quickSlots,
                onEdit: { actions?.onEdit(model.message) },
                onDelete: { actions?.onDelete(model.message) }
            )
        }
        .padding(.horizontal, 10)
    }
}
