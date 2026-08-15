import Foundation

// Порт `data/repository/ChatRepository.kt`.
//
// Вместо Room — лёгкий JSON-кеш на диске (роль та же: список открывается мгновенно и
// офлайн). Пути аплоада (вложения, голосовые, чанки) добавятся вместе с композером.

struct MessagesPage {
    let messages: [Message]
    let hasMore: Bool
    let nextCursor: String?
}

/// Шапка чата: аватар беседы + подзаголовок (имена участников группы / статус 1:1).
struct ConvHeader {
    let avatarUrl: String?
    let subtitle: String?
}

/// Строка присутствия в шапке 1:1 (веб-паритет: ONLINE/BACKGROUND/IN_CALL, иначе ничего).
func presenceHeaderLabel(_ status: String?) -> String? {
    switch status?.uppercased() {
    case "ONLINE": return "в сети"
    case "BACKGROUND": return "в фоне"
    case "IN_CALL": return "в звонке"
    default: return nil
    }
}

final class ChatRepository {
    private let api: APIClient
    private let session: SessionStore

    // userId→avatarUrl по беседам из участников списка (веб-`usersById`): история не несёт
    // аватаров отправителей, групповые пузыри резолвят их через эту карту.
    private var participantAvatars: [String: [String: String?]] = [:]
    // Упорядоченные имена участников — для подзаголовка шапки группы.
    private var participantNames: [String: [String]] = [:]
    // Полные участники — для списка участников группы.
    private var participantUsers: [String: [ChatUser]] = [:]
    // Кеш бесед по id (роль Room-таблицы conversations) — ПОЛНЫЙ список, включая скрытые
    // из выдачи (PENDING-секретка создателя, открытая по realtime-событию).
    private var conversationsById: [String: Conversation] = [:]

    private let cacheURL: URL = {
        let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        return dir.appendingPathComponent("conversations-cache.json")
    }()

    init(api: APIClient, session: SessionStore) {
        self.api = api
        self.session = session
    }

    func currentUserId() -> String? { session.currentUserId() }

    // MARK: - Список бесед

    func listConversations() async -> ApiResult<[Conversation]> {
        await safeApiCall {
            let me = session.currentUserId()
            let response: ConversationsResponse = try await api.get("conversations")
            let items = response.conversations
            for item in items {
                let conv = item.conversation
                participantAvatars[conv.id] = Dictionary(
                    uniqueKeysWithValues: conv.participants.compactMap { p in
                        p.user.map { ($0.id, $0.avatarUrl) }
                    }
                )
                participantNames[conv.id] = conv.participants.compactMap { p in
                    p.user.map { u in
                        (u.displayName?.isEmpty == false ? u.displayName! : u.username)
                    }
                }
                participantUsers[conv.id] = conv.participants.compactMap { p in
                    p.user.map { u in
                        ChatUser(
                            id: u.id, username: u.username, displayName: u.displayName,
                            avatarUrl: u.avatarUrl,
                            online: u.status == "ONLINE" || u.status == "IN_CALL"
                        )
                    }
                }
            }
            let list = items
                .map { toDomain($0.conversation, meId: me, unreadCount: $0.unreadCount) }
                .sorted { ($0.lastMessageAt ?? 0) > ($1.lastMessageAt ?? 0) }
            // Кешируем ПОЛНЫЙ список: conversationMeta() должен резолвить и строки,
            // которые выдача прячет.
            conversationsById = Dictionary(uniqueKeysWithValues: list.map { ($0.id, $0) })
            persistCache(list)
            return presentConversations(list)
        }
    }

    func cachedConversations() -> [Conversation] {
        let list = loadCache()
        if conversationsById.isEmpty {
            conversationsById = Dictionary(uniqueKeysWithValues: list.map { ($0.id, $0) })
        }
        return presentConversations(list)
    }

    /// Кешированная запись беседы, с разовым обновлением списка, если не видели.
    func conversationMeta(_ conversationId: String) async -> Conversation? {
        if let cached = conversationsById[conversationId] { return cached }
        _ = await listConversations()
        return conversationsById[conversationId]
    }

    /// userId→avatarUrl участников беседы (зеркало веб-аватаров по участникам).
    func conversationSenderAvatars(_ conversationId: String) async -> [String: String?] {
        if let known = participantAvatars[conversationId] { return known }
        _ = await listConversations()
        return participantAvatars[conversationId] ?? [:]
    }

    /// Шапка: группа → имена участников; 1:1 → статус (как веб).
    func conversationHeader(_ conversationId: String) async -> ConvHeader {
        if participantNames[conversationId] == nil { _ = await listConversations() }
        let conv = conversationsById[conversationId]
        let names = (participantNames[conversationId] ?? []).filter { !$0.isEmpty }
        let subtitle: String?
        if conv?.isGroup == true {
            subtitle = names.isEmpty ? nil : names.joined(separator: ", ")
        } else {
            subtitle = presenceHeaderLabel(conv?.otherStatus)
        }
        return ConvHeader(avatarUrl: conv?.avatarUrl, subtitle: subtitle)
    }

    /// Участники беседы (тап по шапке группы).
    func conversationMembers(_ conversationId: String) async -> [ChatUser] {
        if participantUsers[conversationId] == nil { _ = await listConversations() }
        return participantUsers[conversationId] ?? []
    }

    /**
     * Формовка списка, общая для сети и кеша (веб-паритет сайдбара ChatsPage): спрятать
     * CANCELLED-секретки (PENDING видна ОБЕИМ сторонам), затем сгруппировать секретный
     * тред соседом сразу под облачной 1:1 с тем же собеседником.
     */
    private func presentConversations(_ list: [Conversation]) -> [Conversation] {
        let visible = list.filter { c in
            !(c.isSecretV2 && c.secretStatus?.caseInsensitiveCompare("CANCELLED") == .orderedSame)
        }
        return groupSecretSiblings(visible)
    }

    /// Пара «облако+секретка» сортируется по свежайшему из двух и рисуется облако-затем-секрет.
    private func groupSecretSiblings(_ list: [Conversation]) -> [Conversation] {
        final class Group {
            var cloud: Conversation?
            var secret: Conversation?
            var other: [Conversation] = []
            var sortTs: Int64 {
                max(
                    cloud?.lastMessageAt ?? 0,
                    secret?.lastMessageAt ?? 0,
                    other.map { $0.lastMessageAt ?? 0 }.max() ?? 0
                )
            }
        }
        var byKey: [String: Group] = [:]
        var order: [String] = []
        for c in list {
            let peerKey = (!c.isGroup ? c.otherUserId.map { "peer:\($0)" } : nil) ?? "conv:\(c.id)"
            let g: Group
            if let existing = byKey[peerKey] {
                g = existing
            } else {
                g = Group()
                byKey[peerKey] = g
                order.append(peerKey)
            }
            if !peerKey.hasPrefix("peer:") {
                g.other.append(c)
            } else if c.isSecretV2 {
                if g.secret == nil { g.secret = c } else { g.other.append(c) }
            } else if c.isSecret {
                // Легаси-секретка не должна занимать облачный слот.
                g.other.append(c)
            } else {
                if g.cloud == nil { g.cloud = c } else { g.other.append(c) }
            }
        }
        return order
            .compactMap { byKey[$0] }
            .sorted { $0.sortTs > $1.sortTs }
            .flatMap { g in [g.cloud, g.secret].compactMap { $0 } + g.other }
    }

    // MARK: - Сообщения

    func history(
        _ conversationId: String, cursor: String? = nil, limit: Int = 50
    ) async -> ApiResult<MessagesPage> {
        await safeApiCall {
            let me = session.currentUserId()
            var query = [URLQueryItem(name: "limit", value: String(limit))]
            if let cursor { query.append(URLQueryItem(name: "cursor", value: cursor)) }
            let response: MessagesResponse = try await api.get(
                "conversations/\(conversationId)/messages", query: query
            )
            return MessagesPage(
                messages: response.messages.map { toDomain($0, meId: me) }.reversed(),
                hasMore: response.hasMore,
                nextCursor: response.nextCursor
            )
        }
    }

    func sendText(
        _ conversationId: String, text: String, replyToId: String? = nil
    ) async -> ApiResult<Message> {
        await safeApiCall {
            let me = session.currentUserId()
            let response: SendMessageResponse = try await api.post(
                "conversations/send",
                body: SendMessageRequest(
                    conversationId: conversationId, type: "TEXT",
                    content: text, replyToId: replyToId
                )
            )
            return toDomain(response.message, meId: me)
        }
    }

    func toggleReaction(
        messageId: String, emoji: String, currentlyMine: Bool
    ) async -> ApiResult<Void> {
        await safeApiCall {
            let path = currentlyMine ? "messages/unreact" : "messages/react"
            try await api.postIgnoringResponse(path, body: ReactionRequest(messageId: messageId, emoji: emoji))
        }
    }

    func editMessage(messageId: String, content: String) async -> ApiResult<Void> {
        await safeApiCall {
            try await api.postIgnoringResponse(
                "messages/update",
                body: UpdateMessageRequest(messageId: messageId, content: content.trimmed())
            )
        }
    }

    func deleteMessage(messageId: String) async -> ApiResult<Void> {
        await safeApiCall {
            try await api.postIgnoringResponse("messages/delete", body: MessageIdRequest(messageId: messageId))
        }
    }

    func markConversationRead(_ conversationId: String) async -> ApiResult<Void> {
        await safeApiCall {
            try await api.postIgnoringResponse(
                "messages/mark-conversation-read",
                body: MarkReadRequest(conversationId: conversationId)
            )
        }
    }

    /// Удаляет беседу у всех участников (сервер шлёт conversations:deleted).
    func deleteConversation(_ conversationId: String) async -> ApiResult<Void> {
        await safeApiCall {
            let _: EmptyResponse = try await api.delete("conversations/\(conversationId)")
        }
    }

    /// Выход из группы (удаляется только наше членство).
    func leaveConversation(_ conversationId: String) async -> ApiResult<Void> {
        await safeApiCall {
            let _: EmptyResponse = try await api.delete("conversations/\(conversationId)/participants/me")
        }
    }

    func mapMessage(_ dto: MessageDto) -> Message {
        toDomain(dto, meId: session.currentUserId())
    }

    /// Просит сервер разрешить Open Graph-превью для сообщения; возвращает обновлённое.
    func fetchLinkPreview(messageId: String) async -> ApiResult<Message> {
        await safeApiCall {
            let response: SendMessageResponse = try await api.get("messages/\(messageId)/preview")
            return toDomain(response.message, meId: session.currentUserId())
        }
    }

    // MARK: - Маппинг DTO → домен (порт toDomain из Kotlin)

    private func toDomain(_ dto: MessageDto, meId: String?) -> Message {
        let name = dto.sender.map { s in
            (s.displayName?.isEmpty == false ? s.displayName! : s.username)
        } ?? "—"
        let isDeleted = dto.deletedAt != nil
        let mappedAttachments = dto.attachments.map { toAttachment($0) }
        let text: String
        if isDeleted {
            text = "Сообщение удалено"
        } else if dto.type == "TEXT" || dto.type == "SYSTEM" {
            text = dto.content ?? ""
        } else if !mappedAttachments.isEmpty {
            // Вложения рисуются инлайн; текстом пузыря остаётся только подпись.
            text = dto.content ?? ""
        } else {
            text = Self.previewFor(dto)
        }
        let createdMs = parseIsoToMillis(dto.createdAt) ?? 0
        // «Изменено» — из metadata.editedAt (как веб), НЕ из updatedAt: тот дёргается и на
        // реакциях/квитанциях/превью и врал бы про правку.
        let editedAt = dto.metadata?["editedAt"]?.stringValue
        let edited = !isDeleted && dto.type == "TEXT" && (editedAt?.isEmpty == false)

        // Пропущенный звонок пишется одной строкой для всех; ЗВОНИВШИЙ должен видеть
        // «Исходящий звонок без ответа …» (веб: renderSystemMessageContent).
        var systemText: String?
        if dto.type == "SYSTEM",
           case .bool(true)? = dto.metadata?["missed"],
           dto.senderId == meId {
            let content = (dto.content ?? "").trimmed()
            let suffix: String
            if let range = content.range(
                of: #"^Пропущенный звонок\s+(.+)$"#,
                options: [.regularExpression, .caseInsensitive]
            ) {
                suffix = String(content[range])
                    .replacingOccurrences(
                        of: #"^Пропущенный звонок\s+"#, with: "",
                        options: [.regularExpression, .caseInsensitive]
                    )
                    .trimmed()
            } else {
                suffix = "в \(formatClockTime(createdMs))"
            }
            systemText = "Исходящий звонок без ответа \(suffix)"
        }

        var grouped: [MessageReaction] = []
        var seenEmoji: [String] = []
        var byEmoji: [String: [ReactionDto]] = [:]
        for r in dto.reactions {
            if byEmoji[r.emoji] == nil { seenEmoji.append(r.emoji) }
            byEmoji[r.emoji, default: []].append(r)
        }
        for emoji in seenEmoji {
            let list = byEmoji[emoji] ?? []
            grouped.append(MessageReaction(
                emoji: emoji, count: list.count, mine: list.contains { $0.userId == meId }
            ))
        }

        let receipt: ReceiptState
        if dto.senderId == meId && !isDeleted {
            let others = dto.receipts.filter { $0.userId != meId }
            if others.contains(where: { $0.status == "READ" || $0.status == "SEEN" }) {
                receipt = .read
            } else if others.contains(where: { $0.status == "DELIVERED" }) {
                receipt = .delivered
            } else {
                receipt = .sent
            }
        } else {
            receipt = .none
        }

        var replyTo = Self.parseReplyBundle(dto.metadata)
        if replyTo.count < 2, let rt = dto.replyTo {
            replyTo = [ReplyInfo(
                id: rt.id, senderId: rt.senderId, content: rt.content,
                createdAt: parseIsoToMillis(rt.createdAt)
            )]
        }

        return Message(
            id: dto.id,
            conversationId: dto.conversationId,
            senderId: dto.senderId,
            senderName: name,
            senderAvatarUrl: dto.sender?.avatarUrl,
            type: dto.type,
            content: systemText ?? text,
            createdAt: createdMs,
            isMine: dto.senderId == meId,
            isSystem: dto.type == "SYSTEM",
            edited: edited,
            deleted: isDeleted,
            reactions: grouped,
            receipt: receipt,
            attachments: mappedAttachments,
            replyTo: replyTo,
            forwardFrom: Self.parseForwardFrom(dto.metadata),
            audioDurationSec: Self.parseAudioDuration(dto.metadata),
            waveform: Self.parseWaveform(dto.metadata),
            linkPreview: Self.parseLinkPreview(dto.metadata)
        )
    }

    private func toAttachment(_ dto: AttachmentDto) -> MessageAttachment {
        let md = dto.metadata
        func str(_ key: String) -> String? { md?[key]?.stringValue }
        func int(_ key: String) -> Int? { md?[key]?.numberValue.map(Int.init) }
        return MessageAttachment(
            url: dto.url,
            type: dto.type,
            mime: str("mime"),
            name: str("originalName") ?? str("name"),
            size: dto.size,
            width: int("width"),
            height: int("height"),
            posterUrl: str("posterKey")
        )
    }

    private func toDomain(_ dto: ConversationDto, meId: String?, unreadCount: Int) -> Conversation {
        let otherParticipant = dto.participants.first { $0.userId != meId }
        let other = otherParticipant?.user
        let resolvedTitle: String
        if dto.isGroup {
            resolvedTitle = (dto.title?.isEmpty == false ? dto.title! : "Группа")
        } else if let other {
            resolvedTitle = other.displayName?.isEmpty == false ? other.displayName! : other.username
        } else {
            resolvedTitle = dto.title ?? "Чат"
        }
        let last = dto.messages.first
        let online = !dto.isGroup && (other?.status == "ONLINE" || other?.status == "IN_CALL")
        return Conversation(
            id: dto.id,
            isGroup: dto.isGroup,
            isSecret: dto.isSecret,
            title: resolvedTitle,
            avatarUrl: dto.isGroup ? dto.avatarUrl : other?.avatarUrl,
            lastMessageText: last.map(Self.previewFor),
            lastMessageAt: parseIsoToMillis(dto.lastMessageAt) ?? last.flatMap { parseIsoToMillis($0.createdAt) },
            unreadCount: unreadCount,
            online: online,
            otherUserId: dto.isGroup ? nil : otherParticipant?.userId,
            otherLastSeen: dto.isGroup ? nil : parseIsoToMillis(other?.lastSeenAt),
            otherStatus: dto.isGroup ? nil : other?.status,
            type: dto.type,
            createdById: dto.createdById,
            secretStatus: dto.secretStatus,
            secretPeerDeviceId: dto.secretPeerDeviceId
        )
    }

    private static func previewFor(_ m: MessageDto) -> String {
        if m.deletedAt != nil { return "Сообщение удалено" }
        switch m.type {
        case "TEXT": return m.content ?? ""
        case "IMAGE": return "📷 Фото"
        case "VIDEO": return "🎬 Видео"
        case "AUDIO": return "🎤 Голосовое"
        case "FILE": return "📎 Файл"
        case "CALL": return "📞 Звонок"
        case "SYSTEM": return m.content ?? ""
        default: return m.content ?? ""
        }
    }

    // MARK: - Разбор metadata (порт parse* из Kotlin)

    /// `metadata.replyQuoteBundle` (мультиответ веба) → [ReplyInfo].
    private static func parseReplyBundle(_ metadata: JSONValue?) -> [ReplyInfo] {
        guard case .array(let arr)? = metadata?["replyQuoteBundle"] else { return [] }
        return arr.compactMap { el in
            guard let id = el["messageId"]?.stringValue else { return nil }
            return ReplyInfo(
                id: id,
                senderId: el["senderId"]?.stringValue ?? "",
                content: el["preview"]?.stringValue,
                createdAt: parseIsoToMillis(el["createdAt"]?.stringValue)
            )
        }
    }

    /// `metadata.forwardFrom` (происхождение пересылки) → ForwardInfo.
    private static func parseForwardFrom(_ metadata: JSONValue?) -> ForwardInfo? {
        guard let md = metadata else { return nil }
        // forwardFrom бывает вложенным объектом или (легаси) JSON-строкой.
        var ff: JSONValue?
        switch md["forwardFrom"] {
        case .object(let o)?: ff = .object(o)
        case .string(let s)?:
            if let data = s.data(using: .utf8),
               let parsed = try? JSONDecoder().decode(JSONValue.self, from: data),
               case .object = parsed { ff = parsed }
        default: break
        }
        guard let ff, let authorName = ff["authorName"]?.stringValue, !authorName.isEmpty else { return nil }
        let originalIso = md["forwardOriginalCreatedAt"]?.stringValue ?? ff["originalCreatedAt"]?.stringValue
        var isGroupSource = false
        if case .bool(let b)? = ff["isGroupSource"] { isGroupSource = b }
        return ForwardInfo(
            authorName: authorName,
            sourceChatTitle: ff["sourceChatTitle"]?.stringValue,
            isGroupSource: isGroupSource,
            directChatPeerName: ff["directChatPeerName"]?.stringValue ?? md["sourceDmPeerName"]?.stringValue,
            originalCreatedAt: parseIsoToMillis(originalIso)
        )
    }

    /// Длительность голосового в целых секундах из `metadata.duration` (int или float).
    private static func parseAudioDuration(_ metadata: JSONValue?) -> Int? {
        switch metadata?["duration"] {
        case .number(let n)?: return Int(n)
        case .string(let s)?: return Double(s).map(Int.init)
        default: return nil
        }
    }

    /// Амплитуды волны (0..100) из `metadata.waveform`; nil, если нет/пусто.
    private static func parseWaveform(_ metadata: JSONValue?) -> [Int]? {
        guard case .array(let arr)? = metadata?["waveform"] else { return nil }
        let bars = arr.compactMap { $0.numberValue.map(Int.init) }
        return bars.isEmpty ? nil : bars
    }

    /// Серверное Open Graph-превью из `metadata.linkPreview`.
    private static func parseLinkPreview(_ metadata: JSONValue?) -> LinkPreview? {
        guard case .object? = metadata?["linkPreview"] else { return nil }
        let lp = metadata?["linkPreview"]
        func str(_ key: String) -> String? {
            lp?[key]?.stringValue.flatMap { $0.isEmpty ? nil : $0 }
        }
        guard let url = str("url") else { return nil }
        return LinkPreview(
            url: url, title: str("title"), description: str("description"),
            imageUrl: str("imageUrl"), siteName: str("siteName")
        )
    }

    // MARK: - Дисковый кеш списка (роль Room)

    private struct CachedConversation: Codable {
        let id: String
        let isGroup: Bool
        let isSecret: Bool
        let title: String
        let avatarUrl: String?
        let lastMessageText: String?
        let lastMessageAt: Int64?
        let unreadCount: Int
        let online: Bool
        let otherUserId: String?
        let otherLastSeen: Int64?
        let otherStatus: String?
        let type: String?
        let createdById: String?
        let secretStatus: String?
        let secretPeerDeviceId: String?
    }

    private func persistCache(_ list: [Conversation]) {
        let cached = list.map {
            CachedConversation(
                id: $0.id, isGroup: $0.isGroup, isSecret: $0.isSecret, title: $0.title,
                avatarUrl: $0.avatarUrl, lastMessageText: $0.lastMessageText,
                lastMessageAt: $0.lastMessageAt, unreadCount: $0.unreadCount,
                online: $0.online, otherUserId: $0.otherUserId,
                otherLastSeen: $0.otherLastSeen, otherStatus: $0.otherStatus,
                type: $0.type, createdById: $0.createdById,
                secretStatus: $0.secretStatus, secretPeerDeviceId: $0.secretPeerDeviceId
            )
        }
        if let data = try? JSONEncoder().encode(cached) {
            try? data.write(to: cacheURL, options: .atomic)
        }
    }

    private func loadCache() -> [Conversation] {
        guard let data = try? Data(contentsOf: cacheURL),
              let cached = try? JSONDecoder().decode([CachedConversation].self, from: data)
        else { return [] }
        return cached.map {
            Conversation(
                id: $0.id, isGroup: $0.isGroup, isSecret: $0.isSecret, title: $0.title,
                avatarUrl: $0.avatarUrl, lastMessageText: $0.lastMessageText,
                lastMessageAt: $0.lastMessageAt, unreadCount: $0.unreadCount,
                online: $0.online, otherUserId: $0.otherUserId,
                otherLastSeen: $0.otherLastSeen, otherStatus: $0.otherStatus,
                type: $0.type, createdById: $0.createdById,
                secretStatus: $0.secretStatus, secretPeerDeviceId: $0.secretPeerDeviceId
            )
        }
    }

    func clearLocalData() {
        conversationsById = [:]
        participantAvatars = [:]
        participantNames = [:]
        participantUsers = [:]
        try? FileManager.default.removeItem(at: cacheURL)
    }
}

/// Для DELETE-ручек, чей ответ нам не важен ({} или {ok:true}).
struct EmptyResponse: Decodable {}
