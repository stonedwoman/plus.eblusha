import SwiftUI
import UIKit

/// Текст и стикеры поверх кадра: слой показа и жестов на холсте, лист правки текста и
/// панели обоих инструментов.
///
/// Слой рисует объекты ВСЕГДА (и когда активна кисть или обрезка), а жесты включает только
/// при `interactive`. Текст рисуется не SwiftUI-`Text`, а тем же `NSAttributedString` с
/// атрибутами из `PhotoEditorRenderer.textAttributes` через UIKit: обводку и тень
/// SwiftUI-текст не умеет, а экран обязан показывать ровно то, что уйдёт в файл.
struct OverlayInteractionView: View {

    @ObservedObject var item: PhotoEditItem
    @ObservedObject var tools: PhotoEditorToolState
    let geometry: EditGeometry
    /// false — только показать объекты, жесты выключены (другие инструменты активны).
    let interactive: Bool

    /// Идущая «манипуляция» объектом: drag, pinch и поворот одновременно. nil — пальцев нет.
    @State private var session: OverlayGestureSession?

    /// Пределы размера — доля ширины исходного кадра. Щипком можно уйти дальше слайдера
    /// панели, но не в ноль и не в «один символ на весь кадр».
    private static let textScaleRange: ClosedRange<CGFloat> = 0.02...0.3
    private static let stickerScaleRange: ClosedRange<CGFloat> = 0.05...0.6

    var body: some View {
        ZStack {
            objectsLayer
            if interactive {
                interactionLayer
            }
        }
        // Без жестов слой не должен перехватывать касания у кисти и обрезки, лежащих выше
        // в ZStack холста, и у тапа по холсту, снимающего фокус с подписи.
        .allowsHitTesting(interactive)
        .onChange(of: interactive) { _, on in
            if !on { session = nil }
        }
        .sheet(item: editingTarget, onDismiss: { pruneEmptyTexts() }) { target in
            let overlay = item.document.texts.first { $0.id == target.id }
            OverlayTextEditorSheet(
                draft: OverlayTextDraft(
                    text: overlay?.text ?? "",
                    color: overlay?.color ?? tools.textColor,
                    style: overlay?.style ?? tools.textStyle
                ),
                onDone: { draft in
                    commitTextEdit(id: target.id, draft: draft)
                    tools.editingText = nil
                },
                onCancel: { tools.editingText = nil }
            )
        }
    }

    // MARK: - Показ объектов

    /// Все тексты и стикеры документа, обрезанные по показанному кадру — как в экспорте.
    private var objectsLayer: some View {
        let ppw = geometry.pixelsPerOriginalWidth
        return ZStack {
            // Порядок как в рендере: стикеры под текстами.
            ForEach(item.document.stickers) { sticker in
                if let layout = stickerLayout(sticker, ppw: ppw) {
                    OverlayGlyphView(
                        string: layout.string, textSize: layout.size, padding: .zero,
                        background: nil, cornerRadius: 0
                    )
                    .frame(width: layout.size.width, height: layout.size.height)
                    .rotationEffect(Angle(radians: Double(geometry.screenRotation(forOriginalRotation: sticker.rotation))))
                    .position(geometry.originalToScreen(sticker.center))
                }
            }
            ForEach(item.document.texts) { text in
                if let layout = textLayout(text, ppw: ppw) {
                    OverlayGlyphView(
                        string: layout.string, textSize: layout.textSize, padding: layout.padding,
                        background: layout.background, cornerRadius: layout.cornerRadius
                    )
                    .frame(width: layout.viewSize.width, height: layout.viewSize.height)
                    .rotationEffect(Angle(radians: Double(geometry.screenRotation(forOriginalRotation: text.rotation))))
                    .position(geometry.originalToScreen(text.center))
                }
            }
        }
        .clipShape(Rectangle().path(in: geometry.displayRect))
        .allowsHitTesting(false)
    }

    private func textLayout(_ overlay: TextOverlay, ppw: CGFloat) -> OverlayTextLayout? {
        let fontSize = overlay.scale * ppw
        // Пустой текст (только что добавлен, лист ещё открыт) не рисуем: у плашки без
        // букв осталась бы одна крошечная подложка.
        guard fontSize >= 1, !overlay.text.isEmpty else { return nil }
        // Рендер ограничивает строку 90% ширины оригинала — на экране это 0.9 · ppw.
        return OverlayTextLayout(overlay: overlay, fontSize: fontSize, maxWidth: ppw * 0.9)
    }

    private func stickerLayout(_ sticker: StickerOverlay, ppw: CGFloat) -> OverlayStickerLayout? {
        let fontSize = sticker.scale * ppw
        guard fontSize >= 1 else { return nil }
        return OverlayStickerLayout(emoji: sticker.emoji, fontSize: fontSize)
    }

    // MARK: - Жесты

    /// Невидимые «ловушки» жестов поверх каждого объекта плюс рамка выделения. Жесты и
    /// картинка разведены по разным слоям нарочно: картинка обрезана по кадру, а ловить
    /// палец нужно и на выступающей за край части объекта.
    private var interactionLayer: some View {
        let ppw = geometry.pixelsPerOriginalWidth
        return ZStack {
            // Тап по пустому месту кадра снимает выделение; за краем кадра касание идёт ниже.
            Color.clear
                .contentShape(Rectangle().path(in: geometry.displayRect))
                .onTapGesture { tools.selection = nil }
            ForEach(item.document.stickers) { sticker in
                if let layout = stickerLayout(sticker, ppw: ppw) {
                    hitView(
                        target: .sticker(sticker.id),
                        center: geometry.originalToScreen(sticker.center),
                        angle: geometry.screenRotation(forOriginalRotation: sticker.rotation),
                        box: layout.size
                    )
                }
            }
            ForEach(item.document.texts) { text in
                if let layout = textLayout(text, ppw: ppw) {
                    hitView(
                        target: .text(text.id),
                        center: geometry.originalToScreen(text.center),
                        angle: geometry.screenRotation(forOriginalRotation: text.rotation),
                        box: layout.boxSize
                    )
                }
            }
            selectionChrome(ppw: ppw)
        }
    }

    /// Прозрачная область объекта с жестами. Жесты навешаны ДО поворота и позиции: так
    /// область попадания едет и вращается вместе с объектом, а сами жесты — в его системе.
    @ViewBuilder
    private func hitView(target: OverlaySelection, center: CGPoint, angle: CGFloat, box: CGSize) -> some View {
        let editableId: UUID? = {
            if case .text(let id) = target { return id }
            return nil
        }()
        let shape = Color.clear
            // Мелкий объект всё равно должен ловиться пальцем.
            .frame(width: max(box.width, 44), height: max(box.height, 44))
            .contentShape(Rectangle())
        if let id = editableId {
            shape
                // Двойной тап — ДО одиночного, иначе одиночный не даст ему сработать.
                .onTapGesture(count: 2) {
                    tools.selection = target
                    tools.editingText = id
                }
                .onTapGesture { tools.selection = target }
                .gesture(dragGesture(for: target))
                .simultaneousGesture(magnifyGesture(for: target))
                .simultaneousGesture(rotateGesture(for: target))
                .rotationEffect(Angle(radians: Double(angle)))
                .position(center)
        } else {
            shape
                .onTapGesture { tools.selection = target }
                .gesture(dragGesture(for: target))
                .simultaneousGesture(magnifyGesture(for: target))
                .simultaneousGesture(rotateGesture(for: target))
                .rotationEffect(Angle(radians: Double(angle)))
                .position(center)
        }
    }

    /// Перетаскивание. Координаты — глобальные: локальная система ловушки движется вместе с
    /// объектом, и относительно неё палец «стоит на месте» — translation был бы нулевой.
    private func dragGesture(for target: OverlaySelection) -> some Gesture {
        DragGesture(minimumDistance: 10, coordinateSpace: .global)
            .onChanged { value in dragChanged(value, target: target) }
            .onEnded { value in
                dragChanged(value, target: target)
                session?.dragStart = nil
                session?.dragBaseCenter = nil
                endSessionIfIdle()
            }
    }

    private func magnifyGesture(for target: OverlaySelection) -> some Gesture {
        MagnifyGesture()
            .onChanged { value in magnifyChanged(value, target: target) }
            .onEnded { value in
                magnifyChanged(value, target: target)
                session?.magnifyStart = nil
                session?.baseScale = nil
                endSessionIfIdle()
            }
    }

    private func rotateGesture(for target: OverlaySelection) -> some Gesture {
        RotateGesture()
            .onChanged { value in rotateChanged(value, target: target) }
            .onEnded { value in
                rotateChanged(value, target: target)
                session?.rotateStart = nil
                session?.baseScreenRotation = nil
                endSessionIfIdle()
            }
    }

    private func dragChanged(_ value: DragGesture.Value, target: OverlaySelection) {
        // startLocation у нового касания другая — так отличаем новый жест от продолжения,
        // даже если onEnded прошлого не пришёл (системная отмена).
        if session?.target != target || session?.dragStart != value.startLocation {
            guard let current = transform(of: target) else { return }
            session?.dragStart = nil
            beginPart(for: target)
            session?.dragStart = value.startLocation
            session?.dragBaseCenter = geometry.originalToScreen(current.center)
        }
        guard let base = session?.dragBaseCenter else { return }
        let moved = CGPoint(x: base.x + value.translation.width, y: base.y + value.translation.height)
        // Центр не выпускаем за показанный кадр: утащенный за край объект нечем вернуть.
        let clamped = clampToDisplay(moved)
        update(target) { $0.center = geometry.screenToOriginal(clamped) }
    }

    private func magnifyChanged(_ value: MagnifyGesture.Value, target: OverlaySelection) {
        if session?.target != target || session?.magnifyStart != value.startLocation {
            guard let current = transform(of: target) else { return }
            session?.magnifyStart = nil
            beginPart(for: target)
            session?.magnifyStart = value.startLocation
            session?.baseScale = current.scale
        }
        guard let base = session?.baseScale else { return }
        let range = scaleRange(for: target)
        let scale = min(max(base * value.magnification, range.lowerBound), range.upperBound)
        update(target) { $0.scale = scale }
    }

    private func rotateChanged(_ value: RotateGesture.Value, target: OverlaySelection) {
        if session?.target != target || session?.rotateStart != value.startLocation {
            guard let current = transform(of: target) else { return }
            session?.rotateStart = nil
            beginPart(for: target)
            session?.rotateStart = value.startLocation
            // База — угол НА ЭКРАНЕ: жест меряет поворот в экранной системе, а кадр может
            // быть повёрнут и отражён. В документ кладём уже переведённый угол.
            session?.baseScreenRotation = geometry.screenRotation(forOriginalRotation: current.rotation)
        }
        guard let base = session?.baseScreenRotation else { return }
        let screen = snappedToQuarter(base + CGFloat(value.rotation.radians))
        update(target) { $0.rotation = geometry.originalRotation(forScreenRotation: screen) }
    }

    /// Начало одной из частей манипуляции (drag / pinch / поворот). Снимок для отмены —
    /// только когда все остальные части ещё не начались: всё, что делают пальцы до полного
    /// отпускания, должно откатываться одним «Отменить».
    private func beginPart(for target: OverlaySelection) {
        if session?.target != target {
            session = OverlayGestureSession(target: target)
            tools.selection = target
        }
        if session?.isIdle == true {
            item.pushUndo()
        }
    }

    private func endSessionIfIdle() {
        if session?.isIdle == true { session = nil }
    }

    /// Лёгкий магнит к 0°/90°/180°/270° на экране: ровно поставить текст пальцами почти
    /// невозможно, а «чуть криво» заметно. Порог ~3°.
    private func snappedToQuarter(_ angle: CGFloat) -> CGFloat {
        let step = CGFloat.pi / 2
        let nearest = (angle / step).rounded() * step
        return abs(angle - nearest) < 0.05 ? nearest : angle
    }

    private func scaleRange(for target: OverlaySelection) -> ClosedRange<CGFloat> {
        switch target {
        case .text: return Self.textScaleRange
        case .sticker: return Self.stickerScaleRange
        }
    }

    private func clampToDisplay(_ point: CGPoint) -> CGPoint {
        let rect = geometry.displayRect
        return CGPoint(x: min(max(point.x, rect.minX), rect.maxX), y: min(max(point.y, rect.minY), rect.maxY))
    }

    // MARK: - Доступ к объекту по выделению

    private func transform(of target: OverlaySelection) -> OverlayTransform? {
        switch target {
        case .text(let id):
            guard let overlay = item.document.texts.first(where: { $0.id == id }) else { return nil }
            return OverlayTransform(center: overlay.center, scale: overlay.scale, rotation: overlay.rotation)
        case .sticker(let id):
            guard let overlay = item.document.stickers.first(where: { $0.id == id }) else { return nil }
            return OverlayTransform(center: overlay.center, scale: overlay.scale, rotation: overlay.rotation)
        }
    }

    /// Правка объекта одним присваиванием в документ (одно уведомление, а не три). Объект
    /// ищем по id, а не по индексу: посреди жеста второй рукой могли нажать «Отменить» —
    /// тогда молча заканчиваем.
    private func update(_ target: OverlaySelection, _ change: (inout OverlayTransform) -> Void) {
        switch target {
        case .text(let id):
            guard let index = item.document.texts.firstIndex(where: { $0.id == id }) else {
                session = nil
                return
            }
            var overlay = item.document.texts[index]
            var transform = OverlayTransform(center: overlay.center, scale: overlay.scale, rotation: overlay.rotation)
            change(&transform)
            overlay.center = transform.center
            overlay.scale = transform.scale
            overlay.rotation = transform.rotation
            item.document.texts[index] = overlay
        case .sticker(let id):
            guard let index = item.document.stickers.firstIndex(where: { $0.id == id }) else {
                session = nil
                return
            }
            var overlay = item.document.stickers[index]
            var transform = OverlayTransform(center: overlay.center, scale: overlay.scale, rotation: overlay.rotation)
            change(&transform)
            overlay.center = transform.center
            overlay.scale = transform.scale
            overlay.rotation = transform.rotation
            item.document.stickers[index] = overlay
        }
    }

    // MARK: - Выделение

    /// Пунктирная рамка вокруг выделенного, крестик удаления в правом верхнем углу и
    /// карандаш правки (у текста) в правом нижнем. Кнопки стоят в углах ПОВЁРНУТОЙ рамки,
    /// но сами не поворачиваются — считаем их экранные позиции вручную.
    @ViewBuilder
    private func selectionChrome(ppw: CGFloat) -> some View {
        if let frame = selectedFrame(ppw: ppw) {
            let inset: CGFloat = 8
            let width = frame.size.width + inset * 2
            let height = frame.size.height + inset * 2
            let deleteAt = rotatedPoint(CGPoint(x: width / 2, y: -height / 2), by: frame.angle, around: frame.center)
            let editAt = rotatedPoint(CGPoint(x: width / 2, y: height / 2), by: frame.angle, around: frame.center)
            RoundedRectangle(cornerRadius: 6)
                .strokeBorder(Color.white, style: StrokeStyle(lineWidth: 1.5, dash: [6, 4]))
                .frame(width: width, height: height)
                .rotationEffect(Angle(radians: Double(frame.angle)))
                .position(frame.center)
                // Рамка не должна перехватывать жесты у объекта под ней.
                .allowsHitTesting(false)
            chromeButton(icon: "xmark", tint: Eb.error) { deleteSelected() }
                .position(deleteAt)
            if let id = frame.textId {
                chromeButton(icon: "pencil", tint: Eb.brand) { tools.editingText = id }
                    .position(editAt)
            }
        }
    }

    private func selectedFrame(ppw: CGFloat) -> OverlayScreenFrame? {
        guard let selection = tools.selection else { return nil }
        switch selection {
        case .text(let id):
            guard let overlay = item.document.texts.first(where: { $0.id == id }),
                  let layout = textLayout(overlay, ppw: ppw)
            else { return nil }
            return OverlayScreenFrame(
                center: geometry.originalToScreen(overlay.center),
                angle: geometry.screenRotation(forOriginalRotation: overlay.rotation),
                size: layout.boxSize, textId: id
            )
        case .sticker(let id):
            guard let overlay = item.document.stickers.first(where: { $0.id == id }),
                  let layout = stickerLayout(overlay, ppw: ppw)
            else { return nil }
            return OverlayScreenFrame(
                center: geometry.originalToScreen(overlay.center),
                angle: geometry.screenRotation(forOriginalRotation: overlay.rotation),
                size: layout.size, textId: nil
            )
        }
    }

    private func chromeButton(icon: String, tint: Color, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: icon)
                .font(.system(size: 12, weight: .bold))
                .foregroundStyle(.white)
                .frame(width: 26, height: 26)
                .background(tint, in: Circle())
                .overlay(Circle().strokeBorder(Color.white, lineWidth: 1.5))
                // Кнопка мелкая, но зона нажатия 44×44 — иначе пальцем не попасть.
                .frame(width: 44, height: 44)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
    }

    private func rotatedPoint(_ local: CGPoint, by angle: CGFloat, around center: CGPoint) -> CGPoint {
        let c = cos(angle)
        let s = sin(angle)
        return CGPoint(x: center.x + local.x * c - local.y * s, y: center.y + local.x * s + local.y * c)
    }

    private func deleteSelected() {
        guard let selection = tools.selection else { return }
        switch selection {
        case .text(let id):
            guard item.document.texts.contains(where: { $0.id == id }) else { return }
            item.pushUndo()
            item.document.texts.removeAll { $0.id == id }
        case .sticker(let id):
            guard item.document.stickers.contains(where: { $0.id == id }) else { return }
            item.pushUndo()
            item.document.stickers.removeAll { $0.id == id }
        }
        tools.selection = nil
        session = nil
    }

    // MARK: - Правка текста

    /// Лист открыт, только если редактируемый текст лежит в ЭТОМ кадре: у пейджера живут
    /// соседние холсты с тем же `tools`, и без проверки лист пытались бы показать все разом.
    private var editingTarget: Binding<OverlayEditTarget?> {
        Binding(
            get: {
                guard let id = tools.editingText, item.document.texts.contains(where: { $0.id == id }) else { return nil }
                return OverlayEditTarget(id: id)
            },
            set: { if $0 == nil { tools.editingText = nil } }
        )
    }

    private func commitTextEdit(id: UUID, draft: OverlayTextDraft) {
        guard let index = item.document.texts.firstIndex(where: { $0.id == id }) else { return }
        // Цвет и стиль запоминаем для следующих текстов, даже если этот в итоге пустой.
        tools.textColor = draft.color
        tools.textStyle = draft.style
        let text = draft.text.trimmingCharacters(in: .whitespacesAndNewlines)
        // Пустой текст невидим и недостижим — в документе его быть не должно.
        guard !text.isEmpty else {
            pruneEmptyTexts()
            return
        }
        let current = item.document.texts[index]
        guard current.text != text || current.color != draft.color || current.style != draft.style else { return }
        item.pushUndo()
        var overlay = current
        overlay.text = text
        overlay.color = draft.color
        overlay.style = draft.style
        item.document.texts[index] = overlay
        tools.selection = .text(id)
    }

    /// Убирает тексты без букв: «Добавить текст» кладёт пустой объект и открывает лист, а
    /// если лист закрыли, ничего не написав, объект остаётся мусором. Без pushUndo: снимок
    /// для отмены уже сделан при добавлении, и после чистки документ ему равен.
    private func pruneEmptyTexts() {
        let empty = item.document.texts.filter {
            $0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
        guard !empty.isEmpty else { return }
        let ids = Set(empty.map(\.id))
        item.document.texts.removeAll { ids.contains($0.id) }
        if let selection = tools.selection, case .text(let id) = selection, ids.contains(id) {
            tools.selection = nil
        }
    }
}

// MARK: - Служебные типы слоя

/// Что палец делает сейчас. У каждой из трёх частей — своя база и свой признак «тот же
/// жест»: части начинаются и заканчиваются независимо (второй палец опустили посреди drag).
private struct OverlayGestureSession {
    let target: OverlaySelection
    /// startLocation текущего drag-жеста; nil — палец не тянет.
    var dragStart: CGPoint? = nil
    /// Центр объекта на экране в момент начала drag.
    var dragBaseCenter: CGPoint? = nil
    var magnifyStart: CGPoint? = nil
    var baseScale: CGFloat? = nil
    var rotateStart: CGPoint? = nil
    /// Угол на экране в момент начала поворота.
    var baseScreenRotation: CGFloat? = nil

    var isIdle: Bool { dragStart == nil && magnifyStart == nil && rotateStart == nil }
}

private struct OverlayTransform {
    var center: CGPoint
    var scale: CGFloat
    var rotation: CGFloat
}

/// Экранная рамка выделенного объекта.
private struct OverlayScreenFrame {
    let center: CGPoint
    let angle: CGFloat
    let size: CGSize
    /// id текста — для кнопки правки; у стикера nil.
    let textId: UUID?
}

/// Обёртка для `.sheet(item:)`: UUID сам по себе не Identifiable.
private struct OverlayEditTarget: Identifiable, Equatable {
    let id: UUID
}

private struct OverlayTextDraft: Equatable {
    var text: String
    var color: Color
    var style: TextStyle
}

// MARK: - Разметка текста и стикера (повторяет PhotoEditorRenderer.drawText/drawSticker)

/// Размеры текста на экране, посчитанные тем же способом, что в рендере: атрибуты —
/// `textAttributes`, ширина — 90% кадра, отступы плашки — 0.5/0.25 кегля, скругление 0.3.
private struct OverlayTextLayout {
    let string: NSAttributedString
    let fontSize: CGFloat
    let textSize: CGSize
    let padding: CGSize
    let background: UIColor?
    let cornerRadius: CGFloat
    /// Запас вокруг плашки под тень и обводку: они выходят за границы букв, а UIView
    /// рисует только внутри своих bounds.
    let margin: CGFloat

    init(overlay: TextOverlay, fontSize: CGFloat, maxWidth: CGFloat) {
        let attributes = PhotoEditorRenderer.textAttributes(overlay, fontSize: fontSize)
        let string = NSAttributedString(string: overlay.text, attributes: attributes)
        let bounds = string.boundingRect(
            with: CGSize(width: max(maxWidth, 1), height: CGFloat.greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin], context: nil
        )
        self.string = string
        self.fontSize = fontSize
        self.textSize = CGSize(width: ceil(bounds.width), height: ceil(bounds.height))
        self.padding = CGSize(width: fontSize * 0.5, height: fontSize * 0.25)
        self.background = PhotoEditorRenderer.textBackground(overlay)
        self.cornerRadius = fontSize * 0.3
        self.margin = fontSize * 0.4
    }

    /// Плашка (или её невидимый эквивалент у plain/outline) — рамка выделения и зона жестов.
    var boxSize: CGSize {
        CGSize(width: textSize.width + padding.width * 2, height: textSize.height + padding.height * 2)
    }

    var viewSize: CGSize {
        CGSize(width: boxSize.width + margin * 2, height: boxSize.height + margin * 2)
    }
}

private struct OverlayStickerLayout {
    let string: NSAttributedString
    let size: CGSize

    init(emoji: String, fontSize: CGFloat) {
        let string = NSAttributedString(string: emoji, attributes: [.font: UIFont.systemFont(ofSize: fontSize)])
        let measured = string.size()
        self.string = string
        self.size = CGSize(width: ceil(measured.width), height: ceil(measured.height))
    }
}

/// UIKit-рисование атрибутированной строки с подложкой — тем же кодом, что экспорт.
/// SwiftUI `Text` не умеет ни обводку, ни `NSShadow`, а показывать нужно ровно результат.
private struct OverlayGlyphView: UIViewRepresentable {
    let string: NSAttributedString
    let textSize: CGSize
    let padding: CGSize
    let background: UIColor?
    let cornerRadius: CGFloat

    func makeUIView(context: Context) -> OverlayGlyphUIView {
        let view = OverlayGlyphUIView()
        view.isOpaque = false
        view.backgroundColor = .clear
        view.isUserInteractionEnabled = false
        // Размер меняется щипком каждый кадр — без redraw слой бы растягивал старую картинку.
        view.contentMode = .redraw
        return view
    }

    func updateUIView(_ view: OverlayGlyphUIView, context: Context) {
        view.string = string
        view.textSize = textSize
        view.padding = padding
        view.background = background
        view.cornerRadius = cornerRadius
        view.setNeedsDisplay()
    }
}

private final class OverlayGlyphUIView: UIView {
    var string = NSAttributedString()
    var textSize: CGSize = .zero
    var padding: CGSize = .zero
    var background: UIColor?
    var cornerRadius: CGFloat = 0

    override func draw(_ rect: CGRect) {
        guard let cg = UIGraphicsGetCurrentContext() else { return }
        let textRect = CGRect(
            x: bounds.midX - textSize.width / 2, y: bounds.midY - textSize.height / 2,
            width: textSize.width, height: textSize.height
        )
        if let background {
            let box = textRect.insetBy(dx: -padding.width, dy: -padding.height)
            // CGPath(roundedRect:) падает, если радиус больше половины стороны.
            let radius = min(cornerRadius, box.width / 2, box.height / 2)
            cg.setFillColor(background.cgColor)
            cg.addPath(CGPath(roundedRect: box, cornerWidth: radius, cornerHeight: radius, transform: nil))
            cg.fillPath()
        }
        string.draw(with: textRect, options: [.usesLineFragmentOrigin], context: nil)
    }
}

// MARK: - Лист правки текста

/// Поле ввода, стиль и цвет. Работает с черновиком и отдаёт его наружу по «Готово»:
/// в документ пишет холст (один шаг отмены на всю правку, а не на каждую букву).
private struct OverlayTextEditorSheet: View {

    let onDone: (OverlayTextDraft) -> Void
    let onCancel: () -> Void

    @State private var draft: OverlayTextDraft
    @FocusState private var focused: Bool

    init(draft: OverlayTextDraft, onDone: @escaping (OverlayTextDraft) -> Void, onCancel: @escaping () -> Void) {
        _draft = State(initialValue: draft)
        self.onDone = onDone
        self.onCancel = onCancel
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 12) {
                preview
                TextField("Введите текст", text: $draft.text, axis: .vertical)
                    .lineLimit(1...5)
                    .focused($focused)
                    .foregroundStyle(.white)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(Color.white.opacity(0.12), in: RoundedRectangle(cornerRadius: 12))
                    .padding(.horizontal, 12)
                ScrollView(.horizontal, showsIndicators: false) {
                    OverlayStyleRow(selected: draft.style) { draft.style = $0 }
                        .padding(.horizontal, 12)
                }
                .frame(height: 44)
                OverlayColorRow(selected: draft.color) { draft.color = $0 }
                    .frame(height: 40)
                    .padding(.horizontal, 12)
                Spacer(minLength: 0)
            }
            .padding(.top, 12)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color.black)
            .navigationTitle("Текст")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Отмена", action: onCancel)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Готово") { onDone(draft) }
                        .fontWeight(.semibold)
                }
            }
        }
        .presentationDetents([.medium, .large])
        .task {
            // Лист открыли ради ввода — сразу поднимаем клавиатуру. Задержка нужна: фокус,
            // выставленный до конца анимации показа листа, система теряет.
            try? await Task.sleep(nanoseconds: 350_000_000)
            focused = true
        }
    }

    /// Живой образец в выбранном стиле — тем же UIKit-рисованием, что и на холсте.
    private var preview: some View {
        let empty = draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        let sample = TextOverlay(text: empty ? "Текст" : draft.text, color: draft.color, style: draft.style)
        let layout = OverlayTextLayout(overlay: sample, fontSize: 24, maxWidth: 300)
        return OverlayGlyphView(
            string: layout.string, textSize: layout.textSize, padding: layout.padding,
            background: layout.background, cornerRadius: layout.cornerRadius
        )
        .frame(width: layout.viewSize.width, height: layout.viewSize.height)
        .opacity(empty ? 0.5 : 1)
        .frame(maxWidth: .infinity)
        .frame(height: 96)
        .clipped()
        // Серая подложка: чёрный и тёмные цвета палитры на чёрном фоне иначе не видны.
        .background(Color.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
        .padding(.horizontal, 12)
    }
}

// MARK: - Панель текста

/// «Добавить текст», стили, палитра и размер. Стиль и цвет применяются к выделенному тексту
/// и запоминаются в `tools` для следующих. Две строки — не выше ~100 pt.
struct TextToolbar: View {

    @ObservedObject var item: PhotoEditItem
    @ObservedObject var tools: PhotoEditorToolState

    /// Кегль как доля ширины кадра: 0.03 — подпись, 0.15 — заголовок на полкадра.
    private static let sizeRange: ClosedRange<CGFloat> = 0.03...0.15

    /// Снимок для отмены делаем один раз за движение слайдера, а не на каждое значение.
    @State private var sizeUndoPushed = false

    var body: some View {
        VStack(spacing: 6) {
            HStack(spacing: 8) {
                Button(action: addText) {
                    HStack(spacing: 6) {
                        Image(systemName: "plus")
                            .font(.system(size: 14, weight: .bold))
                        Text("Добавить текст")
                            .font(.subheadline.weight(.medium))
                    }
                    .foregroundStyle(.white)
                    .padding(.horizontal, 14)
                    .frame(height: 40)
                    .background(Eb.brand, in: Capsule())
                }
                .buttonStyle(.plain)
                ScrollView(.horizontal, showsIndicators: false) {
                    OverlayStyleRow(selected: currentStyle, onPick: applyStyle)
                }
            }
            .frame(height: 44)
            HStack(spacing: 10) {
                OverlayColorRow(selected: currentColor, onPick: applyColor)
                sizeControl
                    .frame(width: 150)
            }
            .frame(height: 40)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 4)
        .frame(maxWidth: .infinity)
        .background(Color.black)
    }

    private var selectedTextIndex: Int? {
        guard let selection = tools.selection, case .text(let id) = selection else { return nil }
        return item.document.texts.firstIndex { $0.id == id }
    }

    private var currentStyle: TextStyle {
        guard let index = selectedTextIndex else { return tools.textStyle }
        return item.document.texts[index].style
    }

    private var currentColor: Color {
        guard let index = selectedTextIndex else { return tools.textColor }
        return item.document.texts[index].color
    }

    /// Слайдер размера живёт только для выделенного текста: без него менять нечего, а
    /// «размер по умолчанию» никто не ищет в панели.
    private var sizeControl: some View {
        let enabled = selectedTextIndex != nil
        return HStack(spacing: 8) {
            Image(systemName: "textformat.size")
                .font(.system(size: 16, weight: .medium))
                .foregroundStyle(.white.opacity(0.85))
            Slider(value: sizeBinding, in: Self.sizeRange, onEditingChanged: { editing in
                if !editing { sizeUndoPushed = false }
            })
            .tint(Eb.brand)
        }
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.4)
    }

    private var sizeBinding: Binding<CGFloat> {
        Binding(
            get: {
                guard let index = selectedTextIndex else { return 0.06 }
                let scale = item.document.texts[index].scale
                return min(max(scale, Self.sizeRange.lowerBound), Self.sizeRange.upperBound)
            },
            set: { value in
                guard let index = selectedTextIndex else { return }
                if !sizeUndoPushed {
                    item.pushUndo()
                    sizeUndoPushed = true
                }
                item.document.texts[index].scale = value
            }
        )
    }

    /// Новый пустой текст в центре видимой области и сразу лист ввода. Пустым он не
    /// останется: холст удалит его, если лист закрыли без букв.
    private func addText() {
        item.pushUndo()
        let overlay = TextOverlay(
            text: "", color: tools.textColor, style: tools.textStyle, center: overlayVisibleCenter(of: item)
        )
        item.document.texts.append(overlay)
        tools.selection = .text(overlay.id)
        tools.editingText = overlay.id
    }

    private func applyStyle(_ style: TextStyle) {
        tools.textStyle = style
        guard let index = selectedTextIndex, item.document.texts[index].style != style else { return }
        item.pushUndo()
        item.document.texts[index].style = style
    }

    private func applyColor(_ color: Color) {
        tools.textColor = color
        guard let index = selectedTextIndex, item.document.texts[index].color != color else { return }
        item.pushUndo()
        item.document.texts[index].color = color
    }
}

// MARK: - Панель стикеров

/// Лента популярных эмодзи и «Ещё» с полным пикером. Выбор кладёт стикер в центр видимой
/// области и выделяет его — дальше пальцами на холсте.
struct StickerToolbar: View {

    @ObservedObject var item: PhotoEditItem
    @ObservedObject var tools: PhotoEditorToolState

    @State private var showingPicker = false

    var body: some View {
        VStack(spacing: 2) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 0) {
                    Button {
                        showingPicker = true
                    } label: {
                        VStack(spacing: 2) {
                            Image(systemName: "plus.circle")
                                .font(.system(size: 22, weight: .medium))
                            Text("Ещё")
                                .font(.system(size: 10))
                        }
                        .foregroundStyle(Eb.brand)
                        .frame(width: 48, height: 48)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    ForEach(EmojiCatalog.emoji(in: .popular), id: \.self) { emoji in
                        Button {
                            add(emoji)
                        } label: {
                            Text(emoji)
                                .font(.system(size: 30))
                                .frame(width: 46, height: 48)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 8)
            }
            .frame(height: 52)
            Text("Тяните, щипком меняйте размер, двумя пальцами поворачивайте")
                .font(.caption)
                .foregroundStyle(.white.opacity(0.6))
                .lineLimit(1)
        }
        .padding(.vertical, 4)
        .frame(maxWidth: .infinity)
        .background(Color.black)
        .sheet(isPresented: $showingPicker) {
            ReactionPickerSheet(
                onPick: { emoji in
                    add(emoji)
                    showingPicker = false
                },
                onDismiss: { showingPicker = false }
            )
        }
    }

    private func add(_ emoji: String) {
        item.pushUndo()
        let sticker = StickerOverlay(emoji: emoji, center: overlayVisibleCenter(of: item))
        item.document.stickers.append(sticker)
        tools.selection = .sticker(sticker.id)
    }
}

// MARK: - Общие детали панелей (только этот файл — у других инструментов свои)

/// Центр ВИДИМОЙ области в координатах оригинала. «В центр» для пользователя — это центр
/// того, что он видит; центр исходного кадра после обрезки может быть вообще срезан.
/// displayRect здесь не участвует — переводу «показанный → исходный» он не нужен.
@MainActor
private func overlayVisibleCenter(of item: PhotoEditItem) -> CGPoint {
    let crop = item.document.crop
    let geometry = EditGeometry(
        document: item.document, originalSize: item.image.size, displayRect: CGRect(x: 0, y: 0, width: 1, height: 1)
    )
    return geometry.rotatedToOriginal(CGPoint(x: crop.x + crop.w / 2, y: crop.y + crop.h / 2))
}

/// Чипы стилей TextStyle; активный — заливка Eb.brand.
private struct OverlayStyleRow: View {

    let selected: TextStyle
    let onPick: (TextStyle) -> Void

    var body: some View {
        HStack(spacing: 6) {
            ForEach(TextStyle.allCases) { style in
                let active = style == selected
                Button {
                    onPick(style)
                } label: {
                    Text(style.title)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(active ? Color.white : Color.white.opacity(0.85))
                        .padding(.horizontal, 14)
                        .frame(height: 40)
                        .background(active ? Eb.brand : Color.white.opacity(0.12), in: Capsule())
                }
                .buttonStyle(.plain)
            }
        }
    }
}

/// Горизонтальная лента цветов PhotoEditorPalette; выбранный — кольцо Eb.brand.
private struct OverlayColorRow: View {

    let selected: Color?
    let onPick: (Color) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 0) {
                ForEach(Array(PhotoEditorPalette.colors.enumerated()), id: \.offset) { _, color in
                    let active = selected == color
                    Button {
                        onPick(color)
                    } label: {
                        Circle()
                            .fill(color)
                            .frame(width: 26, height: 26)
                            .overlay(
                                Circle().strokeBorder(
                                    active ? Eb.brand : Color.white.opacity(0.35),
                                    lineWidth: active ? 3 : 1
                                )
                            )
                            // Кружок мелкий, но зона нажатия — 40×40, чтобы попадать пальцем.
                            .frame(width: 40, height: 40)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }
}
