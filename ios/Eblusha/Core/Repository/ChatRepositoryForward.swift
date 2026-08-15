import Foundation

// Порт пересылки из `data/repository/ChatRepository.kt` (~300-336): forwardMessage +
// buildForwardMetadata. Wire-формат метаданных (forwardOriginalCreatedAt /
// sourceDmPeerName / duration / waveform / вложенный forwardFrom) совпадает с вебом
// и Android байт-в-байт.
//
// Приватные поля ChatRepository (api, session) из другого файла недоступны — extension
// берёт тот же APIClient через AppContainer.shared (это ровно тот объект, что внутри).

extension ChatRepository {

    /// Пересылает [message] в [targetConversationId] свежим сообщением (контент +
    /// вложения копируются), помечая его `metadata.forwardFrom`, чтобы получатель
    /// нарисовал конверт пересылки + цитату оригинала. Если [message] — само
    /// пересылка, исходное происхождение сохраняется.
    func forwardMessage(
        targetConversationId: String, message: Message
    ) async -> ApiResult<Void> {
        await safeApiCall {
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
            // Роль dao.getConversation из Kotlin играет кеш бесед репозитория.
            let srcConv = await self.conversationMeta(message.conversationId)
            let existing = message.forwardFrom
            let isGroupSource = existing?.isGroupSource ?? (srcConv?.isGroup == true)
            // Название 1:1-беседы — это имя собеседника (резолвится в toDomain).
            let info = ForwardInfo(
                authorName: existing?.authorName ?? message.senderName,
                sourceChatTitle: existing?.sourceChatTitle
                    ?? (isGroupSource ? srcConv?.title : nil),
                isGroupSource: isGroupSource,
                directChatPeerName: existing?.directChatPeerName
                    ?? (!isGroupSource ? srcConv?.title : nil),
                originalCreatedAt: existing?.originalCreatedAt ?? message.createdAt
            )
            let originalIso = millisToIso(info.originalCreatedAt ?? message.createdAt)
            let trimmedContent = message.content?.trimmed()
            let _: SendMessageResponse = try await AppContainer.shared.api.post(
                "conversations/send",
                body: SendMessageRequest(
                    conversationId: targetConversationId,
                    type: message.type,
                    content: (trimmedContent?.isEmpty == false) ? message.content : nil,
                    attachments: attachments,
                    metadata: buildForwardMetadata(
                        info,
                        originalIso: originalIso,
                        audioDurationSec: message.audioDurationSec,
                        waveform: message.waveform
                    )
                )
            )
        }
    }
}

/// Собирает `metadata.forwardFrom` для отправки пересылки (зеркалит веб-формат).
private func buildForwardMetadata(
    _ info: ForwardInfo,
    originalIso: String,
    audioDurationSec: Int? = nil,
    waveform: [Int]? = nil
) -> JSONValue {
    var md: [String: JSONValue] = [
        "forwardOriginalCreatedAt": .string(originalIso),
    ]
    if !info.isGroupSource,
       let peer = info.directChatPeerName, !peer.trimmed().isEmpty {
        md["sourceDmPeerName"] = .string(peer)
    }
    // Сохраняем данные воспроизведения голосового: пересланный войс не теряет
    // длительность и волну.
    if let audioDurationSec {
        md["duration"] = .number(Double(audioDurationSec))
    }
    if let waveform, !waveform.isEmpty {
        md["waveform"] = .array(waveform.map { .number(Double($0)) })
    }
    var forwardFrom: [String: JSONValue] = [
        "authorName": .string(info.authorName),
        // null для личных чатов — как kotlinx put(nullable) пишет JsonNull.
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
