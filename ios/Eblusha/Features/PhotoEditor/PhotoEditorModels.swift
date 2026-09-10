import SwiftUI
import UIKit

// Редактор фото перед отправкой. Свой, на SwiftUI: библиотек под GPL мы не берём, а
// готовые MIT-редакторы навязывают чужой интерфейс. Здесь — модель документа и геометрия;
// сами инструменты и рендер живут в соседних файлах.
//
// ГЛАВНЫЙ ПРИНЦИП КООРДИНАТ: всё, что нарисовано поверх кадра (штрихи, размытие, текст,
// стикеры), хранится в НОРМАЛИЗОВАННЫХ координатах ИСХОДНОГО кадра (0…1 по ширине и
// высоте оригинала, до поворота и обрезки). Поэтому поворот, отражение и обрезка ничего
// не ломают: они лишь меняют то, какой кусок оригинала и как показан. Обрезка же хранится
// в координатах ПОКАЗАННОГО (повёрнутого/отражённого) кадра — так её проще тянуть за ручки,
// а при повороте она пересчитывается (как в эталонном PhotoEditor.kt на Android).

// MARK: - Инструменты

enum PhotoTool: String, CaseIterable, Identifiable {
    case crop, draw, text, sticker, blur, adjust

    var id: String { rawValue }

    var title: String {
        switch self {
        case .crop: return "Обрезка"
        case .draw: return "Кисть"
        case .text: return "Текст"
        case .sticker: return "Стикер"
        case .blur: return "Размытие"
        case .adjust: return "Цвет"
        }
    }

    var icon: String {
        switch self {
        case .crop: return "crop.rotate"
        case .draw: return "pencil.tip"
        case .text: return "textformat"
        case .sticker: return "face.smiling"
        case .blur: return "drop.halffull"
        case .adjust: return "slider.horizontal.3"
        }
    }
}

// MARK: - Обрезка и поворот

/// Обрезка в нормализованных координатах показанного кадра. FULL — без обрезки.
struct CropRect: Equatable {
    var x: CGFloat
    var y: CGFloat
    var w: CGFloat
    var h: CGFloat

    static let full = CropRect(x: 0, y: 0, w: 1, h: 1)

    var isFull: Bool {
        x < 0.001 && y < 0.001 && w > 0.999 && h > 0.999
    }

    var cgRect: CGRect { CGRect(x: x, y: y, width: w, height: h) }

    /// Поворот показанного кадра на 90° по часовой: рамка едет вместе с ним
    /// (порт формулы из PhotoEditor.kt).
    func rotatedClockwise() -> CropRect {
        CropRect(x: 1 - y - h, y: x, w: h, h: w)
    }

    func flippedHorizontally() -> CropRect {
        CropRect(x: 1 - x - w, y: y, w: w, h: h)
    }
}

/// Предустановки пропорций рамки. `nil` — свободная.
enum CropAspect: String, CaseIterable, Identifiable {
    case free, original, square, threeFour, fourThree, nineSixteen, sixteenNine

    var id: String { rawValue }

    var title: String {
        switch self {
        case .free: return "Свободно"
        case .original: return "Оригинал"
        case .square: return "1:1"
        case .threeFour: return "3:4"
        case .fourThree: return "4:3"
        case .nineSixteen: return "9:16"
        case .sixteenNine: return "16:9"
        }
    }

    /// Отношение ширина/высота; для original считает вызывающий по размеру кадра.
    func ratio(original: CGFloat) -> CGFloat? {
        switch self {
        case .free: return nil
        case .original: return original
        case .square: return 1
        case .threeFour: return 3.0 / 4.0
        case .fourThree: return 4.0 / 3.0
        case .nineSixteen: return 9.0 / 16.0
        case .sixteenNine: return 16.0 / 9.0
        }
    }
}

// MARK: - Слои поверх кадра (координаты — исходного кадра, 0…1)

enum BrushKind: String, CaseIterable, Identifiable {
    /// Обычная линия.
    case pen
    /// Широкая полупрозрачная — маркер.
    case marker
    /// Светящаяся: белое ядро с цветным ореолом.
    case neon
    /// Линия со стрелкой на конце.
    case arrow
    /// Стирает штрихи (не кадр).
    case eraser

    var id: String { rawValue }

    var title: String {
        switch self {
        case .pen: return "Ручка"
        case .marker: return "Маркер"
        case .neon: return "Неон"
        case .arrow: return "Стрелка"
        case .eraser: return "Ластик"
        }
    }

    var icon: String {
        switch self {
        case .pen: return "pencil"
        case .marker: return "highlighter"
        case .neon: return "sparkles"
        case .arrow: return "arrow.up.right"
        case .eraser: return "eraser"
        }
    }
}

/// Штрих кисти. `width` — доля ширины исходного кадра (0.005 ≈ тонкая линия).
struct DrawStroke: Identifiable, Equatable {
    let id: UUID
    var kind: BrushKind
    var color: Color
    var width: CGFloat
    var points: [CGPoint]

    init(id: UUID = UUID(), kind: BrushKind, color: Color, width: CGFloat, points: [CGPoint] = []) {
        self.id = id
        self.kind = kind
        self.color = color
        self.width = width
        self.points = points
    }
}

/// Штрих размытия: по его пути кадр пикселизуется (защита лиц и документов).
struct BlurStroke: Identifiable, Equatable {
    let id: UUID
    /// Доля ширины кадра.
    var width: CGFloat
    var points: [CGPoint]
    /// Размытие вместо мозаики.
    var soft: Bool

    init(id: UUID = UUID(), width: CGFloat, points: [CGPoint] = [], soft: Bool = false) {
        self.id = id
        self.width = width
        self.points = points
        self.soft = soft
    }
}

enum TextStyle: String, CaseIterable, Identifiable {
    /// Просто текст с тенью.
    case plain
    /// Цветная подложка, белый текст.
    case pill
    /// Белая подложка, цветной текст.
    case card
    /// Обводка.
    case outline

    var id: String { rawValue }

    var title: String {
        switch self {
        case .plain: return "Обычный"
        case .pill: return "Плашка"
        case .card: return "Карточка"
        case .outline: return "Обводка"
        }
    }
}

/// Текст поверх кадра. `center` — нормализованный центр, `scale` — размер шрифта как доля
/// ширины кадра (0.06 ≈ крупный заголовок), `rotation` — радианы.
struct TextOverlay: Identifiable, Equatable {
    let id: UUID
    var text: String
    var color: Color
    var style: TextStyle
    var center: CGPoint
    var scale: CGFloat
    var rotation: CGFloat

    init(
        id: UUID = UUID(), text: String, color: Color = .white, style: TextStyle = .pill,
        center: CGPoint = CGPoint(x: 0.5, y: 0.5), scale: CGFloat = 0.06, rotation: CGFloat = 0
    ) {
        self.id = id
        self.text = text
        self.color = color
        self.style = style
        self.center = center
        self.scale = scale
        self.rotation = rotation
    }
}

/// Стикер — эмодзи поверх кадра; параметры как у текста.
struct StickerOverlay: Identifiable, Equatable {
    let id: UUID
    var emoji: String
    var center: CGPoint
    var scale: CGFloat
    var rotation: CGFloat

    init(
        id: UUID = UUID(), emoji: String, center: CGPoint = CGPoint(x: 0.5, y: 0.5),
        scale: CGFloat = 0.18, rotation: CGFloat = 0
    ) {
        self.id = id
        self.emoji = emoji
        self.center = center
        self.scale = scale
        self.rotation = rotation
    }
}

/// Что выделено на холсте (для удаления и правки).
enum OverlaySelection: Equatable {
    case text(UUID)
    case sticker(UUID)
}

// MARK: - Цветокоррекция

struct Adjustments: Equatable {
    /// −1…1, 0 — как есть.
    var brightness: CGFloat = 0
    var contrast: CGFloat = 0
    var saturation: CGFloat = 0
    /// Теплее/холоднее.
    var warmth: CGFloat = 0
    /// 0…1 — затемнение краёв.
    var vignette: CGFloat = 0
    /// 0…1 — резкость.
    var sharpness: CGFloat = 0

    static let none = Adjustments()

    var isIdentity: Bool { self == .none }
}

/// Готовые наборы коррекции — быстрые «фильтры».
enum AdjustPreset: String, CaseIterable, Identifiable {
    case original, vivid, warm, cool, mono, fade, dramatic

    var id: String { rawValue }

    var title: String {
        switch self {
        case .original: return "Оригинал"
        case .vivid: return "Ярко"
        case .warm: return "Тепло"
        case .cool: return "Холод"
        case .mono: return "Ч/Б"
        case .fade: return "Плёнка"
        case .dramatic: return "Драма"
        }
    }

    var adjustments: Adjustments {
        switch self {
        case .original: return .none
        case .vivid: return Adjustments(contrast: 0.15, saturation: 0.35, sharpness: 0.2)
        case .warm: return Adjustments(brightness: 0.05, saturation: 0.1, warmth: 0.45)
        case .cool: return Adjustments(saturation: 0.05, warmth: -0.45)
        case .mono: return Adjustments(contrast: 0.1, saturation: -1)
        case .fade: return Adjustments(brightness: 0.08, contrast: -0.2, saturation: -0.25)
        case .dramatic: return Adjustments(contrast: 0.35, saturation: -0.1, vignette: 0.5)
        }
    }
}

// MARK: - Документ

/// Всё состояние правок одного кадра. Значимый тип — снимки для отмены дешёвые.
struct PhotoEditDocument: Equatable {
    /// Повороты на 90° по часовой, 0…3.
    var quarterTurns: Int = 0
    var flippedHorizontally = false
    var crop: CropRect = .full
    var adjustments: Adjustments = .none
    var strokes: [DrawStroke] = []
    var blurs: [BlurStroke] = []
    var texts: [TextOverlay] = []
    var stickers: [StickerOverlay] = []

    /// Ничего не менялось — можно отправлять оригинал без перекодирования.
    var isPristine: Bool {
        quarterTurns == 0 && !flippedHorizontally && crop.isFull && adjustments.isIdentity
            && strokes.isEmpty && blurs.isEmpty && texts.isEmpty && stickers.isEmpty
    }

    /// Ширина и высота показанного (повёрнутого) кадра для оригинала `size`.
    func displaySize(for original: CGSize) -> CGSize {
        quarterTurns % 2 == 0 ? original : CGSize(width: original.height, height: original.width)
    }

    mutating func rotateClockwise() {
        quarterTurns = (quarterTurns + 1) % 4
        crop = crop.rotatedClockwise()
    }

    mutating func flipHorizontally() {
        flippedHorizontally.toggle()
        crop = crop.flippedHorizontally()
    }
}

/// Один редактируемый кадр: оригинал + документ + отмена/повтор.
@MainActor
final class PhotoEditItem: ObservableObject, Identifiable {
    let id = UUID()
    /// Исходный файл — имя и mime нужны при отправке нетронутого кадра как есть.
    let source: OutgoingFile
    /// Оригинал с нормализованной ориентацией (EXIF-повороты уже применены).
    let image: UIImage

    @Published var document = PhotoEditDocument()
    @Published private(set) var undoStack: [PhotoEditDocument] = []
    @Published private(set) var redoStack: [PhotoEditDocument] = []

    var canUndo: Bool { !undoStack.isEmpty }
    var canRedo: Bool { !redoStack.isEmpty }

    init?(source: OutgoingFile) {
        guard let raw = UIImage(data: source.bytes) else { return nil }
        self.source = source
        self.image = raw.normalizedOrientation()
    }

    /// Зафиксировать состояние ПЕРЕД изменением: каждый законченный жест — один шаг отмены.
    func pushUndo() {
        undoStack.append(document)
        if undoStack.count > 60 { undoStack.removeFirst() }
        redoStack.removeAll()
    }

    func undo() {
        guard let previous = undoStack.popLast() else { return }
        redoStack.append(document)
        document = previous
    }

    func redo() {
        guard let next = redoStack.popLast() else { return }
        undoStack.append(document)
        document = next
    }

    func reset() {
        guard !document.isPristine else { return }
        pushUndo()
        document = PhotoEditDocument()
    }
}

// MARK: - Геометрия координат

/// Переводы между координатами экрана, показанного кадра и исходного кадра.
///
/// `displayRect` — где на экране лежит показанный кусок (после обрезки; в режиме обрезки
/// вызывающий передаёт рамку ВСЕГО повёрнутого кадра и crop = .full).
struct EditGeometry {
    let document: PhotoEditDocument
    let originalSize: CGSize
    let displayRect: CGRect
    /// Какая часть показанного кадра видна в displayRect.
    let visibleCrop: CropRect

    init(document: PhotoEditDocument, originalSize: CGSize, displayRect: CGRect, showingFullFrame: Bool = false) {
        self.document = document
        self.originalSize = originalSize
        self.displayRect = displayRect
        self.visibleCrop = showingFullFrame ? .full : document.crop
    }

    /// Точка экрана → нормализованные координаты показанного (повёрнутого) кадра.
    func screenToRotated(_ point: CGPoint) -> CGPoint {
        guard displayRect.width > 0, displayRect.height > 0 else { return .zero }
        let u = (point.x - displayRect.minX) / displayRect.width
        let v = (point.y - displayRect.minY) / displayRect.height
        return CGPoint(x: visibleCrop.x + u * visibleCrop.w, y: visibleCrop.y + v * visibleCrop.h)
    }

    func rotatedToScreen(_ point: CGPoint) -> CGPoint {
        let u = visibleCrop.w > 0 ? (point.x - visibleCrop.x) / visibleCrop.w : 0
        let v = visibleCrop.h > 0 ? (point.y - visibleCrop.y) / visibleCrop.h : 0
        return CGPoint(x: displayRect.minX + u * displayRect.width, y: displayRect.minY + v * displayRect.height)
    }

    /// Показанный кадр → исходный: снимаем отражение, затем поворот.
    func rotatedToOriginal(_ point: CGPoint) -> CGPoint {
        var p = point
        if document.flippedHorizontally { p.x = 1 - p.x }
        switch document.quarterTurns % 4 {
        case 1: return CGPoint(x: p.y, y: 1 - p.x)
        case 2: return CGPoint(x: 1 - p.x, y: 1 - p.y)
        case 3: return CGPoint(x: 1 - p.y, y: p.x)
        default: return p
        }
    }

    /// Исходный кадр → показанный: поворот, затем отражение.
    func originalToRotated(_ point: CGPoint) -> CGPoint {
        var p: CGPoint
        switch document.quarterTurns % 4 {
        case 1: p = CGPoint(x: 1 - point.y, y: point.x)
        case 2: p = CGPoint(x: 1 - point.x, y: 1 - point.y)
        case 3: p = CGPoint(x: point.y, y: 1 - point.x)
        default: p = point
        }
        if document.flippedHorizontally { p.x = 1 - p.x }
        return p
    }

    func screenToOriginal(_ point: CGPoint) -> CGPoint {
        rotatedToOriginal(screenToRotated(point))
    }

    func originalToScreen(_ point: CGPoint) -> CGPoint {
        rotatedToScreen(originalToRotated(point))
    }

    /// Сколько экранных точек в одной единице ширины исходного кадра — для толщины линий
    /// и размера шрифта, которые хранятся как доля ширины оригинала.
    var pixelsPerOriginalWidth: CGFloat {
        let shown = document.displaySize(for: originalSize)
        let visibleWidthInRotated = shown.width * visibleCrop.w
        guard visibleWidthInRotated > 0 else { return 0 }
        let scale = displayRect.width / visibleWidthInRotated
        return originalSize.width * scale
    }

    /// Угол на экране для объекта, хранящего угол в исходном кадре.
    func screenRotation(forOriginalRotation angle: CGFloat) -> CGFloat {
        let turned = angle + CGFloat(document.quarterTurns % 4) * (.pi / 2)
        return document.flippedHorizontally ? -turned : turned
    }

    func originalRotation(forScreenRotation angle: CGFloat) -> CGFloat {
        let unflipped = document.flippedHorizontally ? -angle : angle
        return unflipped - CGFloat(document.quarterTurns % 4) * (.pi / 2)
    }
}

// MARK: - Вспомогательное

extension UIImage {
    /// Кадр с EXIF-поворотом, перерисованный в «up»: дальше все расчёты в пикселях без
    /// оглядки на ориентацию.
    func normalizedOrientation() -> UIImage {
        guard imageOrientation != .up else { return self }
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        return UIGraphicsImageRenderer(size: size, format: format).image { _ in
            draw(in: CGRect(origin: .zero, size: size))
        }
    }
}

/// Палитра кисти и текста — та же, что у меток и реакций в чате.
enum PhotoEditorPalette {
    static let colors: [Color] = [
        .white, Color(hex: 0xFF3B30), Color(hex: 0xFF9500), Color(hex: 0xFFCC00),
        Color(hex: 0x34C759), Color(hex: 0x00C7BE), Color(hex: 0x007AFF), Color(hex: 0xAF52DE),
        Color(hex: 0xFF2D55), Color(hex: 0x1C1C1E),
    ]
}
