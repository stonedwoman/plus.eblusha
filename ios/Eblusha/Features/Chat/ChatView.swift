import SwiftUI

// Порт ядра `ui/chat/ChatScreen.kt`: шапка, лента с ранами и пузырями, композер.
// Пока не портированы (следующие итерации фазы 3 и фазы 6): свайп-ответ, мультивыбор,
// пересылка, полноэкранный просмотр фото, голосовые, вложения из пикера, фоторедактор,
// участники группы, переход к цитате, секретный режим.

private let runGapMs: Int64 = 5 * 60 * 1000

/// Позднее сообщение продолжает ран раннего: тот же автор, оба не системные, в окне 5 мин.
private func continuesRun(_ earlier: Message?, _ later: Message?) -> Bool {
    guard let earlier, let later else { return false }
    if earlier.isSystem || later.isSystem { return false }
    if earlier.senderId != later.senderId { return false }
    let gap = later.createdAt - earlier.createdAt
    return gap >= 0 && gap <= runGapMs
}

/// Зеркало веб-`hashStringToUint`: катящийся 31-хэш как беззнаковое 32-битное.
private func hashStringToUint(_ s: String?) -> UInt32 {
    guard let s, !s.isEmpty else { return 0 }
    var h: UInt64 = 0
    for c in s.unicodeScalars { h = (h &* 31 &+ UInt64(c.value)) & 0xFFFF_FFFF }
    return UInt32(h)
}

// Стабильный цвет имени per-user — та же палитра и хэш, что у веба (nameColorForUser).
private let nameColorPalette: [Color] = [
    Color(hex: 0xB39DDB), Color(hex: 0xA5D6A7), Color(hex: 0x90CAF9), Color(hex: 0xFFCC80),
    Color(hex: 0xF48FB1), Color(hex: 0x80CBC4), Color(hex: 0xCE93D8), Color(hex: 0xFFAB91),
    Color(hex: 0x9FA8DA), Color(hex: 0xAED581), Color(hex: 0xFFECB3), Color(hex: 0xEF9A9A),
    Color(hex: 0x81D4FA),
]
private func nameColorForUser(_ userId: String?) -> Color {
    nameColorPalette[Int(hashStringToUint(userId)) % nameColorPalette.count]
}

// Тёмный тинт входящих пузырей per-sender в ГРУППАХ — та же палитра, что у веба.
private let groupBubblePalette: [Color] = [
    Color(hex: 0x2A1F16), Color(hex: 0x1A2836), Color(hex: 0x152820), Color(hex: 0x281A2C),
    Color(hex: 0x162A2E), Color(hex: 0x2D2418), Color(hex: 0x1F2440), Color(hex: 0x223016),
    Color(hex: 0x301C22), Color(hex: 0x14222C), Color(hex: 0x2F2218), Color(hex: 0x241C30),
]
private func groupIncomingBubbleBg(_ userId: String?) -> Color {
    groupBubblePalette[Int(hashStringToUint(userId)) % groupBubblePalette.count]
}

/// Быстрые реакции контекстного меню (веб-паритет ReactionPicker quick row).
private let quickReactions = ["👍", "❤️", "😂", "🔥", "😮", "😢"]

struct ChatView: View {
    let conversation: Conversation
    let onBack: () -> Void

    @StateObject private var vm: ChatViewModel
    @State private var draft = ""
    @State private var editTarget: Message?
    @State private var editText = ""
    @State private var confirmDelete = false
    @FocusState private var composerFocused: Bool

    init(conversation: Conversation, onBack: @escaping () -> Void) {
        self.conversation = conversation
        self.onBack = onBack
        _vm = StateObject(wrappedValue: ChatViewModel(
            repo: AppContainer.shared.chatRepository,
            realtime: AppContainer.shared.realtimeClient,
            conversationId: conversation.id
        ))
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider().overlay(Eb.border)

            if vm.ui.isSecretStub {
                secretStub
            } else if vm.ui.loading {
                Spacer()
                ProgressView()
                Spacer()
            } else {
                messageList
            }

            if let error = vm.ui.error {
                Text(error)
                    .font(.footnote)
                    .foregroundStyle(Eb.error)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 6)
                    .background(Eb.error.opacity(0.12))
            }

            if !vm.ui.isSecretStub {
                composer
            }
        }
        .background(Eb.paper)
        .toolbar(.hidden, for: .navigationBar)
        .onDisappear { vm.onDisappear() }
        .onChange(of: vm.ui.restoredDraft) { _, restored in
            if let restored {
                draft = restored
                vm.consumeRestoredDraft()
            }
        }
        .sheet(item: $editTarget) { target in
            editSheet(target)
        }
        .confirmationDialog(
            vm.ui.isGroup ? "Выйти из беседы?" : "Удалить чат?",
            isPresented: $confirmDelete,
            titleVisibility: .visible
        ) {
            Button(vm.ui.isGroup ? "Выйти" : "Удалить", role: .destructive) {
                vm.deleteOrLeave(onDone: onBack)
            }
            Button("Отмена", role: .cancel) {}
        }
    }

    // MARK: - Шапка

    private var header: some View {
        HStack(spacing: 10) {
            Button(action: onBack) {
                Image(systemName: "chevron.backward")
                    .font(.title3)
                    .foregroundStyle(Eb.textPrimary)
                    .frame(width: 40, height: 40)
            }
            AvatarView(
                name: conversation.title,
                avatarUrl: vm.ui.headerAvatarUrl ?? conversation.avatarUrl,
                size: 38
            )
            VStack(alignment: .leading, spacing: 1) {
                Text(conversation.title)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(Eb.textPrimary)
                    .lineLimit(1)
                // «Печатает…» вытесняет статусную строку (веб-паритет).
                if let typing = vm.ui.typingName {
                    Text("\(typing)…")
                        .font(.footnote)
                        .foregroundStyle(Eb.brand)
                        .lineLimit(1)
                } else if let subtitle = vm.ui.headerSubtitle {
                    Text(subtitle)
                        .font(.footnote)
                        .foregroundStyle(Eb.textMuted)
                        .lineLimit(1)
                }
            }
            Spacer()
            Menu {
                if !vm.ui.isSecretStub {
                    Button {
                        vm.markAllRead()
                    } label: {
                        Label("Отметить прочитанным", systemImage: "checkmark.circle")
                    }
                }
                Button(role: .destructive) {
                    confirmDelete = true
                } label: {
                    Label(
                        vm.ui.isGroup ? "Выйти из беседы" : "Удалить чат",
                        systemImage: "trash"
                    )
                }
            } label: {
                Image(systemName: "ellipsis")
                    .foregroundStyle(Eb.textMuted)
                    .frame(width: 40, height: 40)
            }
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 4)
        .background(Eb.surface200)
    }

    // MARK: - Лента

    private var messageList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 0) {
                    if vm.ui.loadingOlder {
                        ProgressView()
                            .padding(.vertical, 8)
                    } else if vm.ui.hasMore {
                        // Триггер подгрузки назад: появление этой строки у верха экрана.
                        Color.clear
                            .frame(height: 1)
                            .onAppear { vm.loadOlder() }
                    }
                    let messages = vm.ui.messages
                    ForEach(Array(messages.enumerated()), id: \.element.id) { index, message in
                        let earlier = index > 0 ? messages[index - 1] : nil
                        let later = index + 1 < messages.count ? messages[index + 1] : nil
                        MessageRow(
                            m: message,
                            isGroup: vm.ui.isGroup,
                            senderAvatarUrl: vm.ui.senderAvatars[message.senderId] ?? nil,
                            isFirstInRun: !continuesRun(earlier, message),
                            isLastInRun: !continuesRun(message, later),
                            onReply: { vm.setReply(message) },
                            onReact: { vm.react(message, emoji: $0) },
                            onEdit: {
                                editText = message.content ?? ""
                                editTarget = message
                            },
                            onDelete: { vm.delete(messageId: message.id) }
                        )
                        .id(message.id)
                    }
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
            }
            .scrollDismissesKeyboard(.interactively)
            .defaultScrollAnchor(.bottom)
            .onChange(of: vm.ui.messages.last?.id) { _, lastId in
                if let lastId {
                    withAnimation(.easeOut(duration: 0.2)) {
                        proxy.scrollTo(lastId, anchor: .bottom)
                    }
                }
            }
        }
    }

    private var secretStub: some View {
        VStack(spacing: Spacing.lg) {
            Spacer()
            Image(systemName: "lock.fill")
                .font(.system(size: 44))
                .foregroundStyle(Color(hex: 0x22C55E))
            Text("Секретные чаты на iOS ещё в работе")
                .foregroundStyle(Eb.textPrimary)
            Text("Сквозное шифрование появится в одной из ближайших сборок.")
                .font(.footnote)
                .foregroundStyle(Eb.textMuted)
                .multilineTextAlignment(.center)
            Spacer()
        }
        .padding(.horizontal, Spacing.xl)
    }

    // MARK: - Композер

    private var composer: some View {
        VStack(spacing: 0) {
            if let reply = vm.ui.replyingTo.first {
                HStack(spacing: 8) {
                    Rectangle().fill(Eb.brand).frame(width: 3)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(reply.isMine ? "Вы" : reply.senderName)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(Eb.brand)
                        Text(reply.content ?? "Вложение")
                            .font(.caption)
                            .foregroundStyle(Eb.textMuted)
                            .lineLimit(1)
                    }
                    Spacer()
                    Button {
                        vm.clearReply()
                    } label: {
                        Image(systemName: "xmark")
                            .font(.caption)
                            .foregroundStyle(Eb.textMuted)
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(Eb.surface100)
            }

            HStack(alignment: .bottom, spacing: 8) {
                TextField("Сообщение", text: $draft, axis: .vertical)
                    .lineLimit(1...5)
                    .focused($composerFocused)
                    .foregroundStyle(Eb.textPrimary)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 9)
                    .background(Eb.surface100, in: RoundedRectangle(cornerRadius: 20))
                    .overlay(RoundedRectangle(cornerRadius: 20).strokeBorder(Eb.border))
                    .onChange(of: draft) { _, text in vm.onInputChanged(text) }

                Button {
                    let text = draft
                    draft = ""
                    vm.send(text)
                } label: {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 17, weight: .bold))
                        .foregroundStyle(.white)
                        .frame(width: 38, height: 38)
                        .background(
                            draft.trimmed().isEmpty || vm.ui.sending ? Eb.surface300 : Eb.brand,
                            in: Circle()
                        )
                }
                .disabled(draft.trimmed().isEmpty || vm.ui.sending)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
        }
        .background(Eb.surface200)
    }

    private func editSheet(_ target: Message) -> some View {
        NavigationStack {
            VStack(spacing: Spacing.lg) {
                TextField("Текст сообщения", text: $editText, axis: .vertical)
                    .lineLimit(3...10)
                    .padding(12)
                    .background(Eb.surface100, in: RoundedRectangle(cornerRadius: 12))
                    .foregroundStyle(Eb.textPrimary)
                Spacer()
            }
            .padding(Spacing.lg)
            .background(Eb.paper)
            .navigationTitle("Изменить")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Отмена") { editTarget = nil }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Сохранить") {
                        vm.edit(messageId: target.id, content: editText)
                        editTarget = nil
                    }
                    .disabled(editText.trimmed().isEmpty)
                }
            }
        }
        .presentationDetents([.medium])
    }
}

// MARK: - Строка сообщения

private struct MessageRow: View {
    let m: Message
    let isGroup: Bool
    let senderAvatarUrl: String?
    let isFirstInRun: Bool
    let isLastInRun: Bool
    let onReply: () -> Void
    let onReact: (String) -> Void
    let onEdit: () -> Void
    let onDelete: () -> Void

    var body: some View {
        if m.isSystem {
            Text(m.content ?? "")
                .font(.footnote)
                .foregroundStyle(Eb.textMuted)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 4)
        } else {
            HStack(alignment: .bottom, spacing: 6) {
                if m.isMine { Spacer(minLength: 40) }
                if isGroup && !m.isMine {
                    // Слот аватара: виден только у последнего в ране, но место держат все.
                    Group {
                        if isLastInRun {
                            AvatarView(name: m.senderName, avatarUrl: senderAvatarUrl, size: 28)
                        } else {
                            Color.clear.frame(width: 28, height: 28)
                        }
                    }
                }
                bubble
                if !m.isMine { Spacer(minLength: 40) }
            }
            .padding(.top, isFirstInRun ? 8 : 2)
            .padding(.bottom, 1)
        }
    }

    // Веб-пузыри: свои #303845 (серые) справа, входящие #191d23; в группах входящие
    // тонированы per-sender.
    private var bubbleColor: Color {
        if m.isMine { return Eb.bubbleOut }
        if isGroup { return groupIncomingBubbleBg(m.senderId) }
        return Eb.bubbleIn
    }

    private var bubble: some View {
        VStack(alignment: .leading, spacing: 4) {
            if isGroup && !m.isMine && isFirstInRun {
                Text(m.senderName)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(nameColorForUser(m.senderId))
            }

            if let forward = m.forwardFrom {
                Text("↪ переслано от \(forward.authorName)")
                    .font(.caption)
                    .foregroundStyle(Eb.textMuted)
                    .italic()
            }

            ForEach(m.replyTo, id: \.id) { reply in
                HStack(spacing: 6) {
                    Rectangle().fill(Eb.brand).frame(width: 2)
                    Text(reply.content ?? "Вложение")
                        .font(.caption)
                        .foregroundStyle(Eb.textMuted)
                        .lineLimit(2)
                }
                .padding(.vertical, 2)
                .padding(.horizontal, 6)
                .background(Color.white.opacity(0.05), in: RoundedRectangle(cornerRadius: 6))
            }

            attachmentsView

            if let content = m.content, !content.isEmpty {
                Text(content)
                    .font(m.deleted ? .subheadline.italic() : .subheadline)
                    .foregroundStyle(m.deleted ? Eb.textMuted : Eb.textPrimary)
            }

            if let preview = m.linkPreview {
                linkPreviewCard(preview)
            }

            HStack(spacing: 4) {
                if !m.reactions.isEmpty {
                    ForEach(m.reactions, id: \.emoji) { reaction in
                        Button {
                            onReact(reaction.emoji)
                        } label: {
                            Text("\(reaction.emoji) \(reaction.count)")
                                .font(.caption)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(
                                    reaction.mine ? Eb.brand.opacity(0.28) : Color.white.opacity(0.07),
                                    in: Capsule()
                                )
                                .foregroundStyle(Eb.textPrimary)
                        }
                        .buttonStyle(.plain)
                    }
                }
                Spacer(minLength: 8)
                if m.edited {
                    Text("изм.")
                        .font(.system(size: 10))
                        .foregroundStyle(Eb.textMuted)
                }
                Text(formatClockTime(m.createdAt))
                    .font(.system(size: 11))
                    .foregroundStyle(Eb.textMuted)
                if m.isMine {
                    receiptTicks
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .frame(maxWidth: 300, alignment: .leading)
        .background(bubbleColor, in: RoundedRectangle(cornerRadius: 14))
        .overlay(
            RoundedRectangle(cornerRadius: 14).strokeBorder(Color.white.opacity(0.04))
        )
        .contextMenu { contextMenu }
    }

    @ViewBuilder
    private var attachmentsView: some View {
        let images = m.attachments.filter { $0.type == "IMAGE" }
        let files = m.attachments.filter { $0.type != "IMAGE" }

        if !images.isEmpty {
            // Альбом: одна — во всю ширину, больше — сетка 2 колонки (упрощение веб-сетки).
            let columns = images.count == 1
                ? [GridItem(.flexible())]
                : [GridItem(.flexible(), spacing: 3), GridItem(.flexible(), spacing: 3)]
            LazyVGrid(columns: columns, spacing: 3) {
                ForEach(Array(images.enumerated()), id: \.offset) { _, att in
                    attachmentImage(att)
                }
            }
        }
        ForEach(Array(files.enumerated()), id: \.offset) { _, att in
            fileRow(att)
        }
    }

    private func attachmentImage(_ att: MessageAttachment) -> some View {
        Group {
            if let thumb = thumbMediaUrl(att.url), let url = URL(string: thumb) {
                AsyncImage(url: url) { phase in
                    if let image = phase.image {
                        image.resizable().scaledToFill()
                    } else {
                        Rectangle().fill(Eb.surface300)
                            .overlay(ProgressView())
                    }
                }
            } else {
                Rectangle().fill(Eb.surface300)
            }
        }
        .frame(minHeight: 90, maxHeight: 220)
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    private func fileRow(_ att: MessageAttachment) -> some View {
        HStack(spacing: 8) {
            Image(systemName: att.type == "AUDIO" ? "mic.fill"
                : att.type == "VIDEO" ? "film" : "doc.fill")
                .foregroundStyle(Eb.brand)
            VStack(alignment: .leading, spacing: 1) {
                Text(att.name ?? (att.type == "AUDIO" ? "Голосовое" : "Файл"))
                    .font(.caption)
                    .foregroundStyle(Eb.textPrimary)
                    .lineLimit(1)
                if att.type == "AUDIO", let duration = m.audioDurationSec {
                    Text(String(format: "%d:%02d", duration / 60, duration % 60))
                        .font(.caption2)
                        .foregroundStyle(Eb.textMuted)
                } else if let size = att.size {
                    Text(ByteCountFormatter.string(fromByteCount: size, countStyle: .file))
                        .font(.caption2)
                        .foregroundStyle(Eb.textMuted)
                }
            }
        }
        .padding(6)
        .background(Color.white.opacity(0.05), in: RoundedRectangle(cornerRadius: 8))
    }

    private func linkPreviewCard(_ preview: LinkPreview) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            if let siteName = preview.siteName {
                Text(siteName)
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(Eb.brand)
            }
            if let title = preview.title {
                Text(title)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Eb.textPrimary)
                    .lineLimit(2)
            }
            if let description = preview.description {
                Text(description)
                    .font(.caption)
                    .foregroundStyle(Eb.textMuted)
                    .lineLimit(3)
            }
            if let imageUrl = resolveMediaUrl(preview.imageUrl), let url = URL(string: imageUrl) {
                AsyncImage(url: url) { phase in
                    if let image = phase.image {
                        image.resizable().scaledToFill()
                            .frame(maxHeight: 140)
                            .clipShape(RoundedRectangle(cornerRadius: 6))
                    }
                }
            }
        }
        .padding(8)
        .background(Color.white.opacity(0.05), in: RoundedRectangle(cornerRadius: 8))
        .overlay(alignment: .leading) {
            Rectangle().fill(Eb.brand).frame(width: 2)
        }
    }

    @ViewBuilder
    private var contextMenu: some View {
        // Быстрые реакции первой секцией.
        ForEach(quickReactions, id: \.self) { emoji in
            Button {
                onReact(emoji)
            } label: {
                Text(emoji)
            }
        }
        Divider()
        Button(action: onReply) {
            Label("Ответить", systemImage: "arrowshape.turn.up.left")
        }
        Button {
            UIPasteboard.general.string = m.content
        } label: {
            Label("Копировать", systemImage: "doc.on.doc")
        }
        if m.isMine && !m.deleted && m.type == "TEXT" {
            Button(action: onEdit) {
                Label("Изменить", systemImage: "pencil")
            }
        }
        if m.isMine && !m.deleted {
            Button(role: .destructive, action: onDelete) {
                Label("Удалить", systemImage: "trash")
            }
        }
    }

    private var receiptTicks: some View {
        // Галочки квитанций: одна — отправлено, две — доставлено, оранжевые — прочитано.
        HStack(spacing: -6) {
            Image(systemName: "checkmark")
            if m.receipt == .delivered || m.receipt == .read {
                Image(systemName: "checkmark")
            }
        }
        .font(.system(size: 10, weight: .bold))
        .foregroundStyle(m.receipt == .read ? Eb.brand : Eb.textMuted)
    }
}
