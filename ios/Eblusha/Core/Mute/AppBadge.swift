import Foundation
import Combine
import UserNotifications

/// Число на значке приложения — общий счётчик непрочитанного БЕЗ заглушённых бесед (то же правило,
/// что у сервера: `totalUnread` списка и `aps.badge` при APNS_BADGE=on, push/badge.ts).
///
/// Раньше значка не было вовсе. Сервер умеет ставить число в alert-пуш, но включать это можно только
/// вместе с клиентом, который сам сбрасывает значок: тихий read-пуш число нести не может, и без
/// клиента значок залипал бы. Поэтому:
///  - приложение выставляет значок по каждому списку бесед, при прочтении беседы (здесь, на другом
///    устройстве — тихий пуш kind=read и сокет `conversation:read-self`) и при перемене «Без звука»;
///  - Notification Service Extension дописывает пришедшие пуши в журнал (BadgeLedger) и ставит
///    число в само уведомление, пока приложение не на экране (если сервер уже прислал своё — его).
///
/// Только главный поток.
final class AppBadge {
    static let shared = AppBadge()

    private let defaults: UserDefaults
    private let mutes: ConversationMuteStore
    private let apply: (Int) -> Void
    private var cancellables: Set<AnyCancellable> = []

    init(
        defaults: UserDefaults = MuteShared.defaults(),
        mutes: ConversationMuteStore = .shared,
        apply: ((Int) -> Void)? = nil
    ) {
        self.defaults = defaults
        self.mutes = mutes
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

    /// Свежий список бесед: unread — непрочитанное каждой беседы, atMs — момент списка (часы сервера).
    func listLoaded(owner: String?, unread: [String: Int], atMs: Int64) {
        var ledger = BadgeLedger.load(from: defaults)
        ledger.applyList(owner: owner, unread: unread, atMs: atMs)
        ledger.save(to: defaults)
        recompute(ledger)
    }

    /// Беседу прочитали к моменту upToMs (часы сервера); nil — целиком.
    func conversationRead(_ conversationId: String, upToMs: Int64?) {
        var ledger = BadgeLedger.load(from: defaults)
        guard ledger.owner != nil else { return }
        ledger.markRead(conversationId: conversationId, upToMs: upToMs)
        ledger.save(to: defaults)
        recompute(ledger)
    }

    /// Пересчитать и выставить (журнал мог дописать NSE — читаем заново).
    func recompute() {
        recompute(BadgeLedger.load(from: defaults))
    }

    /// Число для журнала — то же, что пойдёт на значок.
    func total(_ ledger: BadgeLedger) -> Int {
        guard ledger.owner != nil else { return 0 }
        return ledger.total { [mutes] in mutes.isMuted($0) }
    }

    /// Выход из аккаунта: значок гаснет, журнал прошлой сессии стирается.
    func reset() {
        BadgeLedger().save(to: defaults)
        apply(0)
    }

    private func recompute(_ ledger: BadgeLedger) {
        apply(total(ledger))
    }
}
