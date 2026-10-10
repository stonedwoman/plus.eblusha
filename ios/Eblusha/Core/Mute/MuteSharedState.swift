import Foundation

// Общее состояние приложения и Notification Service Extension: какие беседы заглушены и сколько в
// них непрочитанного (для числа на значке). Лежит в UserDefaults группы приложений
// `group.org.eblusha.plus` — её видят оба процесса. Пишет приложение (список бесед, сокет, свои
// действия); расширение только читает «Без звука» и дописывает в журнал значка пришедшие пуши.
//
// Файл ОБЩИЙ для приложения и расширения (project.yml) — только Foundation.

enum MuteShared {
    /// Группа приложений (entitlements обоих таргетов).
    static let appGroup = "group.org.eblusha.plus"
    static let stateKey = "eb.mute.state.v1"
    static let ledgerKey = "eb.badge.ledger.v1"

    /// UserDefaults группы. Без entitlement (сборка без подписи) система отдаёт обычный домен
    /// процесса — приложение работает, только расширение его не видит.
    static func defaults() -> UserDefaults {
        UserDefaults(suiteName: appGroup) ?? .standard
    }
}

/// «Без звука» одной беседы, как его последний раз сообщил сервер.
struct MuteEntry: Codable, Equatable {
    /// Срок по часам сервера; nil — звук включён. Истёкший срок хранится как есть: заглушённость —
    /// всегда сравнение с now (MuteRules.isMuted), а не флаг.
    var untilMs: Int64?
    /// Свежесть знания (часы сервера): serverNow списка/снапшота/ответа, `at` события. Более старое
    /// знание более свежее не перетирает — тот же приём, что у местного времени собеседника.
    var asOfMs: Int64
    /// Когда «Без звука» поменяли (часы сервера) — известно только из события `conversation:mute` и
    /// ответа своего POST; из списка и снапшота — nil. Нужно расширению: пуш о сообщении, созданном
    /// РАНЬШЕ этого момента, сервер мог поставить в очередь, ещё не зная о заглушении.
    var setAtMs: Int64?
}

/// Состояние «Без звука» на этом устройстве.
struct MuteSharedState: Codable, Equatable {
    /// Чьё это состояние (userId). Смена аккаунта — состояние с нуля.
    var owner: String?
    var entries: [String: MuteEntry] = [:]
    /// Смещение часов: сервер − телефон, мс (оценка по serverNow, см. ConversationMuteStore).
    var serverOffsetMs: Int64 = 0

    func untilMs(_ conversationId: String) -> Int64? {
        entries[conversationId]?.untilMs
    }

    func isMuted(_ conversationId: String, nowMs: Int64) -> Bool {
        MuteRules.isMuted(untilMs: untilMs(conversationId), nowMs: nowMs)
    }

    static func load(from defaults: UserDefaults) -> MuteSharedState {
        guard let data = defaults.data(forKey: MuteShared.stateKey),
              let state = try? JSONDecoder().decode(MuteSharedState.self, from: data)
        else { return MuteSharedState() }
        return state
    }

    func save(to defaults: UserDefaults) {
        if let data = try? JSONEncoder().encode(self) {
            defaults.set(data, forKey: MuteShared.stateKey)
        }
    }
}

/// Журнал значка: база из последнего списка бесед + пуши, пришедшие после него.
///
/// Значок = Σ по НЕзаглушённым беседам (unread списка + пуши после списка) — то же правило, что у
/// сервера (`totalUnread`, push/badge.ts). Приложение пишет базу при каждом списке бесед и обнуляет
/// беседу при прочтении (здесь, на другом устройстве — тихий пуш kind=read и `conversation:read-self`);
/// расширение дописывает пуши, пока приложение не на экране. Сервер с `APNS_BADGE=on` присылает
/// число сам — тогда расширение его не трогает.
struct BadgeLedger: Codable, Equatable {
    var owner: String?
    /// unreadCount бесед из последнего списка.
    var baseline: [String: Int] = [:]
    /// Момент списка (serverNow; у старого сервера — местное время запроса), мс.
    var baselineAtMs: Int64?
    /// Пуши после списка: беседа → messageId → когда сообщение создано (мс, часы сервера).
    var pending: [String: [String: Int64]] = [:]

    /// Больше этого пушей журнал не держит: приложение, которое долго не открывают, не должно
    /// раздувать общий домен. Точное число всё равно вернёт следующий список бесед.
    static let pendingLimit = 500

    /// Новый список бесед: база заменяется, пуши, которые список уже учёл (созданные не позже
    /// него), выбрасываются.
    mutating func applyList(owner: String?, unread: [String: Int], atMs: Int64) {
        if self.owner != owner {
            pending = [:]
        }
        self.owner = owner
        baseline = unread.filter { $0.value > 0 }
        baselineAtMs = atMs
        prunePending { _, sentAt in sentAt > atMs }
    }

    /// Беседу прочитали (здесь или на другом устройстве) к моменту upToMs; nil — целиком.
    mutating func markRead(conversationId: String, upToMs: Int64?) {
        baseline.removeValue(forKey: conversationId)
        guard var items = pending[conversationId] else { return }
        if let upToMs {
            items = items.filter { $0.value > upToMs }
        } else {
            items = [:]
        }
        pending[conversationId] = items.isEmpty ? nil : items
    }

    /// Пуш о сообщении. false — уже учтён (повтор пуша или сообщение старше списка).
    @discardableResult
    mutating func addPush(conversationId: String, messageId: String, sentAtMs: Int64) -> Bool {
        if let baselineAtMs, sentAtMs <= baselineAtMs { return false }
        var items = pending[conversationId] ?? [:]
        guard items[messageId] == nil else { return false }
        items[messageId] = sentAtMs
        pending[conversationId] = items
        let count = pending.values.reduce(0) { $0 + $1.count }
        if count > Self.pendingLimit {
            // Выбрасываем самые старые: значок чуть занизится до следующего списка — лучше, чем
            // бесконечный рост.
            let all = pending.flatMap { conv, items in items.map { (conv, $0.key, $0.value) } }
                .sorted { $0.2 < $1.2 }
            for (conv, id, _) in all.prefix(count - Self.pendingLimit) {
                pending[conv]?.removeValue(forKey: id)
                if pending[conv]?.isEmpty == true { pending[conv] = nil }
            }
        }
        return true
    }

    /// Число на значке: заглушённые беседы не считаются.
    func total(isMuted: (String) -> Bool) -> Int {
        var ids = Set(baseline.keys)
        ids.formUnion(pending.keys)
        return ids.reduce(0) { sum, id in
            isMuted(id) ? sum : sum + (baseline[id] ?? 0) + (pending[id]?.count ?? 0)
        }
    }

    private mutating func prunePending(keep: (String, Int64) -> Bool) {
        var next: [String: [String: Int64]] = [:]
        for (conv, items) in pending {
            let kept = items.filter { keep(conv, $0.value) }
            if !kept.isEmpty { next[conv] = kept }
        }
        pending = next
    }

    static func load(from defaults: UserDefaults) -> BadgeLedger {
        guard let data = defaults.data(forKey: MuteShared.ledgerKey),
              let ledger = try? JSONDecoder().decode(BadgeLedger.self, from: data)
        else { return BadgeLedger() }
        return ledger
    }

    func save(to defaults: UserDefaults) {
        if let data = try? JSONEncoder().encode(self) {
            defaults.set(data, forKey: MuteShared.ledgerKey)
        }
    }
}

/// Что Notification Service Extension делает с alert-пушем о сообщении (src/push/apns.ts,
/// kind=message). Чистая функция — проверяется XCTest без расширения.
///
/// Пуши по заглушённым беседам режет СЕРВЕР (docs/conversation-mute.md §5) — с правилами пробития
/// (ответ на моё в группе, записи о звонке 1:1), которых расширение знать не может: в пуше нет ни
/// isGroup, ни replyTo. Поэтому пришедшему пушу верим, кроме одного случая — гонки: беседу
/// заглушили ПОСЛЕ того, как сообщение создано (сервер решал по старому состоянию). Тогда
/// уведомление становится тихим (без звука, `passive` — не будит экран). Совсем убрать его
/// расширение не может: для этого нужен entitlement фильтрации уведомлений от Apple.
enum PushMuteDecision {
    struct Result: Equatable {
        /// Сделать уведомление тихим.
        var silence = false
        /// Число на значке; nil — значок не трогать.
        var badge: Int?
        /// Обновлённый журнал значка; nil — не менялся.
        var ledger: BadgeLedger?
    }

    static func decide(
        userInfo: [AnyHashable: Any],
        serverBadge: Int?,
        state: MuteSharedState,
        ledger: BadgeLedger,
        localNowMs: Int64
    ) -> Result {
        guard userInfo["kind"] as? String == "message",
              let conversationId = userInfo["conversationId"] as? String, !conversationId.isEmpty
        else { return Result() }
        let nowMs = localNowMs + state.serverOffsetMs
        let sentAtMs = millis(userInfo["sentAt"])
        let entry = state.entries[conversationId]
        let muted = MuteRules.isMuted(untilMs: entry?.untilMs, nowMs: nowMs)

        var result = Result()
        // Гонка «пуш поставлен за миг до заглушения»: заглушили позже, чем создано сообщение.
        if muted, let setAt = entry?.setAtMs, let sentAtMs, setAt > sentAtMs {
            result.silence = true
        }

        // Значок — только для своего аккаунта: без владельца (вышли из аккаунта) не трогаем.
        guard ledger.owner != nil, ledger.owner == state.owner || state.owner == nil else {
            result.badge = serverBadge
            return result
        }
        var next = ledger
        let secret = flag(userInfo["secret"])
        // Секретки в общий счётчик не входят (у сервера их непрочитанного нет — паритет с totalUnread),
        // заглушённые — тоже, даже когда пуш пробился ответом на моё.
        if !secret, !muted, let messageId = userInfo["messageId"] as? String, !messageId.isEmpty {
            if next.addPush(conversationId: conversationId, messageId: messageId, sentAtMs: sentAtMs ?? nowMs) {
                result.ledger = next
            }
        }
        // Число от сервера (APNS_BADGE=on) точнее нашего — оставляем его.
        result.badge = serverBadge ?? next.total(isMuted: { id in state.isMuted(id, nowMs: nowMs) })
        return result
    }

    static func millis(_ value: Any?) -> Int64? {
        switch value {
        case let n as NSNumber:
            let d = n.doubleValue
            return d.isFinite && d > 0 ? Int64(d) : nil
        case let s as String:
            return Double(s).flatMap { $0.isFinite && $0 > 0 ? Int64($0) : nil }
        default:
            return nil
        }
    }

    static func flag(_ value: Any?) -> Bool {
        switch value {
        case let b as Bool: return b
        case let n as NSNumber: return n.boolValue
        case let s as String: return s == "true" || s == "1"
        default: return false
        }
    }
}
