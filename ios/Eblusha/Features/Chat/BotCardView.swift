import SwiftUI
import UIKit

// Карточка бота внутри пузыря бота (оранжевая полоса слева остаётся — её рисует пузырь).
// Раздаёт по типу: таймер обещания (PromiseCardView) и «поделиться перепиской» (ShareCardView).
// Эталон пикселей и анимаций — scratchpad/promise-timer/mock.html и mock-share.html; числа ниже —
// оттуда (SPEC.md §10, SPEC-share §6.3–6.5). Одни значения на всех клиентах.

/// Что карточка может попросить у ленты. id сообщения подставляет ячейка.
enum BotCardEvent: Equatable {
    /// Действие маршрута карточек: arrived | cancel | reopen | decline | forget.
    case act(String)
    /// «Поделиться» — с выбранным периодом и галкой (их хранит вью-модель).
    case share
    case selectPeriod(String)
    case togglePhotos
    /// «Ответ ниже ↓» — прокрутить к сообщению.
    case jump(String)
}

/// Всё, что нужно карточке сверх самого сообщения.
struct BotCardContext {
    var viewerId: String?
    /// Идущее действие (кнопка — «крутилка»).
    var busyAction: String?
    var shareSelection: ShareSelection?
    /// Свежие имена участников беседы (снимок в данных — запасной).
    var names: [String: String] = [:]
    /// Аватар обещавшего из участников беседы (снимок в данных — запасной).
    var promiserAvatarUrl: String?
    /// Ширина содержимого карточки (без полей пузыря).
    var width: CGFloat
    var onEvent: (BotCardEvent) -> Void
}

struct BotCardView: View {
    let message: Message
    let card: BotCard
    let context: BotCardContext

    var body: some View {
        Group {
            switch card.payload {
            case .promise(let data):
                PromiseCardView(card: card, data: data, context: context, ticker: CardClock.shared.seconds)
            case .share(let data):
                ShareCardView(card: card, data: data, context: context, fallback: message.content,
                              ticker: CardClock.shared.minutes)
            case .unknown:
                EmptyView()
            }
        }
        .frame(width: context.width, alignment: .leading)
    }

    /// Ширина карточки в пузыре: `min(360 | 380, 100%)` макета минус поля пузыря, но не шире, чем
    /// остаётся строке ленты (поля ячейки 2×10, «Б» 28+6, зазор до края 40, поля пузыря 2×12).
    static func contentWidth(for card: BotCard, screenWidth: CGFloat) -> CGFloat {
        let bubble: CGFloat = card.knownType == .share ? 380 : 360
        return max(220, min(bubble - 27, screenWidth - 118))
    }
}

// MARK: - Палитра карточек (SPEC.md §10.2, SPEC-share §6.4)

enum CardPalette {
    static let running = Color(hex: 0xE38B0A)
    static let lastMinute = Color(hex: 0xF5A524)
    static let late = Color(hex: 0xEF4444)
    static let lateText = Color(hex: 0xF87171)
    static let ok = Color(hex: 0x22C55E)
    static let okText = Color(hex: 0x4ADE80)
    static let track = Color.white.opacity(0.08)
    static let tag = Color(hex: 0xF08A5D)
    static let tagBackground = Color(hex: 0xE25C2A, opacity: 0.12)
    static let tagBorder = Color(hex: 0xE25C2A, opacity: 0.30)
    static let quote = Color(hex: 0xD9DCE1)
    static let buttonText = Color(hex: 0xF3A37F)
    static let buttonTextYes = Color(hex: 0xFFD9C7)
    static let buttonBorder = Color(hex: 0xE25C2A, opacity: 0.42)
    static let buttonBackground = Color(hex: 0xE25C2A, opacity: 0.08)
    static let buttonBackgroundYes = Color(hex: 0xE25C2A, opacity: 0.22)
    static let chipSelectedBorder = Color(hex: 0xE25C2A, opacity: 0.70)
    static let amber = Color(hex: 0xF5A524)
    static let amberBackground = Color(hex: 0xF5A524, opacity: 0.10)
    static let checkbox = Color(hex: 0xE38B0A)
}

// MARK: - Общие детали

/// Метка карточки: «⏱ ТАЙМЕР», «🔒 ПЕРЕПИСКА».
struct CardTag: View {
    let icon: String
    let title: String
    var dimmed = false

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: icon)
                .font(.system(size: 9, weight: .bold))
            Text(title)
                .font(.system(size: 10.5, weight: .heavy))
                .tracking(0.6)
                .lineLimit(1)
        }
        .foregroundStyle(CardPalette.tag)
        .padding(.horizontal, 7)
        .frame(height: 18)
        .background(CardPalette.tagBackground, in: Capsule())
        .overlay(Capsule().strokeBorder(CardPalette.tagBorder))
        .opacity(dimmed ? 0.55 : 1)
        .dynamicTypeSize(...DynamicTypeSize.xxLarge)
        .accessibilityHidden(true)
    }
}

/// Кнопка карточки: капсула высотой 32 с областью касания 44 (как `.pt-btn` / `.eb-bot-action`).
struct CardPillButton: View {
    let title: String
    var icon: String?
    var primary = false
    var busy = false
    var disabled = false
    var a11yLabel: String?
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 5) {
                if busy {
                    ProgressView()
                        .controlSize(.mini)
                        .tint(primary ? CardPalette.buttonTextYes : CardPalette.buttonText)
                } else if let icon {
                    Image(systemName: icon)
                        .font(.system(size: 11, weight: .bold))
                }
                Text(title)
                    .font(.system(size: 13, weight: .bold))
                    .lineLimit(1)
            }
            .foregroundStyle(primary ? CardPalette.buttonTextYes : CardPalette.buttonText)
            .padding(.horizontal, 12)
            .frame(minHeight: 32)
            .background(primary ? CardPalette.buttonBackgroundYes : CardPalette.buttonBackground, in: Capsule())
            .overlay(Capsule().strokeBorder(CardPalette.buttonBorder))
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(disabled || busy)
        .opacity(disabled ? 0.45 : 1)
        .accessibilityLabel(a11yLabel ?? title)
    }
}

/// Текстовая кнопка-ссылка карточки («Вернуть», «Забыть переписку», «Ответ ниже ↓»).
struct CardLinkButton: View {
    let title: String
    var busy = false
    var a11yLabel: String?
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 4) {
                if busy {
                    ProgressView().controlSize(.mini).tint(CardPalette.tag)
                }
                Text(title)
                    .font(.system(size: 12.5, weight: .bold))
                    .underline()
                    .foregroundStyle(CardPalette.tag)
            }
            .padding(.vertical, 4)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(busy)
        .accessibilityLabel(a11yLabel ?? title)
    }
}

/// Вежливая живая область: скринридеру — только смена состояния, не каждая секунда.
enum CardAnnouncer {
    static func announce(_ text: String?) {
        guard let text, !text.isEmpty, UIAccessibility.isVoiceOverRunning else { return }
        UIAccessibility.post(notification: .announcement, argument: text)
    }
}
