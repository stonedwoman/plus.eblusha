#if DEBUG
import SwiftUI

/// Стенд шапки беседы со строкой местного времени собеседника — без сети и без входа:
///
///     xcrun simctl launch <устройство> org.eblusha.plus -connectDemo header
///
/// Сценарии: `header` (1:1, «14:30, Красноярск» под «В сети»), `header-offset` (пояс без города —
/// «UTC+5:30»), `header-same` (пояс совпадает с моим — строки нет), `header-secret` (под чипом
/// секретки), `header-typing` (под «печатает…»), `header-group` (группа — строки нет никогда),
/// `header-long` (длинное имя и длинный город). Нужен, чтобы увидеть, помещаются ли три строки в
/// системную панель навигации.
struct ChatHeaderDemo: View {
    let scenarioId: String

    var body: some View {
        NavigationStack {
            ZStack {
                Eb.surface200.ignoresSafeArea()
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(0..<8, id: \.self) { i in
                        Text(i % 2 == 0 ? "Сообщение собеседника \(i)" : "Моё сообщение \(i)")
                            .padding(10)
                            .background(i % 2 == 0 ? Eb.bubbleIn : Eb.bubbleOut)
                            .clipShape(RoundedRectangle(cornerRadius: 14))
                            .frame(maxWidth: .infinity, alignment: i % 2 == 0 ? .leading : .trailing)
                    }
                    Spacer()
                }
                .padding(12)
            }
            .navigationTitle(model.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    ChatHeaderTitle(model: model)
                }
                ToolbarItemGroup(placement: .topBarTrailing) {
                    Image(systemName: "video")
                    Image(systemName: "phone")
                    Image(systemName: "ellipsis")
                }
            }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Image(systemName: "chevron.left")
                }
            }
        }
        .tint(Eb.brand)
        .preferredColorScheme(.dark)
        .onAppear { seed() }
    }

    private var model: ChatHeaderModel {
        ChatHeaderModel(
            conversationId: "demo-conv",
            title: scenarioId == "header-long" ? "Константин Константинопольский" : (scenarioId == "header-group" ? "Еблуши" : "Валентина"),
            avatarUrl: nil,
            isGroup: scenarioId == "header-group",
            peerUserId: scenarioId == "header-group" ? nil : "demo-peer",
            peerStatus: "ONLINE",
            peerLastSeen: nil,
            typingName: scenarioId == "header-typing" ? "Валентина" : nil,
            groupSubtitle: scenarioId == "header-group" ? "Валентина, Костя, Саша" : nil,
            secretState: scenarioId == "header-secret" ? .ready : nil
        )
    }

    private func seed() {
        let info: LocalTimeInfo
        switch scenarioId {
        case "header-offset":
            // Пояс, которого нет в базе телефона: строка падает на смещение сервера.
            info = LocalTimeInfo(timeZone: "Mars/Olympus_Mons", city: nil, offsetMinutes: 330)
        case "header-same":
            info = LocalTimeInfo(timeZone: TimeZone.current.identifier, city: "Здесь", offsetMinutes: 0)
        case "header-long":
            info = LocalTimeInfo(timeZone: "America/Argentina/ComodRivadavia", city: "Комодоро-Ривадавия", offsetMinutes: -180)
        default:
            info = LocalTimeInfo(timeZone: "Asia/Krasnoyarsk", city: "Красноярск", offsetMinutes: 420)
        }
        PeerLocalTimeStore.shared.set(userId: "demo-peer", info)
    }
}
#endif
