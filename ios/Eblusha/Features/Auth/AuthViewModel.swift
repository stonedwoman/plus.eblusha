import Foundation
import Combine

/// Порт `feature/auth/AuthViewModel.kt` — та же машина состояний входа/регистрации.
@MainActor
final class AuthViewModel: ObservableObject {

    enum RegisterStep {
        case inviteCode
        case details
    }

    struct UiState {
        var loading = false
        var error: String?
        var registerStep: RegisterStep = .inviteCode
        var inviteToken: String?
        var inviter: Inviter?
    }

    @Published private(set) var ui = UiState()

    private let repo: AuthRepository

    init(repo: AuthRepository) {
        self.repo = repo
    }

    func clearError() {
        if ui.error != nil { ui.error = nil }
    }

    func login(username: String, password: String) {
        guard !username.trimmed().isEmpty, !password.isEmpty else {
            ui.error = "Введите логин и пароль"
            return
        }
        Task {
            ui.loading = true
            ui.error = nil
            switch await repo.login(username: username, password: password) {
            case .failure(let message, _):
                ui.loading = false
                ui.error = message
            case .success:
                ui.loading = false // сессия переключилась — RootView сам сменит экран
            }
        }
    }

    func verifyInvite(code: String) {
        guard !code.trimmed().isEmpty else {
            ui.error = "Введите код приглашения"
            return
        }
        Task {
            ui.loading = true
            ui.error = nil
            switch await repo.verifyInvite(code: code) {
            case .failure(let message, _):
                ui.loading = false
                ui.error = message
            case .success(let response):
                ui.loading = false
                ui.registerStep = .details
                ui.inviteToken = response.registrationInviteToken
                ui.inviter = response.inviter
            }
        }
    }

    func register(username: String, displayName: String, password: String) {
        guard let token = ui.inviteToken else {
            ui.error = "Сначала подтвердите код приглашения"
            ui.registerStep = .inviteCode
            return
        }
        if username.trimmed().count < 3 { ui.error = "Логин минимум 3 символа"; return }
        if displayName.trimmed().count < 2 { ui.error = "Имя минимум 2 символа"; return }
        if password.count < 6 { ui.error = "Пароль минимум 6 символов"; return }
        Task {
            ui.loading = true
            ui.error = nil
            switch await repo.register(
                username: username, displayName: displayName,
                password: password, inviteToken: token
            ) {
            case .failure(let message, _):
                ui.loading = false
                ui.error = message
            case .success:
                ui.loading = false
            }
        }
    }

    func backToInvite() {
        ui.registerStep = .inviteCode
        ui.error = nil
    }

    func resetRegister() {
        ui = UiState()
    }
}
