import SwiftUI

// «Центр управления» на iOS — компоненты единого вида (SPEC §3): карточка, строка, итог у строки,
// кнопки, тумблер, сегменты, плитки-выбор, пунктирная пометка, ebox, вопрос на месте, панель
// сохранения. Цвета — только токены `Eb.*`; кегли с `relativeTo:` растут с Dynamic Type.
// Тумблер и сегменты СВОИ: системный Toggle рисует выключенное состояние почти невидимым на
// тёмной плитке (inventory-android), а белый бегунок на янтаре даёт 3,2:1.

// MARK: - Шрифт

private struct EbFontModifier: ViewModifier {
    @ScaledMetric private var size: CGFloat
    private let weight: Font.Weight
    private let design: Font.Design
    private let digits: Bool

    init(size: CGFloat, weight: Font.Weight, relativeTo style: Font.TextStyle, design: Font.Design, digits: Bool) {
        _size = ScaledMetric(wrappedValue: size, relativeTo: style)
        self.weight = weight
        self.design = design
        self.digits = digits
    }

    func body(content: Content) -> some View {
        let font = Font.system(size: size, weight: weight, design: design)
        content.font(digits ? font.monospacedDigit() : font)
    }
}

extension View {
    /// Кегль из SPEC §3.3, масштабируемый Dynamic Type. `digits` — табличные цифры (версии,
    /// счётчики, время); `mono` — для адресов.
    func ebFont(
        _ size: CGFloat, _ weight: Font.Weight = .regular, relativeTo style: Font.TextStyle = .body,
        mono: Bool = false, digits: Bool = false
    ) -> some View {
        modifier(EbFontModifier(
            size: size, weight: weight, relativeTo: style, design: mono ? .monospaced : .default, digits: digits
        ))
    }
}

// MARK: - Поиск в окружении: подсветка и бледнение строк

struct SettingsSearchEnv: Equatable {
    var query = ""
    /// id строк, подходящих под запрос.
    var matched: Set<String> = []
    /// Строка, на которую только что прыгнули из выдачи: вспышка 1,4 с.
    var flashID: String?

    var isActive: Bool { SettingsSearch.isActive(query) }
}

private struct SettingsSearchEnvKey: EnvironmentKey {
    static let defaultValue = SettingsSearchEnv()
}

extension EnvironmentValues {
    var settingsSearch: SettingsSearchEnv {
        get { self[SettingsSearchEnvKey.self] }
        set { self[SettingsSearchEnvKey.self] = newValue }
    }
}

// MARK: - Значок

struct EbIcon: View {
    let name: String
    var size: CGFloat = 15
    var color: Color = Eb.brand600
    var weight: Font.Weight = .regular

    var body: some View {
        Image(systemName: name)
            .font(.system(size: size, weight: weight))
            .foregroundStyle(color)
            .accessibilityHidden(true)
    }
}

// MARK: - Кнопки

enum EbButtonKind { case normal, primary, ghost, danger, dangerText }

struct EbButtonStyle: ButtonStyle {
    var kind: EbButtonKind = .normal
    var small = false
    var fullWidth = false
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        let h: CGFloat = small ? 32 : 38
        let r: CGFloat = small ? 10 : 11
        let pressed = configuration.isPressed
        configuration.label
            .ebFont(small ? 13.5 : 14, kind == .primary ? .bold : .semibold)
            .foregroundStyle(textColor(pressed: pressed))
            .padding(.horizontal, small ? 12 : 15)
            .frame(minHeight: h)
            .frame(maxWidth: fullWidth ? .infinity : nil)
            .background { background(radius: r, pressed: pressed) }
            .overlay { border(radius: r) }
            .overlay { if kind == .primary { RoundedRectangle(cornerRadius: r + 2, style: .continuous).stroke(Eb.brand.opacity(0.45), lineWidth: 1).padding(-2) } }
            .scaleEffect(pressed && !reduceMotion ? 0.975 : 1)
            .opacity(isEnabled ? 1 : (kind == .primary ? 0.7 : 0.45))
            // Невидимое расширение зоны нажатия до 44 pt у малых кнопок.
            .contentShape(.interaction, RoundedRectangle(cornerRadius: r, style: .continuous).inset(by: small ? -6 : -3))
            .animation(.easeOut(duration: 0.12), value: pressed)
    }

    private func textColor(pressed: Bool) -> Color {
        switch kind {
        case .normal: return Eb.textPrimary
        case .primary: return Eb.ink
        case .ghost: return pressed ? Eb.textPrimary : Eb.textMuted
        case .danger: return .white
        case .dangerText: return pressed ? .white : Eb.dangerSoft
        }
    }

    @ViewBuilder
    private func background(radius r: CGFloat, pressed: Bool) -> some View {
        switch kind {
        case .normal:
            RoundedRectangle(cornerRadius: r, style: .continuous).fill(Eb.surface100)
                .overlay(RoundedRectangle(cornerRadius: r, style: .continuous).fill(.white.opacity(pressed ? 0.07 : 0)))
        case .primary:
            AmberStripe(cornerRadius: r)
        case .ghost:
            RoundedRectangle(cornerRadius: r, style: .continuous).fill(.white.opacity(pressed ? 0.07 : 0))
        case .danger:
            RoundedRectangle(cornerRadius: r, style: .continuous).fill(pressed ? Eb.dangerHover : Eb.danger)
        case .dangerText:
            RoundedRectangle(cornerRadius: r, style: .continuous).fill(Eb.danger.opacity(pressed ? 0.30 : 0))
        }
    }

    @ViewBuilder
    private func border(radius r: CGFloat) -> some View {
        switch kind {
        case .normal: RoundedRectangle(cornerRadius: r, style: .continuous).strokeBorder(Eb.borderStrong, lineWidth: 1)
        case .primary: RoundedRectangle(cornerRadius: r, style: .continuous).strokeBorder(Eb.brand600, lineWidth: 1)
        default: EmptyView()
        }
    }
}

extension ButtonStyle where Self == EbButtonStyle {
    static func eb(_ kind: EbButtonKind = .normal, small: Bool = false, fullWidth: Bool = false) -> EbButtonStyle {
        EbButtonStyle(kind: kind, small: small, fullWidth: fullWidth)
    }
}

/// Подпись кнопки: значок слева, текст справа.
struct EbButtonLabel: View {
    let title: String
    var symbol: String?
    var spinner = false

    var body: some View {
        HStack(spacing: 8) {
            if spinner {
                ProgressView().controlSize(.small).tint(Eb.ink)
            } else if let symbol {
                Image(systemName: symbol).font(.system(size: 15, weight: .medium))
            }
            Text(title).lineLimit(1).minimumScaleFactor(0.8)
        }
    }
}

// MARK: - Тумблер

struct EbSwitchVisual: View {
    let isOn: Bool
    var small = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let w: CGFloat = small ? 38 : 42
        let h: CGFloat = small ? 22 : 24
        let thumb: CGFloat = small ? 16 : 18
        ZStack(alignment: .leading) {
            Capsule().fill(Eb.surface300)
            AmberStripe(cornerRadius: h / 2).opacity(isOn ? 1 : 0)
            Capsule().strokeBorder(isOn ? Eb.brand600 : Eb.borderStrong, lineWidth: 1)
            Circle()
                .fill(isOn ? Eb.logoCream : Eb.textMuted)
                .frame(width: thumb, height: thumb)
                .padding(.leading, 3)
                .offset(x: isOn ? (w - thumb - 6) : 0)
        }
        .frame(width: w, height: h)
        .background(Capsule().fill(Eb.brand.opacity(isOn ? 0.12 : 0)).padding(-3))
        .animation(reduceMotion ? nil : .spring(response: 0.28, dampingFraction: 0.62), value: isOn)
        .accessibilityHidden(true)
    }
}

// MARK: - Текст строки

/// Название, пояснение, второй абзац — с подсветкой найденного слова.
struct EbRowText: View {
    let title: String
    var desc: String?
    var desc2: String?
    @Environment(\.settingsSearch) private var search

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(SettingsSearch.highlighted(title, query: search.query))
                .ebFont(15, .semibold)
                .foregroundStyle(Eb.textPrimary)
                .lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)
            if let desc {
                Text(SettingsSearch.highlighted(desc, query: search.query))
                    .ebFont(13.5)
                    .foregroundStyle(Eb.textMuted)
                    .lineSpacing(3.5)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 3)
            }
            if let desc2 {
                Text(SettingsSearch.highlighted(desc2, query: search.query))
                    .ebFont(13.5)
                    .foregroundStyle(Eb.textDim)
                    .lineSpacing(3.5)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 6)
            }
        }
    }
}

// MARK: - Итог у строки

struct EbMsgView: View {
    let msg: RowMessage

    var body: some View {
        HStack(alignment: .top, spacing: 9) {
            switch msg.kind {
            case .ok: EbIcon(name: "checkmark", size: 15, color: Eb.brand600, weight: .semibold)
            case .busy: ProgressView().controlSize(.small).tint(Eb.logoCream).frame(width: 17, height: 17)
            case .err: EbIcon(name: "exclamationmark.circle", size: 17, color: Eb.danger)
            case .note: EbIcon(name: "info.circle", size: 17, color: Eb.brand600)
            case .lock: EbIcon(name: "lock", size: 15, color: Eb.textMuted)
            case .dim: EmptyView()
            }
            Text(msg.text)
                .ebFont(14)
                .foregroundStyle(color)
                .lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.top, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .onAppear { announce() }
        .onChange(of: msg) { _, _ in announce() }
    }

    private var color: Color {
        switch msg.kind {
        case .ok: return Eb.textPrimary
        case .busy: return Eb.logoCream
        case .err: return Eb.dangerText
        case .note, .lock: return Eb.textMuted
        case .dim: return Eb.textDim
        }
    }

    /// Живая область: объявляем только новый текст. Ошибки — настойчиво, остальное — вежливо;
    /// тихие итоги (`dim`) не объявляются.
    private func announce() {
        guard msg.kind != .dim else { return }
        var text = AttributedString(msg.text)
        text.accessibilitySpeechAnnouncementPriority = msg.kind == .err ? .high : .low
        AccessibilityNotification.Announcement(text).post()
    }
}

// MARK: - Строка и карточка

/// Строка единого вида: поля 16,14, мин. высота 56, состояние (ошибка / совпадение / бледнее
/// при поиске / заперта) красит фон и полосу 3 слева.
struct EbRow<Content: View>: View {
    let id: String
    var isError = false
    var isLocked = false
    /// Якорь для прокрутки; у нескольких строк одного `id` (сеансы) — свой, чтобы не двоился.
    var anchorID: String?
    @ViewBuilder var content: Content
    @Environment(\.settingsSearch) private var search

    private var isMatch: Bool { search.isActive && search.matched.contains(id) }
    private var isDimmed: Bool { search.isActive && !search.matched.contains(id) }
    private var isFlashing: Bool { search.flashID == id }

    var body: some View {
        content
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .frame(minHeight: 56)
            .background {
                if isError {
                    Eb.danger.opacity(0.06)
                } else if isMatch {
                    Eb.brand.opacity(0.07)
                }
            }
            .overlay(alignment: .leading) {
                if isError {
                    Rectangle().fill(Eb.danger).frame(width: 3)
                } else if isMatch {
                    Rectangle().fill(Eb.brand600).frame(width: 3)
                }
            }
            .overlay {
                Eb.brand600.opacity(isFlashing ? 0.22 : 0)
                    .allowsHitTesting(false)
                    .animation(isFlashing ? nil : .easeOut(duration: 1.4), value: isFlashing)
            }
            .opacity(isLocked ? 0.45 : (isDimmed ? 0.42 : 1))
            .disabled(isLocked)
            // Якорь прокрутки отдаём карточке: строки внутри `Group(subviews:)` ScrollViewReader сам
            // не видит, а `.id` на подпредставлении снаружи — видит.
            .containerValue(\.rowAnchor, anchorID ?? ("row-" + id))
    }
}

extension ContainerValues {
    /// Якорь строки для `ScrollViewProxy.scrollTo` (см. EbCard).
    @Entry var rowAnchor: String? = nil
}

/// Карточка строк: #232731, рамка #313643, радиус 14, линия между строками.
struct EbCard<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        VStack(spacing: 0) {
            Group(subviews: content) { subviews in
                ForEach(subviews.indices, id: \.self) { index in
                    if index > 0 { Rectangle().fill(Eb.border).frame(height: 1) }
                    if let anchor = subviews[index].containerValues.rowAnchor {
                        subviews[index].id(anchor)
                    } else {
                        subviews[index]
                    }
                }
            }
        }
        .frame(maxWidth: .infinity)
        .background(Eb.surface200)
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Eb.border, lineWidth: 1))
    }
}

/// Строка-тумблер: вся строка — один переключатель; имя для диктора — название, подсказка —
/// пояснение. Итог у строки лежит ВНЕ кнопки, чтобы читаться отдельным элементом.
struct EbToggleRow: View {
    let id: String
    let title: String
    var desc: String?
    @Binding var isOn: Bool
    var disabled = false
    var isError = false
    var message: RowMessage?
    var leading: AnyView?
    var extra: AnyView?

    var body: some View {
        EbRow(id: id, isError: isError) {
            VStack(alignment: .leading, spacing: 0) {
                Button { isOn.toggle() } label: {
                    HStack(alignment: .top, spacing: 16) {
                        if let leading { leading }
                        EbRowText(title: title, desc: desc).frame(maxWidth: .infinity, alignment: .leading)
                        EbSwitchVisual(isOn: isOn).padding(.top, 1)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(disabled)
                .opacity(disabled ? 0.45 : 1)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(title)
                .accessibilityHint(desc ?? "")
                .accessibilityValue(isOn ? "Включено" : "Выключено")
                .accessibilityAddTraits(.isToggle)
                if let extra { extra.padding(.top, 10) }
                if let message { EbMsgView(msg: message).transition(.opacity.combined(with: .offset(y: -3))) }
            }
            .animation(.easeOut(duration: 0.22), value: message)
        }
    }
}

// MARK: - Заголовки

/// Голова раздела: квадрат 40, заголовок 22/28 Bold (−0.4), подзаголовок 13.5.
struct EbSectionHead: View {
    let section: SettingsSectionID
    @Environment(\.settingsSearch) private var search

    var body: some View {
        HStack(alignment: .center, spacing: 14) {
            EbIconSquare(symbol: section.symbol, side: 40, icon: 18)
            VStack(alignment: .leading, spacing: 2) {
                Text(SettingsSearch.highlighted(section.title, query: search.query))
                    .ebFont(22, .bold, relativeTo: .title2)
                    .tracking(-0.4)
                    .foregroundStyle(Eb.textPrimary)
                    .accessibilityAddTraits(.isHeader)
                    .accessibilityHeading(.h2)
                Text(SettingsSearch.highlighted(section.subtitle, query: search.query))
                    .ebFont(13.5)
                    .foregroundStyle(Eb.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
    }
}

/// Квадрат-значок: янтарный тон 10 % и рамка 28 %.
struct EbIconSquare: View {
    let symbol: String
    var side: CGFloat = 32
    var icon: CGFloat = 15
    var radius: CGFloat?

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: radius ?? (side >= 40 ? 11 : 9), style: .continuous)
                .fill(Eb.brand600.opacity(0.10))
            RoundedRectangle(cornerRadius: radius ?? (side >= 40 ? 11 : 9), style: .continuous)
                .strokeBorder(Eb.brand600.opacity(0.28), lineWidth: 1)
            Image(systemName: symbol)
                .font(.system(size: icon, weight: .regular))
                .foregroundStyle(Eb.brand600)
        }
        .frame(width: side, height: side)
        .accessibilityHidden(true)
    }
}

/// Голова группы: значок 15 янтарём и заголовок 13.5 Bold сливками (заголовок уровня 3),
/// пометка 13 Muted, справа — действие.
struct EbGroupHeader<Trailing: View>: View {
    let symbol: String
    let title: String
    var mark: String?
    @ViewBuilder var trailing: Trailing
    @Environment(\.settingsSearch) private var search

    var body: some View {
        HStack(spacing: 8) {
            EbIcon(name: symbol, size: 15)
            Text(SettingsSearch.highlighted(title, query: search.query))
                .ebFont(13.5, .bold, relativeTo: .subheadline)
                .foregroundStyle(Eb.logoCream)
                .accessibilityAddTraits(.isHeader)
                .accessibilityHeading(.h3)
            if let mark {
                Text(mark).ebFont(13, digits: true).foregroundStyle(Eb.textMuted)
            }
            Spacer(minLength: 8)
            trailing
        }
        .frame(minHeight: 28)
        .padding(.horizontal, 2)
        .padding(.bottom, 8)
    }
}

extension EbGroupHeader where Trailing == EmptyView {
    init(symbol: String, title: String, mark: String? = nil) {
        self.init(symbol: symbol, title: title, mark: mark, trailing: { EmptyView() })
    }
}

/// Подпись группы: 14 Muted под головой.
struct EbGroupCaption: View {
    let text: String
    var body: some View {
        Text(text)
            .ebFont(14)
            .foregroundStyle(Eb.textMuted)
            .lineSpacing(3.5)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 2)
            .padding(.bottom, 8)
    }
}

/// Мелкий текст под карточкой: 13/19 #6B7280. Несущих смысл слов в нём не бывает.
struct EbSmallPrint: View {
    let text: String
    var body: some View {
        Text(text)
            .ebFont(13)
            .foregroundStyle(Eb.textDim)
            .lineSpacing(3)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 4)
            .padding(.top, 10)
    }
}

// MARK: - Капсулы

struct EbCapsule<Content: View>: View {
    var height: CGFloat = 30
    var horizontal: CGFloat = 12
    var tint: Color?
    @ViewBuilder var content: Content

    var body: some View {
        HStack(spacing: 6) { content }
            .padding(.horizontal, horizontal)
            .frame(minHeight: height)
            .background(Capsule().fill(Eb.surface100))
            .overlay(Capsule().strokeBorder(tint ?? Eb.borderStrong, lineWidth: 1))
    }
}

/// «EBLID 2498» — число жирным и светлее.
struct EbEblidCapsule: View {
    let eblid: String?
    var height: CGFloat = 30

    var body: some View {
        EbCapsule(height: height) {
            Text("EBLID").ebFont(12.5).foregroundStyle(Eb.textMuted).lineLimit(1).fixedSize()
            Text(eblid ?? "— — — —").ebFont(12.5, .bold, digits: true).foregroundStyle(Eb.textPrimary).lineLimit(1).fixedSize()
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(eblid.map { "EBLID \($0)" } ?? "EBLID не назначен")
    }
}

// MARK: - Пометка пунктиром, ebox, вопрос на месте

struct EbDashedNote: View {
    let text: String
    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            EbIcon(name: "info.circle", size: 17)
            Text(text).ebFont(14).foregroundStyle(Eb.textMuted).lineSpacing(3).fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
        .background(RoundedRectangle(cornerRadius: 11, style: .continuous).fill(Eb.brand.opacity(0.07)))
        .overlay(
            RoundedRectangle(cornerRadius: 11, style: .continuous)
                .strokeBorder(Eb.brand.opacity(0.45), style: StrokeStyle(lineWidth: 1, dash: [4, 3]))
        )
    }
}

/// Беда, которую надо заметить: красная рамка, текст #FECACA, «Повторить».
struct EbEbox: View {
    let text: String
    var retryTitle = "Повторить"
    var onRetry: (() -> Void)?

    var body: some View {
        VStack(spacing: 10) {
            HStack(alignment: .top, spacing: 9) {
                EbIcon(name: "exclamationmark.circle", size: 17, color: Eb.danger)
                Text(text).ebFont(14).foregroundStyle(Eb.dangerText).lineSpacing(3).fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
            if let onRetry {
                Button(action: onRetry) { EbButtonLabel(title: retryTitle, symbol: "arrow.clockwise") }
                    .buttonStyle(.eb(.normal, small: true))
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
        .background(RoundedRectangle(cornerRadius: 11, style: .continuous).fill(Eb.danger.opacity(0.08)))
        .overlay(RoundedRectangle(cornerRadius: 11, style: .continuous).strokeBorder(Eb.danger.opacity(0.5), lineWidth: 1))
        .accessibilityElement(children: .combine)
        .onAppear {
            var t = AttributedString(text)
            t.accessibilitySpeechAnnouncementPriority = .high
            AccessibilityNotification.Announcement(t).post()
        }
    }
}

/// Вопрос на месте: жирный вопрос, пояснение, [Отмена] и красное подтверждение. Системные
/// AlertDialog / confirmationDialog не используются — вид один на всех (SPEC §3.11).
struct EbAsk: View {
    let question: String
    let detail: String
    var cancelTitle = "Отмена"
    let confirmTitle: String
    var confirmSymbol = "xmark"
    var onCancel: () -> Void
    var onConfirm: () -> Void
    @State private var appeared = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            (Text(question).fontWeight(.bold).foregroundStyle(Eb.textPrimary)
             + Text(" ") + Text(detail).foregroundStyle(Eb.textMuted))
                .ebFont(14)
                .lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 8) {
                Spacer(minLength: 0)
                Button(action: onCancel) { Text(cancelTitle) }
                    .buttonStyle(.eb(.normal, small: true))
                Button(action: onConfirm) { EbButtonLabel(title: confirmTitle, symbol: confirmSymbol) }
                    .buttonStyle(.eb(.danger, small: true))
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Eb.danger.opacity(0.08)))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Eb.danger.opacity(0.5), lineWidth: 1))
        .opacity(appeared ? 1 : 0)
        .offset(y: appeared ? 0 : -3)
        .onAppear { withAnimation(.easeOut(duration: 0.22)) { appeared = true } }
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(.isModal)
    }
}

// MARK: - Поля ввода

/// Поле 40 высотой: радиус 10, #141820, рамка #3B414F; в фокусе и при правке — янтарная рамка,
/// без системной подчёркивающей полоски.
struct EbField: View {
    let placeholder: String
    @Binding var text: String
    var multiline = false
    var edited = false
    var isError = false
    var submitLabel: SubmitLabel = .done
    var accessibilityName: String
    @FocusState private var focused: Bool

    var body: some View {
        Group {
            if multiline {
                TextField("", text: $text, prompt: Text(placeholder).foregroundStyle(Eb.textDim), axis: .vertical)
                    .lineLimit(2...5)
            } else {
                TextField("", text: $text, prompt: Text(placeholder).foregroundStyle(Eb.textDim))
                    .submitLabel(submitLabel)
            }
        }
        .focused($focused)
        .ebFont(15)
        .foregroundStyle(Eb.textPrimary)
        .tint(Eb.brand600)
        .padding(.horizontal, 12)
        .padding(.vertical, multiline ? 10 : 0)
        .frame(minHeight: 40)
        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Eb.field))
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(isError ? Eb.danger.opacity(0.6) : ((focused || edited) ? Eb.brand600 : Eb.borderStrong), lineWidth: 1)
        )
        .contentShape(Rectangle())
        .onTapGesture { focused = true }
        .accessibilityLabel(accessibilityName)
    }
}

// MARK: - Сегменты и плитки-выбор

struct EbSegments<Value: Hashable>: View {
    let options: [(value: Value, title: String)]
    let selection: Value
    var disabled = false
    var accessibilityName: String
    let onSelect: (Value) -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: 3) {
            ForEach(options.indices, id: \.self) { index in
                let option = options[index]
                let selected = option.value == selection
                Button { onSelect(option.value) } label: {
                    Text(option.title)
                        .ebFont(13.5, selected ? .bold : .semibold)
                        .foregroundStyle(selected ? Eb.ink : Eb.textMuted)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                        .frame(maxWidth: .infinity, minHeight: 34)
                        .background {
                            if selected {
                                AmberStripe(cornerRadius: 9)
                                    .overlay(RoundedRectangle(cornerRadius: 9, style: .continuous).strokeBorder(Eb.brand600, lineWidth: 1))
                            }
                        }
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(option.title)
                .accessibilityAddTraits(selected ? .isSelected : [])
            }
        }
        .padding(3)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Eb.field))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Eb.borderStrong, lineWidth: 1))
        .opacity(disabled ? 0.45 : 1)
        .disabled(disabled)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.2), value: selection)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(accessibilityName)
    }
}

/// Плитки-выбор 2 × N: «Показывать меня». Выбранная — янтарь в полоску, точка цвета статуса.
struct EbChoiceTiles: View {
    let options: [SettingsText.StatusOption]
    let selection: String
    var accessibilityName: String
    let onSelect: (String) -> Void

    var body: some View {
        LazyVGrid(columns: [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)], spacing: 8) {
            ForEach(options, id: \.value) { option in
                let selected = option.value == selection
                Button { onSelect(option.value) } label: {
                    HStack(spacing: 9) {
                        Circle()
                            .fill(option.color)
                            .frame(width: 9, height: 9)
                            .overlay(Circle().strokeBorder(selected ? Eb.ink.opacity(0.35) : .clear, lineWidth: 1))
                        Text(option.label)
                            .ebFont(14, selected ? .bold : .semibold)
                            .foregroundStyle(selected ? Eb.ink : Eb.textPrimary)
                            .lineLimit(1)
                            .minimumScaleFactor(0.8)
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 12)
                    .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
                    .background {
                        if selected {
                            AmberStripe(cornerRadius: 12)
                                .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Eb.brand600, lineWidth: 1))
                        } else {
                            RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Eb.surface100)
                                .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Eb.borderStrong, lineWidth: 1))
                        }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(option.label)
                .accessibilityAddTraits(selected ? .isSelected : [])
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(accessibilityName)
    }
}

// MARK: - Панель сохранения

enum SaveBarState: Equatable {
    case hidden
    case dirty(detail: String)
    case saving
    case failed
    case saved
}

/// Панель сохранения (REF §8.1). На телефоне не прокручивается: прижата к низу над полосой
/// «домой» и клавиатурой, скругление сверху 16.
struct EbSaveBar: View {
    let state: SaveBarState
    let onDiscard: () -> Void
    let onSave: () -> Void

    var body: some View {
        if state != .hidden {
            content
                .padding(.horizontal, 16)
                .padding(.top, 12)
                .padding(.bottom, 12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(
                    UnevenRoundedRectangle(topLeadingRadius: 16, topTrailingRadius: 16, style: .continuous)
                        .fill(fill)
                        .ignoresSafeArea(edges: .bottom)
                )
                .overlay(alignment: .top) {
                    UnevenRoundedRectangle(topLeadingRadius: 16, topTrailingRadius: 16, style: .continuous)
                        .strokeBorder(stroke, lineWidth: 1)
                }
                .transition(.move(edge: .bottom).combined(with: .opacity))
                .accessibilityElement(children: .contain)
                .accessibilityLabel("Несохранённые изменения")
        }
    }

    private var fill: Color {
        switch state {
        case .dirty, .saving: return Color(hex: 0x262119)
        case .failed: return Color(hex: 0x2A1C1D)
        default: return Eb.surface200
        }
    }

    private var stroke: Color {
        switch state {
        case .dirty, .saving: return Eb.brand600
        case .failed: return Eb.danger.opacity(0.7)
        default: return Eb.borderStrong
        }
    }

    @ViewBuilder
    private var content: some View {
        switch state {
        case .hidden:
            EmptyView()
        case .dirty(let detail):
            VStack(alignment: .leading, spacing: 10) {
                head(symbol: "pencil", symbolColor: Eb.brand600, title: "Есть несохранённые изменения", titleColor: Eb.logoCream, detail: detail)
                HStack(spacing: 10) {
                    Spacer(minLength: 0)
                    Button("Не сохранять", action: onDiscard).buttonStyle(.eb(.ghost, small: true))
                    Button(action: onSave) { EbButtonLabel(title: "Сохранить", symbol: "checkmark") }
                        .buttonStyle(.eb(.primary, small: true))
                }
            }
        case .saving:
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 10) {
                    ProgressView().controlSize(.small).tint(Eb.logoCream)
                    Text("Сохраняем…").ebFont(14, .semibold).foregroundStyle(Eb.logoCream)
                    Spacer(minLength: 0)
                    Button("Не сохранять", action: {}).buttonStyle(.eb(.ghost, small: true)).disabled(true)
                    Button(action: {}) { EbButtonLabel(title: "Сохраняем…", spinner: true) }
                        .buttonStyle(.eb(.primary, small: true)).disabled(true)
                }
            }
        case .failed:
            VStack(alignment: .leading, spacing: 10) {
                head(symbol: "exclamationmark.circle", symbolColor: Eb.danger, title: "Не удалось сохранить изменения", titleColor: Eb.dangerText,
                     detail: "Попробуйте ещё раз — изменения не потеряны.")
                HStack(spacing: 10) {
                    Spacer(minLength: 0)
                    Button("Не сохранять", action: onDiscard).buttonStyle(.eb(.ghost, small: true))
                    Button(action: onSave) { EbButtonLabel(title: "Повторить", symbol: "arrow.clockwise") }
                        .buttonStyle(.eb(.primary, small: true))
                }
            }
        case .saved:
            HStack(spacing: 10) {
                EbIcon(name: "checkmark", size: 16, color: Eb.brand600, weight: .semibold)
                Text("Изменения сохранены.").ebFont(14, .semibold).foregroundStyle(Eb.textPrimary)
                Spacer(minLength: 0)
            }
        }
    }

    private func head(symbol: String, symbolColor: Color, title: String, titleColor: Color, detail: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            EbIcon(name: symbol, size: 18, color: symbolColor).padding(.top, 1)
            VStack(alignment: .leading, spacing: 1) {
                Text(title).ebFont(14, .semibold).foregroundStyle(titleColor)
                Text(detail).ebFont(12.5).foregroundStyle(Eb.textMuted).fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
    }
}

/// Какое пояснение у панели: что именно уйдёт одним запросом.
func saveBarDetail(nameChanged: Bool, bioChanged: Bool) -> String {
    switch (nameChanged, bioChanged) {
    case (true, true): return "Новые имя и «О себе» уйдут одним запросом."
    case (false, true): return "Новое «О себе» уйдёт одним запросом."
    default: return "Новое имя уйдёт одним запросом."
    }
}

/// Подпись, нарисованная как малая обычная кнопка: для PhotosPicker, который не берёт наш ButtonStyle.
struct EbPillLabel: View {
    let title: String
    var symbol: String?

    var body: some View {
        HStack(spacing: 8) {
            if let symbol { Image(systemName: symbol).font(.system(size: 15, weight: .medium)) }
            Text(title).lineLimit(1).minimumScaleFactor(0.8)
        }
        .ebFont(13.5, .semibold)
        .foregroundStyle(Eb.textPrimary)
        .padding(.horizontal, 12)
        .frame(minHeight: 32)
        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Eb.surface100))
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Eb.borderStrong, lineWidth: 1))
        .contentShape(.interaction, RoundedRectangle(cornerRadius: 10, style: .continuous).inset(by: -6))
    }
}
