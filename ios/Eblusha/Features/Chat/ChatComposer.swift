import SwiftUI

/// Композер вынесен из ChatView отдельной вью НЕ ради красоты: пока текст жил в @State
/// самого экрана, каждое нажатие клавиши перестраивало тело ChatView целиком — вместе с
/// лентой на сотни сообщений. Ввод отставал от пальца, а лента под ним мигала. Теперь
/// текст живёт здесь, и переписка о наборе не знает.
///
/// Порт нижней колонки `ChatScreen.kt`: прогресс/чипы вложений → панель ответа → строка
/// ввода (или строка записи голосового).
struct ChatComposer: View {

    let conversationId: String
    let staged: [OutgoingFile]
    let uploadProgress: Float?
    let replyingTo: [Message]
    let sending: Bool
    /// Текст, возвращённый вьюмоделью после неудачной отправки (или отменённой подписи).
    let restoredDraft: String?

    let onClearReply: () -> Void
    let onRemoveStaged: (Int) -> Void
    let onCancelUpload: () -> Void
    let onStageFiles: ([OutgoingFile]) -> Void
    let onError: (String) -> Void
    let onDraftChanged: (String) -> Void
    let onSend: (String) -> Void
    let onSendStaged: (String?) -> Void
    let onSendVoice: (Data, Int, [Int]) -> Void
    /// Кадр из очереди отредактирован — подменить на месте.
    let onReplaceStaged: (Int, OutgoingFile) -> Void
    let onConsumeRestoredDraft: () -> Void
    /// Фокус ушёл в поле ввода — ленте пора подтянуть низ под клавиатуру.
    let onFocusChanged: (Bool) -> Void
    /// Панель выросла (цитата, чипы, вторая строка) — лента компенсирует высоту.
    let onHeightChanged: (CGFloat) -> Void

    @State private var draft = ""
    /// Ближайшее изменение текста — не набор пользователя (восстановление черновика).
    @State private var suppressTypingOnce = false
    /// Открытый редактор фото: свежий выбор (кнопка в редакторе сразу отправляет) или
    /// правка кадра, уже стоящего в очереди.
    @State private var editorSession: PhotoEditorSession?
    @StateObject private var voiceRecorder = VoiceRecorder()
    @FocusState private var focused: Bool

    private var isEmpty: Bool { draft.trimmed().isEmpty && staged.isEmpty }

    var body: some View {
        VStack(spacing: 0) {
            ComposerAttachmentsBar(
                staged: staged,
                uploadProgress: uploadProgress,
                onRemoveStaged: onRemoveStaged,
                onCancelUpload: onCancelUpload,
                onEditStaged: { index in
                    guard staged.indices.contains(index),
                          let item = PhotoEditItem(source: staged[index]) else { return }
                    editorSession = PhotoEditorSession(items: [item], passthrough: [], replacingIndex: index)
                }
            )

            if !replyingTo.isEmpty {
                ReplyDraftPreview(messages: replyingTo, onClear: onClearReply)
            }

            if voiceRecorder.isRecording {
                // Порт recording-ветки композера ChatScreen.kt: строка записи вместо ввода.
                VoiceRecordBar(recorder: voiceRecorder, sending: sending) { data, duration, waveform in
                    onSendVoice(data, duration, waveform)
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
            } else {
                inputRow
            }
        }
        // Фон уходит под полосу home indicator — иначе внизу видна полоса другого цвета.
        .background(Eb.surface200.ignoresSafeArea(edges: .bottom))
        // Высота панели меняется от цитаты, чипов и второй строки — лента должна на это
        // отвечать, иначе последнее сообщение уезжает под композер (порт
        // KeepBottomVisibleOnComposerGrowth).
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { onHeightChanged($0) }
        .onAppear {
            restoreDraft()
            applyRestoredDraft()
        }
        .onChange(of: conversationId) { previous, current in
            // Экран умеет переезжать на другую беседу без пересоздания (тап по пушу из
            // другого чата) — иначе набранное сохранилось бы под чужим id.
            DraftStore.set(previous, draft)
            draft = DraftStore.get(current)
            suppressTypingOnce = true
        }
        .onDisappear {
            DraftStore.set(conversationId, draft)
            voiceRecorder.cancel()
        }
        .onChange(of: focused) { _, value in onFocusChanged(value) }
        .fullScreenCover(item: $editorSession) { session in
            PhotoEditorView(
                items: session.items,
                passthrough: session.passthrough,
                initialCaption: session.replacingIndex == nil ? draft : "",
                onDone: { files, caption in
                    editorSession = nil
                    if let index = session.replacingIndex {
                        // Правка кадра из очереди: подменяем, подпись остаётся в поле.
                        if let file = files.first { onReplaceStaged(index, file) }
                        return
                    }
                    // Свежий выбор: кнопка редактора — это «отправить», как в Telegram.
                    onStageFiles(files)
                    draft = ""
                    DraftStore.set(conversationId, "")
                    onSendStaged(caption.trimmed().isEmpty ? nil : caption)
                },
                onCancel: { editorSession = nil }
            )
        }
        // .task(id:), а не onChange: композер могло не быть на экране в момент сбоя
        // отправки (режим выбора, секретное приглашение), и текст пропадал бы совсем.
        .task(id: restoredDraft) { applyRestoredDraft() }
    }

    private func restoreDraft() {
        let saved = DraftStore.get(conversationId)
        guard !saved.isEmpty, draft.isEmpty else { return }
        suppressTypingOnce = true
        draft = saved
    }

    /// Текст, вернувшийся после неудачной отправки, дописывается к набранному, а не
    /// затирает его.
    private func applyRestoredDraft() {
        guard let restored = restoredDraft, !restored.isEmpty else { return }
        draft = draft.trimmed().isEmpty ? restored : restored + " " + draft
        suppressTypingOnce = true
        onConsumeRestoredDraft()
    }

    private var inputRow: some View {
        HStack(alignment: .bottom, spacing: 8) {
            AttachmentPickerButton(
                disabled: sending,
                onPicked: { files in
                    // Фото идут через редактор; всё остальное (видео, документы) — в
                    // очередь как есть.
                    let images = files.filter { $0.mime.hasPrefix("image/") }
                    let rest = files.filter { !$0.mime.hasPrefix("image/") }
                    let items = images.compactMap { PhotoEditItem(source: $0) }
                    guard !items.isEmpty else {
                        onStageFiles(files)
                        return
                    }
                    editorSession = PhotoEditorSession(items: items, passthrough: rest, replacingIndex: nil)
                },
                onError: onError
            )

            TextField("Сообщение", text: $draft, axis: .vertical)
                .lineLimit(1...5)
                .focused($focused)
                .foregroundStyle(Eb.textPrimary)
                .padding(.horizontal, 14)
                .padding(.vertical, 9)
                .background(Eb.surface100, in: RoundedRectangle(cornerRadius: 20))
                .overlay(RoundedRectangle(cornerRadius: 20).strokeBorder(Eb.border))
                .onChange(of: draft) { _, text in
                    // Восстановленный черновик — не набор текста: без этого собеседник
                    // видел «печатает…» просто оттого, что человек открыл чат.
                    if suppressTypingOnce {
                        suppressTypingOnce = false
                    } else {
                        onDraftChanged(text)
                    }
                    DraftStore.set(conversationId, text)
                }

            // Микрофон и «отправить» занимают ОДНО место: раньше микрофон исчезал на первом
            // же символе, поле рывком расширялось на 38 pt и текст под курсором прыгал.
            Group {
                if isEmpty {
                    VoiceRecordButton(recorder: voiceRecorder, sending: sending)
                } else {
                    sendButton
                }
            }
            .frame(width: 38, height: 38)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
    }

    private var sendButton: some View {
        Button {
            let text = draft
            draft = ""
            DraftStore.set(conversationId, "")
            // С очередью вложений текст уходит их подписью; иначе — обычное сообщение.
            if !staged.isEmpty {
                onSendStaged(text.trimmed().isEmpty ? nil : text)
            } else {
                onSend(text)
            }
        } label: {
            Image(systemName: "arrow.up")
                .font(.system(size: 17, weight: .bold))
                .foregroundStyle(.white)
                .frame(width: 38, height: 38)
                .background(sending ? Eb.surface300 : Eb.brand, in: Circle())
        }
        .disabled(sending)
    }
}

/// Что открыто в редакторе фото.
struct PhotoEditorSession: Identifiable {
    let id = UUID()
    let items: [PhotoEditItem]
    let passthrough: [OutgoingFile]
    /// nil — свежий выбор; иначе индекс кадра в очереди, который правим.
    let replacingIndex: Int?
}
