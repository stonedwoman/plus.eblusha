import SwiftUI

/// Порт `ui/auth/LoginScreen.kt` — карточка входа с логотипом.
struct LoginView: View {
    @ObservedObject var vm: AuthViewModel
    let onNavigateRegister: () -> Void

    @State private var username = ""
    @State private var password = ""
    @State private var showPassword = false

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                Spacer(minLength: 48)
                EblushaWordmark()
                Text("Чаты со вкусом")
                    .font(.subheadline)
                    .foregroundStyle(Eb.textMuted)
                    .padding(.top, 6)

                VStack(alignment: .leading, spacing: 0) {
                    Text("Вход в аккаунт")
                        .font(.headline)
                        .foregroundStyle(Eb.textPrimary)

                    AuthTextField("Логин", text: $username, onChange: vm.clearError)
                        .textContentType(.username)
                        .padding(.top, Spacing.lg)

                    AuthSecureField(
                        "Пароль",
                        text: $password,
                        showPassword: $showPassword,
                        onChange: vm.clearError
                    )
                    .padding(.top, Spacing.md)

                    if let error = vm.ui.error {
                        Text(error)
                            .font(.caption)
                            .foregroundStyle(Eb.error)
                            .frame(maxWidth: .infinity)
                            .multilineTextAlignment(.center)
                            .padding(.top, Spacing.md)
                    }

                    Button {
                        vm.login(username: username, password: password)
                    } label: {
                        AuthButtonLabel(loading: vm.ui.loading, title: "Войти")
                    }
                    .buttonStyle(EbPrimaryButtonStyle())
                    .disabled(vm.ui.loading)
                    .padding(.top, 20)

                    Button("Регистрация по коду приглашения", action: onNavigateRegister)
                        .font(.subheadline)
                        .foregroundStyle(Eb.brand)
                        .frame(maxWidth: .infinity)
                        .disabled(vm.ui.loading)
                        .padding(.top, Spacing.md)
                }
                .padding(20)
                .background(Eb.surface200, in: RoundedRectangle(cornerRadius: 16))
                .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Eb.border))
                .padding(.top, 28)

                Spacer(minLength: 48)
            }
            .padding(.horizontal, Spacing.xl)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(Eb.paper)
    }
}

/// Логотип «Еблуша» — кремовые буквы с оранжевой «б», как в вебе.
struct EblushaWordmark: View {
    var body: some View {
        (Text("Е").foregroundColor(Eb.logoCream)
            + Text("б").foregroundColor(Eb.logoB)
            + Text("луша").foregroundColor(Eb.logoCream))
            .font(.system(size: 42, weight: .heavy))
    }
}

// MARK: - Общие элементы форм авторизации

struct AuthTextField: View {
    let label: String
    @Binding var text: String
    var keyboard: UIKeyboardType = .default
    let onChange: () -> Void

    init(
        _ label: String,
        text: Binding<String>,
        keyboard: UIKeyboardType = .default,
        onChange: @escaping () -> Void
    ) {
        self.label = label
        self._text = text
        self.keyboard = keyboard
        self.onChange = onChange
    }

    var body: some View {
        TextField("", text: $text, prompt: Text(label).foregroundStyle(Eb.textMuted))
            .keyboardType(keyboard)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .foregroundStyle(Eb.textPrimary)
            .padding(.horizontal, Spacing.lg)
            .frame(height: 52)
            .background(Eb.surface100, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Eb.border))
            .onChange(of: text) { onChange() }
    }
}

struct AuthSecureField: View {
    let label: String
    @Binding var text: String
    @Binding var showPassword: Bool
    let onChange: () -> Void

    init(
        _ label: String,
        text: Binding<String>,
        showPassword: Binding<Bool>,
        onChange: @escaping () -> Void
    ) {
        self.label = label
        self._text = text
        self._showPassword = showPassword
        self.onChange = onChange
    }

    var body: some View {
        HStack(spacing: Spacing.sm) {
            Group {
                if showPassword {
                    TextField("", text: $text, prompt: Text(label).foregroundStyle(Eb.textMuted))
                } else {
                    SecureField("", text: $text, prompt: Text(label).foregroundStyle(Eb.textMuted))
                }
            }
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .textContentType(.password)
            .foregroundStyle(Eb.textPrimary)

            Button {
                showPassword.toggle()
            } label: {
                Image(systemName: showPassword ? "eye.slash" : "eye")
                    .foregroundStyle(Eb.textMuted)
            }
        }
        .padding(.horizontal, Spacing.lg)
        .frame(height: 52)
        .background(Eb.surface100, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Eb.border))
        .onChange(of: text) { onChange() }
    }
}

struct AuthButtonLabel: View {
    let loading: Bool
    let title: String

    var body: some View {
        Group {
            if loading {
                ProgressView().tint(.white)
            } else {
                Text(title).fontWeight(.semibold)
            }
        }
        .frame(maxWidth: .infinity)
        .frame(height: 50)
    }
}

struct EbPrimaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(
                configuration.isPressed ? Eb.brand700 : Eb.brand,
                in: RoundedRectangle(cornerRadius: 12)
            )
            .foregroundStyle(.white)
    }
}

#Preview {
    LoginView(
        vm: AuthViewModel(repo: AppContainer.shared.authRepository),
        onNavigateRegister: {}
    )
}
