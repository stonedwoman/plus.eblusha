import SwiftUI

// Цветокоррекция: лента пресетов, выбор параметра и ОДИН слайдер под выбранный параметр.
//
// На холсте панель ничего не рисует и ничего не считает: `PhotoEditorCanvas` держит
// `PhotoPreviewCache`, который сам пересчитывает превью при каждом изменении
// `item.document.adjustments`. Поэтому здесь только правка документа и шаги отмены.
//
// Шесть слайдеров разом в 120 pt не влезают, а на телефоне их всё равно двигают по
// одному — отсюда «сегмент + один слайдер», как в редакторе Фото.

// MARK: - Панель

struct AdjustToolbar: View {

    @ObservedObject var item: PhotoEditItem
    @ObservedObject var tools: PhotoEditorToolState

    /// Какой параметр показывает слайдер. Живёт в панели, а не в PhotoEditorToolState:
    /// контракт состояния зафиксирован, а другим инструментам этот выбор не нужен.
    @State private var parameter: AdjustParameter = .brightness
    /// Палец на ползунке (из onEditingChanged): пока тянут, подпись значения подсвечена.
    @State private var editing = false
    /// За текущий жест слайдера снимок для отмены уже сделан. Сбрасывается, когда
    /// onEditingChanged сообщает об отпускании — следующий жест начнёт новый шаг отмены.
    @State private var undoPushed = false

    var body: some View {
        // Три ряда по 40 pt без зазоров — ровно бюджет панели (~120 pt).
        VStack(spacing: 0) {
            presetRow
            parameterRow
            sliderRow
        }
        .frame(maxWidth: .infinity)
        .background(Color.black)
    }

    // MARK: Пресеты

    /// Активен тот пресет, чьи adjustments в точности равны текущим: после любого движения
    /// слайдера ни один чип не подсвечен — это честно, набор уже «свой».
    private var presetRow: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(AdjustPreset.allCases) { preset in
                    AdjustPresetChip(
                        title: preset.title,
                        active: preset.adjustments == item.document.adjustments
                    ) {
                        apply(preset)
                    }
                }
            }
            .padding(.horizontal, 12)
        }
        .frame(height: 40)
    }

    // MARK: Выбор параметра

    /// Шесть кнопок в равных колонках, как ряд кистей: все параметры видны сразу, без
    /// прокрутки. Подпись с minimumScaleFactor — «Насыщенность» на узком экране ужимается,
    /// а не обрезается многоточием.
    private var parameterRow: some View {
        HStack(spacing: 0) {
            ForEach(AdjustParameter.allCases) { param in
                let active = parameter == param
                // Изменённый параметр чуть ярче нулевого: видно, что уже трогали, не
                // переключаясь на него.
                let touched = item.document.adjustments[keyPath: param.keyPath] != 0
                Button {
                    parameter = param
                } label: {
                    VStack(spacing: 2) {
                        Image(systemName: param.icon)
                            .font(.system(size: 15, weight: .medium))
                        Text(param.title)
                            .font(.system(size: 10))
                            .lineLimit(1)
                            .minimumScaleFactor(0.7)
                    }
                    .foregroundStyle(active ? Eb.brand : .white.opacity(touched ? 0.9 : 0.55))
                    .frame(maxWidth: .infinity)
                    .frame(height: 40)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 4)
    }

    // MARK: Слайдер

    private var sliderRow: some View {
        HStack(spacing: 8) {
            // Фиксированная ширина и моноширинные цифры: подпись не дёргает слайдер,
            // когда «+9» становится «+10».
            Text(valueText)
                .font(.system(size: 13, weight: .semibold).monospacedDigit())
                .foregroundStyle(editing ? Eb.brand : .white)
                .frame(width: 44, alignment: .trailing)
            Slider(value: sliderValue, in: parameter.range, onEditingChanged: { began in
                sliderEditingChanged(began)
            })
            .tint(Eb.brand)
            .accessibilityLabel(parameter.title)
            // Явная кнопка сброса в дополнение к двойному тапу: двойной тап по ползунку
            // никак не подсказан, а кнопка видна. Место под неё занято всегда, чтобы
            // слайдер не менял длину, когда параметр возвращается в ноль.
            Button(action: resetParameter) {
                Image(systemName: "arrow.counterclockwise")
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(.white.opacity(0.85))
                    .frame(width: 40, height: 40)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .opacity(currentValue == 0 ? 0 : 1)
            .disabled(currentValue == 0)
        }
        .frame(height: 40)
        .padding(.horizontal, 12)
        .contentShape(Rectangle())
        // simultaneousGesture, а не onTapGesture: обычный жест уступил бы касаниям самого
        // слайдера, а двойной тап должен срабатывать и по ползунку, и по подписи.
        .simultaneousGesture(
            TapGesture(count: 2).onEnded { _ in
                resetParameter()
            }
        )
    }

    /// Привязка слайдера к выбранному параметру документа.
    ///
    /// Снимок для отмены кладём при ПЕРВОМ реальном изменении значения за жест, а не в
    /// onEditingChanged(true): касание ползунка без движения (в том числе двойной тап для
    /// сброса) не должно тратить «Отменить» впустую — так же ведёт себя рамка обрезки.
    /// Дальнейшие изменения того же жеста снимок не делают (`undoPushed`), а
    /// onEditingChanged(false) закрывает жест. Итого — ровно один шаг отмены на движение.
    private var sliderValue: Binding<CGFloat> {
        Binding(
            get: { item.document.adjustments[keyPath: parameter.keyPath] },
            set: { newValue in
                guard newValue != item.document.adjustments[keyPath: parameter.keyPath] else { return }
                if !undoPushed {
                    item.pushUndo()
                    undoPushed = true
                }
                item.document.adjustments[keyPath: parameter.keyPath] = newValue
            }
        )
    }

    private func sliderEditingChanged(_ began: Bool) {
        editing = began
        if !began {
            undoPushed = false
        }
    }

    private var currentValue: CGFloat {
        item.document.adjustments[keyPath: parameter.keyPath]
    }

    /// Проценты: −100…+100 для двусторонних параметров, 0…100 для виньетки и резкости.
    /// Ноль без знака, минус — типографский, чтобы подпись читалась как число, а не дефис.
    private var valueText: String {
        let percent = Int((currentValue * 100).rounded())
        if percent == 0 { return "0" }
        if percent < 0 { return "−\(-percent)" }
        return parameter.isSigned ? "+\(percent)" : "\(percent)"
    }

    // MARK: Действия

    /// Пресет целиком заменяет набор — один шаг отмены. Тап по уже активному ничего не
    /// делает, чтобы не плодить пустые шаги.
    private func apply(_ preset: AdjustPreset) {
        let target = preset.adjustments
        guard item.document.adjustments != target else { return }
        item.pushUndo()
        item.document.adjustments = target
    }

    /// Сброс одного параметра в ноль (двойной тап или кнопка). Свой шаг отмены.
    private func resetParameter() {
        guard currentValue != 0 else { return }
        item.pushUndo()
        item.document.adjustments[keyPath: parameter.keyPath] = 0
    }
}

// MARK: - Параметры

/// Что умеет крутить слайдер. Порядок — как на панели.
private enum AdjustParameter: String, CaseIterable, Identifiable {
    case brightness, contrast, saturation, warmth, sharpness, vignette

    var id: String { rawValue }

    var title: String {
        switch self {
        case .brightness: return "Яркость"
        case .contrast: return "Контраст"
        case .saturation: return "Насыщенность"
        case .warmth: return "Тепло"
        case .sharpness: return "Резкость"
        case .vignette: return "Виньетка"
        }
    }

    var icon: String {
        switch self {
        case .brightness: return "sun.max"
        case .contrast: return "circle.lefthalf.filled"
        case .saturation: return "paintpalette"
        case .warmth: return "thermometer.medium"
        case .sharpness: return "triangle"
        case .vignette: return "circle.dashed"
        }
    }

    /// Двусторонний параметр (−1…1) — у него нейтраль посередине; у резкости и виньетки
    /// нейтраль слева, «отрицательной» резкости не бывает.
    var isSigned: Bool {
        switch self {
        case .brightness, .contrast, .saturation, .warmth: return true
        case .sharpness, .vignette: return false
        }
    }

    var range: ClosedRange<CGFloat> {
        isSigned ? -1...1 : 0...1
    }

    /// Поле Adjustments, которое правит слайдер: одна привязка на все шесть параметров.
    var keyPath: WritableKeyPath<Adjustments, CGFloat> {
        switch self {
        case .brightness: return \.brightness
        case .contrast: return \.contrast
        case .saturation: return \.saturation
        case .warmth: return \.warmth
        case .sharpness: return \.sharpness
        case .vignette: return \.vignette
        }
    }
}

// MARK: - Детали панели (только этот файл — у других инструментов свои)

/// Чип пресета (капсула): активный — цветом бренда, как чипы пропорций в обрезке.
/// Визуально 32 pt, зона касания — 40.
private struct AdjustPresetChip: View {

    let title: String
    let active: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(active ? Eb.brand : .white.opacity(0.85))
                .padding(.horizontal, 14)
                .frame(height: 32)
                .background(active ? Eb.brand.opacity(0.25) : Color.white.opacity(0.12), in: Capsule())
                .frame(minWidth: 44, minHeight: 40)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}
