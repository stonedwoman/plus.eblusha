import Foundation

// Порт `data/repository/ContactsRepository.kt` (+ ContactsApi.kt и UsersApi.kt: Retrofit
// заменяет общий APIClient, пути и query-параметры совпадают байт-в-байт).
//
// В Kotlin конструктор также принимает deviceIdProvider и secretRepository; здесь
// secretRepository прошивается var-свойством из AppContainer (нужен только
// startSecretConversation), чтобы не менять сигнатуру init, уже занятую в DI.

/// Старт секретного чата: ссылка на тред + принял ли уже собеседник (ACTIVE).
struct SecretStartResult {
    let ref: ConversationRef
    let active: Bool
}

final class ContactsRepository {
    private let api: APIClient
    private let session: SessionStore

    /// Ставится из AppContainer после создания SecretRepository (в Kotlin — параметр
    /// конструктора; здесь var, чтобы не менять сигнатуру init, уже прошитую в DI).
    /// Нужен только startSecretConversation.
    var secretRepository: SecretRepository?

    init(api: APIClient, session: SessionStore) {
        self.api = api
        self.session = session
    }

    /// Публичный мини-профиль для карточки (сервер никогда не отдаёт login-username).
    func userCard(_ userId: String) async -> ApiResult<UserCardProfile> {
        await safeApiCall {
            let response: UserCardResponse = try await api.get("users/\(userId)")
            let u = response.user
            // Текущий аватар + история, без дублей (distinct из оригинала).
            var avatars: [String] = []
            for a in [u.avatarUrl].compactMap({ $0 }) + u.avatars where !avatars.contains(a) {
                avatars.append(a)
            }
            return UserCardProfile(
                id: u.id,
                eblid: u.eblid,
                name: (u.displayName?.trimmed().isEmpty == false) ? u.displayName! : "Без имени",
                bio: (u.bio?.trimmed().isEmpty == false) ? u.bio : nil,
                avatarUrl: u.avatarUrl,
                avatars: avatars,
                status: u.status,
                lastSeenMs: parseIsoToMillis(u.lastSeenAt),
                createdAtMs: parseIsoToMillis(u.createdAt)
            )
        }
    }

    /// Состояние «друг / ожидающая заявка» с пользователем — управляет кнопкой дружбы карточки.
    func relationWith(_ userId: String) async -> ApiResult<UserRelation> {
        await safeApiCall {
            let row = try await list(filter: "all").contacts.first { $0.friend?.id == userId }
            guard let row else { return UserRelation(.none) }
            if row.status?.caseInsensitiveCompare("ACCEPTED") == .orderedSame {
                return UserRelation(.friend, row.id)
            }
            if row.direction == "incoming" { return UserRelation(.incoming, row.id) }
            return UserRelation(.outgoing, row.id)
        }
    }

    /// Заявка в друзья из карточки — по userId, потому что карточка не видит логина.
    func addByUserId(_ userId: String) async -> ApiResult<Void> {
        await safeApiCall {
            let _: ContactActionResponse = try await api.post(
                "contacts/add", body: AddContactRequest(userId: userId)
            )
        }
    }

    func listAccepted() async -> ApiResult<[Contact]> {
        await safeApiCall {
            try await list(filter: "accepted").contacts
                .compactMap { toDomain($0) }
                .sorted { $0.user.name.lowercased() < $1.user.name.lowercased() }
        }
    }

    /// Ожидающие заявки, ждущие нашего ответа.
    func listIncoming() async -> ApiResult<[Contact]> {
        await safeApiCall {
            try await list(filter: "incoming").contacts.compactMap { toDomain($0, incoming: true) }
        }
    }

    /// Наши неотвеченные заявки — секция «Ожидание подтверждения» (веб-паритет).
    func listOutgoing() async -> ApiResult<[Contact]> {
        await safeApiCall {
            try await list(filter: "outgoing").contacts
                .filter { $0.status?.caseInsensitiveCompare("PENDING") == .orderedSame }
                .compactMap { toDomain($0, incoming: false) }
        }
    }

    func search(_ query: String) async -> ApiResult<[ChatUser]> {
        await safeApiCall {
            let me = session.currentUserId()
            let response: UserSearchResponse = try await api.get(
                "contacts/search",
                query: [URLQueryItem(name: "query", value: query.trimmed())]
            )
            return response.results.filter { $0.id != me }.map { toChatUser($0) }
        }
    }

    func add(identifier: String) async -> ApiResult<Void> {
        await safeApiCall {
            let _: ContactActionResponse = try await api.post(
                "contacts/add", body: AddContactRequest(identifier: identifier.trimmed())
            )
        }
    }

    func respond(contactId: String, action: String) async -> ApiResult<Void> {
        await safeApiCall {
            try await api.postIgnoringResponse(
                "contacts/respond", body: RespondContactRequest(contactId: contactId, action: action)
            )
        }
    }

    /// Создаёт (или переиспользует) 1:1-беседу и подбирает отображаемый заголовок для открытия.
    func startDirectConversation(userId: String) async -> ApiResult<ConversationRef> {
        await safeApiCall {
            let me = session.currentUserId()
            let response: CreateConversationResponse = try await api.post(
                "conversations", body: CreateConversationRequest(participantIds: [userId])
            )
            let conv = response.conversation
            let other = conv.participants.first { $0.userId != me }?.user
            let title: String
            if conv.isGroup {
                title = (conv.title?.trimmed().isEmpty == false) ? conv.title! : "Группа"
            } else if let other {
                title = (other.displayName?.trimmed().isEmpty == false)
                    ? other.displayName! : other.username
            } else {
                title = conv.title ?? "Чат"
            }
            return ConversationRef(id: conv.id, title: title)
        }
    }

    func removeContact(contactId: String) async -> ApiResult<Void> {
        await safeApiCall {
            try await api.postIgnoringResponse(
                "contacts/remove", body: RemoveContactRequest(contactId: contactId)
            )
        }
    }

    /// Создаёт групповую беседу с выбранными участниками (себя сервер добавляет сам).
    func createGroup(title: String?, participantIds: [String]) async -> ApiResult<ConversationRef> {
        await safeApiCall {
            let cleanTitle: String? = (title?.trimmed().isEmpty == false) ? title : nil
            let response: CreateConversationResponse = try await api.post(
                "conversations",
                body: CreateConversationRequest(
                    participantIds: participantIds,
                    title: cleanTitle,
                    isGroup: true,
                    isSecret: false
                )
            )
            let conv = response.conversation
            let resolved = (conv.title?.trimmed().isEmpty == false)
                ? conv.title! : (cleanTitle ?? "Группа")
            return ConversationRef(id: conv.id, title: resolved)
        }
    }

    /**
     * Стартует (или переиспользует) V2 E2EE-секретный тред с пользователем — POST /threads/secret,
     * НЕ легаси `/conversations {isSecret}` (та создаёт PENDING-чат, который веб целиком прячет).
     * Если мы создатель, SecretRepository генерирует ключ треда и держит его, пока собеседник
     * не примет приглашение на одном устройстве. `SecretStartResult.active` говорит UI, принят
     * ли чат уже (открываем) или это всё ещё PENDING-приглашение (подтверждаем и остаёмся).
     */
    func startSecretConversation(userId: String) async -> ApiResult<SecretStartResult> {
        guard let secretRepository else {
            // DI ещё не прошил SecretRepository (см. integration_notes к AppContainer).
            return .failure(message: "Секретные чаты ещё не инициализированы")
        }
        let created = await secretRepository.createSecretThread(peerUserId: userId)
        guard case .success(let start) = created else {
            if case .failure(let message, let code) = created {
                return .failure(message: message, code: code)
            }
            return .failure(message: "Не удалось создать секретный чат")
        }
        // Тред на этом шаге уже СУЩЕСТВУЕТ — подбор заголовка косметический и не должен
        // превращать успешный create в ошибку (пользователь ретраил бы уже висящий
        // pending-чат), поэтому сбой списка друзей глотается фолбэком.
        var title = "Секретный чат"
        let friends = (try? await list(filter: "accepted"))?.contacts ?? []
        if let friend = friends.first(where: { $0.friend?.id == userId })?.friend {
            let display = friend.displayName?.trimmed() ?? ""
            title = display.isEmpty ? friend.username : display
        }
        return .success(SecretStartResult(
            ref: ConversationRef(id: start.threadId, title: title),
            active: start.active
        ))
    }

    // MARK: - Профиль (временный хост методов ProfileRepository — до фазы 6)

    /// Порт ProfileRepository.me() из Kotlin: профиль текущего пользователя (EBLID для
    /// карточки «Мой EBLID»). Когда фазой 6 приедет полный ProfileRepository — переедет туда.
    func me() async -> ApiResult<UserProfile> {
        await safeApiCall {
            let response: MeResponse = try await api.get("status/me")
            let u = response.user
            return UserProfile(
                id: u.id, username: u.username, eblid: u.eblid,
                displayName: u.displayName, bio: u.bio,
                avatarUrl: u.avatarUrl, status: u.status
            )
        }
    }

    /// Порт ProfileRepository.inviteCode(): код регистрации для карточки приглашения.
    func inviteCode() async -> ApiResult<InviteCode> {
        await safeApiCall {
            toInviteCode(try await api.get("auth/register/code"))
        }
    }

    /// Порт ProfileRepository.refreshInviteCode(): перевыпуск кода регистрации.
    func refreshInviteCode() async -> ApiResult<InviteCode> {
        await safeApiCall {
            // Retrofit шлёт POST без тела; здесь — пустой JSON-объект (сервер тело не читает).
            let refreshed: RegisterCodeResponse = try await api.post(
                "auth/register/code/refresh", body: EmptyRequestBody()
            )
            return toInviteCode(refreshed)
        }
    }

    // MARK: - Маппинг DTO → домен (порт toDomain/toChatUser из Kotlin)

    private func list(filter: String) async throws -> ContactsResponse {
        try await api.get("contacts", query: [URLQueryItem(name: "filter", value: filter)])
    }

    private func toDomain(_ dto: ContactDto, incoming: Bool? = nil) -> Contact? {
        guard let u = dto.friend else { return nil }
        return Contact(
            contactId: dto.id,
            user: toChatUser(u),
            status: dto.status ?? "PENDING",
            incoming: incoming ?? (dto.direction == "incoming")
        )
    }

    private func toChatUser(_ u: UserBriefDto) -> ChatUser {
        ChatUser(
            id: u.id,
            username: u.username,
            displayName: u.displayName,
            avatarUrl: u.avatarUrl,
            online: u.status == "ONLINE" || u.status == "IN_CALL"
        )
    }

    private func toInviteCode(_ r: RegisterCodeResponse) -> InviteCode {
        InviteCode(code: r.code, expiresAtMs: parseIsoToMillis(r.expiresAt))
    }
}

/// Для POST-ручек без тела: Retrofit шлёт пустой POST, наш APIClient — «{}».
struct EmptyRequestBody: Encodable {}
