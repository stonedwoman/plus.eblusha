import SwiftUI

/// Меню сообщения: горизонтальный ряд реакций сверху, действия списком снизу.
///
/// Раньше здесь было системное `contextMenu`, а оно умеет только вертикальный список —
/// четыре эмодзи вставали столбиком, чего нет ни в вебе, ни в одном мессенджере.
/// Полоса реакций — порт `components/MessageReactionRail.tsx`: быстрые слоты и кнопка
/// полного выбора в одну строку.
struct MessageActionsSheet: View {

    let message: Message
    let quickSlots: [String]
    let canForward: Bool

    let onReact: (String) -> Void
    let onPickReaction: () -> Void
    let onReply: () -> Void
    let onCopy: () -> Void
    let onForward: () -> Void
    let onEdit: () -> Void
    let onDelete: () -> Void
    let onSelect: () -> Void
    let onDismiss: () -> Void

    private var canEdit: Bool { message.isMine && !message.deleted && message.type == "TEXT" }
    private var canDelete: Bool { message.isMine && !message.deleted }
    private var hasText: Bool { !(message.content ?? "").isEmpty }

    var body: some View {
        VStack(spacing: 0) {
            reactionRail
            Divider().overlay(Eb.border)
            actions
        }
        .background(Eb.surface200)
        .presentationDetents([.height(detentHeight)])
        .presentationDragIndicator(.visible)
        .presentationBackground(Eb.surface200)
    }

    private var detentHeight: CGFloat {
        var rows = 3 // ответить, копировать, выбрать
        if canForward { rows += 1 }
        if canEdit { rows += 1 }
        if canDelete { rows += 1 }
        return 86 + CGFloat(rows) * 52
    }

    /// Полоса реакций: слоты и «ещё» в одну строку, как в вебе.
    private var reactionRail: some View {
        HStack(spacing: 6) {
            ForEach(quickSlots, id: \.self) { emoji in
                Button {
                    onReact(emoji)
                    onDismiss()
                } label: {
                    Text(emoji)
                        .font(.system(size: 30))
                        .frame(maxWidth: .infinity, minHeight: 48)
                        .background(
                            mine(emoji) ? Eb.brand.opacity(0.28) : Color.clear,
                            in: RoundedRectangle(cornerRadius: 12)
                        )
                }
                .buttonStyle(.plain)
            }
            Button {
                onPickReaction()
            } label: {
                Image(systemName: "plus")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(Eb.textMuted)
                    .frame(width: 44, height: 48)
                    .background(Eb.surface100, in: RoundedRectangle(cornerRadius: 12))
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 12)
        .padding(.top, 14)
        .padding(.bottom, 10)
    }

    private func mine(_ emoji: String) -> Bool {
        message.reactions.first { $0.emoji == emoji }?.mine ?? false
    }

    private var actions: some View {
        VStack(spacing: 0) {
            row("Ответить", icon: "arrowshape.turn.up.left", action: onReply)
            if hasText {
                row("Копировать", icon: "doc.on.doc", action: onCopy)
            }
            if canForward {
                row("Переслать", icon: "arrowshape.turn.up.right", action: onForward)
            }
            if canEdit {
                row("Изменить", icon: "pencil", action: onEdit)
            }
            row("Выбрать", icon: "checkmark.circle", action: onSelect)
            if canDelete {
                row("Удалить", icon: "trash", destructive: true, action: onDelete)
            }
        }
        .padding(.bottom, 8)
    }

    private func row(
        _ title: String, icon: String, destructive: Bool = false, action: @escaping () -> Void
    ) -> some View {
        Button {
            action()
            onDismiss()
        } label: {
            HStack(spacing: 12) {
                Image(systemName: icon)
                    .frame(width: 22)
                Text(title)
                Spacer()
            }
            .foregroundStyle(destructive ? Eb.error : Eb.textPrimary)
            .padding(.horizontal, 18)
            .frame(height: 52)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}
