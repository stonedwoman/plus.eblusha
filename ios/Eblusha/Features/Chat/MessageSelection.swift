import SwiftUI
import UIKit

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
