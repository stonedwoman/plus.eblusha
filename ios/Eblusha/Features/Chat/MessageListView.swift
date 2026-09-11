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
    /// Мост создаёт экран беседы: ему нужен ответ ленты для жеста «назад».
    @ObservedObject var proxy: MessageListProxy
    /// История ещё грузится: пустой снимок в это время — не «пустой чат», показывать нечего.
    let isLoading: Bool
    let pinToken: Int
    let sendToken: Int
    let onForward: (Message) -> Void
    /// Сообщение, индекс среди его медиа (фото, затем видео — Message.galleryMedia) и
    /// рамка плитки в координатах окна (для анимации открытия).
    let onOpenImage: (Message, Int, CGRect?) -> Void
    let onOpenSender: (Message) -> Void
    let onOpenAttachment: (MessageAttachment) -> Void
    let onEdit: (Message) -> Void
    let onPickReaction: (Message) -> Void
    let onLongPress: (Message) -> Void
    /// Двойной тап по пузырю — быстрая реакция первым слотом (экран запоминает выбор).
    let onQuickReact: (Message) -> Void
    let quickSlots: [String]

    @State private var jumpTask: Task<Void, Never>?
    @State private var jumpNotice: String?

    var body: some View {
        MessageListRepresentable(
            rows: rows,
            isLoading: isLoading,
            // Плавающая дата и эта плашка стоят в одном месте сверху — лента гасит пилюлю,
            // пока плашка на экране, иначе они наезжают друг на друга.
            noticeVisible: noticeText != nil,
            proxy: proxy,
            actions: MessageRowActions(
                onQuoteTap: { jumpToQuote($0) },
                onTap: { message in if vm.ui.selectionMode { vm.toggleSelect(message.id) } },
                onLongPress: onLongPress,
                onDoubleTap: onQuickReact,
                onSetSelected: { ids, selected in vm.setSelected(ids, selected: selected) },
                onForward: onForward,
                onOpenImage: onOpenImage,
                onOpenSender: onOpenSender,
                onOpenAttachment: onOpenAttachment,
                onReply: { vm.setReply($0) },
                onReact: { message, emoji in vm.react(message, emoji: emoji) },
                onPickReaction: onPickReaction,
                onEdit: onEdit,
                onDelete: { vm.delete(messageId: $0.id) },
                onOutgoing: { id, action in vm.handleOutgoing(id, action) },
                decryptSecretAttachment: vm.ui.isSecret ? { await vm.decryptSecretAttachment($0) } : nil
            ),
            onReachedTop: { loadOlderIfPossible() },
            onPrependHandled: { vm.releasePrepending() }
        )
        .overlay(alignment: .top) {
            if let notice = noticeText {
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

    /// Плашка сверху: поиск сообщения по цитате или подгрузка истории.
    private var noticeText: String? {
        jumpNotice ?? (vm.ui.loadingOlder ? "Загружаем…" : nil)
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

        // Ран — как в вебе (ChatMessageRow.tsx:106-107): подряд идущие сообщения ОДНОГО
        // автора всегда одна лестница, пауза значения не имеет. Пятиминутное окно, которое
        // тут было раньше, рвало ран на ровном месте: написал в 10:00 и в 15:00 — веб
        // показывает один блок, а телефон повторял имя, второй аватар и большой отступ.
        //
        // Единственная добавка к вебу — граница дня: разделителей дней в вебе нет, а у нас
        // они есть, и без этой проверки плашка «Сегодня» вклинивалась бы внутрь лестницы,
        // а аватар автора уезжал бы под неё.
        func sameRun(_ earlier: Message?, _ later: Message?) -> Bool {
            guard let earlier, let later else { return false }
            if earlier.isSystem || later.isSystem { return false }
            if earlier.senderId != later.senderId { return false }
            return dayIndex(earlier.createdAt) == dayIndex(later.createdAt)
        }

        // Карточке цитаты нужна миниатюра ОРИГИНАЛА, а серверный `replyTo` вложений не
        // отдаёт — оригинал ищем в уже загруженной истории, как веб (fullList.find).
        // Индекс строим один раз за проход: поиск по всей ленте из каждой ячейки стоил бы
        // O(n) на строку и съедал прокрутку.
        var byId: [String: Message] = [:]
        byId.reserveCapacity(messages.count)
        for message in messages { byId[message.id] = message }

        var names: [String: String] = [:]
        for message in messages where !message.senderName.isEmpty {
            names[message.senderId] = message.senderName
        }
        // Позиция участника в отсортированном списке беседы — по ней берутся цвет имени и
        // фон пузыря (порт participantColorIndex из веба). Участники приезжают вместе со
        // списком бесед; пока их нет, цвет считается по хэшу, как раньше.
        var participantOrder: [String: Int] = [:]
        for (index, id) in vm.ui.senderAvatars.keys.sorted().enumerated() {
            participantOrder[id] = index
        }

        // Пачки пересылки (порт computeMultiSourceForwardBundles) считаются здесь же одним
        // проходом: строка узнаёт своё место в конверте словарём, а не поиском по ленте.
        //
        // Почему пачка НЕ склеивается в одну ячейку, как в вебе: id строки — это id
        // сообщения, и на нём держится всё остальное — прыжок к цитате (scroll(to:)),
        // рамки плиток для просмотрщика, вклейка истории по прежней первой строке.
        // Строк столько же, сколько сообщений; конверт рисует каждая, а общую шапку
        // источника — только первая в пачке (slot.isFirst), и визуально это тот же конверт.
        let forwardSlots = computeForwardBundleSlots(messages)
        // Граница «непрочитанные» — ФЛАГ строки, а не отдельный элемент снимка: id строк —
        // это id сообщений, на них держатся вклейка истории (isPrepend), прыжок к цитате
        // (scroll(to:)) и рамки плиток. Синтетическая строка сдвинула бы всё это.
        let unreadAnchorId = vm.ui.unreadAnchorId

        return messages.enumerated().map { index, message in
            let earlier = index > 0 ? messages[index - 1] : nil
            let later = index + 1 < messages.count ? messages[index + 1] : nil
            let newDay = earlier.map { dayIndex($0.createdAt) != dayIndex(message.createdAt) } ?? true
            var quotePreviews: [String: ReplyQuotePreview] = [:]
            for reply in message.replyTo {
                quotePreviews[reply.id] = makeReplyQuotePreview(reply: reply, quoted: byId[reply.id])
            }
            return MessageRowModel(
                message: message,
                isGroup: vm.ui.isGroup,
                senderAvatarUrl: vm.ui.senderAvatars[message.senderId] ?? nil,
                senderNames: names,
                participantOrder: participantOrder,
                replyQuotePreviews: quotePreviews,
                forwardSlot: forwardSlots[message.id],
                isFirstInRun: !sameRun(earlier, message),
                isLastInRun: !sameRun(message, later),
                dayHeader: newDay ? formatMessageDay(message.createdAt) : nil,
                unreadHeader: unreadAnchorId != nil && message.id == unreadAnchorId,
                selectionMode: vm.ui.selectionMode,
                selected: vm.ui.selectedIds.contains(message.id),
                highlighted: message.id == proxy.highlightedId,
                quickSlots: quickSlots,
                outgoingUpload: vm.ui.outgoing[message.id]
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
                // Бейдж наезжает на верх кружка (сдвиг −6, как у Telegram), поэтому он
                // накладка, а не часть стопки: иначе кнопка подросла бы и уехала от угла.
                .overlay(alignment: .top) { scrollDownBadge }
        }
        .buttonStyle(.plain)
        .padding(.trailing, 14)
        .padding(.bottom, 12)
        .opacity(proxy.showScrollDown ? 1 : 0)
        // Пружина 0.3 с с scale 0.2↔1 (числа Telegram): кнопка «прилетает», а не проявляется.
        // Это чистая SwiftUI-накладка над лентой — ни contentOffset, ни жестов не касается.
        .scaleEffect(proxy.showScrollDown ? 1 : 0.2)
        .animation(.spring(duration: 0.3), value: proxy.showScrollDown)
        // Тем же движением и бейдж: появление/смена числа не должны быть кадром-подменой.
        .animation(.spring(duration: 0.3), value: proxy.newBelow)
        .allowsHitTesting(proxy.showScrollDown)
    }

    /// Сколько ЧУЖИХ сообщений прилетело, пока лента была не внизу. Серверный unread тут
    /// не годится: markRead квитирует беседу на каждое входящее, и он всегда 0.
    @ViewBuilder
    private var scrollDownBadge: some View {
        if proxy.newBelow > 0 {
            Text(proxy.newBelow > 99 ? "99+" : "\(proxy.newBelow)")
                .font(.system(size: 13))
                .foregroundStyle(.white)
                .padding(.horizontal, 5)
                // 18×18 — минимум Telegram; шире становится только от самого текста.
                .frame(minWidth: 18, minHeight: 18)
                .background(Eb.brand700, in: Capsule())
                .overlay(Capsule().strokeBorder(Eb.paper, lineWidth: 1.5))
                .offset(y: -6)
                .allowsHitTesting(false)
                .transition(.scale.combined(with: .opacity))
        }
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
    /// Позиция каждого участника беседы: слот палитры имени и фона пузыря.
    let participantOrder: [String: Int]
    /// Предпросмотры цитат этой строки (id оригинала → миниатюра, подпись, время).
    /// Считает лента: только она видит всю загруженную историю, где лежит оригинал.
    let replyQuotePreviews: [String: ReplyQuotePreview]
    /// Место строки в пачке пересылки: по нему строка знает, рисовать ли общую шапку
    /// источника. nil — сообщение не переслано. Участвует в сравнении строк: когда пачка
    /// растёт, у её первой строки шапка остаётся, а у соседей меняется счёт — и
    /// diffable-источник переконфигурирует именно их (reconfigureItems).
    let forwardSlot: ForwardBundleSlot?
    let isFirstInRun: Bool
    let isLastInRun: Bool
    let dayHeader: String?
    /// Над этой строкой рисуется полоса «Непрочитанные сообщения». Ставится один раз на
    /// вход в чат (ChatViewModel.resolveUnreadAnchorIfNeeded) и за визит не меняется —
    /// поэтому строка не переконфигурируется, когда сообщения дочитаны.
    let unreadHeader: Bool
    let selectionMode: Bool
    let selected: Bool
    let highlighted: Bool
    let quickSlots: [String]
    /// Сообщение ещё не отправлено: прогресс аплоада или пометка сбоя. nil — обычная
    /// строка. Лежит В МОДЕЛИ, а не в окружении ленты, чтобы diffable-источник видел
    /// изменение прогресса и переконфигурировал ровно эту ячейку.
    let outgoingUpload: OutgoingUpload?

    var id: String { message.id }

    /// Сообщения на сервере ещё нет: летящее вложение, мгновенный текстовый пузырь или
    /// запись очереди секретки. Отвечать на такое, пересылать, править и выделять нечего —
    /// все жесты ленты об этот признак спотыкаются заранее, а не о временный id внутри.
    // @MainActor — из-за ChatViewModel.isOutgoingId: вью-модель изолирована главным
    // актором, а сама модель строки — обычная структура. Читают признак только лента и
    // её жесты, они и так на главном потоке.
    @MainActor
    var isPending: Bool {
        outgoingUpload != nil || ChatViewModel.isOutgoingId(message.id)
            || SecretOutbox.isPending(message.id)
    }
}

/// Замыкания живут в контроллере и не участвуют в сравнении строк — иначе каждая ячейка
/// считалась бы изменившейся на каждом проходе.
struct MessageRowActions {
    let onQuoteTap: (String) -> Void
    let onTap: (Message) -> Void
    let onLongPress: (Message) -> Void
    /// Двойной тап по пузырю. Лента зовёт его ТОЛЬКО там, где одиночного тапа нет вовсе
    /// (см. quickReactRow(atCollectionPoint:)), поэтому спорить им не с чем.
    let onDoubleTap: (Message) -> Void
    /// Пакетное «выбрать/снять» для протяжки двумя пальцами (ChatViewModel.setSelected).
    let onSetSelected: ([String], Bool) -> Void
    let onForward: (Message) -> Void
    /// Сообщение, индекс среди его медиа (фото, затем видео) и рамка плитки в окне.
    let onOpenImage: (Message, Int, CGRect?) -> Void
    let onOpenSender: (Message) -> Void
    let onOpenAttachment: (MessageAttachment) -> Void
    let onReply: (Message) -> Void
    let onReact: (Message, String) -> Void
    let onPickReaction: (Message) -> Void
    let onEdit: (Message) -> Void
    let onDelete: (Message) -> Void
    /// Кнопки на ещё не отправленном пузыре: отмена, повтор, удаление.
    let onOutgoing: (String, OutgoingUploadAction) -> Void
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
    /// Сколько чужих сообщений пришло, пока лента не внизу — бейдж на кнопке «вниз».
    /// Считает контроллер по снимкам, обнуляет — попадание в низ.
    @Published var newBelow = 0
    /// Подсветка после перехода по цитате.
    @Published var highlightedId: String?
    /// Идёт переход к цитате: подгрузка истории на это время молчит.
    var jumping = false
    /// Следующее пришедшее сообщение утягивает ленту вниз независимо от позиции.
    var followNextMessage = false

    var scrollToBottomAction: ((Bool) -> Void)?
    var scrollToMessageAction: ((String) -> Void)?
    /// Можно ли начать жест «назад» из этой точки экрана (в координатах окна). Лента
    /// отвечает «нет», если палец лёг на входящий пузырь — там свайп вправо значит ответ.
    var backSwipeAllowed: ((CGPoint) -> Bool)?
    /// Актуальная рамка плитки медиа (сообщение, индекс среди его медиа) в координатах
    /// окна; nil — ячейки нет на экране. Просмотрщик улетает по ней обратно в чат.
    var tileFrameAction: ((String, Int) -> CGRect?)?
    /// Близнец `tileFrameAction`, но для пузыря целиком: его рамка в координатах окна,
    /// nil — ячейки нет на экране. По ней меню сообщения возвращает поднятую копию пузыря
    /// на место, даже если лента под меню успела сдвинуться пришедшими сообщениями.
    var bubbleFrameAction: ((String) -> CGRect?)?
    /// Снимок пузыря (растр плюс та же оконная рамка) на момент открытия меню.
    var bubbleCopyAction: ((String) -> MessageBubbleCopy?)?
    /// Спрятать плитку-источник открытого просмотрщика (сообщение и индекс медиа) либо
    /// вернуть все плитки на место (messageId = nil).
    var hideTileAction: ((String?, Int) -> Void)?
    /// Подвести сообщение в видимую область, если его плитки может не быть на экране.
    var revealMessageAction: ((String) -> Void)?

    func scrollToBottom(animated: Bool) { scrollToBottomAction?(animated) }
    func scrollToMessage(_ id: String) { scrollToMessageAction?(id) }
    func tileFrameInWindow(messageId: String, index: Int) -> CGRect? { tileFrameAction?(messageId, index) }
    func bubbleFrameInWindow(messageId: String) -> CGRect? { bubbleFrameAction?(messageId) }
    func bubbleCopy(messageId: String) -> MessageBubbleCopy? { bubbleCopyAction?(messageId) }
    func hideTile(messageId: String?, index: Int) { hideTileAction?(messageId, index) }
    func revealMessage(_ id: String) { revealMessageAction?(id) }
}

// MARK: - UIKit-лента

private struct MessageListRepresentable: UIViewControllerRepresentable {

    let rows: [MessageRowModel]
    let isLoading: Bool
    let noticeVisible: Bool
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
        proxy.backSwipeAllowed = { [weak controller] point in
            controller?.allowsBackSwipe(atWindowPoint: point) ?? true
        }
        proxy.tileFrameAction = { [weak controller] id, index in
            controller?.tileFrameInWindow(messageId: id, index: index)
        }
        proxy.bubbleFrameAction = { [weak controller] id in
            controller?.bubbleFrameInWindow(messageId: id)
        }
        proxy.bubbleCopyAction = { [weak controller] id in
            controller?.bubbleCopy(messageId: id)
        }
        proxy.hideTileAction = { [weak controller] id, index in
            controller?.setHiddenTile(messageId: id, index: index)
        }
        proxy.revealMessageAction = { [weak controller] id in
            controller?.revealIfNeeded(messageId: id)
        }
        return controller
    }

    func updateUIViewController(_ controller: MessageListController, context: Context) {
        controller.isLoading = isLoading
        controller.noticeVisible = noticeVisible
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
    var isLoading = true
    var onReachedTop: (() -> Void)?
    var onPrependHandled: (() -> Void)?
    /// Сверху показана плашка («Загружаем…», поиск сообщения): плавающая дата уступает ей
    /// место, они рисуются в одной точке.
    var noticeVisible = false {
        didSet { if noticeVisible { setFloatingDate(visible: false) } }
    }

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
    /// Окно, в течение которого рост высоты содержимого до-прижимает ленту к низу.
    private static let stickToBottomWindow: TimeInterval = 0.8
    /// До какого момента (по часам) действует это окно. 0 — выключено.
    private var stickToBottomDeadline: TimeInterval = 0
    /// Высота содержимого на прошлом сообщении коллекции о смене contentSize.
    private var lastContentHeight: CGFloat = 0
    /// Строки, чьи ячейки надо проявить (новые пузыри у низа). Ждут здесь, потому что
    /// ячейка может появиться позже снимка — вместе с докруткой к низу.
    private var pendingFadeIds: Set<String> = []
    /// До какого момента это ожидание в силе: иначе строка проявилась бы, когда до неё
    /// долистают через минуту.
    private var fadeDeadline: TimeInterval = 0
    /// Плавающая дата: капсула с подписью дня, живёт в `view`, а не в коллекции.
    private var floatingDate: UIView!
    private var floatingDateLabel: UILabel!
    /// Строка, по которой сейчас подписана пилюля: пересчёт даты только при её смене.
    private var floatingDateRowId: String?
    /// Отложенное гашение пилюли после остановки прокрутки.
    private var floatingDateHide: Task<Void, Never>?

    /// Строка с разделителем непрочитанных — на неё лента встаёт при входе в чат.
    private var unreadAnchorIndex: Int? { rows.firstIndex { $0.unreadHeader } }
    /// Свайп-ответ: порог срабатывания и предел протяжки (как в прежней версии).
    /// Пороги свайпа-ответа взяты у Telegram: тянется до 80 pt, срабатывает после 45.
    private static let replyThreshold: CGFloat = 45
    private static let replyMaxDrag: CGFloat = 80

    /// Строка, которую сейчас тянут вбок.
    private var swipingIndexPath: IndexPath?
    /// Кого тянем прямо сейчас (фиксируется на старте жеста).
    private var swipingRowId: String?
    /// Плитка, спрятанная под открытым просмотрщиком: сообщение и индекс медиа в нём.
    /// Хранится в самом классе: расширения не носят хранимых полей.
    private var hiddenTile: (messageId: String, index: Int)?
    /// Порог уже перейден: отклик даём в момент перехода, как Telegram, а не на отпускании.
    private var swipePassedThreshold = false
    /// Сдвиги пузырей по id сообщения: во время жеста меняется только один объект,
    /// и перерисовывается только один пузырь.
    private var swipeStates: [String: MessageSwipeState] = [:]
    /// Протяжка двумя пальцами: второй вход в мультивыбор. Весь автомат мазка — в
    /// MessageSelectionPanDriver, здесь только проводка к ленте и к вью-модели.
    private let selectionPan = MessageSelectionPanDriver()

    private func swipeState(for id: String) -> MessageSwipeState {
        if let existing = swipeStates[id] { return existing }
        let state = MessageSwipeState()
        swipeStates[id] = state
        return state
    }

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

        let collection = ContentSizeReportingCollectionView(frame: .zero, collectionViewLayout: layout)
        collection.onContentSizeChange = { [weak self] height in
            self?.contentHeightDidChange(height)
        }
        collectionView = collection
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

        // Свайп-ответ живёт на самой коллекции, а не на каждой ячейке: начинается только
        // при явно горизонтальном движении и идёт одновременно с прокруткой, поэтому
        // палец на сообщении по-прежнему листает ленту.
        let replyPan = UIPanGestureRecognizer(target: self, action: #selector(handleReplyPan(_:)))
        replyPan.delegate = self
        // Один палец: два — это мазок выделения, и ответ не должен уезжать вместе с ним.
        replyPan.maximumNumberOfTouches = 1
        collectionView.addGestureRecognizer(replyPan)
        // Долгое нажатие — тоже на коллекции, а не SwiftUI-модификатором в ячейке.
        // SwiftUI-жесты внутри UIKit-прокрутки перехватывали касание: палец на фото
        // (там ещё и тап на плитке) не листал ленту и не тянул ни ответ, ни «назад».
        let longPress = UILongPressGestureRecognizer(target: self, action: #selector(handleLongPress(_:)))
        longPress.minimumPressDuration = 0.32
        longPress.delegate = self
        collectionView.addGestureRecognizer(longPress)
        // Двойной тап — быстрая реакция. Одиночному тапу он не мешает и не задерживает
        // его: жест берётся за дело только на пузырях, где одиночного тапа нет вовсе
        // (текст без вложений и без превью ссылки), — см. quickReactRow.
        let doubleTap = UITapGestureRecognizer(target: self, action: #selector(handleDoubleTap(_:)))
        doubleTap.numberOfTapsRequired = 2
        // САМОЕ ВАЖНОЕ здесь. По умолчанию распознаватель тапа придерживает touchesEnded
        // до своего провала, и КАЖДЫЙ одиночный тап в ленте (фото, файл, ссылка, галочка
        // выбора) отзывался бы с задержкой в треть секунды — ожиданием второго тапа.
        // Одиночный тап уходит вью сразу, а двойной приходит вдогонку; столкнуться им
        // негде, потому что берёмся мы только за пузыри без одиночного тапа.
        doubleTap.delaysTouchesEnded = false
        doubleTap.delegate = self
        collectionView.addGestureRecognizer(doubleTap)
        // Мазок выделения двумя пальцами. Делегат у него свой (сам драйвер), поэтому в
        // здешний арбитраж он не попадает; с прокруткой они разведены числом пальцев —
        // драйвер оставляет ленте ровно один (см. attach).
        selectionPan.attach(to: collectionView, hooks: MessageSelectionPanDriver.Hooks(
            rowAt: { [weak self] point in self?.selectionHit(atCollectionPoint: point) },
            setSelected: { [weak self] ids, selected in self?.actions?.onSetSelected(ids, selected) },
            canScroll: { [weak self] in self?.canScrollUnderSelection ?? false },
            isBusy: { [weak self] in self?.swipingRowId != nil }
        ))
        NSLayoutConstraint.activate([
            collectionView.topAnchor.constraint(equalTo: view.topAnchor),
            collectionView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            collectionView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            collectionView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])
        setUpFloatingDate()
    }

    /// Пилюля с датой поверх ленты. Кладётся в `view`, а НЕ в коллекцию: внутри коллекции
    /// она уехала бы вместе с содержимым, а секции diffable-источника (штатный способ
    /// липких заголовков) сломали бы и вклейку истории, и поиск строки по id.
    private func setUpFloatingDate() {
        let pill = UIView()
        pill.backgroundColor = UIColor(Eb.surface200)
        // Высота 20 (число Telegram) — радиус ровно половина, получается капсула.
        pill.layer.cornerRadius = 10
        pill.layer.cornerCurve = .continuous
        pill.alpha = 0
        pill.isUserInteractionEnabled = false
        pill.translatesAutoresizingMaskIntoConstraints = false

        let label = UILabel()
        // 13 pt с потолком 18 при крупном системном шрифте — тоже числа Telegram.
        label.font = UIFontMetrics(forTextStyle: .footnote).scaledFont(
            for: .systemFont(ofSize: 13, weight: .semibold), maximumPointSize: 18
        )
        label.adjustsFontForContentSizeCategory = true
        label.textColor = UIColor(Eb.textMuted)
        label.translatesAutoresizingMaskIntoConstraints = false
        pill.addSubview(label)
        view.addSubview(pill)

        let height = pill.heightAnchor.constraint(equalToConstant: 20)
        // Не required: под крупным шрифтом пилюля должна вырастать, а не обрезать подпись.
        height.priority = .defaultHigh
        NSLayoutConstraint.activate([
            pill.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            pill.topAnchor.constraint(equalTo: view.topAnchor, constant: Self.basePadding + 8),
            pill.heightAnchor.constraint(greaterThanOrEqualTo: label.heightAnchor, constant: 2),
            height,
            label.leadingAnchor.constraint(equalTo: pill.leadingAnchor, constant: 6),
            label.trailingAnchor.constraint(equalTo: pill.trailingAnchor, constant: -6),
            label.centerYAnchor.constraint(equalTo: pill.centerYAnchor),
        ])
        floatingDate = pill
        floatingDateLabel = label
    }

    private func setUpDataSource() {
        let registration = UICollectionView.CellRegistration<UICollectionViewListCell, String> {
            [weak self] cell, _, id in
            guard let self, let model = self.rowsById[id] else { return }
            cell.backgroundConfiguration = .clear()
            // Ячейку могли переиспользовать посреди проявления нового пузыря (fadeInCells) —
            // прозрачной она достаться не должна.
            cell.contentView.alpha = 1
            cell.contentConfiguration = UIHostingConfiguration {
                MessageCell(
                    model: model, actions: self.actions, swipe: self.swipeState(for: id),
                    // Плитка фото сообщает рамку в координатах ячейки — просмотрщику нужна оконная,
                    // чтобы кадр вырос ровно из своего места.
                    cellToWindow: { [weak cell] rect in cell?.contentView.convert(rect, to: nil) }
                )
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
        // Состояния свайпа держим только для живых строк.
        swipeStates = swipeStates.filter { rowsById[$0.key] != nil }
        // Действительно пустая переписка (загрузка кончилась) — показывать нечего, но и
        // прятать ленту незачем. Пока история грузится, пустой снимок — не повод
        // показываться: иначе первая страница приезжала бы в уже видимую ленту, и был
        // виден кадр «сверху» и рывок к низу.
        if newRows.isEmpty {
            // Снимок всё равно применяем: иначе после удаления последних сообщений в
            // коллекции остались бы старые ячейки.
            var empty = NSDiffableDataSourceSnapshot<Int, String>()
            empty.appendSections([0])
            dataSource.apply(empty, animatingDifferences: false)
            if !isLoading { reveal() }
            return
        }

        let wasAtBottom = isAtBottom
        let follow = proxy?.followNextMessage ?? false
        // Вставка сверху: запоминаем расстояние до низа ДО применения, чтобы после
        // вклейки вернуть ровно ту же точку — видимое место не сдвинется вовсе.
        let prepending = isPrepend(previous: previous, next: newRows)
        if prepending {
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

        // Хвостовой ран РЕАЛЬНО добавленных в конец строк (аналог телеграмовского
        // maxAnimatedInsertionIndex). Первый снимок и вклейка истории сюда не попадают.
        var tailAdded: [MessageRowModel] = []
        if !isFirst, !prepending {
            for row in newRows.reversed() {
                guard previousById[row.id] == nil else { break }
                tailAdded.append(row)
            }
        }
        // Проявляем не больше четырёх ячеек: пачка из десяти мигала бы вся целиком.
        // И только ЧУЖИЕ: свой пузырь встаёт в ленту мгновенно, ещё до ответа сервера, а
        // его подмена серверным (тот же текст, другой id) — это для снимка новая строка,
        // и проявление показало бы мигание на ровном месте.
        let fadeInIds = tailAdded.filter { !$0.message.isMine }.prefix(4).map(\.id)
        // Бейдж кнопки «вниз»: чужие сообщения, пришедшие, пока мы НЕ внизу. Свои и так
        // утягивают ленту (followNextMessage), их считать не за что. Считаем здесь, а
        // ПУБЛИКУЕМ в completion снимка: apply(rows:) зовётся из updateUIViewController,
        // то есть посреди обновления SwiftUI, а запись в @Published оттуда — это
        // «Publishing changes from within view updates».
        let incomingBelow = (!wasAtBottom && !follow)
            ? tailAdded.filter { !$0.message.isMine }.count
            : 0

        // Проявление новых пузырей: ячейка может быть уже на экране, а может приехать
        // вместе с докруткой к низу — поэтому список ждёт в pendingFadeIds, и гасит ячейку
        // тот, кто первым её увидит: willDisplay или проход после применения снимка.
        pendingFadeIds = Set(fadeInIds)
        fadeDeadline = fadeInIds.isEmpty ? 0 : Date().timeIntervalSince1970 + 1

        dataSource.apply(snapshot, animatingDifferences: false) { [weak self] in
            guard let self else { return }
            if let anchor = self.pendingPrependAnchor {
                self.pendingPrependAnchor = nil
                self.collectionView.layoutIfNeeded()
                let target = self.collectionView.contentSize.height - anchor
                self.collectionView.setContentOffset(CGPoint(x: 0, y: target), animated: false)
                self.onPrependHandled?()
            } else if isFirst, let anchorIndex = self.unreadAnchorIndex {
                self.didInitialLayout = true
                // Вход на первом непрочитанном: строку с разделителем прижимаем к ВЕРХУ
                // экрана (у Telegram это .bottom(0.0) на перевёрнутой ленте), чтобы
                // непрочитанное заполняло экран под ним. Для чатов без якоря ветка ниже
                // оставляет всё как было — лента открывается сразу внизу.
                self.scrollToUnreadAnchor(index: anchorIndex)
                // Кнопка «вниз» показывается по общему правилу (есть куда листать и мы не
                // внизу) — его тут ничто не меняет. Бейдж на ней получает то же значение,
                // что и при приходе сообщений мимо низа: сколько ЧУЖИХ строк осталось ниже
                // разделителя. Проверка «не внизу» обязательна: разделитель мог оказаться
                // на последних строках, целиком влезших в экран, и тогда считать нечего.
                if let proxy = self.proxy, !self.isAtBottom {
                    let below = self.rows[anchorIndex...].filter { !$0.message.isMine }.count
                    if proxy.newBelow != below { proxy.newBelow = below }
                }
                // Мы заведомо НЕ внизу. Без этого первое же изменение высоты вью (рост
                // композера, клавиатура) увело бы ленту в низ по wasAtBottomBeforeLayout,
                // который до первой равновысокой раскладки остаётся значением по умолчанию.
                self.wasAtBottomBeforeLayout = false
                DispatchQueue.main.async { [weak self] in
                    guard let self else { return }
                    // Второй проход по той же причине, что и у низа: ячейки досчитывают
                    // высоту после первой раскладки, и цель сдвигается. Лента ещё скрыта,
                    // поэтому доводка не видна.
                    if let index = self.unreadAnchorIndex { self.scrollToUnreadAnchor(index: index) }
                    self.reveal()
                }
            } else if isFirst {
                self.didInitialLayout = true
                self.scrollToBottom(animated: false)
                // Повторная доводка: ячейки досчитывают высоту после первой раскладки.
                // Показываем ленту только после неё — тогда открытие выглядит как сразу
                // готовый экран, без промежуточных кадров.
                self.armStickToBottom()
                DispatchQueue.main.async { [weak self] in
                    self?.scrollToBottom(animated: false)
                    self?.reveal()
                }
            } else if follow {
                self.proxy?.followNextMessage = false
                self.armStickToBottom()
                self.scrollToBottom(animated: true)
            } else if wasAtBottom, countChanged {
                self.armStickToBottom()
                self.scrollToBottom(animated: true)
            }
            if incomingBelow > 0, let proxy = self.proxy {
                proxy.newBelow += incomingBelow
            }
            self.updateTopInsetForShortContent()
            self.updatePosition()
            // Проявление новых пузырей — последним: ячейки к этому моменту уже созданы.
            self.fadeInCells(ids: fadeInIds)
        }
    }

    /// Новый пузырь проявляется на месте (Telegram: alpha 0→1 за 0.2 с) вместо мгновенного
    /// появления. Позиции не касается вовсе — анимируется только alpha содержимого ячейки.
    private func fadeInCells(ids: [String]) {
        guard !pendingFadeIds.isEmpty, let dataSource else { return }
        for id in ids where pendingFadeIds.contains(id) {
            guard let indexPath = dataSource.indexPath(for: id),
                  let cell = collectionView.cellForItem(at: indexPath) else { continue }
            pendingFadeIds.remove(id)
            fadeIn(cell: cell)
        }
    }

    private func fadeIn(cell: UICollectionViewCell) {
        let content = cell.contentView
        content.alpha = 0
        UIView.animate(
            withDuration: 0.2, animations: { content.alpha = 1 },
            completion: { _ in content.alpha = 1 }
        )
    }

    /// Открыть окно до-прижатия к низу. Нужно потому, что цель докрутки считается в
    /// completion снимка, когда самоизмеряющаяся ячейка с фото ещё не знает финальную
    /// высоту: без этого лента после прихода фото остаётся НЕ внизу.
    private func armStickToBottom() {
        stickToBottomDeadline = Date().timeIntervalSince1970 + Self.stickToBottomWindow
    }

    /// Коллекция сообщила, что высота содержимого изменилась.
    private func contentHeightDidChange(_ height: CGFloat) {
        let grew = height > lastContentHeight + 0.5
        lastContentHeight = height
        // Только РОСТ и только внутри окна после команды «встать в низ»: вклейка истории
        // (pendingPrependAnchor) и обычное листание сюда попадать не должны.
        guard collectionView != nil, grew, didInitialLayout, pendingPrependAnchor == nil else { return }
        guard Date().timeIntervalSince1970 < stickToBottomDeadline else { return }
        // Палец на ленте — решает пользователь, добивать низ нельзя.
        guard !collectionView.isTracking, !collectionView.isDragging else { return }
        // Прижимаем напрямую, без layoutIfNeeded внутри scrollToBottom: мы уже внутри
        // раскладки коллекции, и повторный проход отсюда — верный путь к рекурсии.
        collectionView.setContentOffset(CGPoint(x: 0, y: bottomOffset), animated: false)
        updatePosition()
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

    /// Поставить строку с разделителем непрочитанных к верхней кромке. Своей арифметикой
    /// тут делать нечего: высоты строк выше экрана ещё не измерены, а `scrollToItem`
    /// спрашивает их у раскладки сам.
    private func scrollToUnreadAnchor(index: Int) {
        guard index < rows.count else { return }
        collectionView.layoutIfNeeded()
        collectionView.scrollToItem(
            at: IndexPath(item: index, section: 0), at: .top, animated: false
        )
        updatePosition()
    }

    func scroll(to messageId: String) {
        guard let index = rows.firstIndex(where: { $0.id == messageId }) else { return }
        collectionView.scrollToItem(
            at: IndexPath(item: index, section: 0), at: .centeredVertically, animated: true
        )
    }

    // MARK: - Свайп-ответ

    /// Меню сообщения по долгому нажатию на пузырь (см. `gestureRecognizerShouldBegin`).
    @objc private func handleLongPress(_ recognizer: UILongPressGestureRecognizer) {
        guard recognizer.state == .began else { return }
        let point = recognizer.location(in: collectionView)
        guard let row = row(atCollectionPoint: point) else { return }
        // Меню действий для ещё не отправленного бессмысленно: сервер этого сообщения не
        // видел — ни ответить, ни переслать, ни отредактировать. Отмена живёт на пузыре.
        guard !row.isPending else { return }
        // В режиме выбора строка глухая: долгое нажатие поверх галочек открывало бы
        // второе меню поверх панели действий.
        guard !row.selectionMode else { return }
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        actions?.onLongPress(row.message)
    }

    /// Быстрая реакция двойным тапом (порт поведения Telegram: второй тап по пузырю
    /// ставит первую реакцию из быстрых слотов, повторный — снимает её).
    @objc private func handleDoubleTap(_ recognizer: UITapGestureRecognizer) {
        guard recognizer.state == .ended,
              let row = quickReactRow(atCollectionPoint: recognizer.location(in: collectionView))
        else { return }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        actions?.onDoubleTap(row.message)
    }

    @objc private func handleReplyPan(_ recognizer: UIPanGestureRecognizer) {
        switch recognizer.state {
        case .began:
            let point = recognizer.location(in: collectionView)
            guard let indexPath = collectionView.indexPathForItem(at: point),
                  let row = row(atCollectionPoint: point),
                  !row.message.isSystem,
                  // Свайп-ответ на ещё не отправленное: replyToId указывал бы на временный id.
                  !row.isPending,
                  !row.selectionMode
            else {
                swipingIndexPath = nil
                swipingRowId = nil
                return
            }
            swipingIndexPath = indexPath
            // Строку фиксируем на старте: во время жеста лента может обновиться, и
            // пересчёт по индексу увёл бы сдвиг на соседнее сообщение.
            swipingRowId = row.id
            swipePassedThreshold = false

        case .changed:
            guard let id = swipingRowId, let row = rowsById[id] else { return }
            // Влево тянутся ВСЕ сообщения — и свои, и чужие (порт Telegram: translation.x
            // зажат в [-80, 0]). Одна сторона для всех понятнее, чем «наружу из колонки»,
            // и не спорит с жестом «назад», который работает вправо.
            // За пределом протяжки пузырь не встаёт колом: дальше он идёт резинкой, как
            // содержимое прокрутки за краем. Жёсткий клэмп ощущался стеной — палец ехал,
            // а пузырь стоял, и было непонятно, жив ли ещё жест.
            let raw = recognizer.translation(in: collectionView).x
            let dx = -Self.rubberBanded(-min(raw, 0))
            // Двигается САМ пузырь внутри SwiftUI-содержимого (SwipeToReplyRow), а не
            // ячейка: сдвиг контейнера хостинг-конфигурация не показывала.
            swipeState(for: row.id).offset = dx
            // Отклик — в момент перехода порога, как в Telegram: рука понимает, что
            // отпускать уже можно, не доводя жест до конца.
            let passed = dx <= -Self.replyThreshold
            if passed != swipePassedThreshold {
                swipePassedThreshold = passed
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
            }

        case .ended, .cancelled, .failed:
            let passed = swipePassedThreshold
            swipePassedThreshold = false
            guard let id = swipingRowId, let row = rowsById[id] else {
                swipingIndexPath = nil
                swipingRowId = nil
                return
            }
            swipingIndexPath = nil
            swipingRowId = nil
            let message = row.message
            let state = swipeState(for: message.id)
            let triggered = recognizer.state == .ended && passed
            // Возврат — пружиной за 0.2 с, тоже как в Telegram.
            withAnimation(.spring(duration: 0.2)) { state.offset = 0 }
            if triggered { actions?.onReply(message) }

        default:
            break
        }
    }

    /// Затухание за пределом протяжки: первые 80 pt идут один к одному, дальше добавка
    /// тает и упирается в те же 80 сверху (итого не дальше 160). Коэффициент 0.55 — тот
    /// же, что у системной прокрутки за край, поэтому движение ощущается «родным».
    private static func rubberBanded(_ distance: CGFloat) -> CGFloat {
        guard distance > replyMaxDrag else { return max(distance, 0) }
        let extra = distance - replyMaxDrag
        return replyMaxDrag + (1 - 1 / (extra * 0.55 / replyMaxDrag + 1)) * replyMaxDrag
    }

    /// Показать ленту после того, как позиция выставлена.
    private func reveal() {
        guard collectionView.alpha < 1 else { return }
        UIView.animate(withDuration: 0.12) { self.collectionView.alpha = 1 }
    }

    private func updatePosition() {
        guard let proxy, collectionView != nil else { return }
        let atBottom = isAtBottom
        if proxy.atBottom != atBottom {
            proxy.atBottom = atBottom
            // Дошли до низа — всё накопленное показано, бейдж гаснет.
            if atBottom, proxy.newBelow != 0 { proxy.newBelow = 0 }
        }
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
        // Полторы секунды — дольше любой нормальной загрузки первой страницы.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in self?.reveal() }
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

    /// Жест ответа берётся за дело, только если палец лёг НА ПУЗЫРЬ и движется явно
    /// горизонтально ВЛЕВО. Всё остальное остаётся прокрутке и жесту «назад».
    func gestureRecognizerShouldBegin(_ recognizer: UIGestureRecognizer) -> Bool {
        if recognizer is UILongPressGestureRecognizer {
            // Ровно один палец: два лежащих на ленте — это начало мазка выделения, и меню
            // из-под него всплывать не должно.
            guard recognizer.numberOfTouches <= 1 else { return false }
            // Меню — только с пузыря: пустое поле строки и системные сообщения не в счёт.
            let point = recognizer.location(in: collectionView)
            guard let row = row(atCollectionPoint: point), !row.selectionMode, !row.isPending
            else { return false }
            return bubbleContains(row: row, collectionPoint: point)
        }
        if let tap = recognizer as? UITapGestureRecognizer {
            return quickReactRow(atCollectionPoint: tap.location(in: collectionView)) != nil
        }
        guard let pan = recognizer as? UIPanGestureRecognizer,
              pan.view === collectionView, pan !== collectionView.panGestureRecognizer
        else { return true }
        let velocity = pan.velocity(in: collectionView)
        guard abs(velocity.x) > abs(velocity.y) * 1.5 else { return false }
        guard let row = row(atCollectionPoint: pan.location(in: collectionView)),
              // В режиме выбора строка глухая целиком, а ответить на ещё не отправленное
              // нечем: обе проверки есть и в самом обработчике, здесь они экономят жест.
              !row.selectionMode, !row.isPending
        else { return false }
        guard bubbleContains(row: row, collectionPoint: pan.location(in: collectionView)) else { return false }
        // Ответ — только движением ВЛЕВО, для любого сообщения (Telegram). Движение вправо
        // целиком остаётся жесту «назад», поэтому спорить им больше не о чем.
        return velocity.x < 0
    }

    /// Строка, которой годится двойной тап. Правило нарочно узкое: реагируем только там,
    /// где одиночный тап НЕ занят ничем, — на пузыре без вложений и без карточки ссылки.
    /// У фото, видео, файла, голосового и превью ссылки одиночный тап уже значит «открыть»,
    /// и второй тап пришёл бы поверх уже начавшегося перехода.
    private func quickReactRow(atCollectionPoint point: CGPoint) -> MessageRowModel? {
        guard let row = row(atCollectionPoint: point),
              !row.selectionMode, !row.isPending,
              !row.message.isSystem, !row.message.deleted,
              row.message.attachments.isEmpty, row.message.linkPreview == nil,
              bubbleContains(row: row, collectionPoint: point)
        else { return nil }
        return row
    }

    /// Строка под пальцем для мазка выделения. Системные плашки и ещё не отправленные
    /// пузыри вью-модель всё равно отсеет (setSelected), но мазок обязан идти СКВОЗЬ них,
    /// а не обрываться на первой такой строке — поэтому отсекаем их здесь же.
    private func selectionHit(atCollectionPoint point: CGPoint) -> MessageSelectionPanDriver.RowHit? {
        guard let row = row(atCollectionPoint: point), !row.message.isSystem, !row.isPending
        else { return nil }
        return MessageSelectionPanDriver.RowHit(id: row.id, selected: row.selected)
    }

    /// Можно ли катить ленту под мазком: лента уже встала на первую позицию и не занята
    /// вклейкой страницы истории (её положение восстанавливают по якорю — наш сдвиг
    /// пришёлся бы ровно в этот момент и дал бы прыжок).
    private var canScrollUnderSelection: Bool {
        didInitialLayout && pendingPrependAnchor == nil
    }

    /// Строка под точкой коллекции. Ищем по идентификатору из снимка, а не по индексу в
    /// массиве: `rows` обновляется раньше, чем коллекция перестраивает ячейки, и в этот
    /// зазор индекс мог указывать на соседнее сообщение — жест доставался чужому пузырю.
    private func row(atCollectionPoint point: CGPoint) -> MessageRowModel? {
        guard let indexPath = collectionView.indexPathForItem(at: point) else { return nil }
        if let id = dataSource?.itemIdentifier(for: indexPath), let row = rowsById[id] { return row }
        guard indexPath.item < rows.count else { return nil }
        return rows[indexPath.item]
    }

    /// Лежит ли точка на пузыре строки. Рамку пузыря сообщает сам SwiftUI-пузырь.
    private func bubbleContains(row: MessageRowModel, collectionPoint: CGPoint) -> Bool {
        guard let indexPath = collectionView.indexPathForItem(at: collectionPoint),
              let cell = collectionView.cellForItem(at: indexPath),
              let state = swipeStates[row.id] else { return false }
        let local = collectionView.convert(collectionPoint, to: cell.contentView)
        return state.bubbleFrame.insetBy(dx: -8, dy: -4).contains(local)
    }

    /// Рамка плитки медиа в координатах окна — только если ячейка сейчас на экране и хотя
    /// бы частично видна; иначе просмотрщику лететь некуда, и он закроется затуханием.
    func tileFrameInWindow(messageId: String, index: Int) -> CGRect? {
        guard let dataSource,
              let indexPath = dataSource.indexPath(for: messageId),
              let cell = collectionView.cellForItem(at: indexPath),
              let local = swipeStates[messageId]?.tileFrames[index] else { return nil }
        let cellFrame = collectionView.convert(cell.frame, to: nil)
        let visible = collectionView.convert(collectionView.bounds, to: nil)
        guard cellFrame.intersects(visible) else { return nil }
        return cell.contentView.convert(local, to: nil)
    }

    /// Рамка пузыря в координатах окна — близнец `tileFrameInWindow` для меню сообщения.
    /// Условие видимости то же: если ячейки на экране нет, лететь копии некуда и меню
    /// обходится затуханием.
    func bubbleFrameInWindow(messageId: String) -> CGRect? {
        guard let dataSource,
              let indexPath = dataSource.indexPath(for: messageId),
              let cell = collectionView.cellForItem(at: indexPath),
              let local = swipeStates[messageId]?.bubbleFrame,
              local.width > 1, local.height > 1 else { return nil }
        let cellFrame = collectionView.convert(cell.frame, to: nil)
        let visible = collectionView.convert(collectionView.bounds, to: nil)
        guard cellFrame.intersects(visible) else { return nil }
        return cell.contentView.convert(local, to: nil)
    }

    /// Спрятать плитку-источник просмотрщика (nil — вернуть все на место). Прячем через
    /// MessageSwipeState строки, а НЕ через MessageRowModel: модель — это снимок
    /// diffable-источника, и её правка означала бы reconfigure ячейки, то есть пересборку
    /// SwiftUI-пузыря под открытым просмотрщиком — вместе с рамками плиток, по которым
    /// кадр летит назад. Плитка гасится непрозрачностью и держит своё место, поэтому
    /// высота ячейки не меняется и лента не двигается.
    func setHiddenTile(messageId: String?, index: Int) {
        if let previous = hiddenTile {
            swipeStates[previous.messageId]?.hiddenTileIndex = nil
        }
        hiddenTile = nil
        guard let messageId else { return }
        hiddenTile = (messageId: messageId, index: index)
        // Через swipeState(for:), а не через swipeStates[...]: строки может не быть на
        // экране (её плитку ещё подведёт revealIfNeeded), а состояние понадобится к
        // моменту, когда ячейка появится.
        swipeState(for: messageId).hiddenTileIndex = index
    }

    /// Подвести строку в видимую область. Зовёт открытый просмотрщик на смене кадра:
    /// закрытие должно лететь в живую плитку, а не гаснуть уменьшением. Когда строка и так
    /// видна — НЕ делает ничего: иначе каждое листание галереи двигало бы ленту, и возврат
    /// приходил бы в уехавшую плитку. Прокрутка без анимации и без участия арифметики
    /// contentOffset: цель считает раскладка (scrollToItem), высоты строк выше экрана она
    /// знает, а мы — нет.
    func revealIfNeeded(messageId: String) {
        guard didInitialLayout, let dataSource,
              let indexPath = dataSource.indexPath(for: messageId),
              let frame = collectionView.collectionViewLayout
                  .layoutAttributesForItem(at: indexPath)?.frame
        else { return }
        // Палец на ленте важнее: закрытие просмотрщика оставляет ленту живой.
        guard !collectionView.isTracking, !collectionView.isDragging else { return }
        let inset = collectionView.adjustedContentInset
        let viewport = CGRect(
            x: 0,
            y: collectionView.contentOffset.y + inset.top,
            width: collectionView.bounds.width,
            height: max(0, collectionView.bounds.height - inset.top - inset.bottom)
        )
        // «Видно достаточно» — либо строка целиком во вьюпорте, либо она выше экрана и
        // заполняет его целиком: в обоих случаях плитка на экране, двигать нечего.
        let shown = frame.intersection(viewport).height
        guard shown < min(frame.height, viewport.height) - 1 else { return }
        collectionView.scrollToItem(at: indexPath, at: .centeredVertically, animated: false)
        updatePosition()
    }

    /// Растр пузыря плюс его оконная рамка: это и поднимает меню над размытым фоном.
    /// Снимаем в момент долгого нажатия — потом ячейка может переехать или переиспользоваться.
    func bubbleCopy(messageId: String) -> MessageBubbleCopy? {
        // Рамку берём тем же методом, что и при возврате копии: если он говорит «нет»
        // (ячейки нет на экране), то и снимать нечего.
        guard let frame = bubbleFrameInWindow(messageId: messageId),
              let indexPath = dataSource?.indexPath(for: messageId),
              let cell = collectionView.cellForItem(at: indexPath),
              let local = swipeStates[messageId]?.bubbleFrame,
              let image = MessageActionsCapture.crop(of: cell.contentView, rect: local)
        else { return nil }
        return MessageBubbleCopy(image: image, frame: frame)
    }

    /// Жест «назад» спрашивает: можно ли стартовать здесь. Теперь всегда можно: ответ
    /// тянется влево у любого сообщения, а «назад» — вправо, и пересечься им негде.
    func allowsBackSwipe(atWindowPoint point: CGPoint) -> Bool { true }

    /// Идём рядом с прокруткой, а не вместо неё. Исключение — долгое нажатие и прокрутка:
    /// кто первый начался, тот и победил, иначе меню всплывало бы посреди медленного
    /// листания, а лента уезжала бы из-под открытого меню.
    func gestureRecognizer(
        _ recognizer: UIGestureRecognizer,
        shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer
    ) -> Bool {
        if recognizer is UILongPressGestureRecognizer, other === collectionView.panGestureRecognizer {
            return false
        }
        // Мазок выделения ленту ни с кем не делит. Спрашивают обоих участников пары, и
        // «да» от любого включило бы их вместе — поэтому отказ нужен и с этой стороны.
        if other === selectionPan.gestureRecognizer { return false }
        return true
    }
}

extension MessageListController: UICollectionViewDelegate {

    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        updatePosition()
        updateFloatingDate()
        // Следующая страница — за полтора экрана до верха, а не в упор к нему.
        guard didInitialLayout, !rows.isEmpty else { return }
        if scrollView.contentOffset.y < scrollView.bounds.height * Self.topTriggerScreens {
            onReachedTop?()
        }
    }

    /// Ячейка нового пузыря доехала до экрана (обычно вместе с докруткой к низу) — гасим её
    /// и проявляем за 0.2 с, как Telegram. Позиции это не касается вовсе.
    func collectionView(
        _ collectionView: UICollectionView, willDisplay cell: UICollectionViewCell,
        forItemAt indexPath: IndexPath
    ) {
        guard !pendingFadeIds.isEmpty, Date().timeIntervalSince1970 < fadeDeadline,
              let id = dataSource?.itemIdentifier(for: indexPath),
              pendingFadeIds.remove(id) != nil else { return }
        fadeIn(cell: cell)
    }

    func scrollViewWillBeginDragging(_ scrollView: UIScrollView) {
        // Палец на ленте — до-прижатие к низу отменяется: где стоять, решает пользователь.
        stickToBottomDeadline = 0
    }

    func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
        if !decelerate { scheduleFloatingDateHide() }
    }

    func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) {
        scheduleFloatingDateHide()
    }

    // MARK: - Плавающая дата

    /// Дату задаёт ВЕРХНЯЯ видимая строка. Зовётся на каждый кадр прокрутки, поэтому вся
    /// работа здесь — один `indexPathForItem` и словарь; форматирование даты (а это
    /// Calendar) только при смене строки. Наружу, в SwiftUI, состояние не выводится
    /// НАМЕРЕННО: любое @Published пересчитывало бы `rows` целиком на каждом кадре.
    private func updateFloatingDate() {
        guard floatingDate != nil, let dataSource else { return }
        // Только живая прокрутка — палец или инерция (поведение Telegram). Программные
        // докрутки (новое сообщение, клавиатура, прыжок к цитате) пилюлю не зажигают.
        guard collectionView.isDragging || collectionView.isDecelerating else { return }
        // Короткая переписка не листается — ориентир не нужен; плашка сверху важнее пилюли.
        guard canScroll, !noticeVisible else {
            setFloatingDate(visible: false)
            return
        }
        // Точка чуть ниже верхней кромки вьюпорта (в координатах содержимого).
        let probe = CGPoint(
            x: collectionView.bounds.midX,
            y: max(collectionView.contentOffset.y + 2, 0)
        )
        guard let indexPath = collectionView.indexPathForItem(at: probe),
              let id = dataSource.itemIdentifier(for: indexPath),
              let row = rowsById[id] else { return }
        // Своя капсула дня из ячейки подошла к верху — две одинаковые плашки рядом лишние.
        if row.dayHeader != nil,
           let cell = collectionView.cellForItem(at: indexPath),
           cell.frame.minY - collectionView.contentOffset.y < 34 {
            setFloatingDate(visible: false)
            return
        }
        if floatingDateRowId != id {
            floatingDateRowId = id
            floatingDateLabel.text = formatMessageDay(row.message.createdAt)
        }
        floatingDateHide?.cancel()
        floatingDateHide = nil
        setFloatingDate(visible: true)
    }

    /// После остановки прокрутки дата держится ещё 0.3 с и гаснет (поведение Telegram).
    private func scheduleFloatingDateHide() {
        floatingDateHide?.cancel()
        floatingDateHide = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled else { return }
            self?.setFloatingDate(visible: false)
        }
    }

    /// Появление за 0.3 с, гашение за 0.4 с — числа Telegram.
    private func setFloatingDate(visible: Bool) {
        guard let pill = floatingDate else { return }
        let target: CGFloat = visible ? 1 : 0
        guard abs(pill.alpha - target) > 0.01 else { return }
        UIView.animate(withDuration: visible ? 0.3 : 0.4) { pill.alpha = target }
    }
}

/// Коллекция, которая докладывает о СМЕНЕ высоты содержимого. Готового колбэка у
/// UIScrollView нет, а `viewDidLayoutSubviews` контроллера тут не помогает:
/// самоизмеряющаяся ячейка с фото доращивает высоту внутри раскладки самой коллекции,
/// вью контроллера при этом не перекладывается — и лента остаётся не внизу.
private final class ContentSizeReportingCollectionView: UICollectionView {

    var onContentSizeChange: ((CGFloat) -> Void)?
    private var reportedHeight: CGFloat = 0

    override func layoutSubviews() {
        super.layoutSubviews()
        let height = contentSize.height
        guard abs(height - reportedHeight) > 0.5 else { return }
        reportedHeight = height
        onContentSizeChange?(height)
    }
}

/// Содержимое ячейки: тот же SwiftUI-вид сообщения, что и прежде, плюс разделитель дня.
private struct MessageCell: View {

    let model: MessageRowModel
    let actions: MessageRowActions?
    let swipe: MessageSwipeState
    /// Перевод рамки из системы координат ячейки («messageCell») в окно; ставит контроллер.
    var cellToWindow: ((CGRect) -> CGRect?)? = nil

    var body: some View {
        VStack(spacing: 0) {
            if model.unreadHeader {
                // Полоса во всю ширину ленты: отрицательный отступ гасит горизонтальные 10
                // у всей ячейки. Числа Telegram: текст 13 pt, поля 6 сверху и 5 снизу.
                Text("Непрочитанные сообщения")
                    .font(.system(size: 13))
                    .foregroundStyle(Eb.textMuted)
                    .frame(maxWidth: .infinity)
                    .padding(.top, 6)
                    .padding(.bottom, 5)
                    .background(Eb.surface200.opacity(0.9))
                    .padding(.horizontal, -10)
            }
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
                participantOrder: model.participantOrder,
                forwardSlot: model.forwardSlot,
                isFirstInRun: model.isFirstInRun,
                isLastInRun: model.isLastInRun,
                selectionMode: model.selectionMode,
                selected: model.selected,
                highlighted: model.highlighted,
                onQuoteTap: { actions?.onQuoteTap($0) },
                onTap: { actions?.onTap(model.message) },
                onForward: { actions?.onForward(model.message) },
                onOpenImage: { index, frame in
                    actions?.onOpenImage(model.message, index, frame.flatMap { cellToWindow?($0) })
                },
                onOpenSender: { actions?.onOpenSender(model.message) },
                decryptSecretAttachment: actions?.decryptSecretAttachment,
                onOpenAttachment: { actions?.onOpenAttachment($0) },
                onReply: { actions?.onReply(model.message) },
                onReact: { actions?.onReact(model.message, $0) },
                onPickReaction: { actions?.onPickReaction(model.message) },
                swipe: swipe,
                quickSlots: model.quickSlots,
                onEdit: { actions?.onEdit(model.message) },
                onDelete: { actions?.onDelete(model.message) }
            )
        }
        .padding(.horizontal, 10)
        // Система координат ячейки: в ней пузырь сообщает свою рамку для жестов.
        .coordinateSpace(name: "messageCell")
        // Данные карточки цитаты — через окружение: карточка сидит глубоко внутри пузыря,
        // и протаскивать словарь через всю сигнатуру MessageRow не за что.
        .environment(\.replyQuotePreviews, model.replyQuotePreviews)
        // Тем же путём — накладка отправляемого: прогресс, отмена, повтор.
        .environment(\.outgoingUpload, OutgoingUploadBadge(
            state: model.outgoingUpload,
            onCancel: { actions?.onOutgoing(model.message.id, .cancel) },
            onRetry: { actions?.onOutgoing(model.message.id, .retry) },
            onDiscard: { actions?.onOutgoing(model.message.id, .discard) }
        ))
    }
}
