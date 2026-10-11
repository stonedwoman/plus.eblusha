#if DEBUG
import SwiftUI

/// Стенд «Центра управления» без сети и без входа — только в отладке (аргумент `-connectDemo`),
/// как стенды звонка, «Без звука» и бота. Подставные данные: «Роман», EBLID 2498, четыре сеанса.
/// Запросы идут в `DemoSettingsAPI` (в памяти, мгновенно), система — `SystemPermissions(fixed)`.
///
///     -connectDemo settings                    обзор
///     -connectDemo settings-search             обзор, запрос «звук»
///     -connectDemo settings-searchnone         обзор, «ничего не нашлось»
///     -connectDemo settings-exit               обзор, вопрос о выходе
///     -connectDemo settings-leave              обзор, правка профиля и вопрос «Сохранить изменения?»
///     -connectDemo settings-profile[-edit|-savefail]
///     -connectDemo settings-conn
///     -connectDemo settings-av[-denied]
///     -connectDemo settings-security[-ask|-askall|-failed|-nocurrent|-pairing]
///     -connectDemo settings-app[-denied]
///     -connectDemo settings-flip               обзор с переворачивающейся «Б» (по умолчанию стоит)
///     -connectDemo settings-profile-ltime      раздел, прокрученный к строке (ltime / bot / sess / notif)
///     -connectDemo settings-motion             плашка с настройками доступности (Reduce Motion, размер шрифта)
///     -connectDemo settings-conn-qserver       раздел с подсветкой запроса (qserver / qmic / qsound)
///     -connectDemo settings-qbio               обзор, запрос «о себе» (qbio) или «статус» (qstatus): «О себе» и выбора статуса в настройках больше нет
struct SettingsDemo: View {
    enum Route: Hashable {
        case center
        case section(SettingsSectionID)
    }

    private let flags: Set<String>
    private let section: SettingsSectionID?
    @StateObject private var host: SettingsHostModel
    @Namespace private var zoom
    @State private var path: [Route]

    init(scenarioId: String) {
        let tokens = scenarioId.split(separator: "-").map(String.init).dropFirst()
        let section = tokens.compactMap { SettingsSectionID(rawValue: String($0)) }.first
        let flags = Set(tokens.filter { SettingsSectionID(rawValue: $0) == nil })
        self.flags = flags
        self.section = section

        AppConfig.server = .main
        SettingsWordmark.frozen = !flags.contains("flip")

        var perms = SystemPermissions(
            mic: .granted, cam: .granted,
            notifications: NotificationSummary(state: .granted, alert: true, sound: true, badge: true)
        )
        if flags.contains("denied") {
            perms = SystemPermissions(
                mic: .granted, cam: .denied,
                notifications: NotificationSummary(state: .denied, alert: false, sound: false, badge: false)
            )
        }
        Self.seedServices()
        let api = DemoSettingsAPI(failSessions: flags.contains("failed"), failSave: flags.contains("savefail"), noCurrent: flags.contains("nocurrent"))
        let model = SettingsHostModel(api: api, permissions: perms)
        // «ltime»/«bot»/«sess»/«notif» — раздел открывается прокрученным к этой строке.
        let anchors = ["ltime": "p-ltime", "bot": "p-bot", "sess": "s-sess", "notif": "ap-notif"]
        if let key = flags.first(where: { anchors[$0] != nil }) { model.nav.scrollTarget = anchors[key] }
        _host = StateObject(wrappedValue: model)
        _path = State(initialValue: section.map { [Route.center, Route.section($0)] } ?? [Route.center])
    }

    var body: some View {
        NavigationStack(path: $path) {
            Eb.paper
                .ignoresSafeArea()
                .toolbar(.hidden, for: .navigationBar)
                .navigationDestination(for: Route.self) { route in
                    switch route {
                    case .center:
                        SettingsCenterView(
                            host: host, zoom: zoom,
                            onOpenSection: { s, _ in path.append(.section(s)) },
                            onClose: { path.removeAll() }, onLogout: {},
                            demoAskExit: flags.contains("exit"), demoLeave: flags.contains("leave") ? .close : nil
                        )
                    case .section(let s):
                        SettingsSectionView(host: host, section: s, zoom: zoom, onLogout: {})
                    }
                }
        }
        .tint(Eb.brand)
        .preferredColorScheme(.dark)
        .overlay(alignment: .bottomTrailing) {
            // «-motion»: показать, видит ли приложение «Уменьшение движения» и крупный шрифт.
            if flags.contains("motion") { DemoAccessibilityBadge() }
        }
        .task { await apply() }
    }

    /// Сценарий поверх загруженного: правка полей, поиск, открытые вопросы.
    private func apply() async {
        host.refresh()
        let vm = host.vm
        // Холодный старт на симуляторе медленный: сценарий ложится поверх ЗАГРУЖЕННЫХ данных.
        for _ in 0..<40 where vm.ui.profile == nil || !(vm.ui.sessionsLoaded || vm.ui.sessionsFailed) {
            try? await Task.sleep(for: .milliseconds(100))
        }
        try? await Task.sleep(for: .milliseconds(300))
        if flags.contains("edit") || flags.contains("savefail") || flags.contains("leave") {
            vm.onDisplayNameChange("Роман К.")
        }
        if flags.contains("savefail") {
            try? await Task.sleep(for: .milliseconds(100))
            vm.save()
        }
        if flags.contains("search") { host.nav.query = "звук" }
        // Раздел с подсветкой найденного: запрос задан в обзоре.
        for (flag, word) in ["qserver": "сервер", "qmic": "микрофон", "qsound": "звук", "qbio": "о себе", "qstatus": "статус"] where flags.contains(flag) {
            host.nav.query = word
        }
        if flags.contains("searchnone") { host.nav.query = "ыыыы" }
        if flags.contains("ask"), let other = vm.ui.sessions.first(where: { !$0.isCurrent }) { vm.askRevoke(other) }
        if flags.contains("askall") { vm.askRevokeAll() }
        if flags.contains("pairing") { vm.startPairing() }
    }

    /// Местное время и «Чат с Еблушей» — как после ответа сервера.
    private static func seedServices() {
        LocalTimeService.shared.seedDemo(
            share: LocalTimeShareState(share: true, at: 1),
            visibleToPeers: LocalTimeInfo(timeZone: "Europe/Bucharest", city: "Бухарест", offsetMinutes: 180)
        )
        let json = #"{"bot":{"id":"demo-bot","displayName":"Еблуша","eblid":"7087","isBot":true},"botChat":{"botChatEnabled":true,"conversationId":"demo-bot-chat"}}"#
        if let response = try? JSONDecoder().decode(SystemBotResponse.self, from: Data(json.utf8)) {
            SystemBotStore.shared.apply(response)
        }
    }
}

/// Что видит приложение из настроек доступности (для проверки на симуляторе).
private struct DemoAccessibilityBadge: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        Text(verbatim: "reduceMotion=\(reduceMotion) type=\(String(describing: typeSize)) scheme=\(String(describing: scheme))")
            .font(.system(size: 10, design: .monospaced))
            .foregroundStyle(.white)
            .padding(4)
            .background(.black.opacity(0.7))
            .allowsHitTesting(false)
    }
}

/// «Сервер» в памяти: мгновенные ответы без сети.
final class DemoSettingsAPI: SettingsProfileAPI {
    private var profile = UserProfile(
        id: "demo-me", username: "roman", eblid: "2498", displayName: "Роман", avatarUrl: nil
    )
    private var sessions: [DeviceSession]
    private let failSessions: Bool
    private let failSave: Bool

    init(failSessions: Bool = false, failSave: Bool = false, noCurrent: Bool = false) {
        self.failSessions = failSessions
        self.failSave = failSave
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        func s(_ id: String, _ name: String, _ platform: String, ip: String, ago: Int64, keys: Bool = true, current: Bool = false) -> DeviceSession {
            DeviceSession(id: id, name: name, platform: platform, location: "Бухарест, Румыния", ip: ip,
                          lastSeenMs: now - ago, keysReady: keys, isCurrent: current && !noCurrent)
        }
        sessions = [
            s("d-ios", "iPhone", "ios", ip: "95.76.10.11", ago: 0, current: true),
            s("d-web", "Chrome · Windows", "web", ip: "95.76.10.14", ago: 3_600_000),
            s("d-and", "Pixel 8", "android", ip: "95.76.10.12", ago: 86_400_000, keys: false),
            s("d-pc1", "Еблуша для ПК", "windows", ip: "95.76.10.13", ago: 172_800_000),
            s("d-pc2", "Еблуша для ПК", "windows", ip: "95.76.10.13", ago: 259_200_000),
        ]
    }

    func me() async -> ApiResult<UserProfile> { .success(profile) }

    func updateProfile(displayName: String?, avatarUrl: String?) async -> ApiResult<UserProfile> {
        if failSave { return .failure(message: "Нет соединения с сервером") }
        profile = UserProfile(
            id: profile.id, username: profile.username, eblid: profile.eblid,
            displayName: displayName ?? profile.displayName,
            avatarUrl: avatarUrl ?? profile.avatarUrl
        )
        return .success(profile)
    }

    func uploadAvatar(bytes: Data, mime: String) async -> ApiResult<String> { .failure(message: "стенд") }

    func startDevicePairing() async -> ApiResult<DevicePairing> {
        .success(DevicePairing(token: "demo-token-0123456789abcdef0123456789abcdef", code: "7K3PQ2X9MA", expiresAt: nil))
    }

    func listSessions() async -> ApiResult<[DeviceSession]> {
        failSessions ? .failure(message: "Нет соединения с сервером") : .success(sessions)
    }

    func revokeSession(deviceId: String) async -> ApiResult<Void> {
        sessions.removeAll { $0.id == deviceId }
        return .success(())
    }

    func revokeOtherSessions() async -> ApiResult<Void> {
        sessions.removeAll { !$0.isCurrent }
        return .success(())
    }
}
#endif
