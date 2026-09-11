import SwiftUI
import UIKit

// Просмотрщик фото: SwiftUI-хром поверх UIKit-контроллера (контракт: файл 4).
// Жесты (зум, пейджер, свайп-закрытие) и анимации живут в PhotoViewerController —
// SwiftUI-жесты в этом проекте уже дважды ломали прокрутку, поэтому здесь только
// шапка, подпись, лента миниатюр, панель действий и тост. Связь с контроллером —
// исключительно через PhotoViewerProxy: он публикует индекс/видимость/прогресс
// закрытия, хром отдаёт команды jump/requestDismiss.
//
// Открывается из ChatView через fullScreenCover(item:) с .presentationBackground(.clear)
// и выключенной системной анимацией — появление и уход рисует сам контроллер.

struct PhotoViewerView: View {
    let gallery: PhotoViewerGallery
    let decrypt: ((MessageAttachment) async -> URL?)?
    let callbacks: PhotoViewerCallbacks

    @StateObject private var proxy: PhotoViewerProxy
    @StateObject private var store: PhotoViewerImageStore

    /// Подпись раскрыта целиком (по умолчанию — до 3 строк).
    @State private var captionExpanded = false
    /// Какая миниатюра стоит по центру ленты. Отдельно от proxy.currentIndex: пользователь
    /// может свободно листать ленту, не меняя страницу, — страница меняется только по тапу.
    @State private var stripPosition: String?
    @State private var toast: String?
    @State private var toastTask: Task<Void, Never>?
    /// Идёт скачивание/расшифровка файла для действия — второй тап не запускаем.
    @State private var actionBusy = false
    /// Хром показывается ПОСЛЕ анимации открытия (кадр ещё летит из плитки — шапка
    /// поверх него выглядела бы мусором). Дальше видимостью управляет proxy.chromeVisible.
    @State private var chromeReady = false
    @State private var confirmDelete = false

    init(
        gallery: PhotoViewerGallery,
        decrypt: ((MessageAttachment) async -> URL?)?,
        callbacks: PhotoViewerCallbacks
    ) {
        self.gallery = gallery
        self.decrypt = decrypt
        self.callbacks = callbacks
        // dismissProgress = 1 с самого начала: хром невидим, пока контроллер не закончит
        // анимацию открытия (он поднимет его в revealChrome). Ставим здесь, а не в init
        // контроллера: тот создаётся внутри makeUIViewController, то есть посреди обновления
        // SwiftUI, и публикация @Published оттуда — «Publishing changes from within view
        // updates». Всё выражение внутри autoclosure StateObject — выполняется один раз.
        _proxy = StateObject(wrappedValue: {
            let proxy = PhotoViewerProxy(currentIndex: gallery.startIndex)
            proxy.dismissProgress = 1
            return proxy
        }())
        _store = StateObject(wrappedValue: PhotoViewerImageStore(items: gallery.items, decrypt: decrypt))
        let start = gallery.startIndex
        _stripPosition = State(initialValue: gallery.items.indices.contains(start) ? gallery.items[start].id : nil)
    }

    // MARK: - Состояние

    /// Действие, которое выполнится после закрытия с анимацией (см. dismissThen).
    @State private var afterDismiss: (() -> Void)?

    /// Текущий кадр; nil только при кривом индексе (пустая галерея) — тогда хрома нет.
    private var currentItem: PhotoViewerItem? {
        gallery.items.indices.contains(proxy.currentIndex) ? gallery.items[proxy.currentIndex] : nil
    }

    /// Хром гаснет при скрытии тапом и плавно — по мере интерактивного свайпа вниз.
    private var chromeOpacity: Double {
        let visible = (proxy.chromeVisible && chromeReady) ? 1.0 : 0.0
        return visible * Double(max(0, min(1, 1 - proxy.dismissProgress)))
    }

    /// Невидимый хром не должен ловить тапы — иначе тап «показать хром» упирался бы в него.
    private var chromeInteractive: Bool {
        proxy.chromeVisible && chromeReady
    }

    /// Текущий кадр — видео: у него нет «Сохранить в Фото», «Копировать» и «Поделиться».
    /// Все три работают с UIImage и локальным файлом, а видео мы не качаем целиком — оно
    /// играет потоком (см. VideoPage.swift), и полного файла на руках просто нет.
    private var isVideoItem: Bool { currentItem?.isVideo ?? false }

    // MARK: - Body

    var body: some View {
        GeometryReader { geo in
            ZStack {
                PhotoViewerRepresentable(
                    gallery: gallery,
                    store: store,
                    proxy: proxy,
                    onDismissed: {
                        // Сначала координатор снимает обёртку, потом — отложенное действие
                        // (ответить, переслать…): кнопки закрывают просмотрщик с анимацией
                        // контроллера, а не рывком.
                        callbacks.onClose()
                        let pending = afterDismiss
                        afterDismiss = nil
                        pending?()
                    }
                )
                .ignoresSafeArea()

                if let item = currentItem {
                    chrome(item: item, width: geo.size.width)
                }
            }
        }
        .statusBarHidden(true)
        // Индикатор «домой» прячем вместе с хромом — как в системных Фото.
        .persistentSystemOverlays(proxy.chromeVisible ? .automatic : .hidden)
        .onChange(of: proxy.currentIndex) { _, index in
            // Новая страница — подпись снова свёрнута, активная миниатюра — в центр ленты.
            withAnimation(.easeOut(duration: 0.2)) { captionExpanded = false }
            guard gallery.items.indices.contains(index) else { return }
            withAnimation(.snappy) { stripPosition = gallery.items[index].id }
            // Чат под просмотрщиком подводит плитку нового кадра в видимую область: иначе
            // пролистал десяток кадров — и закрытие уходит не в плитку, а в затухание.
            // Обе воронки смены кадра (свайп пейджера и прыжок по ленте миниатюр) пишут
            // proxy.currentIndex, так что канал здесь один. Через Task, а не напрямую:
            // прокрутка ленты синхронно меняет её @Published-состояние, а мы ещё внутри
            // обработки обновления SwiftUI.
            let item = gallery.items[index]
            Task { @MainActor in callbacks.onCurrentItemChanged?(item) }
        }
        .task {
            // Из плитки кадр летит 0.38 с, без плитки — fade 0.2 с; хром — следом.
            let delay: UInt64 = gallery.sourceFrame != nil ? 380_000_000 : 200_000_000
            try? await Task.sleep(nanoseconds: delay)
            guard !Task.isCancelled else { return }
            withAnimation(.easeOut(duration: 0.2)) { chromeReady = true }
        }
        .confirmationDialog(
            isVideoItem ? "Удалить видео?" : "Удалить фото?",
            isPresented: $confirmDelete,
            titleVisibility: .visible
        ) {
            Button("Удалить", role: .destructive) {
                if let item = currentItem { dismissThen { callbacks.onDelete(item) } }
            }
            Button("Отмена", role: .cancel) {}
        } message: {
            Text(isVideoItem ? "Сообщение с этим видео будет удалено." : "Сообщение с этим фото будет удалено.")
        }
    }

    // MARK: - Хром

    private func chrome(item: PhotoViewerItem, width: CGFloat) -> some View {
        VStack(spacing: 0) {
            topBar(item: item)
                .opacity(chromeOpacity)
                .allowsHitTesting(chromeInteractive)

            // Spacer не участвует в hit-test — тап по пустому месту уходит в контроллер
            // (переключить хром), а не глохнет в SwiftUI.
            Spacer(minLength: 0)

            bottomBar(item: item, width: width)
                .opacity(chromeOpacity)
                .allowsHitTesting(chromeInteractive)
                // Тост НЕ внутри блока с opacity: он должен читаться даже когда хром
                // спрятан. Сидит над панелью действий, не двигая её.
                .overlay(alignment: .top) {
                    if let toast {
                        toastView(toast)
                            .alignmentGuide(.top) { $0[.bottom] + 12 }
                            .transition(.opacity.combined(with: .move(edge: .bottom)))
                    }
                }
        }
        .animation(.easeOut(duration: 0.2), value: proxy.chromeVisible)
        .animation(.easeOut(duration: 0.2), value: chromeReady)
    }

    // MARK: Верхняя панель

    private func topBar(item: PhotoViewerItem) -> some View {
        HStack(spacing: 0) {
            Button(action: close) {
                Image(systemName: "chevron.left")
                    .font(.system(size: 20, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .accessibilityLabel("Закрыть")

            Spacer(minLength: 4)

            VStack(spacing: 2) {
                Text(item.senderName)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(.white)
                    .lineLimit(1)
                Text(subtitle(for: item))
                    .font(.caption)
                    .foregroundStyle(.white.opacity(0.75))
                    .lineLimit(1)
            }

            Spacer(minLength: 4)

            Menu {
                if !item.isVideo {
                    Button { save(item) } label: {
                        Label("Сохранить в Фото", systemImage: "square.and.arrow.down")
                    }
                    Button { copy(item) } label: {
                        Label("Копировать", systemImage: "doc.on.doc")
                    }
                }
                if callbacks.canForward {
                    Button { dismissThen { callbacks.onForward(item) } } label: {
                        Label("Переслать", systemImage: "arrowshape.turn.up.right")
                    }
                }
                Button { dismissThen { callbacks.onShowInChat(item) } } label: {
                    Label("Показать в чате", systemImage: "text.bubble")
                }
                if item.isMine && callbacks.canDelete {
                    Button(role: .destructive) { confirmDelete = true } label: {
                        Label("Удалить", systemImage: "trash")
                    }
                }
            } label: {
                Image(systemName: "ellipsis")
                    .font(.system(size: 20, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .menuOrder(.fixed)
            .accessibilityLabel("Ещё")
        }
        .padding(.horizontal, 8)
        .frame(height: 56)
        .frame(maxWidth: .infinity)
        .background {
            // Градиент уходит под статус-бар/чёлку: панель читается на светлом фото,
            // а сам ряд кнопок остаётся в безопасной зоне.
            LinearGradient(
                colors: [.black.opacity(0.55), .clear],
                startPoint: .top,
                endPoint: .bottom
            )
            .ignoresSafeArea(edges: .top)
            .allowsHitTesting(false)
        }
    }

    /// «Сегодня в 14:03 · 3 из 12».
    private func subtitle(for item: PhotoViewerItem) -> String {
        "\(formatMessageDay(item.createdAt)) в \(formatClockTime(item.createdAt))"
            + " · \(proxy.currentIndex + 1) из \(gallery.items.count)"
    }

    // MARK: Нижняя панель

    private func bottomBar(item: PhotoViewerItem, width: CGFloat) -> some View {
        VStack(spacing: 0) {
            if let caption = item.caption {
                captionView(caption)
            }
            if gallery.items.count > 1 {
                thumbStrip(width: width)
            }
            actionBar(item: item)
        }
        // Верхние 24 pt — зона плавного перехода градиента над контентом.
        .padding(.top, 24)
        .frame(maxWidth: .infinity)
        .background {
            // Три стопа, а не два: при раскрытой подписи блок высокий, и линейный
            // clear→0.6 оставил бы верхние строки почти без подложки.
            LinearGradient(
                stops: [
                    .init(color: .clear, location: 0),
                    .init(color: .black.opacity(0.6), location: 0.3),
                    .init(color: .black.opacity(0.6), location: 1),
                ],
                startPoint: .top,
                endPoint: .bottom
            )
            .ignoresSafeArea(edges: .bottom)
            .allowsHitTesting(false)
        }
    }

    /// Подпись: до 3 строк, тап раскрывает. Очень длинный текст в раскрытом виде уходит
    /// в прокрутку фиксированной высоты, чтобы не накрыть весь кадр. Порог — по числу
    /// символов, а не по измеренной высоте: .frame(maxHeight:) в VStack с щедрым
    /// предложением занял бы весь максимум даже под одну строку.
    @ViewBuilder
    private func captionView(_ caption: String) -> some View {
        if captionExpanded && caption.count > Self.captionScrollThreshold {
            ScrollView(.vertical, showsIndicators: true) {
                captionText(caption)
            }
            .frame(height: 280)
            .contentShape(Rectangle())
            .onTapGesture { toggleCaption() }
        } else {
            captionText(caption)
                .contentShape(Rectangle())
                .onTapGesture { toggleCaption() }
        }
    }

    /// ~13 строк при 15 pt на ширине iPhone — дальше подпись читается прокруткой.
    private static let captionScrollThreshold = 600

    private func toggleCaption() {
        withAnimation(.easeOut(duration: 0.2)) { captionExpanded.toggle() }
    }

    private func captionText(_ caption: String) -> some View {
        Text(caption)
            .font(.system(size: 15))
            .foregroundStyle(.white)
            .lineLimit(captionExpanded ? nil : 3)
            .multilineTextAlignment(.leading)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
    }

    /// Лента миниатюр. Свободная прокрутка (без viewAligned), активная держится по центру
    /// через scrollPosition(id:anchor:); боковые отступы — чтобы первую и последнюю
    /// тоже можно было поставить в центр.
    private func thumbStrip(width: CGFloat) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            LazyHStack(spacing: 4) {
                ForEach(Array(gallery.items.enumerated()), id: \.element.id) { index, item in
                    PhotoViewerThumbTile(
                        image: store.thumb(for: item),
                        isActive: index == proxy.currentIndex,
                        isVideo: item.isVideo
                    )
                    .onTapGesture { proxy.jump?(index, true) }
                }
            }
            .scrollTargetLayout()
            .padding(.horizontal, stripSidePadding(width: width))
        }
        .scrollPosition(id: $stripPosition, anchor: .center)
        .frame(height: 64)
        .padding(.vertical, 6)
    }

    private func stripSidePadding(width: CGFloat) -> CGFloat {
        max(0, (width - PhotoViewerThumbTile.activeSize.width) / 2)
    }

    private func actionBar(item: PhotoViewerItem) -> some View {
        HStack(spacing: 0) {
            if item.isVideo {
                // Вместо «Поделиться»/«Сохранить» (им нужен файл целиком, а видео играет
                // потоком) — переход к сообщению: самое полезное, что остаётся.
                actionButton("text.bubble", label: "Показать в чате") {
                    dismissThen { callbacks.onShowInChat(item) }
                }
            } else {
                actionButton("square.and.arrow.up", label: "Поделиться") { share(item) }
            }
            actionButton("arrowshape.turn.up.left", label: "Ответить") { dismissThen { callbacks.onReply(item) } }
            if callbacks.canForward {
                actionButton("arrowshape.turn.up.right", label: "Переслать") { dismissThen { callbacks.onForward(item) } }
            }
            if !item.isVideo {
                actionButton("square.and.arrow.down", label: "Сохранить") { save(item) }
            }
            if item.isMine && callbacks.canDelete {
                actionButton("trash", label: "Удалить") { confirmDelete = true }
            }
        }
        .frame(height: 48)
        .padding(.horizontal, 8)
        // Пока готовится файл — кнопки приглушены: видно, что действие уже идёт.
        .disabled(actionBusy)
        .opacity(actionBusy ? 0.5 : 1)
    }

    private func actionButton(_ symbol: String, label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 20))
                .foregroundStyle(.white)
                .frame(maxWidth: .infinity, minHeight: 48)
                .contentShape(Rectangle())
        }
        .accessibilityLabel(label)
    }

    // MARK: Тост

    private func toastView(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 14, weight: .medium))
            .foregroundStyle(.white)
            .multilineTextAlignment(.center)
            .padding(.horizontal, 14)
            .padding(.vertical, 9)
            .background(.black.opacity(0.7), in: Capsule())
            .padding(.horizontal, 24)
    }

    private func showToast(_ text: String?) {
        guard let text else { return }
        toastTask?.cancel()
        withAnimation(.easeOut(duration: 0.2)) { toast = text }
        toastTask = Task {
            try? await Task.sleep(nanoseconds: 1_400_000_000)
            guard !Task.isCancelled else { return }
            withAnimation(.easeOut(duration: 0.25)) { toast = nil }
        }
    }

    // MARK: - Действия

    /// Закрыть с анимацией контроллера (в плитку, если можно); если контроллер ещё не
    /// повесил команду — просто снимаем обёртку.
    private func close() {
        if let requestDismiss = proxy.requestDismiss {
            requestDismiss()
        } else {
            callbacks.onClose()
            let pending = afterDismiss
            afterDismiss = nil
            pending?()
        }
    }

    /// Закрыть с анимацией и после этого выполнить действие координатора.
    private func dismissThen(_ action: @escaping () -> Void) {
        afterDismiss = action
        close()
    }

    /// Что есть в памяти для действия: полный кадр, иначе миниатюра (isFull = false).
    private func resolvedImage(_ item: PhotoViewerItem) -> (image: UIImage, isFull: Bool)? {
        if let full = store.full(for: item) { return (full, true) }
        if let thumb = store.thumb(for: item) { return (thumb, false) }
        return nil
    }

    private func share(_ item: PhotoViewerItem) {
        guard !actionBusy else { return }
        guard let picked = resolvedImage(item) else {
            showToast("Кадр ещё загружается")
            return
        }
        actionBusy = true
        Task {
            // Файл важнее картинки в памяти: получатель получит оригинал с именем.
            let file = await store.localFile(for: item)
            actionBusy = false
            if file == nil && !picked.isFull { showToast("Кадр ещё загружается") }
            PhotoViewerActions.share(fileURL: file, image: picked.image, from: nil)
        }
    }

    private func save(_ item: PhotoViewerItem) {
        guard !actionBusy else { return }
        guard let picked = resolvedImage(item) else {
            showToast("Кадр ещё загружается")
            return
        }
        actionBusy = true
        Task {
            let file = await store.localFile(for: item)
            // В Фото пишем только настоящий кадр: файл или полноразмер из памяти.
            // Миниатюру в библиотеку не кладём — потом её оттуда не отличить.
            guard file != nil || picked.isFull else {
                actionBusy = false
                showToast("Кадр ещё загружается")
                return
            }
            let result = await PhotoViewerActions.save(picked.image, fileURL: file)
            actionBusy = false
            showToast(result.toastText)
        }
    }

    private func copy(_ item: PhotoViewerItem) {
        guard !actionBusy else { return }
        guard let picked = resolvedImage(item) else {
            showToast("Кадр ещё загружается")
            return
        }
        let result = PhotoViewerActions.copy(picked.image)
        // Скопировали миниатюру — честно говорим, что полный кадр ещё в пути.
        showToast(picked.isFull ? result.toastText : "Кадр ещё загружается")
    }
}

// MARK: - Плитка ленты миниатюр

private struct PhotoViewerThumbTile: View {
    static let activeSize = CGSize(width: 48, height: 64)
    static let normalSize = CGSize(width: 36, height: 48)

    let image: UIImage?
    let isActive: Bool
    /// Видео помечаем уголком с треугольником: по одному постеру фото от видео не отличить.
    var isVideo: Bool = false

    private var size: CGSize { isActive ? Self.activeSize : Self.normalSize }

    var body: some View {
        ZStack {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            } else {
                // Миниатюра ещё не пришла (или секретная до расшифровки) — серая плитка.
                Eb.surface300
            }
        }
        .frame(width: size.width, height: size.height)
        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
        .overlay(alignment: .bottomTrailing) {
            if isVideo {
                Image(systemName: "play.fill")
                    .font(.system(size: 8, weight: .bold))
                    .foregroundStyle(.white)
                    .padding(3)
                    .background(.black.opacity(0.45), in: Circle())
                    .padding(3)
            }
        }
        .overlay {
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .strokeBorder(.white, lineWidth: isActive ? 2 : 0)
        }
        .contentShape(Rectangle())
        .animation(.snappy, value: isActive)
    }
}

// MARK: - Обёртка над UIKit-контроллером

private struct PhotoViewerRepresentable: UIViewControllerRepresentable {
    let gallery: PhotoViewerGallery
    let store: PhotoViewerImageStore
    let proxy: PhotoViewerProxy
    let onDismissed: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onDismissed: onDismissed)
    }

    func makeUIViewController(context: Context) -> PhotoViewerController {
        // Контроллер получает замыкание один раз, а callbacks у ChatView пересобираются
        // на каждом рендере — поэтому зовём через координатор, у которого замыкание
        // обновляется в updateUIViewController.
        let coordinator = context.coordinator
        return PhotoViewerController(
            gallery: gallery,
            store: store,
            proxy: proxy,
            onDismissed: { coordinator.onDismissed() }
        )
    }

    func updateUIViewController(_ controller: PhotoViewerController, context: Context) {
        context.coordinator.onDismissed = onDismissed
    }

    final class Coordinator {
        var onDismissed: () -> Void
        init(onDismissed: @escaping () -> Void) { self.onDismissed = onDismissed }
    }
}
