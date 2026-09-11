import SwiftUI
import UIKit
import AVFoundation
import UniformTypeIdentifiers

/// Композер вынесен из ChatView отдельной вью НЕ ради красоты: пока текст жил в @State
/// самого экрана, каждое нажатие клавиши перестраивало тело ChatView целиком — вместе с
/// лентой на сотни сообщений. Ввод отставал от пальца, а лента под ним мигала. Теперь
/// текст живёт здесь, и переписка о наборе не знает.
///
/// Порт нижней колонки `ChatScreen.kt`: прогресс/чипы вложений → панель ответа → панель
/// форматирования выделения → строка ввода (или строка записи голосового).
///
/// Само поле ввода живёт в ComposerFormatting.swift: это UITextView, а не TextField, —
/// от него нужны выделение (панель Ж/К/З/моно), свои пункты меню и вставка картинки из
/// буфера, чего SwiftUI-поле не даёт. Вложения набираются очередью, как в вебе: и
/// галерея, и камера, и буфер только ДОБАВЛЯЮТ чипы, отправка — кнопкой.
struct ChatComposer: View {

    let conversationId: String
    let staged: [OutgoingFile]
    let uploadProgress: Float?
    let replyingTo: [Message]
    let sending: Bool
    /// Текст, возвращённый вьюмоделью после неудачной отправки (или отменённой подписи).
    let restoredDraft: String?

    // --- Состояние защиты секретного треда (веб: плашки над .msg-input-bar) ---
    // Все параметры этого блока со значениями по умолчанию: композер зовут и из обычных
    // чатов, и старый вызов не должен переставать компилироваться.
    /// Ключа треда ещё нет: висит плашка «Настраивается…». Отправку НЕ блокируем —
    /// вьюмодель копит текст и дошлёт его сама по приходу ключа (веб-паритет).
    var secretPending = false
    /// Сколько сообщений уже стоит в очереди до ключа (веб: N сообщ. в очереди).
    var secretQueued = 0
    /// Ключи не доехали: код первопричины из движка (nil — ошибки нет).
    var secretKeysErrorCode: String? = nil
    /// Повтор обмена ключами прямо сейчас идёт — кнопки карточки ошибки погашены.
    var secretKeysRetrying = false
    /// Есть другие свои устройства — тогда в карточке ошибки есть «Привязать устройство».
    var secretCanLinkDevice = false
    /// «Восстановить»: повторить обмен ключами. Что именно это значит, решает экран.
    var onRetrySecretKeys: () -> Void = {}
    /// «Привязать устройство»: забрать ключи со своего же устройства.
    var onLinkDevice: () -> Void = {}

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

    // --- Правка сообщения (порт веб-плашки «Редактирование сообщения») ---
    // Со значениями по умолчанию и ПОСЛЕДНИМИ в списке свойств: у struct-вью
    // инициализатор почленный, и любой другой порядок ломал бы уже написанные вызовы.
    /// Что правим; nil — обычный режим. Текст сообщения кладётся в то же поле ввода,
    /// поэтому правка достаётся вместе с панелью Ж/К/З, которой не было в модалке.
    var editing: ComposerEdit? = nil
    /// Сохранение уже летит на сервер — кнопка погашена, панель ещё на месте.
    var editSaving = false
    /// «Сохранить»: отдаёт то, что сейчас в поле.
    var onSaveEdit: (String) -> Void = { _ in }
    /// Крестик на плашке либо уход с беседы.
    var onCancelEdit: () -> Void = {}

    @State private var draft = ""
    /// Черновик, отложенный на время правки: в поле лежит текст правимого сообщения.
    /// Вместе с беседой, которой он принадлежит, — переезд на другой чат посреди правки
    /// не должен вернуть в поле чужой текст.
    @State private var stashedDraft: (conversationId: String, text: String)?
    /// Ближайшее изменение текста — не набор пользователя (восстановление черновика).
    @State private var suppressTypingOnce = false
    /// Открытый редактор фото: свежий выбор или правка кадра, уже стоящего в очереди.
    /// В обоих случаях редактор ВОЗВРАЩАЕТ кадры в очередь, а не отправляет их.
    @State private var editorSession: PhotoEditorSession?
    /// Открыта системная камера (съёмка прямо из композера).
    @State private var showCamera = false
    /// В буфере лежит картинка — над полем видна кнопка «Вставить картинку». Значение
    /// обновляем при получении фокуса: проверка типа буфера содержимое не читает.
    @State private var clipboardHasImage = false
    @StateObject private var voiceRecorder = VoiceRecorder()
    /// Голосовая ветка композера: удержание микрофона, зафиксированная запись и черновик
    /// на прослушивание. Рекордер знает про микрофон и файл, это — про пальцы и панели.
    @StateObject private var voiceState = VoiceComposerState()
    /// Мост к полю ввода: выделение для панели форматирования и вставка стиля.
    @StateObject private var textController = ComposerTextController()
    /// Фокус поля — обычный @State, а не @FocusState: поле теперь UITextView, о своём
    /// фокусе оно сообщает само (см. ComposerTextView).
    @State private var focused = false
    /// Возврат из другого приложения — повод перепроверить буфер: картинку чаще всего
    /// копируют именно там, и поле при этом остаётся в фокусе (onChange по фокусу не
    /// сработал бы вовсе).
    @Environment(\.scenePhase) private var scenePhase

    private var isEmpty: Bool { draft.trimmed().isEmpty && staged.isEmpty }

    private var isEditing: Bool { editing != nil }

    /// На сколько панель без клавиатуры опускается в зону home indicator: чуть больше
    /// трети системного отступа (на Face ID-телефонах — 12 pt), на кнопочных — ноль.
    private static let bottomLift: CGFloat = {
        let inset = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first { $0.isKeyWindow }?
            .safeAreaInsets.bottom ?? 0
        return min(12, (inset * 0.4).rounded())
    }()

    /// На симуляторе и на устройстве без камеры кнопка съёмки просто не нужна: пикер с
    /// sourceType = .camera там падает в пустой чёрный экран.
    private static let cameraAvailable = UIImagePickerController.isSourceTypeAvailable(.camera)

    var body: some View {
        VStack(spacing: 0) {
            // Состояние защиты — ПЕРВОЙ строкой панели, как в вебе: сначала красная
            // карточка «ключи не доехали» (она важнее и несёт действия), иначе бирюзовая
            // «настраивается…» со счётчиком очереди.
            if let code = secretKeysErrorCode {
                SecretKeysErrorCard(
                    code: code,
                    canLinkDevice: secretCanLinkDevice,
                    busy: secretKeysRetrying,
                    onRetry: onRetrySecretKeys,
                    onLinkDevice: onLinkDevice
                )
            } else if secretPending {
                SecretKeysWaitingBar(queued: secretQueued)
            }

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

            // Плашка правки — над цитатой ответа и над строкой ввода, как в вебе. Группа
            // нужна ради перехода: анимация висит на НЕЙ, а не на всей панели, иначе
            // масштабом поехал бы и рост поля от набранного текста.
            Group {
                if let edit = editing {
                    ComposerEditBar(edit: edit, onCancel: onCancelEdit)
                        .transition(.scale(scale: 0.001, anchor: .bottom).combined(with: .opacity))
                }
            }
            .animation(.easeOut(duration: 0.2), value: editing)

            if !replyingTo.isEmpty {
                ReplyDraftPreview(messages: replyingTo, onClear: onClearReply)
            }

            // На время правки голосовая строка уступает место полю: записать новое
            // голосовое нельзя (микрофон погашен), а уже записанный черновик никуда не
            // девается — он вернётся, как только правка закроется.
            if voiceState.showsBar && !isEditing {
                // Палец больше не нужен: идёт зафиксированная запись или готов черновик —
                // и та и другая ветка занимают место строки ввода. Во время удержания
                // строку НЕ подменяем: кнопка микрофона несёт жест и обязана остаться.
                VoiceComposerBar(
                    recorder: voiceRecorder,
                    state: voiceState,
                    sending: sending,
                    onSend: onSendVoice
                )
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
            } else {
                // Порядок строк как в вебе: форматирование выделения — ближе всего к полю,
                // под ним сама строка ввода.
                ComposerFormatBar(controller: textController)
                if clipboardHasImage && !sending { pasteImageBar }
                inputRow
            }
        }
        // Без клавиатуры панель сидит ниже, чем велит safe area: полный отступ под полем
        // читался как пустая полоса. С клавиатурой отступ снимаем — иначе поле уехало бы
        // под неё. На телефонах без home indicator сдвиг нулевой (см. `bottomLift`).
        .padding(.bottom, focused ? 0 : -Self.bottomLift)
        .animation(.easeOut(duration: 0.2), value: focused)
        // Фон уходит под полосу home indicator — иначе внизу видна полоса другого цвета.
        .background(Eb.surface200.ignoresSafeArea(edges: .bottom))
        // Полотно беседы теперь той же поверхности, поэтому панель ввода отделяет
        // волосок сверху — ровно как .msg-input-bar в вебе.
        .overlay(alignment: .top) { Rectangle().fill(Eb.border).frame(height: 1) }
        // Высота панели меняется от цитаты, чипов и второй строки — лента должна на это
        // отвечать, иначе последнее сообщение уезжает под композер (порт
        // KeepBottomVisibleOnComposerGrowth).
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { onHeightChanged($0) }
        .onAppear {
            restoreDraft()
            applyRestoredDraft()
            // Страховка на случай, когда панель появляется уже с открытой правкой
            // (композер пересоздали, пока правка жила во вью-состоянии экрана).
            applyEditing(from: nil, to: editing)
        }
        .onChange(of: conversationId) { previous, current in
            // Экран умеет переезжать на другую беседу без пересоздания (тап по пушу из
            // другого чата) — иначе набранное сохранилось бы под чужим id.
            if isEditing {
                // Правка принадлежит ПРЕЖНЕЙ беседе: панель закрываем, а отложенный
                // черновик возвращаем туда, откуда он взят, — не в поле новой беседы.
                DraftStore.set(previous, stashedDraft?.text ?? "")
                stashedDraft = nil
                onCancelEdit()
            } else {
                DraftStore.set(previous, draft)
            }
            draft = DraftStore.get(current)
            suppressTypingOnce = true
            // Начатая запись и записанный черновик принадлежат ПРЕЖНЕЙ беседе — иначе
            // голосовое ушло бы в чужую переписку.
            voiceState.cancelAll(recorder: voiceRecorder)
        }
        .onDisappear {
            // В поле может лежать текст правимого сообщения — черновиком беседы он не
            // является, поэтому в хранилище уходит отложенный.
            DraftStore.set(conversationId, isEditing ? (stashedDraft?.text ?? "") : draft)
            voiceState.cancelAll(recorder: voiceRecorder)
            // Экран уходит — запись заведомо кончилась; флаги снимаем здесь же, иначе чат
            // остался бы немым, а лента — без автоплея до следующей записи (onChange по
            // isRecording при уничтожении панели уже не придёт).
            ChatSounds.setRecording(false)
            InlineVideoCoordinator.shared.isSuspended = false
        }
        // Пока пишется голосовое, звуки чата молчат: системный щелчок лёг бы прямо в
        // записываемую дорожку. Флаг общий на приложение, поэтому его ставит композер —
        // рекордер про звуки чата ничего не знает и знать не должен.
        .onChange(of: voiceRecorder.isRecording) { _, recording in
            ChatSounds.setRecording(recording)
            // Автоплей видео в ленте на время записи глушим: лишний декодер и перерисовка
            // плиток идут по тому же главному потоку, что и волна под пальцем.
            InlineVideoCoordinator.shared.isSuspended = recording
        }
        .onChange(of: editing) { previous, current in
            applyEditing(from: previous, to: current)
        }
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active else { return }
            clipboardHasImage = focused && ComposerClipboard.hasImage
        }
        .onChange(of: focused) { _, value in
            onFocusChanged(value)
            // Буфер проверяем в момент фокуса: hasImages не читает содержимое и не
            // показывает системную плашку «вставлено из …», так что это дёшево и тихо.
            clipboardHasImage = value && ComposerClipboard.hasImage
        }
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
                    // Свежий выбор ТОЛЬКО встаёт в очередь — как в вебе, где выбранное
                    // кладётся в pendingImages чипами, а отправка отдельной кнопкой.
                    // Раньше редактор слал сразу: нельзя было добрать второе фото или
                    // документ, а уже стоявшие в очереди файлы улетали заодно.
                    onStageFiles(files)
                    // Подпись, набранную в редакторе, возвращаем в поле: она станет
                    // подписью всего набора при отправке (и не пропадёт, если человек
                    // решит добрать ещё вложений).
                    draft = caption
                    DraftStore.set(conversationId, caption)
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
        if isEditing {
            // Поле занято правкой: вернувшийся текст кладём в отложенный черновик, иначе
            // он влился бы в редактируемое сообщение и уехал на сервер вместе с ним.
            let waiting = stashedDraft?.text ?? ""
            let merged = waiting.trimmed().isEmpty ? restored : restored + " " + waiting
            stashedDraft = (conversationId, merged)
            onConsumeRestoredDraft()
            return
        }
        draft = draft.trimmed().isEmpty ? restored : restored + " " + draft
        suppressTypingOnce = true
        onConsumeRestoredDraft()
    }

    /// Вход в правку и выход из неё. Текст сообщения занимает поле ввода, а набранный
    /// черновик ждёт в стороне: иначе одно другое затирало бы, и отмена правки оставляла
    /// бы человека без того, что он уже написал.
    private func applyEditing(from previous: ComposerEdit?, to current: ComposerEdit?) {
        if let current {
            // Смена цели правки без выхода (правку начали поверх правки) черновик уже
            // отложила — второй раз его отбирать нельзя.
            guard previous?.id != current.id else { return }
            if previous == nil { stashedDraft = (conversationId, draft) }
            draft = current.text
            // Подстановка текста — не набор: «печатает…» у собеседника от правки не горит.
            suppressTypingOnce = true
            // Клавиатура остаётся поднятой — ради этого панель и затевалась.
            focused = true
            return
        }
        guard previous != nil else { return }
        // Возвращаем черновик, только если он от ЭТОЙ беседы (переезд забирает его сам).
        if let stash = stashedDraft, stash.conversationId == conversationId {
            draft = stash.text
            suppressTypingOnce = true
        }
        stashedDraft = nil
    }

    private var inputRow: some View {
        HStack(alignment: .bottom, spacing: 6) {
            // Во время правки скрепка, камера и микрофон погашены — как в вебе
            // (disabled={!!editState}): править можно только текст уже отправленного.
            AttachmentPickerButton(
                disabled: sending || isEditing,
                onPicked: { files in openPicked(files) },
                onError: onError,
                // Съёмка живёт здесь (fullScreenCover камеры и запрос разрешения ниже по
                // файлу) — лист прикрепления только просит её открыть, закрывшись сам.
                onCamera: { openCamera() }
            )

            // Съёмка отдельной кнопкой, а не пунктом в меню скрепки: в вебе с телефона
            // «Снять фото» — первый пункт системного листа, то есть один тап.
            if Self.cameraAvailable {
                Button {
                    openCamera()
                } label: {
                    Image(systemName: "camera")
                        .font(.title3)
                        .foregroundStyle(Eb.textMuted)
                        .frame(width: 34, height: 38)
                }
                .disabled(sending || isEditing)
                .accessibilityLabel("Снять фото")
            }

            ComposerTextView(
                text: $draft,
                focused: $focused,
                controller: textController,
                onPasteImages: { files in stagePasted(files) }
            )
            .frame(maxWidth: .infinity)
            .background(Eb.surface100, in: RoundedRectangle(cornerRadius: 20))
            .overlay(RoundedRectangle(cornerRadius: 20).strokeBorder(Eb.border))
            // Подсказка рисуется поверх: у UITextView своего placeholder нет. Отступы
            // совпадают с textContainerInset поля, иначе текст «прыгнул» бы с первого
            // символа. Тапы сквозь неё проходят в поле.
            .overlay(alignment: .topLeading) {
                if draft.isEmpty {
                    Text("Сообщение")
                        .foregroundStyle(Eb.textMuted)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 9)
                        .allowsHitTesting(false)
                }
            }
            .onChange(of: draft) { _, text in
                // Восстановленный черновик — не набор текста: без этого собеседник
                // видел «печатает…» просто оттого, что человек открыл чат.
                if suppressTypingOnce {
                    suppressTypingOnce = false
                } else if !isEditing {
                    // Правка — не набор нового сообщения: «печатает…» на неё не зажигаем
                    // (веб ведёт себя так же: editState не трогает typing).
                    onDraftChanged(text)
                }
                // В хранилище черновиков текст правимого сообщения попасть не должен:
                // отменил правку — и чужой текст остался бы в поле навсегда.
                if !isEditing { DraftStore.set(conversationId, text) }
            }

            // Микрофон и «отправить» занимают ОДНО место: раньше микрофон исчезал на первом
            // же символе, поле рывком расширялось на 38 pt и текст под курсором прыгал.
            Group {
                if isEditing {
                    // Правка занимает то же место: кнопка отправки становится кнопкой
                    // сохранения, микрофон на время правки недоступен.
                    saveEditButton
                } else if isEmpty {
                    VoiceRecordButton(
                        recorder: voiceRecorder,
                        state: voiceState,
                        sending: sending,
                        onSend: onSendVoice
                    )
                } else {
                    sendButton
                }
            }
            .frame(width: 38, height: 38)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        // Камера висит на строке ввода, а не на всей панели: второй fullScreenCover на
        // ТОЙ ЖЕ вью SwiftUI игнорирует, а редактор фото уже занял модификатор наверху.
        .fullScreenCover(isPresented: $showCamera) {
            CameraCaptureView(
                onCaptured: { file in
                    showCamera = false
                    // Редактор открываем после закрытия камеры: два полноэкранных показа
                    // подряд SwiftUI склеивает, и редактор не появляется вовсе.
                    Task { @MainActor in
                        try? await Task.sleep(nanoseconds: 350_000_000)
                        openPicked([file])
                    }
                },
                onError: { message in
                    showCamera = false
                    onError(message)
                },
                onCancel: { showCamera = false }
            )
            .ignoresSafeArea()
        }
    }

    /// Кнопка «Вставить картинку»: длинный тап с системным «Вставить» находят не все,
    /// а буфер со скриншотом — самый частый способ поделиться картинкой. Через системное
    /// меню вставка проходит молча, а здесь iOS сначала спросит «Разрешить вставку?» —
    /// это плата за чтение буфера мимо меню, и спрашивают только по явному тапу.
    private var pasteImageBar: some View {
        HStack(spacing: 6) {
            Button {
                stagePasted(ComposerClipboard.readImageFiles())
            } label: {
                Label("Вставить картинку", systemImage: "doc.on.clipboard")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Eb.textPrimary)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 5)
                    .background(Eb.surface300, in: Capsule())
            }
            .buttonStyle(.plain)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 10)
        .padding(.bottom, 2)
    }

    /// Съёмку открываем только с живым разрешением. Без этой проверки отказавшийся
    /// однажды человек получал бы чёрный прямоугольник без единой подсказки: система
    /// второй раз не спрашивает, а пикер про запрет ничего не говорит.
    @MainActor
    private func openCamera() {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            showCamera = true
        case .notDetermined:
            Task { @MainActor in
                if await AVCaptureDevice.requestAccess(for: .video) {
                    showCamera = true
                } else {
                    onError(Self.cameraDeniedMessage)
                }
            }
        default:
            onError(Self.cameraDeniedMessage)
        }
    }

    private static let cameraDeniedMessage =
        "Доступ к камере запрещён — включите его в «Настройки → Eblusha»"

    /// Единый вход для всего выбранного (галерея, камера): картинки — через редактор,
    /// прочее (видео, документы) — сразу в очередь.
    @MainActor
    private func openPicked(_ files: [OutgoingFile]) {
        let images = files.filter { $0.mime.hasPrefix("image/") }
        let rest = files.filter { !$0.mime.hasPrefix("image/") }
        let items = images.compactMap { PhotoEditItem(source: $0) }
        guard !items.isEmpty else {
            onStageFiles(files)
            return
        }
        editorSession = PhotoEditorSession(items: items, passthrough: rest, replacingIndex: nil)
    }

    /// Картинка из буфера идёт в очередь МИМО редактора — ровно как в вебе, где onPaste
    /// зовёт addComposerImage(file, 'paste'). Полноэкранный редактор поверх набора текста
    /// был бы неожиданным; поправить кадр можно тапом по чипу.
    @MainActor
    private func stagePasted(_ files: [OutgoingFile]) {
        clipboardHasImage = false
        guard !files.isEmpty else {
            onError("В буфере обмена нет картинки")
            return
        }
        onStageFiles(files)
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

    /// «Сохранить» на месте кнопки отправки. Поле при этом НЕ очищается: панель закрывает
    /// экран и только по успеху сервера — иначе на сбое правка пропала бы молча.
    private var saveEditButton: some View {
        Button {
            onSaveEdit(draft)
        } label: {
            Group {
                if editSaving {
                    ProgressView().tint(.white)
                } else {
                    Image(systemName: "checkmark")
                        .font(.system(size: 16, weight: .bold))
                        .foregroundStyle(.white)
                }
            }
            .frame(width: 38, height: 38)
            .background(editSaveDisabled ? Eb.surface300 : Eb.brand, in: Circle())
        }
        .disabled(editSaveDisabled)
        .accessibilityLabel("Сохранить")
    }

    /// Пустой текст сервер не примет (ChatViewModel.edit его отсекает), да и смысла в
    /// «правке в пустоту» нет: стереть сообщение — это удаление, отдельный пункт меню.
    private var editSaveDisabled: Bool { editSaving || draft.trimmed().isEmpty }
}

/// Что правит композер: id сообщения и его исходный текст.
/// Equatable — на нём держится `onChange(of: editing)` и переход появления панели.
struct ComposerEdit: Equatable {
    let id: String
    let text: String
}

/// Плашка «Редактирование сообщения» над полем ввода — порт веб-блока над формой
/// (MessagesPane.tsx) и телеграмной EditAccessoryPanel: карандаш, акцентный заголовок,
/// одна строка исходного текста, крестик справа. Модалки на пол-экрана здесь нет
/// нарочно: правка почти всегда — это одна буква, а модалка уводила с переписки,
/// роняла клавиатуру и отбирала панель Ж/К/З, которой у голого TextField не было.
private struct ComposerEditBar: View {
    let edit: ComposerEdit
    let onCancel: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "pencil")
                .font(.system(size: 17))
                .foregroundStyle(Eb.brand)
            RoundedRectangle(cornerRadius: 2)
                .fill(Eb.brand)
                .frame(width: 3, height: 34)
            VStack(alignment: .leading, spacing: 1) {
                Text("Редактирование сообщения")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Eb.brand)
                    .lineLimit(1)
                // Разметку показываем разобранной, а не звёздочками: в поле ниже человек
                // видит исходник, а здесь — как сообщение выглядит в ленте.
                Text(ChatMarkdown.render(preview))
                    .font(.caption)
                    .foregroundStyle(Eb.textMuted)
                    .lineLimit(1)
            }
            Spacer(minLength: 4)
            Button(action: onCancel) {
                Image(systemName: "xmark")
                    .font(.caption)
                    .foregroundStyle(Eb.textMuted)
                    // 32×32 — палец попадает мимо иконки и всё равно закрывает панель.
                    .frame(width: 32, height: 32)
            }
            .accessibilityLabel("Отменить правку")
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(Eb.surface200)
    }

    /// Однострочный текст: переводы строк схлопываем, иначе lineLimit(1) показал бы
    /// только первую строку и панель врала бы о содержимом.
    private var preview: String {
        edit.text
            .split(whereSeparator: \.isNewline)
            .joined(separator: " ")
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

/// Съёмка прямо из композера. UIImagePickerController, а не свой AVFoundation-экран:
/// системная камера — это готовые превью, вспышка, переключение камер, «переснять» и
/// запись видео, а нам нужен только итоговый кадр. Разрешения уже объявлены
/// (NSCameraUsageDescription и NSMicrophoneUsageDescription в Resources/Info.plist).
struct CameraCaptureView: UIViewControllerRepresentable {
    /// Снятое — тем же путём, что и выбранное в галерее (фото → редактор, видео → очередь).
    let onCaptured: (OutgoingFile) -> Void
    let onError: (String) -> Void
    let onCancel: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onCaptured: onCaptured, onError: onError, onCancel: onCancel)
    }

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.mediaTypes = [UTType.image.identifier, UTType.movie.identifier]
        picker.videoQuality = .typeHigh
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ picker: UIImagePickerController, context: Context) {
        context.coordinator.onCaptured = onCaptured
        context.coordinator.onError = onError
        context.coordinator.onCancel = onCancel
    }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        var onCaptured: (OutgoingFile) -> Void
        var onError: (String) -> Void
        var onCancel: () -> Void

        init(
            onCaptured: @escaping (OutgoingFile) -> Void,
            onError: @escaping (String) -> Void,
            onCancel: @escaping () -> Void
        ) {
            self.onCaptured = onCaptured
            self.onError = onError
            self.onCancel = onCancel
        }

        func imagePickerController(
            _ picker: UIImagePickerController,
            didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
        ) {
            let stamp = cameraNameStamp.string(from: Date())
            // Видео камера кладёт во временный файл — читаем его так же, как документ.
            if let url = info[.mediaURL] as? URL {
                guard let data = try? Data(contentsOf: url) else {
                    onError("Не удалось прочитать снятое видео")
                    return
                }
                // Своей отсечки по размеру здесь нет нарочно: лимит один на все вложения
                // и живёт в отправке (вью-модель) — иначе камера отказывала бы по своим
                // правилам, отличным от галереи и документов.
                onCaptured(OutgoingFile(
                    bytes: data, name: "video-\(stamp).mov", mime: "video/quicktime"
                ))
                return
            }
            // JPEG, а не HEIC: HEIC не показывают ни веб, ни Android-клиент (тот же
            // перегон делает readPhotoItems для галереи).
            let picked = (info[.editedImage] as? UIImage) ?? (info[.originalImage] as? UIImage)
            guard let image = picked, let jpeg = image.jpegData(compressionQuality: 0.9) else {
                onError("Не удалось прочитать снимок")
                return
            }
            onCaptured(OutgoingFile(
                bytes: jpeg, name: "photo-\(stamp).jpg", mime: "image/jpeg"
            ))
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            onCancel()
        }
    }
}

/// Штамп для имён снятого: у кадра из камеры исходного имени файла нет.
private let cameraNameStamp: DateFormatter = {
    let formatter = DateFormatter()
    formatter.dateFormat = "yyyyMMdd-HHmmss"
    return formatter
}()
