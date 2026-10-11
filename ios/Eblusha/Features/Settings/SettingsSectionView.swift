import PhotosUI
import SwiftUI
import UniformTypeIdentifiers // UTType.preferredMIMEType для mime выбранного фото

// Экран раздела «Центра управления» (SPEC §2.3, §1.3): голова (квадрат 40, заголовок 22/28,
// подзаголовок 13.5), группы, карточки, строки единого вида. Содержимое — те же настройки, что
// были на одном длинном экране «Профиль» (SettingsView): код действий перенесён, а не написан
// заново. Раздел раскрывается из плитки: `.navigationTransition(.zoom)`; «назад» — системное.

struct SettingsSectionView: View {
    @ObservedObject var host: SettingsHostModel
    let section: SettingsSectionID
    var zoom: Namespace.ID
    var onLogout: () -> Void

    @State private var avatarItem: PhotosPickerItem?
    @State private var pendingServer: AppConfig.Server?
    @State private var copied = false
    @AppStorage(VideoAutoplayMode.storageKey) private var videoAutoplayRaw = VideoAutoplayMode.wifi.rawValue
    @AppStorage(ChatSounds.incomingKey) private var soundIncoming = true
    @AppStorage(ChatSounds.outgoingKey) private var soundOutgoing = true
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase

    private var vm: SettingsViewModel { host.vm }
    private var nav: SettingsNavState { host.nav }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 0, pinnedViews: [.sectionHeaders]) {
                    Section {
                        VStack(alignment: .leading, spacing: 0) {
                            EbSectionHead(section: section)
                                .padding(.top, 16)
                            content
                        }
                        .padding(.horizontal, 16)
                        .padding(.bottom, 32)
                    } header: {
                        searchPill
                    }
                }
            }
            .scrollDismissesKeyboard(.interactively)
            .task { await jumpToTarget(proxy) }
        }
        .background(Eb.paper.ignoresSafeArea())
        .settingsHeaderChrome()
        .toolbar {
            ToolbarItem(placement: .principal) {
                Text(section.title)
                    .ebFont(17, .semibold)
                    .foregroundStyle(Eb.textPrimary)
                    .accessibilityAddTraits(.isHeader)
            }
        }
        .toolbarTitleDisplayMode(.inline)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if section == .profile {
                EbSaveBar(state: vm.saveBarState, onDiscard: { vm.discardDraft() }, onSave: { vm.save() })
                    .animation(reduceMotion ? nil : .easeOut(duration: 0.25), value: vm.saveBarState)
            }
        }
        .sheet(item: pairingBinding) { pairing in
            PairingSheet(pairing: pairing, onDismiss: vm.dismissPairing)
        }
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
        .environment(\.settingsSearch, nav.searchEnv())
        .onAppear { host.permissions.refresh() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { host.permissions.refresh() }
        }
        .modifier(SectionZoomTransition(section: section, zoom: zoom))
    }

    // MARK: Поиск в разделе

    /// Плашка «🔍 «звонк» · 2 совпадения ✕» над разделом, пока в обзоре задан запрос.
    @ViewBuilder
    private var searchPill: some View {
        if nav.isSearching {
            let n = nav.matched.filter { $0.section == section }.count
            HStack(spacing: 8) {
                EbIcon(name: "magnifyingglass", size: 13)
                Text("«\(nav.query.trimmed())» · \(n == 0 ? "нет совпадений" : SettingsText.matches(n))")
                    .ebFont(13, .semibold)
                    .foregroundStyle(Eb.logoCream)
                    .lineLimit(1)
                Spacer(minLength: 0)
                Button { nav.query = "" } label: {
                    Image(systemName: "xmark").font(.system(size: 11, weight: .bold)).foregroundStyle(Eb.textMuted)
                        .frame(width: 24, height: 24)
                        .contentShape(.interaction, Rectangle().inset(by: -10))
                }
                .accessibilityLabel("Сбросить поиск")
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
            .background(Capsule().fill(Eb.surface100))
            .overlay(Capsule().strokeBorder(Eb.brand600, lineWidth: 1))
            .padding(.horizontal, 16)
            .padding(.top, 8).padding(.bottom, 4)
            .background(Eb.paper)
        }
    }

    /// Прыжок к строке из выдачи поиска: прокрутка с запасом сверху и вспышка 1,4 с.
    private func jumpToTarget(_ proxy: ScrollViewProxy) async {
        guard let target = nav.scrollTarget else { return }
        try? await Task.sleep(for: .milliseconds(360))
        withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.3)) {
            proxy.scrollTo("row-" + target, anchor: UnitPoint(x: 0.5, y: 0.18))
        }
        nav.scrollTarget = nil
        nav.flashID = target
        try? await Task.sleep(for: .milliseconds(80))
        nav.flashID = nil
    }

    // MARK: Содержимое

    @ViewBuilder
    private var content: some View {
        switch section {
        case .profile: profileContent
        case .conn: connectionContent
        case .av: avContent
        case .security: securityContent
        case .app: appContent
        }
    }

    private func group<Body: View>(
        _ symbol: String, _ title: String, mark: String? = nil, caption: String? = nil, top: CGFloat = 20,
        @ViewBuilder body: () -> Body
    ) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            EbGroupHeader(symbol: symbol, title: title, mark: mark)
            if let caption { EbGroupCaption(text: caption) }
            body()
        }
        .padding(.top, top)
    }

    // MARK: ① Профиль

    private var profileContent: some View {
        VStack(alignment: .leading, spacing: 0) {
            if vm.ui.profileFailed {
                EbEbox(text: "Не удалось загрузить профиль.", onRetry: { vm.loadProfile() })
                    .padding(.top, 16)
            }
            EbCard {
                photoRow
                nameRow
                eblidRow
            }
            .padding(.top, 16)
            group("clock", "Местное время") {
                EbCard { localTimeRow }
            }
            if host.bot.isAvailable {
                group("bubble.left", "Бот «Еблуша»") {
                    EbCard { botRow }
                }
            }
        }
    }

    private var photoRow: some View {
        let profile = vm.ui.profile
        let name = profile?.name ?? "?"
        let busy = vm.ui.avatarBusy
        return EbRow(id: "p-photo") {
            VStack(alignment: .leading, spacing: 0) {
                EbRowText(title: "Фото профиля", desc: "В круг попадёт центральная часть фото.", desc2: "Новое фото сохраняется сразу.")
                HStack(spacing: 14) {
                    // Тап по самому фото, как и раньше, тоже открывает выбор (для VoiceOver — кнопка рядом).
                    PhotosPicker(selection: $avatarItem, matching: .images) {
                        ZStack {
                            AvatarView(name: name, avatarUrl: profile?.avatarUrl, size: 56)
                            if busy { ProgressView().tint(.white) }
                        }
                    }
                    .buttonStyle(.plain)
                    .disabled(busy)
                    .accessibilityHidden(true)
                    PhotosPicker(selection: $avatarItem, matching: .images) {
                        EbPillLabel(title: profile?.avatarUrl == nil ? "Добавить фото" : "Заменить фото", symbol: "photo")
                    }
                    .buttonStyle(.plain)
                    .disabled(vm.ui.avatarBusy)
                    .onChange(of: avatarItem) { _, item in
                        guard let item else { return }
                        avatarItem = nil
                        Task {
                            // Порт readImageBytes: байты + mime выбранной картинки; тип неизвестен —
                            // считаем JPEG (как `resolver.getType(uri) ?: "image/jpeg"` в эталоне).
                            guard let bytes = try? await item.loadTransferable(type: Data.self) else {
                                vm.setMsg("p-photo", .err("Не удалось открыть картинку. Выберите другую."))
                                return
                            }
                            let mime = item.supportedContentTypes
                                .compactMap(\.preferredMIMEType)
                                .first { $0.hasPrefix("image/") } ?? "image/jpeg"
                            vm.uploadAvatar(bytes: bytes, mime: mime)
                        }
                    }
                    Spacer(minLength: 0)
                }
                .padding(.top, 12)
                msgView("p-photo")
            }
        }
    }

    private var nameRow: some View {
        let msg = vm.msgs["p-name"]
        return EbRow(id: "p-name", isError: msg?.kind == .err) {
            VStack(alignment: .leading, spacing: 10) {
                EbRowText(title: "Отображаемое имя", desc: "Под этим именем вас увидят другие пользователи.")
                EbField(
                    placeholder: "Введите имя",
                    text: Binding(get: { vm.ui.displayName }, set: { vm.onDisplayNameChange($0) }),
                    edited: vm.nameChanged, isError: msg?.kind == .err, accessibilityName: "Отображаемое имя"
                )
                if let msg { EbMsgView(msg: msg) }
            }
        }
    }

    private var eblidRow: some View {
        let eblid = vm.ui.profile?.eblid
        return EbRow(id: "p-eblid") {
            VStack(alignment: .leading, spacing: 12) {
                EbRowText(title: "EBLID", desc: "Ваш номер в Еблуше — по нему вас находят в «Контактах».")
                HStack(spacing: 10) {
                    EbEblidCapsule(eblid: eblid, height: 32)
                    if let eblid {
                        Button {
                            UIPasteboard.general.string = eblid
                            copied = true
                            Task {
                                try? await Task.sleep(for: .seconds(2))
                                copied = false
                            }
                        } label: {
                            EbButtonLabel(title: copied ? "Скопировано" : "Скопировать", symbol: copied ? "checkmark" : "doc.on.doc")
                        }
                        .buttonStyle(.eb(.normal, small: true))
                        .accessibilityLabel(copied ? "EBLID скопирован" : "Скопировать EBLID")
                    }
                    Spacer(minLength: 0)
                }
            }
        }
    }

    private var localTimeRow: some View {
        let lt = host.localTime
        let peer = lt.visibleToPeers.map { SettingsText.peerLine($0, now: Date()) }
        let message = SettingsText.localTimeMessage(
            share: lt.share?.share, saving: lt.saving, serverSupported: lt.serverSupported,
            peerLine: peer, error: lt.error
        )
        return EbToggleRow(
            id: "p-ltime",
            title: "Показывать моё местное время",
            desc: "Собеседники в личных чатах видят в шапке беседы, который у вас час, и город по часовому поясу.",
            isOn: Binding(get: { lt.share?.share ?? true }, set: { lt.setShare($0) }),
            disabled: lt.saving || lt.serverSupported == false,
            isError: message?.kind == .err,
            message: message
        )
    }

    private var botRow: some View {
        let bot = host.bot
        let message = SettingsText.botMessage(enabled: bot.botChat.enabled, saving: bot.saving, error: bot.error)
        var extra: AnyView?
        if bot.botChat.enabled, let id = bot.botChat.conversationId {
            extra = AnyView(
                Button {
                    // Тем же путём, что тап по уведомлению: стек заменяется беседой.
                    AppLifecycle.shared.requestOpenConversation(conversationId: id, title: SystemBotStore.displayName)
                } label: { EbButtonLabel(title: "Открыть чат", symbol: "bubble.left") }
                    .buttonStyle(.eb(.normal, small: true))
                    .frame(maxWidth: .infinity, alignment: .leading)
            )
        }
        return EbToggleRow(
            id: "p-bot",
            title: "Чат с Еблушей",
            desc: "Личный чат с ботом: там можно писать без обращения. В остальных беседах зовите «Еблуша, …».",
            isOn: Binding(get: { bot.botChat.enabled }, set: { bot.setBotChatEnabled($0) }),
            disabled: bot.saving,
            isError: message?.kind == .err,
            message: message,
            extra: extra
        )
    }

    // MARK: ③ Соединение

    private var connectionContent: some View {
        group("server.rack", "Сервер", top: 16) {
            EbCard {
                EbRow(id: "c-server") {
                    VStack(alignment: .leading, spacing: 12) {
                        EbRowText(
                            title: "Сервер",
                            desc: "Если напрямую сервер не открывается, попробуйте через СПб.",
                            desc2: "Смена сервера — это выход из аккаунта: ключи секретных чатов на телефоне сотрутся."
                        )
                        EbSegments(
                            options: AppConfig.Server.allCases.map { ($0, $0.routeTitle) },
                            selection: AppConfig.server,
                            accessibilityName: "Сервер",
                            onSelect: { target in
                                // Выбор сервера — смена мира: токены, id устройства и ключи секреток
                                // принадлежат серверу. Поэтому прежний вопрос с выходом.
                                if target != AppConfig.server { pendingServer = target }
                            }
                        )
                        EbCapsule(height: 26, horizontal: 10) {
                            Text("Сейчас: \(AppConfig.server.origin)").ebFont(12, mono: true).foregroundStyle(Eb.textMuted).lineLimit(1)
                        }
                    }
                }
            }
        }
    }

    // MARK: ④ Звук и видео

    private var avContent: some View {
        VStack(alignment: .leading, spacing: 0) {
            EbCard {
                permissionRow(
                    id: "a-permmic", title: "Доступ к микрофону",
                    desc: "Без него вас не слышно в звонках и не записать голосовое.",
                    message: PermissionText.micMessage(host.permissions.mic), denied: host.permissions.mic.isDenied
                )
                permissionRow(
                    id: "a-permcam", title: "Доступ к камере",
                    desc: "Без него собеседники не увидят ваше видео.",
                    message: PermissionText.camMessage(host.permissions.cam), denied: host.permissions.cam.isDenied
                )
            }
            .padding(.top, 16)
            EbSmallPrint(text: "Громкая связь и выбор камеры — в панели звонка.")
        }
    }

    private func permissionRow(id: String, title: String, desc: String, message: RowMessage, denied: Bool) -> some View {
        EbRow(id: id, isError: denied) {
            VStack(alignment: .leading, spacing: 0) {
                EbRowText(title: title, desc: desc)
                EbMsgView(msg: message)
                if denied {
                    Button { SystemSettingsLink.openApp() } label: {
                        EbButtonLabel(title: "Открыть настройки iOS", symbol: "arrow.up.right.square")
                    }
                    .buttonStyle(.eb(.normal, small: true))
                    .padding(.top, 10)
                }
            }
        }
    }

    // MARK: ⑤ Безопасность

    private var securityContent: some View {
        VStack(alignment: .leading, spacing: 0) {
            group(
                "lock", "Секретные чаты на этом телефоне",
                caption: "Ключи секретных чатов хранятся только на устройствах. Новое своё устройство подключают кодом с уже подключённого.",
                top: 16
            ) {
                EbCard { linkRow }
            }
            sessionsGroup
        }
    }

    private var linkRow: some View {
        let current = vm.ui.sessions.first(where: { $0.isCurrent })
        var message = vm.msgs["s-link"]
        if message == nil, let current {
            message = current.keysReady
                ? .ok("Телефон зарегистрирован, ключи готовы.")
                : .note("Телефон настраивается — ключи ещё не готовы.")
        }
        return EbRow(id: "s-link", isError: message?.kind == .err) {
            VStack(alignment: .leading, spacing: 12) {
                EbRowText(
                    title: "Подключить этот телефон",
                    desc: "Покажите код телефона на уже подключённом устройстве («Подтвердить по коду») — и сюда придут ключи секретных чатов."
                )
                Button(action: vm.startPairing) {
                    EbButtonLabel(title: vm.ui.pairingLoading ? "Создаём код…" : "Показать код", symbol: "qrcode", spinner: false)
                }
                .buttonStyle(.eb(.normal, small: true))
                .disabled(vm.ui.pairingLoading)
                if let message { EbMsgView(msg: message).padding(.top, -4) }
            }
        }
    }

    private var sessionsGroup: some View {
        let ui = vm.ui
        let rows = SessionPresentation.group(ui.sessions)
        let canAll = vm.canRevokeOthers
        return VStack(alignment: .leading, spacing: 0) {
            EbGroupHeader(symbol: "iphone", title: "Активные сеансы", mark: ui.sessionsLoaded ? "\(rows.count)" : nil) {
                Button { vm.askRevokeAll() } label: { EbButtonLabel(title: "Все другие", symbol: "xmark") }
                    .buttonStyle(.eb(.dangerText, small: true))
                    .disabled(!canAll)
                    .accessibilityLabel("Отключить все другие устройства")
                    .accessibilityHint(SessionPresentation.revokeOthersHint(ui.sessions) ?? "")
            }
            .id("row-s-sess")
            EbGroupCaption(text: "Телефоны, браузеры и приложения, где открыт ваш аккаунт.")
            if ui.sessionsLoaded && !canAll, let hint = SessionPresentation.revokeOthersHint(ui.sessions), !SessionPresentation.currentInList(ui.sessions) {
                Text(hint).ebFont(13).foregroundStyle(Eb.textDim).padding(.horizontal, 2).padding(.bottom, 8)
            }
            if ui.askRevokeOthers {
                EbAsk(
                    question: "Отключить все другие устройства?",
                    detail: "Они будут разлогинены и перестанут получать секретные сообщения.",
                    confirmTitle: "Отключить",
                    onCancel: { vm.cancelAsk() }, onConfirm: { vm.confirmRevokeAll() }
                )
                .padding(.bottom, 10)
            }
            if ui.sessionsFailed {
                EbEbox(text: "Не удалось загрузить список устройств.", onRetry: { vm.loadSessions() })
                    .padding(.bottom, 10)
            }
            if ui.sessionsLoading && ui.sessions.isEmpty {
                EbCard {
                    HStack(spacing: 12) {
                        ProgressView().tint(Eb.logoCream)
                        Text("Загружаем устройства…").ebFont(15, .semibold).foregroundStyle(Eb.logoCream)
                        Spacer(minLength: 0)
                    }
                    .padding(16)
                }
            } else if !ui.sessions.isEmpty {
                EbCard {
                    ForEach(rows) { data in
                        SessionRowView(
                            data: data,
                            asking: ui.askRevokeID == data.session.id,
                            onAsk: { vm.askRevoke(data.session) },
                            onCancel: { vm.cancelAsk() },
                            onConfirm: { vm.confirmRevoke() }
                        )
                    }
                }
            } else if ui.sessionsLoaded {
                EbCard {
                    VStack(spacing: 6) {
                        EbIcon(name: "shield", size: 26)
                        Text("Нет устройств").ebFont(15, .semibold).foregroundStyle(Eb.textPrimary)
                        Text("Других входов в ваш аккаунт сейчас нет.").ebFont(14).foregroundStyle(Eb.textMuted)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(20)
                }
            }
            if let msg = vm.msgs["s-sess"] { EbMsgView(msg: msg) }
            if ui.sessionsLoaded && !SessionPresentation.currentInList(ui.sessions) {
                EbDashedNote(text: "Этот телефон здесь пока не значится: его устройство для секретных чатов не зарегистрировано.")
                    .padding(.top, 12)
            }
        }
        .padding(.top, 20)
    }

    // MARK: ⑦ Приложение

    private var appContent: some View {
        VStack(alignment: .leading, spacing: 0) {
            group("play.circle", "Медиа", top: 16) {
                EbCard {
                    EbRow(id: "ap-autoplay") {
                        VStack(alignment: .leading, spacing: 12) {
                            EbRowText(
                                title: "Автовоспроизведение видео",
                                desc: "Короткие видео в переписке оживают сами — без звука и только пока плитка на экране. Звук и перемотка остаются в плеере по тапу."
                            )
                            EbSegments(
                                options: VideoAutoplayMode.allCases.map { ($0.rawValue, $0.title) },
                                selection: videoAutoplayRaw,
                                accessibilityName: "Автовоспроизведение видео",
                                onSelect: { videoAutoplayRaw = $0 }
                            )
                        }
                    }
                }
            }
            group("bell", "Звуки и уведомления") {
                EbCard {
                    EbToggleRow(
                        id: "ap-sndin", title: "Звук входящих сообщений",
                        desc: "Короткий звук, когда приходит сообщение, а беседа не открыта.", isOn: $soundIncoming
                    )
                    EbToggleRow(
                        id: "ap-sndout", title: "Звук отправки",
                        desc: "Короткий звук, когда сообщение ушло.", isOn: $soundOutgoing
                    )
                    notificationsRow
                }
            }
        }
    }

    private var notificationsRow: some View {
        let message = PermissionText.notificationMessage(host.permissions.notifications)
        return EbRow(id: "ap-notif", isError: message?.kind == .err) {
            VStack(alignment: .leading, spacing: 0) {
                EbRowText(title: "Уведомления", desc: "Сообщения и звонки, пока Еблуша закрыта.")
                Button { SystemSettingsLink.openNotifications() } label: {
                    EbButtonLabel(title: "Настройки iOS", symbol: "arrow.up.right.square")
                }
                .buttonStyle(.eb(.normal, small: true))
                .padding(.top, 12)
                if let message { EbMsgView(msg: message) }
            }
        }
    }

    // MARK: Общее

    @ViewBuilder
    private func msgView(_ id: String) -> some View {
        if let msg = vm.msgs[id] { EbMsgView(msg: msg) }
    }

    private var pairingBinding: Binding<DevicePairing?> {
        Binding(
            get: { vm.ui.pairing },
            set: { if $0 == nil { vm.dismissPairing() } }
        )
    }
}

/// Раздел раскрывается из плитки (iOS 18 `.zoom`, свайп назад — интерактивный). «Меньше
/// движения» — обычный переход системы.
private struct SectionZoomTransition: ViewModifier {
    let section: SettingsSectionID
    let zoom: Namespace.ID
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        if reduceMotion {
            content.navigationTransition(.automatic)
        } else {
            content.navigationTransition(.zoom(sourceID: section.id, in: zoom))
        }
    }
}

// MARK: - Строка сеанса

/// Круг 40 со значком платформы, имя 15 SemiBold, «+N», «Это устройство», мета 13.5, ключи,
/// когда был в сети; справа ✕ (у своего — нет). Вопрос «Отключить устройство?» — под строкой.
struct SessionRowView: View {
    let data: SessionRowData
    let asking: Bool
    let onAsk: () -> Void
    let onCancel: () -> Void
    let onConfirm: () -> Void

    var body: some View {
        let s = data.session
        EbRow(id: "s-sess", isError: asking, anchorID: "sess-\(s.id)") {
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .top, spacing: 14) {
                    ZStack {
                        Circle().fill(Eb.surface100)
                        Circle().strokeBorder(Eb.borderStrong, lineWidth: 1)
                        Image(systemName: SessionPresentation.symbol(s.platform))
                            .font(.system(size: 18)).foregroundStyle(Eb.textPrimary)
                    }
                    .frame(width: 40, height: 40)
                    .accessibilityHidden(true)

                    VStack(alignment: .leading, spacing: 3) {
                        HStack(spacing: 8) {
                            Text(s.name).ebFont(15, .semibold).foregroundStyle(Eb.textPrimary).lineLimit(1)
                            if data.extra > 0 {
                                Text("+\(data.extra)").ebFont(12.5, .semibold, digits: true).foregroundStyle(Eb.textMuted)
                                    .padding(.horizontal, 7).frame(minHeight: 20)
                                    .background(Capsule().fill(Eb.surface100))
                                    .overlay(Capsule().strokeBorder(Eb.borderStrong, lineWidth: 1))
                            }
                            if s.isCurrent {
                                Text("Это устройство").ebFont(12, .semibold).foregroundStyle(Eb.ok).lineLimit(1)
                                    .padding(.horizontal, 8).padding(.vertical, 2)
                                    .background(Capsule().fill(Color(hex: 0x22C55E, opacity: 0.12)))
                                    .fixedSize()
                            }
                        }
                        Text(SessionPresentation.metaLine(s)).ebFont(13.5).foregroundStyle(Eb.textMuted)
                            .fixedSize(horizontal: false, vertical: true)
                        HStack(spacing: 6) {
                            if s.keysReady {
                                EbIcon(name: "checkmark", size: 12, color: Eb.textMuted, weight: .semibold)
                                Text("Ключи готовы").ebFont(13).foregroundStyle(Eb.textMuted)
                            } else {
                                EbIcon(name: "info.circle", size: 12, color: Eb.brand600)
                                Text("Ключи не готовы").ebFont(13, .semibold).foregroundStyle(Eb.brand600)
                            }
                        }
                        if let seen = SessionPresentation.seenLine(lastSeenMs: s.lastSeenMs, isCurrent: s.isCurrent) {
                            Text(seen).ebFont(13).foregroundStyle(Eb.textDim)
                        }
                    }
                    Spacer(minLength: 0)
                    if !s.isCurrent {
                        Button(action: onAsk) {
                            Image(systemName: "xmark").font(.system(size: 14, weight: .semibold)).foregroundStyle(Eb.dangerSoft)
                                .frame(width: 36, height: 36)
                                .background(Circle().fill(Eb.danger.opacity(0.10)))
                                .contentShape(.interaction, Circle().inset(by: -6))
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Отключить «\(s.name)»")
                    }
                }
                if asking {
                    EbAsk(
                        question: "Отключить устройство?",
                        detail: "Оно перестанет получать секретные сообщения и ключи.",
                        confirmTitle: "Отключить", onCancel: onCancel, onConfirm: onConfirm
                    )
                }
            }
        }
    }
}

// MARK: - Лист «Подключить этот телефон»

/// Для sheet(item:): пара короткоживущая, токен уникален на показ.
extension DevicePairing: Identifiable {
    var id: String { token }
}

/// Телефон показывает СВОЙ код (по протоколу — роль нового устройства, поток B), а подтверждает
/// его уже подключённое устройство — веб или ПК, «Подтвердить по коду». Прежний текст листа
/// говорил обратное («отсканируйте на новом устройстве»).
struct PairingSheet: View {
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
            Text("Подключить этот телефон")
                .ebFont(20, .semibold, relativeTo: .title3)
                .foregroundStyle(Eb.textPrimary)
                .padding(.top, 40)
                .accessibilityAddTraits(.isHeader)
            Text("Покажите этот код на уже подключённом устройстве: откройте там «Подтвердить по коду» — и сюда придут ключи секретных чатов.")
                .ebFont(14)
                .foregroundStyle(Eb.textMuted)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
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
                    .accessibilityLabel("QR-код для подключения телефона")
            } else {
                Text("Не удалось создать QR-код").foregroundStyle(Eb.dangerText).padding(.top, 16)
            }
            if let code = pairing.code {
                Text("Или введите код:").ebFont(13).foregroundStyle(Eb.textMuted).padding(.top, 12)
                Text(code).ebFont(22, .bold, digits: true).foregroundStyle(Eb.brand600).padding(.top, 2)
            }
            Button(action: onDismiss) { Text("Готово").padding(.horizontal, 24) }
                .buttonStyle(.eb(.primary))
                .padding(.top, 20)
            Spacer()
        }
        .frame(maxWidth: .infinity)
        .background(Eb.surface200)
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }
}
