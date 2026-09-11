import SwiftUI
import PhotosUI

// Участники и настройки группы — порт двух модалок веба: «Добавить участников»
// (chats/render/ChatModals.tsx:3189-3226) и «Настройки группы» (ChatModals.tsx:3283-3400,
// смена аватара и названия). На телефоне они склеены в один экран: ходить между двумя
// шторками ради двух полей — хуже, чем один список с секциями.
//
// Чего в API нет и чего поэтому нет здесь (сверено по src/routes/conversations.ts):
//  - удалить ДРУГОГО участника: есть только DELETE /:id/participants/me (строка 829),
//    то есть «выйти самому» — этот пункт живёт в меню шапки беседы и не дублируется тут;
//  - ролей и админов нет вовсе: PATCH /:id (773) и POST /:id/participants (646) пускают
//    ЛЮБОГО участника беседы, права проверяются только по членству;
//  - состава участников веб вообще не показывает — здесь он есть, потому что на телефоне
//    это единственное место, где можно увидеть, кто в беседе.
//
// Экран рассчитан и на показ шторкой (ChatView оборачивает его в NavigationStack и
// передаёт showsCloseButton: true), и на пуш в общий стек (тогда showsCloseButton: false —
// назад уводит штатная кнопка).

/// Ручки, которых нет в ChatRepository: добавление участников и PATCH беседы. Живут
/// рядом с экраном, потому что больше их никто не зовёт; пути и тела — 1:1 с бэкендом.
/// (Тот же приём, что у PATCH в ProfileRepository и multipart в ChatRepositoryUploads:
/// собрать вызов из общего APIClient, не расширяя его публичную поверхность.)
private enum GroupApi {
    private struct AddRequest: Encodable { let participantIds: [String] }
    private struct PatchRequest: Encodable {
        var title: String?
        var avatarUrl: String?
    }
    /// Оба роута отвечают `{ conversation: … }`; тело нам не нужно, но декодер должен
    /// знать форму ответа.
    private struct ConversationEnvelope: Decodable { let conversation: ConversationDto }

    static func addParticipants(conversationId: String, ids: [String]) async -> ApiResult<Void> {
        await safeApiCall {
            let _: ConversationEnvelope = try await AppContainer.shared.api.post(
                "conversations/\(conversationId)/participants",
                body: AddRequest(participantIds: ids)
            )
        }
    }

    static func update(
        conversationId: String, title: String?, avatarUrl: String?
    ) async -> ApiResult<Void> {
        await safeApiCall {
            let _: ConversationEnvelope = try await AppContainer.shared.api.patch(
                "conversations/\(conversationId)",
                body: PatchRequest(title: title, avatarUrl: avatarUrl)
            )
        }
    }
}

@MainActor
final class GroupMembersViewModel: ObservableObject {

    struct UiState {
        var loading = true
        var members: [ChatUser] = []
        /// Друзья, которых в беседе ещё нет, — кандидаты на добавление.
        var candidates: [ChatUser] = []
        var selected: Set<String> = []
        /// Название в поле ввода (сохраняется отдельной кнопкой, как в вебе).
        var title = ""
        var avatarUrl: String?
        var savingTitle = false
        var uploadingAvatar = false
        var adding = false
        /// Найденный по EBL-ID человек вне списка друзей (веб-паритет режима поиска).
        var found: ChatUser?
        var searching = false
        var error: String?
        var notice: String?
    }

    @Published private(set) var ui = UiState()

    private let conversationId: String
    private let chats: ChatRepository
    private let contacts: ContactsRepository
    private let profile: ProfileRepository
    /// Сообщить открытому ChatView, что беседа изменилась: он держит Conversation
    /// значением и сам о правке не узнает. Зовётся ПОСЛЕ обновления списка бесед, то
    /// есть когда свежую запись уже можно взять из кеша репозитория.
    private let onUpdated: () -> Void
    private var noticeReset: Task<Void, Never>?

    init(
        conversation: Conversation,
        chats: ChatRepository = AppContainer.shared.chatRepository,
        contacts: ContactsRepository = AppContainer.shared.contactsRepository,
        profile: ProfileRepository = AppContainer.shared.profileRepository,
        onUpdated: @escaping () -> Void
    ) {
        self.conversationId = conversation.id
        self.chats = chats
        self.contacts = contacts
        self.profile = profile
        self.onUpdated = onUpdated
        ui.title = conversation.title
        ui.avatarUrl = conversation.avatarUrl
        load()
    }

    var meId: String? { chats.currentUserId() }

    func load() {
        Task {
            ui.loading = true
            let members = await chats.conversationMembers(conversationId)
            ui.members = members
            ui.loading = false
            // Список друзей нужен только для добавления — его сбой не должен ломать
            // просмотр состава, поэтому ошибку сюда не поднимаем.
            if case .success(let friends) = await contacts.listAccepted() {
                let known = Set(members.map(\.id))
                ui.candidates = friends.map(\.user).filter { !known.contains($0.id) }
            }
        }
    }

    func onTitleChange(_ value: String) { ui.title = value }

    func toggle(_ userId: String) {
        if ui.selected.contains(userId) {
            ui.selected.remove(userId)
        } else {
            ui.selected.insert(userId)
        }
    }

    /// Поиск по EBL-ID (4 цифры) или логину — тот же роут, что у «Добавить по ID» в вебе.
    /// Сервер короче двух символов не ищет, поэтому и мы не дёргаем его зря.
    func search(_ query: String) {
        let trimmed = query.trimmed()
        guard trimmed.count >= 2 else {
            ui.found = nil
            return
        }
        Task {
            ui.searching = true
            switch await contacts.search(trimmed) {
            case .success(let users):
                ui.searching = false
                // Уже в беседе или уже среди друзей-кандидатов — из поиска не берём.
                var known = Set(ui.members.map(\.id))
                known.formUnion(ui.candidates.map(\.id))
                ui.found = users.first { user in !known.contains(user.id) }
            case .failure(let message, _):
                ui.searching = false
                ui.error = message
            }
        }
    }

    func addSelected() {
        let ids = Array(ui.selected)
        guard !ids.isEmpty, !ui.adding else { return }
        Task {
            ui.adding = true
            ui.error = nil
            switch await GroupApi.addParticipants(conversationId: conversationId, ids: ids) {
            case .success:
                ui.adding = false
                ui.selected = []
                ui.found = nil
                showNotice(ids.count == 1 ? "Участник добавлен" : "Участники добавлены")
                // Состав и кеш беседы читаются из списка бесед — обновляем его, иначе
                // новый человек не появится ни здесь, ни в аватарах пузырей группы.
                _ = await chats.listConversations()
                load()
            case .failure(let message, _):
                ui.adding = false
                ui.error = message
            }
        }
    }

    func saveTitle() {
        let title = ui.title.trimmed()
        guard !title.isEmpty, !ui.savingTitle else { return }
        Task {
            ui.savingTitle = true
            ui.error = nil
            switch await GroupApi.update(
                conversationId: conversationId, title: title, avatarUrl: nil
            ) {
            case .success:
                ui.savingTitle = false
                showNotice("Название сохранено")
                await refreshConversations()
            case .failure(let message, _):
                ui.savingTitle = false
                ui.error = message
            }
        }
    }

    /// Аватар группы: сначала общий /upload (как у аватара профиля), потом PATCH беседы
    /// полученным прокси-URL. Кадрирование не делаем — веб его тоже делает только на ПК.
    func uploadAvatar(bytes: Data, mime: String) {
        guard !ui.uploadingAvatar else { return }
        Task {
            ui.uploadingAvatar = true
            ui.error = nil
            switch await profile.uploadAvatar(bytes: bytes, mime: mime) {
            case .success(let url):
                switch await GroupApi.update(
                    conversationId: conversationId, title: nil, avatarUrl: url
                ) {
                case .success:
                    ui.uploadingAvatar = false
                    ui.avatarUrl = url
                    showNotice("Аватар обновлён")
                    await refreshConversations()
                case .failure(let message, _):
                    ui.uploadingAvatar = false
                    ui.error = message
                }
            case .failure(let message, _):
                ui.uploadingAvatar = false
                ui.error = message
            }
        }
    }

    func clearError() { ui.error = nil }

    private func refreshConversations() async {
        _ = await chats.listConversations()
        onUpdated()
    }

    private func showNotice(_ text: String) {
        ui.notice = text
        noticeReset?.cancel()
        noticeReset = Task { [weak self] in
            try? await Task.sleep(for: .seconds(3))
            if !Task.isCancelled { self?.ui.notice = nil }
        }
    }
}

struct GroupMembersView: View {
    let conversation: Conversation
    /// Показывать «Закрыть» (шторка). При пуше в стек кнопку даёт сама навигация.
    var showsCloseButton = true
    var onClose: () -> Void = {}

    @StateObject private var vm: GroupMembersViewModel
    /// Строка поиска: фильтрует друзей локально и ищет по EBL-ID на сервере.
    @State private var query = ""
    @State private var avatarItem: PhotosPickerItem?

    init(
        conversation: Conversation,
        showsCloseButton: Bool = true,
        onClose: @escaping () -> Void = {},
        onUpdated: @escaping () -> Void = {}
    ) {
        self.conversation = conversation
        self.showsCloseButton = showsCloseButton
        self.onClose = onClose
        _vm = StateObject(wrappedValue: GroupMembersViewModel(
            conversation: conversation, onUpdated: onUpdated
        ))
    }

    var body: some View {
        List {
            headerSection
            statusSection
            membersSection
            addSection
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(Eb.paper)
        .scrollDismissesKeyboard(.interactively)
        .navigationTitle("Беседа")
        .navigationBarTitleDisplayMode(.inline)
        .searchable(
            text: $query,
            placement: .navigationBarDrawer(displayMode: .always),
            prompt: Text("Имя друга или ID (4 цифры)")
        )
        // Поиск по серверу дёргаем на изменение строки, а не по кнопке: у веба то же
        // поведение в режиме «Добавить по ID».
        .onChange(of: query) { _, value in vm.search(value) }
        .toolbar {
            if showsCloseButton {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Закрыть") { onClose() }
                }
            }
        }
    }

    // MARK: - Аватар и название

    private var headerSection: some View {
        Section {
            VStack(spacing: 10) {
                PhotosPicker(selection: $avatarItem, matching: .images) {
                    ZStack {
                        AvatarView(
                            name: vm.ui.title.isEmpty ? conversation.title : vm.ui.title,
                            avatarUrl: vm.ui.avatarUrl,
                            size: 96
                        )
                        if vm.ui.uploadingAvatar { ProgressView() }
                    }
                }
                // .plain — иначе List растянул бы зону нажатия на всю строку.
                .buttonStyle(.plain)
                .onChange(of: avatarItem) { _, item in
                    guard let item else { return }
                    avatarItem = nil
                    Task {
                        guard let bytes = try? await item.loadTransferable(type: Data.self) else { return }
                        let mime = item.supportedContentTypes
                            .compactMap(\.preferredMIMEType)
                            .first { $0.hasPrefix("image/") } ?? "image/jpeg"
                        vm.uploadAvatar(bytes: bytes, mime: mime)
                    }
                }

                Text("Нажмите на фото, чтобы изменить")
                    .font(.caption2)
                    .foregroundStyle(Eb.textMuted)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 8)
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)

            HStack(spacing: 10) {
                TextField(
                    "", text: titleBinding,
                    prompt: Text("Название группы").foregroundStyle(Eb.textMuted)
                )
                .foregroundStyle(Eb.textPrimary)
                .submitLabel(.done)
                .onSubmit { vm.saveTitle() }

                if vm.ui.savingTitle {
                    ProgressView()
                } else {
                    Button("Сохранить") { vm.saveTitle() }
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(titleChanged ? Eb.brand : Eb.textMuted)
                        .disabled(!titleChanged)
                }
            }
            .listRowBackground(Eb.surface100)
            .listRowSeparatorTint(Eb.border)
        } header: {
            Text("Настройки группы")
        }
    }

    // MARK: - Ошибка и итог действия

    @ViewBuilder
    private var statusSection: some View {
        if vm.ui.error != nil || vm.ui.notice != nil {
            Section {
                if let error = vm.ui.error {
                    Label(error, systemImage: "exclamationmark.triangle.fill")
                        .font(.footnote)
                        .foregroundStyle(Eb.error)
                        .listRowBackground(Eb.surface100)
                        .onTapGesture { vm.clearError() }
                }
                if let notice = vm.ui.notice {
                    Label(notice, systemImage: "checkmark.circle.fill")
                        .font(.footnote)
                        .foregroundStyle(Eb.online)
                        .listRowBackground(Eb.surface100)
                }
            }
        }
    }

    // MARK: - Состав

    private var membersSection: some View {
        Section {
            if vm.ui.loading && vm.ui.members.isEmpty {
                HStack {
                    Spacer()
                    ProgressView()
                    Spacer()
                }
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
            } else {
                ForEach(vm.ui.members) { member in
                    GroupMemberRow(user: member, isMe: member.id == vm.meId)
                        .listRowBackground(Eb.surface100)
                        .listRowSeparatorTint(Eb.border)
                }
            }
        } header: {
            Text(vm.ui.members.isEmpty ? "Участники" : "Участники · \(vm.ui.members.count)")
        }
    }

    // MARK: - Добавление

    private var addSection: some View {
        Section {
            if addable.isEmpty {
                // Пусто по двум разным причинам — говорим, по какой именно.
                ContentUnavailableView(
                    query.trimmed().isEmpty ? "Некого добавить" : "Никого не найдено",
                    systemImage: query.trimmed().isEmpty ? "person.2" : "magnifyingglass",
                    description: Text(
                        query.trimmed().isEmpty
                            ? "Все друзья уже в беседе. Человека не из списка друзей можно найти по его ID из четырёх цифр."
                            : "Среди друзей нет никого с именем «\(query.trimmed())», и по такому ID никто не найден."
                    )
                )
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
            } else {
                ForEach(addable) { user in
                    GroupCandidateRow(
                        user: user,
                        selected: vm.ui.selected.contains(user.id),
                        onTap: { withAnimation(.snappy) { vm.toggle(user.id) } }
                    )
                    .listRowBackground(Eb.surface100)
                    .listRowSeparatorTint(Eb.border)
                }
            }

            Button {
                vm.addSelected()
            } label: {
                HStack {
                    if vm.ui.adding {
                        ProgressView()
                    } else {
                        Text(
                            vm.ui.selected.isEmpty
                                ? "Добавить участников"
                                : "Добавить в беседу: \(vm.ui.selected.count)"
                        )
                        .fontWeight(.semibold)
                    }
                }
                .frame(maxWidth: .infinity)
            }
            .disabled(vm.ui.selected.isEmpty || vm.ui.adding)
            .foregroundStyle(vm.ui.selected.isEmpty ? Eb.textMuted : Eb.brand)
            .listRowBackground(Eb.surface100)
        } header: {
            HStack(spacing: 6) {
                Text("Добавить участников")
                if vm.ui.searching { ProgressView().controlSize(.mini) }
            }
        } footer: {
            Text("Добавлять участников может любой, кто состоит в беседе. Убрать человека из беседы сервер пока не умеет — выйти можно только самому.")
        }
    }

    // MARK: - Производные данные

    private var titleBinding: Binding<String> {
        Binding(get: { vm.ui.title }, set: { vm.onTitleChange($0) })
    }

    private var titleChanged: Bool {
        let value = vm.ui.title.trimmed()
        return !value.isEmpty && value != conversation.title
    }

    /// Кандидаты: друзья вне беседы под фильтром строки поиска плюс найденный по ID.
    private var addable: [ChatUser] {
        let q = query.trimmed()
        var list = q.isEmpty
            ? vm.ui.candidates
            : vm.ui.candidates.filter { $0.name.localizedCaseInsensitiveContains(q) }
        if let found = vm.ui.found, !list.contains(where: { $0.id == found.id }) {
            list.append(found)
        }
        return list
    }
}

/// Строка состава: аватар с точкой присутствия, имя, пометка «вы».
private struct GroupMemberRow: View {
    let user: ChatUser
    let isMe: Bool

    var body: some View {
        HStack(spacing: 12) {
            ZStack(alignment: .bottomTrailing) {
                AvatarView(name: user.name, avatarUrl: user.avatarUrl, size: 40)
                // Состав приходит из списка бесед, где известен только факт «онлайн»;
                // точное устройство добавит PresenceBadge из своей карты.
                PresenceBadge(
                    userId: user.id,
                    status: user.online ? "ONLINE" : "OFFLINE",
                    onlineFallback: user.online,
                    ringColor: Eb.surface100
                )
            }
            Text(user.name)
                .font(.body)
                .foregroundStyle(Eb.textPrimary)
                .lineLimit(1)
            if isMe {
                Text("вы")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(Eb.textMuted)
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 2)
    }
}

/// Строка кандидата на добавление — с отметкой выбора, как в «Новой беседе».
private struct GroupCandidateRow: View {
    let user: ChatUser
    let selected: Bool
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: 12) {
                AvatarView(name: user.name, avatarUrl: user.avatarUrl, size: 40)
                Text(user.name)
                    .font(.body)
                    .foregroundStyle(Eb.textPrimary)
                    .lineLimit(1)
                Spacer(minLength: 0)
                Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 20))
                    .foregroundStyle(selected ? Eb.brand : Eb.textMuted)
            }
            .padding(.vertical, 2)
        }
        .buttonStyle(.plain)
    }
}
