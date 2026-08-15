import SwiftUI

// Порт `ui/chat/ChatListScreen.kt`. Обновления в диалоге не портированы (iOS
// обновляется через TestFlight/App Store) — пилюля справа показывает версию.

private let offlineDot = Color(hex: 0x6B7280)
private let groupGreen = Color(hex: 0x22C55E)
private let contactsPurple = Color(hex: 0x8B5CF6)
/// Веб-зелёный секретных чатов (#22c55e) — замок, кант, подзаголовок приглашения.
private let secretGreen = Color(hex: 0x22C55E)

struct ChatListView: View {
    @ObservedObject var vm: ChatListViewModel
    let onOpenChat: (Conversation) -> Void
    var onOpenContacts: () -> Void = {}
    var onOpenSettings: () -> Void = {}
    var onNewGroup: () -> Void = {}

    @State private var confirmDelete: Conversation?

    var body: some View {
        VStack(spacing: 0) {
            // Брендовая шапка (заменяет тулбар — как панель списка веба).
            VStack(spacing: 0) {
                AnimatedWordmark()
                Text("Здесь мы общаемся")
                    .font(.caption)
                    .foregroundStyle(Eb.textMuted)
            }
            .padding(.top, 10)
            .padding(.bottom, 12)

            ZStack {
                if vm.ui.loading {
                    ProgressView()
                } else if let error = vm.ui.error, vm.ui.conversations.isEmpty {
                    centeredMessage(error, retry: vm.refresh)
                } else if vm.ui.conversations.isEmpty {
                    centeredMessage("Чатов пока нет", retry: nil)
                } else {
                    conversationList
                }
            }
            .frame(maxHeight: .infinity)

            bottomPanel
        }
        .background(Eb.surface200)
        .alert(item: $confirmDelete) { target in
            deleteAlert(target)
        }
    }

    private var conversationList: some View {
        // Секретка рисуется отступной плиткой «СЕКРЕТНЫЙ ЧАТ» под облачной 1:1 того же
        // собеседника (репозиторий уже упорядочил) — имя пишем только сироте без родителя.
        let cloudPeerIds = Set(
            vm.ui.conversations
                .filter { !$0.isSecretV2 && !$0.isSecret && !$0.isGroup }
                .compactMap { $0.otherUserId }
        )
        return ScrollView {
            LazyVStack(spacing: 8) {
                ForEach(vm.ui.conversations) { conversation in
                    ConversationTile(
                        c: conversation,
                        typing: vm.ui.typingConversations.contains(conversation.id),
                        hasCloudSibling: conversation.isSecretV2 &&
                            conversation.otherUserId.map { cloudPeerIds.contains($0) } == true,
                        onMarkRead: (!conversation.isSecretV2 && conversation.unreadCount > 0)
                            ? { vm.markConversationRead(conversation) } : nil,
                        onDelete: { confirmDelete = conversation },
                        onTap: { onOpenChat(conversation) }
                    )
                }
            }
            .padding(.horizontal, 12)
            .padding(.top, 6)
            .padding(.bottom, 14)
        }
    }

    private func deleteAlert(_ target: Conversation) -> Alert {
        let (title, body, action): (String, String, String)
        if target.isSecretV2 {
            (title, body, action) = (
                "Закрыть секретный чат?",
                "Секретный чат будет закрыт и скрыт у всех участников.",
                "Закрыть"
            )
        } else if target.isGroup {
            (title, body, action) = (
                "Выйти из беседы?",
                "Беседа исчезнет из вашего списка, остальные участники останутся.",
                "Выйти"
            )
        } else {
            (title, body, action) = (
                "Удалить чат?",
                "Переписка будет удалена у всех участников безвозвратно.",
                "Удалить"
            )
        }
        return Alert(
            title: Text(title),
            message: Text(body),
            primaryButton: .destructive(Text(action)) { vm.deleteConversation(target) },
            secondaryButton: .cancel(Text("Отмена"))
        )
    }

    private var bottomPanel: some View {
        let me = AppContainer.shared.sessionStore.currentUser()
        let myName = me?.displayName?.isEmpty == false ? me!.displayName! : (me?.username ?? "Профиль")
        let (statusLabel, statusColor) = selfPresenceLabel(vm.ui.selfPresence)
        let version = (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? "?"

        return VStack(spacing: 8) {
            HStack(spacing: 10) {
                actionTile(
                    iconBackground: groupGreen, icon: "plus",
                    title: "Беседа", subtitle: "Групповой чат", action: onNewGroup
                )
                actionTile(
                    iconBackground: contactsPurple, icon: "person.2.fill",
                    title: "Контакты", subtitle: "Список контактов", action: onOpenContacts
                )
            }
            HStack(spacing: 10) {
                ZStack(alignment: .bottomTrailing) {
                    AvatarView(name: myName, avatarUrl: me?.avatarUrl, size: 40)
                    // Своё присутствие: та же иконка устройства, что видят собеседники.
                    PresenceBadge(
                        userId: me?.id, status: vm.ui.selfPresence,
                        ringSize: 14, dotSize: 9
                    )
                }
                VStack(alignment: .leading, spacing: 1) {
                    Text(myName)
                        .fontWeight(.semibold)
                        .foregroundStyle(Eb.textPrimary)
                        .lineLimit(1)
                    Text(statusLabel)
                        .font(.footnote)
                        .foregroundStyle(statusColor)
                }
                Spacer()
                Text("v \(version)")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Eb.textMuted)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 7)
                    .background(Eb.surface300, in: Capsule())
                    .overlay(Capsule().strokeBorder(Eb.borderStrong))
            }
            .padding(10)
            .background(Eb.surface200, in: RoundedRectangle(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Eb.borderStrong))
            .contentShape(Rectangle())
            .onTapGesture(perform: onOpenSettings)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
    }

    private func actionTile(
        iconBackground: Color, icon: String, title: String, subtitle: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 10) {
                ZStack {
                    Circle().fill(iconBackground)
                    Image(systemName: icon)
                        .foregroundStyle(.white)
                        .font(.system(size: 17, weight: .semibold))
                }
                .frame(width: 40, height: 40)
                VStack(alignment: .leading, spacing: 1) {
                    Text(title)
                        .fontWeight(.semibold)
                        .foregroundStyle(Eb.textPrimary)
                        .lineLimit(1)
                    Text(subtitle)
                        .font(.footnote)
                        .foregroundStyle(Eb.textMuted)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            .padding(12)
            .background(Eb.surface200, in: RoundedRectangle(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Eb.borderStrong))
        }
        .buttonStyle(.plain)
    }

    private func centeredMessage(_ text: String, retry: (() -> Void)?) -> some View {
        VStack(spacing: 12) {
            Text(text)
                .foregroundStyle(Eb.textMuted)
                .multilineTextAlignment(.center)
            if let retry {
                Button("Повторить", action: retry)
                    .buttonStyle(.borderedProminent)
                    .tint(Eb.brand)
            }
        }
        .padding(24)
    }
}

/// Своё присутствие → (метка, цвет) для своей строки, зеркало веб-точки статуса.
private func selfPresenceLabel(_ status: String) -> (String, Color) {
    switch status.uppercased() {
    case "ONLINE": return ("в сети", Eb.online)
    case "BACKGROUND": return ("в фоне", Eb.presenceBg)
    case "AWAY": return ("не активен", Eb.away)
    case "IN_CALL": return ("в звонке", Eb.online)
    default: return ("не в сети", offlineDot)
    }
}

/// Логотип с периодическим переворотом «Б» — зеркало веб-`.logo .b { animation: flipY 5s }`.
struct AnimatedWordmark: View {
    @State private var flip = false

    var body: some View {
        HStack(spacing: 0) {
            Text("Е").foregroundStyle(Eb.logoCream)
            Text("Б")
                .foregroundStyle(Eb.logoB)
                .rotation3DEffect(
                    .degrees(flip ? 360 : 0),
                    axis: (x: 0, y: 1, z: 0),
                    perspective: 0.5
                )
            Text("луша").foregroundStyle(Eb.logoCream)
        }
        .font(.system(size: 34, weight: .heavy))
        .task {
            // Цикл 5 с: 85% покоя, затем полный оборот (как keyframes в оригинале).
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(4.25))
                withAnimation(.easeInOut(duration: 0.75)) { flip = true }
                try? await Task.sleep(for: .seconds(0.75))
                var t = Transaction()
                t.disablesAnimations = true
                withTransaction(t) { flip = false }
            }
        }
    }
}

// MARK: - Плитка беседы

private struct ConversationTile: View {
    let c: Conversation
    var typing = false
    var hasCloudSibling = false
    var onMarkRead: (() -> Void)?
    var onDelete: (() -> Void)?
    let onTap: () -> Void

    private var borderColor: Color {
        if c.isSecretV2 { return secretGreen.opacity(0.45) }
        if c.unreadCount > 0 { return Eb.brand600 } // веб: непрочитанные ярче онлайна
        if c.online && !c.isGroup { return Eb.brand }
        return Eb.borderStrong
    }

    var body: some View {
        HStack(spacing: 12) {
            if c.isSecretV2 {
                // Секретная плитка: замок ВМЕСТО аватара — без фото и точки присутствия.
                ZStack {
                    Circle().fill(secretGreen.opacity(0.12))
                    Image(systemName: "lock.fill")
                        .foregroundStyle(secretGreen)
                        .font(.system(size: 18))
                }
                .frame(width: 46, height: 46)
            } else {
                ZStack(alignment: .bottomTrailing) {
                    AvatarView(name: c.title, avatarUrl: c.avatarUrl, size: 46)
                    if !c.isGroup {
                        PresenceBadge(
                            userId: c.otherUserId,
                            status: c.otherStatus ?? (c.online ? "ONLINE" : "OFFLINE"),
                            onlineFallback: c.online
                        )
                    }
                }
            }

            VStack(alignment: .leading, spacing: 2) {
                if c.isSecretV2 {
                    Text(hasCloudSibling ? "СЕКРЕТНЫЙ ЧАТ" : "СЕКРЕТНЫЙ ЧАТ · \(c.title)")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Eb.textPrimary)
                        .lineLimit(1)
                } else {
                    Text(c.isSecret ? "🔒 \(c.title)" : c.title)
                        .font(.body.weight(.semibold))
                        .foregroundStyle(Eb.textPrimary)
                        .lineLimit(1)
                    // Веб-приоритет строки: «печатает…» → «N непрочитанных» → присутствие.
                    if let (subtitle, color) = subtitleLine {
                        Text(subtitle)
                            .font(.footnote)
                            .foregroundStyle(color)
                            .lineLimit(1)
                    }
                }
            }
            Spacer(minLength: 4)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .frame(minHeight: 64)
        .background(Eb.surface200, in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(borderColor, lineWidth: 1.5))
        .shadow(color: .black.opacity(0.25), radius: 3, y: 1)
        .padding(.leading, c.isSecretV2 ? 14 : 0) // веб: секретка с отступом под родителем
        .contentShape(Rectangle())
        .onTapGesture(perform: onTap)
        .contextMenu {
            if let onMarkRead {
                Button {
                    onMarkRead()
                } label: {
                    Label("Отметить прочитанным", systemImage: "checkmark.circle")
                }
            }
            if let onDelete {
                Button(role: .destructive) {
                    onDelete()
                } label: {
                    Label(
                        c.isSecretV2 ? "Закрыть секретный чат"
                            : c.isGroup ? "Выйти из беседы" : "Удалить чат",
                        systemImage: "trash"
                    )
                }
            }
        }
    }

    private var subtitleLine: (String, Color)? {
        if typing { return ("печатает…", Eb.brand) }
        if c.unreadCount > 0 { return ("\(c.unreadCount) непрочитанных", Eb.brand600) }
        if c.isGroup { return nil }
        switch c.otherStatus?.uppercased() {
        case "ONLINE": return ("ОНЛАЙН", Eb.online)
        case "IN_CALL": return ("В ЗВОНКЕ", Eb.online)
        case "BACKGROUND": return ("В ФОНЕ", Eb.presenceBg)
        default:
            if c.online { return ("ОНЛАЙН", Eb.online) }
            if let lastSeen = c.otherLastSeen {
                return ("был(а) онлайн \(formatLastSeen(lastSeen))", Eb.textMuted)
            }
            return nil
        }
    }
}
