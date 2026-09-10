import SwiftUI

/// Кисть и размытие: прозрачный слой, ловящий жест рисования, и панели обоих инструментов.
///
/// Слой сам НИЧЕГО не рисует — штрихи и мозаику показывает `PhotoStrokesLayer` холста,
/// читая `item.document`. Здесь только перевод пальца в точки документа: тогда экран и
/// экспорт рисуют один и тот же путь одним и тем же кодом, без второго рендера.
struct DrawInteractionView: View {

    @ObservedObject var item: PhotoEditItem
    @ObservedObject var tools: PhotoEditorToolState
    let geometry: EditGeometry

    /// Текущий жест; nil — палец не на холсте.
    @State private var active: DrawActiveStroke?

    /// Ближе этого (в экранных точках) новые точки не добавляем: путь и так сглаживается
    /// сплайнами, а лишние точки лишь раздувают документ и замедляют Canvas.
    private static let minPointDistance: CGFloat = 2

    var body: some View {
        Color.clear
            // Область попадания — ровно показанный кадр: за его краями касание уходит
            // ниже (снимает фокус с подписи), а не заводит пустой штрих.
            .contentShape(Rectangle().path(in: geometry.displayRect))
            .gesture(
                // minimumDistance 0 — штрих начинается с самого касания: иначе первые
                // миллиметры терялись бы, а тап без движения (точка) не срабатывал бы вовсе.
                DragGesture(minimumDistance: 0, coordinateSpace: .local)
                    .onChanged { value in
                        // startLocation у нового касания другая — так отличаем новый жест
                        // от продолжения, даже если onEnded прошлого не пришёл (системная
                        // отмена). pushUndo при этом делается ровно один раз — в begin.
                        if active?.gestureStart != value.startLocation {
                            begin(at: value.startLocation)
                        }
                        extend(to: value.location)
                    }
                    .onEnded { value in
                        extend(to: value.location)
                        finish()
                    }
            )
    }

    // MARK: - Жест

    /// Начало жеста: один шаг отмены и новый пустой штрих в документе.
    private func begin(at screenPoint: CGPoint) {
        guard geometry.displayRect.contains(screenPoint) else {
            active = nil
            return
        }
        // Снимок ДО первой правки: весь жест целиком — один шаг «Отменить».
        item.pushUndo()
        let start = clampedOriginal(screenPoint)
        let isBlur = tools.activeTool == .blur
        let id: UUID
        if isBlur {
            let stroke = BlurStroke(width: tools.blurWidth, points: [start], soft: tools.blurSoft)
            item.document.blurs.append(stroke)
            id = stroke.id
        } else {
            let stroke = DrawStroke(kind: tools.brushKind, color: tools.brushColor, width: tools.brushWidth, points: [start])
            item.document.strokes.append(stroke)
            id = stroke.id
        }
        active = DrawActiveStroke(id: id, isBlur: isBlur, gestureStart: screenPoint, lastScreen: screenPoint)
    }

    /// Очередная точка пальца — в хвост текущего штриха (с прореживанием).
    private func extend(to screenPoint: CGPoint) {
        guard let current = active else { return }
        let dx = screenPoint.x - current.lastScreen.x
        let dy = screenPoint.y - current.lastScreen.y
        guard dx * dx + dy * dy >= Self.minPointDistance * Self.minPointDistance else { return }
        let point = clampedOriginal(screenPoint)
        // Штрих ищем по id, а не берём слепо последний: если посреди жеста второй рукой
        // нажали «Отменить», штриха уже нет — тогда молча заканчиваем жест.
        if current.isBlur {
            guard let index = item.document.blurs.lastIndex(where: { $0.id == current.id }) else {
                active = nil
                return
            }
            item.document.blurs[index].points.append(point)
        } else {
            guard let index = item.document.strokes.lastIndex(where: { $0.id == current.id }) else {
                active = nil
                return
            }
            item.document.strokes[index].points.append(point)
        }
        active?.lastScreen = screenPoint
    }

    /// Конец жеста. Тап без движения оставил одну точку, а холст и экспорт рисуют пути
    /// только из двух и более — дублируем координату: отрезок нулевой длины с круглым
    /// концом и есть точка нужной толщины.
    private func finish() {
        guard let current = active else { return }
        active = nil
        if current.isBlur {
            guard let index = item.document.blurs.lastIndex(where: { $0.id == current.id }),
                  item.document.blurs[index].points.count == 1,
                  let only = item.document.blurs[index].points.first
            else { return }
            item.document.blurs[index].points.append(only)
        } else {
            guard let index = item.document.strokes.lastIndex(where: { $0.id == current.id }),
                  item.document.strokes[index].points.count == 1,
                  let only = item.document.strokes[index].points.first
            else { return }
            item.document.strokes[index].points.append(only)
        }
    }

    /// Экран → нормализованные координаты исходного кадра, зажатые в 0…1: палец может
    /// уехать за край кадра, а точка за пределами оригинала при экспорте не имеет смысла.
    private func clampedOriginal(_ screenPoint: CGPoint) -> CGPoint {
        let p = geometry.screenToOriginal(screenPoint)
        return CGPoint(x: min(max(p.x, 0), 1), y: min(max(p.y, 0), 1))
    }
}

/// Что рисуем прямо сейчас: какой штрих в документе и где была последняя точка.
private struct DrawActiveStroke {
    let id: UUID
    /// true — штрих в `document.blurs`, иначе в `document.strokes`.
    let isBlur: Bool
    /// startLocation жеста в координатах слоя — признак «тот же жест».
    let gestureStart: CGPoint
    /// Последняя ЗАПИСАННАЯ точка на экране — от неё считаем прореживание.
    var lastScreen: CGPoint
}

// MARK: - Панель кисти

/// Ряд видов кисти, палитра и толщина. Панель не выше ~100 pt: две строки.
struct DrawToolbar: View {

    @ObservedObject var item: PhotoEditItem
    @ObservedObject var tools: PhotoEditorToolState

    /// Диапазон толщины — доля ширины исходного кадра (0.004 — волосяная линия,
    /// 0.04 — жирный маркер на четверти экрана).
    private static let widthRange: ClosedRange<CGFloat> = 0.004...0.04

    var body: some View {
        VStack(spacing: 6) {
            brushRow
            HStack(spacing: 10) {
                if tools.brushKind == .eraser {
                    // Ластику цвет не нужен — вместо палитры подсказка, что он стирает.
                    Text("Ластик стирает только штрихи, фото не трогает")
                        .font(.caption)
                        .foregroundStyle(.white.opacity(0.6))
                        .lineLimit(2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    DrawColorPalette(selected: $tools.brushColor)
                }
                DrawWidthSlider(
                    value: $tools.brushWidth, range: Self.widthRange,
                    color: previewColor, opacity: previewOpacity
                )
                .frame(width: 150)
            }
            .frame(height: 40)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 4)
        .frame(maxWidth: .infinity)
        .background(Color.black)
    }

    private var brushRow: some View {
        HStack(spacing: 0) {
            ForEach(BrushKind.allCases) { kind in
                let active = tools.brushKind == kind
                Button {
                    tools.brushKind = kind
                } label: {
                    VStack(spacing: 3) {
                        Image(systemName: kind.icon)
                            .font(.system(size: 18, weight: .medium))
                        Text(kind.title)
                            .font(.system(size: 10))
                    }
                    .foregroundStyle(active ? Eb.brand : .white.opacity(0.85))
                    .frame(maxWidth: .infinity)
                    .frame(height: 44)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
    }

    /// Цвет кружка-превью: у ластика цвета нет, показываем нейтральный серый.
    private var previewColor: Color {
        tools.brushKind == .eraser ? Color.white.opacity(0.5) : tools.brushColor
    }

    /// Маркер на холсте полупрозрачный — превью повторяет это, чтобы не обманывать.
    private var previewOpacity: Double {
        tools.brushKind == .marker ? 0.45 : 1
    }
}

// MARK: - Панель размытия

/// Переключатель «Мозаика / Размытие» и ширина штриха.
struct BlurToolbar: View {

    @ObservedObject var item: PhotoEditItem
    @ObservedObject var tools: PhotoEditorToolState

    /// Ширина штриха размытия — доля ширины кадра; 0.03 — палец, 0.2 — пятая часть кадра.
    private static let widthRange: ClosedRange<CGFloat> = 0.03...0.2

    var body: some View {
        VStack(spacing: 8) {
            HStack(spacing: 8) {
                DrawModeChip(title: "Мозаика", icon: "square.grid.3x3.fill", active: !tools.blurSoft) {
                    tools.blurSoft = false
                }
                DrawModeChip(title: "Размытие", icon: "aqi.medium", active: tools.blurSoft) {
                    tools.blurSoft = true
                }
                Spacer(minLength: 0)
                // Подсказка — почему по умолчанию мозаика: размытый текст порой читается.
                Text(tools.blurSoft ? "Мягче, но текст может угадываться" : "Надёжно скрывает лица и текст")
                    .font(.caption)
                    .foregroundStyle(.white.opacity(0.6))
                    .multilineTextAlignment(.trailing)
                    .lineLimit(2)
            }
            HStack(spacing: 10) {
                Text("Ширина")
                    .font(.subheadline)
                    .foregroundStyle(.white.opacity(0.85))
                DrawWidthSlider(
                    value: $tools.blurWidth, range: Self.widthRange,
                    color: Color.white.opacity(0.7), soft: tools.blurSoft
                )
            }
            .frame(height: 40)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 4)
        .frame(maxWidth: .infinity)
        .background(Color.black)
    }
}

// MARK: - Общие детали панелей (только этот файл — у других инструментов свои)

/// Горизонтальная лента цветов PhotoEditorPalette; выбранный — кольцо Eb.brand.
private struct DrawColorPalette: View {

    @Binding var selected: Color

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 0) {
                ForEach(Array(PhotoEditorPalette.colors.enumerated()), id: \.offset) { _, color in
                    let active = selected == color
                    Button {
                        selected = color
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

/// Слайдер толщины с кружком-превью слева. Кружок показывает толщину ОТНОСИТЕЛЬНО
/// диапазона, а не в масштабе кадра: у панели нет геометрии холста, а точный размер
/// и так виден по самому штриху.
private struct DrawWidthSlider: View {

    @Binding var value: CGFloat
    let range: ClosedRange<CGFloat>
    let color: Color
    var opacity: Double = 1
    /// Размытый кружок — для мягкого режима размытия.
    var soft: Bool = false

    private var diameter: CGFloat {
        let span = max(range.upperBound - range.lowerBound, 0.0001)
        let t = min(max((value - range.lowerBound) / span, 0), 1)
        return 4 + t * 24
    }

    var body: some View {
        HStack(spacing: 8) {
            ZStack {
                // Серая подложка: чёрный цвет палитры на чёрной панели иначе не виден.
                Circle()
                    .fill(Color.white.opacity(0.12))
                Circle()
                    .fill(color.opacity(opacity))
                    .frame(width: diameter, height: diameter)
                    .blur(radius: soft ? 2 : 0)
            }
            .frame(width: 32, height: 32)
            Slider(value: $value, in: range)
                .tint(Eb.brand)
        }
    }
}

/// Чип режима (капсула): активный — заливка Eb.brand.
private struct DrawModeChip: View {

    let title: String
    let icon: String
    let active: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Image(systemName: icon)
                    .font(.system(size: 14, weight: .medium))
                Text(title)
                    .font(.subheadline.weight(.medium))
            }
            .foregroundStyle(active ? Color.white : Color.white.opacity(0.85))
            .padding(.horizontal, 14)
            .frame(height: 40)
            .background(active ? Eb.brand : Color.white.opacity(0.12), in: Capsule())
        }
        .buttonStyle(.plain)
    }
}
