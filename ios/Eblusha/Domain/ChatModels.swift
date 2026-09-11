import Foundation

// Порт `domain/model/ChatModels.kt` — доменные модели, которыми живёт UI.

enum ReceiptState: String, Codable {
    case none = "NONE"
    case sent = "SENT"
    case delivered = "DELIVERED"
    case read = "READ"
}

struct MessageReaction: Codable, Equatable {
    let emoji: String
    let count: Int
    let mine: Bool
}

/// Цитата, на которую указывает ответ (по одной на цитату). Имя отправителя резолвит UI.
struct ReplyInfo: Equatable {
    let id: String
    let senderId: String
    let content: String?
    var createdAt: Int64?
}

/// Происхождение пересылки из `metadata.forwardFrom` (совместимо с вебом по проводу).
struct ForwardInfo: Equatable {
    let authorName: String
    var sourceChatTitle: String?
    var isGroupSource = false
    var directChatPeerName: String?
    var originalCreatedAt: Int64?
}

/// Серверное Open Graph-превью первой ссылки (`metadata.linkPreview`).
struct LinkPreview: Equatable {
    let url: String
    var title: String?
    var description: String?
    var imageUrl: String?
    var siteName: String?
}

struct MessageAttachment: Codable, Equatable {
    let url: String
    let type: String // IMAGE | VIDEO | AUDIO | FILE
    var mime: String?
    var name: String?
    var size: Int64?
    var width: Int?
    var height: Int?
    /// Кадр-постер видео (metadata.posterKey); nil — постера нет.
    var posterUrl: String?
    /// Длительность медиа в секундах (`metadata.duration` ВЛОЖЕНИЯ, не сообщения): у видео
    /// она нужна плитке в пузыре, а `Message.audioDurationSec` описывает только голосовое.
    var durationSec: Int?
    /// E2EE: nonce файла — url отдаёт шифртекст, расшифровать ключом треда secretThreadId.
    var secretNonce: String?
    var secretThreadId: String?

    /// Размер плитки под картинку — порт расчёта из веба (`ChatMessageRow.tsx`):
    /// бокс с точными пропорциями резервируется ДО загрузки, поэтому лента не прыгает,
    /// а картинка вписывается целиком (contain), а не обрезается.
    /// `extraInset` — ширина, которую отъедает обёртка вокруг картинки (конверт
    /// пересылки: ForwardEnvelopeMetrics.horizontalInset). Без него плитка считалась бы
    /// от полного пузыря и вылезала за янтарную рамку.
    func displaySize(screen: CGSize, extraInset: CGFloat = 0) -> CGSize {
        // Веб: maxScreen = max(320, vw/2), heightBudget = min(420, vh*0.55) на мобильном.
        let maxScreen = max(320, screen.width / 2)
        let heightBudget = min(420, screen.height * 0.55)

        let baseW = CGFloat(width ?? 0) > 0 ? CGFloat(width!) : maxScreen
        let baseH = CGFloat(height ?? 0) > 0 ? CGFloat(height!) : baseW * 0.75
        let ratio = baseH / baseW

        let maxWidth = maxScreen
        var maxHeight = heightBudget
        // Широкие кадры не должны занимать весь бюджет высоты (веб: те же пороги).
        if ratio < 0.5 {
            maxHeight = max(maxScreen * 0.6, 200)
        } else if ratio < 0.7 {
            maxHeight = max(maxScreen * 0.75, 200)
        }
        maxHeight = min(maxHeight, heightBudget)

        let scale = min(baseW > maxWidth ? maxWidth / baseW : 1, baseH > maxHeight ? maxHeight / baseH : 1, 1)
        var targetW = baseW * scale
        var targetH = baseH * scale
        if targetW > maxWidth {
            targetW = maxWidth
            targetH = targetW * ratio
        }
        if targetH > maxHeight {
            targetH = maxHeight
            targetW = targetH / ratio
        }
        // Ширина пузыря ограничена экраном минус аватар и отступы (веб: vw - 100).
        targetW = min(targetW, screen.width - 100 - extraInset)
        return CGSize(width: targetW.rounded(), height: (targetW * ratio).rounded())
    }

    /// Пропорция кадра h/w для мозаики альбома — порт веб-`getRatio`: без метаданных
    /// считаем квадрат, панорамы и «простыни» зажимаем в 0.2..5, иначе одна картинка
    /// растянула бы весь альбом. Считается из метаданных, то есть ДО загрузки.
    var albumRatio: CGFloat {
        guard let width, let height, width > 0, height > 0 else { return 1 }
        return AlbumLayout.clampRatio(CGFloat(height) / CGFloat(width))
    }

    /// Бюджет альбома: порт веб-`gridMaxW`/`gridMaxH` (мобильная ветка — 85% ширины окна,
    /// высота до min(420, 55% окна)), но ширина зажата тем, что реально остаётся пузырю.
    /// В вебе лишнее поджимал flex, здесь плитки жёсткого размера, поэтому вычитаем
    /// 120 = отступы ячейки (2×10) + аватар с зазором (28+6) + паддинги пузыря (2×12)
    /// + минимальный зазор до края (40): иначе мозаика вылезала бы за пузырь в группе.
    /// `extraInset` — потеря ширины на обёртке (конверт пересылки), см. displaySize.
    static func albumBudget(
        screen: CGSize, extraInset: CGFloat = 0
    ) -> (maxWidth: CGFloat, maxHeight: CGFloat) {
        let byViewport = max(280, (screen.width * 0.85).rounded(.down))
        return (
            maxWidth: min(byViewport, screen.width - 120 - extraInset),
            maxHeight: min(420, (screen.height * 0.55).rounded())
        )
    }

    /// Размер плитки видео. Математика та же, что у картинки, но при отсутствии
    /// метаданных веб (`VideoMessageBubble`) берёт 16/9, а не 4/3 как у фото, — иначе
    /// плитка была бы заметно выше кадра, который в неё потом ляжет.
    func videoDisplaySize(screen: CGSize, extraInset: CGFloat = 0) -> CGSize {
        if let width, let height, width > 0, height > 0 {
            return displaySize(screen: screen, extraInset: extraInset)
        }
        var guessed = self
        // Подставляем не 16×9 (displaySize мелкие кадры НЕ растягивает), а сразу
        // «экранный» размер в пропорции 16/9.
        let base = max(320, screen.width / 2)
        guessed.width = Int(base.rounded())
        guessed.height = Int((base * 9 / 16).rounded())
        return guessed.displaySize(screen: screen, extraInset: extraInset)
    }
}

struct ChatUser: Identifiable, Equatable {
    let id: String
    let username: String
    let displayName: String?
    let avatarUrl: String?
    var online = false

    var name: String {
        if let displayName, !displayName.isEmpty { return displayName }
        return username
    }
}

struct Conversation: Identifiable, Equatable, Hashable {
    let id: String
    let isGroup: Bool
    let isSecret: Bool
    let title: String
    let avatarUrl: String?
    let lastMessageText: String?
    let lastMessageAt: Int64?
    let unreadCount: Int
    var online: Bool
    var otherUserId: String?
    var otherLastSeen: Int64?
    /// ПОЛНЫЙ статус собеседника (ONLINE/BACKGROUND/AWAY/IN_CALL/OFFLINE): одного
    /// `online` мало — BACKGROUND схлопывался в false и плитка врала «был(а) онлайн».
    var otherStatus: String?
    var type: String?        // "SECRET" = E2EE-тред (V2); у легаси-секреток другой тип
    var createdById: String? // секретные треды: ключ треда генерирует ТОЛЬКО создатель
    var secretStatus: String?       // PENDING (приглашение) | ACTIVE | CANCELLED
    var secretPeerDeviceId: String?
    /// Когда беседу завели (мс эпохи). Только для порядка списка: беседа без сообщений
    /// сортируется по ней, иначе новая строка тонет под перепиской годичной давности.
    /// Объявлен последним и с дефолтом — чтобы memberwise-init оставался совместимым.
    var createdAt: Int64? = nil

    /// Свежесть беседы для сортировки — порт веб-`tsOf` (ConversationListPane.tsx:107-112).
    var sortTs: Int64 { lastMessageAt ?? createdAt ?? 0 }

    /// V2-секретка — E2EE через секретный транспорт; НИКОГДА не различать по isSecret одному.
    var isSecretV2: Bool { type?.caseInsensitiveCompare("SECRET") == .orderedSame }
    /// Секретное приглашение, которое собеседник ещё не принял.
    var isSecretPending: Bool {
        isSecretV2 && secretStatus?.caseInsensitiveCompare("PENDING") == .orderedSame
    }
}

struct Message: Identifiable, Equatable {
    let id: String
    let conversationId: String
    let senderId: String
    let senderName: String
    var senderAvatarUrl: String?
    let type: String
    let content: String?
    let createdAt: Int64
    let isMine: Bool
    let isSystem: Bool
    var edited = false
    var deleted = false
    var reactions: [MessageReaction] = []
    var receipt: ReceiptState = .none
    var attachments: [MessageAttachment] = []
    /// Цитаты, на которые отвечает сообщение (0 — нет, 1 — одна, ≥2 — мультиответ).
    var replyTo: [ReplyInfo] = []
    /// Не-nil, когда сообщение переслано (рисуется конверт пересылки + цитата оригинала).
    var forwardFrom: ForwardInfo?
    /// Длительность голосового в секундах (`metadata.duration`); nil для не-аудио.
    var audioDurationSec: Int?
    /// Предрассчитанные амплитуды (0..100) волны голосового (`metadata.waveform`).
    var waveform: [Int]?
    /// Open Graph-превью первой ссылки, когда сервер его разрешил.
    var linkPreview: LinkPreview?
}
