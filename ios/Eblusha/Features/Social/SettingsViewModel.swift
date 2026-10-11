import Foundation
import Combine

/// Порт `feature/social/SettingsViewModel.kt`, переписанный под «Центр управления»
/// (Features/Settings). Запросы и порядок действий те же, что были; новое — только у вида:
///  - итог у СВОЕЙ строки (`msgs[id]`) вместо одной общей ошибки на весь экран;
///  - панель сохранения для имени и «О себе» (`saveStatus`, `isDirty`);
///  - вопрос «на месте» перед отключением сеанса и «Все другие» (`askRevokeID`,
///    `askRevokeOthers`) и защита «Все другие»: пока своего устройства в списке нет,
///    `POST /devices/revoke-others` отозвал бы ВСЕ устройства, включая сам телефон;
///  - сбой загрузки сеансов — состояние `sessionsFailed` (ebox «Повторить»), а не тишина.
/// Сеть — через узкий `SettingsProfileAPI`: боевой `ProfileRepository` и подмена в тестах и на
/// стенде без сети.

protocol SettingsProfileAPI {
    func me() async -> ApiResult<UserProfile>
    func updateProfile(displayName: String?, bio: String?, avatarUrl: String?) async -> ApiResult<UserProfile>
    func updateStatus(_ status: String) async -> ApiResult<UserProfile>
    func uploadAvatar(bytes: Data, mime: String) async -> ApiResult<String>
    func startDevicePairing() async -> ApiResult<DevicePairing>
    func listSessions() async -> ApiResult<[DeviceSession]>
    func revokeSession(deviceId: String) async -> ApiResult<Void>
    func revokeOtherSessions() async -> ApiResult<Void>
}

extension ProfileRepository: SettingsProfileAPI {}

@MainActor
final class SettingsViewModel: ObservableObject {

    enum SaveStatus: Equatable { case idle, saving, failed, saved }

    struct UiState {
        var profile: UserProfile?
        /// Первая загрузка профиля шла и не закончилась.
        var profileLoading = false
        var profileFailed = false
        var displayName = ""
        var bio = ""
        var saveStatus: SaveStatus = .idle
        var avatarBusy = false
        var pairing: DevicePairing?
        var pairingLoading = false
        var sessions: [DeviceSession] = []
        var sessionsLoading = false
        /// Список хотя бы раз загрузился.
        var sessionsLoaded = false
        var sessionsFailed = false
        /// id сеанса, у которого открыт вопрос «Отключить устройство?».
        var askRevokeID: String?
        var askRevokeOthers = false
    }

    @Published private(set) var ui = UiState()
    /// Итог у строки по её `id` из указателя поиска («p-status», «s-sess»…).
    @Published private(set) var msgs: [String: RowMessage] = [:]

    private let api: SettingsProfileAPI
    private var savedResetTask: Task<Void, Never>?
    /// Человек уже правил поля: свежий ответ сервера их не перезаписывает, даже если профиль на
    /// момент правки ещё не пришёл.
    private var draftTouched = false
    /// Сколько мс держим «Изменения сохранены.» — потом панель уходит (REF §8.1: 2,8 с).
    static let savedHold: Duration = .milliseconds(2800)

    init(api: SettingsProfileAPI) {
        self.api = api
    }

    // MARK: - Загрузка

    /// Перечитать профиль и сеансы: при каждом открытии центра (настройку могли поменять на
    /// другом устройстве).
    func refresh() {
        loadProfile()
        loadSessions()
    }

    func loadProfile() {
        guard !ui.profileLoading else { return }
        Task {
            ui.profileLoading = ui.profile == nil
            ui.profileFailed = false
            switch await api.me() {
            case .success(let profile):
                ui.profileLoading = false
                let hadDraft = draftTouched
                ui.profile = profile
                // Правку пользователя поверх свежего профиля не затираем.
                if !hadDraft {
                    ui.displayName = profile.displayName ?? ""
                    ui.bio = profile.bio ?? ""
                }
            case .failure:
                ui.profileLoading = false
                ui.profileFailed = ui.profile == nil
            }
        }
    }

    func loadSessions() {
        guard !ui.sessionsLoading else { return }
        Task {
            ui.sessionsLoading = true
            switch await api.listSessions() {
            case .success(let sessions):
                ui.sessionsLoading = false
                ui.sessions = sessions
                ui.sessionsLoaded = true
                ui.sessionsFailed = false
                // Вопрос про сеанс, которого уже нет, не оставляем висеть.
                if let id = ui.askRevokeID, !sessions.contains(where: { $0.id == id }) { ui.askRevokeID = nil }
            case .failure:
                ui.sessionsLoading = false
                ui.sessionsFailed = true
            }
        }
    }

    // MARK: - Итоги у строк

    func setMsg(_ id: String, _ message: RowMessage?) {
        if let message { msgs[id] = message } else { msgs.removeValue(forKey: id) }
    }

    // MARK: - Имя и «О себе»: панель сохранения

    private var baselineName: String { (ui.profile?.displayName ?? "").trimmed() }
    private var baselineBio: String { (ui.profile?.bio ?? "").trimmed() }

    var nameChanged: Bool { ui.profile != nil && ui.displayName.trimmed() != baselineName }
    var bioChanged: Bool { ui.profile != nil && ui.bio.trimmed() != baselineBio }
    var isDirty: Bool { nameChanged || bioChanged }

    var saveBarState: SaveBarState {
        switch ui.saveStatus {
        case .saving: return .saving
        case .failed: return isDirty ? .failed : .hidden
        case .saved: return .saved
        case .idle:
            return isDirty ? .dirty(detail: saveBarDetail(nameChanged: nameChanged, bioChanged: bioChanged)) : .hidden
        }
    }

    func onDisplayNameChange(_ value: String) {
        ui.displayName = value
        draftTouched = true
        touchDraft()
        if msgs["p-name"]?.kind == .err { setMsg("p-name", nil) }
    }

    func onBioChange(_ value: String) {
        ui.bio = value
        draftTouched = true
        touchDraft()
    }

    private func touchDraft() {
        if ui.saveStatus == .saved || ui.saveStatus == .failed {
            savedResetTask?.cancel()
            ui.saveStatus = .idle
        }
    }

    /// «Не сохранять»: вернуть поля к тому, что на сервере.
    func discardDraft() {
        savedResetTask?.cancel()
        draftTouched = false
        ui.displayName = ui.profile?.displayName ?? ""
        ui.bio = ui.profile?.bio ?? ""
        ui.saveStatus = .idle
        setMsg("p-name", nil)
    }

    /// Имя и «О себе» уходят одним запросом, как и раньше. Новое: пустое имя при имени на сервере
    /// не отправляется (сервер его не принимает — поле просто не уходило, и «Сохранено» врало),
    /// а «О себе», стёртое целиком, уходит пустой строкой — иначе его не стереть.
    /// `completion` — после ответа: true — сохранено.
    func save(completion: ((Bool) -> Void)? = nil) {
        guard ui.saveStatus != .saving, let profile = ui.profile else { completion?(false); return }
        let name = ui.displayName.trimmed()
        let bio = ui.bio.trimmed()
        if name.isEmpty && !baselineName.isEmpty {
            setMsg("p-name", .err("Введите отображаемое имя."))
            completion?(false)
            return
        }
        setMsg("p-name", nil)
        savedResetTask?.cancel()
        ui.saveStatus = .saving
        let clearsBio = bio.isEmpty && !baselineBio.isEmpty
        Task {
            let result = await api.updateProfile(
                displayName: name.isEmpty ? nil : name,
                bio: bio.isEmpty ? (clearsBio ? "" : nil) : bio,
                avatarUrl: profile.avatarUrl
            )
            switch result {
            case .success(let updated):
                ui.profile = updated
                ui.displayName = updated.displayName ?? ""
                ui.bio = updated.bio ?? ""
                draftTouched = false
                ui.saveStatus = .saved
                scheduleSavedReset()
                completion?(true)
            case .failure:
                ui.saveStatus = .failed
                completion?(false)
            }
        }
    }

    private func scheduleSavedReset() {
        savedResetTask?.cancel()
        savedResetTask = Task { [weak self] in
            try? await Task.sleep(for: Self.savedHold)
            guard !Task.isCancelled, let self else { return }
            if self.ui.saveStatus == .saved { self.ui.saveStatus = .idle }
        }
    }

    // MARK: - Фото

    /// Фото сохраняется сразу — как и раньше: загрузка, затем тот же `PATCH /status/me` с
    /// фото и текущими значениями полей.
    func uploadAvatar(bytes: Data, mime: String) {
        guard !ui.avatarBusy else { return }
        Task {
            ui.avatarBusy = true
            setMsg("p-photo", .busy("Загружаем фото…"))
            switch await api.uploadAvatar(bytes: bytes, mime: mime) {
            case .success(let url):
                let name = ui.displayName.trimmed()
                let bio = ui.bio.trimmed()
                switch await api.updateProfile(
                    displayName: name.isEmpty ? nil : name,
                    bio: bio.isEmpty ? nil : bio,
                    avatarUrl: url
                ) {
                case .success(let profile):
                    ui.profile = profile
                    // Поля, которые ушли вместе с фото, больше не «несохранённые».
                    if !name.isEmpty { ui.displayName = profile.displayName ?? ui.displayName }
                    if !bio.isEmpty { ui.bio = profile.bio ?? ui.bio }
                    draftTouched = isDirty
                    setMsg("p-photo", .ok("Фото сохранено."))
                case .failure:
                    setMsg("p-photo", .err("Не удалось сохранить фото. Попробуйте ещё раз."))
                }
            case .failure:
                setMsg("p-photo", .err("Не удалось загрузить фото. Попробуйте ещё раз."))
            }
            ui.avatarBusy = false
        }
    }

    // MARK: - Ручной статус

    /// Применяется сразу, без «Сохранить»; при сбое возвращается прежний.
    func setStatus(_ status: String) {
        guard let prev = ui.profile, prev.status?.uppercased() != status else { return }
        // Оптимистично — плитки-выбор не мигают.
        ui.profile = UserProfile(
            id: prev.id, username: prev.username, eblid: prev.eblid,
            displayName: prev.displayName, bio: prev.bio,
            avatarUrl: prev.avatarUrl, status: status
        )
        setMsg("p-status", nil)
        Task {
            switch await api.updateStatus(status) {
            case .success(let profile):
                // Ответ сервера несёт и имя с «О себе»: драфт полей не трогаем.
                ui.profile = UserProfile(
                    id: profile.id, username: profile.username, eblid: profile.eblid,
                    displayName: ui.profile?.displayName ?? profile.displayName,
                    bio: ui.profile?.bio ?? profile.bio,
                    avatarUrl: profile.avatarUrl, status: profile.status ?? status
                )
            case .failure:
                ui.profile = prev
                setMsg("p-status", .err("Не удалось сохранить настройку. Попробуйте ещё раз."))
            }
        }
    }

    // MARK: - Привязка

    func startPairing() {
        guard !ui.pairingLoading else { return }
        Task {
            ui.pairingLoading = true
            setMsg("s-link", nil)
            switch await api.startDevicePairing() {
            case .success(let pairing):
                ui.pairingLoading = false
                ui.pairing = pairing
            case .failure:
                ui.pairingLoading = false
                setMsg("s-link", .err("Не удалось создать код. Попробуйте ещё раз."))
            }
        }
    }

    func dismissPairing() {
        ui.pairing = nil
    }

    // MARK: - Сеансы

    var canRevokeOthers: Bool { SessionPresentation.canRevokeOthers(ui.sessions) }

    func askRevoke(_ session: DeviceSession) {
        guard !session.isCurrent else { return }
        ui.askRevokeID = session.id
        ui.askRevokeOthers = false
        setMsg("s-sess", nil)
    }

    func askRevokeAll() {
        guard canRevokeOthers else { return }
        ui.askRevokeOthers = true
        ui.askRevokeID = nil
        setMsg("s-sess", nil)
    }

    func cancelAsk() {
        ui.askRevokeID = nil
        ui.askRevokeOthers = false
    }

    func confirmRevoke() {
        guard let id = ui.askRevokeID,
              let session = ui.sessions.first(where: { $0.id == id }), !session.isCurrent else {
            cancelAsk()
            return
        }
        ui.askRevokeID = nil
        Task {
            switch await api.revokeSession(deviceId: id) {
            case .success:
                setMsg("s-sess", .ok("Устройство отключено"))
                loadSessions()
            case .failure:
                setMsg("s-sess", .err("Не удалось отключить устройство"))
            }
        }
    }

    func confirmRevokeAll() {
        // Состояние могло измениться, пока вопрос висел: без своего устройства в списке
        // revoke-others отозвал бы все устройства аккаунта, включая телефон.
        guard canRevokeOthers else {
            cancelAsk()
            return
        }
        ui.askRevokeOthers = false
        Task {
            switch await api.revokeOtherSessions() {
            case .success:
                setMsg("s-sess", .ok("Другие устройства отключены"))
                loadSessions()
            case .failure:
                setMsg("s-sess", .err("Не удалось отключить другие устройства. Попробуйте ещё раз."))
            }
        }
    }
}
