import SwiftUI

// Порт `ui/components/Avatar.kt` и `PresenceBadge.kt`.

/// Красный «в звонке» — тот же, что у веба (#ef4444).
let ebCallRed = Color(hex: 0xEF4444)

/// Цвет присутствия — один на всё приложение.
func presenceColor(_ status: String?, onlineFallback: Bool = false) -> Color {
    switch status?.uppercased() {
    case "ONLINE": return Eb.online
    case "IN_CALL": return ebCallRed
    case "BACKGROUND": return Eb.presenceBg
    case "AWAY": return Eb.away
    case "OFFLINE": return Eb.offline
    default: return onlineFallback ? Eb.online : Eb.offline
    }
}

/// Тёплый hash-оттенок, зеркало веб-аватара `hsl(24+base%18-9, 60+base%15, 30+base%12)`.
private func avatarColor(_ name: String) -> Color {
    // hashCode Java-строки — чтобы цвета совпадали с Android-клиентом у тех же имён.
    var hash: Int32 = 0
    for scalar in name.unicodeScalars {
        hash = hash &* 31 &+ Int32(bitPattern: UInt32(scalar.value))
    }
    let base = Int(hash.magnitude)
    let hue = Double(24 + base % 18 - 9) / 360.0
    let saturation = Double(60 + base % 15) / 100.0
    let lightness = Double(30 + base % 12) / 100.0
    // HSL → HSB: SwiftUI Color принимает hue/saturation/brightness.
    let brightness = lightness + saturation * min(lightness, 1 - lightness)
    let hsbSaturation = brightness == 0 ? 0 : 2 * (1 - lightness / brightness)
    return Color(hue: hue, saturation: hsbSaturation, brightness: brightness)
}

private func initials(_ name: String) -> String {
    let parts = name
        .split(whereSeparator: { $0 == " " || $0 == "_" || $0 == "-" })
        .filter { !$0.isEmpty }
    switch parts.count {
    case 0: return "?"
    case 1: return parts[0].prefix(1).uppercased()
    default: return (parts[0].prefix(1) + parts[1].prefix(1)).uppercased()
    }
}

struct AvatarView: View {
    let name: String
    let avatarUrl: String?
    var size: CGFloat = 48

    var body: some View {
        Group {
            if let resolved = resolveMediaUrl(avatarUrl), let url = URL(string: resolved) {
                AsyncImage(url: url) { phase in
                    if let image = phase.image {
                        image.resizable().scaledToFill()
                    } else {
                        placeholder
                    }
                }
            } else {
                placeholder
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
    }

    private var placeholder: some View {
        ZStack {
            Circle().fill(avatarColor(name))
            Text(initials(name))
                .font(.system(size: size / 2.4, weight: .semibold))
                .foregroundStyle(.white)
        }
    }
}

/// Значок присутствия поверх аватара. Если известно устройство — иконка устройства
/// цветом статуса вместо безликой точки; офлайн остаётся точкой.
struct PresenceBadge: View {
    let userId: String?
    let status: String?
    var onlineFallback = false
    var ringSize: CGFloat = 16
    var dotSize: CGFloat = 10
    var ringColor: Color = Eb.surface200

    @ObservedObject private var presenceDevices = PresenceDevices.shared

    var body: some View {
        let device = userId.flatMap { presenceDevices.devices[$0] }
        // Известное устройство означает живой сокет: человек в сети хотя бы в фоне.
        let effectiveStatus: String?
        if device == nil {
            effectiveStatus = status
        } else if status == nil || status?.uppercased() == "OFFLINE" {
            effectiveStatus = "BACKGROUND"
        } else {
            effectiveStatus = status
        }
        let offline = device == nil &&
            (effectiveStatus?.uppercased() == "OFFLINE" || (effectiveStatus == nil && !onlineFallback))
        let color = presenceColor(effectiveStatus, onlineFallback: onlineFallback)

        return ZStack {
            Circle().fill(Eb.surface100)
            Circle().strokeBorder(ringColor, lineWidth: 2)
            if !offline, let device {
                Image(systemName: deviceIcon(device))
                    .resizable()
                    .scaledToFit()
                    .frame(width: ringSize - 6, height: ringSize - 6)
                    .foregroundStyle(color)
            } else {
                Circle().fill(color).frame(width: dotSize, height: dotSize)
            }
        }
        .frame(width: ringSize, height: ringSize)
        // Юго-восточная точка значка — в угол квадрата вокруг аватара (см. Kotlin-оригинал).
        .offset(x: ringSize * 0.146, y: ringSize * 0.146)
    }

    private func deviceIcon(_ device: String) -> String {
        switch device {
        case "mobile": return "iphone"
        case "desktop": return "desktopcomputer"
        default: return "globe"
        }
    }
}
