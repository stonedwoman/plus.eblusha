import SwiftUI

// Порт ImageViewer из `ui/chat/ChatScreen.kt` (полноэкранный лайтбокс, веб-паритет):
// пейджер по IMAGE-вложениям сообщения, pinch-zoom (пан в зуме, двойной тап —
// переключить), счётчик «N из M» + кнопка закрытия сверху, тап — закрыть.
// Открывается из ChatView через fullScreenCover(item:).

/// Что открыто в просмотрщике: все IMAGE-вложения тапнутого сообщения + стартовый
/// индекс (Kotlin: `viewer = imgs to idx`; Identifiable — для fullScreenCover(item:)).
struct ImageViewerState: Identifiable {
    let id = UUID()
    let images: [MessageAttachment]
    let startIndex: Int
}

struct ImageViewer: View {
    let images: [MessageAttachment]
    let startIndex: Int
    let onClose: () -> Void

    @State private var page: Int
    /// Текущая страница в зуме → листание пейджера отдаёт горизонтальные жесты
    /// панораме картинки, а не перелистыванию (Kotlin: `userScrollEnabled = !zoomed`).
    @State private var pagingLocked = false

    init(images: [MessageAttachment], startIndex: Int, onClose: @escaping () -> Void) {
        self.images = images
        self.startIndex = startIndex
        self.onClose = onClose
        _page = State(initialValue: min(max(startIndex, 0), max(images.count - 1, 0)))
    }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            TabView(selection: $page) {
                ForEach(Array(images.enumerated()), id: \.offset) { index, attachment in
                    ViewerPage(
                        attachment: attachment,
                        isCurrent: page == index,
                        onTap: onClose,
                        onZoomChanged: { pagingLocked = $0 }
                    )
                    .tag(index)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: .never))
            .scrollDisabled(pagingLocked)
            .ignoresSafeArea()

            // Верх: счётчик «N из M» (по центру) + закрыть (справа).
            VStack {
                HStack {
                    // Симметричная заглушка под кнопку закрытия — счётчик строго по центру.
                    Color.clear.frame(width: 44, height: 44)
                    Spacer()
                    Text("\(page + 1) из \(images.count)")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(.white)
                    Spacer()
                    Button(action: onClose) {
                        Image(systemName: "xmark")
                            .font(.system(size: 17, weight: .semibold))
                            .foregroundStyle(.white)
                            .frame(width: 44, height: 44)
                    }
                }
                .padding(.horizontal, 8)
                Spacer()
            }
        }
        .statusBarHidden()
    }
}

/// Одна страница просмотрщика: полноразмерный кадр с зумом/панорамой.
private struct ViewerPage: View {
    let attachment: MessageAttachment
    let isCurrent: Bool
    let onTap: () -> Void
    let onZoomChanged: (Bool) -> Void

    /// Зафиксированный масштаб (между жестами) и множитель идущего pinch-жеста.
    @State private var scale: CGFloat = 1
    @State private var gestureScale: CGFloat = 1
    /// Зафиксированная панорама и смещение идущего drag-жеста.
    @State private var offset: CGSize = .zero
    @State private var dragOffset: CGSize = .zero
    @State private var fullLoading = true
    @State private var loadFailed = false

    private var currentScale: CGFloat { min(max(scale * gestureScale, 1), 5) }
    private var zoomed: Bool { scale > 1.01 }

    var body: some View {
        GeometryReader { geo in
            ZStack {
                // Превью показываем, только пока не пришёл полноразмерный кадр: на
                // медленном канале он идёт десятки секунд, и без этого всё это время
                // была бы чернота. Трансформация зума — ОДНА на оба слоя (иначе превью
                // остаётся неподвижным, и при жесте видно вторую копию кадра).
                if fullLoading, let thumb = thumbMediaUrl(attachment.url),
                   let thumbUrl = URL(string: thumb) {
                    AsyncImage(url: thumbUrl) { phase in
                        if let image = phase.image {
                            image.resizable().scaledToFit()
                        }
                    }
                }
                // Полноразмерный кадр — resolveMediaUrl, НЕ thumb (в этом смысл лайтбокса).
                if let resolved = resolveMediaUrl(attachment.url),
                   let url = URL(string: resolved) {
                    AsyncImage(url: url) { phase in
                        switch phase {
                        case .success(let image):
                            image.resizable().scaledToFit()
                                .onAppear {
                                    fullLoading = false
                                    loadFailed = false
                                }
                        case .failure:
                            Color.clear.onAppear {
                                fullLoading = false
                                loadFailed = true
                            }
                        case .empty:
                            Color.clear
                        @unknown default:
                            Color.clear
                        }
                    }
                }
                if fullLoading && !loadFailed {
                    ProgressView().tint(Eb.brand)
                }
                if loadFailed {
                    Text("Не удалось загрузить изображение")
                        .font(.system(size: 14))
                        .foregroundStyle(.white)
                }
            }
            .padding(.horizontal, 4)
            .frame(width: geo.size.width, height: geo.size.height)
            .scaleEffect(currentScale)
            .offset(clampPan(
                CGSize(
                    width: offset.width + dragOffset.width,
                    height: offset.height + dragOffset.height
                ),
                scale: currentScale,
                in: geo.size
            ))
            .contentShape(Rectangle())
            // Двойной тап — зум, ДО одиночного (иначе одиночный не дал бы ему сработать).
            .onTapGesture(count: 2) {
                withAnimation(.easeOut(duration: 0.2)) {
                    if zoomed {
                        scale = 1
                        offset = .zero
                    } else {
                        scale = 2
                    }
                }
                onZoomChanged(zoomed)
            }
            .onTapGesture { onTap() }
            .gesture(magnify)
            .simultaneousGesture(pan(in: geo.size))
        }
        // Смена страницы сбрасывает зум/панораму — как LaunchedEffect(currentPage) в эталоне.
        .onChange(of: isCurrent) {
            scale = 1
            gestureScale = 1
            offset = .zero
            dragOffset = .zero
            if isCurrent { onZoomChanged(false) }
        }
    }

    private var magnify: some Gesture {
        MagnifyGesture()
            .onChanged { value in
                gestureScale = value.magnification
            }
            .onEnded { value in
                scale = min(max(scale * value.magnification, 1), 5)
                gestureScale = 1
                onZoomChanged(scale > 1.01)
            }
    }

    /// Панорама увеличенного кадра. Жест висит всегда, но работает только в зуме:
    /// без зума горизонтальные свайпы должны листать пейджер.
    private func pan(in size: CGSize) -> some Gesture {
        DragGesture()
            .onChanged { value in
                guard zoomed else { return }
                dragOffset = value.translation
            }
            .onEnded { value in
                guard zoomed else { return }
                offset = clampPan(
                    CGSize(
                        width: offset.width + value.translation.width,
                        height: offset.height + value.translation.height
                    ),
                    scale: scale,
                    in: size
                )
                dragOffset = .zero
            }
    }

    /// Порт clampPan из эталона: панорама не выводит кадр за края (масштабированный
    /// кадр может уехать максимум на половину «лишней» ширины/высоты).
    private func clampPan(_ proposed: CGSize, scale: CGFloat, in size: CGSize) -> CGSize {
        let maxX = size.width * (scale - 1) / 2
        let maxY = size.height * (scale - 1) / 2
        return CGSize(
            width: min(max(proposed.width, -maxX), maxX),
            height: min(max(proposed.height, -maxY), maxY)
        )
    }
}
