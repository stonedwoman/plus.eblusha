#if DEBUG
import SwiftUI

/// Стенд экрана установления звонка — iOS-двойник веб-стенда `/__dev/call-connecting`:
/// фиксированные состояния без настоящего звонка, для сверки внешнего вида. Существует
/// только в отладочной сборке и открывается аргументом запуска:
///
///     xcrun simctl launch <устройство> org.eblusha.plus -connectDemo cf-wait
///
/// Экран здесь ничем не управляет, «Отменить» ничего не делает.
struct CallConnectingDemo: View {
    let scenarioId: String

    /// Какой сценарий попросили аргументом запуска; nil — обычный запуск приложения.
    static var requestedScenario: String? {
        let args = ProcessInfo.processInfo.arguments
        guard let index = args.firstIndex(of: "-connectDemo"), index + 1 < args.count else { return nil }
        return args[index + 1]
    }

    var body: some View {
        CallConnectingView(view: buildConnectView(Self.signals(scenarioId)), leaving: false, onCancel: {})
            .preferredColorScheme(.dark)
    }

    private static let cloudflare = ConnectRoute(relayed: true, rttMs: 45, relayName: "Cloudflare", relayHost: "turn.cloudflare.com")
    private static let own = ConnectRoute(relayed: true, rttMs: 98, relayName: "Наш ретранслятор", relayHost: "ru.eblusha.org")
    private static let direct = ConnectRoute(relayed: false, rttMs: 32, relayName: nil, relayHost: nil)

    private static let base = ConnectSignals(
        isGroup: false, encrypted: true, muted: false,
        hasToken: false, keysReady: false, connected: false, e2eeEnabled: false, micPublished: false,
        routeSwitching: false, route: .empty,
        peer: ConnectPeer(presence: .absent, count: 0, name: "Катя", id: "demo-peer", avatarUrl: nil),
        error: nil, errorTitle: nil, micUnavailable: false
    )

    /// Сценарии — те же, что на веб-стенде (CallConnectingDemo.tsx), с теми же id.
    static func signals(_ id: String) -> ConnectSignals {
        var s = base
        let group = ConnectPeer(presence: .absent, count: 0, name: "Ереванский Городовой", id: "demo-group", avatarUrl: nil)
        switch id {
        case "keys":
            s.hasToken = true
        case "route":
            s.hasToken = true; s.keysReady = true
        case "cf-e2ee":
            s.hasToken = true; s.keysReady = true; s.connected = true; s.route = cloudflare
        case "cf-publish":
            s.hasToken = true; s.keysReady = true; s.connected = true; s.e2eeEnabled = true; s.route = cloudflare
        case "cf-wait":
            s.hasToken = true; s.keysReady = true; s.connected = true; s.e2eeEnabled = true
            s.micPublished = true; s.route = cloudflare
        case "cf-joining":
            s.hasToken = true; s.keysReady = true; s.connected = true; s.e2eeEnabled = true
            s.micPublished = true; s.route = cloudflare; s.peer.presence = .joining; s.peer.count = 1
        case "own":
            s.hasToken = true; s.keysReady = true; s.connected = true; s.e2eeEnabled = true; s.route = own
        case "direct":
            s.hasToken = true; s.keysReady = true; s.connected = true; s.e2eeEnabled = true
            s.micPublished = true; s.route = direct
        case "switch":
            s.hasToken = true; s.keysReady = true; s.routeSwitching = true
        case "group-empty":
            s.isGroup = true; s.encrypted = false; s.hasToken = true; s.connected = true
            s.route = cloudflare; s.peer = group
        case "group":
            s.isGroup = true; s.encrypted = false; s.hasToken = true; s.connected = true
            s.micPublished = true; s.route = cloudflare
            s.peer = group; s.peer.presence = .joining; s.peer.count = 3
        case "muted":
            s.hasToken = true; s.keysReady = true; s.connected = true; s.e2eeEnabled = true
            s.muted = true; s.route = cloudflare
        case "longname":
            s.hasToken = true; s.keysReady = true; s.connected = true; s.e2eeEnabled = true
            s.micPublished = true
            s.route = ConnectRoute(relayed: true, rttMs: 98, relayName: "Наш ретранслятор", relayHost: "very-long-relay-hostname.example-provider.net")
            s.peer = ConnectPeer(presence: .joining, count: 1, name: "Константин Константинопольский-Задунайский", id: "demo-long", avatarUrl: nil)
        case "mic-unavailable":
            s.isGroup = true; s.encrypted = false; s.hasToken = true; s.connected = true
            s.micUnavailable = true; s.route = cloudflare; s.peer = group
        case "connect-error":
            s.hasToken = true; s.keysReady = true
            s.error = "Не удалось соединиться с сервером звонков. Проверьте связь и попробуйте ещё раз."
            s.errorTitle = "Не удалось подключиться"
        case "sync":
            s.hasToken = true; s.keysReady = true; s.connected = true; s.e2eeEnabled = true
            s.micPublished = true; s.route = cloudflare; s.peer.presence = .settling; s.peer.count = 1
        case "error":
            s.hasToken = true; s.keysReady = true
            s.error = "Не удалось включить сквозное шифрование для этого звонка."
        case "done":
            s.hasToken = true; s.keysReady = true; s.connected = true; s.e2eeEnabled = true
            s.micPublished = true; s.route = cloudflare; s.peer.presence = .ready; s.peer.count = 1
        default:
            break // «signaling»: самое начало
        }
        return s
    }
}
#endif
