import Foundation

// Порт мультиответа из `data/repository/ChatRepository.kt` (sendText c replyBundle +
// buildReplyBundleMetadata, ~560-620): при ≥2 цитатах отправка несёт
// `metadata.replyQuoteBundle` — байт-в-байт с вебом (chatsMessages.ts:
// buildReplyQuoteMetadataForSend) и Android: messageId / senderId (только непустой) /
// preview (обрезка до 420) / createdAt (ISO, только когда известен).
//
// Приватные поля ChatRepository (api, session) из другого файла недоступны — extension
// берёт тот же APIClient через `apiClient` (раньше через AppContainer.shared: в приложении это
// тот же объект, но в тестах он ходил бы в настоящую сеть мимо подменного транспорта),
// а маппинг DTO → домен идёт через internal mapMessage.

extension ChatRepository {

    /// Отправка TEXT с опциональным мультиответом. replyToId — последняя цитата (как в
    /// Kotlin: reply.lastOrNull()), replyBundle — ВСЕ цитаты; бандл пишется в metadata
    /// только при ≥2 (одиночный ответ остаётся чистым replyToId — веб-паритет).
    /// `botAsk` — режим «Спросить» поля ввода (docs/bot-system.md §4): true — боту, false —
    /// плашку убрали (обычное сообщение), nil — ключа нет, решает сервер.
    func sendText(
        _ conversationId: String,
        text: String,
        replyToId: String?,
        replyBundle: [ReplyInfo]?,
        botAsk: Bool? = nil
    ) async -> ApiResult<Message> {
        await safeApiCall {
            let response: SendMessageResponse = try await apiClient.post(
                "conversations/send",
                body: SendMessageRequest(
                    conversationId: conversationId,
                    type: "TEXT",
                    content: text,
                    replyToId: replyToId,
                    metadata: composeSendMetadata(replyBundle: replyBundle, botAsk: botAsk)
                )
            )
            return self.mapMessage(response.message)
        }
    }
}

/// metadata отправки: `base` (у голосового — duration и waveform), мультиответ (только при ≥2
/// цитатах) и `botAsk`. nil — класть нечего, и ключ metadata в запрос не попадает вовсе (как
/// раньше у обычного текста).
func composeSendMetadata(
    replyBundle: [ReplyInfo]?, botAsk: Bool?, base: [String: JSONValue] = [:]
) -> JSONValue? {
    var fields = base
    if let bundle = replyBundle, bundle.count >= 2 {
        fields["replyQuoteBundle"] = replyQuoteBundleRows(bundle)
    }
    if let botAsk { fields["botAsk"] = .bool(botAsk) }
    return fields.isEmpty ? nil : .object(fields)
}

/// Ряды `metadata.replyQuoteBundle` для мультиответа (зеркалит веб-формат): messageId /
/// senderId (только непустой) / preview (обрезка до 420) / createdAt (ISO, только когда известен).
func replyQuoteBundleRows(_ bundle: [ReplyInfo]) -> JSONValue {
    .array(bundle.map { r in
        var row: [String: JSONValue] = [
            "messageId": .string(r.id),
            // preview пишется всегда, даже пустой (Kotlin: (content ?: "").take(420)).
            "preview": .string(String((r.content ?? "").prefix(420))),
        ]
        if !r.senderId.isEmpty { row["senderId"] = .string(r.senderId) }
        if let createdAt = r.createdAt { row["createdAt"] = .string(millisToIso(createdAt)) }
        return .object(row)
    })
}
