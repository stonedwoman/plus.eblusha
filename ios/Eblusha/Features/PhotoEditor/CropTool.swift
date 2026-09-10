import SwiftUI
import UIKit

// Инструмент обрезки: рамка поверх ВСЕГО повёрнутого кадра (порт PhotoEditor.kt с Android)
// и панель с пресетами пропорций, поворотом и отражением.
//
// Рамка хранится в `item.document.crop` — нормализованные координаты показанного
// (повёрнутого/отражённого) кадра. На экране этот кадр лежит в `frameRect`, поэтому
// перевод crop ↔ экран — простое масштабирование, без участия EditGeometry.
//
// Вся математика перетаскивания живёт в `CropMath` и работает в «честных» единицах
// (точки экрана или пиксели кадра), где отношение сторон w/h — настоящее. Нормализованные
// доли для этого не годятся: 0.5 × 0.5 у кадра 4:3 — это не квадрат.

// MARK: - Рамка на холсте

struct CropOverlayView: View {
    @ObservedObject var item: PhotoEditItem
    @ObservedObject var tools: PhotoEditorToolState
    /// Рамка ВСЕГО повёрнутого кадра на экране (crop рисуется внутри неё).
    let frameRect: CGRect

    /// Жест считается от рамки НА МОМЕНТ КАСАНИЯ и полного смещения пальца, а не по дельтам
    /// между событиями: накопление дельт с клампами за сотню событий уводит рамку от пальца,
    /// и при отпускании она «доезжает» рывком.
    @State private var session: DragSession?
    /// Палец лёг мимо рамки — этот жест игнорируем до конца, не пересчитывая попадание.
    @State private var touchOutside = false

    private struct DragSession {
        let handle: CropHandle
        let startBox: CGRect
        /// Шаг отмены кладём при ПЕРВОМ реальном изменении, а не на касании: тап по рамке без
        /// движения не должен тратить «Отменить» впустую.
        var undoPushed = false
    }

    /// Визуальный размер ручки ~20 pt, зона касания — 44 pt (радиус 22).
    private let handleTouchRadius: CGFloat = 22
    private let cornerArm: CGFloat = 20
    private let edgeBarLength: CGFloat = 22
    private let handleThickness: CGFloat = 4

    var body: some View {
        let box = CropMath.box(item.document.crop, in: frameRect)
        Canvas { context, _ in
            draw(in: &context, box: box)
        }
        .contentShape(Rectangle())
        .gesture(dragGesture)
        .onChange(of: item.document.crop) { _, crop in
            dropAspectIfBroken(by: crop)
        }
    }

    // MARK: Жест

    private var dragGesture: some Gesture {
        // minimumDistance: 0 — ручка должна «схватиться» сразу, без порога, иначе первые
        // точки движения теряются и рамка стартует с запозданием.
        DragGesture(minimumDistance: 0, coordinateSpace: .local)
            .onChanged { value in
                if touchOutside { return }
                if session == nil {
                    let box = CropMath.box(item.document.crop, in: frameRect)
                    guard let handle = CropMath.hitTest(value.startLocation, box: box, touchRadius: handleTouchRadius) else {
                        touchOutside = true
                        return
                    }
                    session = DragSession(handle: handle, startBox: box)
                }
                guard var current = session else { return }
                let next = CropMath.dragged(
                    start: current.startBox, handle: current.handle, translation: value.translation,
                    ratio: ratio, minSize: minSize, frame: frameRect
                )
                let crop = CropMath.crop(next, in: frameRect)
                guard crop != item.document.crop else { return }
                if !current.undoPushed {
                    item.pushUndo()
                    current.undoPushed = true
                    session = current
                }
                item.document.crop = crop
            }
            .onEnded { _ in
                // На отпускании рамку не трогаем: она уже там, куда её довели, — ничего не прыгает.
                session = nil
                touchOutside = false
            }
    }

    /// Удерживаемая пропорция (w/h) в экранных точках; nil — свободная.
    private var ratio: CGFloat? {
        let shown = item.document.displaySize(for: item.image.size)
        guard shown.width > 0, shown.height > 0 else { return nil }
        return tools.cropAspect.ratio(original: shown.width / shown.height)
    }

    /// Минимум рамки: 8% стороны, но не меньше 24 pt — иначе ручки налезают друг на друга и
    /// за нужную не ухватиться. Не больше самого кадра (панорамы бывают очень плоскими).
    private var minSize: CGSize {
        CGSize(
            width: min(frameRect.width, max(24, frameRect.width * CropMath.minFraction)),
            height: min(frameRect.height, max(24, frameRect.height * CropMath.minFraction))
        )
    }

    /// Отмена/повтор возвращают рамку, которая уже не обязана держать выбранную пропорцию.
    /// Если чип оставить, первое же касание ручки дёрнет рамку под пропорцию — поэтому чип
    /// честно сбрасываем в «Свободно». Во время своего жеста проверять нечего: рамка
    /// строится под пропорцию по построению.
    private func dropAspectIfBroken(by crop: CropRect) {
        guard session == nil, let ratio = ratio, crop.w > 0, crop.h > 0 else { return }
        let shown = item.document.displaySize(for: item.image.size)
        let actual = (crop.w * shown.width) / (crop.h * shown.height)
        if abs(actual - ratio) > ratio * 0.02 {
            tools.cropAspect = .free
        }
    }

    // MARK: Рисование

    private func draw(in context: inout GraphicsContext, box: CGRect) {
        // Затемнение вне рамки: внешний прямоугольник минус внутренний (even-odd).
        var scrim = Path(frameRect)
        scrim.addRect(box)
        context.fill(scrim, with: .color(.black.opacity(0.55)), style: FillStyle(eoFill: true))

        // Сетка третей — как в камере и остальных мессенджерах.
        var grid = Path()
        for step in 1...2 {
            let gx = box.minX + box.width * CGFloat(step) / 3
            let gy = box.minY + box.height * CGFloat(step) / 3
            grid.move(to: CGPoint(x: gx, y: box.minY))
            grid.addLine(to: CGPoint(x: gx, y: box.maxY))
            grid.move(to: CGPoint(x: box.minX, y: gy))
            grid.addLine(to: CGPoint(x: box.maxX, y: gy))
        }
        context.stroke(grid, with: .color(.white.opacity(0.35)), lineWidth: 1)

        context.stroke(Path(box), with: .color(.white.opacity(0.95)), lineWidth: 1.5)

        // Ручки: уголки-скобки и короткие планки на серединах сторон. Активная — цветом бренда,
        // чтобы было видно, за что именно держим.
        let active = session?.handle
        for handle in CropHandle.grips {
            let color: Color = handle == active ? Eb.brand : .white
            if handle.isCorner {
                context.stroke(
                    cornerPath(handle, box: box), with: .color(color),
                    style: StrokeStyle(lineWidth: handleThickness, lineCap: .round, lineJoin: .round)
                )
            } else {
                context.fill(edgePath(handle, box: box), with: .color(color))
            }
        }
    }

    /// Скобка в углу: две «ножки» вдоль сторон рамки.
    private func cornerPath(_ handle: CropHandle, box: CGRect) -> Path {
        let corner = handle.point(in: box)
        let dx: CGFloat = handle.west ? cornerArm : -cornerArm
        let dy: CGFloat = handle.north ? cornerArm : -cornerArm
        var path = Path()
        path.move(to: CGPoint(x: corner.x, y: corner.y + dy))
        path.addLine(to: corner)
        path.addLine(to: CGPoint(x: corner.x + dx, y: corner.y))
        return path
    }

    /// Планка на середине стороны: горизонтальная сверху/снизу, вертикальная слева/справа.
    private func edgePath(_ handle: CropHandle, box: CGRect) -> Path {
        let center = handle.point(in: box)
        let horizontal = handle == .top || handle == .bottom
        let width = horizontal ? edgeBarLength : handleThickness
        let height = horizontal ? handleThickness : edgeBarLength
        let rect = CGRect(x: center.x - width / 2, y: center.y - height / 2, width: width, height: height)
        return Path(roundedRect: rect, cornerRadius: handleThickness / 2)
    }
}

// MARK: - Панель обрезки

struct CropToolbar: View {
    @ObservedObject var item: PhotoEditItem
    @ObservedObject var tools: PhotoEditorToolState

    var body: some View {
        VStack(spacing: 6) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(CropAspect.allCases) { aspect in
                        aspectChip(aspect)
                    }
                }
                .padding(.horizontal, 12)
            }
            HStack(spacing: 0) {
                actionButton("Повернуть", icon: "rotate.right", action: rotate)
                actionButton("Отразить", icon: "flip.horizontal", action: flip)
                actionButton("Сбросить", icon: "arrow.counterclockwise", action: resetCrop)
                    .disabled(item.document.crop.isFull && tools.cropAspect == .free)
            }
            .padding(.horizontal, 4)
        }
    }

    private func aspectChip(_ aspect: CropAspect) -> some View {
        let active = tools.cropAspect == aspect
        return Button {
            select(aspect)
        } label: {
            Text(aspect.title)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(active ? Eb.brand : .white.opacity(0.85))
                .padding(.horizontal, 14)
                .frame(height: 34)
                .background(active ? Eb.brand.opacity(0.25) : Color.white.opacity(0.12), in: Capsule())
                // Визуально чип 34 pt, зона касания — 40.
                .frame(minWidth: 44, minHeight: 40)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func actionButton(_ title: String, icon: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 3) {
                Image(systemName: icon)
                    .font(.system(size: 18, weight: .medium))
                Text(title)
                    .font(.system(size: 10))
            }
            .foregroundStyle(.white.opacity(0.85))
            .frame(maxWidth: .infinity)
            .frame(height: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    // MARK: Действия

    /// Пресет: рамка перестраивается к максимальной вписанной с этой пропорцией. Центр
    /// берём от текущей рамки — пользователь уже показал, какая часть кадра ему нужна.
    private func select(_ aspect: CropAspect) {
        // Сначала чип, потом рамка: CropOverlayView сверяет рамку с чипом при её изменении.
        tools.cropAspect = aspect
        let shown = item.document.displaySize(for: item.image.size)
        guard shown.width > 0, shown.height > 0,
              let ratio = aspect.ratio(original: shown.width / shown.height)
        else { return }
        let frame = CGRect(origin: .zero, size: shown)
        let current = CropMath.box(item.document.crop, in: frame)
        let fitted = CropMath.fitted(ratio: ratio, center: CGPoint(x: current.midX, y: current.midY), in: frame)
        let crop = CropMath.crop(fitted, in: frame)
        guard crop != item.document.crop else { return }
        item.pushUndo()
        item.document.crop = crop
    }

    private func rotate() {
        item.pushUndo()
        item.document.rotateClockwise()
        // Рамка повернулась вместе с кадром — чип должен показывать её новую пропорцию.
        tools.cropAspect = tools.cropAspect.rotated
    }

    private func flip() {
        item.pushUndo()
        item.document.flipHorizontally()
    }

    private func resetCrop() {
        if !item.document.crop.isFull {
            item.pushUndo()
            item.document.crop = .full
        }
        // Полный кадр держит только «Оригинал» или «Свободно»; выбираем свободную, чтобы
        // следующее движение ручки не перестроило рамку под старый пресет.
        tools.cropAspect = .free
    }
}

private extension CropAspect {
    /// После поворота кадра на 90° рамка едет вместе с ним и её пропорция переворачивается:
    /// 3:4 становится 4:3. Квадрат, свободная и «Оригинал» (он считается от повёрнутого
    /// кадра) остаются собой.
    var rotated: CropAspect {
        switch self {
        case .threeFour: return .fourThree
        case .fourThree: return .threeFour
        case .nineSixteen: return .sixteenNine
        case .sixteenNine: return .nineSixteen
        case .free, .original, .square: return self
        }
    }
}

// MARK: - Ручки

private enum CropHandle: Equatable {
    case topLeft, top, topRight, right, bottomRight, bottom, bottomLeft, left
    /// Перетаскивание рамки целиком (палец внутри рамки, не на ручке).
    case move

    /// Восемь ручек в порядке рисования.
    static let grips: [CropHandle] = [.topLeft, .top, .topRight, .right, .bottomRight, .bottom, .bottomLeft, .left]

    var isCorner: Bool {
        switch self {
        case .topLeft, .topRight, .bottomLeft, .bottomRight: return true
        default: return false
        }
    }

    var west: Bool { self == .topLeft || self == .left || self == .bottomLeft }
    var east: Bool { self == .topRight || self == .right || self == .bottomRight }
    var north: Bool { self == .topLeft || self == .top || self == .topRight }
    var south: Bool { self == .bottomLeft || self == .bottom || self == .bottomRight }

    /// Где ручка сидит на рамке (для move — центр).
    func point(in box: CGRect) -> CGPoint {
        switch self {
        case .topLeft: return CGPoint(x: box.minX, y: box.minY)
        case .top: return CGPoint(x: box.midX, y: box.minY)
        case .topRight: return CGPoint(x: box.maxX, y: box.minY)
        case .right: return CGPoint(x: box.maxX, y: box.midY)
        case .bottomRight: return CGPoint(x: box.maxX, y: box.maxY)
        case .bottom: return CGPoint(x: box.midX, y: box.maxY)
        case .bottomLeft: return CGPoint(x: box.minX, y: box.maxY)
        case .left: return CGPoint(x: box.minX, y: box.midY)
        case .move: return CGPoint(x: box.midX, y: box.midY)
        }
    }
}

// MARK: - Математика рамки

/// Все функции работают в единицах, где пропорция честная (точки экрана или пиксели кадра);
/// `frame` — прямоугольник всего кадра в этих единицах, рамка обязана лежать внутри него.
private enum CropMath {

    /// Минимум стороны рамки — доля стороны кадра (как MIN_CROP на Android).
    static let minFraction: CGFloat = 0.08

    static func box(_ crop: CropRect, in frame: CGRect) -> CGRect {
        CGRect(
            x: frame.minX + crop.x * frame.width, y: frame.minY + crop.y * frame.height,
            width: crop.w * frame.width, height: crop.h * frame.height
        )
    }

    /// Обратно в нормализованные доли с страховкой: рамка не выходит за 0…1, иначе в файл
    /// попала бы чёрная полоса.
    static func crop(_ box: CGRect, in frame: CGRect) -> CropRect {
        guard frame.width > 0, frame.height > 0 else { return .full }
        let w = clamp(box.width / frame.width, 0.01, 1)
        let h = clamp(box.height / frame.height, 0.01, 1)
        let x = clamp((box.minX - frame.minX) / frame.width, 0, 1 - w)
        let y = clamp((box.minY - frame.minY) / frame.height, 0, 1 - h)
        return CropRect(x: x, y: y, w: w, h: h)
    }

    /// Ближайшая ручка в зоне касания; иначе move, если палец внутри рамки; иначе nil.
    /// Ручка важнее рамки: у маленькой рамки зоны касания ручек накрывают её целиком, и без
    /// приоритета рамку можно было бы только двигать. Зона ручки может выходить за кадр —
    /// иначе ручки на краю кадра были бы доступны только с половины.
    static func hitTest(_ point: CGPoint, box: CGRect, touchRadius: CGFloat) -> CropHandle? {
        var nearest: CropHandle?
        var nearestDistance = touchRadius
        for handle in CropHandle.grips {
            let at = handle.point(in: box)
            let dx = point.x - at.x
            let dy = point.y - at.y
            let distance = sqrt(dx * dx + dy * dy)
            if distance <= nearestDistance {
                nearest = handle
                nearestDistance = distance
            }
        }
        if let nearest { return nearest }
        return box.contains(point) ? .move : nil
    }

    /// Максимальная рамка с пропорцией `ratio` внутри кадра, по возможности с центром в `center`.
    static func fitted(ratio: CGFloat, center: CGPoint, in frame: CGRect) -> CGRect {
        guard ratio > 0 else { return frame }
        var width = frame.width
        var height = width / ratio
        if height > frame.height {
            height = frame.height
            width = height * ratio
        }
        let x = clamp(center.x - width / 2, frame.minX, frame.maxX - width)
        let y = clamp(center.y - height / 2, frame.minY, frame.maxY - height)
        return CGRect(x: x, y: y, width: width, height: height)
    }

    /// Рамка после смещения пальца на `translation` от начала жеста при рамке `start`.
    static func dragged(
        start: CGRect, handle: CropHandle, translation: CGSize, ratio: CGFloat?, minSize: CGSize, frame: CGRect
    ) -> CGRect {
        let dx = translation.width
        let dy = translation.height

        if handle == .move {
            return CGRect(
                x: clamp(start.minX + dx, frame.minX, frame.maxX - start.width),
                y: clamp(start.minY + dy, frame.minY, frame.maxY - start.height),
                width: start.width, height: start.height
            )
        }

        guard let ratio, ratio > 0 else {
            return resizedFree(start: start, handle: handle, dx: dx, dy: dy, minSize: minSize, frame: frame)
        }
        if handle.isCorner {
            return resizedCornerKeepingRatio(start: start, handle: handle, dx: dx, dy: dy, ratio: ratio, minSize: minSize, frame: frame)
        }
        return resizedEdgeKeepingRatio(start: start, handle: handle, dx: dx, dy: dy, ratio: ratio, minSize: minSize, frame: frame)
    }

    /// Свободная пропорция: каждая тянутая сторона идёт за пальцем, противоположная стоит.
    private static func resizedFree(
        start: CGRect, handle: CropHandle, dx: CGFloat, dy: CGFloat, minSize: CGSize, frame: CGRect
    ) -> CGRect {
        var left = start.minX
        var top = start.minY
        var right = start.maxX
        var bottom = start.maxY
        if handle.west { left = clamp(start.minX + dx, frame.minX, right - minSize.width) }
        if handle.east { right = clamp(start.maxX + dx, left + minSize.width, frame.maxX) }
        if handle.north { top = clamp(start.minY + dy, frame.minY, bottom - minSize.height) }
        if handle.south { bottom = clamp(start.maxY + dy, top + minSize.height, frame.maxY) }
        return CGRect(x: left, y: top, width: right - left, height: bottom - top)
    }

    /// Сторона при удержании пропорции: тянутая сторона идёт за пальцем, противоположная
    /// стоит, а перпендикулярный размер меняется СИММЕТРИЧНО вокруг центра — так рамка не
    /// уползает вбок, когда тянешь верх или низ.
    private static func resizedEdgeKeepingRatio(
        start: CGRect, handle: CropHandle, dx: CGFloat, dy: CGFloat, ratio: CGFloat, minSize: CGSize, frame: CGRect
    ) -> CGRect {
        let minHeight = max(minSize.height, minSize.width / ratio)
        let minWidth = minHeight * ratio

        switch handle {
        case .top, .bottom:
            let anchorY = handle == .top ? start.maxY : start.minY
            let wanted = handle == .top ? start.maxY - (start.minY + dy) : (start.maxY + dy) - start.minY
            let roomHeight = handle == .top ? anchorY - frame.minY : frame.maxY - anchorY
            // Ширина растёт в обе стороны от центра — упираемся в ближний край кадра.
            let roomWidth = 2 * min(start.midX - frame.minX, frame.maxX - start.midX)
            let height = clamp(wanted, minHeight, min(roomHeight, roomWidth / ratio))
            let width = height * ratio
            let y = handle == .top ? anchorY - height : anchorY
            return CGRect(x: start.midX - width / 2, y: y, width: width, height: height)

        default:
            let anchorX = handle == .left ? start.maxX : start.minX
            let wanted = handle == .left ? start.maxX - (start.minX + dx) : (start.maxX + dx) - start.minX
            let roomWidth = handle == .left ? anchorX - frame.minX : frame.maxX - anchorX
            let roomHeight = 2 * min(start.midY - frame.minY, frame.maxY - start.midY)
            let width = clamp(wanted, minWidth, min(roomWidth, roomHeight * ratio))
            let height = width / ratio
            let x = handle == .left ? anchorX - width : anchorX
            return CGRect(x: x, y: start.midY - height / 2, width: width, height: height)
        }
    }

    /// Угол при удержании пропорции: противоположный угол — якорь, а тянутый угол скользит по
    /// диагонали рамки. Берём проекцию вектора «якорь → палец» на диагональ: рамка плавно
    /// растёт и сжимается по любому направлению движения, без переключений между «ведёт
    /// ширина» и «ведёт высота», от которых бывают рывки.
    private static func resizedCornerKeepingRatio(
        start: CGRect, handle: CropHandle, dx: CGFloat, dy: CGFloat, ratio: CGFloat, minSize: CGSize, frame: CGRect
    ) -> CGRect {
        let sx: CGFloat = handle.east ? 1 : -1
        let sy: CGFloat = handle.south ? 1 : -1
        let anchor = CGPoint(x: handle.east ? start.minX : start.maxX, y: handle.south ? start.minY : start.maxY)
        let finger = CGPoint(
            x: (handle.east ? start.maxX : start.minX) + dx,
            y: (handle.south ? start.maxY : start.minY) + dy
        )
        // Единичный вектор диагонали (±ratio, ±1)/n; проекция на него даёт высоту t/n.
        let n = sqrt(ratio * ratio + 1)
        let t = ((finger.x - anchor.x) * sx * ratio + (finger.y - anchor.y) * sy) / n
        let wantedHeight = t / n

        let roomHeight = handle.south ? frame.maxY - anchor.y : anchor.y - frame.minY
        let roomWidth = handle.east ? frame.maxX - anchor.x : anchor.x - frame.minX
        let minHeight = max(minSize.height, minSize.width / ratio)
        let height = clamp(wantedHeight, minHeight, min(roomHeight, roomWidth / ratio))
        let width = height * ratio
        return CGRect(
            x: handle.east ? anchor.x : anchor.x - width,
            y: handle.south ? anchor.y : anchor.y - height,
            width: width, height: height
        )
    }

    /// При lo > hi (кадр меньше минимума) побеждает верхняя граница — рамка не вылезет за кадр.
    private static func clamp(_ value: CGFloat, _ lower: CGFloat, _ upper: CGFloat) -> CGFloat {
        min(max(value, lower), upper)
    }
}
