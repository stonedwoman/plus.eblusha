import SwiftUI

/// Полоса чипов реакций у пузыря — порт веб-рельсы
/// (`frontend/src/ui/pages/chats/components/MessageReactionRail.tsx:157-171, 299-303, 516-546`
/// + `style.css:776, 920-950`).
///
/// Раньше iOS рисовал серые «пилюли» с капсульным фоном, всегда со счётчиком и в том
/// порядке, в каком реакции пришли с сервера (то есть «кто первым поставил»). Из-за этого
/// один и тот же чат выглядел на телефоне и в браузере по-разному, а «главная» реакция
/// у сообщения была разная. Здесь вид и порядок ровно веб-овские.

/// Порядок чипов как в вебе: по популярности вниз, при равенстве — по самому эмодзи.
///
/// Разрыв равенства обязателен и обязан зависеть ТОЛЬКО от эмодзи: `sorted(by:)` в Swift
/// неустойчива, и без такого правила два чипа с одинаковым счётчиком меняли бы места при
/// каждой перерисовке ленты. Попутно группируем одинаковые эмодзи: на вход может прийти
/// массив с дублями (оптимистичная постановка реакции добавляет запись в конец), а в
/// `ForEach(id: \.emoji)` дубликат ключа — это битая ячейка.
func sortedReactionChips(_ reactions: [MessageReaction]) -> [MessageReaction] {
    var order: [String] = []
    var byEmoji: [String: MessageReaction] = [:]
    for reaction in reactions where !reaction.emoji.isEmpty {
        if let merged = byEmoji[reaction.emoji] {
            byEmoji[reaction.emoji] = MessageReaction(
                emoji: merged.emoji,
                count: merged.count + reaction.count,
                mine: merged.mine || reaction.mine
            )
        } else {
            order.append(reaction.emoji)
            byEmoji[reaction.emoji] = reaction
        }
    }
    return order.compactMap { byEmoji[$0] }.sorted { lhs, rhs in
        if lhs.count != rhs.count { return lhs.count > rhs.count }
        return lhs.emoji < rhs.emoji
    }
}

/// Цвет счётчика у чипа — порт `accentForEmoji`: сердце красное, остальное янтарное, а на
/// подсвеченной строке мультивыбора — тёмно-коричневое (светлый янтарь на янтарном фоне
/// не читается). В вебе этот цвет достаётся и самому эмодзи, но системный эмодзи-шрифт
/// цвет игнорирует — видимая часть правила это именно счётчик.
///
/// `❤️` приходит и с вариационным селектором, и без него: веб сравнивает с «❤️», а нам
/// нужны оба написания, иначе «голое» сердце осталось бы янтарным.
func reactionAccentColor(_ emoji: String, isSelectedInMulti: Bool) -> Color {
    if emoji == "❤️" || emoji == "❤" { return Color(hex: 0xEF4444) }
    return isSelectedInMulti ? Color(hex: 0x713F12) : Color(hex: 0xFFC46B)
}

struct ReactionChips: View {

    let reactions: [MessageReaction]
    /// Строка выделена в мультивыборе — фон уходит в янтарный, акцент темнеет (веб:
    /// `isSelectedInMulti` в MessageReactionRail).
    var isSelectedInMulti = false
    let onTap: (String) -> Void

    /// Высота рельсы в вебе — `--msg-reaction-row` = 44px / 2.
    private static let rowHeight: CGFloat = 22
    /// `--msg-reaction-emoji: 20px`.
    private static let emojiSize: CGFloat = 20

    var body: some View {
        let chips = sortedReactionChips(reactions)
        if !chips.isEmpty {
            // В вебе `gap: 0` — чипы держатся боковыми свесами глифов. На iOS эмодзи
            // прижимаются друг к другу плотнее, поэтому минимальный зазор всё же нужен.
            HStack(spacing: 2) {
                ForEach(chips, id: \.emoji) { chip in
                    Button {
                        onTap(chip.emoji)
                    } label: {
                        chipLabel(chip)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    /// Чип без подложки и рамки: крупный эмодзи и — ТОЛЬКО при нескольких голосах —
    /// мелкий счётчик. Своя реакция отличается лишь полной непрозрачностью против 0.82,
    /// как в вебе (никакой отдельной «жёлтой капсулы»).
    private func chipLabel(_ chip: MessageReaction) -> some View {
        HStack(spacing: 1) {
            Text(chip.emoji)
                .font(.system(size: Self.emojiSize))
            if chip.count > 1 {
                Text("\(chip.count)")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(
                        reactionAccentColor(chip.emoji, isSelectedInMulti: isSelectedInMulti)
                    )
            }
        }
        .frame(minHeight: Self.rowHeight)
        // Капсулы с её паддингами больше нет, а палец по 20-точечному глифу попадает
        // плохо — площадь касания добираем прозрачным отступом.
        .padding(.horizontal, 2)
        .padding(.vertical, 2)
        .contentShape(Rectangle())
        .opacity(chip.mine ? 1 : 0.82)
    }
}
