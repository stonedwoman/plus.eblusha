import SwiftUI

// Обзор «Центра управления» на iOS (SPEC §2.3): шапка с янтарным налётом, поле поиска, сетка
// плиток с живым состоянием, подвал «Выйти из Еблуши» и версия. Обзор прокручивается (в отличие
// от натива, где он обязан влезть). Плитка открывает раздел: `.matchedTransitionSource` →
// `.navigationTransition(.zoom)` (iOS 18, интерактивный свайп назад из коробки).

// MARK: - Шапка

/// Логотип «ЕБлуша»: большая «Б» #E25C2A, раз в 5 с переворот по вертикальной оси. «Меньше
/// движения» — «Б» стоит.
struct SettingsWordmark: View {
    var size: CGFloat = 20
    @State private var flip = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    #if DEBUG
    /// Снимки стенда: «Б» не должна быть пойманной посреди переворота.
    static var frozen = false
    #endif

    var body: some View {
        HStack(spacing: 0) {
            Text("Е").foregroundStyle(Eb.logoCream)
            Text("Б").foregroundStyle(Eb.logoB)
                .rotation3DEffect(.degrees(flip ? 360 : 0), axis: (x: 0, y: 1, z: 0), perspective: 0.5)
            Text("луша").foregroundStyle(Eb.logoCream)
        }
        .font(.system(size: size, weight: .heavy))
        .tracking(-0.2)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Еблуша")
        .task(id: reduceMotion) {
            guard !reduceMotion, !Self.isFrozen else { return }
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(4.25))
                withAnimation(.easeInOut(duration: 0.75)) { flip = true }
                try? await Task.sleep(for: .seconds(0.75))
                var t = Transaction()
                t.disablesAnimations = true
                withTransaction(t) { flip = false }
            }
        }
    }

    private static var isFrozen: Bool {
        #if DEBUG
        return frozen
        #else
        return false
        #endif
    }
}

/// Фон панели навигации: янтарный налёт сверху вниз (#3B2813 → #191716 — `rgba(217,119,6,.22)` →
/// `.05` поверх #0F1217, уже смешанные: прозрачный фон бара дал бы прокручиваемое под ним).
let settingsHeaderVeil = LinearGradient(
    colors: [Color(hex: 0x3B2813), Color(hex: 0x191716)], startPoint: .top, endPoint: .bottom
)

extension View {
    /// Шапка экранов «Центра управления»: налёт, тёмная схема бара и линия 2 #D97706 под ним.
    func settingsHeaderChrome() -> some View {
        self
            .toolbarBackground(settingsHeaderVeil, for: .navigationBar)
            .toolbarBackgroundVisibility(.visible, for: .navigationBar)
            .toolbarColorScheme(.dark, for: .navigationBar)
            .safeAreaInset(edge: .top, spacing: 0) {
                Rectangle().fill(Eb.brand).frame(height: 2)
            }
    }
}

// MARK: - Обзор

enum SettingsLeaveIntent: Equatable { case close, logout }

struct SettingsCenterView: View {
    @ObservedObject var host: SettingsHostModel
    var zoom: Namespace.ID
    /// Открыть раздел; второй аргумент — строка, к которой прокрутить (из выдачи поиска).
    var onOpenSection: (SettingsSectionID, String?) -> Void
    var onClose: () -> Void
    var onLogout: () -> Void
    /// Только стенд (SettingsDemo): открыть экран сразу с вопросом о выходе / о несохранённом.
    var demoAskExit = false
    var demoLeave: SettingsLeaveIntent?

    @State private var width: CGFloat = 390
    @State private var askExit = false
    @State private var leaveIntent: SettingsLeaveIntent?
    @FocusState private var searchFocused: Bool
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.scenePhase) private var scenePhase

    private var nav: SettingsNavState { host.nav }
    private var vm: SettingsViewModel { host.vm }

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 0, pinnedViews: [.sectionHeaders]) {
                Section {
                    VStack(spacing: 10) {
                        if nav.isSearching {
                            searchResults
                        } else {
                            tilesGrid
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.top, 12)
                    footer
                        .padding(.horizontal, 16)
                        .padding(.top, 20)
                        .padding(.bottom, 28)
                } header: {
                    searchField
                }
            }
        }
        .scrollDismissesKeyboard(.interactively)
        .background(Eb.paper.ignoresSafeArea())
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
        .settingsHeaderChrome()
        .navigationBarBackButtonHidden(true)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button(action: handleBack) {
                    Image(systemName: "chevron.left").font(.system(size: 17, weight: .semibold)).foregroundStyle(Eb.textPrimary)
                }
                .accessibilityLabel(nav.isSearching ? "Сбросить поиск" : "Назад к беседам")
            }
            ToolbarItem(placement: .principal) {
                HStack(spacing: 10) {
                    SettingsWordmark(size: 20)
                    Rectangle().fill(Eb.borderStrong).frame(width: 1, height: 20).accessibilityHidden(true)
                    Text("Настройки")
                        .ebFont(17, .semibold)
                        .foregroundStyle(Eb.textPrimary)
                        .accessibilityAddTraits(.isHeader)
                        .accessibilityHeading(.h1)
                }
            }
        }
        .toolbarTitleDisplayMode(.inline)
        .edgeSwipeBack { handleBack() }
        .overlay { leaveCard }
        .environment(\.settingsSearch, nav.searchEnv())
        .onAppear {
            host.refresh()
            if demoAskExit { askExit = true }
            if let demoLeave { leaveIntent = demoLeave }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { host.permissions.refresh() }
        }
        .animation(.easeOut(duration: 0.2), value: nav.isSearching)
    }

    // MARK: Назад по шагам

    /// Вопрос на месте → запрос поиска → вопрос о несохранённом → беседы.
    private func handleBack() {
        if askExit { askExit = false; return }
        if !nav.query.isEmpty { nav.query = ""; searchFocused = false; return }
        if vm.isDirty { leaveIntent = .close; return }
        close()
    }

    private func close() {
        host.reset()
        onClose()
    }

    private func proceed(_ intent: SettingsLeaveIntent) {
        leaveIntent = nil
        switch intent {
        case .close: close()
        case .logout: onLogout()
        }
    }

    // MARK: Поле поиска

    private var searchField: some View {
        let count = nav.matched.count
        return HStack(spacing: 10) {
            Image(systemName: "magnifyingglass").font(.system(size: 15)).foregroundStyle(Eb.textMuted)
            TextField("", text: Binding(get: { nav.query }, set: { nav.query = String($0.prefix(80)) }),
                      prompt: Text("Найти настройку").foregroundStyle(Eb.textDim))
                .ebFont(14.5)
                .foregroundStyle(Eb.textPrimary)
                .tint(Eb.brand600)
                .focused($searchFocused)
                .submitLabel(.search)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .onSubmit { openFirstResult() }
                .accessibilityLabel("Поиск по настройкам")
            if nav.isSearching {
                Text(count == 0 ? "ничего" : SettingsText.settingsCount(count))
                    .ebFont(12.5, .semibold)
                    .foregroundStyle(count == 0 ? Eb.dangerSoft : Eb.logoCream)
                    .lineLimit(1)
                    .accessibilityHidden(true)
            }
            if !nav.query.isEmpty {
                Button { nav.query = "" } label: {
                    Image(systemName: "xmark").font(.system(size: 12, weight: .semibold)).foregroundStyle(Eb.textMuted)
                        .frame(width: 28, height: 28)
                        .contentShape(.interaction, Rectangle().inset(by: -8))
                }
                .accessibilityLabel("Сбросить поиск")
            }
        }
        .padding(.horizontal, 12)
        .frame(minHeight: 44)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Eb.field))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(searchFocused ? Eb.brand600 : Eb.borderStrong, lineWidth: 1))
        .padding(.horizontal, 16)
        .padding(.top, 12)
        .padding(.bottom, 4)
        .background(Eb.paper)
        .onChange(of: count) { _, new in
            guard nav.isSearching else { return }
            var text = AttributedString(new == 0 ? "Ничего не нашлось" : "Нашлось \(SettingsText.settingsCount(new))")
            text.accessibilitySpeechAnnouncementPriority = .low
            AccessibilityNotification.Announcement(text).post()
        }
    }

    private func openFirstResult() {
        guard let first = nav.matched.first else { return }
        open(row: first)
    }

    private func open(row: SettingsSearchRow) {
        searchFocused = false
        guard let section = row.section else {
            nav.query = ""
            askExit = true
            return
        }
        nav.scrollTarget = row.id
        onOpenSection(section, row.id)
    }

    // MARK: Сетка плиток

    private var visibleSections: [SettingsSectionID] { SettingsSectionID.allCases }

    private var tilesGrid: some View {
        let large = typeSize >= .accessibility1
        let columns = SettingsGridLayout.columns(forWidth: width, largeText: large)
        let rows = SettingsGridLayout.rows(for: visibleSections, columns: columns)
        let gap: CGFloat = 10
        let inner = max(0, width - 32)
        let unit = (inner - gap * CGFloat(columns - 1)) / CGFloat(columns)
        return VStack(spacing: gap) {
            ForEach(rows.indices, id: \.self) { r in
                HStack(alignment: .top, spacing: gap) {
                    ForEach(rows[r], id: \.section) { cell in
                        tile(cell.section, wide: cell.span >= 2 || columns == 1)
                            .frame(width: unit * CGFloat(cell.span) + gap * CGFloat(cell.span - 1))
                            .frame(maxHeight: .infinity)
                    }
                }
                .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    @ViewBuilder
    private func tile(_ section: SettingsSectionID, wide: Bool) -> some View {
        let summary = host.summary(section)
        let name = summary.accessibilityName(section)
        let open = { onOpenSection(section, nil) }
        switch section {
        case .profile:
            let ui = vm.ui
            let shown = vm.nameChanged && !ui.displayName.trimmed().isEmpty ? ui.displayName.trimmed() : (ui.profile?.name ?? fallbackName)
            SettingsTile(
                section: .profile, accessibilityName: name, attention: summary.attention, dot: vm.isDirty,
                banner: true, minHeight: 0, zoom: zoom, onOpen: open
            ) {
                ProfileTileContent(
                    name: shown, avatarUrl: ui.profile?.avatarUrl, eblid: ui.profile?.eblid,
                    status: SettingsText.statusOption(ui.profile?.status),
                    hint: vm.isDirty ? "Сохраните изменения" : nil
                )
            }
        case .conn:
            SettingsTile(section: .conn, accessibilityName: name, attention: summary.attention, zoom: zoom, onOpen: open) {
                ConnectionTileContent(server: AppConfig.server)
            }
        case .av:
            let perm = host.permissions
            let denied = perm.mic.isDenied || perm.cam.isDenied
            SettingsTile(section: .av, accessibilityName: name, attention: summary.attention, zoom: zoom, onOpen: open) {
                AvTileContent(mic: perm.mic, cam: perm.cam, reserveAction: denied)
            } action: {
                if denied {
                    Button { SystemSettingsLink.openApp() } label: {
                        EbButtonLabel(title: "Настройки", symbol: "arrow.up.right.square")
                    }
                    .buttonStyle(.eb(.normal, small: true))
                    .accessibilityLabel("Открыть настройки iOS")
                }
            }
        case .security:
            SettingsTile(section: .security, accessibilityName: name, attention: summary.attention, zoom: zoom, onOpen: open) {
                SecurityTileContent(state: securityState)
            }
        case .app:
            let i = host.inputs
            SettingsTile(section: .app, accessibilityName: name, attention: summary.attention, zoom: zoom, onOpen: open) {
                AppTileContent(
                    autoplay: i.autoplay, soundIncoming: i.soundIncoming, soundOutgoing: i.soundOutgoing,
                    notifications: i.notifications
                )
            }
        }
    }

    private var fallbackName: String {
        let user = AppContainer.shared.sessionStore.currentUser()
        if let d = user?.displayName, !d.trimmed().isEmpty { return d }
        return user?.username ?? "Профиль"
    }

    private var securityState: SecurityTileState {
        let i = host.inputs
        if i.sessionsLoading { return .loading }
        if i.sessionsFailed { return .failed }
        return .ready(count: i.sessionsCount, keysReady: i.keysReady ?? false)
    }

    // MARK: Поиск: группы во всю ширину

    @ViewBuilder
    private var searchResults: some View {
        let matches = nav.matched
        if matches.isEmpty {
            noResults
        } else {
            let sections = visibleSections.filter { s in matches.contains { $0.section == s } }
            ForEach(sections) { section in
                resultGroup(section, rows: matches.filter { $0.section == section })
            }
            let loose = matches.filter { $0.section == nil }
            if !loose.isEmpty {
                VStack(spacing: 0) {
                    ForEach(loose) { row in resultRow(row, first: true) }
                }
                .padding(.vertical, 4)
                .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Eb.surface200))
                .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Eb.brand600, lineWidth: 1))
            }
            let without = visibleSections.count - sections.count
            if without > 0 {
                Text("Ещё \(without) " + SettingsText.plural(without, "раздел", "раздела", "разделов") + " без совпадений")
                    .ebFont(13)
                    .foregroundStyle(Eb.textDim)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 4)
                    .padding(.top, 2)
            }
        }
    }

    private func resultGroup(_ section: SettingsSectionID, rows: [SettingsSearchRow]) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 10) {
                EbIconSquare(symbol: section.symbol, side: 28, icon: 14, radius: 8)
                Text(section.title).ebFont(14.5, .bold, relativeTo: .subheadline).foregroundStyle(Eb.textPrimary)
                    .accessibilityAddTraits(.isHeader)
                Spacer(minLength: 0)
                Text("\(rows.count)")
                    .ebFont(12.5, .bold, digits: true)
                    .foregroundStyle(Eb.logoCream)
                    .padding(.horizontal, 7)
                    .frame(minWidth: 22, minHeight: 22)
                    .background(Capsule().fill(Eb.brand600.opacity(0.16)))
                    .overlay(Capsule().strokeBorder(Eb.brand600.opacity(0.55), lineWidth: 1))
                    .accessibilityLabel("\(SettingsText.matches(rows.count))")
            }
            .padding(.horizontal, 14).padding(.top, 14).padding(.bottom, 8)
            ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                resultRow(row, first: index == 0)
            }
            .padding(.horizontal, 6)
            Color.clear.frame(height: 8)
        }
        .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Eb.surface200))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Eb.brand600, lineWidth: 1))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(section.title): \(SettingsText.matches(rows.count))")
    }

    private func resultRow(_ row: SettingsSearchRow, first: Bool) -> some View {
        let value = valueText(row.id)
        let sub = SettingsSearch.excerpt(row, query: nav.query)
        return Button { open(row: row) } label: {
            HStack(alignment: .top, spacing: 10) {
                EbIcon(name: "arrow.right", size: 12, color: Eb.brand600, weight: .semibold).padding(.top, 5)
                VStack(alignment: .leading, spacing: 2) {
                    // Значение — справа от названия, если оно помещается в одну строку; иначе
                    // название переносится по словам, а значение уходит под него.
                    ViewThatFits(in: .horizontal) {
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            resultTitle(row).lineLimit(1)
                            Spacer(minLength: 8)
                            resultValue(value)
                        }
                        VStack(alignment: .leading, spacing: 2) {
                            resultTitle(row)
                            resultValue(value)
                        }
                    }
                    if !sub.isEmpty {
                        Text(SettingsSearch.highlighted(sub, query: nav.query))
                            .ebFont(12.5)
                            .foregroundStyle(Eb.textMuted)
                            .multilineTextAlignment(.leading)
                            .lineLimit(2)
                    }
                }
            }
            .padding(.horizontal, 8).padding(.vertical, 8)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func resultTitle(_ row: SettingsSearchRow) -> some View {
        Text(SettingsSearch.highlighted(row.title, query: nav.query))
            .ebFont(14, .semibold)
            .foregroundStyle(Eb.textPrimary)
            .multilineTextAlignment(.leading)
    }

    @ViewBuilder
    private func resultValue(_ value: String) -> some View {
        if !value.isEmpty {
            Text(value).ebFont(12.5, .semibold).foregroundStyle(Eb.textMuted).lineLimit(1)
        }
    }

    private var noResults: some View {
        VStack(spacing: 10) {
            EbIcon(name: "magnifyingglass", size: 26)
            Text("Ничего не нашлось по «\(nav.query.trimmed())»")
                .ebFont(17, .bold, relativeTo: .headline)
                .foregroundStyle(Eb.textPrimary)
                .multilineTextAlignment(.center)
            Text("Поиск идёт по названиям и пояснениям всех настроек. Попробуйте другое слово:")
                .ebFont(14).foregroundStyle(Eb.textMuted).multilineTextAlignment(.center)
            HStack(spacing: 8) {
                ForEach(["микрофон", "сервер", "звук", "видео"], id: \.self) { word in
                    Button(word) { nav.query = word }.buttonStyle(.eb(.normal, small: true))
                }
            }
        }
        .padding(22)
        .frame(maxWidth: .infinity)
        .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Eb.surface200))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Eb.borderStrong, lineWidth: 1))
        .accessibilityElement(children: .combine)
    }

    /// Текущее значение у строки выдачи (12.5 SemiBold справа).
    private func valueText(_ id: String) -> String {
        let i = host.inputs
        switch id {
        case "p-photo": return host.vm.ui.profile?.avatarUrl == nil ? "нет фото" : "есть фото"
        case "p-name": return host.vm.ui.profile?.name ?? ""
        case "p-eblid": return host.vm.ui.profile?.eblid ?? ""
        case "p-status": return SettingsText.statusOption(host.vm.ui.profile?.status).label
        case "p-ltime": return (host.localTime.share?.share ?? true) ? "Вкл" : "Выкл"
        case "p-bot": return host.bot.botChat.enabled ? "Вкл" : "Выкл"
        case "c-server": return i.server.routeTitle
        case "a-permmic": return permWord(i.mic)
        case "a-permcam": return permWord(i.cam)
        case "s-sess": return i.sessionsLoading ? "" : "\(i.sessionsCount)"
        case "ap-autoplay": return i.autoplay.title
        case "ap-sndin": return i.soundIncoming ? "Вкл" : "Выкл"
        case "ap-sndout": return i.soundOutgoing ? "Вкл" : "Выкл"
        case "ap-notif": return i.notifications.map { $0.isOn ? "Вкл" : "Выкл" } ?? ""
        default: return ""
        }
    }

    private func permWord(_ state: PermissionState) -> String {
        switch state {
        case .granted: return "есть"
        case .notDetermined: return "спросим"
        case .denied: return "нет"
        }
    }

    // MARK: Подвал: выход и версия

    private var footer: some View {
        VStack(alignment: .leading, spacing: 0) {
            Rectangle().fill(Eb.border).frame(height: 1).padding(.bottom, 8)
            if askExit {
                EbAsk(
                    question: "Выйти из аккаунта на этом телефоне?",
                    detail: "Откроется экран входа, ключи секретных чатов на этом телефоне сотрутся.",
                    cancelTitle: "Остаться", confirmTitle: "Выйти", confirmSymbol: "rectangle.portrait.and.arrow.right",
                    onCancel: { askExit = false },
                    onConfirm: {
                        askExit = false
                        if vm.isDirty { leaveIntent = .logout } else { onLogout() }
                    }
                )
            } else {
                Button { askExit = true } label: {
                    HStack(spacing: 10) {
                        Image(systemName: "rectangle.portrait.and.arrow.right").font(.system(size: 17, weight: .regular))
                        Text("Выйти из Еблуши").ebFont(15, .semibold)
                        Spacer(minLength: 0)
                    }
                    .foregroundStyle(Eb.dangerSoft)
                    .padding(.horizontal, 4)
                    .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            Text(SettingsText.versionLineFromBundle())
                .ebFont(12.5)
                .foregroundStyle(Eb.textDim)
                .padding(.horizontal, 4)
                .padding(.top, 10)
        }
    }

    // MARK: Вопрос о несохранённом профиле

    @ViewBuilder
    private var leaveCard: some View {
        if let intent = leaveIntent {
            ZStack {
                Color(hex: 0x0A0C10, opacity: 0.55).ignoresSafeArea()
                    .onTapGesture { leaveIntent = nil }
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 8) {
                    Text("Сохранить изменения в профиле?")
                        .ebFont(17, .bold, relativeTo: .headline).foregroundStyle(Eb.textPrimary)
                        .accessibilityAddTraits(.isHeader)
                    Text("Вы изменили профиль, но не сохранили изменения.")
                        .ebFont(14).foregroundStyle(Eb.textMuted).fixedSize(horizontal: false, vertical: true)
                    VStack(spacing: 8) {
                        Button {
                            vm.save { ok in
                                if ok { proceed(intent) } else { leaveIntent = nil }
                            }
                        } label: { EbButtonLabel(title: "Сохранить", symbol: "checkmark") }
                            .buttonStyle(.eb(.primary, fullWidth: true))
                        Button("Не сохранять") {
                            vm.discardDraft()
                            proceed(intent)
                        }
                        .buttonStyle(.eb(.normal, fullWidth: true))
                        Button("Отмена") { leaveIntent = nil }
                            .buttonStyle(.eb(.ghost, fullWidth: true))
                    }
                    .padding(.top, 10)
                }
                .padding(22)
                .frame(maxWidth: 420)
                .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Eb.surface200))
                .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Eb.borderStrong, lineWidth: 1))
                .padding(.horizontal, 24)
                .accessibilityAddTraits(.isModal)
            }
            .transition(.opacity)
        }
    }
}
