import Foundation
import Combine

/// Порт `feature/social/SettingsViewModel.kt`.
@MainActor
final class SettingsViewModel: ObservableObject {

    struct UiState {
        var loading = true
        var profile: UserProfile?
        var displayName = ""
        var bio = ""
        var saving = false
        var saved = false
        var error: String?
        var pairing: DevicePairing?
        var pairingLoading = false
        var sessions: [DeviceSession] = []
        var sessionsLoading = false
    }

    @Published private(set) var ui = UiState()

    private let repo: ProfileRepository

    init(repo: ProfileRepository) {
        self.repo = repo
        load()
        loadSessions()
    }

    func loadSessions() {
        Task {
            ui.sessionsLoading = true
            switch await repo.listSessions() {
            case .success(let sessions):
                ui.sessionsLoading = false
                ui.sessions = sessions
            case .failure:
                ui.sessionsLoading = false
            }
        }
    }

    func revokeSession(_ session: DeviceSession) {
        guard !session.isCurrent else { return }
        Task {
            if case .success = await repo.revokeSession(deviceId: session.id) {
                loadSessions()
            }
        }
    }

    func revokeOtherSessions() {
        Task {
            if case .success = await repo.revokeOtherSessions() {
                loadSessions()
            }
        }
    }

    func load() {
        Task {
            ui.loading = ui.profile == nil
            ui.error = nil
            switch await repo.me() {
            case .success(let profile):
                ui.loading = false
                ui.profile = profile
                ui.displayName = profile.displayName ?? ""
                ui.bio = profile.bio ?? ""
            case .failure(let message, _):
                ui.loading = false
                ui.error = message
            }
        }
    }

    /// Ручной статус (ONLINE/AWAY/DND/OFFLINE): применяется сразу, без кнопки «Сохранить».
    func setStatus(_ status: String) {
        let prev = ui.profile
        if let prev {
            // Оптимистично — пикер не мигает (порт profile.copy(status = status)).
            ui.profile = UserProfile(
                id: prev.id, username: prev.username, eblid: prev.eblid,
                displayName: prev.displayName, bio: prev.bio,
                avatarUrl: prev.avatarUrl, status: status
            )
        }
        Task {
            switch await repo.updateStatus(status) {
            case .success(let profile):
                ui.profile = profile
            case .failure(let message, _):
                ui.profile = prev
                ui.error = message
            }
        }
    }

    func onDisplayNameChange(_ value: String) {
        ui.displayName = value
        ui.saved = false
    }

    func onBioChange(_ value: String) {
        ui.bio = value
        ui.saved = false
    }

    func save() {
        guard !ui.saving else { return }
        Task {
            ui.saving = true
            ui.error = nil
            let name = ui.displayName.trimmed()
            let bio = ui.bio.trimmed()
            switch await repo.updateProfile(
                displayName: name.isEmpty ? nil : name,
                bio: bio.isEmpty ? nil : bio,
                avatarUrl: ui.profile?.avatarUrl
            ) {
            case .success(let profile):
                ui.saving = false
                ui.profile = profile
                ui.saved = true
            case .failure(let message, _):
                ui.saving = false
                ui.error = message
            }
        }
    }

    func uploadAvatar(bytes: Data, mime: String) {
        guard !ui.saving else { return }
        Task {
            ui.saving = true
            ui.error = nil
            switch await repo.uploadAvatar(bytes: bytes, mime: mime) {
            case .success(let url):
                let name = ui.displayName.trimmed()
                let bio = ui.bio.trimmed()
                switch await repo.updateProfile(
                    displayName: name.isEmpty ? nil : name,
                    bio: bio.isEmpty ? nil : bio,
                    avatarUrl: url
                ) {
                case .success(let profile):
                    ui.saving = false
                    ui.profile = profile
                    ui.saved = true
                case .failure(let message, _):
                    ui.saving = false
                    ui.error = message
                }
            case .failure(let message, _):
                ui.saving = false
                ui.error = message
            }
        }
    }

    func startPairing() {
        guard !ui.pairingLoading else { return }
        Task {
            ui.pairingLoading = true
            ui.error = nil
            switch await repo.startDevicePairing() {
            case .success(let pairing):
                ui.pairingLoading = false
                ui.pairing = pairing
            case .failure(let message, _):
                ui.pairingLoading = false
                ui.error = message
            }
        }
    }

    func dismissPairing() {
        ui.pairing = nil
    }
}
