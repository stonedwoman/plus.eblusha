import SwiftUI
import Combine

// Поток пересылки — порт веб-логики «выбрал получателя → черновик в композере получателя
// → комментарий → отправка одним пакетом»:
//   • тап по беседе НИЧЕГО не отправляет, а кладёт черновик и переключает чат —
//     frontend/src/ui/pages/chats/render/ChatModals.tsx:2815-2882;
//   • чип «Переслать сообщения (N)» с крестиком над композером —
//     frontend/src/ui/pages/chats/render/MessagesPane.tsx:2877-2939;
//   • подпись «Комментарий к пересылке (необязательно)…» — MessagesPane.tsx:3326-3328;
//   • отправка по кнопке с комментарием — MessagesPane.tsx:3229-3258 →
//     executeForwardPayloadDelivery (ChatsPage.tsx:1463-1530).
//
// Почему отдельный файл, а не ChatView.swift: экран чата и без пересылки большой, а
// черновик живёт ДОЛЬШЕ экрана — он переживает переход из чата-источника в чат-получатель.

/// Ключ metadata с комментарием к пересылке. Веб: FORWARD_COMPOSER_CAPTION_META_KEY
/// (frontend/src/ui/pages/chats/chatsMessages.ts:388) — имя обязано совпадать байт-в-байт,
/// иначе приписка, отправленная с телефона, не покажется в браузере и наоборот.
let forwardComposerCaptionMetaKey = "forwardComposerCaption"

// MARK: - Черновик пересылки

/// Отложенная пересылка, ждущая отправки В БЕСЕДЕ-ПОЛУЧАТЕЛЕ (порт forwardComposerDraft,
/// frontend/src/ui/pages/ChatsPage.tsx:227): какие сообщения, куда и когда отложили.
struct ForwardDraft: Equatable {
    let destinationConversationId: String
    /// Название беседы-получателя: нужно и плашке, и итогу «Переслано в «…»».
    let destinationTitle: String
    let messages: [Message]
    /// Когда черновик положили — по нему отбрасываем забытые (см. `ForwardDraftStore.ttl`).
    let stagedAt: Date

    init(
        destinationConversationId: String,
        destinationTitle: String,
        messages: [Message],
        stagedAt: Date = Date()
    ) {
        self.destinationConversationId = destinationConversationId
        self.destinationTitle = destinationTitle
        self.messages = messages
        self.stagedAt = stagedAt
    }

    var count: Int { messages.count }
}

/// Передача черновика между экранами: лист выбора получателя кладёт его здесь, а
/// вьюмодель беседы-получателя забирает при своём создании. Через синглтон, а не через
/// параметр навигации, потому что ChatView получателя создаётся НЕ нами, а стеком
/// навигации (RootView), и передать ему что-либо по пути неоткуда.
///
/// Без @MainActor (как AppLifecycle): пользуемся только с главного потока — из вью и из
/// @MainActor-вьюмодели, так что замок не нужен, а изоляция не мешает `sink`.
final class ForwardDraftStore: ObservableObject {
    static let shared = ForwardDraftStore()

    /// Забытый черновик не должен ожить через час и молча уйти при следующем входе в чат.
    private static let ttl: TimeInterval = 5 * 60

    @Published private(set) var pending: ForwardDraft?

    private init() {}

    func stage(_ draft: ForwardDraft) {
        pending = draft
    }

    /// Черновик, адресованный этой беседе (иначе nil). Чтение НЕ одноразовое: SwiftUI
    /// пересоздаёт структуру экрана много раз и вместе с ней вьюмодель, из которых живёт
    /// только одна — «забирающее» чтение мог съесть выброшенный экземпляр, и пересылка
    /// пропадала бы молча. Черновик снимается там, где это осмысленно: после отправки
    /// или по крестику (`clear`).
    func draft(for conversationId: String) -> ForwardDraft? {
        guard let draft = pending,
              draft.destinationConversationId == conversationId,
              Date().timeIntervalSince(draft.stagedAt) <= Self.ttl
        else { return nil }
        return draft
    }

    func clear() {
        pending = nil
    }
}

// MARK: - Предпросмотр в плашке

/// Строка предпросмотра пересылаемого сообщения — порт previewTextForReplyDraft
/// (frontend/src/ui/pages/chats/chatsMessages.ts:155-187): сначала текст, иначе тип
/// первого вложения, а у файла — его имя (слово «Вложение» ничего не объясняет).
func forwardDraftPreviewLine(_ message: Message) -> String {
    let raw = (message.content ?? "").trimmed()
    if !raw.isEmpty {
        return raw.count > 120 ? "\(raw.prefix(117))…" : raw
    }
    guard let first = message.attachments.first else { return "Сообщение" }
    switch first.type {
    case "IMAGE": return "Фото"
    case "VIDEO": return "Видео"
    case "AUDIO": return "Голосовое сообщение"
    default:
        let name = (first.name ?? "").trimmed()
        return name.isEmpty ? "Файл" : name
    }
}

/// Плашка отложенной пересылки над композером беседы-получателя (веб-чип
/// MessagesPane.tsx:2877-2939): что уйдёт, кнопка «Переслать» и крестик «Отменить».
struct ForwardDraftBar: View {
    let draft: ForwardDraft
    /// Композер пуст. Кнопка «Переслать» нужна именно тогда: у пустого композера вместо
    /// стрелки «отправить» стоит микрофон (ChatComposer.inputRow), и без своей кнопки
    /// пересылку БЕЗ комментария отправить было бы нечем.
    let composerEmpty: Bool
    let sending: Bool
    let onSend: () -> Void
    let onCancel: () -> Void

    /// Веб показывает до 5 строк предпросмотра; на телефоне полоса уже — хватает трёх.
    private static let maxPreviewLines = 3

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "arrowshape.turn.up.right")
                .font(.system(size: 17))
                .foregroundStyle(Eb.brand)
            RoundedRectangle(cornerRadius: 2)
                .fill(Eb.brand)
                .frame(width: 3, height: 34)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Eb.brand)
                    .lineLimit(1)
                ForEach(Array(previewLines.enumerated()), id: \.offset) { row in
                    Text(row.element)
                        .font(.caption)
                        .foregroundStyle(Eb.textMuted)
                        .lineLimit(1)
                }
                if draft.count > Self.maxPreviewLines {
                    Text("…ещё \(draft.count - Self.maxPreviewLines)")
                        .font(.caption2)
                        .foregroundStyle(Eb.textMuted)
                }
                if composerEmpty {
                    // Роль поля ввода при живом черновике надо объяснить: в вебе об этом
                    // говорит подсказка в самом композере, которой у нас пока нет.
                    Text("Комментарий к пересылке (необязательно) — в поле ввода")
                        .font(.caption2)
                        .foregroundStyle(Eb.textMuted)
                        .lineLimit(2)
                }
            }
            Spacer(minLength: 4)
            if composerEmpty {
                Button(action: onSend) {
                    Text("Переслать")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 7)
                        .background(sending ? Eb.surface300 : Eb.brand, in: Capsule())
                }
                .disabled(sending)
            }
            Button(action: onCancel) {
                Image(systemName: "xmark")
                    .font(.caption)
                    .foregroundStyle(Eb.textMuted)
                    .frame(width: 32, height: 32)
            }
            .accessibilityLabel("Отменить пересылку")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Eb.surface100, in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Eb.border))
        .padding(.horizontal, 10)
        .padding(.top, 8)
    }

    /// Веб: одна пересылка — «Переслать», несколько — «Переслать сообщения (N)».
    private var title: String {
        draft.count > 1 ? "Переслать сообщения (\(draft.count))" : "Переслать"
    }

    private var previewLines: [String] {
        draft.messages.prefix(Self.maxPreviewLines).map(forwardDraftPreviewLine)
    }
}

// MARK: - Отправка пересылки с комментарием

extension ChatRepository {

    /// Пересылка с припиской из композера: то же, что `forwardMessage`, плюс
    /// `metadata.forwardComposerCaption` (веб кладёт комментарий в metadata ПЕРВОГО
    /// сообщения пачки — ChatsPage.tsx:1513-1523, читает extractForwardComposerCaption).
    ///
    /// Отдельным методом, а не параметром существующего `forwardMessage`: тот живёт в
    /// ChatRepositoryForward.swift, и без приписки мы честно зовём именно его — весь
    /// проводной формат остаётся в одном месте.
    func forwardMessage(
        targetConversationId: String, message: Message, composerCaption: String?
    ) async -> ApiResult<Void> {
        let caption = (composerCaption ?? "").trimmed()
        guard !caption.isEmpty else {
            return await forwardMessage(targetConversationId: targetConversationId, message: message)
        }
        return await safeApiCall {
            let attachments: [AttachmentReq]? = message.attachments.isEmpty
                ? nil
                : message.attachments.map { att in
                    AttachmentReq(
                        url: att.url,
                        type: att.type,
                        size: att.size,
                        metadata: AttachmentMetadataReq(
                            originalName: att.name, mime: att.mime,
                            width: att.width, height: att.height
                        )
                    )
                }
            let srcConv = await self.conversationMeta(message.conversationId)
            // Пересылка пересылки сохраняет ПЕРВОИСТОЧНИК (как в ChatRepositoryForward).
            let existing = message.forwardFrom
            let isGroupSource = existing?.isGroupSource ?? (srcConv?.isGroup == true)
            let info = ForwardInfo(
                authorName: existing?.authorName ?? message.senderName,
                sourceChatTitle: existing?.sourceChatTitle
                    ?? (isGroupSource ? srcConv?.title : nil),
                isGroupSource: isGroupSource,
                directChatPeerName: existing?.directChatPeerName
                    ?? (!isGroupSource ? srcConv?.title : nil),
                originalCreatedAt: existing?.originalCreatedAt ?? message.createdAt
            )
            let trimmedContent = message.content?.trimmed()
            let _: SendMessageResponse = try await AppContainer.shared.api.post(
                "conversations/send",
                body: SendMessageRequest(
                    conversationId: targetConversationId,
                    type: message.type,
                    content: (trimmedContent?.isEmpty == false) ? message.content : nil,
                    attachments: attachments,
                    metadata: buildForwardMetadataWithCaption(
                        info,
                        originalIso: millisToIso(info.originalCreatedAt ?? message.createdAt),
                        caption: caption,
                        audioDurationSec: message.audioDurationSec,
                        waveform: message.waveform
                    )
                )
            )
        }
    }
}

/// Тот же `metadata`, что у обычной пересылки, плюс ключ комментария. Дублирует сборку из
/// ChatRepositoryForward.swift сознательно: там она приватная, а лезть в чужой файл
/// ради одного ключа хуже, чем держать здесь узкий вариант (см. отчёт — предложен
/// параметр `composerCaption` у исходного forwardMessage, тогда эта копия уйдёт).
private func buildForwardMetadataWithCaption(
    _ info: ForwardInfo,
    originalIso: String,
    caption: String,
    audioDurationSec: Int? = nil,
    waveform: [Int]? = nil
) -> JSONValue {
    var md: [String: JSONValue] = [
        "forwardOriginalCreatedAt": .string(originalIso),
        forwardComposerCaptionMetaKey: .string(caption),
    ]
    if !info.isGroupSource,
       let peer = info.directChatPeerName, !peer.trimmed().isEmpty {
        md["sourceDmPeerName"] = .string(peer)
    }
    // Пересланный войс не теряет длительность и волну.
    if let audioDurationSec {
        md["duration"] = .number(Double(audioDurationSec))
    }
    if let waveform, !waveform.isEmpty {
        md["waveform"] = .array(waveform.map { .number(Double($0)) })
    }
    var forwardFrom: [String: JSONValue] = [
        "authorName": .string(info.authorName),
        "sourceChatTitle": info.sourceChatTitle.map(JSONValue.string) ?? .null,
        "isGroupSource": .bool(info.isGroupSource),
        "originalCreatedAt": .string(originalIso),
    ]
    if !info.isGroupSource {
        forwardFrom["directChatPeerName"] =
            info.directChatPeerName.map(JSONValue.string) ?? .null
    }
    md["forwardFrom"] = .object(forwardFrom)
    return .object(md)
}
