import SwiftUI

// Экран установления звонка и дозвона — в фирменном стиле Еблуши: графит, янтарь, сливки.
// Порт веб-эталона `CallConnecting.tsx` + `callConnecting.css` в раскладке узкого контейнера
// (≤ 480 px): панель с янтарной шапкой (логотип, капсулы «Аудиозвонок · m:ss» и фактов),
// заголовок, цепочка узлов 52 pt, карточки этапов в две колонки, кнопка внизу. Цвета и
// состояния — один в один с вебом.
//
// Всё, что здесь нарисовано, приходит готовым из ConnectView: вид ничего не решает и ничем
// не управляет, кроме отмены. Его собственная память — выбранная подсказка, «уже отменяем»
// и начало секундомера в шапке.

// MARK: - Палитра звонка

/// Палитра сайта (`frontend/src/style.css :root`) — те же токены, что у `Eb`, плюс роли
/// узлов схемы: «Вы» сливочный, ретранслятор и собеседник янтарные, сервер — тёмный
/// янтарь. Синего и бирюзового прежней схемы здесь больше нет.
private enum CallInk {
    static let bg = Eb.paper                        // #0f1217
    static let bgDeep = Color(hex: 0x0B0E12)
    static let bgGlow = Color(hex: 0x171A21)
    static let surface = Eb.surface100              // #1b1f27 — панель, капсулы шапки
    static let surface2 = Eb.surface200             // #232731 — карточки, круги узлов
    static let surface3 = Eb.surface300             // #2b303a — бейдж ждущего этапа, выбор
    static let border = Eb.border                   // #313643
    static let borderStrong = Eb.borderStrong       // #3b414f
    static let text = Eb.textPrimary                // #f1f3f6
    static let textMuted = Eb.textMuted             // #9aa0a8
    static let textDim = Color(hex: 0x6B7280)
    static let amber = Eb.brand600                  // #e38b0a
    static let amberDeep = Eb.brand                 // #d97706
    static let amberDark = Eb.brand700              // #b45309
    static let cream = Eb.logoCream                 // #f4e8c9
    static let brandB = Eb.logoB                    // #e25c2a — переворачивающаяся «Б»
    static let error = Color(hex: 0xEF4444)
    /// Текст активной (янтарной) карточки.
    static let onAmber = Color(hex: 0x0A0A0A)
    /// Низ градиента инициалов — linear-gradient(160deg, #b45309, #7a3407) веба.
    static let initialsDeep = Color(hex: 0x7A3407)

    /// Цвет роли узла. Роль задаёт оттенок, состояние — насыщенность, ореол и активность.
    static func role(_ id: ConnectNodeId) -> Color {
        switch id {
        case .you: return cream
        case .relay: return amber
        case .server: return amberDark
        case .peer: return amber
        }
    }
}

// MARK: - Оверлей

/// Кладётся поверх интерфейса разговора. Пока экран смонтирован, соединение под ним
/// устанавливается как шло, а человек не видит разговор раньше, чем его начнут слышать.
struct CallConnectingOverlay: View {
    @ObservedObject var controller: CallConnectController
    /// Видеозвонок — только подпись в капсуле шапки.
    var video: Bool = false

    var body: some View {
        if controller.visible {
            CallConnectingView(
                view: controller.view,
                leaving: controller.leaving,
                onCancel: controller.cancel,
                onRetry: controller.retry,
                ringStartedAt: controller.ringStartedAt,
                video: video
            )
            .id(controller.attempt)
        }
    }
}

// MARK: - Экран

struct CallConnectingView: View {
    let view: ConnectView
    let leaving: Bool
    let onCancel: () -> Void
    /// «Повторить» под ошибкой, у которой он есть (звонок не начат из-за шифрования).
    var onRetry: (() -> Void)? = nil
    /// Когда начался дозвон (монотонные мс) — кольца, столбики гудка и «Б» попадают в фазу,
    /// а секундомер считает с набора, а не с появления экрана. nil — от момента появления.
    var ringStartedAt: Double? = nil
    /// Период колец. Своего гудка у iOS нет — берём период веб-эталона по умолчанию.
    var ringPeriodMs: Double = 2000
    /// Видеозвонок — подпись и значок капсулы в шапке.
    var video: Bool = false

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var cancelling = false
    @State private var selected: String?
    @State private var appeared = false
    /// Начало секундомера в шапке: первый известный старт (дозвон), иначе появление экрана.
    /// Запоминается один раз: после ответа дозвон из модели уходит, а секундомер
    /// сбрасываться не должен.
    @State private var clockSince: Date?

    private static let corner: CGFloat = 14

    private var ringing: Bool { view.nodes.contains { $0.id == .peer && $0.state == .ringing } }

    var body: some View {
        GeometryReader { geo in
            ZStack {
                background
                ScrollView(showsIndicators: false) {
                    Group {
                        if view.mode == .error, let error = view.error {
                            errorPanel(error)
                                // Панель ошибки берёт СВОЮ высоту и стоит по центру.
                                .fixedSize(horizontal: false, vertical: true)
                                .frame(maxWidth: .infinity)
                                .frame(minHeight: geo.size.height - 24, alignment: .center)
                        } else {
                            // Панель во весь экран; если содержимое выше экрана — прокрутка.
                            panel(minHeight: geo.size.height - 24)
                        }
                    }
                    .padding(12)
                }
            }
        }
        // Уход: растворяется за 0,2 с, разговор под ним уже идёт; касания — сразу ему.
        .opacity(leaving ? 0 : 1)
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.2), value: leaving)
        .allowsHitTesting(!leaving)
        .onAppear {
            pinClock()
            if reduceMotion {
                appeared = true
            } else {
                withAnimation(.easeOut(duration: 0.28)) { appeared = true }
            }
        }
    }

    /// Секундомер привязывается к первому известному началу один раз. Монотонные мс
    /// дозвона переводятся в дату здесь же: периодической шкале TimelineView нужна Date.
    private func pinClock() {
        guard clockSince == nil else { return }
        if let ringStartedAt {
            clockSince = Date().addingTimeInterval((ringStartedAt - connectMonotonicNowMs()) / 1000)
        } else {
            clockSince = Date()
        }
    }

    private var background: some View {
        // radial-gradient(120% 90% at 50% 0%, #171a21, #0f1217 55%, #0b0e12) веба.
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

    private func panel(minHeight: CGFloat) -> some View {
        VStack(spacing: 0) {
            bar
            VStack(spacing: 14) {
                Spacer(minLength: 0)
                // Содержимое берёт СВОЮ высоту (fixedSize): иначе VStack делит экран между
                // ним и пружинами поровну, и многострочные подписи ужимаются до одной строки.
                VStack(spacing: 14) {
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
                    detailLine
                }
                .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
                cancelButton(
                    title: ringing
                        ? (cancelling ? "Сбрасываем…" : "Сбросить")
                        : (cancelling ? "Отменяем…" : "Отменить"),
                    hangup: ringing
                )
            }
            .padding(EdgeInsets(top: 14, leading: 16, bottom: 16, trailing: 16))
            .frame(maxHeight: .infinity)
        }
        .frame(maxWidth: .infinity, minHeight: minHeight)
        .clipShape(RoundedRectangle(cornerRadius: Self.corner))
        .background(panelShape)
        .opacity(appeared ? 1 : 0)
        .offset(y: appeared ? 0 : 6)
        .scaleEffect(appeared ? 1 : 0.985)
    }

    private var panelShape: some View {
        RoundedRectangle(cornerRadius: Self.corner)
            .fill(CallInk.surface)
            .overlay(RoundedRectangle(cornerRadius: Self.corner).strokeBorder(CallInk.border, lineWidth: 1))
            .shadow(color: Color(red: 5 / 255, green: 6 / 255, blue: 9 / 255, opacity: 0.45), radius: 16, y: 12)
    }

    // MARK: Шапка: логотип и капсулы

    /// Янтарная шапка панели (`.eb-cn__bar`): слева логотип, справа капсула звонка; капсулы
    /// подтверждённых фактов — рядом, с переносом. Подпись «Звонок · Имя» на телефоне скрыта.
    private var bar: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                BrandMark(
                    ringing: ringing,
                    ringStartedAt: ringStartedAt,
                    ringPeriodMs: ringPeriodMs,
                    reduceMotion: reduceMotion
                )
                Spacer(minLength: 8)
                callPill
            }
            if !view.facts.isEmpty {
                factsRow
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(LinearGradient(
            colors: [CallInk.amberDeep.opacity(0.22), CallInk.amberDeep.opacity(0.05)],
            startPoint: .top,
            endPoint: .bottom
        ))
        .overlay(alignment: .bottom) {
            Rectangle().fill(CallInk.amberDeep).frame(height: 2)
        }
    }

    /// «Аудиозвонок · m:ss»: секундомер считает от начала дозвона и после ответа не
    /// сбрасывается — он честный, как в шапке чата.
    private var callPill: some View {
        HStack(spacing: 8) {
            Image(systemName: video ? "video" : "phone")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(CallInk.amber)
            Text(video ? "Видеозвонок" : "Аудиозвонок")
                .font(.system(size: 12))
                .foregroundStyle(CallInk.textMuted)
            ClockLabel(since: clockSince)
        }
        .modifier(PillStyle())
        .accessibilityElement(children: .combine)
    }

    /// Факты о соединении — только подтверждённые (модель других не отдаёт).
    private var factsRow: some View {
        FlowRows(horizontalSpacing: 8, verticalSpacing: 8) {
            ForEach(view.facts) { fact in
                HStack(spacing: 8) {
                    Image(systemName: factIcon(fact.id))
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(CallInk.amber)
                    Text(fact.text)
                        .font(.system(size: 12, weight: fact.id == .rtt ? .semibold : .regular))
                        // Цифры табличной ширины: 45 и 108 мс не двигают строку.
                        .monospacedDigit()
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .foregroundStyle(CallInk.text)
                }
                .modifier(PillStyle())
                .transition(reduceMotion ? .identity : .opacity.combined(with: .offset(y: 4)))
            }
        }
        .animation(reduceMotion ? nil : .easeOut(duration: 0.18), value: view.facts.map(\.id))
        .frame(maxWidth: .infinity, alignment: .leading)
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
                    .font(.system(size: 19, weight: .bold))
                    .kerning(-0.2)
                    .foregroundStyle(CallInk.text)
                    .multilineTextAlignment(.center)
                    .id(view.title)
                    .transition(headTransition)
            }
            ZStack {
                HStack(spacing: 10) {
                    Text(view.subtitle)
                        .font(.system(size: 14))
                        .monospacedDigit()
                        .foregroundStyle(CallInk.textMuted)
                        .multilineTextAlignment(.center)
                    if ringing {
                        ToneBars(ringStartedAt: ringStartedAt, ringPeriodMs: ringPeriodMs, reduceMotion: reduceMotion)
                    }
                }
                .id(view.subtitle)
                .transition(headTransition)
            }
        }
        // justify-content: flex-end в блоке не ниже 52 pt — без жадного Spacer.
        .frame(maxWidth: .infinity, minHeight: 52, alignment: .bottom)
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

    // MARK: Подсказка и отмена

    private var detailLine: some View {
        Text(selectedDetail ?? " ")
            .font(.system(size: 12.5))
            .foregroundStyle(CallInk.textMuted)
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity, minHeight: 18)
            .opacity(selectedDetail == nil ? 0 : 1)
    }

    /// На дозвоне — красный «Сбросить» с перечёркнутой трубкой, как на телефоне; дальше —
    /// тёмный «Отменить».
    private func cancelButton(title: String, hangup: Bool) -> some View {
        Button {
            guard !cancelling else { return }
            cancelling = true
            onCancel()
        } label: {
            HStack(spacing: 8) {
                if hangup {
                    Image(systemName: "phone.down.fill")
                        .font(.system(size: 15, weight: .semibold))
                }
                Text(title)
                    .font(.system(size: 14, weight: .semibold))
            }
            .foregroundStyle(hangup ? .white : CallInk.text)
            .frame(maxWidth: 280)
            .frame(height: 44)
            .background(RoundedRectangle(cornerRadius: 12).fill(hangup ? CallInk.error : CallInk.surface))
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(hangup ? CallInk.error : CallInk.border, lineWidth: 1))
            .shadow(color: Color(red: 3 / 255, green: 3 / 255, blue: 4 / 255, opacity: 0.35), radius: 7, y: 6)
            .contentShape(RoundedRectangle(cornerRadius: 12))
        }
        .buttonStyle(CancelPressStyle())
        .disabled(cancelling)
        .opacity(cancelling ? 0.7 : 1)
        .frame(maxWidth: .infinity)
    }

    /// Главная кнопка под ошибкой «звонок не начат» — янтарная, над тёмным «Закрыть».
    /// Своего «нажато» не держит: экран после неё сразу показывает новый вызов, а
    /// повторное нажатие гасит сам CallManager (ошибки к тому моменту уже нет).
    private func retryButton(_ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Image(systemName: "arrow.clockwise")
                    .font(.system(size: 15, weight: .semibold))
                Text("Повторить")
                    .font(.system(size: 14, weight: .semibold))
            }
            .foregroundStyle(CallInk.onAmber)
            .frame(maxWidth: 280)
            .frame(height: 44)
            .background(RoundedRectangle(cornerRadius: 12).fill(CallInk.amber))
            .shadow(color: Color(red: 3 / 255, green: 3 / 255, blue: 4 / 255, opacity: 0.35), radius: 7, y: 6)
            .contentShape(RoundedRectangle(cornerRadius: 12))
        }
        .buttonStyle(CancelPressStyle())
        .disabled(cancelling)
        .frame(maxWidth: .infinity)
    }

    // MARK: Ошибка

    private func errorPanel(_ error: ConnectError) -> some View {
        VStack(spacing: 0) {
            HStack {
                BrandMark(ringing: false, ringStartedAt: nil, ringPeriodMs: ringPeriodMs, reduceMotion: reduceMotion)
                Spacer()
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(LinearGradient(
                colors: [CallInk.amberDeep.opacity(0.22), CallInk.amberDeep.opacity(0.05)],
                startPoint: .top,
                endPoint: .bottom
            ))
            .overlay(alignment: .bottom) {
                Rectangle().fill(CallInk.amberDeep).frame(height: 2)
            }
            VStack(spacing: 12) {
                ZStack {
                    Circle()
                        .fill(CallInk.error.opacity(0.1))
                        .frame(width: 80, height: 80)
                    Circle()
                        .fill(CallInk.surface2)
                        .frame(width: 72, height: 72)
                        .overlay(Circle().strokeBorder(CallInk.error.opacity(0.8), lineWidth: 2))
                        .shadow(color: CallInk.error.opacity(0.25), radius: 12)
                    Image(systemName: "exclamationmark.shield")
                        .font(.system(size: 30, weight: .regular))
                        .foregroundStyle(CallInk.error)
                }
                .accessibilityHidden(true)
                Text(error.title)
                    .font(.system(size: 20, weight: .bold))
                    .foregroundStyle(CallInk.text)
                    .multilineTextAlignment(.center)
                Text(error.text)
                    .font(.system(size: 14))
                    .lineSpacing(3)
                    .foregroundStyle(CallInk.textMuted)
                    .multilineTextAlignment(.center)
                    .padding(.bottom, 6)
                if error.retry, let onRetry {
                    retryButton(onRetry)
                }
                cancelButton(title: cancelling ? "Закрываем…" : "Закрыть", hangup: false)
            }
            .padding(EdgeInsets(top: 30, leading: 24, bottom: 24, trailing: 24))
        }
        .frame(maxWidth: .infinity)
        .clipShape(RoundedRectangle(cornerRadius: Self.corner))
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

/// Капсула шапки (`.eb-cn__pill`): рамка #3b414f на фоне панели.
private struct PillStyle: ViewModifier {
    func body(content: Content) -> some View {
        content
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(Capsule().fill(CallInk.surface))
            .overlay(Capsule().strokeBorder(CallInk.borderStrong, lineWidth: 1))
    }
}

private struct CancelPressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.985 : 1)
            .animation(.easeOut(duration: 0.1), value: configuration.isPressed)
    }
}

private func nodeStateTitle(_ state: ConnectNodeState) -> String {
    switch state {
    case .waiting: return "ждёт"
    case .active: return "подключается"
    case .ready: return "готов"
    case .ringing: return "вызываем"
    }
}

private func stepStatusTitle(_ status: ConnectStepStatus) -> String {
    switch status {
    case .done: return "готово"
    case .active: return "выполняется"
    case .waiting: return "ждёт"
    }
}

/// m:ss, как в шапке чата.
private func formatClock(_ total: Int) -> String {
    let m = total / 60
    let s = total % 60
    return "\(m):\(s < 10 ? "0" : "")\(s)"
}

// MARK: - Логотип

/// Логотип «ЕБлуша» с фирменной переворачивающейся большой «Б» — как в шапке веба и на
/// заставке. На дозвоне оборот за период гудка, в фазе с кольцами; в остальное время —
/// редкий, раз в 5 с (keyframes eb-cn-flip / eb-cn-flip-slow веба).
private struct BrandMark: View {
    let ringing: Bool
    let ringStartedAt: Double?
    let ringPeriodMs: Double
    let reduceMotion: Bool

    @State private var appearedAt = connectMonotonicNowMs()

    var body: some View {
        HStack(spacing: 0) {
            Text("Е").foregroundStyle(CallInk.cream)
            if reduceMotion {
                Text("Б").foregroundStyle(CallInk.brandB)
            } else {
                TimelineView(.animation) { _ in
                    Text("Б")
                        .foregroundStyle(CallInk.brandB)
                        .rotation3DEffect(
                            .degrees(angle(at: connectMonotonicNowMs())),
                            axis: (x: 0, y: 1, z: 0),
                            perspective: 0.5
                        )
                }
            }
            Text("луша").foregroundStyle(CallInk.cream)
        }
        .font(.system(size: 20, weight: .heavy))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Еблуша")
    }

    private func angle(at now: Double) -> Double {
        if ringing {
            let period = max(ringPeriodMs, 1)
            let p = fraction((now - (ringStartedAt ?? appearedAt)) / period)
            // 0–18 % покой, 18–45 % поворот на 180°, 45–72 % покой, 72–100 % дооборот до 360°.
            return keyframes(p, [(0.18, 0), (0.45, 180), (0.72, 180), (1, 360)])
        }
        let p = fraction((now - appearedAt) / 5000)
        // 85 % покоя, затем полный оборот за 10 % периода.
        return keyframes(p, [(0.85, 0), (0.90, 180), (0.95, 360), (1, 360)])
    }

    private func fraction(_ cycles: Double) -> Double {
        let p = cycles - cycles.rounded(.down)
        return p < 0 ? p + 1 : p
    }

    /// Кусочно-линейные ключи (доля периода, угол) с ease-in-out между ними.
    private func keyframes(_ p: Double, _ keys: [(Double, Double)]) -> Double {
        var prev = (0.0, 0.0)
        for key in keys {
            if p <= key.0 {
                let span = key.0 - prev.0
                let t = span > 0 ? (p - prev.0) / span : 1
                return prev.1 + (key.1 - prev.1) * (t * t * (3 - 2 * t))
            }
            prev = key
        }
        return prev.1
    }
}

// MARK: - Секундомер

/// Тикает ровно на границе секунды от старта, чтобы не расходиться с «· m:ss» в
/// подзаголовке дозвона, который модель считает от того же момента.
private struct ClockLabel: View {
    let since: Date?

    var body: some View {
        let start = since ?? Date()
        TimelineView(.periodic(from: start, by: 1)) { context in
            // +50 мс запаса: дата перевода монотонных часов в Date неточна на миллисекунды,
            // и секунда не должна «проскакивать» назад.
            let elapsed = max(0, Int((context.date.timeIntervalSince(start) + 0.05).rounded(.down)))
            Text(formatClock(elapsed))
                .font(.system(size: 12, weight: .semibold))
                .monospacedDigit()
                .foregroundStyle(CallInk.text)
        }
    }
}

// MARK: - Гудок: столбики

/// Три янтарных столбика гаснут по очереди в такт трём нотам гудка (keyframes eb-cn-tone:
/// 0–12 % ярко, к 30 % гаснут до 0,25, дальше тускло), сдвиг 0 / 0,13 / 0,30 периода.
private struct ToneBars: View {
    let ringStartedAt: Double?
    let ringPeriodMs: Double
    let reduceMotion: Bool

    @State private var appearedAt = connectMonotonicNowMs()

    private static let offsets: [Double] = [0, 0.13, 0.3]
    private static let heights: [CGFloat] = [8, 12, 16]

    var body: some View {
        if reduceMotion {
            bars { _ in 0.7 }
        } else {
            TimelineView(.animation) { _ in
                let cycles = (connectMonotonicNowMs() - (ringStartedAt ?? appearedAt)) / max(ringPeriodMs, 1)
                bars { i in
                    let phase = cycles - Self.offsets[i]
                    let p = phase - phase.rounded(.down)
                    if p < 0.12 { return 1 }
                    if p < 0.30 { return 1 - 0.75 * cssEaseOut((p - 0.12) / 0.18) }
                    return 0.25
                }
            }
        }
    }

    private func bars(_ opacity: @escaping (Int) -> Double) -> some View {
        HStack(alignment: .bottom, spacing: 4) {
            ForEach(0..<3, id: \.self) { i in
                RoundedRectangle(cornerRadius: 2)
                    .fill(CallInk.amber)
                    .frame(width: 4, height: Self.heights[i])
                    .opacity(opacity(i))
            }
        }
        .accessibilityHidden(true)
    }
}

// MARK: - Цепочка узлов

/// Путь разговора: вы → [ретранслятор] → сервер → собеседник, узлы 52 pt с подписями и
/// участками между ними. Участок лежит на горизонтали центров кругов, а не блоков с
/// подписями.
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
        // свой минимум (22 pt, из них 12 заходят под поля соседних узлов).
        let wrap = rowWidth > 0
            ? min(80, max(Self.node + 12, (rowWidth - CGFloat(count - 1) * 10) / CGFloat(count)))
            : 80
        let side = (wrap - Self.node) / 2

        HStack(alignment: .top, spacing: 0) {
            ForEach(Array(view.nodes.enumerated()), id: \.element.id) { index, node in
                if index > 0 {
                    let previous = view.nodes[index - 1]
                    LinkView(
                        state: view.links.first(where: { $0.to == node.id })?.state ?? .ready,
                        from: CallInk.role(previous.id),
                        to: CallInk.role(node.id),
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
        .padding(.top, 10)
        .padding(.bottom, 2)
    }
}

/// Узел: круг с кольцом цвета роли, подпись под ним. На дозвоне вокруг собеседника
/// расходятся три кольца, у подключающегося — ореол и бегущая сливочная дуга.
private struct NodeView: View {
    let node: ConnectNode
    let wrap: CGFloat
    let selected: Bool
    let reduceMotion: Bool
    let ringStartedAt: Double?
    let ringPeriodMs: Double
    let onTap: () -> Void

    private static let size: CGFloat = 52

    var body: some View {
        Button(action: onTap) {
            VStack(spacing: 0) {
                ZStack {
                    if node.state == .ringing {
                        RingWaves(
                            color: CallInk.amberDeep,
                            startedAt: ringStartedAt,
                            periodMs: ringPeriodMs,
                            reduceMotion: reduceMotion
                        )
                        .frame(width: Self.size, height: Self.size)
                    }
                    if node.state == .active {
                        NodeHalo(ring: CallInk.amberDark, reduceMotion: reduceMotion)
                            .frame(width: Self.size, height: Self.size)
                        SpinningArc(color: CallInk.cream.opacity(0.95), lineWidth: 2, period: 1.1, reduceMotion: reduceMotion)
                            .frame(width: Self.size + 12, height: Self.size + 12)
                    }
                    NodeDisc(node: node, selected: selected)
                }
                .frame(width: Self.size, height: Self.size)
                .offset(y: selected ? -2 : 0)
                .animation(.easeOut(duration: 0.16), value: selected)
                Text(node.label)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(node.state == .waiting ? CallInk.textMuted : CallInk.text)
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
                        .truncationMode(.middle)
                        .padding(.top, 2)
                }
            }
            .frame(width: wrap)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(node.label): \(nodeStateTitle(node.state))")
        .accessibilityHint(node.detail)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

/// Круг узла (`.eb-cn__circle`): подложка-кольцо, содержимое (значок или аватар), рамка и
/// свечение — по состоянию. Ждёт — серая рамка и тусклый значок; подключается —
/// полупрозрачная рамка роли (ореол и дугу рисует владелец); готов — рамка роли с мягким
/// свечением; вызываем — янтарная рамка и свечение сильнее. «Вы» всегда сливочный и без
/// свечения: это не этап, а точка отсчёта.
private struct NodeDisc: View {
    let node: ConnectNode
    let selected: Bool

    private static let size: CGFloat = 52
    private static let icon: CGFloat = 22

    /// Рамка, подложка и свечение по состоянию.
    private struct Look {
        let ring: Color
        let underlay: Double
        let glow: Double
    }

    private var look: Look {
        let role = CallInk.role(node.id)
        switch node.state {
        case .waiting:
            return Look(ring: CallInk.borderStrong, underlay: 0, glow: 0)
        case .active:
            return Look(ring: role.opacity(0.7), underlay: 0.08, glow: 0)
        case .ready:
            return Look(ring: role, underlay: node.id == .you ? 0.08 : 0.1, glow: node.id == .you ? 0 : 0.28)
        case .ringing:
            return Look(ring: CallInk.amber, underlay: 0.14, glow: 0.35)
        }
    }

    var body: some View {
        let role = CallInk.role(node.id)
        let look = look
        let shadowOpacity = selected ? max(look.glow, 0.3) + 0.1 : look.glow
        ZStack {
            if look.underlay > 0 {
                Circle()
                    .fill(role.opacity(selected ? look.underlay + 0.06 : look.underlay))
                    .frame(width: Self.size + (selected ? 10 : 8), height: Self.size + (selected ? 10 : 8))
            }
            Circle()
                .fill(CallInk.surface2)
                .overlay(glyph(role: role))
                .clipShape(Circle())
                .overlay(Circle().strokeBorder(look.ring, lineWidth: 2))
                .frame(width: Self.size, height: Self.size)
                .shadow(
                    color: shadowOpacity > 0 ? role.opacity(shadowOpacity) : .clear,
                    radius: node.state == .ringing || selected ? 14 : 11
                )
        }
        .frame(width: Self.size, height: Self.size)
    }

    @ViewBuilder
    private func glyph(role: Color) -> some View {
        let waiting = node.state == .waiting
        switch node.id {
        case .you:
            symbol("person", waiting ? CallInk.textDim : role)
        case .relay:
            symbol("cloud", waiting ? CallInk.textDim : role)
        case .server:
            // Значок сервера янтарный при тёмно-янтарной рамке — как на макете.
            symbol("server.rack", waiting ? CallInk.textDim : CallInk.amber)
        case .peer:
            ConnectAvatar(node: node, size: Self.size)
                .grayscale(waiting ? 0.7 : 0)
                .opacity(waiting ? 0.55 : 1)
        }
    }

    private func symbol(_ name: String, _ tint: Color) -> some View {
        Image(systemName: name)
            .font(.system(size: Self.icon * 0.82, weight: .regular))
            .frame(width: Self.icon, height: Self.icon)
            .foregroundStyle(tint)
    }
}

/// Аватар в узле: картинка, если она есть и грузится; иначе инициалы на фирменном янтаре
/// или значок группы. Ошибка загрузки схему не ломает — остаётся запасной вариант.
private struct ConnectAvatar: View {
    let node: ConnectNode
    let size: CGFloat

    var body: some View {
        Group {
            if let resolved = resolveMediaUrl(node.avatarUrl), let url = URL(string: resolved) {
                CachedImage(url: url, contentMode: .fill) { fallback }
            } else {
                fallback
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
    }

    @ViewBuilder
    private var fallback: some View {
        if node.group {
            ZStack {
                Circle().fill(CallInk.surface2)
                Image(systemName: "person.2")
                    .font(.system(size: size * 0.36, weight: .regular))
                    .foregroundStyle(CallInk.amber)
            }
        } else {
            ZStack {
                Circle().fill(LinearGradient(
                    colors: [CallInk.amberDark, CallInk.initialsDeep],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                ))
                Text(Self.initials(node.label))
                    .font(.system(size: size * 0.36, weight: .bold))
                    .kerning(0.5)
                    .foregroundStyle(.white)
            }
        }
    }

    /// Как initialsFromName веба: первая буква первого и последнего слова.
    private static func initials(_ name: String) -> String {
        let parts = name.split(whereSeparator: { $0.isWhitespace }).filter { !$0.isEmpty }
        guard let first = parts.first else { return "?" }
        if parts.count == 1 { return first.prefix(1).uppercased() }
        return (first.prefix(1) + parts[parts.count - 1].prefix(1)).uppercased()
    }
}

// MARK: - Кольца, ореол, дуга

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
            .allowsHitTesting(false)
    }
}

/// Бегущая сливочная дуга: верхняя четверть окружности (border-top-color на вебе),
/// вращение по кругу.
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
            .allowsHitTesting(false)
    }
}

/// Участок между узлами: пунктир «ждёт», бегущий янтарный пунктир «прокладывается»,
/// градиент от цвета узла к цвету узла с бегущей сливочной точкой «проложен». Точка едет
/// ТОЛЬКО по проложенным.
private struct LinkView: View {
    let state: ConnectLinkState
    let from: Color
    let to: Color
    let reduceMotion: Bool

    var body: some View {
        switch state {
        case .idle:
            DashLine(color: CallInk.borderStrong, phase: 0)
        case .searching:
            if reduceMotion {
                DashLine(color: CallInk.amberDeep.opacity(0.85), phase: 0)
            } else {
                TimelineView(.animation(minimumInterval: 1 / 30)) { context in
                    let t = context.date.timeIntervalSinceReferenceDate
                    // Сдвиг на период штриха (12 pt) за 0,8 с — пунктир «бежит» вперёд.
                    DashLine(color: CallInk.amberDeep.opacity(0.85), phase: -CGFloat(t.truncatingRemainder(dividingBy: 0.8) / 0.8) * 12)
                }
            }
        case .ready:
            Capsule()
                .fill(LinearGradient(colors: [from, to], startPoint: .leading, endPoint: .trailing))
                .shadow(color: CallInk.amberDeep.opacity(0.25), radius: 4)
                .overlay(alignment: .leading) {
                    if !reduceMotion { Packet() }
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

/// Сливочная точка с янтарным ореолом, едущая по проложенному участку за 2,2 с, с
/// проявлением в начале и растворением в конце пути.
private struct Packet: View {
    private static let size: CGFloat = 8

    var body: some View {
        GeometryReader { geo in
            TimelineView(.animation(minimumInterval: 1 / 30)) { context in
                let t = context.date.timeIntervalSinceReferenceDate
                let progress = t.truncatingRemainder(dividingBy: 2.2) / 2.2
                let alpha = progress < 0.12
                    ? progress / 0.12
                    : (progress > 0.88 ? (1 - progress) / 0.12 : 1)
                Circle()
                    .fill(CallInk.cream)
                    .frame(width: Self.size, height: Self.size)
                    .shadow(color: CallInk.amber, radius: 5)
                    .opacity(alpha)
                    .offset(x: -Self.size / 2 + geo.size.width * progress, y: geo.size.height / 2 - Self.size / 2)
            }
        }
    }
}

// MARK: - Этап

/// Карточка этапа (`.eb-cn__step`): бейдж с номером или галочкой и подпись. Сделанный —
/// янтарный бейдж с белой галочкой; активный — янтарная карточка в диагональную полоску с
/// тёмным текстом и сливочной дугой вокруг бейджа; ждущий — приглушённый.
private struct StepCard: View {
    let step: ConnectStep
    let number: Int
    let selected: Bool
    let reduceMotion: Bool
    let onTap: () -> Void

    private static let corner: CGFloat = 12

    var body: some View {
        let active = step.status == .active
        Button(action: onTap) {
            VStack(alignment: .leading, spacing: 8) {
                badge
                Text(step.title)
                    .font(.system(size: 12, weight: active ? .semibold : .regular))
                    .lineSpacing(1)
                    .lineLimit(3)
                    .multilineTextAlignment(.leading)
                    .foregroundStyle(textColor)
            }
            .padding(10)
            .frame(maxWidth: .infinity, minHeight: 72, maxHeight: .infinity, alignment: .topLeading)
            .background(cardBackground)
            .clipShape(RoundedRectangle(cornerRadius: Self.corner))
            .overlay(RoundedRectangle(cornerRadius: Self.corner).strokeBorder(stroke, lineWidth: 1))
            .overlay {
                // box-shadow 0 0 0 1px rgba(amber, .45): тонкое кольцо снаружи рамки.
                if active {
                    RoundedRectangle(cornerRadius: Self.corner + 1)
                        .strokeBorder(CallInk.amberDeep.opacity(0.45), lineWidth: 1)
                        .padding(-1)
                }
            }
            .shadow(color: active ? CallInk.amberDeep.opacity(0.28) : .clear, radius: 7, y: 2)
            .opacity(step.status == .waiting ? 0.85 : 1)
            .contentShape(RoundedRectangle(cornerRadius: Self.corner))
        }
        .buttonStyle(.plain)
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.2), value: step.status)
        .accessibilityLabel("Этап \(number), \(step.title): \(stepStatusTitle(step.status))")
        .accessibilityHint(step.hint)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private var badge: some View {
        ZStack {
            Circle().fill(badgeFill)
            if step.status == .done {
                Image(systemName: "checkmark")
                    .font(.system(size: 11, weight: .heavy))
                    .foregroundStyle(.white)
            } else {
                Text("\(number)")
                    .font(.system(size: 12, weight: step.status == .active ? .bold : .semibold))
                    .foregroundStyle(step.status == .active ? CallInk.cream : CallInk.textMuted)
            }
            if step.status == .active {
                SpinningArc(color: CallInk.cream, lineWidth: 2, period: 1.1, reduceMotion: reduceMotion)
                    .frame(width: 32, height: 32)
            }
        }
        .frame(width: 24, height: 24)
        .accessibilityHidden(true)
    }

    @ViewBuilder
    private var cardBackground: some View {
        if step.status == .active {
            AmberStripes(highlight: selected)
        } else {
            RoundedRectangle(cornerRadius: Self.corner)
                .fill(selected ? CallInk.surface3 : CallInk.surface2)
        }
    }

    private var textColor: Color {
        switch step.status {
        case .done: return CallInk.text
        case .active: return CallInk.onAmber
        case .waiting: return CallInk.textMuted
        }
    }

    private var badgeFill: Color {
        switch step.status {
        case .done: return CallInk.amberDeep
        case .active: return CallInk.surface
        case .waiting: return CallInk.surface3
        }
    }

    private var stroke: Color {
        if step.status == .active { return selected ? CallInk.cream : CallInk.amber }
        return selected ? CallInk.borderStrong : CallInk.border
    }
}

/// Янтарная карточка в тонкую диагональную полоску, как плашки сайта: четыре слоя CSS —
/// основа под 158°, две сетки штрихов (белые под −32° через 9 pt, чёрные под 32° через
/// 13 pt) и блик сверху.
private struct AmberStripes: View {
    /// Выбранная карточка: блик чуть ярче (`.is-active.is-selected`).
    let highlight: Bool

    var body: some View {
        ZStack {
            // linear-gradient(158deg, #b45309 0%, #e38b0a 48%, #d97706 100%): направление
            // 158° по часовой от вертикали — почти вниз, чуть вправо.
            LinearGradient(
                stops: [
                    .init(color: CallInk.amberDark, location: 0),
                    .init(color: CallInk.amber, location: 0.48),
                    .init(color: CallInk.amberDeep, location: 1),
                ],
                startPoint: UnitPoint(x: 0.31, y: 0.04),
                endPoint: UnitPoint(x: 0.69, y: 0.96)
            )
            Canvas { ctx, size in
                Self.stripes(ctx, size, angle: -32, period: 9, color: .white.opacity(0.14))
                Self.stripes(ctx, size, angle: 32, period: 13, color: .black.opacity(0.05))
            }
            LinearGradient(
                stops: [
                    .init(color: .white.opacity(highlight ? 0.26 : 0.2), location: 0),
                    .init(color: .white.opacity(highlight ? 0.08 : 0.06), location: 0.55),
                    .init(color: .black.opacity(0.04), location: 1),
                ],
                startPoint: .top,
                endPoint: .bottom
            )
        }
    }

    /// repeating-linear-gradient(angle, transparent 0 period−1, color period−1 period):
    /// штрих шириной 1 pt в конце каждого периода, перпендикулярно направлению градиента.
    private static func stripes(_ ctx: GraphicsContext, _ size: CGSize, angle: Double, period: CGFloat, color: Color) {
        let rad = angle * .pi / 180
        // Направление градиента CSS: угол от вертикали по часовой стрелке.
        let n = CGPoint(x: sin(rad), y: -cos(rad))
        // Сам штрих идёт поперёк направления.
        let d = CGPoint(x: -n.y, y: n.x)
        let corners = [CGPoint.zero, CGPoint(x: size.width, y: 0), CGPoint(x: 0, y: size.height), CGPoint(x: size.width, y: size.height)]
        let projections = corners.map { $0.x * n.x + $0.y * n.y }
        guard let tMin = projections.min(), let tMax = projections.max() else { return }
        let reach = hypot(size.width, size.height)
        var path = Path()
        var k = (tMin / period).rounded(.down)
        while k * period <= tMax + period {
            let t = k * period + period - 0.5
            let origin = CGPoint(x: n.x * t, y: n.y * t)
            path.move(to: CGPoint(x: origin.x - d.x * reach, y: origin.y - d.y * reach))
            path.addLine(to: CGPoint(x: origin.x + d.x * reach, y: origin.y + d.y * reach))
            k += 1
        }
        ctx.stroke(path, with: .color(color), lineWidth: 1)
    }
}

// MARK: - Строки с переносом

/// Капсулы фактов: в ряд, с переносом на следующую строку (flex-wrap веба).
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
