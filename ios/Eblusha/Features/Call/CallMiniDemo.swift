#if DEBUG
import SwiftUI

/// Стенд миниатюры свёрнутого звонка: плитка без настоящей комнаты, с фиктивным участником.
/// Открывается тем же аргументом, что стенд экрана установления:
///
///     xcrun simctl launch <устройство> org.eblusha.plus -connectDemo mini
///
/// Сценарии: `mini` (1:1, собеседник говорит), `mini-silent` (молчит), `mini-group`
/// (группа, никого — «Пока никого»), `mini-reconnect` (переподключение), `mini-two`
/// (двое, говорит второй — плитка переключится через 500 мс). Тап по плитке «разворачивает»
/// условную панель, её кнопка «Свернуть» сворачивает обратно — так видно обе анимации.
/// Микрофон и отбой меняют только стенд. Место плитки, как и в приложении, запоминается
/// в UserDefaults (`eb.call.mini`) — сбросить: `defaults delete org.eblusha.plus eb.call.mini`
/// через `xcrun simctl spawn`.
struct CallMiniDemo: View {
    let scenarioId: String

    @State private var minimized = true
    @State private var flyFrom: CGRect?
    @State private var expandedFrom: CGRect?
    @State private var micOn = true
    @State private var ended = false

    var body: some View {
        ZStack {
            Eb.paper.ignoresSafeArea()
            backdrop
            if !minimized {
                panel
            }
            if minimized && !ended {
                CallMiniView(
                    snapshot: snapshot,
                    flyFrom: flyFrom,
                    onExpand: { rect in
                        expandedFrom = rect
                        minimized = false
                    },
                    onToggleMic: { micOn.toggle() },
                    onHangUp: { ended = true }
                )
            }
        }
        .preferredColorScheme(.dark)
    }

    /// Условная беседа под плиткой: шапка, пузыри, композер — чтобы видеть, что плитка не
    /// закрывает шапку и композер.
    private var backdrop: some View {
        VStack(spacing: 0) {
            Text("Стенд миниатюры · \(scenarioId)")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Eb.textPrimary)
                .frame(maxWidth: .infinity)
                .frame(height: 44)
                .background(Eb.surface200)
            ScrollView {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(0..<14, id: \.self) { i in
                        RoundedRectangle(cornerRadius: 14)
                            .fill(i % 3 == 0 ? Eb.bubbleOut : Eb.bubbleIn)
                            .frame(width: CGFloat(140 + (i * 37) % 160), height: 40)
                            .frame(maxWidth: .infinity, alignment: i % 3 == 0 ? .trailing : .leading)
                    }
                }
                .padding(12)
            }
            HStack {
                Text(ended ? "Звонок завершён (стенд)" : "Сообщение…")
                    .foregroundStyle(Eb.textMuted)
                    .padding(.horizontal, 14)
                Spacer()
            }
            .frame(height: 56)
            .background(Eb.surface100)
        }
    }

    /// «Развёрнутая панель звонка» стенда — только чтобы свернуть обратно и увидеть прилёт.
    private var panel: some View {
        GeometryReader { geo in
            VStack(spacing: 16) {
                Text("Панель звонка (стенд)")
                    .font(.system(size: 20, weight: .semibold))
                    .foregroundStyle(Eb.textPrimary)
                if let expandedFrom {
                    Text("Развернуто из \(Int(expandedFrom.minX))×\(Int(expandedFrom.minY)) \(Int(expandedFrom.width))×\(Int(expandedFrom.height))")
                        .font(.system(size: 13))
                        .foregroundStyle(Eb.textMuted)
                }
                Button("Свернуть") {
                    flyFrom = geo.frame(in: .global)
                    minimized = true
                }
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(Eb.logoCream)
                .padding(.horizontal, 24)
                .padding(.vertical, 12)
                .background(Eb.brand, in: Capsule())
            }
            .frame(width: geo.size.width, height: geo.size.height)
            .background(Eb.surface200)
        }
        .ignoresSafeArea()
    }

    private var snapshot: CallMiniSnapshot {
        let me = CallParticipant(
            id: "me", userId: "me", name: "Я", avatarUrl: nil, isLocal: true,
            muted: !micOn, speaking: false, hasVideo: false, videoTrack: nil
        )
        func peer(_ id: String, _ name: String, speaking: Bool) -> CallParticipant {
            CallParticipant(
                id: id, userId: id, name: name, avatarUrl: nil, isLocal: false,
                muted: false, speaking: speaking, hasVideo: false, videoTrack: nil
            )
        }
        var s = CallMiniSnapshot(micOn: micOn, encrypted: true, connectedAt: Date().addingTimeInterval(-83))
        switch scenarioId {
        case "mini-silent":
            s.participants = [me, peer("demo-peer", "Катя", speaking: false)]
        case "mini-group":
            s.participants = [me]
            s.isGroup = true
            s.encrypted = false
        case "mini-reconnect":
            s.participants = [me, peer("demo-peer", "Катя", speaking: false)]
            s.reconnecting = true
        case "mini-two":
            s.participants = [me, peer("demo-a", "Катя", speaking: false), peer("demo-b", "Константин Константинопольский", speaking: true)]
            s.activeSpeakerIds = ["demo-b"]
            s.isGroup = true
            s.encrypted = false
        default:
            s.participants = [me, peer("demo-peer", "Катя", speaking: true)]
            s.activeSpeakerIds = ["demo-peer"]
        }
        return s
    }
}
#endif
