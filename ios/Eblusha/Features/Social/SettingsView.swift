import SwiftUI
import PhotosUI
import UniformTypeIdentifiers // UTType.preferredMIMEType для mime выбранного фото

// Порт `ui/social/SettingsScreen.kt`: профиль (аватар, имя, био), селектор статуса,
// «ID: EBLID», привязка нового устройства (QR + код), активные сеансы, выход.

/// Для sheet(item:): пара короткоживущая, токен уникален на показ.
extension DevicePairing: Identifiable {
    var id: String { token }
}

/// Статус присутствия (веб-паритет: селектор в настройках). Применяется сразу.
private struct PresenceOption {
    let value: String
    let label: String
}

private let presenceStatuses: [PresenceOption] = [
    PresenceOption(value: "ONLINE", label: "В сети"),
    PresenceOption(value: "AWAY", label: "Отошёл"),
    PresenceOption(value: "DND", label: "Не беспокоить"),
    PresenceOption(value: "OFFLINE", label: "Невидимка"),
]

struct SettingsView: View {
    var onBack: (() -> Void)?
    let onLogout: () -> Void

    @StateObject private var vm: SettingsViewModel
    @State private var avatarItem: PhotosPickerItem?

    init(onBack: (() -> Void)? = nil, onLogout: @escaping () -> Void) {
        self.onBack = onBack
        self.onLogout = onLogout
        _vm = StateObject(wrappedValue: SettingsViewModel(
            repo: AppContainer.shared.profileRepository
        ))
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider().overlay(Eb.border)
            if vm.ui.loading {
                Spacer()
                ProgressView()
                Spacer()
            } else {
                content
            }
        }
        .background(Eb.paper)
        .toolbar(.hidden, for: .navigationBar)
        .sheet(item: pairingBinding) { pairing in
            PairingDialog(pairing: pairing, onDismiss: vm.dismissPairing)
        }
    }

    /// vm.ui.pairing — private(set); закрытие sheet транслируем в dismissPairing().
    private var pairingBinding: Binding<DevicePairing?> {
        Binding(
            get: { vm.ui.pairing },
            set: { if $0 == nil { vm.dismissPairing() } }
        )
    }

    // MARK: - Шапка (порт TopAppBar: назад / «Профиль» / выйти)

    private var header: some View {
        HStack(spacing: 10) {
            if let onBack {
                Button(action: onBack) {
                    Image(systemName: "chevron.backward")
                        .font(.title3)
                        .foregroundStyle(Eb.textPrimary)
                        .frame(width: 40, height: 40)
                }
            }
            Text("Профиль")
                .font(.body.weight(.semibold))
                .foregroundStyle(Eb.textPrimary)
            Spacer()
            Button(action: onLogout) {
                Image(systemName: "rectangle.portrait.and.arrow.right")
                    .foregroundStyle(Eb.error)
                    .frame(width: 40, height: 40)
            }
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 4)
        .background(Eb.surface200)
    }

    // MARK: - Содержимое

    private var content: some View {
        ScrollView {
            VStack(spacing: 0) {
                avatarBlock
                Text("Нажмите на фото, чтобы изменить")
                    .font(.caption2)
                    .foregroundStyle(Eb.textMuted)
                    .padding(.top, 6)
                if let eblid = vm.ui.profile?.eblid {
                    Text("ID: \(eblid)")
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(Eb.brand)
                        .padding(.top, 4)
                }

                statusRow
                    .padding(.top, 14)

                TextField(
                    "", text: displayNameBinding,
                    prompt: Text("Отображаемое имя").foregroundStyle(Eb.textMuted)
                )
                .foregroundStyle(Eb.textPrimary)
                .padding(12)
                .background(Eb.surface100, in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Eb.border))
                .padding(.top, 20)

                TextField(
                    "", text: bioBinding,
                    prompt: Text("О себе").foregroundStyle(Eb.textMuted),
                    axis: .vertical
                )
                .lineLimit(3)
                .foregroundStyle(Eb.textPrimary)
                .padding(12)
                .background(Eb.surface100, in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Eb.border))
                .padding(.top, 12)

                Button(action: vm.save) {
                    Text(vm.ui.saved ? "Сохранено ✓" : "Сохранить")
                        .fontWeight(.semibold)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 6)
                }
                .buttonStyle(.borderedProminent)
                .tint(Eb.brand)
                .disabled(vm.ui.saving)
                .padding(.top, 16)

                if let error = vm.ui.error {
                    Text(error)
                        .foregroundStyle(Eb.error)
                        .multilineTextAlignment(.center)
                        .padding(.top, 8)
                }

                Button(action: vm.startPairing) {
                    Text(vm.ui.pairingLoading ? "Создаём код…" : "Привязать новое устройство")
                        .fontWeight(.medium)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 6)
                }
                .buttonStyle(.bordered)
                .tint(Eb.brand)
                .disabled(vm.ui.pairingLoading)
                .padding(.top, 28)

                sessionsSection
                    .padding(.top, 24)
            }
            .padding(.horizontal, 24)
            .padding(.top, 16)
            .padding(.bottom, 32)
        }
        .scrollDismissesKeyboard(.interactively)
    }

    /// Аватар — он же пикер новой фотографии (порт pickAvatar.launch("image/*")).
    private var avatarBlock: some View {
        PhotosPicker(selection: $avatarItem, matching: .images) {
            ZStack {
                AvatarView(
                    name: vm.ui.profile?.name ?? "?",
                    avatarUrl: vm.ui.profile?.avatarUrl,
                    size: 110
                )
                if vm.ui.saving { ProgressView() }
            }
        }
        .buttonStyle(.plain)
        .onChange(of: avatarItem) { _, item in
            guard let item else { return }
            avatarItem = nil
            Task {
                // Порт readImageBytes: байты + mime выбранной картинки; тип неизвестен —
                // считаем JPEG (как `resolver.getType(uri) ?: "image/jpeg"` в эталоне).
                guard let bytes = try? await item.loadTransferable(type: Data.self) else { return }
                let mime = item.supportedContentTypes
                    .compactMap(\.preferredMIMEType)
                    .first { $0.hasPrefix("image/") } ?? "image/jpeg"
                vm.uploadAvatar(bytes: bytes, mime: mime)
            }
        }
    }

    private var statusRow: some View {
        let current = vm.ui.profile?.status?.uppercased() ?? "ONLINE"
        return HStack(spacing: 6) {
            ForEach(presenceStatuses, id: \.value) { status in
                let selected = current == status.value
                Text(status.label)
                    .font(.system(size: 11))
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
                    .foregroundStyle(selected ? .white : Eb.textPrimary)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
                    .background(
                        selected ? Eb.brand : Eb.surface200,
                        in: RoundedRectangle(cornerRadius: 10)
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: 10)
                            .strokeBorder(selected ? Eb.brand : Eb.borderStrong)
                    )
                    .contentShape(Rectangle())
                    .onTapGesture { vm.setStatus(status.value) }
            }
        }
    }

    private var displayNameBinding: Binding<String> {
        Binding(get: { vm.ui.displayName }, set: { vm.onDisplayNameChange($0) })
    }

    private var bioBinding: Binding<String> {
        Binding(get: { vm.ui.bio }, set: { vm.onBioChange($0) })
    }

    // MARK: - Активные сеансы (порт ActiveSessionsSection)

    private var sessionsSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Активные сеансы")
                    .font(.headline)
                    .foregroundStyle(Eb.textPrimary)
                Spacer()
                if vm.ui.sessions.contains(where: { !$0.isCurrent }) {
                    Button(action: vm.revokeOtherSessions) {
                        Text("Отключить все")
                            .font(.subheadline)
                            .foregroundStyle(Eb.error)
                    }
                }
            }
            if vm.ui.sessionsLoading && vm.ui.sessions.isEmpty {
                ProgressView()
                    .controlSize(.small)
            }
            ForEach(vm.ui.sessions) { session in
                sessionRow(session)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func sessionRow(_ session: DeviceSession) -> some View {
        HStack(spacing: 10) {
            ZStack {
                RoundedRectangle(cornerRadius: 10).fill(Eb.surface100)
                Image(systemName: "desktopcomputer")
                    .font(.system(size: 16))
                    .foregroundStyle(Eb.textMuted)
            }
            .frame(width: 38, height: 38)

            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(session.name)
                        .fontWeight(.semibold)
                        .foregroundStyle(Eb.textPrimary)
                        .lineLimit(1)
                    if session.isCurrent {
                        Text("Это устройство")
                            .font(.caption2)
                            .foregroundStyle(Eb.online)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 1)
                            .background(
                                Eb.online.opacity(0.18),
                                in: RoundedRectangle(cornerRadius: 8)
                            )
                    }
                }
                let meta = [session.platform, session.location, session.ip]
                    .compactMap { $0 }
                    .filter { !$0.isEmpty }
                    .joined(separator: " • ")
                if !meta.isEmpty {
                    Text(meta)
                        .font(.caption2)
                        .foregroundStyle(Eb.textMuted)
                        .lineLimit(1)
                }
                HStack(spacing: 8) {
                    if session.keysReady {
                        Text("Ключи готовы")
                            .font(.caption2)
                            .foregroundStyle(Eb.online)
                    }
                    if let lastSeen = session.lastSeenMs {
                        Text(formatSessionTime(lastSeen))
                            .font(.caption2)
                            .foregroundStyle(Eb.textMuted)
                    }
                }
            }
            Spacer(minLength: 0)
            if !session.isCurrent {
                Button {
                    vm.revokeSession(session)
                } label: {
                    Image(systemName: "xmark")
                        .foregroundStyle(Eb.error)
                        .frame(width: 32, height: 32)
                }
            }
        }
        .padding(12)
        .background(Eb.surface200, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Eb.borderStrong))
    }
}

/// Порт formatSessionTime: «дд.ММ.гггг, ЧЧ:мм».
private func formatSessionTime(_ millis: Int64) -> String {
    let formatter = DateFormatter()
    formatter.dateFormat = "dd.MM.yyyy, HH:mm"
    return formatter.string(from: Date(timeIntervalSince1970: Double(millis) / 1000))
}

// MARK: - Диалог привязки устройства (порт PairingDialog)

private struct PairingDialog: View {
    let pairing: DevicePairing
    let onDismiss: () -> Void
    /// remember(pairing.token) из эталона: QR считается один раз на показ диалога.
    private let qr: UIImage?

    init(pairing: DevicePairing, onDismiss: @escaping () -> Void) {
        self.pairing = pairing
        self.onDismiss = onDismiss
        self.qr = generateQrImage(pairing.qrPayload)
    }

    var body: some View {
        VStack(spacing: 0) {
            Text("Привязка устройства")
                .font(.title3.weight(.semibold))
                .foregroundStyle(Eb.textPrimary)
                .padding(.top, 24)
            Text("Отсканируйте этот QR-код на новом устройстве, чтобы привязать его к аккаунту.")
                .font(.subheadline)
                .foregroundStyle(Eb.textMuted)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 24)
                .padding(.top, 12)
            if let qr {
                Image(uiImage: qr)
                    .interpolation(.none) // модули QR должны остаться резкими
                    .resizable()
                    .scaledToFit()
                    .frame(width: 220, height: 220)
                    .padding(10)
                    .background(.white, in: RoundedRectangle(cornerRadius: 12))
                    .padding(.top, 16)
            } else {
                Text("Не удалось создать QR-код")
                    .foregroundStyle(Eb.error)
                    .padding(.top, 16)
            }
            if let code = pairing.code {
                Text("Или введите код:")
                    .font(.footnote)
                    .foregroundStyle(Eb.textMuted)
                    .padding(.top, 12)
                Text(code)
                    .font(.title2.weight(.bold))
                    .foregroundStyle(Eb.brand)
                    .padding(.top, 2)
            }
            Button(action: onDismiss) {
                Text("Готово")
                    .fontWeight(.semibold)
                    .padding(.horizontal, 24)
            }
            .buttonStyle(.borderedProminent)
            .tint(Eb.brand)
            .padding(.top, 20)
            Spacer()
        }
        .frame(maxWidth: .infinity)
        .background(Eb.surface200)
        .presentationDetents([.medium, .large])
    }
}
