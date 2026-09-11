import SwiftUI

// Порт `ui/chat/ChatScreen.kt`: шапка, лента с ранами и пузырями, композер, выбор,
// пересылка, вьюер, голосовые, секретные карточки.
// Ещё не портированы: фоторедактор перед отправкой и экран участников группы.

private let runGapMs: Int64 = 5 * 60 * 1000

/// Сдвиг пузыря при свайпе-ответе. Отдельный объект на строку: во время жеста
/// перерисовывается только сам пузырь, а не вся ячейка и не вся лента.
final class MessageSwipeState: ObservableObject {
    @Published var offset: CGFloat = 0
    /// Рамка пузыря в координатах ячейки — по ней жесты понимают, куда лёг палец:
    /// свайп по входящему пузырю вправо — это ответ, а вправо мимо пузыря — «назад».
    var bubbleFrame: CGRect = .zero
    /// Рамки плиток фото (индекс среди фото сообщения → рамка в координатах ячейки):
    /// просмотрщик открывается из своей плитки и улетает обратно в актуальную.
    var tileFrames: [Int: CGRect] = [:]
}

/// Пузырь, который умеет уезжать вбок: как на Android — сдвигается сам пузырь, аватар и
/// галочки выбора стоят на месте, а за пузырём проявляется стрелка ответа. Входящие
/// едут вправо, свои — влево.
struct SwipeableBubble<Content: View>: View {
    @ObservedObject var state: MessageSwipeState
    let isMine: Bool
    @ViewBuilder let content: () -> Content

    var body: some View {
        content()
            .offset(x: state.offset)
            // Фон выравнивается по РАСКЛАДОЧНОЙ рамке, а offset — чисто визуальный сдвиг,
            // поэтому стрелка остаётся там, откуда уехал пузырь.
            .background(alignment: isMine ? .trailing : .leading) {
                Image(systemName: "arrowshape.turn.up.left.fill")
                    .font(.system(size: 20))
                    .foregroundStyle(Eb.brand)
                    .padding(.horizontal, 10)
                    .opacity(min(abs(state.offset) / 56, 1))
            }
            .onGeometryChange(for: CGRect.self) { $0.frame(in: .named("messageCell")) } action: {
                state.bubbleFrame = $0
            }
    }
}

/// Позднее сообщение продолжает ран раннего: тот же автор, оба не системные, в окне 5 мин.
/// Не private: ранами занимается MessageListView, собирая их один раз за проход.
func continuesRun(_ earlier: Message?, _ later: Message?) -> Bool {
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

// Цвета имён авторов — порт `chats/chatsColors.ts`. Цвет берётся по ПОЗИЦИИ участника в
// беседе, а не по хэшу от id: хэш в маленькой группе то и дело давал двоим один цвет
// (парадокс дней рождения). Хэш остался запасным путём для id вне беседы — например,
// автора пересланного сообщения из чужого чата.
private let nameColorPalette13: [Color] = [
    Color(hex: 0xB39DDB), Color(hex: 0xA5D6A7), Color(hex: 0x90CAF9), Color(hex: 0xFFCC80),
    Color(hex: 0xF48FB1), Color(hex: 0x80CBC4), Color(hex: 0xCE93D8), Color(hex: 0xFFAB91),
    Color(hex: 0x9FA8DA), Color(hex: 0xAED581), Color(hex: 0xFFECB3), Color(hex: 0xEF9A9A),
    Color(hex: 0x81D4FA),
]
/// Резерв для беседы больше 13 человек — ещё 13 различимых тонов (веб-паритет).
private let nameColorPalette26: [Color] = nameColorPalette13 + [
    Color(hex: 0x9575CD), Color(hex: 0x4DB6AC), Color(hex: 0x64B5F6), Color(hex: 0xFF8A65),
    Color(hex: 0xF06292), Color(hex: 0xBA68C8), Color(hex: 0x4FC3F7), Color(hex: 0x81C784),
    Color(hex: 0xDCE775), Color(hex: 0xFFD54F), Color(hex: 0xA1887F), Color(hex: 0x90A4AE),
    Color(hex: 0x7986CB),
]
/// `order` — позиция участника в отсортированном списке беседы (см. `participantOrder`).
func nameColorForUser(_ userId: String?, order: [String: Int]) -> Color {
    if let userId, let index = order[userId] {
        let palette = order.count > nameColorPalette13.count ? nameColorPalette26 : nameColorPalette13
        return palette[index % palette.count]
    }
    return nameColorPalette13[Int(hashStringToUint(userId)) % nameColorPalette13.count]
}

// Тёмный тинт входящих пузырей per-sender в ГРУППАХ — та же палитра, что у веба.
private let groupBubblePalette: [Color] = [
    Color(hex: 0x2A1F16), Color(hex: 0x1A2836), Color(hex: 0x152820), Color(hex: 0x281A2C),
    Color(hex: 0x162A2E), Color(hex: 0x2D2418), Color(hex: 0x1F2440), Color(hex: 0x223016),
    Color(hex: 0x301C22), Color(hex: 0x14222C), Color(hex: 0x2F2218), Color(hex: 0x241C30),
]
/// Фон входящего пузыря в группе берётся ТЕМ ЖЕ индексом участника, что и цвет имени —
/// поэтому «имя + фон» одного человека согласованы, а у разных авторов фоны не совпадают.
func groupIncomingBubbleBg(_ userId: String?, order: [String: Int]) -> Color {
    if let userId, let index = order[userId] {
        return groupBubblePalette[index % groupBubblePalette.count]
    }
    return groupBubblePalette[Int(hashStringToUint(userId)) % groupBubblePalette.count]
}

struct ChatView: View {
    let conversation: Conversation
    let onBack: () -> Void

    @StateObject private var vm: ChatViewModel
    @State private var editTarget: Message?
    @State private var editText = ""
    @State private var confirmDelete = false
    @State private var forwardSheet: ForwardRequest?
    /// Открытая галерея фото (nil — просмотрщик закрыт).
    @State private var gallery: PhotoViewerGallery?
    /// Что сделать, когда fullScreenCover просмотрщика полностью ушёл (лист пересылки
    /// поверх ещё закрывающегося cover система не показывает).
    @State private var pendingAfterGallery: (() -> Void)?
    @State private var userCard: UserCardSeed?
    /// Открытое вложение (видео в плеере, документ в системном просмотре).
    @State private var preview: AttachmentPreview?
    /// Идёт скачивание/расшифровка перед открытием.
    @State private var preparingAttachment = false
    /// Просьба к ленте вернуться к низу: выехала клавиатура, вырос композер, ушло своё
    /// сообщение. Счётчик, а не Bool, — важен сам факт события, а не состояние.
    @State private var pinToken = 0
    /// Счётчик своих отправок — по нему лента утягивается к низу даже из истории.
    @State private var sendToken = 0
    /// Мост к ленте: команды прокрутки и вопрос «палец на входящем пузыре?» для жеста назад.
    @StateObject private var listProxy = MessageListProxy()
    /// Сообщение, для которого открыт полный выбор эмодзи.
    @State private var reactionTarget: Message?
    /// Сообщение, для которого открыто меню действий.
    @State private var actionsTarget: Message?
    /// Быстрые слоты реакций: пересчитываются, когда пользователь выбрал новую.
    @State private var quickSlots = ReactionFavorites.defaults
    /// Высота композера в прошлом замере — по её приросту лента понимает, что её поджали.
    @State private var composerHeight: CGFloat = 0

    init(conversation: Conversation, onBack: @escaping () -> Void) {
        self.conversation = conversation
        self.onBack = onBack
        _vm = StateObject(wrappedValue: ChatViewModel(
            repo: AppContainer.shared.chatRepository,
            realtime: AppContainer.shared.realtimeClient,
            conversationId: conversation.id,
            secretRepo: AppContainer.shared.secretRepository
        ))
    }

    var body: some View {
        VStack(spacing: 0) {
            // Шапки в теле больше нет: её роль играет системная панель навигации
            // (см. headerToolbar ниже), разделитель под ней тоже рисует система.

            // Лента смонтирована всегда: пересоздание её на смене loading давало кадр
            // со спиннером и кадр с пустой лентой перед готовым экраном.
            MessageListView(
                    vm: vm,
                    proxy: listProxy,
                    isLoading: vm.ui.loading,
                    pinToken: pinToken,
                    sendToken: sendToken,
                    onForward: { forwardSheet = ForwardRequest(messages: [$0]) },
                    onOpenImage: { message, index, sourceFrame in
                        openGallery(from: message, imageIndex: index, sourceFrame: sourceFrame)
                    },
                    onOpenSender: { message in
                        // Тап по аватару отправителя в группе — карточка пользователя.
                        userCard = UserCardSeed(
                            userId: message.senderId,
                            name: message.senderName,
                            avatarUrl: message.senderAvatarUrl
                        )
                    },
                    onOpenAttachment: { openAttachment($0) },
                    onEdit: { message in
                        editText = message.content ?? ""
                        editTarget = message
                    },
                    onPickReaction: { reactionTarget = $0 },
                    onLongPress: { actionsTarget = $0 },
                    quickSlots: quickSlots
                )
                    // Карточки секретного треда (приглашение / ожидание / привязка
                    // устройства) ложатся поверх ленты, как в вебе и Android.
                    .overlay {
                        SecretChatOverlay(
                            ui: vm.ui,
                            title: conversation.title,
                            onAccept: { vm.acceptSecretInvite() },
                            onDecline: { vm.declineSecretInvite() },
                            onOpenScanner: { vm.openLinkScanner() },
                            onCloseScanner: { vm.closeLinkScanner() },
                            onScanned: { vm.onLinkScanned($0) },
                            onCodeChange: { vm.onLinkCodeChange($0) },
                            onSubmitCode: { vm.submitLinkCode() }
                        )
                    }
                    .overlay { emptyState }
                    .overlay {
                        if vm.ui.loading, vm.ui.messages.isEmpty {
                            ProgressView()
                        }
                    }

            if let error = vm.ui.error {
                HStack(spacing: 8) {
                    Text(error)
                        .font(.footnote)
                        .foregroundStyle(Eb.error)
                    Spacer(minLength: 4)
                    Image(systemName: "xmark")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Eb.error.opacity(0.8))
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .frame(maxWidth: .infinity)
                .background(Eb.error.opacity(0.12))
                .contentShape(Rectangle())
                .onTapGesture { vm.clearError() }
            }

            if vm.ui.selectionMode {
                SelectionActionBar(
                    count: vm.ui.selectedIds.count,
                    canDelete: vm.selectedMessages().contains { $0.isMine && !$0.deleted },
                    canForward: !vm.ui.isSecret,
                    onReply: { vm.replyToSelected() },
                    onForward: { forwardSheet = ForwardRequest(messages: vm.selectedMessages()) },
                    onCopy: {
                        let msgs = vm.selectedMessages().filter { !$0.isSystem }
                        UIPasteboard.general.string = msgs.map { $0.content ?? "" }.joined(separator: "\n")
                        vm.clearSelection()
                    },
                    onDelete: { vm.deleteSelected() },
                    onCancel: { vm.clearSelection() }
                )
            } else if vm.ui.secretInvite || vm.ui.secretWaiting {
                // Композер скрыт, пока приглашение не принято обеими сторонами.
                EmptyView()
            } else {
                ChatComposer(
                    conversationId: conversation.id,
                    staged: vm.ui.staged,
                    uploadProgress: vm.ui.uploadProgress,
                    replyingTo: vm.ui.replyingTo,
                    sending: vm.ui.sending,
                    restoredDraft: vm.ui.restoredDraft,
                    onClearReply: { vm.clearReply() },
                    onRemoveStaged: { vm.removeStaged($0) },
                    onCancelUpload: { vm.cancelUpload() },
                    onStageFiles: { vm.stageFiles($0) },
                    onError: { vm.setError($0) },
                    onDraftChanged: { vm.onInputChanged($0) },
                    onSend: { text in
                        // Своё сообщение обязано оказаться на виду, даже если человек
                        // читал историю: лента получает право утянуться к низу.
                        sendToken += 1
                        vm.send(text)
                    },
                    onSendStaged: { caption in
                        sendToken += 1
                        vm.sendStaged(caption)
                    },
                    onSendVoice: { data, duration, waveform in
                        sendToken += 1
                        vm.sendVoice(data, durationSec: duration, waveform: waveform)
                    },
                    onReplaceStaged: { index, file in vm.replaceStaged(at: index, with: file) },
                    onConsumeRestoredDraft: { vm.consumeRestoredDraft() },
                    onFocusChanged: { focused in
                        // Клавиатура поджимает ленту снизу — последнее сообщение уезжало
                        // под неё (порт KeepBottomVisibleOnKeyboard).
                        if focused { pinToken += 1 }
                    },
                    onHeightChanged: { height in
                        // Цитата ответа, чипы вложений, вторая строка текста: панель
                        // выросла — возвращаем низ на место.
                        let grew = height > composerHeight + 1
                        composerHeight = height
                        if grew { pinToken += 1 }
                    }
                )
            }
        }
        .background(Eb.paper)
        // Родная панель навигации вместо своей шапки: штатная кнопка «назад», по центру —
        // собеседник, справа — звонки и меню. Материал панели рисует система, свой фон
        // не подкладываем — иначе на iOS 26 пропадает стекло.
        .navigationTitle(conversation.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { headerToolbar }
        // Возврат в список чатов свайпом вправо из любой точки. Кроме входящих пузырей:
        // там свайп вправо — ответ на сообщение, лента об этом знает.
        .edgeSwipeBack(shouldBegin: { listProxy.backSwipeAllowed?($0) ?? true }) { onBack() }
        .onAppear {
            quickSlots = ReactionFavorites.quickSlots(userId: vm.currentUserId)
        }
        .onDisappear {
            vm.onDisappear()
        }
        .sheet(item: $editTarget) { target in
            editSheet(target)
        }
        .sheet(item: $forwardSheet) { request in
            ForwardPickerSheet(
                repo: AppContainer.shared.chatRepository,
                currentConversationId: conversation.id,
                onPick: { targetId in
                    vm.forward(targetConversationId: targetId, messages: request.messages)
                    forwardSheet = nil
                }
            )
            .presentationDetents([.medium, .large])
        }
        .sheet(item: $actionsTarget) { target in
            MessageActionsSheet(
                message: target,
                quickSlots: quickSlots,
                canForward: !vm.ui.isSecret,
                onReact: { emoji in
                    vm.react(target, emoji: emoji)
                    if !(target.reactions.first { $0.emoji == emoji }?.mine ?? false) {
                        ReactionFavorites.record(userId: vm.currentUserId, emoji: emoji)
                        quickSlots = ReactionFavorites.quickSlots(userId: vm.currentUserId)
                    }
                },
                onPickReaction: {
                    actionsTarget = nil
                    // Лист поверх листа система не покажет — даём первому закрыться.
                    Task { @MainActor in
                        try? await Task.sleep(for: .milliseconds(320))
                        reactionTarget = target
                    }
                },
                onReply: { vm.setReply(target) },
                onCopy: { UIPasteboard.general.string = target.content },
                onForward: { forwardSheet = ForwardRequest(messages: [target]) },
                onEdit: {
                    editText = target.content ?? ""
                    editTarget = target
                },
                onDelete: { vm.delete(messageId: target.id) },
                onSelect: { vm.startSelection(target.id) },
                onDismiss: { actionsTarget = nil }
            )
        }
        .sheet(item: $reactionTarget) { target in
            ReactionPickerSheet(
                onPick: { emoji in
                    vm.react(target, emoji: emoji)
                    // Запоминаем только постановку — как в вебе (recordReactionChoice).
                    if !(target.reactions.first { $0.emoji == emoji }?.mine ?? false) {
                        ReactionFavorites.record(userId: vm.currentUserId, emoji: emoji)
                        quickSlots = ReactionFavorites.quickSlots(userId: vm.currentUserId)
                    }
                    reactionTarget = nil
                },
                onDismiss: { reactionTarget = nil }
            )
        }
        .sheet(item: $userCard) { seed in
            UserCardSheet(
                seed: seed,
                onOpenConversation: { _ in userCard = nil },
                onDismiss: { userCard = nil }
            )
        }
        .fullScreenCover(item: $gallery, onDismiss: {
            let pending = pendingAfterGallery
            pendingAfterGallery = nil
            pending?()
        }) { gallery in
            PhotoViewerView(
                gallery: gallery,
                decrypt: vm.ui.isSecret ? { await vm.decryptSecretAttachment($0) } : nil,
                callbacks: galleryCallbacks
            )
            // Появление и уход анимирует сам просмотрщик (кадр вырастает из плитки и
            // улетает обратно) — системная шторка снизу тут только мешала бы.
            .presentationBackground(.clear)
        }
        .fullScreenCover(item: $preview) { item in
            if item.isVideo {
                VideoPlayerSheet(url: item.url, onClose: { preview = nil })
            } else {
                DocumentPreviewSheet(url: item.url)
            }
        }
        .overlay {
            if preparingAttachment {
                ZStack {
                    Color.black.opacity(0.35).ignoresSafeArea()
                    ProgressView().tint(.white)
                }
            }
        }
        // Приглашение доверенного устройства: QR + код + остаток TTL, затем «подключён».
        .sheet(isPresented: Binding(
            get: { vm.ui.linkInvite != nil || vm.ui.linkedOut != nil },
            set: { if !$0 { vm.dismissLinkInvite() } }
        )) {
            SecretDeviceLinkInviteSheet(
                invite: vm.ui.linkInvite,
                leftMs: vm.ui.linkInviteLeftMs,
                linkedOut: vm.ui.linkedOut,
                onRefresh: { vm.refreshLinkInvite() },
                onDismiss: { vm.dismissLinkInvite() }
            )
        }
        // Приглашение отклонено или отменено на другом устройстве — уходим с мёртвого экрана.
        .onChange(of: vm.ui.secretDeclined) { _, declined in
            if declined { onBack() }
        }
        .confirmationDialog(
            vm.ui.isSecret ? "Закрыть секретный чат?" : vm.ui.isGroup ? "Выйти из беседы?" : "Удалить чат?",
            isPresented: $confirmDelete,
            titleVisibility: .visible
        ) {
            Button(
                vm.ui.isSecret ? "Закрыть" : vm.ui.isGroup ? "Выйти" : "Удалить",
                role: .destructive
            ) {
                vm.deleteOrLeave(onDone: onBack)
            }
            Button("Отмена", role: .cancel) {}
        }
    }

    // MARK: - Просмотр фото

    /// Галерея — все фото загруженной истории в хронологическом порядке, как в Telegram,
    /// а не только фото тапнутого сообщения (так было в старом просмотрщике и в вебе).
    private func openGallery(from message: Message, imageIndex: Int, sourceFrame: CGRect?) {
        var items: [PhotoViewerItem] = []
        let source = vm.ui.messages.contains { $0.id == message.id } ? vm.ui.messages : [message]
        for m in source where !m.deleted && !m.isSystem {
            let trimmed = m.content?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let images = m.attachments.filter { $0.type == "IMAGE" }
            // В секретных чатах у чужих сообщений имя пустое — берём название беседы.
            let sender = m.senderName.isEmpty ? (m.isMine ? "Вы" : conversation.title) : m.senderName
            for (i, att) in images.enumerated() {
                items.append(PhotoViewerItem(
                    id: "\(m.id)#\(i)",
                    attachment: att,
                    messageId: m.id,
                    senderName: sender,
                    isMine: m.isMine,
                    createdAt: m.createdAt,
                    caption: trimmed.isEmpty ? nil : trimmed
                ))
            }
        }
        guard !items.isEmpty else { return }
        let start = items.firstIndex { $0.id == "\(message.id)#\(imageIndex)" } ?? 0
        // Просмотрщик показывается поверх (overFullScreen) и клавиатуру сам не прячет —
        // иначе она осталась бы торчать над кадром.
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        // Системную анимацию fullScreenCover глушим: кадр вырастает из плитки силами
        // самого просмотрщика, а шторка снизу поверх этого выглядела бы двойным движением.
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) {
            gallery = PhotoViewerGallery(
                items: items,
                startIndex: start,
                sourceFrame: sourceFrame,
                // Куда улетать при закрытии: лента могла проскроллиться, а кадр — смениться.
                sourceFrameProvider: { item in
                    let index = Int(item.id.split(separator: "#").last ?? "") ?? 0
                    return listProxy.tileFrameInWindow(messageId: item.messageId, index: index)
                }
            )
        }
    }

    private func closeGallery() {
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) { gallery = nil }
    }

    /// Кнопки просмотрщика: он сам закрывается с анимацией и лишь потом зовёт эти
    /// обработчики, поэтому здесь ничего закрывать не нужно.
    private var galleryCallbacks: PhotoViewerCallbacks {
        PhotoViewerCallbacks(
            onClose: { closeGallery() },
            onReply: { item in
                if let message = vm.ui.messages.first(where: { $0.id == item.messageId }) {
                    vm.setReply(message)
                }
            },
            onForward: { item in
                guard let message = vm.ui.messages.first(where: { $0.id == item.messageId }) else { return }
                pendingAfterGallery = { forwardSheet = ForwardRequest(messages: [message]) }
            },
            onDelete: { item in
                vm.delete(messageId: item.messageId)
            },
            onShowInChat: { item in
                listProxy.scrollToMessage(item.messageId)
                listProxy.highlightedId = item.messageId
            },
            // В секретных чатах нет ни пересылки, ни удаления у всех — кнопки прячем.
            canForward: !vm.ui.isSecret,
            canDelete: !vm.ui.isSecret
        )
    }

    // MARK: - Шапка (системная панель навигации)

    /// Содержимое панели навигации. Обычный режим: по центру аватар с названием и строкой
    /// статуса, справа — QR (секретный чат), видео, аудио и меню «…». Режим выбора: по центру
    /// счётчик, справа «Отмена»; SelectionActionBar снизу остаётся. Кнопка «назад» — штатная,
    /// её даёт NavigationStack, поэтому своей здесь нет.
    @ToolbarContentBuilder
    private var headerToolbar: some ToolbarContent {
        if vm.ui.selectionMode {
            ToolbarItem(placement: .principal) {
                // Тот же текст, что был в SelectionTopBar, — поведение экрана не меняется.
                Text(vm.ui.selectedIds.isEmpty ? "Выберите сообщения" : "Выбрано: \(vm.ui.selectedIds.count)")
                    .font(.body.weight(.semibold))
                    .lineLimit(1)
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button("Отмена") { vm.clearSelection() }
            }
        } else {
            ToolbarItem(placement: .principal) {
                headerTitle
            }
            ToolbarItemGroup(placement: .topBarTrailing) {
                // «Добавить устройство» в секретном чате (веб-паритет): раздать ключи по QR.
                // Зелёный — цвет секретных чатов, как замок в списке; остальное — системный тинт.
                if vm.ui.isSecret && vm.ui.secretReady {
                    Button {
                        vm.createLinkInvite()
                    } label: {
                        Label("Добавить устройство", systemImage: "qrcode")
                            .foregroundStyle(Color(hex: 0x86EFAC))
                    }
                }
                // Порт кнопок звонка из шапки ChatScreen.kt: сначала видео, потом аудио.
                // Разрешения CallManager добирает сам перед публикацией треков.
                Button {
                    AppContainer.shared.callManager.startOutgoing(
                        conversationId: conversation.id, title: conversation.title, video: true)
                } label: {
                    Label("Видеозвонок", systemImage: "video")
                }
                Button {
                    AppContainer.shared.callManager.startOutgoing(
                        conversationId: conversation.id, title: conversation.title, video: false)
                } label: {
                    Label("Позвонить", systemImage: "phone")
                }
                Menu {
                    if !vm.ui.isSecret {
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
                            vm.ui.isSecret ? "Закрыть секретный чат"
                                : vm.ui.isGroup ? "Выйти из беседы" : "Удалить чат",
                            systemImage: "trash"
                        )
                    }
                } label: {
                    Label("Ещё", systemImage: "ellipsis")
                }
            }
        }
    }

    /// Центр панели: аватар 34 + название + «печатает…»/статус. Шрифты чуть мельче, чем
    /// были в своей шапке, — две строки должны уместиться в 44 pt системной панели.
    /// В 1:1 тап по всей связке открывает карточку собеседника (веб-паритет), в группе — нет.
    private var headerTitle: some View {
        HStack(spacing: 8) {
            AvatarView(
                name: conversation.title,
                avatarUrl: vm.ui.headerAvatarUrl ?? conversation.avatarUrl,
                size: 34
            )
            VStack(alignment: .leading, spacing: 1) {
                Text(conversation.title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                // «Печатает…» вытесняет статусную строку (веб-паритет).
                if let typing = vm.ui.typingName {
                    // Раньше выводилось просто «Виктор…» — читалось как обрезанный текст.
                    Text(vm.ui.isGroup ? "\(typing) печатает…" : "печатает…")
                        .font(.caption)
                        .foregroundStyle(Eb.brand)
                        .lineLimit(1)
                } else if let subtitle = vm.ui.headerSubtitle {
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
        }
        // Цель нажатия — вся связка, а не только аватар: в панели он мелкий.
        .contentShape(Rectangle())
        .onTapGesture {
            if !vm.ui.isGroup, let peerId = vm.ui.peerUserId {
                userCard = UserCardSeed(
                    userId: peerId, name: conversation.title, avatarUrl: conversation.avatarUrl
                )
            }
        }
    }

    /// Пустая беседа и несостоявшаяся загрузка: раньше и то и другое выглядело как
    /// пустая серая область, в которой непонятно, сломалось что-то или нет.
    @ViewBuilder
    private var emptyState: some View {
        if !vm.ui.loading, vm.ui.messages.isEmpty, !vm.ui.secretInvite, !vm.ui.secretWaiting {
            VStack(spacing: 10) {
                if vm.ui.error != nil {
                    Image(systemName: "wifi.exclamationmark")
                        .font(.largeTitle)
                        .foregroundStyle(Eb.textMuted)
                    Text("Не удалось загрузить переписку")
                        .font(.subheadline)
                        .foregroundStyle(Eb.textMuted)
                    Button("Повторить") {
                        vm.clearError()
                        vm.load()
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(Eb.brand)
                } else {
                    Text("Сообщений пока нет")
                        .font(.subheadline)
                        .foregroundStyle(Eb.textMuted)
                    Text("Напишите первым")
                        .font(.footnote)
                        .foregroundStyle(Eb.textMuted.opacity(0.7))
                }
            }
            .padding(24)
        }
    }

    /// Тап по видео/файлу: секретное расшифровываем, обычное скачиваем и показываем
    /// системным просмотром (сетевой URL прокси требует токен, QuickLook его не пошлёт).
    private func openAttachment(_ att: MessageAttachment) {
        guard !preparingAttachment else { return }
        preparingAttachment = true
        Task { @MainActor in
            defer { preparingAttachment = false }
            let decrypt: ((MessageAttachment) async -> URL?)? = vm.ui.isSecret
                ? { await vm.decryptSecretAttachment($0) } : nil
            if let ready = await AttachmentOpener.prepare(att, decryptSecret: decrypt) {
                preview = ready
            } else {
                vm.setError("Не удалось открыть вложение")
            }
        }
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

struct MessageRow: View {
    let m: Message
    let isGroup: Bool
    let senderAvatarUrl: String?
    /// Имена по id отправителя — для подписи плитки цитаты («кому отвечают»).
    var senderNames: [String: String] = [:]
    /// Позиция участника беседы → слот в палитре имени и фона пузыря (веб-паритет).
    var participantOrder: [String: Int] = [:]
    let isFirstInRun: Bool
    let isLastInRun: Bool
    let selectionMode: Bool
    /// Размер экрана — из него считается плитка картинки (веб делает то же от vw/vh).
    var screenSize: CGSize = UIScreen.main.bounds.size
    let selected: Bool
    /// Строка вспыхивает после перехода по цитате — чтобы глаз её нашёл.
    let highlighted: Bool
    var onQuoteTap: ((String) -> Void)?
    let onTap: () -> Void
    let onStartSelect: () -> Void
    let onForward: () -> Void
    /// Индекс среди фото сообщения и рамка плитки в координатах ячейки («messageCell»).
    let onOpenImage: (Int, CGRect?) -> Void
    var onOpenSender: (() -> Void)?
    /// Расшифровка секретного вложения в локальный файл (в обычном чате не зовётся).
    var decryptSecretAttachment: ((MessageAttachment) async -> URL?)?
    let onOpenAttachment: (MessageAttachment) -> Void
    let onReply: () -> Void
    let onReact: (String) -> Void
    /// Открыть полный выбор эмодзи (лист живёт на экране беседы).
    let onPickReaction: () -> Void
    /// Сдвиг пузыря при свайпе-ответе; объект живёт в контроллере ленты.
    var swipe = MessageSwipeState()
    /// Быстрые слоты — считает лента, чтобы не читать UserDefaults на каждую строку.
    var quickSlots: [String] = ReactionFavorites.defaults
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
                .background(
                selected ? Eb.brand.opacity(0.14)
                    : (highlighted ? Eb.brand.opacity(0.18) : Color.clear)
            )
            .animation(.easeOut(duration: 0.7), value: highlighted)
                .contentShape(Rectangle())
                .onTapGesture { if selectionMode { onTap() } }
        } else {
            // Галки выбора по краям (у входящих слева, у своих справа), фон выбранной
            // строки, тап всей строкой в режиме выбора; свайп-ответ на самом пузыре.
            HStack(alignment: .center, spacing: 0) {
                if selectionMode && !m.isMine {
                    SelectionCheck(selected: selected)
                        .padding(.leading, 2)
                        .padding(.trailing, 6)
                }
                HStack(alignment: .bottom, spacing: 6) {
                    if m.isMine { Spacer(minLength: 40) }
                    if isGroup && !m.isMine {
                        // Слот аватара: виден только у последнего в ране, но место держат все.
                        Group {
                            if isLastInRun {
                                AvatarView(name: m.senderName, avatarUrl: senderAvatarUrl, size: 28)
                                    .onTapGesture { onOpenSender?() }
                            } else {
                                Color.clear.frame(width: 28, height: 28)
                            }
                        }
                    }
                    // Свайп-ответ: сам жест живёт на коллекции (MessageListView), а здесь
                    // только визуальная часть — едет пузырь, стрелка проявляется за ним.
                    SwipeableBubble(state: swipe, isMine: m.isMine) { bubble }
                    if !m.isMine { Spacer(minLength: 40) }
                }
                if selectionMode && m.isMine {
                    SelectionCheck(selected: selected)
                        .padding(.leading, 6)
                        .padding(.trailing, 2)
                }
            }
            .background(
                selected ? Eb.brand.opacity(0.14)
                    : (highlighted ? Eb.brand.opacity(0.18) : Color.clear)
            )
            // Вспышка после перехода по цитате: быстро загорается, медленно гаснет —
            // ровно как в системной ветке выше (порт jumpHighlight).
            .animation(.easeOut(duration: highlighted ? 0.16 : 0.7), value: highlighted)
            .contentShape(Rectangle())
            .onTapGesture { if selectionMode { onTap() } }
            .padding(.top, isFirstInRun ? 8 : 2)
            .padding(.bottom, 1)
        }
    }

    /// Автор цитаты: сначала имя из загруженной истории, потом — «вы» для своих.
    private func replyAuthorName(_ reply: ReplyInfo) -> String? {
        if let name = senderNames[reply.senderId], !name.isEmpty { return name }
        return nil
    }

    /// Время, пометка «изм.» и галочки квитанций — одной строкой.
    private var metaRow: some View {
        HStack(spacing: 4) {
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

    // Веб-пузыри: свои #303845 (серые) справа, входящие #191d23; в группах входящие
    // тонированы per-sender.
    private var bubbleColor: Color {
        if m.isMine { return Eb.bubbleOut }
        if isGroup { return groupIncomingBubbleBg(m.senderId, order: participantOrder) }
        return Eb.bubbleIn
    }

    private var bubble: some View {
        VStack(alignment: .leading, spacing: 4) {
            if isGroup && !m.isMine && isFirstInRun {
                Text(m.senderName)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(nameColorForUser(m.senderId, order: participantOrder))
            }

            if let forward = m.forwardFrom {
                Text("↪ переслано от \(forward.authorName)")
                    .font(.caption)
                    .foregroundStyle(Eb.textMuted)
                    .italic()
            }

            ForEach(m.replyTo, id: \.id) { reply in
                HStack(spacing: 6) {
                    // Полоса цитаты — цвета автора, как в вебе: по ней взгляд отличает,
                    // кому отвечают, ещё до чтения имени.
                    Rectangle()
                        .fill(nameColorForUser(reply.senderId, order: participantOrder))
                        .frame(width: 2)
                    VStack(alignment: .leading, spacing: 1) {
                        // Имя автора цитаты: без него плитка была безымянной серой
                        // полоской и было непонятно, кому вообще отвечают.
                        if let author = replyAuthorName(reply) {
                            Text(author)
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(nameColorForUser(reply.senderId, order: participantOrder))
                                .lineLimit(1)
                        }
                        Text(reply.content?.isEmpty == false ? reply.content! : "Вложение")
                            .font(.caption)
                            .foregroundStyle(Eb.textMuted)
                            .lineLimit(2)
                    }
                }
                .padding(.vertical, 3)
                .padding(.horizontal, 6)
                .background(Color.white.opacity(0.05), in: RoundedRectangle(cornerRadius: 6))
                .contentShape(Rectangle())
                .onTapGesture { onQuoteTap?(reply.id) }
            }

            attachmentsView

            if let content = m.content, !content.isEmpty {
                MessageTextView(content: content, deleted: m.deleted)
            }

            if let preview = m.linkPreview {
                linkPreviewCard(preview)
            }

            if !m.reactions.isEmpty {
                HStack(spacing: 4) {
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
            }

            // Невидимая копия метки времени держит ширину пузыря, а видимая лежит
            // оверлеем в правом нижнем углу. Раньше в этой строке стоял Spacer, и он
            // растягивал КАЖДЫЙ пузырь до предела: короткое «ок» рисовалось плитой в
            // пол-экрана.
            metaRow.hidden()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .overlay(alignment: .bottomTrailing) {
            metaRow
                .padding(.trailing, 12)
                .padding(.bottom, 8)
        }
        .background(bubbleColor, in: RoundedRectangle(cornerRadius: 14))
        .overlay(
            RoundedRectangle(cornerRadius: 14).strokeBorder(Color.white.opacity(0.04))
        )
        // Долгое нажатие (своё меню вместо системного contextMenu) живёт на коллекции
        // ленты как UIKit-жест: SwiftUI-модификатор здесь перехватывал касание у прокрутки.
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
            if images.count == 1, let att = images.first {
                // Одиночная картинка — точный размер из метаданных, как в вебе.
                let size = att.displaySize(screen: screenSize)
                attachmentImage(att, width: size.width, height: size.height)
                    .onGeometryChange(for: CGRect.self) { $0.frame(in: .named("messageCell")) } action: {
                        swipe.tileFrames[0] = $0
                    }
                    .onTapGesture {
                        if selectionMode { onTap() } else { onOpenImage(0, swipe.tileFrames[0]) }
                    }
            } else {
                // Альбом: квадратные плитки в две колонки — соседи с разными пропорциями
                // иначе рвут сетку.
                let side = min(screenSize.width - 120, 320) / 2 - 2
                LazyVGrid(columns: columns, spacing: 3) {
                    ForEach(Array(images.enumerated()), id: \.offset) { idx, att in
                        attachmentImage(att, width: side, height: side)
                            .onGeometryChange(for: CGRect.self) { $0.frame(in: .named("messageCell")) } action: {
                                swipe.tileFrames[idx] = $0
                            }
                            .onTapGesture {
                                if selectionMode { onTap() } else { onOpenImage(idx, swipe.tileFrames[idx]) }
                            }
                    }
                }
            }
        }
        ForEach(Array(files.enumerated()), id: \.offset) { _, att in
            if att.type == "AUDIO" {
                // «AUDIO» → waveform-плеер вместо файловой строки (порт AttachmentView).
                if att.secretNonce != nil {
                    // В секретке по url лежит ШИФРТЕКСТ: AVPlayer на него давал молчащий
                    // пузырь. Плеер получает файл только после расшифровки ключом треда —
                    // веб-паритет (ChatMessageRow.tsx, ветка decryptPending у AUDIO).
                    SecretVoiceMessagePlayer(
                        att: att,
                        durationSec: m.audioDurationSec,
                        waveform: m.waveform,
                        decrypt: decryptSecretAttachment
                    )
                } else {
                    VoiceMessagePlayer(url: att.url, durationSec: m.audioDurationSec, waveform: m.waveform)
                }
            } else {
                fileRow(att)
            }
        }
    }

    /// Слот под картинку задаётся ДО загрузки и не меняется после неё: размер считается
    /// из метаданных вложения ровно как в вебе, поэтому лента не прыгает, а портретные
    /// кадры показываются целиком, а не обрезанными по центру.
    private func attachmentImage(_ att: MessageAttachment, width: CGFloat, height: CGFloat) -> some View {
        // Секретное вложение по своему url отдаёт ШИФРТЕКСТ — его нельзя показывать
        // напрямую: сначала расшифровываем ключом треда в кэш-файл (порт rememberSecretDecrypted).
        if att.secretNonce != nil {
            return AnyView(
                SecretImageView(att: att, decrypt: decryptSecretAttachment)
                    .frame(width: width, height: height)
                    .clipShape(RoundedRectangle(cornerRadius: 10))
            )
        }
        return AnyView(plainAttachmentImage(att, width: width, height: height))
    }

    private func plainAttachmentImage(_ att: MessageAttachment, width: CGFloat, height: CGFloat) -> some View {
        let url = thumbMediaUrl(att.url).flatMap { URL(string: $0) }
        // contentMode .fit, как objectFit: contain в вебе: у людей перестают отрезаться
        // головы, а у скриншотов — верх и низ.
        return CachedImage(url: url, contentMode: .fit) {
            Rectangle().fill(Eb.surface100)
        }
        .frame(width: width, height: height)
        .background(Eb.surface100)
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    private func fileRow(_ att: MessageAttachment) -> some View {
        Button {
            if selectionMode { onTap() } else { onOpenAttachment(att) }
        } label: {
            fileRowLabel(att)
        }
        .buttonStyle(.plain)
    }

    private func fileRowLabel(_ att: MessageAttachment) -> some View {
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
            Spacer(minLength: 4)
            Image(systemName: att.type == "VIDEO" ? "play.circle" : "arrow.down.circle")
                .foregroundStyle(Eb.textMuted)
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
                CachedImage(url: url, contentMode: .fill)
                    .frame(maxWidth: .infinity)
                    .aspectRatio(1.9, contentMode: .fit)
                    .clipped()
                    .clipShape(RoundedRectangle(cornerRadius: 6))
            }
        }
        .padding(8)
        .background(Color.white.opacity(0.05), in: RoundedRectangle(cornerRadius: 8))
        .overlay(alignment: .leading) {
            Rectangle().fill(Eb.brand).frame(width: 2)
        }
        .contentShape(Rectangle())
        // Карточка теперь кликабельна целиком: раньше открыть ссылку можно было, только
        // попав пальцем в сам url в тексте выше.
        .onTapGesture {
            if selectionMode {
                onTap()
            } else if let url = URL(string: preview.url) {
                UIApplication.shared.open(url)
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
