import SwiftUI
import PhotosUI
import UniformTypeIdentifiers // UTType.preferredMIMEType для mime выбранного фото

// Порт `ui/social/SettingsScreen.kt` в родной оболочке iOS: системная панель с крупным
// заголовком «Профиль» и `Form` на секциях — аватар с «ID: EBLID», профиль (имя, о себе),
// статус, источник (сервер), устройства (привязка + активные сеансы), выход. Своя шапка
// ушла: заголовок и кнопку «назад» даёт NavigationStack. Логика та же — SettingsViewModel,
// PhotosPicker для аватара, PairingDialog в sheet, подтверждение смены сервера через
// confirmationDialog. Пилюля версии внизу дублирует ту, что в строке профиля списка
// чатов: здесь она под рукой при разборе жалоб, там — на виду.

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

/// Цвет точки у выбранного статуса. «Не беспокоить» в общей шкале присутствия нет —
/// красный, как у веба; остальное совпадает с индикатором на аватарах.
private func manualStatusColor(_ status: String) -> Color {
    status == "DND" ? Eb.error : presenceColor(status)
}

struct SettingsView: View {
    var onBack: (() -> Void)?
    let onLogout: () -> Void

    @StateObject private var vm: SettingsViewModel
    @State private var avatarItem: PhotosPickerItem?
    /// Выбранный, но ещё не подтверждённый источник (нужен выход из аккаунта).
    @State private var pendingServer: AppConfig.Server?
    /// Режим автопроигрывания видео в ленте — СЫРОЙ строкой, ключом из InlineVideoPlayer:
    /// его же читает координатор автоплея. @AppStorage, а не своя обёртка над UserDefaults,
    /// ради перерисовки пикера: без наблюдения он остался бы с прежней галочкой.
    @AppStorage(VideoAutoplayMode.storageKey) private var videoAutoplayRaw = VideoAutoplayMode.wifi.rawValue

    init(onBack: (() -> Void)? = nil, onLogout: @escaping () -> Void) {
        self.onBack = onBack
        self.onLogout = onLogout
        _vm = StateObject(wrappedValue: SettingsViewModel(
            repo: AppContainer.shared.profileRepository
        ))
    }

    var body: some View {
        screen
            .navigationTitle("Профиль")
            .navigationBarTitleDisplayMode(.large)
            .sheet(item: pairingBinding) { pairing in
                PairingDialog(pairing: pairing, onDismiss: vm.dismissPairing)
            }
    }

    /// Свайп «назад» из любой точки — только когда экран пущен в стек (onBack задан).
    /// Без onBack возвращаться некуда, а глухой жест лишь перехватывал бы движения.
    @ViewBuilder
    private var screen: some View {
        if let onBack {
            content.edgeSwipeBack(onBack)
        } else {
            content
        }
    }

    private var content: some View {
        ZStack {
            Eb.paper.ignoresSafeArea()
            if vm.ui.loading {
                ProgressView()
            } else {
                form
            }
        }
    }

    /// vm.ui.pairing — private(set); закрытие sheet транслируем в dismissPairing().
    private var pairingBinding: Binding<DevicePairing?> {
        Binding(
            get: { vm.ui.pairing },
            set: { if $0 == nil { vm.dismissPairing() } }
        )
    }

    // MARK: - Форма

    private var form: some View {
        Form {
            avatarSection
            profileSection
            statusSection
            mediaSection
            serverSection
            devicesSection
            sessionsSection
            logoutSection
        }
        .scrollContentBackground(.hidden)
        .background(Eb.paper)
        .scrollDismissesKeyboard(.interactively)
        // Смена источника — смена мира (токены, устройство, ключи секреток), поэтому
        // только через явное подтверждение с выходом из аккаунта.
        .confirmationDialog(
            "Переключиться на \(pendingServer?.title ?? "")?",
            isPresented: Binding(get: { pendingServer != nil }, set: { if !$0 { pendingServer = nil } }),
            titleVisibility: .visible
        ) {
            Button("Переключиться и выйти", role: .destructive) {
                guard let target = pendingServer else { return }
                pendingServer = nil
                AppConfig.server = target
                onLogout()
            }
            Button("Отмена", role: .cancel) { pendingServer = nil }
        } message: {
            Text("Приложение выйдет из аккаунта и подключится к другому серверу.")
        }
    }

    // MARK: - Аватар и ID

    private var avatarSection: some View {
        Section {
            VStack(spacing: 6) {
                avatarBlock
                Text("Нажмите на фото, чтобы изменить")
                    .font(.caption2)
                    .foregroundStyle(Eb.textMuted)
                if let eblid = vm.ui.profile?.eblid {
                    Text("ID: \(eblid)")
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(Eb.brand)
                        .textSelection(.enabled)
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 8)
            // Аватар живёт прямо на фоне, без карточки — как шапка профиля в Настройках iOS.
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
        }
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
        // .plain — иначе List растянул бы зону нажатия на всю строку.
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

    // MARK: - Профиль (имя, о себе, сохранить)

    private var profileSection: some View {
        Section {
            TextField(
                "", text: displayNameBinding,
                prompt: Text("Отображаемое имя").foregroundStyle(Eb.textMuted)
            )
            .foregroundStyle(Eb.textPrimary)

            TextField(
                "", text: bioBinding,
                prompt: Text("О себе").foregroundStyle(Eb.textMuted),
                axis: .vertical
            )
            .lineLimit(3)
            .foregroundStyle(Eb.textPrimary)

            Button(action: vm.save) {
                Text(vm.ui.saved ? "Сохранено ✓" : "Сохранить")
                    .fontWeight(.semibold)
                    .frame(maxWidth: .infinity)
            }
            .disabled(vm.ui.saving)
        } header: {
            Text("Профиль")
        } footer: {
            // ui.error общий на все действия экрана (загрузка, сохранение, статус,
            // привязка) — показываем под профилем, где его чаще всего и ждут.
            if let error = vm.ui.error {
                Text(error)
                    .foregroundStyle(Eb.error)
            }
        }
        .ebRow()
    }

    private var displayNameBinding: Binding<String> {
        Binding(get: { vm.ui.displayName }, set: { vm.onDisplayNameChange($0) })
    }

    private var bioBinding: Binding<String> {
        Binding(get: { vm.ui.bio }, set: { vm.onBioChange($0) })
    }

    // MARK: - Статус

    private var statusSection: some View {
        Section("Статус") {
            Picker(selection: statusBinding) {
                ForEach(presenceStatuses, id: \.value) { option in
                    Text(option.label).tag(option.value)
                }
            } label: {
                HStack(spacing: 8) {
                    Circle()
                        .fill(manualStatusColor(currentStatus))
                        .frame(width: 10, height: 10)
                    Text("Показывать меня")
                        .foregroundStyle(Eb.textPrimary)
                }
            }
            .pickerStyle(.menu)
        }
        .ebRow()
    }

    /// Текущий ручной статус для пикера. Неизвестное значение сервера сводим к «В сети»,
    /// иначе Picker остался бы без выбранного пункта и ругался в консоль.
    private var currentStatus: String {
        let raw = vm.ui.profile?.status?.uppercased() ?? "ONLINE"
        return presenceStatuses.contains { $0.value == raw } ? raw : "ONLINE"
    }

    /// Выбор применяется сразу, без «Сохранить» (порт setStatus).
    private var statusBinding: Binding<String> {
        Binding(get: { currentStatus }, set: { vm.setStatus($0) })
    }

    // MARK: - Медиа

    /// Автопроигрывание коротких видео в ленте. Настройка одна и хранится строкой в
    /// UserDefaults: тот же ключ читает координатор автоплея напрямую на каждом решении
    /// (InlineVideoPlayer.swift), поэтому выбор применяется сразу, без перезахода в чат.
    private var mediaSection: some View {
        Section {
            Picker(selection: $videoAutoplayRaw) {
                ForEach(VideoAutoplayMode.allCases) { mode in
                    Text(mode.title).tag(mode.rawValue)
                }
            } label: {
                Text("Автовоспроизведение видео")
                    .foregroundStyle(Eb.textPrimary)
            }
            .pickerStyle(.menu)
        } header: {
            Text("Медиа")
        } footer: {
            Text("Короткие видео в переписке оживают сами — без звука и только пока плитка на экране. Звук и перемотка остаются в плеере по тапу.")
        }
        .ebRow()
    }

    // MARK: - Источник (основной сервер или зеркало)

    /// Выбор сервера прямо в приложении: одна сборка ходит и на eblusha.org, и на
    /// ru.eblusha.org. Смена — только через выход: токены, идентификатор устройства и
    /// ключи секретных чатов принадлежат конкретному серверу.
    private var serverSection: some View {
        Section {
            ForEach(AppConfig.Server.allCases) { option in
                Button {
                    if option != AppConfig.server { pendingServer = option }
                } label: {
                    HStack(spacing: 10) {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(option.title)
                                .foregroundStyle(Eb.textPrimary)
                            Text(option.subtitle)
                                .font(.caption)
                                .foregroundStyle(Eb.textMuted)
                        }
                        Spacer()
                        if option == AppConfig.server {
                            Image(systemName: "checkmark")
                                .font(.body.weight(.semibold))
                                .foregroundStyle(Eb.brand)
                        }
                    }
                }
            }
        } header: {
            Text("Источник")
        } footer: {
            Text("Смена источника выполняет выход из аккаунта: учётные записи на серверах разные.")
        }
        .ebRow()
    }

    // MARK: - Устройства (привязка нового)

    private var devicesSection: some View {
        Section("Устройства") {
            Button(action: vm.startPairing) {
                Label {
                    Text(vm.ui.pairingLoading ? "Создаём код…" : "Привязать новое устройство")
                } icon: {
                    Image(systemName: "qrcode")
                }
            }
            .disabled(vm.ui.pairingLoading)
        }
        .ebRow()
    }

    // MARK: - Активные сеансы (порт ActiveSessionsSection)

    private var sessionsSection: some View {
        Section("Активные сеансы") {
            if vm.ui.sessionsLoading && vm.ui.sessions.isEmpty {
                HStack {
                    Spacer()
                    ProgressView()
                        .controlSize(.small)
                    Spacer()
                }
            }
            ForEach(vm.ui.sessions) { session in
                sessionRow(session)
                    // Свайп дублирует крестик: на iOS так отключают строку привычнее.
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        if !session.isCurrent {
                            Button(role: .destructive) {
                                vm.revokeSession(session)
                            } label: {
                                Label("Отключить", systemImage: "xmark.circle")
                            }
                        }
                    }
            }
            if vm.ui.sessions.contains(where: { !$0.isCurrent }) {
                Button(role: .destructive, action: vm.revokeOtherSessions) {
                    Text("Отключить все")
                        .frame(maxWidth: .infinity)
                }
            }
        }
        .ebRow()
    }

    private func sessionRow(_ session: DeviceSession) -> some View {
        HStack(spacing: 10) {
            ZStack {
                RoundedRectangle(cornerRadius: 10).fill(Eb.surface200)
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
                // .borderless — иначе List сделал бы кнопкой всю строку сеанса.
                .buttonStyle(.borderless)
            }
        }
        .padding(.vertical, 4)
    }

    // MARK: - Выход и версия

    private var logoutSection: some View {
        Section {
            Button(role: .destructive, action: onLogout) {
                Text("Выйти из аккаунта")
                    .fontWeight(.semibold)
                    .frame(maxWidth: .infinity)
            }
        } footer: {
            // Пилюля версии — бывшая соседка строки профиля в списке чатов.
            Text(versionLabel)
                .font(.caption.weight(.semibold))
                .foregroundStyle(Eb.textMuted)
                .padding(.horizontal, 12)
                .padding(.vertical, 7)
                .background(Eb.surface300, in: Capsule())
                .overlay(Capsule().strokeBorder(Eb.borderStrong))
                .frame(maxWidth: .infinity)
                .padding(.top, 12)
        }
        .ebRow()
    }

    /// «v 1.0 · метка». Метка сборки рядом с версией: у отладочной — хеш коммита, у
    /// TestFlight — номер сборки. Иначе на телефоне их не отличить, обе показывают «1.0».
    private var versionLabel: String {
        let version = (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? "?"
        let buildTag = (Bundle.main.infoDictionary?["EblushaBuildTag"] as? String)?
            .trimmingCharacters(in: .whitespaces) ?? ""
        return buildTag.isEmpty ? "v \(version)" : "v \(version) · \(buildTag)"
    }
}

private extension View {
    /// Строки секций на фирменной поверхности `Eb.surface100` с разделителями `Eb.border`:
    /// форма остаётся системной, а цвета — наши, а не серые по умолчанию.
    func ebRow() -> some View {
        listRowBackground(Eb.surface100)
            .listRowSeparatorTint(Eb.border)
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
        .presentationDragIndicator(.visible)
    }
}
