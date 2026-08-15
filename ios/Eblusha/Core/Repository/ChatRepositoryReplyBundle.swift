import Foundation

// Порт мультиответа из `data/repository/ChatRepository.kt` (sendText c replyBundle +
// buildReplyBundleMetadata, ~560-620): при ≥2 цитатах отправка несёт
// `metadata.replyQuoteBundle` — байт-в-байт с вебом (chatsMessages.ts:
// buildReplyQuoteMetadataForSend) и Android: messageId / senderId (только непустой) /
// preview (обрезка до 420) / createdAt (ISO, только когда известен).
//
// Приватные поля ChatRepository (api, session) из другого файла недоступны — extension
// берёт тот же APIClient через AppContainer.shared (это ровно тот объект, что внутри),
// а маппинг DTO → домен идёт через internal mapMessage.

extension ChatRepository {

    /// Отправка TEXT с опциональным мультиответом. replyToId — последняя цитата (как в
    /// Kotlin: reply.lastOrNull()), replyBundle — ВСЕ цитаты; бандл пишется в metadata
    /// только при ≥2 (одиночный ответ остаётся чистым replyToId — веб-паритет).
    func sendText(
        _ conversationId: String,
        text: String,
        replyToId: String?,
        replyBundle: [ReplyInfo]?
    ) async -> ApiResult<Message> {
        await safeApiCall {
            let bundle = (replyBundle?.count ?? 0) >= 2 ? replyBundle : nil
            let response: SendMessageResponse = try await AppContainer.shared.api.post(
                "conversations/send",
                body: SendMessageRequest(
                    conversationId: conversationId,
                    type: "TEXT",
                    content: text,
                    replyToId: replyToId,
                    metadata: bundle.map(buildReplyBundleMetadata)
                )
            )
            return self.mapMessage(response.message)
        }
    }
}

/// Собирает `metadata.replyQuoteBundle` для мультиответа (зеркалит веб-формат).
private func buildReplyBundleMetadata(_ bundle: [ReplyInfo]) -> JSONValue {
    .object([
        "replyQuoteBundle": .array(bundle.map { r in
            var row: [String: JSONValue] = [
                "messageId": .string(r.id),
                // preview пишется всегда, даже пустой (Kotlin: (content ?: "").take(420)).
                "preview": .string(String((r.content ?? "").prefix(420))),
            ]
            if !r.senderId.isEmpty { row["senderId"] = .string(r.senderId) }
            if let createdAt = r.createdAt { row["createdAt"] = .string(millisToIso(createdAt)) }
            return .object(row)
        }),
    ])
}
