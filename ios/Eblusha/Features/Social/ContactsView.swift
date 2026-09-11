import SwiftUI
import UIKit

// Порт `ui/social/ContactsScreen.kt` в родной структуре iOS: крупный системный заголовок
// «Контакты», штатный поиск, `List` с секциями («Входящие запросы», «Ожидание
// подтверждения», затем друзья по буквам алфавита) и свайп-действиями. Всё, что относится
// к добавлению друга — ввод EBLID, QR-сканер, карточки «Мой EBLID» и «Код регистрации», —
// уехало в отдельный лист по кнопке «Добавить» в панели. Логика прежняя: тот же
// ContactsViewModel и те же вызовы, здесь только сборка вью.

struct ContactsView: View {
    /// Свою кнопку «назад» не рисуем — её даёт NavigationStack. onBack нужен свайпу
    /// «назад» из любой точки (см. `edgeSwipeBack`); nil — если экран показан не в стеке.
    let onBack: (() -> Void)?
    let onOpenConversation: (ConversationRef) -> Void

    @StateObject private var vm: ContactsViewModel

    /// Универсальная карточка пользователя: тап по аватару друга, «Профиль» в меню,
    /// тап по строке заявки или результата поиска.
    @State private var userCard: UserCardSeed?
    @State private var showAdd = false
    /// Кандидат на удаление: подтверждаем диалогом, чтобы случайный свайп не сносил друга.
    @State private var contactToRemove: Contact?

    init(onBack: (() -> Void)?, onOpenConversation: @escaping (ConversationRef) -> Void) {
        self.onBack = onBack
        self.onOpenConversation = onOpenConversation
        _vm = StateObject(wrappedValue: ContactsViewModel(
            repo: AppContainer.shared.contactsRepository,
            realtime: AppContainer.shared.realtimeClient
        ))
    }

    var body: some View {
        List {
            noticeSection
            if isSearching {
                searchSections
            } else {
                requestSections
                contactSections
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(Eb.paper)
        .navigationTitle("Контакты")
        // Возврат свайпом вправо из любой точки — как в остальных экранах стека.
        .edgeSwipeBack { onBack?() }
        .navigationBarTitleDisplayMode(.large)
        // Поиск — системный. Строка уходит в ту же vm.onQueryChange: друзей фильтруем
        // локально по имени, а от двух символов ViewModel сама ищет по серверу (имя/EBLID).
        .searchable(text: queryBinding, prompt: Text("Имя или EBLID"))
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    showAdd = true
                } label: {
                    Label("Добавить", systemImage: "person.badge.plus")
                }
            }
        }
        // load() лишь запускает задачу, поэтому индикатор гаснет сразу, а список догоняет
        // через @Published. Async-API у ViewModel нет, и ради одного жеста его не заводим.
        .refreshable {
            await vm.load()
        }
        .overlay { emptyState }
        .sheet(item: $userCard) { seed in
            UserCardSheet(
                seed: seed,
                onOpenConversation: { ref in
                    userCard = nil
                    onOpenConversation(ref)
                },
                onDismiss: { userCard = nil }
            )
        }
        // Закрыли лист добавления — прибираем «Запрос отправлен»/ошибку, чтобы не висели.
        .sheet(isPresented: $showAdd, onDismiss: { vm.clearMessages() }) {
            AddContactSheet(vm: vm)
        }
        .confirmationDialog(
            "Удалить из контактов?",
            isPresented: Binding(
                get: { contactToRemove != nil },
                set: { if !$0 { contactToRemove = nil } }
            ),
            titleVisibility: .visible,
            presenting: contactToRemove
        ) { contact in
            Button("Удалить", role: .destructive) {
                contactToRemove = nil
                vm.removeContact(contact)
            }
            Button("Отмена", role: .cancel) { contactToRemove = nil }
        } message: { contact in
            Text("\(contact.user.name) исчезнет из списка контактов.")
        }
    }

    // MARK: - Производные данные

    private var query: String { vm.ui.query.trimmed() }
    private var isSearching: Bool { !query.isEmpty }

    private var queryBinding: Binding<String> {
        Binding(get: { vm.ui.query }, set: { vm.onQueryChange($0) })
    }

    /// Друзья, подходящие под строку поиска. Только по имени: логин — секрет входа,
    /// и даже совпадение по нему выдавало бы его существование.
    private var localMatches: [Contact] {
        vm.ui.contacts.filter { $0.user.name.localizedCaseInsensitiveContains(query) }
    }

    /// Серверные результаты без тех, кто уже в друзьях, — они и так в секции выше.
    private var serverResults: [ChatUser] {
        let known = Set(vm.ui.contacts.map { $0.user.id })
        return vm.ui.results.filter { !known.contains($0.id) }
    }

    private var letterGroups: [LetterGroup] { groupByLetter(vm.ui.contacts) }

    private var showEmpty: Bool {
        !isSearching && !vm.ui.loading && vm.ui.contacts.isEmpty
            && vm.ui.incoming.isEmpty && vm.ui.outgoing.isEmpty
    }

    private var showNoResults: Bool {
        isSearching && !vm.ui.searching && localMatches.isEmpty && serverResults.isEmpty
    }

    private func showCard(_ user: ChatUser) {
        userCard = UserCardSeed(userId: user.id, name: user.name, avatarUrl: user.avatarUrl)
    }

    // MARK: - Секции списка

    /// Сообщения ViewModel («Запрос отправлен», ошибка) — строкой сверху, закрываются крестиком.
    @ViewBuilder
    private var noticeSection: some View {
        if vm.ui.info != nil || vm.ui.error != nil {
            Section {
                if let info = vm.ui.info {
                    NoticeRow(text: info, icon: "checkmark.circle.fill", color: Eb.brand) {
                        vm.clearMessages()
                    }
                    .plainRow()
                }
                if let error = vm.ui.error {
                    NoticeRow(text: error, icon: "exclamationmark.triangle.fill", color: Eb.error) {
                        vm.clearMessages()
                    }
                    .plainRow()
                }
            }
        }
    }

    /// Заявки: входящие (принять/отклонить) и наши неотвеченные (отменить).
    @ViewBuilder
    private var requestSections: some View {
        if !vm.ui.incoming.isEmpty {
            Section {
                ForEach(vm.ui.incoming) { c in
                    PersonRow(
                        user: c.user,
                        subtitle: "хочет добавить вас",
                        onTap: { showCard(c.user) },
                        onAvatarTap: nil,
                        actions: {
                            MiniButton(icon: "checkmark", description: "Принять", tint: Eb.online) {
                                vm.respond(c, action: "accept")
                            }
                            MiniButton(icon: "xmark", description: "Отклонить", tint: Eb.error) {
                                vm.respond(c, action: "reject")
                            }
                        }
                    )
                    .plainRow()
                    .swipeActions(edge: .leading, allowsFullSwipe: true) {
                        Button {
                            vm.respond(c, action: "accept")
                        } label: {
                            Label("Принять", systemImage: "checkmark")
                        }
                        .tint(Eb.online)
                    }
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        Button(role: .destructive) {
                            vm.respond(c, action: "reject")
                        } label: {
                            Label("Отклонить", systemImage: "xmark")
                        }
                    }
                }
            } header: {
                Text("Входящие запросы")
            }
        }

        if !vm.ui.outgoing.isEmpty {
            Section {
                ForEach(vm.ui.outgoing) { c in
                    PersonRow(
                        user: c.user,
                        subtitle: "запрос отправлен",
                        onTap: { showCard(c.user) },
                        onAvatarTap: nil,
                        actions: {
                            MiniButton(icon: "xmark", description: "Отменить запрос") {
                                vm.removeContact(c)
                            }
                        }
                    )
                    .plainRow()
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        Button(role: .destructive) {
                            vm.removeContact(c)
                        } label: {
                            Label("Отменить", systemImage: "xmark")
                        }
                    }
                }
            } header: {
                Text("Ожидание подтверждения")
            }
        }
    }

    /// Друзья по буквам алфавита. Бокового индекса в SwiftUI нет — только секции-буквы.
    @ViewBuilder
    private var contactSections: some View {
        if vm.ui.loading {
            Section {
                LoadingRow().plainRow()
            }
        } else {
            ForEach(letterGroups) { group in
                Section {
                    ForEach(group.contacts) { c in
                        contactRow(c)
                    }
                } header: {
                    Text(group.letter)
                }
            }
        }
    }

    /// Режим поиска: сначала совпадения среди друзей, затем найденные на сервере
    /// (с кнопкой «Добавить» — заявка по userId, логин наружу не выносим).
    @ViewBuilder
    private var searchSections: some View {
        if !localMatches.isEmpty {
            Section {
                ForEach(localMatches) { c in
                    contactRow(c)
                }
            } header: {
                Text("Мои контакты")
            }
        }

        if vm.ui.searching || !serverResults.isEmpty {
            Section {
                ForEach(serverResults) { user in
                    PersonRow(
                        user: user,
                        // Логин не показываем — это секрет входа (веб-правило: только EBLID).
                        subtitle: user.online ? "в сети" : "Пользователь Еблуши",
                        subtitleColor: user.online ? Eb.online : nil,
                        onTap: { showCard(user) },
                        onAvatarTap: nil,
                        actions: {
                            MiniButton(icon: "person.badge.plus", description: "Добавить", filled: true) {
                                vm.addById(userId: user.id)
                            }
                        }
                    )
                    .plainRow()
                    .swipeActions(edge: .leading, allowsFullSwipe: true) {
                        Button {
                            vm.addById(userId: user.id)
                        } label: {
                            Label("Добавить", systemImage: "person.badge.plus")
                        }
                        .tint(Eb.brand)
                    }
                }
                if vm.ui.searching {
                    LoadingRow().plainRow()
                }
            } header: {
                Text("Поиск в Еблуше")
            }
        }
    }

    /// Строка друга: тап — написать (диалог), аватар — карточка, свайп и долгое нажатие —
    /// секретный чат и удаление. Набор действий тот же, что раньше был кнопками в строке.
    private func contactRow(_ c: Contact) -> some View {
        PersonRow(
            user: c.user,
            subtitle: c.user.online ? "в сети" : "не в сети",
            subtitleColor: c.user.online ? Eb.online : nil,
            onTap: { vm.startDm(userId: c.user.id, onOpened: onOpenConversation) },
            onAvatarTap: { showCard(c.user) },
            actions: { EmptyView() }
        )
        .plainRow()
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button(role: .destructive) {
                contactToRemove = c
            } label: {
                Label("Удалить", systemImage: "person.badge.minus")
            }
            Button {
                vm.startSecret(userId: c.user.id, onOpened: onOpenConversation)
            } label: {
                Label("Секретный чат", systemImage: "lock.fill")
            }
            .tint(Eb.brand)
        }
        .contextMenu {
            Button {
                vm.startDm(userId: c.user.id, onOpened: onOpenConversation)
            } label: {
                Label("Написать", systemImage: "bubble.left.fill")
            }
            Button {
                vm.startSecret(userId: c.user.id, onOpened: onOpenConversation)
            } label: {
                Label("Секретный чат", systemImage: "lock.fill")
            }
            Button {
                showCard(c.user)
            } label: {
                Label("Профиль", systemImage: "person.crop.circle")
            }
            Divider()
            Button(role: .destructive) {
                contactToRemove = c
            } label: {
                Label("Удалить из контактов", systemImage: "person.badge.minus")
            }
        }
    }

    /// Пустые состояния поверх списка: нет друзей вовсе / по запросу никого не нашли.
    @ViewBuilder
    private var emptyState: some View {
        if showEmpty {
            ContentUnavailableView {
                Label("Контактов пока нет", systemImage: "person.2")
            } description: {
                Text("Найдите друга по EBLID или отсканируйте его QR-код.")
            } actions: {
                Button("Добавить контакт") { showAdd = true }
                    .buttonStyle(.borderedProminent)
            }
        } else if showNoResults {
            ContentUnavailableView.search(text: query)
        }
    }
}

// MARK: - Строка человека (друг, заявка, результат поиска)

private struct PersonRow<Actions: View>: View {
    let user: ChatUser
    let subtitle: String
    let subtitleColor: Color?
    let onTap: () -> Void
    /// Отдельное действие по аватару (карточка профиля), если задано.
    let onAvatarTap: (() -> Void)?
    let actions: Actions

    init(
        user: ChatUser,
        subtitle: String,
        subtitleColor: Color? = nil,
        onTap: @escaping () -> Void,
        onAvatarTap: (() -> Void)?,
        @ViewBuilder actions: () -> Actions
    ) {
        self.user = user
        self.subtitle = subtitle
        self.subtitleColor = subtitleColor
        self.onTap = onTap
        self.onAvatarTap = onAvatarTap
        self.actions = actions()
    }

    var body: some View {
        HStack(spacing: 12) {
            if let onAvatarTap {
                // Кнопка внутри строки с onTapGesture: вложенный жест побеждает внешний,
                // поэтому аватар открывает карточку, а остальная строка — своё действие.
                Button(action: onAvatarTap) { avatar }
                    .buttonStyle(.plain)
            } else {
                avatar
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(user.name)
                    .fontWeight(.semibold)
                    .foregroundStyle(Eb.textPrimary)
                    .lineLimit(1)
                Text(subtitle)
                    .font(.footnote)
                    .foregroundStyle(subtitleColor ?? Eb.textMuted)
                    .lineLimit(1)
            }
            Spacer(minLength: 4)
            HStack(spacing: 6) { actions }
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
        .onTapGesture(perform: onTap)
        .accessibilityAddTraits(.isButton)
    }

    private var avatar: some View {
        ZStack(alignment: .bottomTrailing) {
            AvatarView(name: user.name, avatarUrl: user.avatarUrl, size: 44)
            // Кольцо под цвет фона экрана, чтобы значок не «висел» на серой подложке.
            PresenceBadge(
                userId: user.id,
                status: user.online ? "ONLINE" : "OFFLINE",
                onlineFallback: user.online,
                ringSize: 14,
                dotSize: 9,
                ringColor: Eb.paper
            )
        }
    }
}

// MARK: - Мини-кнопка действия строки

/// Стиль `.plain` обязателен: внутри строки List кнопка с системным стилем срабатывала
/// бы от тапа по всей строке, а нам нужен именно тап по кнопке.
private struct MiniButton: View {
    let icon: String
    let description: String
    var tint: Color = Eb.textPrimary
    var filled = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            ZStack {
                RoundedRectangle(cornerRadius: 10).fill(filled ? Eb.brand : Eb.surface100)
                RoundedRectangle(cornerRadius: 10).strokeBorder(filled ? Eb.brand : Eb.borderStrong)
                Image(systemName: icon)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(filled ? .white : tint)
            }
            .frame(width: 36, height: 36)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(description)
    }
}

// MARK: - Лист «Добавить»

/// Всё, что раньше жило над списком: ввод EBLID, QR-сканер и карточки «Мой EBLID» /
/// «Код регистрации». Тот же ViewModel — сообщения vm.ui.info/error видны прямо здесь.
private struct AddContactSheet: View {
    @ObservedObject var vm: ContactsViewModel

    @Environment(\.dismiss) private var dismiss
    @State private var code = ""
    @State private var showScanner = false
    @FocusState private var codeFocused: Bool

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("EBLID друга", text: $code)
                        .foregroundStyle(Eb.textPrimary)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.send)
                        .focused($codeFocused)
                        .onSubmit(submit)
                    Button(action: submit) {
                        Label("Отправить запрос", systemImage: "paperplane.fill")
                    }
                    .disabled(code.trimmed().isEmpty)
                    // Вход в сканер: разрешение камеры уже в Info.plist.
                    Button {
                        showScanner = true
                    } label: {
                        Label("Сканировать QR-код", systemImage: "qrcode.viewfinder")
                    }
                } header: {
                    Text("Добавить друга")
                } footer: {
                    Text("EBLID — номер в профиле друга. Введите его или наведите камеру на QR-код: другу придёт запрос в друзья.")
                }
                .listRowBackground(Eb.surface100)

                if vm.ui.info != nil || vm.ui.error != nil {
                    Section {
                        if let info = vm.ui.info {
                            Label(info, systemImage: "checkmark.circle.fill")
                                .foregroundStyle(Eb.brand)
                        }
                        if let error = vm.ui.error {
                            Label(error, systemImage: "exclamationmark.triangle.fill")
                                .foregroundStyle(Eb.error)
                        }
                    }
                    .listRowBackground(Eb.surface100)
                }

                Section {
                    HStack {
                        Text(vm.ui.myEblid ?? "—")
                            .font(.title3.weight(.bold))
                            .foregroundStyle(Eb.textPrimary)
                            .textSelection(.enabled)
                        Spacer()
                        if let eblid = vm.ui.myEblid {
                            CopyButton(text: eblid)
                        }
                    }
                } header: {
                    Text("Мой EBLID")
                } footer: {
                    Text("Отправьте его другу — по нему вас найдут и добавят.")
                }
                .listRowBackground(Eb.surface100)

                Section {
                    InviteCodeRow(
                        code: vm.ui.invite?.code,
                        expiresAtMs: vm.ui.invite?.expiresAtMs,
                        refreshing: vm.ui.inviteRefreshing,
                        onRefresh: { vm.refreshInvite() }
                    )
                } header: {
                    Text("Код регистрации")
                } footer: {
                    Text("По этому коду новый человек регистрируется в Еблуше, а вы будете указаны как пригласивший. Код обновляется по таймеру.")
                }
                .listRowBackground(Eb.surface100)
            }
            .scrollContentBackground(.hidden)
            .background(Eb.paper)
            .navigationTitle("Новый контакт")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Готово") { dismiss() }
                }
            }
            // Сканер — листом поверх этого листа; результат идёт тем же путём, что ручной ввод.
            .sheet(isPresented: $showScanner) {
                QrScanSheet { text in
                    showScanner = false
                    // QR несёт EBLID — добавляем как identifier (тот же путь, что ручной ввод).
                    vm.add(identifier: text)
                }
            }
        }
        .tint(Eb.brand)
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    private func submit() {
        let value = code.trimmed()
        guard !value.isEmpty else { return }
        codeFocused = false
        vm.add(identifier: value)
        code = ""
    }
}

/// Копирование в буфер. `.borderless`, чтобы в одной строке Form соседние кнопки
/// срабатывали по отдельности, а не все разом от тапа по строке.
private struct CopyButton: View {
    let text: String

    var body: some View {
        Button {
            UIPasteboard.general.string = text
        } label: {
            Image(systemName: "doc.on.doc")
                .foregroundStyle(Eb.brand)
                .frame(width: 28, height: 28)
        }
        .buttonStyle(.borderless)
        .accessibilityLabel("Копировать")
    }
}

/// Код регистрации с обратным отсчётом, копированием и ручным обновлением.
private struct InviteCodeRow: View {
    let code: String?
    let expiresAtMs: Int64?
    let refreshing: Bool
    let onRefresh: () -> Void

    @State private var remaining: Int64 = 0

    var body: some View {
        HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text(code ?? "—")
                    .font(.title3.weight(.bold))
                    .foregroundStyle(Eb.textPrimary)
                    .textSelection(.enabled)
                if expiresAtMs != nil && remaining > 0 {
                    Text("Обновится через \(formatCountdown(remaining))")
                        .monospacedDigit()
                        .font(.caption)
                        .foregroundStyle(Eb.brand)
                }
            }
            Spacer()
            if let code {
                CopyButton(text: code)
            }
            Button(action: onRefresh) {
                Group {
                    if refreshing {
                        ProgressView().controlSize(.small)
                    } else {
                        Image(systemName: "arrow.clockwise")
                            .foregroundStyle(Eb.brand)
                    }
                }
                .frame(width: 28, height: 28)
            }
            .buttonStyle(.borderless)
            .disabled(refreshing)
            .accessibilityLabel("Обновить")
        }
        // Порт LaunchedEffect(code, expiresAtMs): тикаем раз в секунду, на нуле — refresh.
        .task(id: "\(code ?? "")_\(expiresAtMs ?? 0)") {
            guard let expiresAtMs else { return }
            while !Task.isCancelled {
                remaining = expiresAtMs - Int64(Date().timeIntervalSince1970 * 1000)
                if remaining <= 0 {
                    onRefresh()
                    break
                }
                try? await Task.sleep(for: .seconds(1))
            }
        }
    }
}

// MARK: - Вспомогательные

/// Уведомление в списке (info/ошибка ViewModel) с крестиком — раньше эти тексты
/// висели над списком и не убирались никогда.
private struct NoticeRow: View {
    let text: String
    let icon: String
    let color: Color
    let onClose: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: icon)
                .foregroundStyle(color)
            Text(text)
                .font(.subheadline)
                .foregroundStyle(Eb.textPrimary)
            Spacer(minLength: 4)
            Button(action: onClose) {
                Image(systemName: "xmark")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Eb.textMuted)
                    .frame(width: 28, height: 28)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Закрыть")
        }
    }
}

private struct LoadingRow: View {
    var body: some View {
        HStack {
            Spacer()
            ProgressView().controlSize(.small)
            Spacer()
        }
        .padding(.vertical, 8)
    }
}

private extension View {
    /// Строка списка — та же карточка, что у бесед и у веб-плитки `.tile`: surface-200,
    /// радиус 12, поле 10, кант 1.5, поля от краёв экрана 16. Фон рисует сама строка:
    /// listRowBackground растягивается на всю ширину и упирался бы в края экрана.
    func plainRow() -> some View {
        padding(10)
            .background(Eb.surface200, in: RoundedRectangle(cornerRadius: 12))
            .overlay {
                RoundedRectangle(cornerRadius: 12)
                    .strokeBorder(Eb.borderStrong, lineWidth: 1.5)
            }
            .shadow(color: .black.opacity(0.12), radius: 4, y: 2)
            .padding(.horizontal, 16)
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
            .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
    }
}

// MARK: - Группировка по буквам

private struct LetterGroup: Identifiable {
    let letter: String
    let contacts: [Contact]
    var id: String { letter }
}

/// Друзья по алфавиту с заголовками-буквами; имена не с буквы — в «#» в конце, как в
/// системных Контактах. Сравнение локализованное, чтобы «Ё» стояла рядом с «Е».
private func groupByLetter(_ contacts: [Contact]) -> [LetterGroup] {
    let sorted = contacts.sorted {
        $0.user.name.localizedCaseInsensitiveCompare($1.user.name) == .orderedAscending
    }
    var order: [String] = []
    var buckets: [String: [Contact]] = [:]
    for contact in sorted {
        let key = letterKey(contact.user.name)
        if buckets[key] == nil {
            order.append(key)
            buckets[key] = []
        }
        buckets[key]?.append(contact)
    }
    let letters = order.filter { $0 != "#" }
    let tail: [String] = order.contains("#") ? ["#"] : []
    return (letters + tail).map { LetterGroup(letter: $0, contacts: buckets[$0] ?? []) }
}

private func letterKey(_ name: String) -> String {
    guard let first = name.trimmed().first, first.isLetter else { return "#" }
    return String(first).uppercased()
}

private func formatCountdown(_ ms: Int64) -> String {
    let totalSec = max(ms / 1000, 0)
    return String(format: "%02d:%02d", totalSec / 60, totalSec % 60)
}
