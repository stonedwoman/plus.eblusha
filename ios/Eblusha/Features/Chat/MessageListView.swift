import SwiftUI

/// Лента переписки. Вынесена из ChatView вместе со всей механикой прокрутки.
///
/// Прежняя лента держалась на двух подпорках: `.defaultScrollAnchor(.bottom)` и невидимом
/// маркере высотой 1 pt в конце стека, чей `onAppear` считался признаком «мы у низа».
/// Обе врали. Маркер в LazyVStack срабатывает на МАТЕРИАЛИЗАЦИЮ, а не на видимость, и
/// после любой перезаливки массива стрелял невпопад — отсюда «новые сообщения не клеятся
/// к низу» через раз. А единственный якорь на iOS 17 применялся сразу ко всем ролям, и
/// вклеенная сверху страница истории двигала текст под пальцем.
///
/// Теперь позиция берётся из настоящей геометрии скролла (`onScrollGeometryChange`), роли
/// якоря разведены (`initialOffset` / `alignment` / `sizeChanges`), а для страницы истории
/// якорь на время вклейки переключается на низ — так вставка сверху не двигает видимое.
struct MessageListView: View {

    @ObservedObject var vm: ChatViewModel
    /// Растёт, когда ленте нужно вернуться к низу не из-за нового сообщения: выехала
    /// клавиатура, вырос композер, человек нажал «отправить».
    let pinToken: Int
    let onForward: (Message) -> Void
    let onOpenImage: ([MessageAttachment], Int) -> Void
    let onOpenSender: (Message) -> Void
    let onOpenAttachment: (MessageAttachment) -> Void
    let onEdit: (Message) -> Void

    /// Низ контента — отдельная точка привязки. Целиться в последнее СООБЩЕНИЕ нельзя:
    /// под ним ещё паддинг стека, и прокрутка к нему оставляла пузырь под кромкой.
    private static let bottomAnchor = "eb.chat.bottom"
    /// Порог «мы у низа»: примерно один пузырь. Веб использует rootMargin 40px, Android —
    /// «последний элемент виден».
    private static let bottomThreshold: CGFloat = 80

    @State private var atBottom = true
    @State private var userInteracting = false
    /// Первая привязка к низу отработала — до неё нельзя ни грузить историю, ни следовать
    /// за сообщениями: лента ещё складывается.
    @State private var didInitialPin = false
    /// Следующее пришедшее сообщение утягивает ленту вниз независимо от позиции — это
    /// наше собственное отправленное сообщение, его человек обязан увидеть.
    @State private var followNextMessage = false
    @State private var pinTask: Task<Void, Never>?

    // Переход к цитате.
    @State private var jumpTask: Task<Void, Never>?
    @State private var jumping = false
    @State private var jumpNotice: String?
    @State private var highlightedId: String?

    private struct ScrollMetrics: Equatable {
        var distanceToBottom: CGFloat = 0
        var offsetFromTop: CGFloat = 0
        var viewportHeight: CGFloat = 1
    }

    /// Ключ, по которому лента решает «приехало новое» — count И последний id: подмена
    /// оптимистичного сообщения серверным не меняет количество, а правка последнего не
    /// меняет id, и оба случая одинаково требуют доводки позиции.
    private struct BottomKey: Equatable {
        let count: Int
        let lastId: String?
    }

    /// Строка ленты вместе с местом в «ране» — считается один раз за проход, а не
    /// индексной арифметикой внутри ForEach на каждую ячейку.
    private struct RowSpec: Identifiable {
        let message: Message
        let isFirstInRun: Bool
        let isLastInRun: Bool
        /// Заголовок дня, если это первое сообщение суток.
        let dayHeader: String?
        var id: String { message.id }
    }

    /// Имена отправителей из загруженной истории — плитке цитаты нужно показать, кому
    /// отвечают, а сама цитата несёт только id автора.
    private var senderNames: [String: String] {
        var names: [String: String] = [:]
        for message in vm.ui.messages where !message.senderName.isEmpty {
            names[message.senderId] = message.senderName
        }
        return names
    }

    private var rows: [RowSpec] {
        // Удалённые в ленте не показываем — как в вебе и на Android: надгробия
        // «Сообщение удалено» копились и засоряли историю.
        let messages = vm.ui.messages.filter { !$0.deleted }
        return messages.enumerated().map { index, message in
            let earlier = index > 0 ? messages[index - 1] : nil
            let newDay = earlier.map { localDayIndex($0.createdAt) != localDayIndex(message.createdAt) } ?? true
            return RowSpec(
                message: message,
                isFirstInRun: !continuesRun(earlier, message),
                isLastInRun: !continuesRun(message, index + 1 < messages.count ? messages[index + 1] : nil),
                dayHeader: newDay ? formatMessageDay(message.createdAt) : nil
            )
        }
    }

    /// Куда тянуть контент, когда меняется его размер. При вклейке страницы истории —
    /// к низу: расстояние до низа сохраняется, и видимое остаётся на месте. Когда человек
    /// читает историю — к верху, иначе чужое сообщение выдёргивало бы текст из-под глаз.
    private var sizeChangeAnchor: UnitPoint {
        (atBottom || vm.ui.prepending) ? .bottom : .top
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                let names = senderNames
                LazyVStack(spacing: 0) {
                    ForEach(rows) { spec in
                        if let day = spec.dayHeader {
                            // Разделитель дней: без него вся история читается как «сегодня».
                            Text(day)
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(Eb.textMuted)
                                .padding(.horizontal, 10)
                                .padding(.vertical, 3)
                                .background(Eb.surface200, in: Capsule())
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 8)
                        }
                        row(spec, names: names, proxy: proxy)
                    }
                    Color.clear
                        .frame(height: 1)
                        .id(Self.bottomAnchor)
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
            }
            .scrollDismissesKeyboard(.interactively)
            .defaultScrollAnchor(.bottom, for: .initialOffset)
            .defaultScrollAnchor(.bottom, for: .alignment)
            .defaultScrollAnchor(sizeChangeAnchor, for: .sizeChanges)
            .onScrollGeometryChange(for: ScrollMetrics.self) { geometry in
                ScrollMetrics(
                    distanceToBottom: geometry.contentSize.height
                        - geometry.contentOffset.y
                        - geometry.containerSize.height
                        + geometry.contentInsets.bottom,
                    offsetFromTop: geometry.contentOffset.y + geometry.contentInsets.top,
                    viewportHeight: max(geometry.containerSize.height, 1)
                )
            } action: { _, value in
                // В @State кладём ТОЛЬКО факт «мы у низа» и только когда он поменялся:
                // расстояние меняется каждый кадр прокрутки, и запись его в состояние
                // перестраивала бы ленту 120 раз в секунду — ровно та тряска, от которой
                // мы здесь и избавляемся.
                let nowAtBottom = value.distanceToBottom < Self.bottomThreshold
                if nowAtBottom != atBottom { atBottom = nowAtBottom }
                maybeLoadOlder(offsetFromTop: value.offsetFromTop, viewport: value.viewportHeight)
            }
            .onScrollPhaseChange { _, phase in
                // Пока палец ведёт ленту, никакие наши доводки в неё не лезут.
                let active = phase == .tracking || phase == .interacting || phase == .decelerating
                if active != userInteracting { userInteracting = active }
            }
            // Верхняя плашка: загрузка истории и ход перехода к цитате. В потоке ленты
            // индикатору не место — появляясь и исчезая, он дважды дёргал высоту контента.
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
            .overlay(alignment: .bottomTrailing) {
                scrollDownButton(proxy: proxy)
            }
            .animation(.easeOut(duration: 0.15), value: atBottom)
            .animation(.easeOut(duration: 0.15), value: vm.ui.loadingOlder)
            .task(id: vm.conversationId) {
                await initialPin(proxy: proxy)
            }
            .onChange(of: BottomKey(count: rows.count, lastId: rows.last?.id)) { _, _ in
                onMessagesChanged(proxy: proxy)
            }
            .onChange(of: pinToken) { _, _ in
                // Клавиатура, рост композера, своя отправка: возвращаемся к низу, только
                // если человек там и был, — читающего историю дёргать нельзя.
                guard atBottom || followNextMessage else { return }
                pin(proxy: proxy, repeats: 6)
            }
            .onDisappear { pinTask?.cancel(); jumpTask?.cancel() }
        }
    }

    // MARK: - Строка

    private func row(_ spec: RowSpec, names: [String: String], proxy: ScrollViewProxy) -> some View {
        let message = spec.message
        return MessageRow(
            m: message,
            isGroup: vm.ui.isGroup,
            senderAvatarUrl: vm.ui.senderAvatars[message.senderId] ?? nil,
            senderNames: names,
            isFirstInRun: spec.isFirstInRun,
            isLastInRun: spec.isLastInRun,
            selectionMode: vm.ui.selectionMode,
            selected: vm.ui.selectedIds.contains(message.id),
            highlighted: message.id == highlightedId,
            onQuoteTap: { targetId in jumpToQuote(targetId, proxy: proxy) },
            onTap: { if vm.ui.selectionMode { vm.toggleSelect(message.id) } },
            onStartSelect: { vm.startSelection(message.id) },
            onForward: { onForward(message) },
            onOpenImage: onOpenImage,
            onOpenSender: { onOpenSender(message) },
            decryptSecretAttachment: vm.ui.isSecret ? { await vm.decryptSecretAttachment($0) } : nil,
            onOpenAttachment: onOpenAttachment,
            onReply: { vm.setReply(message) },
            onReact: { vm.react(message, emoji: $0) },
            onEdit: { onEdit(message) },
            onDelete: { vm.delete(messageId: message.id) }
        )
        .id(message.id)
    }

    private func scrollDownButton(proxy: ScrollViewProxy) -> some View {
        Button {
            followNextMessage = false
            withAnimation(.easeOut(duration: 0.22)) {
                proxy.scrollTo(Self.bottomAnchor, anchor: .bottom)
            }
            atBottom = true
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
        .opacity(atBottom ? 0 : 1)
        // Скрытую кнопку нельзя оставлять кликабельной — она ловила бы тапы по последнему
        // сообщению.
        .allowsHitTesting(!atBottom)
    }

    // MARK: - Привязка к низу

    /// Открытие чата: мгновенно ставим ленту на последнее сообщение и несколько раз
    /// переспрашиваем — аватары и картинки дорисовываются позже и растят высоту.
    /// Порт стартового блока ChatScreen.kt (scrollToItem + 12 повторов по 40 мс).
    private func initialPin(proxy: ScrollViewProxy) async {
        didInitialPin = false
        guard !vm.ui.messages.isEmpty else {
            // Сообщений ещё нет: первая страница приедет и отработает onMessagesChanged.
            return
        }
        pin(proxy: proxy, repeats: 12, animated: false)
        didInitialPin = true
    }

    private func onMessagesChanged(proxy: ScrollViewProxy) {
        guard !rows.isEmpty else { return }
        if !didInitialPin {
            // Первая страница только что приехала — это и есть открытие чата.
            pin(proxy: proxy, repeats: 12, animated: false)
            didInitialPin = true
            return
        }
        guard !jumping else { return }
        if followNextMessage {
            followNextMessage = false
            pin(proxy: proxy, repeats: 6, animated: false)
            return
        }
        guard atBottom else { return }
        pin(proxy: proxy, repeats: 6)
    }

    /// Доводка к низу с повторами: одна попытка промахивается, пока ячейки ещё меряются.
    private func pin(proxy: ScrollViewProxy, repeats: Int, animated: Bool = true) {
        pinTask?.cancel()
        atBottom = true
        let scroll = {
            proxy.scrollTo(Self.bottomAnchor, anchor: .bottom)
        }
        if animated {
            withAnimation(.easeOut(duration: 0.18), scroll)
        } else {
            scroll()
        }
        guard repeats > 0 else { return }
        pinTask = Task { @MainActor in
            for _ in 0..<repeats {
                try? await Task.sleep(for: .milliseconds(40))
                if Task.isCancelled || userInteracting { return }
                scroll()
            }
        }
    }

    private func maybeLoadOlder(offsetFromTop: CGFloat, viewport: CGFloat) {
        guard didInitialPin, !jumping, vm.ui.hasMore, !vm.ui.loadingOlder else { return }
        // Тянем следующую страницу за полтора экрана до верха, а не в упор к нему: иначе
        // лента упирается в пустоту и ждёт сеть у человека на глазах.
        guard offsetFromTop < viewport * 1.5 else { return }
        vm.loadOlder()
    }

    // MARK: - Переход к цитате

    /// Сервер умеет только «страницу назад по курсору» — оригинал старше загруженного
    /// тянется страницами (vm.loadUntil), затем прицел в центр и подсветка.
    private func jumpToQuote(_ targetId: String, proxy: ScrollViewProxy) {
        // Повторный тап отменяет предыдущий переход, а не игнорируется молча.
        jumpTask?.cancel()
        jumpTask = Task { @MainActor in
            jumping = true
            highlightedId = nil
            defer {
                jumping = false
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
            // Прицеливаемся несколько раз: страница вклеивается в LazyVStack постепенно,
            // и одиночный scrollTo промахивался мимо цели.
            for _ in 0..<6 {
                withAnimation(.easeOut(duration: 0.25)) {
                    proxy.scrollTo(targetId, anchor: .center)
                }
                try? await Task.sleep(for: .milliseconds(60))
                if Task.isCancelled { return }
            }
            highlightedId = targetId
            try? await Task.sleep(for: .seconds(1.6))
            if highlightedId == targetId { highlightedId = nil }
        }
    }
}
