import Foundation
import Combine
import UserNotifications

/// Число на значке приложения — общий счётчик непрочитанного БЕЗ заглушённых бесед (то же правило,
/// что у сервера: `totalUnread` списка и `aps.badge`, src/push/badge.ts).
///
/// Раньше значка не было вовсе. Число ведёт СЕРВЕР: приложение, выгруженное свайпом, не получает ни
/// сокета, ни тихих read-пушей, и посчитанное здесь число залипало бы (прочитали на ПК — а на иконке
/// всё ещё 4). Сервер ставит его в каждый пуш о сообщении и отдельным badge-only пушем после прочтения
/// на другом устройстве, смены «Без звука» и истечения его срока — но только устройствам, объявившим
/// `caps:["badge"]` при регистрации alert-токена (PushRepository). Его ответ `badge:true` — «число ведёт
/// сервер» (`serverMaintained`, переживает перезапуск).
///
/// Отсюда два режима:
///  - сервер ведёт число — приложение, пока открыто, выставляет то же число само: по каждому списку бесед,
///    при прочтении (здесь, на другом устройстве — тихий пуш kind=read и сокет `conversation:read-self`) и
///    при перемене «Без звука» (своё прочтение серверу некому отправить: читающее устройство из read-пуша
///    исключено);
///  - не ведёт (старый сервер, APNS_BADGE=off, нет ответа) — значок пустой всегда: обновлять его, пока
///    приложение выгружено, было бы некому.
///
/// Только главный поток.
final class AppBadge {
    static let shared = AppBadge()

    static let serverKey = "eb.badge.server.v1"

    private let defaults: UserDefaults
    private let mutes: ConversationMuteStore
    private let apply: (Int) -> Void
    private var cancellables: Set<AnyCancellable> = []

    /// Сервер ведёт число на значке этого устройства (последний ответ регистрации alert-токена).
    private(set) var serverMaintained: Bool

    init(
        defaults: UserDefaults = MuteShared.defaults(),
        mutes: ConversationMuteStore = .shared,
        apply: ((Int) -> Void)? = nil
    ) {
        self.defaults = defaults
        self.mutes = mutes
        self.serverMaintained = defaults.bool(forKey: Self.serverKey)
        self.apply = apply ?? { count in
            UNUserNotificationCenter.current().setBadgeCount(count) { error in
                if let error { NSLog("AppBadge: значок не выставлен: %@", String(describing: error)) }
            }
        }
        // «Без звука» поменялся (здесь, на другом устройстве, истёк срок) — беседа вошла в счётчик
        // или вышла из него.
        mutes.changes
            .receive(on: DispatchQueue.main)
            .sink { [weak self] in self?.recompute() }
            .store(in: &cancellables)
    }

    /// Ответ регистрации alert-токена: `badge:true` — число ведёт сервер. Иначе значок гаснет.
    func setServerMaintained(_ on: Bool) {
        if on != serverMaintained {
            serverMaintained = on
            defaults.set(on, forKey: Self.serverKey)
        }
        recompute()
    }

    /// Свежий список бесед: unread — непрочитанное каждой беседы, atMs — момент списка (часы сервера).
    func listLoaded(owner: String?, unread: [String: Int], atMs: Int64) {
        var ledger = BadgeLedger.load(from: defaults)
        ledger.applyList(owner: owner, unread: unread, atMs: atMs)
        ledger.save(to: defaults)
        recompute(ledger)
    }

    /// Беседу прочитали (здесь или на другом устройстве).
    func conversationRead(_ conversationId: String) {
        var ledger = BadgeLedger.load(from: defaults)
        guard ledger.owner != nil else { return }
        ledger.markRead(conversationId: conversationId)
        ledger.save(to: defaults)
        recompute(ledger)
    }

    /// Пересчитать и выставить.
    func recompute() {
        recompute(BadgeLedger.load(from: defaults))
    }

    /// Число по списку — то же, что у сервера.
    func total(_ ledger: BadgeLedger) -> Int {
        guard ledger.owner != nil else { return 0 }
        return ledger.total { [mutes] in mutes.isMuted($0) }
    }

    /// Выход из аккаунта: значок гаснет, база прошлой сессии стирается. Объявление на сервере снимает
    /// DELETE …/push (PushRepository.unregister); до следующей регистрации считаем, что число не ведётся.
    func reset() {
        BadgeLedger().save(to: defaults)
        serverMaintained = false
        defaults.set(false, forKey: Self.serverKey)
        apply(0)
    }

    private func recompute(_ ledger: BadgeLedger) {
        apply(serverMaintained ? total(ledger) : 0)
    }
}

/// База значка, пока приложение открыто: непрочитанное по беседам из последнего списка бесед. Пока
/// приложение выгружено, число ведёт сервер (AppBadge).
struct BadgeLedger: Codable, Equatable {
    var owner: String?
    /// unreadCount бесед из последнего списка (нули не храним).
    var baseline: [String: Int] = [:]
    /// Момент списка (serverNow; у старого сервера — местное время запроса), мс.
    var baselineAtMs: Int64?

    /// Новый список бесед: база заменяется целиком.
    mutating func applyList(owner: String?, unread: [String: Int], atMs: Int64) {
        self.owner = owner
        baseline = unread.filter { $0.value > 0 }
        baselineAtMs = atMs
    }

    /// Беседу прочитали (здесь или на другом устройстве). Пришедшее после прочтения вернёт следующий
    /// список (он перечитывается на каждое новое сообщение).
    mutating func markRead(conversationId: String) {
        baseline.removeValue(forKey: conversationId)
    }

    /// Число на значке: заглушённые беседы не считаются.
    func total(isMuted: (String) -> Bool) -> Int {
        baseline.reduce(0) { sum, item in isMuted(item.key) ? sum : sum + item.value }
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
