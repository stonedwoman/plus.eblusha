import SwiftUI
import UIKit

/// Экран редактора: пейджер по выбранным кадрам, холст, панель активного инструмента,
/// вкладки инструментов, подпись и отправка.
///
/// Инструменты живут в отдельных файлах (CropTool, DrawTool, OverlayTool, AdjustTool)
/// и общаются с холстом через `PhotoEditorToolState` и `EditGeometry` — здесь только
/// сборка экрана.
struct PhotoEditorView: View {

    /// Кадры на редактирование (порядок сохраняется при отправке).
    let items: [PhotoEditItem]
    /// Файлы, выбранные вместе с фото, но не картинки — уедут как есть.
    let passthrough: [OutgoingFile]
    /// Подпись, набранная до открытия редактора.
    let initialCaption: String
    /// Готово: отредактированные кадры + прочие файлы + подпись.
    let onDone: ([OutgoingFile], String) -> Void
    let onCancel: () -> Void

    @StateObject private var tools = PhotoEditorToolState()
    @State private var page = 0
    @State private var caption: String
    @State private var exporting = false
    @FocusState private var captionFocused: Bool

    init(
        items: [PhotoEditItem], passthrough: [OutgoingFile] = [], initialCaption: String = "",
        onDone: @escaping ([OutgoingFile], String) -> Void, onCancel: @escaping () -> Void
    ) {
        self.items = items
        self.passthrough = passthrough
        self.initialCaption = initialCaption
        self.onDone = onDone
        self.onCancel = onCancel
        _caption = State(initialValue: initialCaption)
    }

    private var current: PhotoEditItem? {
        items.indices.contains(page) ? items[page] : nil
    }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            VStack(spacing: 0) {
                topBar
                canvasArea
                bottomPanel
            }
            if exporting {
                Color.black.opacity(0.5).ignoresSafeArea()
                ProgressView("Готовим фото…")
                    .tint(.white)
                    .foregroundStyle(.white)
            }
        }
        .statusBarHidden()
        .onChange(of: page) { _, _ in
            // На другом кадре выделение прошлого не имеет смысла.
            tools.selection = nil
            tools.editingText = nil
        }
    }

    // MARK: - Верх

    private var topBar: some View {
        HStack(spacing: 4) {
            Button(action: onCancel) {
                Image(systemName: "xmark")
                    .font(.system(size: 17, weight: .semibold))
                    .frame(width: 44, height: 44)
            }
            Spacer()
            if let item = current {
                // Отдельная вью с @ObservedObject: иначе кнопки не узнавали бы о pushUndo
                // из жестов, пока экран не перерисуется по другой причине.
                EditorUndoControls(item: item)
            }
        }
        .foregroundStyle(.white)
        .padding(.horizontal, 6)
    }

    // MARK: - Холст

    private var canvasArea: some View {
        ZStack {
            if items.count > 1 {
                TabView(selection: $page) {
                    ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                        PhotoEditorCanvas(item: item, tools: tools)
                            .tag(index)
                    }
                }
                .tabViewStyle(.page(indexDisplayMode: .never))
                // Пока рисуют или тянут рамку, листать кадры нельзя — жесты столкнутся.
                .scrollDisabled(tools.activeTool != nil)
            } else if let item = current {
                PhotoEditorCanvas(item: item, tools: tools)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onTapGesture {
            captionFocused = false
        }
    }

    // MARK: - Низ

    private var bottomPanel: some View {
        VStack(spacing: 8) {
            if let item = current, let tool = tools.activeTool {
                toolbar(for: tool, item: item)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
            toolTabs
            if items.count > 1 {
                thumbnails
            }
            captionRow
        }
        .padding(.top, 8)
        .background(Color.black)
        .animation(.easeOut(duration: 0.18), value: tools.activeTool)
    }

    @ViewBuilder
    private func toolbar(for tool: PhotoTool, item: PhotoEditItem) -> some View {
        switch tool {
        case .crop: CropToolbar(item: item, tools: tools)
        case .draw: DrawToolbar(item: item, tools: tools)
        case .blur: BlurToolbar(item: item, tools: tools)
        case .text: TextToolbar(item: item, tools: tools)
        case .sticker: StickerToolbar(item: item, tools: tools)
        case .adjust: AdjustToolbar(item: item, tools: tools)
        }
    }

    private var toolTabs: some View {
        HStack(spacing: 0) {
            ForEach(PhotoTool.allCases) { tool in
                let active = tools.activeTool == tool
                Button {
                    // Повторный тап по активному инструменту сворачивает его панель.
                    tools.activeTool = active ? nil : tool
                    tools.selection = nil
                    captionFocused = false
                } label: {
                    VStack(spacing: 3) {
                        Image(systemName: tool.icon)
                            .font(.system(size: 18, weight: .medium))
                        Text(tool.title)
                            .font(.system(size: 10))
                    }
                    .foregroundStyle(active ? Eb.brand : .white.opacity(0.85))
                    .frame(maxWidth: .infinity)
                    .frame(height: 48)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 4)
    }

    private var thumbnails: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                    Image(uiImage: item.thumbnail)
                        .resizable()
                        .scaledToFill()
                        .frame(width: 44, height: 44)
                        .clipShape(RoundedRectangle(cornerRadius: 7))
                        .overlay(
                            RoundedRectangle(cornerRadius: 7)
                                .strokeBorder(index == page ? Eb.brand : .white.opacity(0.25),
                                              lineWidth: index == page ? 2 : 1)
                        )
                        .onTapGesture { withAnimation { page = index } }
                }
            }
            .padding(.horizontal, 12)
        }
        .frame(height: 52)
    }

    private var captionRow: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField("Подпись", text: $caption, axis: .vertical)
                .lineLimit(1...4)
                .focused($captionFocused)
                .foregroundStyle(.white)
                .padding(.horizontal, 14)
                .padding(.vertical, 9)
                .background(Color.white.opacity(0.12), in: RoundedRectangle(cornerRadius: 20))
            Button(action: send) {
                Image(systemName: "arrow.up")
                    .font(.system(size: 17, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 38, height: 38)
                    .background(Eb.brand, in: Circle())
            }
            .disabled(exporting)
        }
        .padding(.horizontal, 10)
        .padding(.bottom, 10)
    }

    // MARK: - Отправка

    private func send() {
        guard !exporting else { return }
        exporting = true
        captionFocused = false
        // Снимки документов берём на главном потоке — рендер уйдёт в фон без доступа к модели.
        let snapshot = items.map { (document: $0.document, source: $0.source, image: $0.image) }
        let files = passthrough
        let text = caption
        // Рендер полноразмерных кадров — секунды на больших фото; не в главном потоке.
        Task.detached(priority: .userInitiated) {
            var result: [OutgoingFile] = []
            for entry in snapshot {
                let exported = PhotoEditorRenderer.exportBytes(
                    document: entry.document, source: entry.source, image: entry.image
                )
                result.append(OutgoingFile(bytes: exported.bytes, name: exported.name, mime: exported.mime))
            }
            let all = result + files
            await MainActor.run {
                exporting = false
                onDone(all, text)
            }
        }
    }
}

/// Отмена, повтор и сброс — наблюдают кадр напрямую.
private struct EditorUndoControls: View {
    @ObservedObject var item: PhotoEditItem

    var body: some View {
        HStack(spacing: 4) {
            Button { item.undo() } label: {
                Image(systemName: "arrow.uturn.backward")
                    .frame(width: 40, height: 44)
            }
            .disabled(!item.canUndo)
            Button { item.redo() } label: {
                Image(systemName: "arrow.uturn.forward")
                    .frame(width: 40, height: 44)
            }
            .disabled(!item.canRedo)
            Button { item.reset() } label: {
                Text("Сброс")
                    .font(.subheadline)
                    .frame(height: 44)
                    .padding(.horizontal, 8)
            }
            .disabled(item.document.isPristine)
        }
    }
}

// MARK: - Общее состояние инструментов

/// Что сейчас выбрано в панелях: активный инструмент, кисть, цвет, стиль текста,
/// выделенный объект. Один объект на весь экран, чтобы холст и панели видели одно и то же.
@MainActor
final class PhotoEditorToolState: ObservableObject {
    @Published var activeTool: PhotoTool?

    // Кисть.
    @Published var brushKind: BrushKind = .pen
    @Published var brushColor: Color = Color(hex: 0xFF3B30)
    /// Доля ширины кадра.
    @Published var brushWidth: CGFloat = 0.012

    // Размытие.
    @Published var blurSoft = false
    @Published var blurWidth: CGFloat = 0.08

    // Обрезка.
    @Published var cropAspect: CropAspect = .free

    // Текст и стикеры.
    @Published var selection: OverlaySelection?
    @Published var textColor: Color = .white
    @Published var textStyle: TextStyle = .pill
    /// Текст, открытый на редактирование (лист с полем ввода).
    @Published var editingText: UUID?
}

// MARK: - Холст

/// Показывает кадр с текущими правками и кладёт поверх слой активного инструмента.
///
/// Как считается геометрия: в режиме обрезки показан ВЕСЬ повёрнутый кадр (рамка
/// рисуется поверх), в остальных режимах — только обрезанная область. `EditGeometry`
/// переводит экранные точки в координаты исходного кадра, поэтому инструментам не
/// нужно знать про поворот и обрезку.
struct PhotoEditorCanvas: View {

    @ObservedObject var item: PhotoEditItem
    @ObservedObject var tools: PhotoEditorToolState
    @StateObject private var preview = PhotoPreviewCache()

    var body: some View {
        GeometryReader { proxy in
            let document = item.document
            let showingFull = tools.activeTool == .crop
            let rect = displayRect(in: proxy.size, document: document, showingFull: showingFull)
            let geometry = EditGeometry(
                document: document, originalSize: item.image.size, displayRect: rect, showingFullFrame: showingFull
            )

            ZStack {
                baseLayer(document: document, geometry: geometry, showingFull: showingFull)
                    .frame(width: proxy.size.width, height: proxy.size.height)
                    .clipped()

                PhotoStrokesLayer(item: item, geometry: geometry, preview: preview)
                    .frame(width: proxy.size.width, height: proxy.size.height)
                    .clipShape(Rectangle().path(in: rect))
                    .allowsHitTesting(false)

                OverlayInteractionView(
                    item: item, tools: tools, geometry: geometry,
                    interactive: tools.activeTool == .text || tools.activeTool == .sticker
                )
                .frame(width: proxy.size.width, height: proxy.size.height)

                if tools.activeTool == .draw || tools.activeTool == .blur {
                    DrawInteractionView(item: item, tools: tools, geometry: geometry)
                        .frame(width: proxy.size.width, height: proxy.size.height)
                }
                if tools.activeTool == .crop {
                    CropOverlayView(item: item, tools: tools, frameRect: rect)
                        .frame(width: proxy.size.width, height: proxy.size.height)
                }
            }
            .onAppear { preview.update(image: item.image, adjustments: document.adjustments) }
            .onChange(of: document.adjustments) { _, adjustments in
                preview.update(image: item.image, adjustments: adjustments)
            }
        }
    }

    /// Где на экране лежит показанная область: вписываем её пропорции в доступное место.
    private func displayRect(in size: CGSize, document: PhotoEditDocument, showingFull: Bool) -> CGRect {
        let shown = document.displaySize(for: item.image.size)
        let crop = showingFull ? CropRect.full : document.crop
        let regionWidth = max(shown.width * crop.w, 1)
        let regionHeight = max(shown.height * crop.h, 1)
        let inset: CGFloat = showingFull ? 24 : 8
        let available = CGSize(width: max(size.width - inset * 2, 1), height: max(size.height - inset * 2, 1))
        let scale = min(available.width / regionWidth, available.height / regionHeight)
        let width = regionWidth * scale
        let height = regionHeight * scale
        return CGRect(x: (size.width - width) / 2, y: (size.height - height) / 2, width: width, height: height)
    }

    /// Кадр с коррекцией, повёрнутый, сдвинутый так, чтобы в displayRect попала обрезка.
    @ViewBuilder
    private func baseLayer(document: PhotoEditDocument, geometry: EditGeometry, showingFull: Bool) -> some View {
        if let image = preview.base {
            let crop = showingFull ? CropRect.full : document.crop
            let rect = geometry.displayRect
            let fullWidth = rect.width / max(crop.w, 0.001)
            let fullHeight = rect.height / max(crop.h, 0.001)
            let fullRect = CGRect(
                x: rect.minX - crop.x * fullWidth, y: rect.minY - crop.y * fullHeight,
                width: fullWidth, height: fullHeight
            )
            Image(uiImage: image)
                .resizable()
                .rotationEffect(.degrees(Double(document.quarterTurns % 4) * 90))
                .scaleEffect(x: document.flippedHorizontally ? -1 : 1, y: 1)
                // Поворот делается вокруг центра неповёрнутого фрейма, поэтому под
                // повёрнутый кадр даём фрейм с обратными сторонами и тот же центр.
                .frame(
                    width: document.quarterTurns % 2 == 0 ? fullRect.width : fullRect.height,
                    height: document.quarterTurns % 2 == 0 ? fullRect.height : fullRect.width
                )
                .position(x: fullRect.midX, y: fullRect.midY)
                .mask(
                    Rectangle()
                        .frame(width: rect.width, height: rect.height)
                        .position(x: rect.midX, y: rect.midY)
                )
        } else {
            Color.clear
        }
    }
}

/// Превью-кадры для холста: с коррекцией, мозаикой и размытием. Считаются в фоне и
/// переиспользуются, пока коррекция не поменялась.
@MainActor
final class PhotoPreviewCache: ObservableObject {
    @Published private(set) var base: UIImage?
    @Published private(set) var pixelated: UIImage?
    @Published private(set) var blurred: UIImage?

    private var appliedAdjustments: Adjustments?
    private var task: Task<Void, Never>?
    /// Предел стороны превью: и быстро, и на экране разницы не видно.
    private static let maxDimension: CGFloat = 1600

    func update(image: UIImage, adjustments: Adjustments) {
        guard appliedAdjustments != adjustments || base == nil else { return }
        appliedAdjustments = adjustments
        task?.cancel()
        task = Task.detached(priority: .userInitiated) { [weak self] in
            let adjusted = PhotoEditorRenderer.adjusted(image, adjustments, maxDimension: Self.maxDimension)
            guard !Task.isCancelled else { return }
            await MainActor.run { self?.base = adjusted; self?.pixelated = nil; self?.blurred = nil }
            let mosaic = PhotoEditorRenderer.pixelated(adjusted)
            let soft = PhotoEditorRenderer.blurred(adjusted)
            guard !Task.isCancelled else { return }
            await MainActor.run { self?.pixelated = mosaic; self?.blurred = soft }
        }
    }
}

/// Живой слой штрихов и размытия поверх кадра — SwiftUI Canvas, координаты через геометрию.
struct PhotoStrokesLayer: View {
    @ObservedObject var item: PhotoEditItem
    let geometry: EditGeometry
    @ObservedObject var preview: PhotoPreviewCache

    var body: some View {
        Canvas { context, _ in
            let document = item.document
            let ppw = geometry.pixelsPerOriginalWidth

            // Размытие: мозаичная/размытая копия кадра, обрезанная по пути штриха. Копия —
            // это целый неповёрнутый кадр, поэтому рисуем её через тот же поворот и
            // отражение, что и базовый слой, иначе мозаика не совпадёт с картинкой.
            for blur in document.blurs where blur.points.count > 1 {
                guard let layer = blur.soft ? preview.blurred : preview.pixelated else { continue }
                let path = screenPath(blur.points)
                var clip = context
                clip.clip(to: path.strokedPath(StrokeStyle(lineWidth: max(2, blur.width * ppw), lineCap: .round, lineJoin: .round)))
                let frame = fullFrameRect()
                let turns = document.quarterTurns % 4
                let unrotated = turns % 2 == 0
                    ? frame.size
                    : CGSize(width: frame.height, height: frame.width)
                clip.translateBy(x: frame.midX, y: frame.midY)
                if document.flippedHorizontally { clip.scaleBy(x: -1, y: 1) }
                clip.rotate(by: .degrees(Double(turns) * 90))
                clip.draw(
                    Image(uiImage: layer),
                    in: CGRect(x: -unrotated.width / 2, y: -unrotated.height / 2, width: unrotated.width, height: unrotated.height)
                )
            }

            // Штрихи — на отдельном слое, чтобы ластик стирал только их.
            context.drawLayer { layer in
                for stroke in document.strokes where stroke.points.count > 1 {
                    let path = screenPath(stroke.points)
                    let width = max(1, stroke.width * ppw)
                    switch stroke.kind {
                    case .pen:
                        layer.stroke(path, with: .color(stroke.color), style: StrokeStyle(lineWidth: width, lineCap: .round, lineJoin: .round))
                    case .marker:
                        layer.stroke(path, with: .color(stroke.color.opacity(0.45)), style: StrokeStyle(lineWidth: width * 2.2, lineCap: .square, lineJoin: .round))
                    case .neon:
                        var glow = layer
                        glow.addFilter(.shadow(color: stroke.color, radius: width * 1.6))
                        glow.stroke(path, with: .color(stroke.color), style: StrokeStyle(lineWidth: width * 1.4, lineCap: .round, lineJoin: .round))
                        layer.stroke(path, with: .color(.white), style: StrokeStyle(lineWidth: width * 0.55, lineCap: .round, lineJoin: .round))
                    case .arrow:
                        layer.stroke(path, with: .color(stroke.color), style: StrokeStyle(lineWidth: width, lineCap: .round, lineJoin: .round))
                        layer.fill(arrowHeadPath(stroke.points, width: width), with: .color(stroke.color))
                    case .eraser:
                        var eraser = layer
                        eraser.blendMode = .clear
                        eraser.stroke(path, with: .color(.black), style: StrokeStyle(lineWidth: width * 2, lineCap: .round, lineJoin: .round))
                    }
                }
            }
        }
    }

    /// Путь штриха в экранных точках (сглаживание как в экспорте).
    private func screenPath(_ points: [CGPoint]) -> Path {
        let screen = points.map { geometry.originalToScreen($0) }
        var path = Path()
        guard let first = screen.first else { return path }
        path.move(to: first)
        if screen.count == 2 {
            path.addLine(to: screen[1])
            return path
        }
        for index in 1..<screen.count {
            let previous = screen[index - 1]
            let current = screen[index]
            let mid = CGPoint(x: (previous.x + current.x) / 2, y: (previous.y + current.y) / 2)
            path.addQuadCurve(to: mid, control: previous)
        }
        if let last = screen.last { path.addLine(to: last) }
        return path
    }

    private func arrowHeadPath(_ points: [CGPoint], width: CGFloat) -> Path {
        let screen = points.map { geometry.originalToScreen($0) }
        var path = Path()
        guard screen.count >= 2 else { return path }
        let tip = screen[screen.count - 1]
        let back = screen[max(0, screen.count - 6)]
        let angle = atan2(tip.y - back.y, tip.x - back.x)
        let length = max(width * 4, 12)
        let spread: CGFloat = .pi / 7
        path.move(to: tip)
        path.addLine(to: CGPoint(x: tip.x - length * cos(angle - spread), y: tip.y - length * sin(angle - spread)))
        path.addLine(to: CGPoint(x: tip.x - length * cos(angle + spread), y: tip.y - length * sin(angle + spread)))
        path.closeSubpath()
        return path
    }

    /// Прямоугольник, в котором на экране лежит ВЕСЬ повёрнутый кадр.
    private func fullFrameRect() -> CGRect {
        let crop = geometry.visibleCrop
        let rect = geometry.displayRect
        let fullWidth = rect.width / max(crop.w, 0.001)
        let fullHeight = rect.height / max(crop.h, 0.001)
        return CGRect(x: rect.minX - crop.x * fullWidth, y: rect.minY - crop.y * fullHeight, width: fullWidth, height: fullHeight)
    }
}

extension PhotoEditItem {
    /// Маленький кадр для ленты миниатюр — считается один раз.
    var thumbnail: UIImage {
        if let cached = thumbnailCache { return cached }
        let small = image.downscaled(maxDimension: 160)
        thumbnailCache = small
        return small
    }
}

private var thumbnailStorage: [UUID: UIImage] = [:]
private extension PhotoEditItem {
    var thumbnailCache: UIImage? {
        get { thumbnailStorage[id] }
        set { thumbnailStorage[id] = newValue }
    }
}
