import SwiftUI

// Карточка таймера обещания (SPEC.md §10, эталон — mock.html):
//
//  ▌ ⏱ ТАЙМЕР                                    попросил Рома
//  ▌ (кольцо+ава)  Козёл Ебаный
//  ▌               «15мин»
//  ▌               обещал в 14:00 · по местному 18:15 [продлевал 1 раз]
//  ▌   12:47                                       до 14:15
//  ▌   осталось                                    15 мин
//  ▌ [ ✓ Пришёл ]  [ Отменить ]
//
// Всё, что зависит от времени, считает PromiseRules от `deadlineAt − now`; секунды тикает общий
// секундный тикер (CardClock), и только пока карточка на экране и её надо тикать.

struct PromiseCardView: View {
    let card: BotCard
    let data: PromiseCardData
    let context: BotCardContext
    /// Общий секундный тикер: смена `now` перерисовывает видимые карточки.
    @ObservedObject var ticker: CardTicker

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var token = UUID().uuidString
    @State private var subscribed = false

    var body: some View {
        let now = CardClock.shared.now()
        let display = PromiseRules.display(
            card: card, data: data, viewerId: context.viewerId, now: now, names: context.names
        )
        let ticking = Self.needsTicking(card: card, viewer: context.viewerId, now: now)

        VStack(alignment: .leading, spacing: 0) {
            header(display)
            who(display)
            clock(display)
            actions(display)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(display.accessibilityLabel)
        .onAppear { setTicking(ticking) }
        .onDisappear { setTicking(false) }
        .onChange(of: ticking) { _, value in setTicking(value) }
        .onChange(of: display.view) { old, new in
            CardAnnouncer.announce(PromiseRules.announcement(from: old, to: new, data: data, name: display.name))
        }
    }

    /// Тикать нужно, пока таймер идёт, и пока у зрителя есть действие со сроком («Вернуть»).
    /// Закрытые карточки не тикают вовсе.
    static func needsTicking(card: BotCard, viewer: String?, now: Date) -> Bool {
        if card.state == "running" { return true }
        return card.actions.contains { action in
            guard let until = action.until else { return false }
            return until > now && action.allows(viewer)
        }
    }

    private func setTicking(_ on: Bool) {
        guard on != subscribed else { return }
        subscribed = on
        if on { ticker.subscribe(token) } else { ticker.unsubscribe(token) }
    }

    // MARK: Шапка

    private func header(_ d: PromiseDisplay) -> some View {
        HStack(spacing: 8) {
            CardTag(icon: "timer", title: "ТАЙМЕР")
            Spacer(minLength: 4)
            if let requester = d.requesterLine {
                Text(requester)
                    .font(.system(size: 12))
                    .foregroundStyle(Eb.textMuted)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
        }
        .padding(.bottom, 8)
    }

    // MARK: Кто обещал

    private func who(_ d: PromiseDisplay) -> some View {
        HStack(alignment: .center, spacing: 12) {
            PromiseRing(
                view: d.view, progress: d.progress, reduceMotion: reduceMotion,
                name: d.name, avatarUrl: context.promiserAvatarUrl ?? data.promiser.avatarUrl
            )
            VStack(alignment: .leading, spacing: 1) {
                Text(d.name)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(Eb.textPrimary)
                    .lineLimit(1)
                if !d.quote.isEmpty {
                    Text(d.quote)
                        .font(.system(size: 14).italic())
                        .foregroundStyle(CardPalette.quote)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                }
                subLine(d)
            }
            Spacer(minLength: 0)
        }
    }

    /// «обещал в 14:00 · по местному 18:15 [продлевал 1 раз]» — переносится, если не влезает.
    @ViewBuilder
    private func subLine(_ d: PromiseDisplay) -> some View {
        let text = [d.promisedAt, d.localTime].compactMap { $0 }.joined(separator: " · ")
        if !text.isEmpty || d.extensionsChip != nil {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 6) {
                    subText(text)
                    extensionsChip(d.extensionsChip)
                }
                VStack(alignment: .leading, spacing: 3) {
                    subText(text)
                    extensionsChip(d.extensionsChip)
                }
            }
        }
    }

    @ViewBuilder
    private func subText(_ text: String) -> some View {
        if !text.isEmpty {
            Text(text)
                .font(.system(size: 12))
                .foregroundStyle(Eb.textMuted)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    @ViewBuilder
    private func extensionsChip(_ text: String?) -> some View {
        if let text {
            Text(text)
                .font(.system(size: 11, weight: .bold))
                .foregroundStyle(CardPalette.tag)
                .lineLimit(1)
                .padding(.horizontal, 7)
                .padding(.vertical, 1)
                .background(CardPalette.tagBackground, in: Capsule())
        }
    }

    // MARK: Часы

    @ViewBuilder
    private func clock(_ d: PromiseDisplay) -> some View {
        // Узко (пузырь < 300): «до 14:15» уходит строкой под цифры (SPEC.md §10.1). Иначе — справа,
        // а длинные подписи итога переносятся в левой колонке, как в макете.
        if context.width + 27 < 300 {
            VStack(alignment: .leading, spacing: 4) {
                clockLeft(d)
                clockRight(d, alignment: .leading)
            }
            .padding(.top, 10)
        } else {
            HStack(alignment: .bottom, spacing: 12) {
                clockLeft(d)
                    .layoutPriority(0)
                Spacer(minLength: 0)
                clockRight(d, alignment: .trailing)
                    .layoutPriority(1)
            }
            .padding(.top, 10)
        }
    }

    private func clockLeft(_ d: PromiseDisplay) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(d.digits)
                .font(.system(size: 34, weight: .bold).monospacedDigit())
                .tracking(-0.5)
                .foregroundStyle(digitsColor(d.view))
                .lineLimit(1)
                .minimumScaleFactor(0.6)
                .contentTransition(.identity)
                .animation(reduceMotion ? nil : .easeInOut(duration: 0.3), value: d.view)
                // Тикающие цифры скринридеру не читаем — их пересказывает имя карточки раз в минуту.
                .accessibilityHidden(true)
            if let result = d.result {
                Text(result)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(d.view == .onTime ? CardPalette.okText : CardPalette.lateText)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let caption = d.caption {
                Text(caption)
                    .font(.system(size: 12))
                    .foregroundStyle(d.view == .late ? CardPalette.lateText : Eb.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let detail = d.resultDetail {
                Text(detail)
                    .font(.system(size: 12))
                    .foregroundStyle(Eb.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func clockRight(_ d: PromiseDisplay, alignment: HorizontalAlignment) -> some View {
        VStack(alignment: alignment, spacing: 1) {
            Text(d.until)
                .font(.system(size: 13))
                .foregroundStyle(Eb.textMuted)
                .lineLimit(1)
            if !d.label.isEmpty {
                Text(d.label)
                    .font(.system(size: 12))
                    .foregroundStyle(Eb.textMuted.opacity(0.85))
                    .lineLimit(1)
            }
        }
        .fixedSize()
    }

    private func digitsColor(_ view: PromiseView) -> Color {
        switch view {
        case .running: return Eb.textPrimary
        case .lastMinute: return CardPalette.lastMinute
        case .late, .lateArrived: return CardPalette.lateText
        case .onTime: return CardPalette.okText
        case .cancelled, .unresolved: return Eb.textMuted
        }
    }

    // MARK: Кнопки

    @ViewBuilder
    private func actions(_ d: PromiseDisplay) -> some View {
        if !d.buttons.isEmpty {
            HStack(spacing: 6) {
                ForEach(d.buttons, id: \.self) { id in
                    button(id, name: d.name)
                }
            }
            .padding(.top, 4)
        }
    }

    @ViewBuilder
    private func button(_ id: String, name: String) -> some View {
        let busy = context.busyAction == id
        let locked = context.busyAction != nil && !busy
        switch id {
        case "arrived":
            CardPillButton(
                title: "Пришёл", icon: "checkmark", primary: true, busy: busy, disabled: locked,
                a11yLabel: "Отметить, что \(name) пришёл"
            ) { context.onEvent(.act("arrived")) }
        case "cancel":
            CardPillButton(
                title: "Отменить", busy: busy, disabled: locked, a11yLabel: "Отменить таймер"
            ) { context.onEvent(.act("cancel")) }
        case "reopen":
            CardLinkButton(title: "Вернуть", busy: busy, a11yLabel: "Вернуть таймер") {
                context.onEvent(.act("reopen"))
            }
        default:
            EmptyView()
        }
    }
}

// MARK: - Кольцо с аватаром

/// Кольцо Ø 60, толщина 4, дорожка 8 % белого; дуга по часовой от 12 часов и убывает
/// (оставшаяся доля). Аватар Ø 48 в центре, у «пришёл вовремя» — зелёная ✓.
struct PromiseRing: View {
    let view: PromiseView
    let progress: Double
    let reduceMotion: Bool
    let name: String
    let avatarUrl: String?

    var body: some View {
        ZStack {
            Circle().inset(by: 2).stroke(CardPalette.track, lineWidth: 4)
            arc
            AvatarView(name: name, avatarUrl: avatarUrl, size: 48)
                .grayscale(muted ? 0.8 : 0)
                .brightness(muted ? -0.12 : 0)
            if view == .onTime {
                Image(systemName: "checkmark")
                    .font(.system(size: 10, weight: .black))
                    .foregroundStyle(Eb.paper)
                    .frame(width: 20, height: 20)
                    .background(CardPalette.ok, in: Circle())
                    .overlay(Circle().strokeBorder(botBubbleBackground, lineWidth: 2).padding(-2))
                    .offset(x: 21, y: 21)
                    .transition(reduceMotion ? .identity : .scale(scale: 0.6).combined(with: .opacity))
            }
        }
        .frame(width: 60, height: 60)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.2), value: view == .onTime)
        .accessibilityHidden(true)
    }

    private var muted: Bool { view == .cancelled || view == .unresolved }

    @ViewBuilder
    private var arc: some View {
        switch view {
        case .running, .lastMinute:
            let shape = Circle().inset(by: 2).trim(from: 0, to: max(0.0001, progress))
                .stroke(view == .lastMinute ? CardPalette.lastMinute : CardPalette.running,
                        style: StrokeStyle(lineWidth: 4, lineCap: .round))
                .rotationEffect(.degrees(-90))
                // Плавно и дёшево: кольцо доезжает до нового значения за секунду тика.
                .animation(reduceMotion ? nil : .linear(duration: 1), value: progress)
                .animation(reduceMotion ? nil : .easeInOut(duration: 0.3), value: view)
            if view == .lastMinute && !reduceMotion {
                // «Последняя минута»: мягкое свечение 0 → 6 → 0 за секунду.
                shape.phaseAnimator([false, true]) { content, glow in
                    content.shadow(color: CardPalette.lastMinute.opacity(glow ? 0.55 : 0), radius: glow ? 6 : 0)
                } animation: { _ in .easeInOut(duration: 0.5) }
            } else {
                shape
            }
        case .late:
            let ring = Circle().inset(by: 2).stroke(CardPalette.late, lineWidth: 4)
            if reduceMotion {
                ring
            } else {
                // «Дыхание» опоздания: 1 → 0.7 → 1 за 2 с.
                ring.phaseAnimator([false, true]) { content, dim in
                    content.opacity(dim ? 0.7 : 1)
                } animation: { _ in .easeInOut(duration: 1) }
            }
        case .onTime:
            Circle().inset(by: 2).stroke(CardPalette.ok, lineWidth: 4)
        case .lateArrived:
            Circle().inset(by: 2).stroke(CardPalette.late.opacity(0.55), lineWidth: 4)
        case .cancelled, .unresolved:
            Circle().inset(by: 2)
                .stroke(Eb.textMuted.opacity(0.4), style: StrokeStyle(lineWidth: 4, dash: [4, 6]))
        }
    }
}
