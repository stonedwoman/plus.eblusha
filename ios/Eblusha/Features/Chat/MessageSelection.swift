import SwiftUI

// Порт компонентов мультивыбора и пересылки из `ui/chat/ChatScreen.kt`:
// SelectionCheck (~1768) / SelectionTopBar (~2097) / SelectionActionBar (~2109) /
// ReplyDraftPreview (~2172) / ForwardPickerSheet (~2199).

/// Кружок-галка выбора: залитая, когда выбран, пустой контур — когда нет.
struct SelectionCheck: View {
    let selected: Bool

    var body: some View {
        Image(systemName: selected ? "checkmark.circle.fill" : "circle")
            .font(.system(size: 22))
            .foregroundStyle(selected ? Eb.brand : Eb.textMuted)
    }
}

/// Шапка режима выбора: крестик-отмена + счётчик (вместо обычной шапки чата).
struct SelectionTopBar: View {
    let count: Int
    let onClose: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            Button(action: onClose) {
                Image(systemName: "xmark")
                    .font(.title3)
                    .foregroundStyle(Eb.textPrimary)
                    .frame(width: 40, height: 40)
            }
            Text(count > 0 ? "Выбрано: \(count)" : "Выберите сообщения")
                .font(.body.weight(.semibold))
                .foregroundStyle(Eb.textPrimary)
            Spacer()
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 4)
        .background(Eb.surface200)
    }
}

/// Нижняя панель мультивыбора: ответить / переслать N / копировать / удалить N /
/// отмена (в досягаемости большого пальца). Удаление — только когда среди выбранных
/// есть НАШИ неудалённые.
struct SelectionActionBar: View {
    let count: Int
    let canDelete: Bool
    /// false в секретных чатах — пересылка из них запрещена (E2EE).
    let canForward: Bool
    let onReply: () -> Void
    let onForward: () -> Void
    let onCopy: () -> Void
    let onDelete: () -> Void
    let onCancel: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            // Ровно линия-граница сверху, без подмешивания брендового тона — панель
            // выделения не должна отдавать оранжевым (веб-паритет; в Compose ради
            // этого выключали tonalElevation, подмешивавший surfaceTint).
            Rectangle().fill(Eb.border).frame(height: 1)
            HStack(spacing: 0) {
                SelectionAction(
                    icon: "arrowshape.turn.up.left", label: "Ответить", action: onReply
                )
                if canForward {
                    SelectionAction(
                        icon: "arrowshape.turn.up.right",
                        label: count > 0 ? "Переслать \(count)" : "Переслать",
                        action: onForward
                    )
                }
                SelectionAction(icon: "doc.on.doc", label: "Копировать", action: onCopy)
                SelectionAction(
                    icon: "trash",
                    label: count > 0 ? "Удалить \(count)" : "Удалить",
                    tint: Eb.error,
                    enabled: canDelete,
                    action: onDelete
                )
                SelectionAction(icon: "xmark", label: "Отмена", action: onCancel)
            }
            .padding(.horizontal, 4)
            .padding(.vertical, 8)
        }
        .background(Eb.surface200)
    }
}

private struct SelectionAction: View {
    let icon: String
    let label: String
    var tint: Color = .white
    var enabled = true
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 2) {
                Image(systemName: icon)
                    .font(.system(size: 20))
                    .foregroundStyle(tint)
                    .frame(height: 24)
                Text(label)
                    .font(.system(size: 11))
                    .foregroundStyle(Eb.textMuted)
                    .lineLimit(1)
            }
            .padding(.horizontal, 4)
            .padding(.vertical, 4)
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.4)
    }
}

/// Русская множественность «сообщение/сообщения/сообщений» (порт pluralMessages).
func pluralMessages(_ n: Int) -> String {
    let mod10 = n % 10
    let mod100 = n % 100
    if mod10 == 1 && mod100 != 11 { return "сообщение" }
    if (2...4).contains(mod10) && !(12...14).contains(mod100) { return "сообщения" }
    return "сообщений"
}

/// Черновик цитаты над композером во время ответа (одиночного или мультиответа).
struct ReplyDraftPreview: View {
    let messages: [Message]
    let onClear: () -> Void

    var body: some View {
        if let first = messages.first {
            let title = messages.count >= 2
                ? "Ответ на \(messages.count) \(pluralMessages(messages.count))"
                : (first.isMine ? "Вы" : first.senderName)
            HStack(spacing: 8) {
                Image(systemName: "arrowshape.turn.up.left")
                    .font(.system(size: 17))
                    .foregroundStyle(Eb.brand)
                RoundedRectangle(cornerRadius: 2)
                    .fill(Eb.brand)
                    .frame(width: 3, height: 34)
                VStack(alignment: .leading, spacing: 1) {
                    Text(title)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Eb.brand)
                        .lineLimit(1)
                    Text(
                        (first.content?.isEmpty == false ? first.content! : "Вложение")
                    )
                    .font(.caption)
                    .foregroundStyle(Eb.textMuted)
                    .lineLimit(1)
                }
                Spacer()
                Button(action: onClear) {
                    Image(systemName: "xmark")
                        .font(.caption)
                        .foregroundStyle(Eb.textMuted)
                        .frame(width: 32, height: 32)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(Eb.surface200)
        }
    }
}

/// Запрос пересылки: какие сообщения переслать (Identifiable — для .sheet(item:)).
struct ForwardRequest: Identifiable {
    let id = UUID()
    let messages: [Message]
}

/// Шит выбора беседы-получателя пересылки.
struct ForwardPickerSheet: View {
    let repo: ChatRepository
    let currentConversationId: String
    let onPick: (String) -> Void

    @State private var conversations: [Conversation] = []

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Переслать в…")
                .font(.body.weight(.semibold))
                .foregroundStyle(Eb.textPrimary)
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(conversations.filter { $0.id != currentConversationId }) { conv in
                        Button {
                            onPick(conv.id)
                        } label: {
                            HStack(spacing: 12) {
                                AvatarView(name: conv.title, avatarUrl: conv.avatarUrl, size: 40)
                                Text(conv.title)
                                    .foregroundStyle(Eb.textPrimary)
                                    .lineLimit(1)
                                Spacer()
                            }
                            .padding(.horizontal, 16)
                            .padding(.vertical, 8)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            Spacer(minLength: 12)
        }
        .padding(.top, Spacing.md)
        .background(Eb.surface200)
        .task {
            var list = repo.cachedConversations()
            if list.isEmpty, case .success(let fetched) = await repo.listConversations() {
                list = fetched
            }
            // Секретные треды отвергают обычный путь отправки — пересылка В них
            // не поддерживается.
            conversations = list.filter { !$0.isSecretV2 }
        }
    }
}
