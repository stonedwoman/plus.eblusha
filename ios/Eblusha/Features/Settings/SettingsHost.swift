import AVFoundation
import Combine
import SwiftUI
import UIKit
import UserNotifications

// Связка «Центра управления» с остальным приложением: что читаем из системы (разрешения),
// что держим между экранами (запрос поиска, вспышка строки), сводка по разделам для плиток,
// диктора и поиска. Логика запросов — в SettingsViewModel; здесь только состояние вида.

// MARK: - Системные разрешения (только чтение)

/// Состояние разрешений на микрофон, камеру и уведомления. Перечитывается при открытии
/// экрана и при возврате в приложение (`scenePhase == .active`): человек мог поправить его
/// в системных настройках. Запросов разрешений отсюда НЕТ — они идут по месту, как и раньше.
@MainActor
final class SystemPermissions: ObservableObject {
    @Published private(set) var mic: PermissionState
    @Published private(set) var cam: PermissionState
    @Published private(set) var notifications: NotificationSummary?
    private let fixed: Bool

    init() {
        mic = Self.readMic()
        cam = Self.readCam()
        notifications = nil
        fixed = false
    }

    /// Неизменные значения: стенд без системы и тесты.
    init(mic: PermissionState, cam: PermissionState, notifications: NotificationSummary?) {
        self.mic = mic
        self.cam = cam
        self.notifications = notifications
        fixed = true
    }

    func refresh() {
        guard !fixed else { return }
        mic = Self.readMic()
        cam = Self.readCam()
        Task {
            let s = await UNUserNotificationCenter.current().notificationSettings()
            notifications = Self.summary(s)
        }
    }

    private static func readMic() -> PermissionState {
        switch AVAudioApplication.shared.recordPermission {
        case .granted: return .granted
        case .denied: return .denied
        default: return .notDetermined
        }
    }

    private static func readCam() -> PermissionState {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: return .granted
        case .notDetermined: return .notDetermined
        default: return .denied   // denied и restricted: включить из приложения нельзя
        }
    }

    private static func summary(_ s: UNNotificationSettings) -> NotificationSummary {
        let state: PermissionState
        switch s.authorizationStatus {
        case .authorized, .provisional, .ephemeral: state = .granted
        case .notDetermined: state = .notDetermined
        default: state = .denied
        }
        return NotificationSummary(
            state: state,
            alert: s.alertSetting == .enabled || s.notificationCenterSetting == .enabled,
            sound: s.soundSetting == .enabled,
            badge: s.badgeSetting == .enabled
        )
    }
}

/// Переход в системные настройки — единственное действие строк «+» над разрешениями.
enum SystemSettingsLink {
    static func openApp() { open(UIApplication.openSettingsURLString) }
    static func openNotifications() { open(UIApplication.openNotificationSettingsURLString) }

    private static func open(_ raw: String) {
        guard let url = URL(string: raw) else { return }
        UIApplication.shared.open(url)
    }
}

// MARK: - Состояние вида между экранами

/// Запрос поиска и прыжок к строке живут между обзором и разделом.
@MainActor
final class SettingsNavState: ObservableObject {
    @Published var query = ""
    /// Строка, к которой раздел прокрутит при появлении (после касания строки выдачи).
    @Published var scrollTarget: String?
    /// Строка со вспышкой 1,4 с.
    @Published var flashID: String?

    var isSearching: Bool { SettingsSearch.isActive(query) }
    var matched: [SettingsSearchRow] { SettingsSearch.match(query) }

    func searchEnv() -> SettingsSearchEnv {
        SettingsSearchEnv(
            query: isSearching ? query : "",
            matched: Set(matched.map(\.id)),
            flashID: flashID
        )
    }
}

/// Всё, что центр держит в руках: вью-модель, поиск, разрешения, местное время, бот. Наблюдается
/// целиком — любое изменение детей перерисовывает экран (экраны маленькие, дёшево).
@MainActor
final class SettingsHostModel: ObservableObject {
    let vm: SettingsViewModel
    let nav = SettingsNavState()
    let permissions: SystemPermissions
    let localTime: LocalTimeService
    let bot: SystemBotStore
    private var cancellables: [AnyCancellable] = []

    init(
        api: SettingsProfileAPI,
        permissions: SystemPermissions? = nil,
        localTime: LocalTimeService = .shared,
        bot: SystemBotStore = .shared
    ) {
        let permissions = permissions ?? SystemPermissions()
        vm = SettingsViewModel(api: api)
        self.permissions = permissions
        self.localTime = localTime
        self.bot = bot
        let relay: () -> Void = { [weak self] in self?.objectWillChange.send() }
        cancellables = [
            vm.objectWillChange.sink { _ in relay() },
            nav.objectWillChange.sink { _ in relay() },
            permissions.objectWillChange.sink { _ in relay() },
            localTime.objectWillChange.sink { _ in relay() },
            bot.objectWillChange.sink { _ in relay() },
        ]
    }

    /// Открытие центра: перечитать всё, что могло поменяться снаружи.
    func refresh() {
        vm.refresh()
        bot.load(force: true)
        localTime.loadOwn()
        permissions.refresh()
    }

    /// Центр закрыт совсем (вернулись к беседам): правка и запрос не переживают закрытие.
    func reset() {
        vm.discardDraft()
        vm.cancelAsk()
        nav.query = ""
        nav.scrollTarget = nil
        nav.flashID = nil
    }

    // MARK: Входы сводки

    var inputs: SettingsInputs {
        let profile = vm.ui.profile
        let sessions = vm.ui.sessions
        let current = sessions.first(where: { $0.isCurrent })
        return SettingsInputs(
            profileName: profile?.name,
            eblid: profile?.eblid,
            hasUnsaved: vm.isDirty || vm.ui.saveStatus == .failed,
            saveFailed: vm.ui.saveStatus == .failed,
            profileMessageIsError: profileHasError,
            server: AppConfig.server,
            mic: permissions.mic,
            cam: permissions.cam,
            sessionsCount: SessionPresentation.group(sessions).count,
            sessionsLoading: vm.ui.sessionsLoading && !vm.ui.sessionsLoaded,
            sessionsFailed: vm.ui.sessionsFailed && sessions.isEmpty,
            keysReady: current?.keysReady,
            autoplay: VideoAutoplayMode.current,
            soundIncoming: UserDefaults.standard.object(forKey: ChatSounds.incomingKey) as? Bool ?? true,
            soundOutgoing: UserDefaults.standard.object(forKey: ChatSounds.outgoingKey) as? Bool ?? true,
            notifications: permissions.notifications
        )
    }

    /// Ошибка местного времени или «Чата с Еблушей» красит плитку «Профиль» (SPEC §1.2).
    var profileHasError: Bool {
        if localTime.error != nil || (bot.isAvailable && bot.error != nil) { return true }
        return vm.msgs.values.contains { $0.kind == .err }
    }

    func summary(_ section: SettingsSectionID) -> SettingsSummary {
        SettingsSummary.make(section, inputs: inputs)
    }
}

// MARK: - Сводка по разделам

struct SettingsInputs: Equatable {
    var profileName: String?
    var eblid: String?
    var hasUnsaved = false
    var saveFailed = false
    var profileMessageIsError = false
    var server: AppConfig.Server = .main
    var mic: PermissionState = .notDetermined
    var cam: PermissionState = .notDetermined
    var sessionsCount = 0
    var sessionsLoading = false
    var sessionsFailed = false
    var keysReady: Bool?
    var autoplay: VideoAutoplayMode = .wifi
    var soundIncoming = true
    var soundOutgoing = true
    var notifications: NotificationSummary?
}

/// Строка состояния раздела: для имени плитки (диктор), заголовка списка и т. п. (SPEC §1.2).
struct SettingsSummary: Equatable {
    var state: String
    var attention: Bool
    var busy = false

    /// «{Раздел}: {состояние}[, требует внимания]» — имя плитки для диктора.
    func accessibilityName(_ section: SettingsSectionID) -> String {
        "\(section.title): \(state)" + (attention ? ", требует внимания" : "")
    }

    static func make(_ section: SettingsSectionID, inputs i: SettingsInputs) -> SettingsSummary {
        switch section {
        case .profile:
            if i.hasUnsaved { return .init(state: "Есть несохранённое", attention: i.saveFailed || i.profileMessageIsError, busy: !i.saveFailed) }
            let name = i.profileName ?? "—"
            return .init(state: "\(name) · EBLID \(i.eblid ?? "— — — —")", attention: i.profileMessageIsError)
        case .conn:
            return .init(state: "\(i.server.routeTitle) · \(i.server.title)", attention: false)
        case .av:
            let av = PermissionText.avState(mic: i.mic, cam: i.cam)
            return .init(state: av.text, attention: av.isError)
        case .security:
            if i.sessionsLoading { return .init(state: "Загружаем…", attention: false, busy: true) }
            if i.sessionsFailed { return .init(state: "Список не загрузился", attention: true) }
            return .init(state: SettingsText.devicesCount(i.sessionsCount), attention: false)
        case .app:
            let video: String
            switch i.autoplay {
            case .never: video = "Видео: не играть"
            case .wifi: video = "Видео: только Wi-Fi"
            case .always: video = "Видео: всегда"
            }
            let notifOff = i.notifications.map { $0.state == .denied || ($0.state == .granted && !$0.isOn) } ?? false
            if notifOff { return .init(state: "Уведомления выключены", attention: true) }
            return .init(state: video, attention: false)
        }
    }

    static func soundsLine(incoming: Bool, outgoing: Bool) -> String {
        switch (incoming, outgoing) {
        case (true, true): return "Звуки включены"
        case (false, false): return "Звуки выключены"
        default: return "Звуки: частично"
        }
    }

    static func videoLine(_ mode: VideoAutoplayMode) -> String {
        switch mode {
        case .never: return "Видео: никогда"
        case .wifi: return "Видео: по Wi-Fi"
        case .always: return "Видео: всегда"
        }
    }

    static func notificationsLine(_ n: NotificationSummary?) -> (text: String, isError: Bool) {
        guard let n else { return ("Уведомления…", false) }
        switch n.state {
        case .granted: return n.isOn ? ("Уведомления: да", false) : ("Уведомления: нет", true)
        case .notDetermined: return ("Уведомления: спросим", false)
        case .denied: return ("Уведомления: нет", true)
        }
    }
}
