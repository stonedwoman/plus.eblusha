import SwiftUI

/// Порт `ui/auth/RegisterScreen.kt`: двухшаговая регистрация — код приглашения → данные.
struct RegisterView: View {
    @ObservedObject var vm: AuthViewModel
    let onExit: () -> Void

    @State private var code = ""
    @State private var username = ""
    @State private var displayName = ""
    @State private var password = ""
    @State private var showPassword = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: Spacing.sm) {
                    Button(action: handleBack) {
                        Image(systemName: "chevron.backward")
                            .font(.title3)
                            .foregroundStyle(Eb.textPrimary)
                            .frame(width: 44, height: 44)
                    }
                    Text(vm.ui.registerStep == .inviteCode ? "Код приглашения" : "Новый аккаунт")
                        .font(.title2.weight(.semibold))
                        .foregroundStyle(Eb.textPrimary)
                }

                switch vm.ui.registerStep {
                case .inviteCode: inviteCodeStep
                case .details: detailsStep
                }
            }
            .padding(.horizontal, Spacing.xl)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(Eb.paper)
        .navigationBarBackButtonHidden(true)
    }

    private func handleBack() {
        if vm.ui.registerStep == .details {
            vm.backToInvite()
        } else {
            onExit()
        }
    }

    private var inviteCodeStep: some View {
        VStack(spacing: 0) {
            Text("Регистрация только по приглашению. Введите код, который вам дал друг.")
                .font(.subheadline)
                .foregroundStyle(Eb.textMuted)
                .multilineTextAlignment(.center)
                .padding(.top, Spacing.xl)

            AuthTextField("Код приглашения", text: $code, keyboard: .numberPad, onChange: vm.clearError)
                .padding(.top, Spacing.xl)

            errorText

            Button {
                vm.verifyInvite(code: code)
            } label: {
                AuthButtonLabel(loading: vm.ui.loading, title: "Далее")
            }
            .buttonStyle(EbPrimaryButtonStyle())
            .disabled(vm.ui.loading)
            .padding(.top, 20)
        }
    }

    private var detailsStep: some View {
        VStack(spacing: 0) {
            let inviterName = vm.ui.inviter?.displayName ?? vm.ui.inviter?.username
            if let inviterName {
                Text("Приглашает: \(inviterName)")
                    .font(.subheadline)
                    .foregroundStyle(Eb.brand)
                    .padding(.top, Spacing.lg)
            }

            AuthTextField("Логин", text: $username, onChange: vm.clearError)
                .padding(.top, Spacing.lg)
            AuthTextField("Отображаемое имя", text: $displayName, onChange: vm.clearError)
                .padding(.top, Spacing.md)
            AuthSecureField("Пароль", text: $password, showPassword: $showPassword, onChange: vm.clearError)
                .padding(.top, Spacing.md)

            errorText

            Button {
                vm.register(username: username, displayName: displayName, password: password)
            } label: {
                AuthButtonLabel(loading: vm.ui.loading, title: "Создать аккаунт")
            }
            .buttonStyle(EbPrimaryButtonStyle())
            .disabled(vm.ui.loading)
            .padding(.top, 20)
            .padding(.bottom, Spacing.xl)
        }
    }

    @ViewBuilder
    private var errorText: some View {
        if let error = vm.ui.error {
            Text(error)
                .font(.caption)
                .foregroundStyle(Eb.error)
                .frame(maxWidth: .infinity)
                .multilineTextAlignment(.center)
                .padding(.top, Spacing.md)
        }
    }
}
