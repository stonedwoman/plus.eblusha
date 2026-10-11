import SwiftUI
import UIKit

// Карточка «поделиться перепиской» (SPEC-share §6, эталон — mock-share.html).
//
// У спросившего (ожидает выбора):          У остальных:
//  ▌ 🔒 ПЕРЕПИСКА                           ▌ 🔒 ПЕРЕПИСКА
//  ▌ Чтобы ответить, мне нужно почитать…    ▌ Еблуша просит разрешения почитать…
//  ▌ (Сегодня)(Эта неделя)(Всё время)       ▌ Решает Рома · ждём ещё 28 мин
//  ▌ [ ] Включать фото (3)
//  ▌ [Поделиться] [Не делиться]
//  ▌ Прочитаю только для этого вопроса…
//
// Решает ТОТ, КТО СПРОСИЛ: остальным — карточка только для чтения. Что показать, считает
// ShareRules; минутные подписи («ждём ещё 28 мин», «доступ ещё 42 мин») тикает общий минутный
// тикер, пока карточка на экране.

struct ShareCardView: View {
    let card: BotCard
    let data: ShareCardData
    let context: BotCardContext
    /// Запасной текст сервера — для состояния новее клиента.
    let fallback: String?
    @ObservedObject var ticker: CardTicker

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var token = UUID().uuidString
    @State private var subscribed = false

    var body: some View {
        let now = CardClock.shared.now()
        let display = ShareRules.display(
            card: card, data: data, viewerId: context.viewerId, now: now,
            selection: context.shareSelection, names: context.names, fallback: fallback
        )
        let ticking = !card.closed

        VStack(alignment: .leading, spacing: 8) {
            CardTag(icon: "lock.fill", title: "ПЕРЕПИСКА", dimmed: display.mode == .finished)
            switch display.mode {
            case .choose: choose(display)
            case .waiting: waiting(display)
            case .reading, .answered: granted(display)
            case .finished: finishedView(display)
            }
        }
        .onAppear { setTicking(ticking) }
        .onDisappear { setTicking(false) }
        .onChange(of: ticking) { _, value in setTicking(value) }
        .onChange(of: card.state) { old, new in
            guard old != new else { return }
            CardAnnouncer.announce(display.lines.first?.plainText)
        }
    }

    private func setTicking(_ on: Bool) {
        guard on != subscribed else { return }
        subscribed = on
        if on { ticker.subscribe(token) } else { ticker.unsubscribe(token) }
    }

    // MARK: Выбор (спросивший)

    @ViewBuilder
    private func choose(_ d: ShareDisplay) -> some View {
        if let notice = d.notice {
            Text(notice)
                .font(.system(size: 13))
                .foregroundStyle(CardPalette.amber)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 10)
                .padding(.vertical, 7)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(CardPalette.amberBackground, in: RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(CardPalette.amber.opacity(0.3)))
        }
        if let question = d.question {
            Text(question)
                .font(.system(size: 14))
                .foregroundStyle(Eb.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
        }
        chips(d.chips)
        if let photos = d.photos { photosToggle(photos) }
        HStack(spacing: 6) {
            CardPillButton(
                title: "Поделиться", primary: true, busy: context.busyAction == "share",
                disabled: !d.canShare || (context.busyAction != nil && context.busyAction != "share"),
                a11yLabel: d.shareAccessibility
            ) { context.onEvent(.share) }
            if d.canDecline {
                CardPillButton(
                    title: "Не делиться", busy: context.busyAction == "decline",
                    disabled: context.busyAction != nil && context.busyAction != "decline"
                ) { context.onEvent(.act("decline")) }
            }
        }
        if let footnote = d.footnote {
            Text(footnote)
                .font(.system(size: 11.5))
                .foregroundStyle(Eb.textMuted)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    /// «Чипы» периода: в ряд, а если подписи в ряд не влезают целиком (узкий пузырь телефона) —
    /// столбиком, счёт справа (SPEC-share §6.3). Решаем замером текста, а не ViewThatFits: тот
    /// соглашался на ряд с обрезанными «Эта неде…».
    private func chips(_ chips: [ShareChip]) -> some View {
        Group {
            if Self.chipsFitInRow(chips, width: context.width) {
                HStack(spacing: 6) {
                    ForEach(chips, id: \.period) { chip in chipButton(chip, stretch: true) }
                }
            } else {
                VStack(spacing: 6) {
                    ForEach(chips, id: \.period) { chip in chipButton(chip, stretch: true, row: true) }
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Период переписки")
    }

    static func chipsFitInRow(_ chips: [ShareChip], width: CGFloat) -> Bool {
        let titleFont = UIFont.systemFont(ofSize: 13, weight: .semibold)
        let subtitleFont = UIFont.systemFont(ofSize: 11.5)
        // Ряд делит ширину поровну, поэтому мерило — самый широкий чип, умноженный на их число.
        let widest = chips.map { chip -> CGFloat in
            let title = (chip.title as NSString).size(withAttributes: [.font: titleFont]).width
            let subtitle = (chip.subtitle as NSString).size(withAttributes: [.font: subtitleFont]).width
            return max(title, subtitle).rounded(.up) + 20 + 2
        }.max() ?? 0
        let needed = widest * CGFloat(chips.count) + CGFloat(max(0, chips.count - 1)) * 6
        return needed <= width
    }

    private func chipButton(_ chip: ShareChip, stretch: Bool, row: Bool = false) -> some View {
        Button {
            context.onEvent(.selectPeriod(chip.period))
        } label: {
            Group {
                if row {
                    HStack {
                        Text(chip.title).font(.system(size: 13, weight: .semibold))
                        Spacer(minLength: 8)
                        Text(chip.subtitle).font(.system(size: 11.5)).foregroundStyle(Eb.textMuted)
                    }
                } else {
                    VStack(spacing: 1) {
                        Text(chip.title).font(.system(size: 13, weight: .semibold))
                        Text(chip.subtitle).font(.system(size: 11.5)).foregroundStyle(Eb.textMuted)
                    }
                }
            }
            .lineLimit(1)
            .foregroundStyle(chip.selected ? CardPalette.buttonTextYes : CardPalette.buttonText)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .frame(maxWidth: stretch ? .infinity : nil, minHeight: 44)
            .background(
                chip.selected ? CardPalette.buttonBackgroundYes : CardPalette.buttonBackground,
                in: RoundedRectangle(cornerRadius: 10)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 10)
                    .strokeBorder(chip.selected ? CardPalette.chipSelectedBorder : CardPalette.buttonBorder)
            )
            .contentShape(RoundedRectangle(cornerRadius: 10))
        }
        .buttonStyle(.plain)
        .disabled(!chip.enabled || context.busyAction != nil)
        .opacity(chip.enabled ? 1 : 0.4)
        .accessibilityLabel(chip.accessibilityLabel)
        .accessibilityAddTraits(chip.selected ? [.isSelected] : [])
    }

    private func photosToggle(_ toggle: SharePhotosToggle) -> some View {
        Button {
            context.onEvent(.togglePhotos)
        } label: {
            HStack(spacing: 8) {
                ZStack {
                    RoundedRectangle(cornerRadius: 4)
                        .fill(toggle.on ? CardPalette.checkbox : Color.clear)
                    RoundedRectangle(cornerRadius: 4)
                        .strokeBorder(toggle.on ? CardPalette.checkbox : Eb.textMuted.opacity(0.7), lineWidth: 1.5)
                    if toggle.on {
                        Image(systemName: "checkmark")
                            .font(.system(size: 11, weight: .heavy))
                            .foregroundStyle(Eb.paper)
                    }
                }
                .frame(width: 18, height: 18)
                Text("Включать фото")
                    .font(.system(size: 14))
                    .foregroundStyle(Eb.textPrimary)
                Text(toggle.count)
                    .font(.system(size: 12))
                    .foregroundStyle(Eb.textMuted)
                    .lineLimit(1)
                Spacer(minLength: 0)
            }
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!toggle.enabled || context.busyAction != nil)
        .opacity(toggle.enabled ? 1 : 0.45)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(toggle.accessibilityLabel)
        .accessibilityValue(toggle.on ? "включено" : "выключено")
        .accessibilityAddTraits(.isToggle)
    }

    // MARK: Ожидание (остальные)

    @ViewBuilder
    private func waiting(_ d: ShareDisplay) -> some View {
        if let first = d.lines.first {
            Text(first.attributed)
                .font(.system(size: 14))
                .foregroundStyle(Eb.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
        }
        if d.lines.count > 1 {
            Text(d.lines[1].attributed)
                .font(.system(size: 12))
                .foregroundStyle(Eb.textMuted)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: Доступ дан

    @ViewBuilder
    private func granted(_ d: ShareDisplay) -> some View {
        if let first = d.lines.first {
            HStack(alignment: .firstTextBaseline, spacing: 5) {
                Image(systemName: "checkmark")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(CardPalette.okText)
                    .accessibilityHidden(true)
                Text(first.attributed)
                    .font(.system(size: 14))
                    .foregroundStyle(Eb.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        if d.mode == .answered {
            HStack(spacing: 0) {
                if let link = d.answerLink, let answerId = data.answerMessageId {
                    Button { context.onEvent(.jump(answerId)) } label: {
                        Text(link)
                            .font(.system(size: 12.5, weight: .bold))
                            .underline()
                            .foregroundStyle(CardPalette.tag)
                            .frame(minHeight: 32)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Перейти к ответу")
                }
                if let suffix = d.answerSuffix {
                    Text(suffix)
                        .font(.system(size: 12))
                        .foregroundStyle(Eb.textMuted)
                }
            }
            if let detail = d.detail {
                Text(detail)
                    .font(.system(size: 12))
                    .foregroundStyle(Eb.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        } else if let detail = d.detail {
            readingLine(detail)
        }
        if d.canForget {
            HStack {
                Spacer(minLength: 0)
                CardLinkButton(
                    title: "Забыть переписку", busy: context.busyAction == "forget",
                    a11yLabel: "Забыть переписку — Еблуша перестанет её читать"
                ) { context.onEvent(.act("forget")) }
            }
            // Область касания 44 остаётся, но строка не раздвигает карточку.
            .padding(.vertical, -8)
        }
    }

    /// «Читаю: 34 сообщения и 3 фото…» — три точки бегут; «меньше движения» — стоят.
    @ViewBuilder
    private func readingLine(_ text: String) -> some View {
        let base = text.hasSuffix("…") ? String(text.dropLast()) : text
        if reduceMotion || !text.hasSuffix("…") {
            Text(text)
                .font(.system(size: 12))
                .foregroundStyle(Eb.textMuted)
                .fixedSize(horizontal: false, vertical: true)
        } else {
            HStack(spacing: 0) {
                Text(base)
                // Место под три точки держит невидимая копия — строка не дёргается по ширине.
                Text("...").hidden().overlay(alignment: .leading) {
                    Color.clear.phaseAnimator([1, 2, 3]) { _, step in
                        Text(String(repeating: ".", count: step))
                    } animation: { _ in .linear(duration: 0.35) }
                }
            }
            .font(.system(size: 12))
            .foregroundStyle(Eb.textMuted)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(text)
        }
    }

    // MARK: Финалы

    @ViewBuilder
    private func finishedView(_ d: ShareDisplay) -> some View {
        if let line = d.lines.first {
            Text(line.attributed)
                .font(.system(size: 14))
                .foregroundStyle(Eb.textMuted)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}
