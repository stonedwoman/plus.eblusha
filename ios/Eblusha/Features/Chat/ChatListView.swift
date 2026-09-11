import SwiftUI

// Порт `ui/chat/ChatListScreen.kt`: наша брендовая шапка сверху, `List` со свайпами и
// pull-to-refresh посередине, внизу — панель плиток «Беседа/Контакты» и строка профиля
// с пилюлей версии. Системные вкладки и карандаш в панели навигации пробовали и убрали:
// стеклянные «пузыри» iOS 26 не вязались с интерфейсом. Обновления в диалоге не
// портированы (iOS обновляется через TestFlight/App Store).

private let offlineDot = Color(hex: 0x6B7280)
private let groupGreen = Color(hex: 0x22C55E)
private let contactsPurple = Color(hex: 0x8B5CF6)
/// Веб-зелёный секретных чатов (#22c55e) — замок и кант.
private let secretGreen = Color(hex: 0x22C55E)

struct ChatListView: View {
    @ObservedObject var vm: ChatListViewModel
    let onOpenChat: (Conversation) -> Void
    let onOpenContacts: () -> Void
    let onOpenSettings: () -> Void
    let onNewGroup: () -> Void

    @State private var confirmDelete: Conversation?
    /// Универсальная карточка пользователя. Лист живёт у родителя (в SwiftUI sheet держит
    /// родитель, см. UserCardSheet). Из списка сейчас не вызывается — тап по аватару, как и по
    /// строке, открывает чат, а карточка доступна из шапки самого чата; точка входа сохранена.
    @State private var userCard: UserCardSeed?
    var body: some View {
        VStack(spacing: 0) {
            // Брендовая шапка вместо системной панели — как панель списка веба.
            VStack(spacing: 0) {
                AnimatedWordmark()
                Text("Здесь мы общаемся")
                    .font(.caption)
                    .foregroundStyle(Eb.textMuted)
            }
            .padding(.top, 10)
            .padding(.bottom, 12)

            ZStack {
                if vm.ui.loading {
                    ProgressView()
                } else if let error = vm.ui.error, vm.ui.conversations.isEmpty {
                    centeredMessage(error, retry: vm.refresh)
                } else if vm.ui.conversations.isEmpty {
                    ContentUnavailableView(
                        "Чатов пока нет",
                        systemImage: "bubble.left.and.bubble.right",
                        description: Text("Напишите кому-нибудь из контактов или соберите беседу плиткой внизу.")
                    )
                } else {
                    conversationList
                }
            }
            .frame(maxHeight: .infinity)

            bottomPanel
        }
        .background(Eb.paper.ignoresSafeArea())
        // Своя шапка и своя нижняя панель — системную панель навигации здесь не показываем.
        // Заголовок при скрытой панели не рисуется, но питает подпись кнопки «назад»
        // на пушащихся экранах: «Чаты» вместо безликого «Назад».
        .navigationTitle("Чаты")
        .toolbar(.hidden, for: .navigationBar)
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

    private var conversationList: some View {
        // Секретка рисуется отступной строкой «СЕКРЕТНЫЙ ЧАТ» под облачной 1:1 того же
        // собеседника (репозиторий уже упорядочил) — имя пишем только сироте без родителя.
        let cloudPeerIds = Set(
            vm.ui.conversations
                .filter { !$0.isSecretV2 && !$0.isSecret && !$0.isGroup }
                .compactMap { $0.otherUserId }
        )
        return List {
            ForEach(vm.ui.conversations) { conversation in
                let hasCloudSibling = conversation.isSecretV2 &&
                    conversation.otherUserId.map { cloudPeerIds.contains($0) } == true
                // У секреток нет квитанций — «Прочитано» только облачным с непрочитанными.
                let canMarkRead = !conversation.isSecretV2 && conversation.unreadCount > 0

                // Идущий звонок в беседе: подсветка строки, подпись и кнопка входа.
                let call = vm.callTile(for: conversation.id)

                ConversationRow(
                    c: conversation,
                    typing: vm.ui.typingConversations.contains(conversation.id),
                    hasCloudSibling: hasCloudSibling,
                    call: call,
                    onTap: { onOpenChat(conversation) },
                    onJoinCall: { vm.joinCall(conversation) }
                )
                .listRowBackground(callRowBackground(call))
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

    /// Плитка беседы со звонком заливается оранжевым — порт веб-градиента
    /// (ConversationListPane.tsx:224-240); свой звонок заметно теплее чужого.
    @ViewBuilder
    private func callRowBackground(_ call: CallTile?) -> some View {
        if let call, call.kind != .ended {
            Eb.brand.opacity(call.mine || call.participating ? 0.16 : 0.10)
        } else {
            Color.clear
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
        // Тексты общие с шапкой открытого чата (ConversationRemovalPrompt): пока они
        // лежали в двух вьюхах, одно и то же действие спрашивалось по-разному.
        let (title, body, action) = ConversationRemovalPrompt.texts(
            isSecret: target.isSecretV2, isGroup: target.isGroup
        )
        return Alert(
            title: Text(title),
            message: Text(body),
            primaryButton: .destructive(Text(action)) { vm.deleteConversation(target) },
            secondaryButton: .cancel(Text("Отмена"))
        )
    }

    // MARK: - Нижняя панель: плитки и профиль

    /// Плитки «Беседа»/«Контакты» и строка профиля — наш вариант «вкладок», как в панели
    /// списка веба. Строка профиля целиком ведёт в настройки; справа — версия и метка сборки
    /// (у отладочной — хеш коммита), иначе на телефоне сборки не отличить.
    private var bottomPanel: some View {
        let me = AppContainer.shared.sessionStore.currentUser()
        let myName = me?.displayName?.isEmpty == false ? me!.displayName! : (me?.username ?? "Профиль")
        let (statusLabel, statusColor) = selfPresenceLabel(vm.ui.selfPresence)
        let version = (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? "?"
        let buildTag = (Bundle.main.infoDictionary?["EblushaBuildTag"] as? String)?
            .trimmingCharacters(in: .whitespaces) ?? ""

        return VStack(spacing: 8) {
            HStack(spacing: 10) {
                actionTile(
                    iconBackground: groupGreen, icon: "plus",
                    title: "Беседа", subtitle: "Групповой чат", action: onNewGroup
                )
                actionTile(
                    iconBackground: contactsPurple, icon: "person.2.fill",
                    title: "Контакты", subtitle: "Список контактов", action: onOpenContacts
                )
            }
            HStack(spacing: 10) {
                ZStack(alignment: .bottomTrailing) {
                    AvatarView(name: myName, avatarUrl: me?.avatarUrl, size: 40)
                    // Своё присутствие: та же иконка устройства, что видят собеседники.
                    PresenceBadge(
                        userId: me?.id, status: vm.ui.selfPresence,
                        ringSize: 14, dotSize: 9
                    )
                }
                VStack(alignment: .leading, spacing: 1) {
                    Text(myName)
                        .fontWeight(.semibold)
                        .foregroundStyle(Eb.textPrimary)
                        .lineLimit(1)
                    Text(statusLabel)
                        .font(.footnote)
                        .foregroundStyle(statusColor)
                }
                Spacer()
                Text(buildTag.isEmpty ? "v \(version)" : "v \(version) · \(buildTag)")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Eb.textMuted)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 7)
                    .background(Eb.surface300, in: Capsule())
                    .overlay(Capsule().strokeBorder(Eb.borderStrong))
            }
            .padding(10)
            .background(Eb.surface200, in: RoundedRectangle(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Eb.borderStrong))
            .contentShape(Rectangle())
            .onTapGesture(perform: onOpenSettings)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
    }

    private func actionTile(
        iconBackground: Color, icon: String, title: String, subtitle: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 10) {
                ZStack {
                    Circle().fill(iconBackground)
                    Image(systemName: icon)
                        .foregroundStyle(.white)
                        .font(.system(size: 17, weight: .semibold))
                }
                .frame(width: 40, height: 40)
                VStack(alignment: .leading, spacing: 1) {
                    Text(title)
                        .fontWeight(.semibold)
                        .foregroundStyle(Eb.textPrimary)
                        .lineLimit(1)
                    Text(subtitle)
                        .font(.footnote)
                        .foregroundStyle(Eb.textMuted)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            .padding(12)
            .background(Eb.surface200, in: RoundedRectangle(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Eb.borderStrong))
        }
        .buttonStyle(.plain)
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

/// Своё присутствие → (метка, цвет) для своей строки, зеркало веб-точки статуса.
private func selfPresenceLabel(_ status: String) -> (String, Color) {
    switch status.uppercased() {
    case "ONLINE": return ("в сети", Eb.online)
    case "BACKGROUND": return ("в фоне", Eb.presenceBg)
    case "AWAY": return ("не активен", Eb.away)
    case "IN_CALL": return ("в звонке", Eb.online)
    default: return ("не в сети", offlineDot)
    }
}

/// Логотип с периодическим переворотом «Б» — зеркало веб-`.logo .b { animation: flipY 5s }`.
struct AnimatedWordmark: View {
    @State private var flip = false

    var body: some View {
        HStack(spacing: 0) {
            Text("Е").foregroundStyle(Eb.logoCream)
            Text("Б")
                .foregroundStyle(Eb.logoB)
                .rotation3DEffect(
                    .degrees(flip ? 360 : 0),
                    axis: (x: 0, y: 1, z: 0),
                    perspective: 0.5
                )
            Text("луша").foregroundStyle(Eb.logoCream)
        }
        .font(.system(size: 34, weight: .heavy))
        .task {
            // Цикл 5 с: 85% покоя, затем полный оборот (как keyframes в оригинале).
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
}

// MARK: - Строка беседы

/// Строка списка: аватар 52 с индикатором, название и время, вторая строка (статус +
/// превью) и бейдж непрочитанных. Сама строка — кнопка, поэтому тап по аватару и по
/// тексту ведёт в чат; кнопка входа в звонок живёт РЯДОМ с ней, а не внутри.
private struct ConversationRow: View {
    let c: Conversation
    var typing = false
    var hasCloudSibling = false
    /// Звонок в этой беседе (nil — звонка нет); считает ChatListViewModel.callTile.
    var call: CallTile?
    let onTap: () -> Void
    var onJoinCall: () -> Void = {}

    /// Во что играет собеседник (веб пишет это прямо в подзаголовок плитки).
    @ObservedObject private var presenceGames = PresenceGames.shared

    var body: some View {
        // Кнопка звонка — СОСЕД строки, а не вложенная кнопка: вложенная в строке
        // списка тапа не получает, его забирает внешняя.
        HStack(spacing: 10) {
            Button(action: onTap) { rowContent }
                .buttonStyle(.plain)
            if let call, call.kind != .ended {
                joinButton(call)
            }
        }
    }

    private var rowContent: some View {
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
                    subtitleLine
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

    /// «Подключиться» / «Тоже сюда» / «Вернуться» — веб-подписи кнопок шапки
    /// (MessagesPane.tsx:1041-1043), сжатые до ширины плитки.
    private func joinButton(_ call: CallTile) -> some View {
        let label = call.mine ? "Вернуться" : (call.participating ? "Тоже сюда" : "Подключиться")
        return Button(action: onJoinCall) {
            HStack(spacing: 5) {
                Image(systemName: call.mine ? "arrow.up.left.and.arrow.down.right" : "phone.fill")
                    .font(.system(size: 11, weight: .bold))
                Text(label)
                    .font(.caption2.weight(.bold))
                    .lineLimit(1)
            }
            .foregroundStyle(.white)
            .padding(.horizontal, 10)
            .frame(height: 30)
            .background(Eb.brand, in: Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(call.mine ? "Вернуться в звонок" : "Присоединиться к звонку")
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
                    // В группе точки присутствия нет, поэтому идущий звонок показываем
                    // трубкой вместо значка группы (веб даёт аватару presence IN_CALL).
                    if call?.kind == .ongoing { CallBadge() } else { GroupBadge() }
                } else if peerGame != nil {
                    // Играющий получает геймпад ВМЕСТО точки — как avatarPresenceForUser
                    // веба (Avatar.tsx:247-270); красный, если он ещё и в звонке.
                    GamePresenceBadge(
                        inCall: c.otherStatus?.uppercased() == "IN_CALL",
                        ringSize: 18,
                        ringColor: Eb.paper
                    )
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

    /// Вторая строка плитки: статус беседы И превью последнего сообщения вместе.
    ///
    /// В вебе здесь ТОЛЬКО статус — «печатает» → состояние звонка → присутствие, а текста
    /// сообщения в списке нет вовсе (ConversationListPane.tsx:308-383). На телефоне
    /// превью — главный ориентир списка, терять его нельзя. Поэтому: живой статус идёт
    /// короткой меткой-префиксом, превью — за ней и усекается первым. Звонок вытесняет
    /// превью целиком (как в вебе): строка и так занята таймером и кнопкой входа.
    /// Веб-ветку «N непрочитанных» не повторяем — справа уже висит числовой бейдж.
    @ViewBuilder
    private var subtitleLine: some View {
        if typing {
            Text("печатает…")
                .font(.subheadline)
                .foregroundStyle(Eb.brand)
                .lineLimit(1)
        } else if let call, call.kind != .ended {
            callLine(call)
        } else {
            HStack(spacing: 6) {
                if let (tag, color) = statusTag {
                    Text(tag)
                        .font(.caption.weight(.bold))
                        .foregroundStyle(color)
                        .lineLimit(1)
                        // Метка статуса короткая и не должна усекаться раньше превью.
                        .layoutPriority(1)
                }
                if let preview {
                    Text(preview)
                        .font(.subheadline)
                        .foregroundStyle(c.unreadCount > 0 ? Eb.textPrimary : Eb.textMuted)
                        .lineLimit(1)
                }
            }
        }
    }

    /// Состояние звонка словами веба: «Звоним...», «В ЗВОНКЕ: m:ss» (только участнику —
    /// длительность конфиденциальна), «В ЗВОНКЕ» остальным.
    @ViewBuilder
    private func callLine(_ call: CallTile) -> some View {
        HStack(spacing: 5) {
            Image(systemName: "phone.fill")
                .font(.system(size: 11, weight: .bold))
            if call.kind == .dialing {
                Text("Звоним…")
            } else if call.participating, let startedAt = call.startedAt {
                // Таймер тикает локально: сервер шлёт только момент начала.
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    Text("В ЗВОНКЕ: " + callDurationLabel(
                        since: Date(timeIntervalSince1970: Double(startedAt) / 1000),
                        now: context.date
                    ))
                }
            } else {
                Text("В ЗВОНКЕ")
            }
        }
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(Eb.brand600)
        .lineLimit(1)
    }

    /// Короткая метка перед превью: «Завершён N назад» у только что закончившегося
    /// звонка, иначе присутствие собеседника (веб-подзаголовок плитки).
    private var statusTag: (String, Color)? {
        if let call, call.kind == .ended, let endedAt = call.endedAt {
            // Текст общий с шапкой беседы (ChatHeader.formatCallEndedLabel).
            return (formatCallEndedLabel(endedAt), Eb.brand600)
        }
        if c.isGroup || c.isSecretV2 { return nil }
        let status = c.otherStatus?.uppercased()
        // Игра вытесняет обычный статус — как formatPresence веба (ChatsPage.tsx:5902-5912).
        // Нет данных об игре (сервер не прислал presence:game) — нет и строки про неё.
        if let game = peerGame {
            if status == "IN_CALL" { return ("В ЗВОНКЕ И В \(game)", Eb.online) }
            if status == "ONLINE" || status == "BACKGROUND" || c.online {
                return ("ИГРАЕТ В \(game)", Eb.online)
            }
        }
        switch status {
        case "ONLINE": return ("ОНЛАЙН", Eb.online)
        case "IN_CALL": return ("В ЗВОНКЕ", Eb.online)
        case "BACKGROUND": return ("В ФОНЕ", Eb.presenceBg)
        default:
            if c.online { return ("ОНЛАЙН", Eb.online) }
            // «был(а) онлайн …» длинное и вытеснило бы превью, поэтому показываем его
            // только когда показывать больше нечего. Полная строка присутствия живёт в
            // шапке беседы — там она и в вебе.
            if preview == nil, let lastSeen = c.otherLastSeen {
                return ("был(а) онлайн \(formatLastSeen(lastSeen))", Eb.textMuted)
            }
            return nil
        }
    }

    private var peerGame: String? {
        guard !c.isGroup, let peer = c.otherUserId else { return nil }
        return presenceGames.games[peer]
    }

    /// Превью последнего сообщения; у V2-секреток его нет (шифртекст не показываем).
    private var preview: String? {
        guard !c.isSecretV2 else { return nil }
        let text = c.lastMessageText?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let text, !text.isEmpty else { return nil }
        return text
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

/// Значок «в беседе идёт звонок» — на месте значка группы, пока звонок жив.
/// Красный тот же, что у точки IN_CALL на аватарах (ebCallRed, веб #ef4444).
private struct CallBadge: View {
    private let size: CGFloat = 18

    var body: some View {
        ZStack {
            Circle().fill(ebCallRed)
            Circle().strokeBorder(Eb.paper, lineWidth: 2)
            Image(systemName: "phone.fill")
                .font(.system(size: 8, weight: .bold))
                .foregroundStyle(.white)
        }
        .frame(width: size, height: size)
        // Та же геометрия, что у PresenceBadge и GroupBadge.
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
