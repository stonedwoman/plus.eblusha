import SwiftUI

// Экран установления звонка — порт `CallConnecting.tsx` + `callConnecting.css` (дизайн
// «вариант 2»), раскладка узкого экрана (телефон): узел 52, обёртка до 80, этапы в две
// колонки. Всё, что здесь нарисовано, приходит готовым из ConnectView: вид ничего не решает
// и ничем не управляет, кроме отмены. Его собственная память — выбранная подсказка и
// «уже отменяем».

// MARK: - Палитра звонка

/// Сине-графитовая палитра экрана звонка — НЕ оранжевая: у звонка свой характер.
/// Значения — из переменных `.eb-cn` веба.
private enum CallInk {
    static let bg = Color(hex: 0x0D1722)
    static let bgDeep = Color(hex: 0x0A121B)
    static let bgGlow = Color(hex: 0x12213A)
    static let border = Color(hex: 0x293A50)
    static let borderStrong = Color(hex: 0x3A5070)
    static let text = Color(hex: 0xEEF3FF)
    static let textMuted = Color(hex: 0xAABCD5)
    static let accent = Color(hex: 0x4B7BFF)
    static let accentText = Color(hex: 0xA9C1FF)
    static let success = Color(hex: 0x64DDAA)
    static let error = Color(hex: 0xFF5C7A)
    /// Кружок сделанного этапа: тёмная галочка на бирюзовом.
    static let successInk = Color(hex: 0x08231A)
    /// Идущие штрихи «ждёт»: rgba(170, 188, 213, 0.3).
    static let idleDash = Color(hex: 0xAABCD5, opacity: 0.3)

    static func ring(_ id: ConnectNodeId) -> Color {
        switch id {
        case .you: return Color(hex: 0x64DDAA)
        case .relay: return Color(hex: 0x4B7BFF)
        case .server: return Color(hex: 0x8758FF)
        case .peer: return Color(hex: 0x64DDAA)
        }
    }
}

// MARK: - Оверлей

/// Кладётся поверх интерфейса разговора. Пока экран смонтирован, соединение под ним
/// устанавливается как шло, а человек не видит разговор раньше, чем его начнут слышать.
struct CallConnectingOverlay: View {
    @ObservedObject var controller: CallConnectController

    var body: some View {
        if controller.visible {
            CallConnectingView(
                view: controller.view,
                leaving: controller.leaving,
                onCancel: controller.cancel,
                ringStartedAt: controller.ringStartedAt
            )
        }
    }
}

// MARK: - Экран

struct CallConnectingView: View {
    let view: ConnectView
    let leaving: Bool
    let onCancel: () -> Void
    /// Когда начался дозвон (монотонные мс) — кольца попадают в фазу, а не стартуют с нуля
    /// при каждом появлении экрана. nil — от момента появления.
    var ringStartedAt: Double? = nil
    /// Период колец. Своего гудка у iOS нет — берём период веб-эталона по умолчанию.
    var ringPeriodMs: Double = 2000

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var cancelling = false
    @State private var selected: String?
    @State private var appeared = false

    var body: some View {
        GeometryReader { geo in
            ZStack {
                background
                ScrollView(showsIndicators: false) {
                    Group {
                        if view.mode == .error, let error = view.error {
                            errorPanel(error)
                        } else {
                            panel
                        }
                    }
                    // Панель берёт СВОЮ высоту, а не высоту экрана: иначе высоту, которую
                    // предлагает прокрутка, съедали бы гибкие дети — карточки этапов
                    // вытягивались бы на весь экран.
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(12)
                    .frame(maxWidth: .infinity)
                    // Панель по центру, если помещается; иначе — прокрутка (overflow: auto).
                    .frame(minHeight: geo.size.height, alignment: .center)
                }
            }
        }
        // Уход: растворяется за 0,2 с, разговор под ним уже идёт; касания — сразу ему.
        .opacity(leaving ? 0 : 1)
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.2), value: leaving)
        .allowsHitTesting(!leaving)
        .onAppear {
            if reduceMotion {
                appeared = true
            } else {
                withAnimation(.easeOut(duration: 0.28)) { appeared = true }
            }
        }
    }

    private var background: some View {
        EllipticalGradient(
            stops: [
                .init(color: CallInk.bgGlow, location: 0),
                .init(color: CallInk.bg, location: 0.55),
                .init(color: CallInk.bgDeep, location: 1),
            ],
            center: .top,
            startRadiusFraction: 0,
            endRadiusFraction: 1.8
        )
        .ignoresSafeArea()
    }

    // MARK: Панель

    private var panel: some View {
        VStack(spacing: 14) {
            if !view.facts.isEmpty { factsCard }
            head
            ConnectPath(
                view: view,
                selected: selected,
                reduceMotion: reduceMotion,
                ringStartedAt: ringStartedAt,
                ringPeriodMs: ringPeriodMs,
                onSelect: toggle
            )
            steps
            Text(selectedDetail ?? " ")
                .font(.system(size: 12.5))
                .foregroundStyle(CallInk.textMuted)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity, minHeight: 18)
                .opacity(selectedDetail == nil ? 0 : 1)
            cancelButton(title: cancelling ? "Отменяем…" : "Отменить")
        }
        .padding(16)
        .background(panelShape)
        .opacity(appeared ? 1 : 0)
        .offset(y: appeared ? 0 : 6)
        .scaleEffect(appeared ? 1 : 0.985)
    }

    private var panelShape: some View {
        RoundedRectangle(cornerRadius: 14)
            .fill(LinearGradient(
                colors: [
                    Color(red: 20 / 255, green: 32 / 255, blue: 46 / 255, opacity: 0.92),
                    Color(red: 13 / 255, green: 23 / 255, blue: 34 / 255, opacity: 0.96),
                ],
                startPoint: .top,
                endPoint: .bottom
            ))
            .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(CallInk.border, lineWidth: 1))
            .shadow(color: Color(red: 3 / 255, green: 8 / 255, blue: 16 / 255, opacity: 0.45), radius: 25, y: 18)
    }

    // MARK: Факты

    private var factsCard: some View {
        FlowRows(horizontalSpacing: 16, verticalSpacing: 6) {
            ForEach(view.facts) { fact in
                HStack(spacing: 8) {
                    Image(systemName: factIcon(fact.id))
                        .font(.system(size: 12, weight: .medium))
                        .frame(width: 14, height: 14)
                        .foregroundStyle(CallInk.success)
                    Text(fact.text)
                        .font(.system(size: 12))
                        // Цифры табличной ширины: 45 и 108 мс не двигают строку.
                        .monospacedDigit()
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .foregroundStyle(CallInk.text)
                }
                .transition(reduceMotion ? .identity : .opacity.combined(with: .offset(y: 4)))
            }
        }
        .animation(reduceMotion ? nil : .easeOut(duration: 0.18), value: view.facts.map(\.id))
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 13)
                .fill(Color(red: 13 / 255, green: 23 / 255, blue: 34 / 255, opacity: 0.72))
        )
        .overlay(RoundedRectangle(cornerRadius: 13).strokeBorder(CallInk.border, lineWidth: 1))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Сведения о соединении: " + view.facts.map(\.text).joined(separator: ", "))
    }

    private func factIcon(_ id: ConnectFactId) -> String {
        switch id {
        case .e2ee: return "lock"
        case .relay: return "point.3.connected.trianglepath.dotted"
        case .direct: return "arrow.right"
        case .rtt: return "clock"
        }
    }

    // MARK: Заголовок

    private var head: some View {
        // Новый текст проявляется заново (key={…} на вебе) — в том числе каждую секунду
        // таймера дозвона. Каждая строка в своём ZStack: на время перехода уходящая и
        // приходящая лежат друг на друге, а не друг под другом — иначе панель подпрыгивала бы.
        VStack(spacing: 4) {
            ZStack {
                Text(view.title)
                    .font(.system(size: 19, weight: .semibold))
                    .kerning(-0.2)
                    .foregroundStyle(CallInk.text)
                    .multilineTextAlignment(.center)
                    .id(view.title)
                    .transition(headTransition)
            }
            ZStack {
                Text(view.subtitle)
                    .font(.system(size: 14))
                    .monospacedDigit()
                    .foregroundStyle(CallInk.textMuted)
                    .multilineTextAlignment(.center)
                    .id(view.subtitle)
                    .transition(headTransition)
            }
        }
        // justify-content: flex-end в блоке не ниже 58 pt — без жадного Spacer: внутри
        // прокрутки он растягивал бы всю панель на высоту экрана.
        .frame(maxWidth: .infinity, minHeight: 58, alignment: .bottom)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.16), value: view.title)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.16), value: view.subtitle)
        .accessibilityElement(children: .combine)
    }

    private var headTransition: AnyTransition {
        reduceMotion ? .identity : .asymmetric(insertion: .opacity.combined(with: .offset(y: 4)), removal: .opacity)
    }

    // MARK: Этапы

    private var steps: some View {
        // Grid, а не LazyVGrid: ячейки одного ряда делят общую высоту, как в CSS-сетке
        // веба, — карточка с подписью в две строки не торчит над соседней.
        let indexed = Array(view.steps.enumerated())
        let rows = stride(from: 0, to: indexed.count, by: 2).map { Array(indexed[$0..<min($0 + 2, indexed.count)]) }
        return Grid(horizontalSpacing: 8, verticalSpacing: 8) {
            ForEach(rows, id: \.first!.element.id) { row in
                GridRow {
                    ForEach(row, id: \.element.id) { index, step in
                        StepCard(
                            step: step,
                            number: index + 1,
                            selected: selected == "step:\(step.id.rawValue)",
                            reduceMotion: reduceMotion
                        ) {
                            toggle("step:\(step.id.rawValue)")
                        }
                    }
                    if row.count == 1 {
                        Color.clear.gridCellUnsizedAxes([.horizontal, .vertical])
                    }
                }
            }
        }
    }

    // MARK: Отмена

    private func cancelButton(title: String) -> some View {
        Button {
            guard !cancelling else { return }
            cancelling = true
            onCancel()
        } label: {
            Text(title)
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(CallInk.text)
                .frame(maxWidth: 280)
                .frame(height: 44)
                .background(
                    Capsule().fill(Color(red: 20 / 255, green: 32 / 255, blue: 46 / 255, opacity: 0.9))
                )
                .overlay(Capsule().strokeBorder(CallInk.borderStrong, lineWidth: 1))
        }
        .buttonStyle(CancelPressStyle())
        .disabled(cancelling)
        .opacity(cancelling ? 0.7 : 1)
        .frame(maxWidth: .infinity)
    }

    // MARK: Ошибка

    private func errorPanel(_ error: ConnectError) -> some View {
        VStack(spacing: 12) {
            ZStack {
                Circle()
                    .fill(CallInk.error.opacity(0.1))
                    .frame(width: 80, height: 80)
                Circle()
                    .fill(Color(hex: 0x1B1320))
                    .frame(width: 72, height: 72)
                    .overlay(Circle().strokeBorder(CallInk.error.opacity(0.8), lineWidth: 2))
                    .shadow(color: CallInk.error.opacity(0.25), radius: 12)
                Image(systemName: "exclamationmark.shield")
                    .font(.system(size: 30, weight: .regular))
                    .foregroundStyle(CallInk.error)
            }
            .accessibilityHidden(true)
            Text(error.title)
                .font(.system(size: 20, weight: .semibold))
                .foregroundStyle(CallInk.text)
                .multilineTextAlignment(.center)
            Text(error.text)
                .font(.system(size: 14))
                .lineSpacing(3)
                .foregroundStyle(CallInk.textMuted)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 440)
                .padding(.bottom, 6)
            cancelButton(title: cancelling ? "Закрываем…" : "Закрыть")
        }
        .padding(.top, 16)
        .padding(.horizontal, 8)
        .padding(.bottom, 8)
        .frame(maxWidth: .infinity)
        .padding(16)
        .background(panelShape)
        .opacity(appeared ? 1 : 0)
        .offset(y: appeared ? 0 : 6)
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(.isModal)
    }

    // MARK: Подсказка

    private var selectedDetail: String? {
        guard let selected else { return nil }
        if let node = view.nodes.first(where: { "node:\($0.id.rawValue)" == selected }) { return node.detail }
        if let step = view.steps.first(where: { "step:\($0.id.rawValue)" == selected }) { return step.hint }
        return nil
    }

    private func toggle(_ key: String) {
        selected = selected == key ? nil : key
    }
}

private struct CancelPressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.985 : 1)
            .animation(.easeOut(duration: 0.1), value: configuration.isPressed)
    }
}

// MARK: - Цепочка узлов

/// Путь разговора: вы → [ретранслятор] → сервер → собеседник, с участками между узлами и
/// волнами за ними. Участок лежит на горизонтали центров кругов, а не блоков с подписями.
private struct ConnectPath: View {
    let view: ConnectView
    let selected: String?
    let reduceMotion: Bool
    let ringStartedAt: Double?
    let ringPeriodMs: Double
    let onSelect: (String) -> Void

    @State private var rowWidth: CGFloat = 0

    private static let node: CGFloat = 52

    var body: some View {
        let count = max(view.nodes.count, 1)
        // У веба обёртка узла 80 px, и цепочка из четырёх узлов на телефоне вылезала за
        // край. Здесь обёртка сжимается ровно настолько, чтобы все участки сохранили хотя бы
        // свой минимум (22 px, из них 12 заходят под поля соседних узлов).
        let wrap = rowWidth > 0
            ? min(80, max(Self.node + 12, (rowWidth - CGFloat(count - 1) * 10) / CGFloat(count)))
            : 80
        let side = (wrap - Self.node) / 2

        HStack(alignment: .top, spacing: 0) {
            ForEach(Array(view.nodes.enumerated()), id: \.element.id) { index, node in
                if index > 0 {
                    let previous = view.nodes[index - 1]
                    ConnectLinkView(
                        state: view.links.first(where: { $0.to == node.id })?.state ?? .ready,
                        from: CallInk.ring(previous.id),
                        to: CallInk.ring(node.id),
                        reduceMotion: reduceMotion
                    )
                    // Линия тянется почти от кромки до кромки кругов: заходит под поля
                    // узлов, не доставая до круга 8 pt.
                    .frame(minWidth: 22, maxWidth: .infinity)
                    .frame(height: 2)
                    .padding(.horizontal, 8 - side)
                    .padding(.top, Self.node / 2 - 1)
                    .transition(.opacity)
                }
                NodeView(
                    node: node,
                    wrap: wrap,
                    selected: selected == "node:\(node.id.rawValue)",
                    reduceMotion: reduceMotion,
                    ringStartedAt: ringStartedAt,
                    ringPeriodMs: ringPeriodMs
                ) {
                    onSelect("node:\(node.id.rawValue)")
                }
                .transition(reduceMotion ? .identity : .opacity.combined(with: .scale(scale: 0.6)))
            }
        }
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.4), value: view.nodes.map(\.id))
        .frame(maxWidth: .infinity)
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { rowWidth = $0 }
        .background(alignment: .top) {
            // Фоновые волны — только декор; при «меньше движения» их нет вовсе.
            if !reduceMotion {
                ConnectWaves()
                    .frame(height: Self.node + 72)
                    .padding(.horizontal, -24)
                    .offset(y: -16)
                    .allowsHitTesting(false)
            }
        }
        .padding(.top, 14)
        .padding(.bottom, 4)
    }
}

/// Узел: круг с кольцом цвета роли, подпись под ним. Цвет роли и состояние — разные вещи:
/// роль задаёт оттенок, состояние — насыщенность, ореол и активность.
private struct NodeView: View {
    let node: ConnectNode
    let wrap: CGFloat
    let selected: Bool
    let reduceMotion: Bool
    let ringStartedAt: Double?
    let ringPeriodMs: Double
    let onTap: () -> Void

    private static let size: CGFloat = 52
    private static let icon: CGFloat = 22

    var body: some View {
        let ring = CallInk.ring(node.id)
        Button(action: onTap) {
            VStack(spacing: 0) {
                disc(ring: ring)
                    .offset(y: selected ? -2 : 0)
                    .animation(.easeOut(duration: 0.16), value: selected)
                Text(node.label)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(CallInk.text)
                    .multilineTextAlignment(.center)
                    .lineLimit(2)
                    // Длинное слово («ретранслятор») чуть ужимается, а не обрезается.
                    .minimumScaleFactor(0.85)
                    .padding(.top, 10)
                if let sub = node.sub {
                    Text(sub)
                        .font(.system(size: 11))
                        .monospacedDigit()
                        .foregroundStyle(CallInk.textMuted)
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .padding(.top, 2)
                }
            }
            .frame(width: wrap)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(node.label): \(stateTitle)")
        .accessibilityHint(node.detail)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private var stateTitle: String {
        switch node.state {
        case .waiting: return "ждёт"
        case .active: return "подключается"
        case .ready: return "готов"
        case .ringing: return "вызываем"
        }
    }

    private func disc(ring: Color) -> some View {
        let state = node.state
        let border: Double = state == .waiting ? 0.3 : (state == .active ? 0.85 : 0.95)
        let underlay: Double = state == .active ? 0.08 : (state == .ringing ? 0.12 : 0.1)
        return ZStack {
            // Кольцо-подложка (box-shadow 0 0 0 4px): у готового ярче, у ждущего нет.
            if state != .waiting {
                Circle()
                    .fill(ring.opacity(selected ? 0.16 : underlay))
                    .frame(width: Self.size + (selected ? 10 : 8), height: Self.size + (selected ? 10 : 8))
            }
            if state == .ringing {
                RingWaves(color: ring, startedAt: ringStartedAt, periodMs: ringPeriodMs, reduceMotion: reduceMotion)
                    .frame(width: Self.size, height: Self.size)
            }
            if state == .active {
                NodeHalo(ring: ring, reduceMotion: reduceMotion)
                SpinningArc(color: ring.opacity(0.9), lineWidth: 2, period: 1.2, reduceMotion: reduceMotion)
                    .frame(width: Self.size + 12, height: Self.size + 12)
            }
            Circle()
                .fill(RadialGradient(
                    colors: [Color(hex: 0x1C2D42), Color(hex: 0x0F1B29)],
                    center: UnitPoint(x: 0.5, y: 0.38),
                    startRadius: 0,
                    endRadius: Self.size * 0.6
                ))
                .overlay(glyph(ring: ring))
                .clipShape(Circle())
                .overlay(Circle().strokeBorder(ring.opacity(border), lineWidth: 2))
                .frame(width: Self.size, height: Self.size)
                .shadow(
                    color: state == .ready
                        ? ring.opacity(selected ? 0.4 : 0.28)
                        : (state == .ringing ? ring.opacity(selected ? 0.4 : 0.35) : .clear),
                    radius: selected || state == .ringing ? 13 : 11
                )
        }
        .frame(width: Self.size, height: Self.size)
    }

    @ViewBuilder
    private func glyph(ring: Color) -> some View {
        let tint = node.state == .waiting ? ring.opacity(0.5) : ring
        switch node.id {
        case .you:
            symbol("person", tint)
        case .relay:
            symbol("cloud", tint)
        case .server:
            symbol("server.rack", tint)
        case .peer:
            if node.group && node.avatarUrl?.isEmpty != false {
                // Группа без картинки — значок людей, как у веба.
                symbol("person.2", tint)
            } else {
                // Штатный аватар приложения: картинка или инициалы в тех же цветах, что в
                // списке чатов, — собеседник узнаётся с первого взгляда.
                AvatarView(name: node.label, avatarUrl: node.avatarUrl, size: Self.size)
                    .grayscale(node.state == .waiting ? 0.7 : 0)
                    .opacity(node.state == .waiting ? 0.55 : 1)
            }
        }
    }

    private func symbol(_ name: String, _ tint: Color) -> some View {
        Image(systemName: name)
            .font(.system(size: Self.icon * 0.82, weight: .regular))
            .frame(width: Self.icon, height: Self.icon)
            .foregroundStyle(tint)
    }
}

/// Дозвон: три кольца расходятся от круга со сдвигом 0 / 0,13 / 0,30 периода — в такт трём
/// нотам веб-гудка. Фаза считается от начала вызова, а не от появления вида: вернувшись в
/// приложение или развернув звонок, человек видит те же кольца, а не новый старт с нуля.
/// Кадр кольца — keyframes eb-cn-ring веба: за 55 % периода масштаб 1 → 1,9 и
/// непрозрачность 0,75 → 0 (ease-out), остаток периода кольца нет.
private struct RingWaves: View {
    let color: Color
    let startedAt: Double?
    let periodMs: Double
    let reduceMotion: Bool

    @State private var appearedAt = connectMonotonicNowMs()

    private static let offsets: [Double] = [0, 0.13, 0.3]

    var body: some View {
        if reduceMotion {
            // «Меньше движения»: одно неподвижное кольцо, как на вебе.
            Circle()
                .strokeBorder(color, lineWidth: 2)
                .scaleEffect(1.25)
                .opacity(0.35)
                .allowsHitTesting(false)
        } else {
            TimelineView(.animation) { _ in
                let cycles = (connectMonotonicNowMs() - (startedAt ?? appearedAt)) / max(periodMs, 1)
                ZStack {
                    ForEach(0..<Self.offsets.count, id: \.self) { i in
                        let phase = cycles - Self.offsets[i]
                        let progress = phase - phase.rounded(.down)
                        let eased = progress < 0.55 ? cssEaseOut(progress / 0.55) : 1
                        Circle()
                            .strokeBorder(color, lineWidth: 2)
                            .scaleEffect(1 + 0.9 * eased)
                            .opacity(0.75 * (1 - eased))
                    }
                }
            }
            .allowsHitTesting(false)
        }
    }
}

/// CSS ease-out — cubic-bezier(0, 0, 0.58, 1): по доле времени x находим параметр кривой
/// (бисекция, x(t) монотонна) и возвращаем её y.
private func cssEaseOut(_ x: Double) -> Double {
    if x <= 0 { return 0 }
    if x >= 1 { return 1 }
    func curve(_ t: Double, _ p1: Double, _ p2: Double) -> Double {
        let u = 1 - t
        return 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t
    }
    var lo = 0.0, hi = 1.0
    for _ in 0..<24 {
        let mid = (lo + hi) / 2
        if curve(mid, 0, 0.58) < x { lo = mid } else { hi = mid }
    }
    return curve((lo + hi) / 2, 0, 1)
}

/// Ореол подключающегося узла — отдельным слоем, чтобы сам круг, аватар и подпись не дышали.
private struct NodeHalo: View {
    let ring: Color
    let reduceMotion: Bool
    @State private var pulse = false

    var body: some View {
        Circle()
            .strokeBorder(ring, lineWidth: 2)
            .scaleEffect(reduceMotion ? 1 : (pulse ? 1.45 : 1))
            .opacity(reduceMotion ? 0.5 : (pulse ? 0 : 0.6))
            .onAppear {
                guard !reduceMotion else { return }
                withAnimation(.easeOut(duration: 2).repeatForever(autoreverses: false)) { pulse = true }
            }
    }
}

/// Бегущая дуга: верхняя четверть окружности (border-top-color на вебе), вращение по кругу.
private struct SpinningArc: View {
    let color: Color
    let lineWidth: CGFloat
    let period: Double
    let reduceMotion: Bool
    @State private var spin = false

    var body: some View {
        Circle()
            .trim(from: 0.625, to: 0.875)
            .stroke(color, style: StrokeStyle(lineWidth: lineWidth, lineCap: .butt))
            .rotationEffect(.degrees(spin ? 360 : 0))
            .onAppear {
                guard !reduceMotion else { return }
                withAnimation(.linear(duration: period).repeatForever(autoreverses: false)) { spin = true }
            }
    }
}

/// Участок между узлами: пунктир «ждёт», бегущий пунктир «прокладывается», сплошной
/// градиент с бегущей светящейся точкой «проложен». Точка едет ТОЛЬКО по проложенным.
private struct ConnectLinkView: View {
    let state: ConnectLinkState
    let from: Color
    let to: Color
    let reduceMotion: Bool

    var body: some View {
        switch state {
        case .idle:
            DashLine(color: CallInk.idleDash, phase: 0)
        case .searching:
            if reduceMotion {
                DashLine(color: CallInk.accent.opacity(0.85), phase: 0)
            } else {
                TimelineView(.animation(minimumInterval: 1 / 30)) { context in
                    let t = context.date.timeIntervalSinceReferenceDate
                    // Сдвиг на период штриха (12 pt) за 0,8 с — пунктир «бежит» вперёд.
                    DashLine(color: CallInk.accent.opacity(0.85), phase: -CGFloat(t.truncatingRemainder(dividingBy: 0.8) / 0.8) * 12)
                }
            }
        case .ready:
            Capsule()
                .fill(LinearGradient(colors: [from, to], startPoint: .leading, endPoint: .trailing))
                .shadow(color: CallInk.accent.opacity(0.25), radius: 4)
                .overlay(alignment: .leading) {
                    if !reduceMotion { Packet(glow: to) }
                }
        }
    }
}

private struct DashLine: View {
    let color: Color
    let phase: CGFloat

    var body: some View {
        GeometryReader { geo in
            Path { path in
                path.move(to: CGPoint(x: 0, y: geo.size.height / 2))
                path.addLine(to: CGPoint(x: geo.size.width, y: geo.size.height / 2))
            }
            .stroke(color, style: StrokeStyle(lineWidth: 2, dash: [6, 6], dashPhase: phase))
        }
    }
}

/// Светящаяся точка, едущая по проложенному участку за 2,2 с, с проявлением в начале и
/// растворением в конце пути.
private struct Packet: View {
    let glow: Color

    var body: some View {
        GeometryReader { geo in
            TimelineView(.animation(minimumInterval: 1 / 30)) { context in
                let t = context.date.timeIntervalSinceReferenceDate
                let progress = t.truncatingRemainder(dividingBy: 2.2) / 2.2
                let alpha = progress < 0.12
                    ? progress / 0.12
                    : (progress > 0.88 ? (1 - progress) / 0.12 : 1)
                Circle()
                    .fill(.white)
                    .frame(width: 8, height: 8)
                    .shadow(color: glow, radius: 5)
                    .opacity(alpha)
                    .offset(x: -4 + geo.size.width * progress, y: geo.size.height / 2 - 4)
            }
        }
    }
}

// MARK: - Этап

private struct StepCard: View {
    let step: ConnectStep
    let number: Int
    let selected: Bool
    let reduceMotion: Bool
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            VStack(alignment: .leading, spacing: 8) {
                badge
                Text(step.title)
                    .font(.system(size: 12))
                    .lineSpacing(1)
                    .lineLimit(3)
                    .multilineTextAlignment(.leading)
                    .foregroundStyle(textColor)
            }
            .padding(10)
            .frame(maxWidth: .infinity, minHeight: 72, maxHeight: .infinity, alignment: .topLeading)
            .background(RoundedRectangle(cornerRadius: 13).fill(fill))
            .overlay(RoundedRectangle(cornerRadius: 13).strokeBorder(stroke, lineWidth: 1))
            .overlay {
                if step.status == .active {
                    RoundedRectangle(cornerRadius: 12)
                        .strokeBorder(CallInk.accent.opacity(0.25), lineWidth: 1)
                        .padding(1)
                }
            }
            .opacity(step.status == .waiting ? 0.72 : 1)
            .contentShape(RoundedRectangle(cornerRadius: 13))
        }
        .buttonStyle(.plain)
        .animation(.easeInOut(duration: 0.2), value: step.status)
        .accessibilityLabel("Этап \(number), \(step.title): \(statusTitle)")
        .accessibilityHint(step.hint)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private var badge: some View {
        ZStack {
            Circle().fill(badgeFill)
            if step.status == .done {
                Image(systemName: "checkmark")
                    .font(.system(size: 11, weight: .heavy))
                    .foregroundStyle(CallInk.successInk)
            } else {
                Text("\(number)")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(step.status == .active ? .white : CallInk.textMuted)
            }
            if step.status == .active {
                SpinningArc(color: CallInk.accent.opacity(0.9), lineWidth: 2, period: 1.1, reduceMotion: reduceMotion)
                    .frame(width: 32, height: 32)
            }
        }
        .frame(width: 24, height: 24)
    }

    private var statusTitle: String {
        switch step.status {
        case .done: return "готово"
        case .active: return "выполняется"
        case .waiting: return "ждёт"
        }
    }

    private var textColor: Color {
        switch step.status {
        case .done: return CallInk.text
        case .active: return CallInk.accentText
        case .waiting: return CallInk.textMuted
        }
    }

    private var badgeFill: Color {
        switch step.status {
        case .done: return CallInk.success
        case .active: return CallInk.accent
        case .waiting: return Color(hex: 0xAABCD5, opacity: 0.12)
        }
    }

    private var fill: Color {
        if step.status == .active { return CallInk.accent.opacity(selected ? 0.16 : 0.1) }
        if selected { return Color(red: 26 / 255, green: 41 / 255, blue: 56 / 255, opacity: 0.9) }
        return Color(red: 20 / 255, green: 32 / 255, blue: 46 / 255, opacity: 0.6)
    }

    private var stroke: Color {
        if step.status == .active { return CallInk.accent.opacity(selected ? 0.9 : 0.8) }
        return selected ? CallInk.borderStrong : CallInk.border
    }
}

// MARK: - Волны

/// Фоновые волны за схемой: три слоя с периодом 800 единиц (как SVG веба, растянутый без
/// сохранения пропорций), сдвиг ровно на период даёт бесшовный цикл — 14 с, 19 с в
/// обратную сторону и 11 с со сдвигом −4 с. Чисто декоративны: не реагируют ни на голос,
/// ни на состояние.
private struct ConnectWaves: View {

    private struct Layer {
        let base: CGFloat
        let control: CGFloat
        let period: Double
        let reverse: Bool
        let delay: Double
        let fillOpacity: Double
        let lineWidth: CGFloat
        let lineOpacity: Double
    }

    private static let layers: [Layer] = [
        Layer(base: 116, control: 62, period: 14, reverse: false, delay: 0, fillOpacity: 0.24, lineWidth: 1.0, lineOpacity: 0.85),
        Layer(base: 124, control: 92, period: 19, reverse: true, delay: 0, fillOpacity: 0.18, lineWidth: 0.75, lineOpacity: 0.6),
        Layer(base: 104, control: 80, period: 11, reverse: false, delay: -4, fillOpacity: 0, lineWidth: 0.6, lineOpacity: 0.35),
    ]

    private static let gradient = Gradient(colors: [
        Color(hex: 0x38D3B0), Color(hex: 0x4B7BFF), Color(hex: 0x8758FF),
    ])

    var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 30)) { context in
            let t = context.date.timeIntervalSinceReferenceDate
            Canvas { ctx, size in
                let sx = size.width / 800
                let sy = size.height / 200
                let shading = GraphicsContext.Shading.linearGradient(
                    Self.gradient,
                    startPoint: .zero,
                    endPoint: CGPoint(x: size.width, y: 0)
                )
                for layer in Self.layers {
                    var fraction = ((t - layer.delay) / layer.period).truncatingRemainder(dividingBy: 1)
                    if fraction < 0 { fraction += 1 }
                    let shift = layer.reverse ? -(1 - fraction) * 800 : -fraction * 800
                    let wave = Self.wavePath(layer: layer, shift: shift, sx: sx, sy: sy)
                    if layer.fillOpacity > 0 {
                        var filled = wave
                        filled.addLine(to: CGPoint(x: (1600 + shift) * sx, y: 200 * sy))
                        filled.addLine(to: CGPoint(x: (-800 + shift) * sx, y: 200 * sy))
                        filled.closeSubpath()
                        ctx.opacity = layer.fillOpacity
                        ctx.fill(filled, with: shading)
                    }
                    ctx.opacity = layer.lineOpacity
                    ctx.stroke(wave, with: shading, lineWidth: layer.lineWidth)
                }
            }
        }
        // Маска сверху вниз: волны растворяются к нижнему краю.
        .mask(LinearGradient(colors: [.white, .white.opacity(0)], startPoint: .top, endPoint: .bottom))
    }

    /// `M-800,b Q-600,c -400,b T0,b …` — сглаженные квадратичные сегменты по 400 единиц:
    /// контрольная точка каждого следующего отражает предыдущую (горб, впадина, горб…).
    private static func wavePath(layer: Layer, shift: Double, sx: CGFloat, sy: CGFloat) -> Path {
        var path = Path()
        let trough = 2 * layer.base - layer.control
        path.move(to: CGPoint(x: (-800 + shift) * sx, y: layer.base * sy))
        var x: Double = -800
        var crest = true
        while x < 1600 {
            let controlY = crest ? layer.control : trough
            path.addQuadCurve(
                to: CGPoint(x: (x + 400 + shift) * sx, y: layer.base * sy),
                control: CGPoint(x: (x + 200 + shift) * sx, y: controlY * sy)
            )
            x += 400
            crest.toggle()
        }
        return path
    }
}

// MARK: - Строки с переносом

/// Факты в карточке: в ряд, с переносом на следующую строку (flex-wrap веба).
private struct FlowRows: Layout {
    let horizontalSpacing: CGFloat
    let verticalSpacing: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxWidth = proposal.width ?? .infinity
        var x: CGFloat = 0
        var y: CGFloat = 0
        var rowHeight: CGFloat = 0
        var widest: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(ProposedViewSize(width: maxWidth, height: nil))
            if x > 0 && x + size.width > maxWidth {
                y += rowHeight + verticalSpacing
                x = 0
                rowHeight = 0
            }
            x += size.width + horizontalSpacing
            rowHeight = max(rowHeight, size.height)
            widest = max(widest, x - horizontalSpacing)
        }
        return CGSize(width: min(widest, maxWidth), height: y + rowHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX
        var y = bounds.minY
        var rowHeight: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(ProposedViewSize(width: bounds.width, height: nil))
            if x > bounds.minX && x + size.width > bounds.maxX {
                y += rowHeight + verticalSpacing
                x = bounds.minX
                rowHeight = 0
            }
            subview.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(width: min(size.width, bounds.width), height: size.height))
            x += size.width + horizontalSpacing
            rowHeight = max(rowHeight, size.height)
        }
    }
}
