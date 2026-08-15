import Foundation
import LiveKit

// Порт `feature/call/CallModels.kt` — модели состояния звонка.

struct CallParticipant: Identifiable {
    let id: String
    /// Чистый userId (из метаданных токена или identity до «#») — для карточки пользователя.
    let userId: String?
    let name: String
    let avatarUrl: String?
    let isLocal: Bool
    let muted: Bool
    let speaking: Bool
    let hasVideo: Bool
    let videoTrack: VideoTrack?
    var connectionQuality: ConnectionQuality = .unknown
    var pingMs: Int?
    var isScreenSharing = false
}

extension CallParticipant: Equatable {
    // VideoTrack не Equatable — сравниваем ссылочно: для diffing SwiftUI важно лишь,
    // что это тот же самый живой трек.
    static func == (l: CallParticipant, r: CallParticipant) -> Bool {
        l.id == r.id && l.userId == r.userId && l.name == r.name
            && l.avatarUrl == r.avatarUrl && l.isLocal == r.isLocal
            && l.muted == r.muted && l.speaking == r.speaking
            && l.hasVideo == r.hasVideo && l.videoTrack === r.videoTrack
            && l.connectionQuality == r.connectionQuality
            && l.pingMs == r.pingMs && l.isScreenSharing == r.isScreenSharing
    }
}

enum CameraFacing { case front, back, external }

/// Физически выбираемая камера: фронтальная, задняя или конкретный задний объектив
/// (широкий / сверхширокий / телефото).
struct CameraOption: Identifiable, Equatable {
    /// `uniqueID` соответствующего AVCaptureDevice.
    let deviceId: String
    let label: String
    let facing: CameraFacing

    var id: String { deviceId }
}

/// Порт sealed-интерфейса `CallState`: фазы жизни звонка. В Kotlin данные ехали внутри
/// состояний; здесь данные лежат в published-свойствах CallManager, а фаза — плоский enum
/// (так SwiftUI-подписчикам не нужно деструктурировать sealed-иерархию).
enum CallPhase: Equatable {
    case idle
    case incoming
    case outgoing
    /// Звонок принят, комната ещё собирается — `CallState.Active(connecting = true)`.
    case connecting
    case inCall

    /// Аналог `state is CallState.Active` из Kotlin.
    var isActive: Bool { self == .connecting || self == .inCall }
}
