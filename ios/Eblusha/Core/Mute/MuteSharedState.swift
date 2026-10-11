import Foundation

// Общее состояние приложения и Notification Service Extension: какие беседы заглушены. Лежит в
// UserDefaults группы приложений `group.org.eblusha.plus` — её видят оба процесса. Пишет приложение
// (список бесед, сокет, свои действия); расширение только читает. Число на значке расширение не
// считает: его ведёт сервер (AppBadge, docs/conversation-mute.md §5).
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
    /// С какого момента (часы сервера) беседа НЕПРЕРЫВНО заглушена — известно только из события
    /// `conversation:mute` и ответа своего POST, которые её заглушили; из списка и снапшота — nil
    /// (неизвестно). Перестановка срока у уже заглушённой беседы момент не сдвигает: сервер всё это время
    /// резал пуши и пропускал только пробившиеся. Нужно расширению: пуш о сообщении, созданном РАНЬШЕ этого
    /// момента, сервер мог поставить в очередь, ещё не зная о заглушении.
    var setAtMs: Int64?
}

/// Состояние «Без звука» на этом устройстве.
struct MuteSharedState: Codable, Equatable {
    /// Чьё это состояние (userId). Смена аккаунта — состояние с нуля.
    var owner: String?
    var entries: [String: MuteEntry] = [:]
    /// Смещение часов: сервер − телефон, мс (оценка по serverNow, см. ConversationMuteStore).
    var serverOffsetMs: Int64 = 0
    /// asOf последнего снапшота (замена целиком): про беседу, которой нет в entries, известно «звук включён»
    /// на этот момент, и более старый список её не заглушит. nil — снапшота ещё не было.
    var snapshotAsOfMs: Int64?

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

/// Что Notification Service Extension делает с alert-пушем о сообщении (src/push/apns.ts,
/// kind=message). Чистая функция — проверяется XCTest без расширения.
///
/// Пуши по заглушённым беседам режет СЕРВЕР (docs/conversation-mute.md §5) — с правилами пробития
/// (ответ на моё в группе, записи о звонке 1:1), которых расширение знать не может: в пуше нет ни
/// isGroup, ни replyTo. Поэтому пришедшему пушу верим, кроме одного случая — гонки: беседу
/// заглушили ПОСЛЕ того, как сообщение создано (сервер решал по старому состоянию). Тогда
/// уведомление становится тихим (без звука, `passive` — не будит экран). Совсем убрать его
/// расширение не может: для этого нужен entitlement фильтрации уведомлений от Apple.
///
/// Значок расширение не трогает: число в `aps.badge` ставит сервер (и только устройствам, которым он
/// ведёт значок), а своё число по пушам здесь посчитать правильно нельзя — прочтения на других
/// устройствах до выгруженного приложения не доходят.
enum PushMuteDecision {
    struct Result: Equatable {
        /// Сделать уведомление тихим.
        var silence = false
    }

    static func decide(
        userInfo: [AnyHashable: Any],
        state: MuteSharedState,
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
