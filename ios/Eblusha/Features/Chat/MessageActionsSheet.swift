import SwiftUI

/// Кирпичи меню сообщения: состав и порядок пунктов, вид одной строки и полоса быстрых
/// реакций. Само меню рисует `MessageActionsOverlay`.
///
/// Раньше здесь жил нижний лист (`.sheet` + `presentationDetents([.height(86 + rows * 52)])`),
/// и это была главная беда меню: шторка высотой почти в пол-экрана накрывала ровно то
/// сообщение, по которому нажали, — чтобы вспомнить, над чем открыто меню, приходилось его
/// закрывать. Теперь пузырь поднимается над размытым фоном, а состав и порядок пунктов
/// переехали сюда без единого изменения: это веб-паритет (`ChatModals.tsx`), и меняться он
/// должен вместе с вебом, а не вместе с подачей.
///
/// Имя файла оставлено прежним намеренно — чтобы история правок меню не разрывалась.

/// Один пункт меню. `id` — свой стабильный ключ, а не заголовок: по нему `ForEach`
/// отличает пункты, и перевод текста не должен пересобирать список.
struct MessageActionItem: Identifiable {
    let id: String
    let title: String
    let icon: String
    var destructive = false
    let action: () -> Void
}

/// «Копировать» есть почти всегда — как в вебе (ChatModals.tsx:2632-2645), где пункт
/// стоит безусловно: у сообщения без подписи в буфер уходит описание вложений
/// («Файл: смета.pdf»), а у одной картинки — сама картинка. Прячем только там, где
/// положить в буфер честно нечего: удалённое сообщение и секретная картинка без
/// подписи (расшифровать её вне вьюмодели нечем).
private func messageCanCopy(_ message: Message) -> Bool {
    if message.deleted { return false }
    if !buildMessageCopyText(message).isEmpty { return true }
    return message.attachments.contains { $0.type == "IMAGE" && $0.secretNonce == nil }
}

private func messageCanEdit(_ message: Message) -> Bool {
    message.isMine && !message.deleted && message.type == "TEXT"
}

private func messageCanDelete(_ message: Message) -> Bool {
    message.isMine && !message.deleted
}

/// Пункты меню в том же составе и порядке, что были в нижнем листе (веб-паритет).
func messageActionItems(
    message: Message,
    canForward: Bool,
    onReply: @escaping () -> Void,
    onCopy: @escaping () -> Void,
    onForward: @escaping () -> Void,
    onEdit: @escaping () -> Void,
    onSelect: @escaping () -> Void,
    onDelete: @escaping () -> Void
) -> [MessageActionItem] {
    var items: [MessageActionItem] = [
        MessageActionItem(
            id: "reply", title: "Ответить", icon: "arrowshape.turn.up.left", action: onReply
        )
    ]
    if messageCanCopy(message) {
        items.append(MessageActionItem(
            id: "copy", title: "Копировать", icon: "doc.on.doc", action: onCopy
        ))
    }
    if canForward {
        items.append(MessageActionItem(
            id: "forward", title: "Переслать", icon: "arrowshape.turn.up.right", action: onForward
        ))
    }
    if messageCanEdit(message) {
        items.append(MessageActionItem(
            id: "edit", title: "Изменить", icon: "pencil", action: onEdit
        ))
    }
    items.append(MessageActionItem(
        id: "select", title: "Выбрать", icon: "checkmark.circle", action: onSelect
    ))
    if messageCanDelete(message) {
        items.append(MessageActionItem(
            id: "delete", title: "Удалить", icon: "trash", destructive: true, action: onDelete
        ))
    }
    return items
}

// MARK: - Карточка действий

/// Список пунктов в отдельной карточке под поднятым пузырём.
///
/// Метрики строки (52 pt, ведущая иконка) оставлены нашими, а не телеграмовскими (44 pt,
/// иконка справа): 44 pt — это ровно минимальная зона касания, без запаса под красным
/// «Удалить», а ведущая иконка — родная идиома iOS и идиома остальных наших списков
/// (ChatListView). Из телеграмовского здесь только радиус 14 и подсветка нажатой строки.
struct MessageActionsCard: View {

    let items: [MessageActionItem]
    let onPick: (MessageActionItem) -> Void

    static let rowHeight: CGFloat = 52
    /// Вертикальные поля карточки: строка не должна упираться в скругление.
    static let verticalPadding: CGFloat = 6
    /// Ширина карточки; у узких экранов ужимается вызывающей стороной.
    static let width: CGFloat = 236
    static let cornerRadius: CGFloat = 14
    /// Волосок между пунктами.
    static let separator: CGFloat = 0.5

    /// Точная высота карточки: строки, поля и волоски между строками. Оверлей считает по
    /// ней всю колонку, поэтому забытый волосок здесь — это сдвиг всего блока.
    static func height(rows: Int) -> CGFloat {
        let count = CGFloat(max(rows, 1))
        return count * rowHeight + verticalPadding * 2 + max(count - 1, 0) * separator
    }

    var body: some View {
        VStack(spacing: 0) {
            ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                if index > 0 {
                    // Волосяная линия, а не Divider: Divider в карточке тянет свои
                    // системные отступы и рвёт высоту, посчитанную в height(rows:).
                    Rectangle()
                        .fill(Eb.border)
                        .frame(height: Self.separator)
                        .padding(.leading, 18)
                }
                Button {
                    onPick(item)
                } label: {
                    HStack(spacing: 12) {
                        Image(systemName: item.icon)
                            .frame(width: 22)
                        Text(item.title)
                        Spacer(minLength: 0)
                    }
                    .foregroundStyle(item.destructive ? Eb.error : Eb.textPrimary)
                    .padding(.horizontal, 18)
                    .frame(height: Self.rowHeight)
                    .contentShape(Rectangle())
                }
                .buttonStyle(MessageActionRowStyle())
            }
        }
        .padding(.vertical, Self.verticalPadding)
        .background(
            Eb.surface200.opacity(0.95),
            in: RoundedRectangle(cornerRadius: Self.cornerRadius, style: .continuous)
        )
        .overlay {
            RoundedRectangle(cornerRadius: Self.cornerRadius, style: .continuous)
                .strokeBorder(Eb.border.opacity(0.6), lineWidth: 0.5)
        }
    }
}

/// Подсветка нажатой строки: `.plain` не даёт никакой, а палец должен видеть попадание
/// ещё до того, как меню закроется.
private struct MessageActionRowStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(configuration.isPressed ? Color.white.opacity(0.1) : Color.clear)
    }
}

// MARK: - Полоса быстрых реакций

/// Быстрые слоты и кнопка полного выбора — отдельная «таблетка» над поднятым пузырём.
///
/// Порт `components/MessageReactionRail.tsx`: состав слотов и правило «запоминаем только
/// постановку» веб-овские. Телеграмовская здесь только геометрия: кружок 36, зазор 8,
/// боковое поле 6, высота 46 — и выход слотов по очереди.
struct MessageQuickReactionsRail: View {

    let quickSlots: [String]
    /// Эта реакция уже стоит от меня — слот подсвечен.
    let mine: (String) -> Bool
    let onPick: (String) -> Void
    let onMore: () -> Void
    /// Полоса на месте: слоты выскакивают из масштаба 0.01 по очереди.
    let shown: Bool

    static let height: CGFloat = 46
    static let item: CGFloat = 36
    static let spacing: CGFloat = 8
    static let sideInset: CGFloat = 6

    /// Ширина таблетки под заданное число слотов (быстрые + кнопка «ещё»).
    static func width(slots: Int) -> CGFloat {
        let count = CGFloat(max(slots, 1))
        return sideInset * 2 + count * item + (count - 1) * spacing
    }

    var body: some View {
        HStack(spacing: Self.spacing) {
            ForEach(Array(quickSlots.enumerated()), id: \.offset) { index, emoji in
                Button {
                    onPick(emoji)
                } label: {
                    // Системный эмодзи рисуется крупнее номинала, поэтому 30 в кружке 36,
                    // а не 36 — иначе глиф упирается в края подсветки.
                    Text(emoji)
                        .font(.system(size: 30))
                        .frame(width: Self.item, height: Self.item)
                        .background(
                            mine(emoji) ? Eb.brand.opacity(0.28) : Color.clear, in: Circle()
                        )
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .scaleEffect(shown ? 1 : 0.01)
                .animation(popIn(index: index), value: shown)
            }
            Button {
                onMore()
            } label: {
                Image(systemName: "plus")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(Eb.textMuted)
                    .frame(width: Self.item, height: Self.item)
                    .background(Eb.surface100.opacity(0.9), in: Circle())
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .scaleEffect(shown ? 1 : 0.01)
            .animation(popIn(index: quickSlots.count), value: shown)
        }
        .padding(.horizontal, Self.sideInset)
        .frame(height: Self.height)
        .background(Eb.surface200.opacity(0.92), in: Capsule())
        .overlay { Capsule().strokeBorder(Eb.border.opacity(0.6), lineWidth: 0.5) }
    }

    /// Пружина 0.4 с от масштаба 0.01 с задержкой 0.05 с на слот. При уходе задержек нет:
    /// меню закрывается целиком, и расползающиеся друг за другом эмодзи смотрятся мусором.
    private func popIn(index: Int) -> Animation {
        .spring(response: 0.4, dampingFraction: 0.72)
        .delay(shown ? 0.05 * Double(index) : 0)
    }
}
