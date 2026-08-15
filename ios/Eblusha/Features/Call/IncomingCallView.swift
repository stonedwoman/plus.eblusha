import SwiftUI

// Порт `IncomingCallUi` из `ui/call/CallScreen.kt` — полноэкранный входящий звонок.
//
// Роль Android-IncomingCallService (рингтон + вибрация + сворачивание всплывашки
// с дублирующими кнопками) на iOS выполняет CallRinger внутри CallManager, поэтому
// экрану остаётся только показать звонящего и три большие кнопки.

struct IncomingCallView: View {
    @ObservedObject var manager: CallManager

    var body: some View {
        VStack(spacing: 0) {
            Spacer()
            AvatarView(name: manager.title, avatarUrl: manager.avatarUrl, size: 120)
            Spacer().frame(height: 16)
            Text(manager.title)
                .font(.system(size: 28, weight: .semibold))
                .foregroundStyle(.white)
                .multilineTextAlignment(.center)
            Text(manager.isVideoCall ? "Входящий видеозвонок" : "Входящий звонок")
                .font(.system(size: 14))
                .foregroundStyle(Eb.textMuted)
            Spacer()
            HStack {
                Spacer()
                CallBigButton(
                    systemName: "phone.down.fill",
                    container: Eb.error,
                    label: "Отклонить",
                    action: manager.declineIncoming
                )
                Spacer()
                // Обычное «Принять» подключает только звук (наша камера остаётся выключенной);
                // у видеозвонков появляется отдельная кнопка «С видео».
                CallBigButton(
                    systemName: "phone.fill",
                    container: Eb.online,
                    label: "Принять",
                    action: { manager.acceptIncoming(withVideo: false) }
                )
                Spacer()
                if manager.isVideoCall {
                    CallBigButton(
                        systemName: "video.fill",
                        container: Eb.brand,
                        label: "С видео",
                        action: { manager.acceptIncoming(withVideo: true) }
                    )
                    Spacer()
                }
            }
            Spacer().frame(height: 40)
        }
        .padding(24)
    }
}

/// Порт `BigCallButton`: большая круглая кнопка звонка с подписью снизу.
/// Общая для входящего экрана и экрана дозвона (RingingView).
struct CallBigButton: View {
    let systemName: String
    let container: Color
    let label: String
    let action: () -> Void

    var body: some View {
        VStack(spacing: 6) {
            Button(action: action) {
                Image(systemName: systemName)
                    .font(.system(size: 24, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 64, height: 64)
                    .background(container, in: Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(label)
            Text(label)
                .font(.system(size: 12))
                .foregroundStyle(Eb.textMuted)
        }
    }
}
