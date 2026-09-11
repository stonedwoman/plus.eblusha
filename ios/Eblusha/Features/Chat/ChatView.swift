import SwiftUI

// Порт `ui/chat/ChatScreen.kt`: шапка, лента с ранами и пузырями, композер, выбор,
// пересылка, вьюер, голосовые, секретные карточки.
// Ещё не портирован: фоторедактор перед отправкой.

/// Сдвиг пузыря при свайпе-ответе. Отдельный объект на строку: во время жеста
/// перерисовывается только сам пузырь, а не вся ячейка и не вся лента.
final class MessageSwipeState: ObservableObject {
    @Published var offset: CGFloat = 0
    /// Рамка пузыря в координатах ячейки — по ней жесты понимают, куда лёг палец:
    /// свайп по входящему пузырю вправо — это ответ, а вправо мимо пузыря — «назад».
    var bubbleFrame: CGRect = .zero
    /// Рамки плиток медиа (индекс среди медиа сообщения → рамка в координатах ячейки):
    /// просмотрщик открывается из своей плитки и улетает обратно в актуальную.
    /// Нумерация — Message.galleryMedia: сперва фото, затем видео.
    var tileFrames: [Int: CGRect] = [:]
    /// Индекс плитки, которую сейчас показывает открытый просмотрщик: её пузырь не рисует
    /// (гасит непрозрачностью, место оставляя за ней). Под летящей копией кадра не должно
    /// быть той же картинки — в альбоме кадр иначе приземляется на самого себя.
    /// @Published, потому что перерисовку строки запускает подписанный на этот объект
    /// SwipeToReplyRow: его body пересобирает content(), а тот уже читает свежее значение.
    @Published var hiddenTileIndex: Int?
}

/// Пузырь, который умеет уезжать вбок: как на Android — сдвигается сам пузырь, аватар и
/// галочки выбора стоят на месте, а за пузырём проявляется стрелка ответа. Входящие
/// едут вправо, свои — влево.
struct SwipeToReplyRow<Content: View>: View {
    @ObservedObject var state: MessageSwipeState
    @ViewBuilder let content: () -> Content

    /// Насколько близко к срабатыванию: кружок наливается по мере утягивания.
    /// Делитель 40 и клэмп — как в Telegram (alpha = |offset| / 40).
    private var progress: CGFloat { min(abs(state.offset) / 40, 1) }

    var body: some View {
        ZStack(alignment: .trailing) {
            // Кружок стоит у правого края НЕПОДВИЖНО, а строка уезжает влево и открывает
            // его — так это сделано в Telegram (узел лежит за правой границей строки).
            ReplyCircle(progress: progress)
                .padding(.trailing, 6)
                .allowsHitTesting(false)
            content()
                .offset(x: state.offset)
        }
    }
}

/// Кружок со стрелкой ответа: 33 pt, как в Telegram, растёт от 0.65 до 1 по мере утягивания.
private struct ReplyCircle: View {
    let progress: CGFloat

    var body: some View {
        ZStack {
            Circle().fill(Eb.surface300)
            Image(systemName: "arrowshape.turn.up.left.fill")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Eb.brand)
        }
        .frame(width: 33, height: 33)
        .scaleEffect(0.65 + progress * 0.35)
        .opacity(Double(progress))
    }
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
    /// Открытое меню действий: сообщение, снимок его пузыря и замороженный фон. Снимки
    /// делаются в момент долгого нажатия, поэтому здесь лежит готовая цель, а не сообщение.
    @State private var actionsTarget: MessageActionsTarget?
    /// Быстрые слоты реакций: пересчитываются, когда пользователь выбрал новую.
    @State private var quickSlots = ReactionFavorites.defaults
    /// Высота композера в прошлом замере — по её приросту лента понимает, что её поджали.
    @State private var composerHeight: CGFloat = 0
    /// Короткая галочка «Готово» после прихода ключа секретки (веб: secretBootDonePulse).
    /// Живёт во вью, а не в UiState: это анимация экрана, а не состояние беседы.
    @State private var secretDonePulse = false
    /// Открыт экран участников и настроек группы (шторкой, как модалки веба).
    @State private var groupSheet = false
    /// Беседа, перечитанная после правки названия/аватара на экране участников.
    /// `conversation` приезжает сюда значением из списка и о правке не узнаёт, а
    /// пересоздавать экран ради двух полей нельзя — потеряются позиция ленты и черновик.
    @State private var groupOverride: Conversation?

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
                        openGallery(from: message, mediaIndex: index, sourceFrame: sourceFrame)
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
                    onLongPress: { openActionsMenu(for: $0) },
                    quickSlots: quickSlots
                )
                    // Карточки секретного треда (приглашение / ожидание / привязка
                    // устройства) ложатся поверх ленты, как в вебе и Android.
                    .overlay {
                        SecretChatOverlay(
                            ui: vm.ui,
                            title: conversation.title,
                            bootstrapping: secretBootstrapping,
                            donePulse: secretDonePulse,
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

            // Итог действия («Переслано в «…»»): раньше пересылка уходила молча, и об
            // успехе — как и об отказе сервера — человек не узнавал вовсе.
            if let notice = vm.ui.notice {
                HStack(spacing: 8) {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.caption)
                        .foregroundStyle(Eb.brand)
                    Text(notice)
                        .font(.footnote)
                        .foregroundStyle(Eb.textPrimary)
                    Spacer(minLength: 4)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .frame(maxWidth: .infinity)
                .background(Eb.brand.opacity(0.12))
                .contentShape(Rectangle())
                .onTapGesture { vm.clearNotice() }
            }

            if vm.ui.selectionMode {
                SelectionActionBar(
                    count: vm.ui.selectedIds.count,
                    canDelete: vm.selectedMessages().contains { $0.isMine && !$0.deleted },
                    canForward: !vm.ui.isSecret,
                    onReply: { vm.replyToSelected() },
                    onForward: { forwardSheet = ForwardRequest(messages: vm.selectedMessages()) },
                    onCopy: {
                        // Не голый content: буфер получает «Переслано от …», цитаты и
                        // имена файлов — тот же текст, что кладёт веб.
                        copyMessagesToClipboard(vm.selectedMessages())
                        vm.clearSelection()
                    },
                    onDelete: { vm.deleteSelected() },
                    onCancel: { vm.clearSelection() }
                )
            } else if vm.ui.secretInvite || vm.ui.secretWaiting {
                // Композер скрыт, пока приглашение не принято обеими сторонами.
                EmptyView()
            } else {
                // Отложенная пересылка: что уйдёт, кнопка «Переслать» (когда в поле пусто —
                // там вместо стрелки микрофон) и крестик «Отменить». Набранный текст
                // становится комментарием к пересылке, как в вебе.
                if let draft = vm.ui.forwardDraft {
                    ForwardDraftBar(
                        draft: draft,
                        composerEmpty: vm.ui.composerEmpty,
                        sending: vm.ui.sending,
                        onSend: {
                            sendToken += 1
                            vm.sendForwardDraft(comment: nil)
                        },
                        onCancel: { vm.cancelForwardDraft() }
                    )
                }
                ChatComposer(
                    conversationId: conversation.id,
                    staged: vm.ui.staged,
                    uploadProgress: vm.ui.uploadProgress,
                    replyingTo: vm.ui.replyingTo,
                    sending: vm.ui.sending,
                    restoredDraft: vm.ui.restoredDraft,
                    // Плашки состояния защиты — первой строкой панели, как в вебе.
                    secretPending: vm.ui.isSecret && !vm.ui.secretReady,
                    secretQueued: vm.ui.secretQueued,
                    secretKeysErrorCode: vm.ui.secretKeysError,
                    secretKeysRetrying: vm.ui.secretKeysRetrying,
                    // «Привязать устройство» имеет смысл только новому устройству: забрать
                    // ключи можно лишь у СВОИХ, и лишь когда своих ключей здесь нет вовсе.
                    secretCanLinkDevice: vm.ui.hasOtherDevices && !vm.ui.hasAnySecretKeys,
                    onRetrySecretKeys: { vm.retrySecretKeys() },
                    onLinkDevice: { vm.openLinkScanner() },
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
        .navigationTitle(headerTitleText)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { headerToolbar }
        // Возврат в список чатов свайпом вправо из любой точки. Кроме входящих пузырей:
        // там свайп вправо — ответ на сообщение, лента об этом знает.
        .edgeSwipeBack(shouldBegin: { point in
            // Палец держит запись голосового — уход с экрана стёр бы её (композер зовёт
            // cancelAll в onDisappear). Пока держат, «назад» не начинается.
            guard !VoiceHoldGuard.isActive else { return false }
            return listProxy.backSwipeAllowed?(point) ?? true
        }) { onBack() }
        .onAppear {
            quickSlots = ReactionFavorites.quickSlots(userId: vm.currentUserId)
        }
        // Плашка пересылки поджимает ленту снизу так же, как цитата ответа: последнее
        // сообщение не должно уехать под неё (onHeightChanged знает только про композер).
        .onChange(of: vm.ui.forwardDraft != nil) { _, live in
            if live { pinToken += 1 }
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
                    // Тап по беседе НИЧЕГО не отправляет (веб: ChatModals.tsx:2815-2882):
                    // пересылка ложится черновиком, экран уезжает в беседу-получателя, и
                    // там к ней можно приписать комментарий и отправить кнопкой.
                    vm.stageForward(targetConversationId: targetId, messages: request.messages)
                    forwardSheet = nil
                },
                messageCount: request.messages.count
            )
            .presentationDetents([.medium, .large])
        }
        // Меню сообщения — не шторка, а оверлей: он сам поднимает пузырь над размытым
        // фоном и сам же рисует появление и уход, поэтому системную анимацию показа
        // глушим (см. openActionsMenu / closeActionsMenu).
        .fullScreenCover(item: $actionsTarget) { target in
            MessageActionsOverlay(
                target: target,
                quickSlots: quickSlots,
                canForward: !vm.ui.isSecret,
                // Пока меню открыто, лента могла сдвинуться пришедшими сообщениями —
                // копия возвращается в АКТУАЛЬНУЮ рамку строки, а не в снятую при открытии.
                bubbleFrameProvider: { id in listProxy.bubbleFrameInWindow(messageId: id) },
                onReact: { emoji in applyReaction(emoji, to: target.message) },
                onReply: { vm.setReply(target.message) },
                onCopy: { copyMessageToClipboard(target.message) },
                onForward: { forwardSheet = ForwardRequest(messages: [target.message]) },
                onEdit: {
                    editText = target.message.content ?? ""
                    editTarget = target.message
                },
                onDelete: { vm.delete(messageId: target.message.id) },
                onSelect: { vm.startSelection(target.message.id) },
                onClose: { closeActionsMenu() }
            )
        }
        // Полный выбор эмодзи с плашки реакций под пузырём. Из меню он теперь
        // раскрывается сам (оверлею есть откуда показать лист), и ожидание закрытия
        // шторки перед показом пикера больше не нужно.
        .sheet(item: $reactionTarget) { target in
            ReactionPickerSheet(
                onPick: { emoji in
                    applyReaction(emoji, to: target)
                    reactionTarget = nil
                },
                onDismiss: { reactionTarget = nil }
            )
        }
        // Участники и настройки группы. Именно шторкой, а не пушем в стек: стек здесь
        // принадлежит списку чатов, а возврат из беседы живёт на своём жесте
        // (edgeSwipeBack) — второй экран в том же стеке конфликтовал бы с ним.
        .sheet(isPresented: $groupSheet) {
            NavigationStack {
                GroupMembersView(
                    conversation: headerConversation,
                    showsCloseButton: true,
                    onClose: { groupSheet = false },
                    onUpdated: {
                        // Экран уже дождался обновления списка бесед — берём беседу из
                        // кеша репозитория целиком, чтобы не собирать её по полям.
                        Task { @MainActor in
                            groupOverride = await AppContainer.shared.chatRepository
                                .conversationMeta(conversation.id)
                        }
                    }
                )
            }
        }
        .sheet(item: $userCard) { seed in
            UserCardSheet(
                seed: seed,
                onOpenConversation: { _ in userCard = nil },
                onDismiss: { userCard = nil }
            )
        }
        .fullScreenCover(item: $gallery, onDismiss: {
            // Страховка от залипшей дыры в ленте: обычно плитку возвращает сам просмотрщик
            // (по концу полёта и в finishDismiss), но если обёртку сняли мимо него —
            // например, экран ушёл из иерархии — вернуть её больше некому.
            listProxy.hideTile(messageId: nil, index: 0)
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
        // Момент готовности защиты ничем не отмечался — короткая галочка «Готово», как в вебе.
        // Сигнал даёт вьюмодель (ui.secretKeyArrived), а не сам secretReady: в уже рабочей
        // секретке он поднимается при инициализации, и галочка мигала бы на каждом входе.
        .onChange(of: vm.ui.secretKeyArrived) { _, _ in
            guard vm.ui.isSecret else { return }
            secretDonePulse = true
            Task { @MainActor in
                try? await Task.sleep(for: .milliseconds(700))
                secretDonePulse = false
            }
        }
        .confirmationDialog(
            removalPrompt.title,
            isPresented: $confirmDelete,
            titleVisibility: .visible
        ) {
            Button(removalPrompt.action, role: .destructive) {
                vm.deleteOrLeave(onDone: onBack)
            }
            Button("Отмена", role: .cancel) {}
        } message: {
            // Раньше необратимое удаление переписки у ОБОИХ подтверждалось голым вопросом
            // из двух слов — без пояснения, которое в списке чатов есть.
            Text(removalPrompt.message)
        }
    }

    // MARK: - Меню сообщения

    /// Долгое нажатие по пузырю. Снимки (копия пузыря и замороженный экран) делаются
    /// ЗДЕСЬ, до показа: секундой позже на снимок попал бы уже затемнённый экран, а
    /// ячейка могла бы уехать. Системную анимацию показа глушим — подачу рисует оверлей.
    private func openActionsMenu(for message: Message) {
        let target = MessageActionsCapture.target(
            for: message, bubble: listProxy.bubbleCopy(messageId: message.id)
        )
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) { actionsTarget = target }
    }

    /// Оверлей зовёт это ПОСЛЕ своей анимации ухода — гасить его ещё и системной шторкой
    /// значило бы показать два движения подряд.
    private func closeActionsMenu() {
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) { actionsTarget = nil }
    }

    /// Реакция из меню и из полного выбора: ставим и запоминаем ТОЛЬКО постановку —
    /// как в вебе (recordReactionChoice), где снятие в быстрые слоты не попадает.
    private func applyReaction(_ emoji: String, to message: Message) {
        let alreadyMine = message.reactions.first { $0.emoji == emoji }?.mine ?? false
        vm.react(message, emoji: emoji)
        guard !alreadyMine else { return }
        ReactionFavorites.record(userId: vm.currentUserId, emoji: emoji)
        quickSlots = ReactionFavorites.quickSlots(userId: vm.currentUserId)
    }

    // MARK: - Просмотр фото

    /// Галерея — всё медиа загруженной истории в хронологическом порядке, как в Telegram,
    /// а не только вложения тапнутого сообщения (так было в старом просмотрщике и в вебе).
    /// Фото и видео идут одним списком: в пейджере они равноправные страницы.
    private func openGallery(from message: Message, mediaIndex: Int, sourceFrame: CGRect?) {
        var items: [PhotoViewerItem] = []
        let source = vm.ui.messages.contains { $0.id == message.id } ? vm.ui.messages : [message]
        for m in source where !m.deleted && !m.isSystem {
            let trimmed = m.content?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            // В секретных чатах у чужих сообщений имя пустое — берём название беседы.
            let sender = m.senderName.isEmpty ? (m.isMine ? "Вы" : conversation.title) : m.senderName
            for (i, att) in m.galleryMedia.enumerated() {
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
        let start = items.firstIndex { $0.id == "\(message.id)#\(mediaIndex)" } ?? 0
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
                    listProxy.tileFrameInWindow(
                        messageId: item.messageId, index: galleryTileIndex(item)
                    )
                },
                // Плитку текущего кадра лента не рисует: под открытым кадром и под летящей
                // копией не должно быть той же картинки. Снимается по концу полёта и на
                // всякий случай ещё раз в finishDismiss просмотрщика.
                setHiddenTile: { item in
                    listProxy.hideTile(
                        messageId: item?.messageId,
                        index: item.map { galleryTileIndex($0) } ?? 0
                    )
                }
            )
        }
    }

    /// Индекс кадра внутри сообщения, зашитый в id («<messageId>#<n>»): по нему лента
    /// находит плитку-источник. Нумерация — Message.galleryMedia (фото, затем видео).
    private func galleryTileIndex(_ item: PhotoViewerItem) -> Int {
        Int(item.id.split(separator: "#").last ?? "") ?? 0
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
            // Пролистали галерею — чат под ней подводит плитку нового кадра в видимую
            // область, иначе закрытие уходит не в плитку, а в затухание. Лента двигается
            // ТОЛЬКО когда строки не видно (revealIfNeeded), поэтому листание соседних
            // кадров одного сообщения её не трогает вовсе.
            onCurrentItemChanged: { item in
                listProxy.revealMessage(item.messageId)
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
                // Видео и трубка. Когда в беседе УЖЕ идёт звонок, те же две кнопки
                // означают «подключиться», а свой свёрнутый звонок — «развернуть»
                // (ChatHeaderCallButtons). Разрешения CallManager добирает сам.
                ChatHeaderCallButtons(
                    conversationId: conversation.id,
                    onStart: { video in
                        AppContainer.shared.callManager.startOutgoing(
                            conversationId: conversation.id, title: headerTitleText, video: video
                        )
                    },
                    onJoin: { video in
                        joinOrStartConversationCall(
                            conversationId: conversation.id, title: headerTitleText, video: video
                        )
                    },
                    onExpand: { AppContainer.shared.callManager.expand() }
                )
                Menu {
                    if vm.ui.isGroup {
                        // Веб-паритет меню шапки группы: добавить людей, сменить название
                        // и аватар. Раньше с телефона не было ни одного из трёх.
                        Button {
                            groupSheet = true
                        } label: {
                            Label("Участники и настройки", systemImage: "person.2")
                        }
                    }
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

    /// Центр панели навигации. Раньше это была своя связка на одной готовой строке
    /// `ui.headerSubtitle`, из-за чего в шапке не было ни «был(а) онлайн …», ни игры, ни
    /// идущего звонка, ни точки присутствия; всё это считает ChatHeaderTitle.
    private var headerTitle: some View {
        ChatHeaderTitle(
            model: ChatHeaderModel(
                conversationId: conversation.id,
                title: headerTitleText,
                avatarUrl: groupOverride?.avatarUrl ?? vm.ui.headerAvatarUrl ?? conversation.avatarUrl,
                isGroup: vm.ui.isGroup,
                peerUserId: vm.ui.peerUserId,
                peerStatus: vm.ui.peerStatus,
                peerLastSeen: vm.ui.peerLastSeen,
                typingName: vm.ui.typingName,
                groupSubtitle: vm.ui.headerSubtitle,
                secretState: vm.ui.isSecret ? secretProtectionState : nil
            ),
            onTap: {
                if vm.ui.isGroup {
                    // Тап по шапке группы — «Настройки группы» веба (MessagesPane.tsx:305-318).
                    groupSheet = true
                } else if let peerId = vm.ui.peerUserId {
                    userCard = UserCardSeed(
                        userId: peerId, name: headerTitleText,
                        avatarUrl: vm.ui.headerAvatarUrl ?? conversation.avatarUrl
                    )
                }
            }
        )
    }

    /// Беседа с учётом правок, сделанных на экране участников.
    private var headerConversation: Conversation { groupOverride ?? conversation }

    /// Название беседы с учётом переименования, сделанного на этом же экране.
    private var headerTitleText: String { headerConversation.title }

    /// Заголовок, пояснение и подпись кнопки подтверждения — общие со списком чатов,
    /// чтобы одно и то же действие не описывалось в двух местах по-разному.
    private var removalPrompt: (title: String, message: String, action: String) {
        ConversationRemovalPrompt.texts(isSecret: vm.ui.isSecret, isGroup: vm.ui.isGroup)
    }

    /// Секретка ещё не шифрует, и ни одна карточка экран не перехватила: показываем, что
    /// обмен ключами идёт. При сработавшем стороже спиннер гасим — вместо него над
    /// композером висит плашка «ключи не доехали» с кнопками.
    private var secretBootstrapping: Bool {
        vm.ui.isSecret && !vm.ui.secretReady && !vm.ui.secretInvite && !vm.ui.secretWaiting
            && vm.ui.secretKeysError == nil
            && !(vm.ui.hasOtherDevices && !vm.ui.hasAnySecretKeys)
    }

    /// Состояние защиты для чипа шапки (порт activeSecretUiState.readyState): ошибка
    /// важнее настройки, настройка — важнее «Защищено».
    private var secretProtectionState: SecretProtectionState {
        if vm.ui.secretKeysError != nil { return .failed }
        return vm.ui.secretReady ? .ready : .bootstrapping
    }

    /// Пустая беседа и несостоявшаяся загрузка: раньше и то и другое выглядело как
    /// пустая серая область, в которой непонятно, сломалось что-то или нет.
    @ViewBuilder
    private var emptyState: some View {
        // Во время настройки защиты на этом же месте крутится спиннер оверлея — две
        // подписи поверх друг друга читались бы как сломанный экран.
        if !vm.ui.loading, vm.ui.messages.isEmpty, !vm.ui.secretInvite, !vm.ui.secretWaiting,
           !secretBootstrapping, !secretDonePulse {
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
    /// Место сообщения в пачке пересылки — считает лента (computeForwardBundleSlots).
    /// nil у непересланного, а у пересланного без слота конверт рисуется сам по себе:
    /// шапка тогда собирается из одной этой пересылки.
    var forwardSlot: ForwardBundleSlot?
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
    /// Индекс среди медиа сообщения (Message.galleryMedia: фото, затем видео) и рамка
    /// плитки в координатах ячейки («messageCell»).
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

    /// Ещё не отправленное вложение: прогресс с отменой или пометка сбоя с повтором.
    /// Через окружение (как превью цитат): ставит ячейка ленты, см. MessageListView.
    @Environment(\.outgoingUpload) private var outgoingUpload

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
            // Свайп-ответ: жест живёт на коллекции (MessageListView), здесь только
            // визуальная часть. Влево уезжает ВСЯ строка — и свои, и входящие, как в
            // Telegram: одна сторона для всех, а не «наружу из своей колонки».
            SwipeToReplyRow(state: swipe) {
                HStack(alignment: .center, spacing: 0) {
                    if selectionMode && !m.isMine {
                        SelectionCheck(selected: selected)
                            .padding(.leading, 2)
                            .padding(.trailing, 6)
                    }
                    HStack(alignment: .bottom, spacing: 6) {
                        if m.isMine { Spacer(minLength: 40) }
                        if isGroup && !m.isMine {
                            // Слот аватара: виден только у последнего в ране, место держат все.
                            Group {
                                if isLastInRun {
                                    AvatarView(name: m.senderName, avatarUrl: senderAvatarUrl, size: 28)
                                        .onTapGesture { onOpenSender?() }
                                } else {
                                    Color.clear.frame(width: 28, height: 28)
                                }
                            }
                        }
                        // Рамку пузыря (в раскладочных координатах, без сдвига жеста) знает
                        // лента: по ней она решает, лёг ли палец на сообщение.
                        bubble
                            .onGeometryChange(for: CGRect.self) {
                                $0.frame(in: .named("messageCell"))
                            } action: {
                                swipe.bubbleFrame = $0
                            }
                        if !m.isMine { Spacer(minLength: 40) }
                    }
                    if selectionMode && m.isMine {
                        SelectionCheck(selected: selected)
                            .padding(.leading, 6)
                            .padding(.trailing, 2)
                    }
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

    /// Имя автора цитаты из уже загруженной истории. Пусто — карточка сама подставит
    /// «Участник» (веб-паритет: безымянная серая полоска не объясняла, кому отвечают).
    private func replyAuthorName(_ reply: ReplyInfo) -> String {
        senderNames[reply.senderId] ?? ""
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
                // Пузырь секретки, ждущий ключа, ещё НЕ отправлен: галочка «отправлено»
                // тут врала бы, поэтому у него часы — как только очередь уедет, пузырь
                // заменится серверным сообщением с обычными галочками.
                if SecretOutbox.isPending(m.id) || ChatViewModel.isOutgoingId(m.id) {
                    Image(systemName: "clock")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(Eb.textMuted)
                } else {
                    receiptTicks
                }
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

            // Цитата — мини-пузырь (ReplyQuoteCard): миниатюра оригинала, подпись и время,
            // фон и полоса тоном АВТОРА ЦИТАТЫ, как в вебе. Что именно показать (картинка
            // или текст), считает лента: серверный replyTo вложений не отдаёт, оригинал
            // виден только ей — карточка берёт это из окружения replyQuotePreviews.
            ForEach(m.replyTo, id: \.id) { reply in
                ReplyQuoteCard(
                    reply: reply,
                    authorName: replyAuthorName(reply),
                    accent: nameColorForUser(reply.senderId, order: participantOrder),
                    background: groupIncomingBubbleBg(reply.senderId, order: participantOrder),
                    decryptSecretAttachment: decryptSecretAttachment,
                    // В режиме выбора тап по карточке — это выбор строки, а не прыжок к
                    // оригиналу: иначе галочку нельзя было бы поставить по цитате.
                    onTap: { if selectionMode { onTap() } else { onQuoteTap?(reply.id) } }
                )
            }

            if let forward = m.forwardFrom {
                // Пересланное лежит в янтарном конверте, как в вебе: шапка «кто и откуда»
                // (у пачки — одна, у первой строки), имя автора оригинала его цветом и
                // ОРИГИНАЛЬНОЕ время внутри. Своё время и галочки остаются у внешнего
                // пузыря — на телефоне иначе непонятно, дошла ли сама пересылка.
                ForwardEnvelope(
                    header: forwardHeaderTitle(forward),
                    headerColor: nameColorForUser(m.senderId, order: participantOrder),
                    authorName: forward.authorName,
                    // Автора чужого чата в участниках беседы нет, поэтому цвет — по хэшу от
                    // того же ключа, что считает веб: тон имени совпадает с браузером.
                    authorColor: nameColorForUser(forwardAuthorHueKey(forward), order: [:]),
                    originalTime: forwardOriginalTimeLabel(forward)
                ) {
                    payloadView
                }
            } else {
                payloadView
            }

            // Рельса реакций: вид, порядок и правило «счётчик только при count > 1» —
            // в ReactionChips (порт MessageReactionRail). Пустоту отсекаем здесь, чтобы
            // VStack не оставлял под сообщением без реакций лишний зазор.
            if !m.reactions.isEmpty {
                ReactionChips(
                    reactions: m.reactions,
                    isSelectedInMulti: selected,
                    onTap: { onReact($0) }
                )
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
        // Пока файл летит — затемнение с кольцом прогресса и крестиком отмены прямо на
        // пузыре (веб наливает прогресс поверх картинки, ChatMessageRow.tsx); упало —
        // «Не отправилось» с повтором. Пустой пузырь накладку не рисует вовсе.
        .overlay { OutgoingUploadOverlay(badge: outgoingUpload) }
        // Долгое нажатие (своё меню вместо системного contextMenu) живёт на коллекции
        // ленты как UIKit-жест: SwiftUI-модификатор здесь перехватывал касание у прокрутки.
    }

    /// Содержимое сообщения: вложения, текст, превью ссылки. Один и тот же кусок и внутри
    /// конверта пересылки, и без него: второй рендер вложений разъехался бы с рамками
    /// плиток, которыми просмотрщик открывается и закрывается.
    @ViewBuilder
    private var payloadView: some View {
        attachmentsView

        if let content = m.content, !content.isEmpty {
            MessageTextView(content: content, deleted: m.deleted)
        }

        if let preview = m.linkPreview {
            linkPreviewCard(preview)
        }
    }

    /// Шапка конверта «Роман из переписки с Настей» (nil — не рисуем). У пачки шапку несёт
    /// только первая строка: остальные продолжают тот же конверт, как в вебе.
    private func forwardHeaderTitle(_ info: ForwardInfo) -> String? {
        if let slot = forwardSlot {
            return slot.isFirst ? slot.headerTitle : nil
        }
        // Слота нет (строка вне ленты) — собираем шапку из этой одной пересылки.
        let name = m.senderName.trimmed()
        let phrase = formatForwardSourcePhraseAfterName([info])
        return name.isEmpty ? phrase : "\(name) \(phrase)"
    }

    /// Ширина, которую отъедает конверт пересылки. Плитки и мозаика считают размер от
    /// ширины экрана ЗАРАНЕЕ, поэтому поправку надо передать им: иначе медиа вылезает за
    /// янтарную рамку.
    private var forwardContentInset: CGFloat {
        m.forwardFrom == nil ? 0 : ForwardEnvelopeMetrics.horizontalInset
    }

    @ViewBuilder
    private var attachmentsView: some View {
        // Нумерация плиток — Message.galleryMedia: сперва фото, затем видео. Тот же индекс
        // означает тот же кадр и в swipe.tileFrames, и в id кадра галереи («<id>#<n>»),
        // поэтому просмотрщик открывает именно то, по чему ткнули, и улетает обратно в его
        // плитку. Фильтры здесь и в galleryMedia обязаны совпадать.
        let images = m.attachments.filter { $0.type == "IMAGE" }
        let videos = m.attachments.filter { $0.type == "VIDEO" }
        // Всё остальное (голосовые и документы) — строками под медиа, как в вебе.
        let files = m.attachments.filter { $0.type != "IMAGE" && $0.type != "VIDEO" }

        if images.count == 1, let att = images.first {
            // Одиночная картинка — точный размер из метаданных и вписывание (contain),
            // как в вебе: мозаика начинается только с двух кадров.
            let size = att.displaySize(screen: screenSize, extraInset: forwardContentInset)
            attachmentImage(att, width: size.width, height: size.height)
                // Плитка под открытым просмотрщиком невидима, но место держит: иначе
                // высота пузыря изменилась бы и лента сдвинулась под галереей.
                .opacity(swipe.hiddenTileIndex == 0 ? 0 : 1)
                .onGeometryChange(for: CGRect.self) { $0.frame(in: .named("messageCell")) } action: {
                    swipe.tileFrames[0] = $0
                }
                .onTapGesture {
                    if selectionMode { onTap() } else { onOpenImage(0, swipe.tileFrames[0]) }
                }
        } else if images.count > 1 {
            // Мозаика по пропорциям кадров (порт веб-renderImageGroup): вся геометрия
            // считается из метаданных ДО загрузки, поэтому высота ячейки не меняется.
            let budget = MessageAttachment.albumBudget(
                screen: screenSize, extraInset: forwardContentInset
            )
            AttachmentAlbumView(
                atts: images,
                maxWidth: budget.maxWidth,
                maxHeight: budget.maxHeight,
                decryptSecretAttachment: decryptSecretAttachment,
                hiddenTileIndex: swipe.hiddenTileIndex,
                onTileFrame: { index, frame in swipe.tileFrames[index] = frame },
                onOpenImage: { index in
                    if selectionMode { onTap() } else { onOpenImage(index, swipe.tileFrames[index]) }
                }
            )
        }

        // Видео — плитка с кадром-постером и кнопкой Play. Тап открывает ТОТ ЖЕ
        // просмотрщик, что и фото (страница с плеером, VideoPage.swift): видео стоит в
        // одном пейджере с кадрами беседы, поэтому его индекс продолжает нумерацию фото.
        ForEach(Array(videos.enumerated()), id: \.offset) { offset, att in
            let index = images.count + offset
            VideoAttachmentTile(
                att: att,
                size: att.videoDisplaySize(screen: screenSize, extraInset: forwardContentInset),
                durationSec: att.durationSec,
                onPlay: {
                    if selectionMode { onTap() } else { onOpenImage(index, swipe.tileFrames[index]) }
                }
            )
            .opacity(swipe.hiddenTileIndex == index ? 0 : 1)
            .onGeometryChange(for: CGRect.self) { $0.frame(in: .named("messageCell")) } action: {
                swipe.tileFrames[index] = $0
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

    /// Строка файла. Видео сюда больше не попадает (у него плитка с постером), картинки —
    /// тоже, так что это документы и подстраховка для голосового без плеера.
    private func fileRowLabel(_ att: MessageAttachment) -> some View {
        HStack(spacing: 8) {
            Image(systemName: att.type == "AUDIO" ? "mic.fill" : "doc.fill")
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
            Image(systemName: "arrow.down.circle")
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
