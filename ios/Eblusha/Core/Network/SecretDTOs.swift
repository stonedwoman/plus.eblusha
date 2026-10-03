import Foundation

// Порт `data/remote/dto/SecretDtos.kt`. Имена JSON-полей повторяют бэкенд один в один —
// это совместимость секреток с вебом и Android (src/routes/devices.ts, e2ee.ts, secret.ts).
//
// НЕ дублировать: DevicesListResponse/DeviceDto живут в ProfileDTOs.swift,
// PairingStartResponse — в SocialDTOs.swift, ConversationDto — в ChatDTOs.swift.
//
// О null-полях: Android (kotlinx, explicitNulls) шлёт null явно, веб — опускает поле.
// JSONEncoder Swift опускает nil, как веб; бэкенд принимает оба варианта, поэтому
// сериализация здесь синтезированная, без кастомных encode(to:).

// MARK: - Регистрация ключей устройства

struct PrekeyUpload: Encodable {
    let keyId: String
    let publicKey: String
    var oneTimePreKeyId: String?
    var oneTimePreKeyPublic: String?
    var version: Int = 1
    var alg: String = "x25519"
}

struct RegisterDeviceRequest: Encodable {
    let deviceId: String
    let name: String
    var platform: String = "ios"
    let publicKey: String
    var identityPublicKey: String?
    var prekeys: [PrekeyUpload] = []
    var version: Int = 1
    var alg: String = "x25519"
}

struct PublishPrekeysRequest: Encodable {
    let prekeys: [PrekeyUpload]
}

/// Ответ /devices/register и /devices/{id}/prekeys: сервер держит не больше 250 невыданных
/// OPK на устройство и молча отбрасывает лишние — принятые перечислены в insertedKeyIds.
/// Секреты отброшенных хранить незачем (H04). nil — старый сервер без поля: ничего не чистим.
struct PrekeysAcceptedResponse: Decodable {
    var insertedKeyIds: [String]?

    private enum CodingKeys: String, CodingKey { case insertedKeyIds }

    init(insertedKeyIds: [String]? = nil) {
        self.insertedKeyIds = insertedKeyIds
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        insertedKeyIds = try? c.decodeIfPresent([String].self, forKey: .insertedKeyIds)
    }

    static func lenient(_ data: Data) -> PrekeysAcceptedResponse {
        (try? JSONDecoder().decode(PrekeysAcceptedResponse.self, from: data)) ?? PrekeysAcceptedResponse()
    }
}

// MARK: - Prekey-бандлы / claim (открытые ключи устройств собеседника)

struct PrekeyBundlesResponse: Decodable {
    var userId: String?
    var bundles: [PrekeyBundleDto] = []

    private enum CodingKeys: String, CodingKey { case userId, bundles }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        userId = try c.decodeIfPresent(String.self, forKey: .userId)
        bundles = try c.decodeIfPresent([PrekeyBundleDto].self, forKey: .bundles) ?? []
    }
}

struct PrekeyBundleDto: Decodable {
    let deviceId: String
    var identityPublicKey: String?
    var oneTimePreKey: OneTimePreKeyDto?
    var version: Int = 1
    var alg: String?

    private enum CodingKeys: String, CodingKey {
        case deviceId, identityPublicKey, oneTimePreKey, version, alg
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        deviceId = try c.decode(String.self, forKey: .deviceId)
        identityPublicKey = try c.decodeIfPresent(String.self, forKey: .identityPublicKey)
        oneTimePreKey = try c.decodeIfPresent(OneTimePreKeyDto.self, forKey: .oneTimePreKey)
        version = try c.decodeIfPresent(Int.self, forKey: .version) ?? 1
        alg = try c.decodeIfPresent(String.self, forKey: .alg)
    }
}

struct OneTimePreKeyDto: Decodable {
    var id: String?
    let publicKey: String
}

struct ClaimPrekeyRequest: Encodable {
    let deviceId: String
}

struct ClaimPrekeyResponse: Decodable {
    let deviceId: String
    var identityKey: String?
    var prekey: ClaimedPrekeyDto?
    var alg: String?
}

struct ClaimedPrekeyDto: Decodable {
    let keyId: String
    let publicKey: String
}

// MARK: - Заголовок секретного сообщения / рукопожатия

/// Покрывает kind="msg" | "key_package" | "control" | "prekeys_needed" | "link_device_join".
/// Decodable-инициализатор — в extension, чтобы сохранился member-wise init (заголовки
/// мы не только читаем, но и собираем при отправке).
struct SecretHeader: Codable {
    var v: Int = 1
    var kind: String
    var nonce: String?
    var packageKind: String?            // key_package: "thread_key" | "device_link_keys"
    var threadId: String?
    var recipientDeviceId: String?
    var initiatorDeviceId: String?
    var initiatorIdentityKey: String?
    var prekeyId: String?
    var handshakeSalt: String?
    var hkdfInfo: String?
    var alg: String?
    // control-конверты (весь смысл в заголовке; ciphertext — заглушка):
    var type: String?                   // "key_receipt" | "key_request" | "key_resend_request"
    var fromDeviceId: String?
    var requesterDeviceId: String?
    var ts: Int64?
    // kind="link_device_join": новое устройство предъявляет token/code приглашения (deviceLinkInvite).
    var token: String?
    var code: String?
    // contentType="attachment": objectKey ПЕРВОГО файла + суммарный размер открытого текста.
    // Сервер по нему апсертит SecretAttachmentRef (учёт для GC) — имён и nonce он не видит.
    var attachment: SecretHeaderAttachment?
}

extension SecretHeader {
    private enum CodingKeys: String, CodingKey {
        case v, kind, nonce, packageKind, threadId, recipientDeviceId, initiatorDeviceId
        case initiatorIdentityKey, prekeyId, handshakeSalt, hkdfInfo, alg
        case type, fromDeviceId, requesterDeviceId, ts, token, code, attachment
    }

    /// Терпимый разбор (H12). Заголовок пишет ОТПРАВИТЕЛЬ — любой пользователь через
    /// /secret/send, любой участник через /messages/push, — поэтому неверный тип одного
    /// необязательного поля не должен ронять ни конверт, ни (раньше) всю пачку инбокса:
    /// такое поле читается как отсутствующее. Обязателен только `kind` — без него конверт
    /// не к чему отнести; такой элемент разбор пачки пропускает и подтверждает
    /// (SecretInboxResponse.undecodableMsgIds).
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = try c.decode(String.self, forKey: .kind)
        v = (try? c.decodeIfPresent(Int.self, forKey: .v)) ?? 1
        nonce = try? c.decodeIfPresent(String.self, forKey: .nonce)
        packageKind = try? c.decodeIfPresent(String.self, forKey: .packageKind)
        threadId = try? c.decodeIfPresent(String.self, forKey: .threadId)
        recipientDeviceId = try? c.decodeIfPresent(String.self, forKey: .recipientDeviceId)
        initiatorDeviceId = try? c.decodeIfPresent(String.self, forKey: .initiatorDeviceId)
        initiatorIdentityKey = try? c.decodeIfPresent(String.self, forKey: .initiatorIdentityKey)
        prekeyId = try? c.decodeIfPresent(String.self, forKey: .prekeyId)
        handshakeSalt = try? c.decodeIfPresent(String.self, forKey: .handshakeSalt)
        hkdfInfo = try? c.decodeIfPresent(String.self, forKey: .hkdfInfo)
        alg = try? c.decodeIfPresent(String.self, forKey: .alg)
        type = try? c.decodeIfPresent(String.self, forKey: .type)
        fromDeviceId = try? c.decodeIfPresent(String.self, forKey: .fromDeviceId)
        requesterDeviceId = try? c.decodeIfPresent(String.self, forKey: .requesterDeviceId)
        ts = try? c.decodeIfPresent(Int64.self, forKey: .ts)
        token = try? c.decodeIfPresent(String.self, forKey: .token)
        code = try? c.decodeIfPresent(String.self, forKey: .code)
        attachment = try? c.decodeIfPresent(SecretHeaderAttachment.self, forKey: .attachment)
    }
}

struct SecretHeaderAttachment: Codable {
    let objectKey: String
    let size: Int64
}

/// POST /secret/attachments/ref — регистрирует файлы альбома 2..N для GC (push несёт только №1).
struct SecretAttachmentRefRequest: Encodable {
    let threadId: String
    let objectKey: String
}

// MARK: - E2EE-дескриптор вложений (ЗАШИФРОВАННЫЙ payload push-а contentType="attachment")

// Wire-формат зафиксирован вебом (secretThreadMessaging.ts): каждое поле каждого элемента,
// кроме objectKey/url/nonce, опционально, неизвестные поля игнорируются. Всё nullable, чтобы
// битый дескриптор декодировался во что-то отбрасываемое, а не кидал исключение.

struct SecretAttachmentItemDto: Codable {
    var objectKey: String?
    var url: String?          // "/api/files/{key}" — отдаёт ШИФРТЕКСТ байт-в-байт
    var nonce: String?        // собственный secretbox-nonce файла (ключ треда)
    var name: String?
    var mime: String?
    var size: Int64?
    var attType: String?      // IMAGE | VIDEO | AUDIO | FILE
    var width: Int?
    var height: Int?
    var duration: Double?     // AUDIO: секунды
    // AUDIO: столбики амплитуды. Double, НЕ Int: дробное значение от веба в Int-поле валило бы
    // парсинг ВСЕГО дескриптора → «вложение зашифровано» на ровном месте.
    var waveform: [Double]?
}

struct SecretAttachmentDescriptorDto: Codable {
    var v: Int = 0
    var text: String?
    var attachments: [SecretAttachmentItemDto] = []

    private enum CodingKeys: String, CodingKey { case v, text, attachments }

    init(v: Int = 0, text: String? = nil, attachments: [SecretAttachmentItemDto] = []) {
        self.v = v
        self.text = text
        self.attachments = attachments
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        v = try c.decodeIfPresent(Int.self, forKey: .v) ?? 0
        text = try c.decodeIfPresent(String.self, forKey: .text)
        attachments = try c.decodeIfPresent([SecretAttachmentItemDto].self, forKey: .attachments) ?? []
    }
}

// MARK: - Прямой конверт (доставка key-package через /secret/send + /secret/inbox)

struct SecretDirectEnvelope: Encodable {
    let toDeviceId: String
    let msgId: String
    let createdAt: String
    let ciphertext: String
    var contentType: String = "ref"
    var schemaVersion: Int = 1
    let headerJson: SecretHeader
    var ttlSeconds: Int?              // веб: 3600 для thread_key-пакетов, 600-900 для control
}

/// POST /secret/send — ТОЛЬКО батч: голый конверт в теле получает 400 (backend sendSchema).
struct SecretSendBatchRequest: Encodable {
    let messages: [SecretDirectEnvelope]
}

/// Поле инбокса у бэкенда — `messages`, НЕ `items`: старое имя молча парсилось в пустоту.
///
/// H12: пачка разбирается ПОЭЛЕМЕНТНО. Раньше один элемент с заголовком неверной формы
/// ронял декодирование всего ответа — ack становился невозможен, запись навсегда стояла
/// в голове FIFO (сервер отдаёт первые 50), и входящие секреток умирали. Теперь такой
/// элемент пропускается, а его msgId (если он читается) попадает в undecodableMsgIds —
/// вызывающий обязан его подтвердить.
struct SecretInboxResponse: Decodable {
    var messages: [SecretInboxItemDto] = []
    var undecodableMsgIds: [String] = []

    private enum CodingKeys: String, CodingKey { case messages }

    init(messages: [SecretInboxItemDto] = [], undecodableMsgIds: [String] = []) {
        self.messages = messages
        self.undecodableMsgIds = undecodableMsgIds
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        guard let elements = try? c.decodeIfPresent([LossyElement<SecretInboxItemDto>].self, forKey: .messages) else {
            return
        }
        for element in elements {
            if let item = element.value {
                messages.append(item)
            } else if let msgId = element.msgId {
                undecodableMsgIds.append(msgId)
            }
        }
    }
}

/// Элемент массива, разбор которого не бросает: иначе неразобранный элемент не сдвигал бы
/// курсор UnkeyedDecodingContainer и пачку нельзя было бы дочитать.
struct LossyElement<T: Decodable>: Decodable {
    let value: T?
    /// msgId сырого элемента — чтобы подтвердить даже то, что не разобралось.
    let msgId: String?

    private enum IdKey: String, CodingKey { case msgId }

    init(from decoder: Decoder) throws {
        value = try? T(from: decoder)
        msgId = try? decoder.container(keyedBy: IdKey.self).decode(String.self, forKey: .msgId)
    }
}

struct SecretInboxItemDto: Decodable {
    let msgId: String
    var threadId: String?             // non-nil у тредовых сообщений, nil у прямых конвертов
    var senderUserId: String?
    var senderDeviceId: String?
    var createdAt: String?
    let ciphertext: String
    let headerJson: SecretHeader
    var contentType: String?
}

struct SecretAckRequest: Encodable {
    let msgIds: [String]
}

// MARK: - Сообщения секретного треда

struct SecretPushRequest: Encodable {
    let threadId: String
    let msgId: String
    let createdAt: String
    let headerJson: SecretHeader
    let ciphertext: String
    var contentType: String = "text"
    var schemaVersion: Int = 1
    var receiverDeviceIds: [String] = []
}

struct SecretHistoryResponse: Decodable {
    var items: [SecretMessageItemDto] = []
    var hasMore: Bool = false
    var nextCursor: String?           // "createdAtISO|msgId" — keyset, как в обычной истории
    /// Строки, которые не разобрались (H12): страница их пропускает, а не падает целиком.
    var skippedCount = 0

    private enum CodingKeys: String, CodingKey { case items, hasMore, nextCursor }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let elements = (try? c.decodeIfPresent([LossyElement<SecretMessageItemDto>].self, forKey: .items)) ?? nil
        items = (elements ?? []).compactMap(\.value)
        skippedCount = (elements?.count ?? 0) - items.count
        hasMore = (try? c.decodeIfPresent(Bool.self, forKey: .hasMore)) ?? false
        nextCursor = try? c.decodeIfPresent(String.self, forKey: .nextCursor)
    }
}

struct SecretMessageItemDto: Decodable {
    let msgId: String
    var threadId: String?
    var senderUserId: String?
    var senderDeviceId: String?
    var createdAt: String?
    let headerJson: SecretHeader
    let ciphertext: String
    var contentType: String?
}

// MARK: - Создание секретного треда (V2: POST /threads/secret — НЕ легаси /conversations isSecret)

struct CreateSecretThreadRequest: Encodable {
    let peerUserId: String
}

struct CreateSecretThreadResponse: Decodable {
    let threadId: String
    var created: Bool = false
    var thread: ConversationDto?

    private enum CodingKeys: String, CodingKey { case threadId, created, thread }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        threadId = try c.decode(String.self, forKey: .threadId)
        created = try c.decodeIfPresent(Bool.self, forKey: .created) ?? false
        thread = try c.decodeIfPresent(ConversationDto.self, forKey: .thread)
    }
}

/// Accept-on-one-device: собеседник принимает на ЭТОМ устройстве (deviceId дублируется
/// в теле поверх заголовка x-device-id).
struct AcceptSecretThreadRequest: Encodable {
    var deviceId: String?
}

struct AcceptSecretThreadResponse: Decodable {
    var ok: Bool = false
    var conversationId: String?
    var peerDeviceId: String?

    private enum CodingKeys: String, CodingKey { case ok, conversationId, peerDeviceId }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = try c.decodeIfPresent(Bool.self, forKey: .ok) ?? false
        conversationId = try c.decodeIfPresent(String.self, forKey: .conversationId)
        peerDeviceId = try c.decodeIfPresent(String.self, forKey: .peerDeviceId)
    }
}

// MARK: - Push-токен устройства

/// POST /devices/{deviceId}/push. На Android provider="fcm"; здесь — "apns" (обычные
/// уведомления) либо "apns-voip" (PushKit, входящие звонки).
struct PushTokenRequest: Encodable {
    let token: String
    var provider: String = "apns"
}

// MARK: - Участники секретных тредов (проверка отправителя ключа, H01/H03)

/// Минимальный срез GET /conversations: только то, что нужно, чтобы решить «отправитель —
/// участник этого SECRET-треда». Разбор терпимый: одна непонятная беседа не мешает остальным.
struct SecretMembershipListResponse: Decodable {
    var conversations: [LossyElement<SecretMembershipRow>] = []

    private enum CodingKeys: String, CodingKey { case conversations }

    init(conversations: [LossyElement<SecretMembershipRow>] = []) {
        self.conversations = conversations
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        conversations = (try? c.decodeIfPresent([LossyElement<SecretMembershipRow>].self, forKey: .conversations)) ?? []
    }
}

struct SecretMembershipRow: Decodable {
    let conversation: SecretMembershipConversation
}

struct SecretMembershipConversation: Decodable {
    let id: String
    var type: String?
    var isSecret: Bool?
    var participants: [SecretMembershipParticipant] = []

    private enum CodingKeys: String, CodingKey { case id, type, isSecret, participants }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        type = try? c.decodeIfPresent(String.self, forKey: .type)
        isSecret = try? c.decodeIfPresent(Bool.self, forKey: .isSecret)
        participants = ((try? c.decodeIfPresent([LossyElement<SecretMembershipParticipant>].self, forKey: .participants)) ?? nil)?
            .compactMap(\.value) ?? []
    }
}

struct SecretMembershipParticipant: Decodable {
    let userId: String
}
