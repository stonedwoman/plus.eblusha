import SwiftUI

// Порт `ui/chat/ChatListScreen.kt` в родной оболочке iOS: системная панель с крупным
// заголовком «Чаты», `.searchable`, `List` со свайпами и pull-to-refresh. Свои шапка,
// плитки «Беседа/Контакты» и строка профиля ушли — их заменили вкладки (см. HomeNavView),
// а пилюля версии переехала в SettingsView. Обновления в диалоге не портированы
// (iOS обновляется через TestFlight/App Store).

/// Веб-зелёный секретных чатов (#22c55e) — замок и кант.
private let secretGreen = Color(hex: 0x22C55E)

struct ChatListView: View {
    @ObservedObject var vm: ChatListViewModel
    let onOpenChat: (Conversation) -> Void
    let onNewGroup: () -> Void

    @State private var confirmDelete: Conversation?
    /// Универсальная карточка пользователя. Лист живёт у родителя (в SwiftUI sheet держит
    /// родитель, см. UserCardSheet). Из списка сейчас не вызывается — тап по аватару, как и по
    /// строке, открывает чат, а карточка доступна из шапки самого чата; точка входа сохранена.
    @State private var userCard: UserCardSeed?
    /// Строка системного поиска. Фильтр локальный: по названию и последнему сообщению.
    @State private var query = ""

    var body: some View {
        ZStack {
            Eb.paper.ignoresSafeArea()
            if vm.ui.loading {
                ProgressView()
            } else if let error = vm.ui.error, vm.ui.conversations.isEmpty {
                centeredMessage(error, retry: vm.refresh)
            } else if vm.ui.conversations.isEmpty {
                ContentUnavailableView(
                    "Чатов пока нет",
                    systemImage: "bubble.left.and.bubble.right",
                    description: Text("Напишите кому-нибудь из контактов или соберите беседу кнопкой справа сверху.")
                )
            } else if filtered.isEmpty {
                // Список есть, но под запрос ничего не подошло — системная заглушка поиска.
                ContentUnavailableView.search(text: query)
            } else {
                conversationList
            }
        }
        .navigationTitle("Чаты")
        .navigationBarTitleDisplayMode(.large)
        .searchable(text: $query, prompt: "Поиск по чатам")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button(action: onNewGroup) {
                    Image(systemName: "square.and.pencil")
                }
                .accessibilityLabel("Новая беседа")
            }
        }
        .alert(item: $confirmDelete) { target in
            deleteAlert(target)
        }
        .sheet(item: $userCard) { seed in
            UserCardSheet(
                seed: seed,
                onOpenConversation: { ref in
                    userCard = nil
                    Task { @MainActor in
                        onOpenChat(await AppContainer.shared.chatRepository.resolveRef(ref))
                    }
                },
                onDismiss: { userCard = nil }
            )
        }
    }

    // MARK: - Список

    /// Беседы под текущий запрос поиска; пустой запрос — весь список как есть.
    private var filtered: [Conversation] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else { return vm.ui.conversations }
        return vm.ui.conversations.filter { c in
            c.title.localizedCaseInsensitiveContains(q)
                || (c.lastMessageText?.localizedCaseInsensitiveContains(q) ?? false)
        }
    }

    private var conversationList: some View {
        // Секретка рисуется отступной строкой «СЕКРЕТНЫЙ ЧАТ» под облачной 1:1 того же
        // собеседника (репозиторий уже упорядочил) — имя пишем только сироте без родителя.
        let cloudPeerIds = Set(
            vm.ui.conversations
                .filter { !$0.isSecretV2 && !$0.isSecret && !$0.isGroup }
                .compactMap { $0.otherUserId }
        )
        return List {
            ForEach(filtered) { conversation in
                let hasCloudSibling = conversation.isSecretV2 &&
                    conversation.otherUserId.map { cloudPeerIds.contains($0) } == true
                // У секреток нет квитанций — «Прочитано» только облачным с непрочитанными.
                let canMarkRead = !conversation.isSecretV2 && conversation.unreadCount > 0

                ConversationRow(
                    c: conversation,
                    typing: vm.ui.typingConversations.contains(conversation.id),
                    hasCloudSibling: hasCloudSibling,
                    onTap: { onOpenChat(conversation) }
                )
                .listRowBackground(Color.clear)
                .listRowSeparatorTint(Eb.border)
                // Секретка с отступом под родителем — веб-паритет вложенности.
                .listRowInsets(EdgeInsets(
                    top: 8, leading: hasCloudSibling ? 32 : 16, bottom: 8, trailing: 16
                ))
                // Разделитель начинается под текстом, а не под аватаром — как в Сообщениях.
                .alignmentGuide(.listRowSeparatorLeading) { d in d[.leading] + 64 }
                .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                    // Первая кнопка — у края экрана и на полном свайпе; удаление всё равно
                    // идёт через подтверждение (confirmDelete), случайный свайп безопасен.
                    Button(role: .destructive) {
                        confirmDelete = conversation
                    } label: {
                        Label(deleteShortTitle(conversation), systemImage: "trash")
                    }
                    if canMarkRead {
                        Button {
                            vm.markConversationRead(conversation)
                        } label: {
                            Label("Прочитано", systemImage: "checkmark.circle")
                        }
                        .tint(Eb.brand)
                    }
                }
                .contextMenu {
                    if canMarkRead {
                        Button {
                            vm.markConversationRead(conversation)
                        } label: {
                            Label("Отметить прочитанным", systemImage: "checkmark.circle")
                        }
                    }
                    Button(role: .destructive) {
                        confirmDelete = conversation
                    } label: {
                        Label(deleteMenuTitle(conversation), systemImage: "trash")
                    }
                }
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(Eb.paper)
        .refreshable {
            // refresh() запускает загрузку в собственной Task и возвращается сразу — без
            // ожидания флага системный индикатор гас бы мгновенно. Ждём, пока ViewModel
            // снимет refreshing, но не дольше ~10 с. Всё на главном акторе, как и сама VM.
            await Task { @MainActor in
                vm.refresh()
                var ticks = 0
                repeat {
                    try? await Task.sleep(for: .milliseconds(250))
                    ticks += 1
                } while (vm.ui.refreshing || vm.ui.loading) && ticks < 40
            }.value
        }
    }

    // MARK: - Удаление

    /// Короткая подпись свайпа — совпадает с кнопкой подтверждения в алерте.
    private func deleteShortTitle(_ c: Conversation) -> String {
        if c.isSecretV2 { return "Закрыть" }
        if c.isGroup { return "Выйти" }
        return "Удалить"
    }

    /// Полная подпись пункта контекстного меню (как в прежней плитке).
    private func deleteMenuTitle(_ c: Conversation) -> String {
        if c.isSecretV2 { return "Закрыть секретный чат" }
        if c.isGroup { return "Выйти из беседы" }
        return "Удалить чат"
    }

    private func deleteAlert(_ target: Conversation) -> Alert {
        let (title, body, action): (String, String, String)
        if target.isSecretV2 {
            (title, body, action) = (
                "Закрыть секретный чат?",
                "Секретный чат будет закрыт и скрыт у всех участников.",
                "Закрыть"
            )
        } else if target.isGroup {
            (title, body, action) = (
                "Выйти из беседы?",
                "Беседа исчезнет из вашего списка, остальные участники останутся.",
                "Выйти"
            )
        } else {
            (title, body, action) = (
                "Удалить чат?",
                "Переписка будет удалена у всех участников безвозвратно.",
                "Удалить"
            )
        }
        return Alert(
            title: Text(title),
            message: Text(body),
            primaryButton: .destructive(Text(action)) { vm.deleteConversation(target) },
            secondaryButton: .cancel(Text("Отмена"))
        )
    }

    // MARK: - Ошибка / повтор

    private func centeredMessage(_ text: String, retry: (() -> Void)?) -> some View {
        VStack(spacing: 12) {
            Text(text)
                .foregroundStyle(Eb.textMuted)
                .multilineTextAlignment(.center)
            if let retry {
                Button("Повторить", action: retry)
                    .buttonStyle(.borderedProminent)
                    .tint(Eb.brand)
            }
        }
        .padding(24)
    }
}

// MARK: - Строка беседы

/// Строка списка: аватар 52 с индикатором, название и время, последнее сообщение и бейдж
/// непрочитанных. Вся строка — кнопка, поэтому тап по аватару и по тексту ведёт в чат.
private struct ConversationRow: View {
    let c: Conversation
    var typing = false
    var hasCloudSibling = false
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: 12) {
                avatar

                VStack(alignment: .leading, spacing: 3) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        titleText
                        Spacer(minLength: 4)
                        if let at = c.lastMessageAt {
                            Text(formatListTime(at))
                                .font(.caption)
                                .foregroundStyle(c.unreadCount > 0 ? Eb.brand : Eb.textMuted)
                        }
                    }
                    HStack(spacing: 8) {
                        if let (subtitle, color) = subtitleLine {
                            Text(subtitle)
                                .font(.subheadline)
                                .foregroundStyle(color)
                                .lineLimit(1)
                        }
                        Spacer(minLength: 4)
                        if c.unreadCount > 0 {
                            unreadBadge
                        }
                    }
                }
                // Одинаковая высота строк, даже когда второй строки текста нет.
                .frame(minHeight: 52)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private var avatar: some View {
        if c.isSecretV2 {
            // Секретный тред: замок ВМЕСТО аватара — без фото и точки присутствия.
            ZStack {
                Circle().fill(secretGreen.opacity(0.12))
                Circle().strokeBorder(secretGreen.opacity(0.45), lineWidth: 1.5)
                Image(systemName: "lock.fill")
                    .font(.system(size: 20))
                    .foregroundStyle(secretGreen)
            }
            .frame(width: 52, height: 52)
        } else {
            ZStack(alignment: .bottomTrailing) {
                AvatarView(name: c.title, avatarUrl: c.avatarUrl, size: 52)
                if c.isGroup {
                    GroupBadge()
                } else {
                    // Кольцо под цвет фона экрана, а не панели — иначе виден серый ободок.
                    PresenceBadge(
                        userId: c.otherUserId,
                        status: c.otherStatus ?? (c.online ? "ONLINE" : "OFFLINE"),
                        onlineFallback: c.online,
                        ringColor: Eb.paper
                    )
                }
            }
        }
    }

    private var titleText: some View {
        Group {
            if c.isSecretV2 {
                Text(hasCloudSibling ? "СЕКРЕТНЫЙ ЧАТ" : "СЕКРЕТНЫЙ ЧАТ · \(c.title)")
                    .font(.subheadline.weight(.semibold))
            } else {
                Text(c.isSecret ? "🔒 \(c.title)" : c.title)
                    .font(.body.weight(.semibold))
            }
        }
        .foregroundStyle(Eb.textPrimary)
        .lineLimit(1)
    }

    private var unreadBadge: some View {
        Text(c.unreadCount > 99 ? "99+" : "\(c.unreadCount)")
            .font(.caption2.weight(.bold))
            .foregroundStyle(.white)
            .padding(.horizontal, 6)
            .frame(minWidth: 22, minHeight: 22)
            .background(Eb.brand, in: Capsule())
    }

    /// Приоритет второй строки: «печатает…» → последнее сообщение → присутствие собеседника.
    /// У V2-секреток превью нет (шифртекст не показываем) — только индикатор набора.
    private var subtitleLine: (String, Color)? {
        if typing { return ("печатает…", Eb.brand) }
        if c.isSecretV2 { return nil }
        if let text = c.lastMessageText?.trimmingCharacters(in: .whitespacesAndNewlines),
           !text.isEmpty {
            return (text, c.unreadCount > 0 ? Eb.textPrimary : Eb.textMuted)
        }
        if c.isGroup { return nil }
        switch c.otherStatus?.uppercased() {
        case "ONLINE": return ("ОНЛАЙН", Eb.online)
        case "IN_CALL": return ("В ЗВОНКЕ", Eb.online)
        case "BACKGROUND": return ("В ФОНЕ", Eb.presenceBg)
        default:
            if c.online { return ("ОНЛАЙН", Eb.online) }
            if let lastSeen = c.otherLastSeen {
                return ("был(а) онлайн \(formatLastSeen(lastSeen))", Eb.textMuted)
            }
            return nil
        }
    }
}

/// Значок «группа» в углу аватара беседы — на месте точки присутствия у 1:1.
private struct GroupBadge: View {
    private let size: CGFloat = 18

    var body: some View {
        ZStack {
            Circle().fill(Eb.surface300)
            Circle().strokeBorder(Eb.paper, lineWidth: 2)
            Image(systemName: "person.2.fill")
                .font(.system(size: 8, weight: .semibold))
                .foregroundStyle(Eb.textMuted)
        }
        .frame(width: size, height: size)
        // Та же геометрия, что у PresenceBadge: юго-восток значка — в угол квадрата аватара.
        .offset(x: size * 0.146, y: size * 0.146)
    }
}

// MARK: - Время в строке

// Форматтеры создаются один раз (DateFormatter дорогой, а строк в списке десятки).
private let weekdayFormatter: DateFormatter = {
    let f = DateFormatter()
    f.locale = Locale(identifier: "ru_RU")
    f.timeZone = TimeZone.autoupdatingCurrent
    f.dateFormat = "EEE"
    return f
}()
private let shortDayFormatter: DateFormatter = {
    let f = DateFormatter()
    f.locale = Locale(identifier: "ru_RU")
    f.timeZone = TimeZone.autoupdatingCurrent
    f.dateFormat = "d MMM"
    return f
}()
private let shortDateFormatter: DateFormatter = {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.timeZone = TimeZone.autoupdatingCurrent
    f.dateFormat = "dd.MM.yy"
    return f
}()

/// Время последнего сообщения, как в системных Сообщениях: сегодня — «ЧЧ:ММ», вчера —
/// «Вчера», на этой неделе — день недели, в этом году — «7 сент.», иначе — «07.09.25».
private func formatListTime(_ millis: Int64) -> String {
    let date = Date(timeIntervalSince1970: Double(millis) / 1000)
    let calendar = Calendar.current
    if calendar.isDateInToday(date) { return formatClockTime(millis) }
    if calendar.isDateInYesterday(date) { return "Вчера" }
    let now = Date()
    let today = calendar.startOfDay(for: now)
    if let weekStart = calendar.date(byAdding: .day, value: -6, to: today), date >= weekStart {
        return weekdayFormatter.string(from: date)
    }
    if calendar.isDate(date, equalTo: now, toGranularity: .year) {
        return shortDayFormatter.string(from: date)
    }
    return shortDateFormatter.string(from: date)
}
