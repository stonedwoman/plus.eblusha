import QuartzCore
import SwiftUI
import UIKit

// Порт компонентов мультивыбора и пересылки из `ui/chat/ChatScreen.kt`:
// SelectionCheck (~1768) / SelectionActionBar (~2109) / ReplyDraftPreview (~2172) /
// ForwardPickerSheet (~2199). Шапки режима выбора (SelectionTopBar) здесь больше нет:
// счётчик и «Отмена» живут в системной панели навигации (ChatView.headerToolbar).

/// Кружок-галка выбора: залитая, когда выбран, пустой контур — когда нет.
///
/// Переключение с «попом»: у Telegram это три ручных отрезка масштаба (1.0→0.9 за 0.08,
/// 0.9→1.1 за 0.13, 1.1→1.0 за 0.1), одна пружина с малым затуханием даёт тот же отскок
/// без таймеров. Невыбранный кружок так и остаётся чуть меньше — ровно прежние 22 pt из
/// 24, поэтому колонка контуров выглядит как была, а выбранный слегка выступает.
///
/// Рамка фиксированная: глифы `circle` и `checkmark.circle.fill` разной ширины, и без
/// неё каждая галка подвигала бы соседнее содержимое строки.
struct SelectionCheck: View {
    let selected: Bool

    var body: some View {
        Image(systemName: selected ? "checkmark.circle.fill" : "circle")
            .font(.system(size: 24))
            .foregroundStyle(selected ? Eb.brand : Eb.textMuted)
            // Штатная подмена символа вместо «исчез один, появился другой».
            .contentTransition(.symbolEffect(.replace))
            .frame(width: 26, height: 26)
            .scaleEffect(selected ? 1 : 0.92)
            .animation(.spring(response: 0.25, dampingFraction: 0.55), value: selected)
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
    /// Сколько сообщений реально удалится (свои неудалённые, vm.deletableSelectedCount).
    /// nil — вызов без счётчика: подписываем общим числом выбранных, как раньше.
    var deleteCount: Int? = nil
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
                // Пустой выбор стал достижимым состоянием (снятие последней галки режим
                // больше не гасит), поэтому действия при нуле выбранных — неактивны:
                // иначе «Копировать» молча гасило бы режим, а «Переслать» ругалось бы
                // «нечего пересылать». У «Удалить» это уже делает canDelete.
                SelectionAction(
                    icon: "arrowshape.turn.up.left", label: "Ответить",
                    enabled: count > 0, action: onReply
                )
                if canForward {
                    SelectionAction(
                        icon: "arrowshape.turn.up.right",
                        label: count > 0 ? "Переслать \(count)" : "Переслать",
                        enabled: count > 0,
                        action: onForward
                    )
                }
                SelectionAction(
                    icon: "doc.on.doc", label: "Копировать",
                    enabled: count > 0, action: onCopy
                )
                SelectionAction(
                    icon: "trash",
                    label: deleteLabel,
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

    /// Число в подписи — то, что исчезнет на самом деле.
    private var deleteLabel: String {
        let n = deleteCount ?? count
        return n > 0 ? "Удалить \(n)" : "Удалить"
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

/// Шит выбора беседы-получателя пересылки. Тексты — порт модала пересылки из веба
/// (frontend/src/ui/pages/chats/render/ChatModals.tsx:2725-2790): заголовок со счётчиком,
/// подсказка о том, ЧТО будет дальше (откроется чат, можно приписать комментарий), и
/// объяснение пустого списка.
struct ForwardPickerSheet: View {
    let repo: ChatRepository
    let currentConversationId: String
    let onPick: (String) -> Void
    /// Сколько сообщений пересылаем — только для заголовка. Со значением по умолчанию:
    /// старый вызов без счётчика обязан продолжать компилироваться.
    var messageCount: Int = 0

    @State private var conversations: [Conversation] = []
    /// Список бесед уже загружен: до этого «нет бесед» показывать нельзя — это не пустота,
    /// а ещё не пришедший ответ.
    @State private var loaded = false

    /// Беседы-кандидаты: без текущей (переслать себе же в этот чат веб не предлагает).
    private var targets: [Conversation] {
        conversations.filter { $0.id != currentConversationId }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(messageCount > 1 ? "Переслать сообщения (\(messageCount))" : "Переслать в…")
                .font(.body.weight(.semibold))
                .foregroundStyle(Eb.textPrimary)
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
            Text("Выберите беседу — откроется чат, можно добавить комментарий и отправить.")
                .font(.caption)
                .foregroundStyle(Eb.textMuted)
                .padding(.horizontal, 16)
                .padding(.bottom, 8)
            if loaded, targets.isEmpty {
                Text("Нет других бесед для пересылки. Откройте ещё один диалог или группу.")
                    .font(.footnote)
                    .foregroundStyle(Eb.textMuted)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity)
                    .padding(.horizontal, 24)
                    .padding(.vertical, 28)
            }
            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(targets) { conv in
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
            loaded = true
        }
    }
}

// MARK: - Копирование в буфер

// Порт buildMessageCopyText (frontend/src/ui/pages/chats/chatsMessages.ts:58-110) и
// describeCopyableAttachment (chatsAttachments.ts:383-392).
//
// iOS клал в буфер только `content`, поэтому у пересланного сообщения терялось
// «Переслано от …», у ответа — цитата, а у файла — его имя; у сообщения без подписи пункта
// «Копировать» не было вовсе. Веб собирает текст по строгому порядку блоков, а при пустом
// тексте кладёт саму картинку — здесь ровно то же.

/// Текст сообщения для буфера: шапка мультиответа с цитатами, «Переслано от …», цитата
/// одиночного ответа, текст, строки вложений. Пусто — копировать нечего (сообщение
/// состоит из одних картинок; их кладёт `copyMessageToClipboard`).
func buildMessageCopyText(_ message: Message) -> String {
    var parts: [String] = []

    // Мультиответ (≥2 цитаты) — как metadata.replyQuoteBundle в вебе: заголовок со
    // счётчиком и по строке на цитату.
    let quotes = message.replyTo
    let isQuoteBundle = quotes.count >= 2
    if isQuoteBundle {
        parts.append("Ответ на \(quotes.count) \(pluralMessages(quotes.count))")
        for quote in quotes {
            parts.append("— \(copyQuotePreview(quote))")
        }
    }

    if let forward = message.forwardFrom {
        let who = forward.authorName.trimmed()
        if !who.isEmpty {
            let groupTitle = (forward.sourceChatTitle ?? "").trimmed()
            let peer = (forward.directChatPeerName ?? "").trimmed()
            if forward.isGroupSource, !groupTitle.isEmpty {
                parts.append("Переслано от \(who), из «\(groupTitle)»")
            } else if !peer.isEmpty {
                parts.append("Переслано от \(who), из переписки с \(peer)")
            } else {
                parts.append("Переслано от \(who)")
            }
        }
    }

    // Одиночная цитата — тот же заголовок «Ответ на 1 сообщение», что и у пачки.
    if !isQuoteBundle {
        let single = (quotes.first?.content ?? "").trimmed()
        if !single.isEmpty {
            parts.append("Ответ на 1 \(pluralMessages(1))")
            parts.append("— \(single)")
        }
    }

    let content = (message.content ?? "").trimmed()
    if !content.isEmpty {
        parts.append(content)
    }

    parts.append(contentsOf: message.attachments.compactMap(copyableAttachmentLine))

    return parts.joined(separator: "\n").trimmed()
}

/// Описание вложения строкой — «Видео: clip.mp4» / «Аудио: …» / «Файл: …», а без имени
/// просто «Видео»/«Аудио»/«Файл». Картинка словами НЕ описывается (веб возвращает null):
/// её копируют как изображение.
func copyableAttachmentLine(_ att: MessageAttachment) -> String? {
    let name = copyAttachmentFileName(att)
    switch copyAttachmentRenderType(att) {
    case "IMAGE": return nil
    case "VIDEO": return name == "Файл" ? "Видео" : "Видео: \(name)"
    case "AUDIO": return name == "Файл" ? "Аудио" : "Аудио: \(name)"
    default: return name == "Файл" ? "Файл" : "Файл: \(name)"
    }
}

/// Тип вложения для подписи — порт inferAttachmentRenderType: серверному типу верим, а
/// «FILE» доопределяем по mime и расширению (видео проверяется раньше аудио, как в вебе).
private func copyAttachmentRenderType(_ att: MessageAttachment) -> String {
    let declared = att.type.uppercased()
    if declared == "IMAGE" || declared == "VIDEO" || declared == "AUDIO" { return declared }

    let mime = (att.mime ?? "").trimmed().lowercased()
    let ext = copyAttachmentExtension(att)
    if mime.hasPrefix("video/") || ["mp4", "webm", "mov", "m4v"].contains(ext) { return "VIDEO" }
    if mime.hasPrefix("audio/") || ["mp3", "m4a", "ogg", "wav"].contains(ext) { return "AUDIO" }
    return "FILE"
}

/// Расширение из имени или url. У выгруженных файлов сверху лежит «.eblusha» (шифрованный
/// блоб) — настоящее расширение под ним, поэтому его снимаем.
private func copyAttachmentExtension(_ att: MessageAttachment) -> String {
    let candidate = (att.name ?? "").trimmed().isEmpty ? att.url : (att.name ?? "").trimmed()
    var ext = (candidate.split(separator: ".").last.map { String($0) } ?? "").lowercased()
    if ext == "eblusha" {
        let withoutBlobSuffix = String(candidate.dropLast(".eblusha".count))
        ext = (withoutBlobSuffix.split(separator: ".").last.map { String($0) } ?? ext).lowercased()
    }
    return ext
}

/// Имя файла — порт resolveAttachmentFileName: сперва метаданные, затем последний сегмент
/// url, и «Файл» как признак «имени нет» (веб по этому же слову решает, писать ли двоеточие).
private func copyAttachmentFileName(_ att: MessageAttachment) -> String {
    let fromMeta = (att.name ?? "").trimmed()
    if !fromMeta.isEmpty { return fromMeta }
    if let fromUrl = copyFileNameFromUrl(att.url), !fromUrl.lowercased().hasSuffix(".eblusha") {
        return fromUrl
    }
    return "Файл"
}

private func copyFileNameFromUrl(_ rawUrl: String) -> String? {
    let clean = rawUrl.components(separatedBy: "?")[0].components(separatedBy: "#")[0]
    guard let last = clean.split(separator: "/").last, !last.isEmpty else { return nil }
    let name = String(last)
    return name.removingPercentEncoding ?? name
}

/// Обрезка цитаты как в вебе (parseReplyQuoteBundleEntries): длинные превью режутся на 240
/// символов, пустое превью становится словом «Сообщение».
private func copyQuotePreview(_ quote: ReplyInfo) -> String {
    var preview = (quote.content ?? "").trimmed()
    if preview.count > 240 { preview = "\(preview.prefix(237))…" }
    return preview.isEmpty ? "Сообщение" : preview
}

/// «Копировать» одного сообщения: есть текст — в буфер уходит он, нет — сама картинка
/// (веб: ChatModals.tsx:2632-2645). Картинку берём из кэша ленты, а при промахе догружаем:
/// молчаливое «ничего не скопировалось» хуже, чем копирование через полсекунды.
///
/// `@MainActor` — потому что UIPasteboard в новых SDK изолирован в главный актор (ровно
/// поэтому @MainActor висит и на PhotoViewerActions); все вызовы и так идут из обработчиков
/// SwiftUI, так что ограничение ничего не стоит.
@MainActor
func copyMessageToClipboard(_ message: Message) {
    let text = buildMessageCopyText(message)
    if !text.isEmpty {
        UIPasteboard.general.string = text
        return
    }
    // Секретное вложение по своему url отдаёт шифртекст, а ключ треда живёт во вьюмодели —
    // из буфера его не достать, поэтому такие картинки не копируем.
    guard let image = message.attachments.first(where: { $0.type == "IMAGE" && $0.secretNonce == nil }),
          let url = resolveMediaUrl(image.url).flatMap({ URL(string: $0) })
    else { return }
    if let hot = ImageLoader.shared.cached(url) {
        UIPasteboard.general.image = hot
        return
    }
    Task {
        if let loaded = await ImageLoader.shared.load(url) {
            UIPasteboard.general.image = loaded
        }
    }
}

/// «Копировать» в мультивыборе: каждое сообщение — своим блоком, в порядке ленты. Одно
/// выбранное сообщение обрабатывается как в меню (включая картинку без подписи).
@MainActor
func copyMessagesToClipboard(_ messages: [Message]) {
    let usable = messages.filter { !$0.isSystem }
    if usable.count == 1, let single = usable.first {
        copyMessageToClipboard(single)
        return
    }
    let text = usable.map(buildMessageCopyText).filter { !$0.isEmpty }.joined(separator: "\n")
    // Пустой буфер не затираем: раньше выбор одних картинок очищал ранее скопированное.
    guard !text.isEmpty else { return }
    UIPasteboard.general.string = text
}

// MARK: - Протяжка двумя пальцами: выделение пачкой

// Выбрать 10-15 подряд идущих сообщений («переслать кусок переписки») стоило пятнадцати
// прицельных тапов. Здесь — второй способ ввода той же функции: два пальца ведут по ленте
// и отмечают всё, через что прошли, а возврат пальца назад по своему следу откатывает
// переключения — промах прощается тем же движением, каким сделан.
//
// Числа поведения взяты из разбора Telegram-iOS (/tmp/tg-selection.md), код — свой.

/// Пороги протяжки.
enum MessageSelectionPanMetrics {
    /// Вертикальное смещение, после которого жест берётся за дело.
    static let activationThreshold: CGFloat = 5
    /// Полоса у верхнего и нижнего края ленты, в которой включается автопрокрутка.
    static let autoScrollZone: CGFloat = 50
    /// Сколько палец должен простоять у края, прежде чем лента поедет сама.
    static let autoScrollDelay: CFTimeInterval = 0.45
    /// Максимальный шаг автопрокрутки за кадр.
    static let autoScrollStep: CGFloat = 15
    /// Медленнее этой доли шага автопрокрутка не идёт — иначе у самой границы полосы
    /// лента ползёт незаметно и кажется, что жест сломался.
    static let autoScrollMinFactor: CGFloat = 0.15
    /// Шаг досбора строк между двумя отсчётами жеста (см. `samples(to:)`).
    static let samplingStep: CGFloat = 12
}

/// Распознаватель протяжки: ровно два пальца, старт после 5 pt по вертикали.
///
/// Свой подкласс нужен ровно из-за порога: штатный UIPanGestureRecognizer начинается
/// после ~10 pt, а к этому моменту палец уже сходит с первой строки, и мазок начинается
/// со второго сообщения. Горизонтальное движение двумя пальцами мы не берём вовсе.
final class MessageSelectionPanRecognizer: UIPanGestureRecognizer {

    private var origin: CGPoint?

    override func reset() {
        super.reset()
        origin = nil
    }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        super.touchesBegan(touches, with: event)
        // Пальцы ложатся не одновременно: точку отсчёта берём, когда их стало двое.
        guard state == .possible, numberOfTouches == 2, origin == nil else { return }
        origin = location(in: view)
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) {
        super.touchesMoved(touches, with: event)
        // Базовый класс начал бы жест сам, но позже и по любому направлению.
        guard state == .possible, numberOfTouches == 2, let origin else { return }
        let point = location(in: view)
        let dy = abs(point.y - origin.y)
        let dx = abs(point.x - origin.x)
        guard dy >= MessageSelectionPanMetrics.activationThreshold, dy > dx else { return }
        state = .began
    }
}

/// Ведёт мазок выделения по ленте и у края катит ленту сам.
///
/// Живёт отдельно от контроллера ленты намеренно: весь автомат (направление, стопка
/// пройденных строк, откат) — это чистая логика над тремя замыканиями, а в MessageListView
/// остаётся только создание и проводка. Так двухпальцевый жест не попадает в тамошний
/// арбитраж, где ЛЮБОЙ не-скролловый pan считается свайпом-ответом: делегат у этого
/// распознавателя свой, этот класс.
@MainActor
final class MessageSelectionPanDriver: NSObject {

    /// Строка под пальцем: её id и текущее состояние выбора.
    struct RowHit {
        let id: String
        let selected: Bool
    }

    /// Мост к ленте. Замыкания ставит контроллер: сам драйвер знает про ленту ровно
    /// столько, сколько нужно, чтобы найти строку под пальцем и подвинуть прокрутку.
    struct Hooks {
        /// Строка в точке (координаты СОДЕРЖИМОГО коллекции) или nil — там ничего,
        /// что можно выделять (пусто, системная плашка, ещё не отправленный пузырь).
        let rowAt: (CGPoint) -> RowHit?
        /// Пакетно выбрать/снять (ChatViewModel.setSelected).
        let setSelected: ([String], Bool) -> Void
        /// Можно ли сейчас двигать ленту: false, пока вклеивается страница истории — её
        /// позицию восстанавливают по якорю, и наш сдвиг в этот момент дал бы прыжок.
        let canScroll: () -> Bool
        /// Идёт свайп-ответ: тогда жест не начинаем вовсе.
        let isBusy: () -> Bool
    }

    /// Автопрокрутка у краёв — самая рискованная половина жеста: у верхнего края она
    /// въезжает в подгрузку истории. Если на устройстве лента дёргается, достаточно
    /// поставить здесь false: сам мазок этим не ломается, просто перестаёт продлеваться
    /// за пределы экрана.
    var autoScrollEnabled = true

    /// Сам распознаватель — чтобы арбитраж ленты мог узнать его в лицо.
    var gestureRecognizer: UIGestureRecognizer { recognizer }

    private let recognizer = MessageSelectionPanRecognizer()
    private weak var collection: UICollectionView?
    private var hooks: Hooks?

    /// Направление мазка: выбираем или снимаем. Решается по первой строке под пальцем.
    private var selecting = false
    /// След: пройденные строки по порядку, первая — начальная. Возврат пальца назад
    /// откатывает всё, что после совпавшей строки.
    private var trail: [String] = []
    /// Точка, по которой уже собирали строки, — от неё досчитываем пропуски.
    private var lastSamplePoint: CGPoint?
    private var displayLink: CADisplayLink?
    /// Когда палец вошёл в краевую полосу: до +0.45 с лента стоит.
    private var edgeEnteredAt: CFTimeInterval?

    /// Повесить жест на ленту.
    func attach(to collectionView: UICollectionView, hooks: Hooks) {
        collection = collectionView
        self.hooks = hooks
        recognizer.minimumNumberOfTouches = 2
        recognizer.maximumNumberOfTouches = 2
        recognizer.delegate = self
        recognizer.addTarget(self, action: #selector(handlePan(_:)))
        collectionView.addGestureRecognizer(recognizer)
        // Прокрутка остаётся ОДНОпальцевой. Иначе UIScrollView листает теми же двумя
        // пальцами, лента едет под мазком и отмечается не то. Привычное листание одним
        // пальцем это не трогает.
        collectionView.panGestureRecognizer.maximumNumberOfTouches = 1
    }

    @objc private func handlePan(_ gesture: UIPanGestureRecognizer) {
        guard let collection, let hooks else { return }
        switch gesture.state {
        case .began:
            let point = gesture.location(in: collection)
            guard let hit = hooks.rowAt(point) else {
                // Начали с пустого места — мазку не от чего оттолкнуться.
                finish()
                return
            }
            // Лента могла ещё катиться по инерции с прошлого листания: гасим, иначе
            // строки поедут под неподвижными пальцами.
            if collection.isDecelerating {
                collection.setContentOffset(collection.contentOffset, animated: false)
            }
            // Направление задаёт первая строка: не выбрана — мазок выбирает, выбрана —
            // снимает. И сразу переключаем её саму.
            selecting = !hit.selected
            trail = [hit.id]
            lastSamplePoint = point
            hooks.setSelected([hit.id], selecting)
            startAutoScrollClock()
        case .changed:
            advance(to: gesture.location(in: collection))
        default:
            finish()
        }
    }

    /// Довести мазок до точки, собрав всё, через что палец прошёл по дороге.
    private func advance(to point: CGPoint) {
        guard let hooks, !trail.isEmpty else { return }
        for sample in samples(to: point) {
            guard let hit = hooks.rowAt(sample) else { continue }
            apply(rowId: hit.id, hooks: hooks)
        }
        lastSamplePoint = point
    }

    /// Промежуточные пробы между прошлой точкой и текущей: между двумя отсчётами жеста
    /// палец проезжает десятки точек, и короткая строка посреди мазка (однословный ответ)
    /// иначе осталась бы неотмеченной.
    private func samples(to point: CGPoint) -> [CGPoint] {
        guard let previous = lastSamplePoint else { return [point] }
        let dx = point.x - previous.x
        let dy = point.y - previous.y
        let distance = max(abs(dx), abs(dy))
        let steps = Int(distance / MessageSelectionPanMetrics.samplingStep)
        guard steps > 1 else { return [point] }
        // Потолок на случай рывка через весь экран: перебирать сотни точек незачем.
        let capped = min(steps, 60)
        return (1...capped).map { step in
            let ratio = CGFloat(step) / CGFloat(capped)
            return CGPoint(x: previous.x + dx * ratio, y: previous.y + dy * ratio)
        }
    }

    /// Одна строка под пальцем: либо продолжаем след, либо откатываемся по нему назад.
    private func apply(rowId: String, hooks: Hooks) {
        if let index = trail.firstIndex(of: rowId) {
            // Палец вернулся к уже пройденной строке — снимаем всё, что было после неё.
            guard index < trail.count - 1 else { return }
            let undo = Array(trail[(index + 1)...])
            trail.removeSubrange((index + 1)...)
            hooks.setSelected(undo, !selecting)
        } else {
            trail.append(rowId)
            hooks.setSelected([rowId], selecting)
        }
    }

    private func startAutoScrollClock() {
        guard autoScrollEnabled, displayLink == nil else { return }
        edgeEnteredAt = nil
        let link = CADisplayLink(target: self, selector: #selector(stepAutoScroll))
        // .common — иначе во время самой прокрутки такт пропадает.
        link.add(to: .main, forMode: .common)
        displayLink = link
    }

    @objc private func stepAutoScroll() {
        guard let collection, let hooks, !trail.isEmpty else {
            // Ленты больше нет (экран закрыли посреди мазка) или мазок кончился: такт
            // держит драйвер ссылкой, и без этого он тикал бы до конца жизни процесса.
            finish()
            return
        }
        let point = recognizer.location(in: collection)
        // Близость к краю считаем в ВИДИМЫХ координатах: точка жеста — в координатах
        // содержимого, а полоса в 50 pt живёт у края экрана.
        let visibleY = point.y - collection.contentOffset.y
        let height = collection.bounds.height
        let zone = MessageSelectionPanMetrics.autoScrollZone
        var direction: CGFloat = 0
        var factor: CGFloat = 0
        if visibleY < zone {
            direction = -1
            factor = (zone - visibleY) / zone
        } else if visibleY > height - zone {
            direction = 1
            factor = (visibleY - (height - zone)) / zone
        }
        guard direction != 0 else {
            edgeEnteredAt = nil
            return
        }
        let now = CACurrentMediaTime()
        guard let entered = edgeEnteredAt else {
            // Первый кадр у края: с этого мгновения отсчитываем задержку, чтобы лента не
            // трогалась от того, что мазок просто дошёл до нижнего сообщения.
            edgeEnteredAt = now
            return
        }
        guard now - entered >= MessageSelectionPanMetrics.autoScrollDelay,
              hooks.canScroll() else { return }
        let speed = MessageSelectionPanMetrics.autoScrollStep
            * max(MessageSelectionPanMetrics.autoScrollMinFactor, min(1, factor))
        let targetY = clampedOffsetY(collection.contentOffset.y + direction * speed, in: collection)
        guard targetY != collection.contentOffset.y else { return }
        // Без анимации: анимированный сдвиг накладывался бы сам на себя каждый кадр.
        collection.setContentOffset(
            CGPoint(x: collection.contentOffset.x, y: targetY), animated: false
        )
        // Лента уехала — под пальцем теперь другие строки, хотя сам палец не двигался и
        // .changed не придёт; собрать их больше некому.
        advance(to: recognizer.location(in: collection))
    }

    /// Не даём уехать за пределы содержимого: у края отрицательный offset дал бы резинку,
    /// которую потом отбрасывает обратно.
    private func clampedOffsetY(_ value: CGFloat, in collection: UICollectionView) -> CGFloat {
        let inset = collection.adjustedContentInset
        let minY = -inset.top
        let maxY = max(minY, collection.contentSize.height + inset.bottom - collection.bounds.height)
        return min(max(value, minY), maxY)
    }

    private func finish() {
        trail = []
        lastSamplePoint = nil
        edgeEnteredAt = nil
        displayLink?.invalidate()
        displayLink = nil
    }
}

extension MessageSelectionPanDriver: UIGestureRecognizerDelegate {

    /// Берёмся только за вертикальное движение ровно двумя пальцами по строке сообщения
    /// и только когда лента не занята свайпом-ответом.
    func gestureRecognizerShouldBegin(_ gesture: UIGestureRecognizer) -> Bool {
        guard let pan = gesture as? UIPanGestureRecognizer,
              let collection, let hooks,
              pan.numberOfTouches == 2, !hooks.isBusy()
        else { return false }
        let velocity = pan.velocity(in: collection)
        guard abs(velocity.y) >= abs(velocity.x) else { return false }
        return hooks.rowAt(pan.location(in: collection)) != nil
    }

    /// Мазок ленту ни с кем не делит: ни с прокруткой, ни со свайпом-ответом, ни с
    /// долгим нажатием. С прокруткой они и так разведены по числу пальцев.
    func gestureRecognizer(
        _ gesture: UIGestureRecognizer,
        shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer
    ) -> Bool { false }
}
