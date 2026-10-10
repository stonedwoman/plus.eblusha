#if DEBUG
import SwiftUI
import UserNotifications

/// Стенд «Без звука» без сети и без входа — настоящий список бесед (ChatListView + ChatListViewModel),
/// в который положены готовые беседы и состояние «Без звука»:
///
///     xcrun simctl launch <устройство> org.eblusha.plus -connectDemo mute
///
/// Сценарии: `mute` — список (заглушённая группа с серым счётчиком, обычная личка с оранжевым,
/// заглушённая навсегда группа с идущим звонком — кант горит от звонка, личка «до завтра» без
/// непрочитанного, «Чат с Еблушей» на неделю); `mute-toast` — то же с подтверждением «Без звука на
/// 1 час»; `mute-error` — с ошибкой «Не удалось изменить звук беседы»; `mute-push` — спросить
/// разрешение на уведомления и положить журнал значка (значок = 2: непрочитанное незаглушённой
/// лички) — проверка Notification Service Extension через `xcrun simctl push` (handoff §16).
/// Меню (долгое нажатие) и свайп — через пульт симулятора (scripts/ios-drive.sh, `press:`, `drag:`).
/// Шапка заглушённой беседы — `-connectDemo header-muted` (ChatHeaderDemo).
struct MuteDemo: View {
    let scenarioId: String
    @StateObject private var vm: ChatListViewModel

    init(scenarioId: String) {
        self.scenarioId = scenarioId
        let c = AppContainer.shared
        _vm = StateObject(wrappedValue: ChatListViewModel(
            repo: c.chatRepository, realtime: c.realtimeClient,
            contacts: c.contactsRepository, secret: c.secretRepository
        ))
    }

    var body: some View {
        NavigationStack {
            ChatListView(vm: vm, onOpenChat: { _ in }, onOpenContacts: {}, onOpenSettings: {}, onNewGroup: {})
        }
        .tint(Eb.brand)
        .muteToast()
        .preferredColorScheme(.dark)
        .onAppear { seed() }
    }

    static let ids = (group: "demo-g1", dm: "demo-d1", callGroup: "demo-g2", dmTomorrow: "demo-d2", bot: "demo-bot")

    private func seed() {
        let nowMs = Int64(Date().timeIntervalSince1970 * 1000)
        let minute: Int64 = 60_000
        func conv(
            _ id: String, _ title: String, group: Bool, unread: Int, text: String, agoMin: Int64,
            bot: Bool = false, online: Bool = false
        ) -> Conversation {
            Conversation(
                id: id, isGroup: group, isSecret: false, title: title,
                avatarUrl: nil, lastMessageText: text, lastMessageAt: nowMs - agoMin * minute, unreadCount: unread,
                online: online, otherUserId: group ? nil : "peer-\(id)", otherLastSeen: nil,
                otherStatus: online ? "ONLINE" : nil,
                type: nil, createdById: nil, secretStatus: nil, secretPeerDeviceId: nil,
                isBotChat: bot
            )
        }
        let ids = Self.ids
        vm.demoSeed([
            conv(ids.group, "Еблуши", group: true, unread: 3, text: "Костя: кто сегодня в Valheim?", agoMin: 2),
            conv(ids.dm, "Валентина", group: false, unread: 2, text: "Ты где?", agoMin: 5, online: true),
            conv(ids.callGroup, "Работа", group: true, unread: 7, text: "Саша начал звонок", agoMin: 9),
            conv(ids.dmTomorrow, "Костя", group: false, unread: 0, text: "Ок, до завтра", agoMin: 40),
            conv(ids.bot, "Еблуша", group: false, unread: 1, text: "Готово: карта обновлена", agoMin: 75, bot: true),
        ])
        // Срок «до завтра»: завтрашние 10:00 по часам телефона.
        let calendar = Calendar.current
        let tomorrow = calendar.date(
            bySettingHour: 10, minute: 0, second: 0,
            of: calendar.date(byAdding: .day, value: 1, to: Date()) ?? Date()
        ) ?? Date()
        ConversationMuteStore.shared.applyList(
            owner: nil,
            items: [
                ids.group: nowMs + 60 * minute,
                ids.dm: nil,
                ids.callGroup: MuteRules.foreverMs,
                ids.dmTomorrow: Int64(tomorrow.timeIntervalSince1970 * 1000),
                ids.bot: nowMs + 7 * 24 * 60 * minute,
            ],
            serverNowMs: nowMs,
            requestedAtMs: nowMs
        )
        // Идущий групповой звонок в заглушённой «Работе» — «тихая отметка»: кант и «В ЗВОНКЕ» есть.
        let call = #"{"conversationId":"\#(ids.callGroup)","active":true,"startedAt":\#(nowMs - 4 * minute),"participants":["x"]}"#
        if let payload = try? JSONDecoder().decode(CallStatusPayload.self, from: Data(call.utf8)) {
            CallStatusStore.shared.apply(payload)
        }
        switch scenarioId {
        case "mute-toast":
            ConversationMuteStore.shared.toast = MuteToast(text: MutePreset.hour.doneText, isError: false)
        case "mute-error":
            ConversationMuteStore.shared.toast = MuteToast(text: MuteText.failed, isError: true)
        case "mute-push":
            // «Еблуши» заглушили только что (как событием с другого устройства): пуш о сообщении,
            // созданном раньше, расширение сделает тихим.
            ConversationMuteStore.shared.applyEvent(ConversationMuteEvent(
                conversationId: ids.group, untilMs: nowMs + 60 * minute, atMs: nowMs + 1, byDeviceId: nil
            ))
            let unread = [ids.group: 3, ids.dm: 2, ids.callGroup: 7, ids.bot: 1]
            UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound]) { _, _ in
                DispatchQueue.main.async {
                    AppBadge.shared.listLoaded(owner: "demo-owner", unread: unread, atMs: nowMs)
                }
            }
        default:
            break
        }
    }
}
#endif
