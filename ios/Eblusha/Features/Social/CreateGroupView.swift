import SwiftUI

// Порт `ui/social/CreateGroupScreen.kt` + `feature/social/CreateGroupViewModel.kt`.
// Данные — через общий ContactsRepository (listAccepted / createGroup), как в Kotlin.
//
// Оболочка экрана — родная iOS: системная панель с заголовком «Новая беседа», кнопка
// «Создать» в панели, `List` с системным поиском и отметками выбора. ViewModel и все
// вызовы (load / onNameChange / toggle / create) остались ровно теми же — менялась
// только сборка вью.

@MainActor
final class CreateGroupViewModel: ObservableObject {

    struct UiState {
        var loading = true
        var contacts: [Contact] = []
        var selected: Set<String> = []
        var name = ""
        var creating = false
        var error: String?
    }

    @Published private(set) var ui = UiState()

    private let repo: ContactsRepository

    init(repo: ContactsRepository) {
        self.repo = repo
        load()
    }

    func load() {
        Task {
            ui.loading = true
            ui.error = nil
            switch await repo.listAccepted() {
            case .success(let contacts):
                ui.loading = false
                ui.contacts = contacts
            case .failure(let message, _):
                ui.loading = false
                ui.error = message
            }
        }
    }

    func onNameChange(_ value: String) {
        ui.name = value
    }

    func toggle(_ userId: String) {
        if ui.selected.contains(userId) {
            ui.selected.remove(userId)
        } else {
            ui.selected.insert(userId)
        }
    }

    func create(onCreated: @escaping (ConversationRef) -> Void) {
        guard !ui.selected.isEmpty, !ui.creating else { return }
        Task {
            ui.creating = true
            ui.error = nil
            switch await repo.createGroup(title: ui.name, participantIds: Array(ui.selected)) {
            case .success(let ref):
                onCreated(ref)
            case .failure(let message, _):
                ui.creating = false
                ui.error = message
            }
        }
    }
}

struct CreateGroupView: View {
    /// В сигнатуре остаётся ради совместимости с RootView. Свою кнопку «назад» не рисуем:
    /// экран живёт в NavigationStack вкладки «Чаты», и штатная кнопка снимает его со стека.
    let onBack: () -> Void
    let onCreated: (ConversationRef) -> Void

    @StateObject private var vm: CreateGroupViewModel
    /// Строка поиска по участникам. Фильтр чисто локальный — по уже загруженным
    /// vm.ui.contacts, поэтому во ViewModel её не заводим.
    @State private var query = ""

    init(onBack: @escaping () -> Void, onCreated: @escaping (ConversationRef) -> Void) {
        self.onBack = onBack
        self.onCreated = onCreated
        _vm = StateObject(wrappedValue: CreateGroupViewModel(
            repo: AppContainer.shared.contactsRepository
        ))
    }

    var body: some View {
        List {
            nameSection
            errorSection
            participantsSection
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(Eb.paper)
        .scrollDismissesKeyboard(.interactively)
        .navigationTitle("Новая беседа")
        .navigationBarTitleDisplayMode(.inline)
        // Поле поиска всегда на виду: это экран-выборщик, прятать его до прокрутки нет смысла.
        .searchable(
            text: $query,
            placement: .navigationBarDrawer(displayMode: .always),
            prompt: Text("Имя участника")
        )
        .toolbar {
            // Порт кнопки «Создать (N)» из bottomBar: то же условие блокировки, тот же вызов.
            ToolbarItem(placement: .confirmationAction) {
                Button {
                    vm.create(onCreated: onCreated)
                } label: {
                    if vm.ui.creating {
                        ProgressView()
                    } else {
                        Text("Создать")
                    }
                }
                .disabled(vm.ui.selected.isEmpty || vm.ui.creating)
            }
        }
    }

    // MARK: - Производные данные

    private var nameBinding: Binding<String> {
        Binding(get: { vm.ui.name }, set: { vm.onNameChange($0) })
    }

    private var trimmedQuery: String {
        query.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Контакты, подходящие под строку поиска. Только по имени: логин — секрет входа.
    private var filtered: [Contact] {
        let q = trimmedQuery
        guard !q.isEmpty else { return vm.ui.contacts }
        return vm.ui.contacts.filter { $0.user.name.localizedCaseInsensitiveContains(q) }
    }

    /// Подпись под списком дублирует счётчик, который раньше жил в тексте кнопки «Создать (N)».
    private var participantsFooter: String {
        vm.ui.selected.isEmpty
            ? "Отметьте хотя бы одного участника."
            : "Выбрано: \(vm.ui.selected.count)"
    }

    // MARK: - Название группы

    private var nameSection: some View {
        Section {
            HStack(spacing: 12) {
                // Аватар группы — тот же оранжевый круг с «тремя людьми», что и раньше.
                ZStack {
                    Circle().fill(Eb.brand)
                    Image(systemName: "person.3.fill")
                        .font(.system(size: 18))
                        .foregroundStyle(.white)
                }
                .frame(width: 48, height: 48)

                // В эталоне label «Название группы» + placeholder с примерами; плавающего
                // label в SwiftUI нет — placeholder несёт имя поля, примеры ушли в footer.
                TextField(
                    "", text: nameBinding,
                    prompt: Text("Название группы").foregroundStyle(Eb.textMuted)
                )
                .foregroundStyle(Eb.textPrimary)
                .submitLabel(.done)
            }
            .padding(.vertical, 4)
            .listRowBackground(Eb.surface100)
            .listRowSeparatorTint(Eb.border)
        } footer: {
            Text("Например: Семья, Коллеги…")
        }
    }

    // MARK: - Ошибка (порт текста ошибки из bottomBar)

    @ViewBuilder
    private var errorSection: some View {
        if let error = vm.ui.error {
            Section {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .font(.footnote)
                    .foregroundStyle(Eb.error)
                    .listRowBackground(Eb.surface100)
                    .listRowSeparatorTint(Eb.border)
                // Ошибка при пустом списке — значит, не загрузились контакты; даём повторить,
                // не уходя с экрана (раньше выхода не было — только «назад»).
                if !vm.ui.loading && vm.ui.contacts.isEmpty {
                    Button("Повторить") { vm.load() }
                        .foregroundStyle(Eb.brand)
                        .listRowBackground(Eb.surface100)
                        .listRowSeparatorTint(Eb.border)
                }
            }
        }
    }

    // MARK: - Участники (порт сетки ParticipantTile, теперь строками с отметками)

    private var participantsSection: some View {
        Section {
            if vm.ui.loading {
                HStack {
                    Spacer()
                    ProgressView()
                    Spacer()
                }
                .padding(.vertical, 8)
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
            } else if vm.ui.contacts.isEmpty {
                // При ошибке загрузки список тоже пуст, но тогда объяснение уже дала
                // секция ошибки — не путаем человека «нет контактов».
                if vm.ui.error == nil {
                    ContentUnavailableView(
                        "Контактов пока нет",
                        systemImage: "person.2",
                        description: Text("Добавьте друзей во вкладке «Контакты» — их можно будет позвать в беседу.")
                    )
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
                }
            } else if filtered.isEmpty {
                ContentUnavailableView(
                    "Никого не найдено",
                    systemImage: "magnifyingglass",
                    description: Text("Среди контактов нет никого с именем «\(trimmedQuery)».")
                )
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
            } else {
                ForEach(filtered) { contact in
                    ParticipantRow(
                        contact: contact,
                        selected: vm.ui.selected.contains(contact.user.id),
                        onTap: {
                            withAnimation(.snappy) { vm.toggle(contact.user.id) }
                        }
                    )
                    .listRowBackground(Eb.surface100)
                    .listRowSeparatorTint(Eb.border)
                }
            }
        } header: {
            Text("Участники")
        } footer: {
            Text(participantsFooter)
        }
    }
}

// MARK: - Строка участника (порт ParticipantTile: аватар, имя, отметка выбора)

private struct ParticipantRow: View {
    let contact: Contact
    let selected: Bool
    let onTap: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            ZStack(alignment: .bottomTrailing) {
                AvatarView(name: contact.user.name, avatarUrl: contact.user.avatarUrl, size: 40)
                // Кольцо под цвет строки, чтобы значок не «висел» на подложке другого тона.
                PresenceBadge(
                    userId: contact.user.id,
                    status: contact.user.online ? "ONLINE" : "OFFLINE",
                    onlineFallback: contact.user.online,
                    ringSize: 14,
                    dotSize: 9,
                    ringColor: Eb.surface100
                )
            }
            Text(contact.user.name)
                .fontWeight(.semibold)
                .foregroundStyle(Eb.textPrimary)
                .lineLimit(1)
            Spacer(minLength: 8)
            // Отметка выбора в духе системных выборщиков: галочка акцентом, пустой круг — нет.
            Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                .font(.title3)
                .foregroundStyle(selected ? Eb.brand : Eb.textMuted)
                .contentTransition(.symbolEffect(.replace))
        }
        .padding(.vertical, 2)
        // Тап по всей строке, а не только по тексту: иначе пустое место между именем
        // и отметкой не реагировало бы.
        .contentShape(Rectangle())
        .onTapGesture(perform: onTap)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
        .accessibilityValue(Text(verbatim: selected ? "выбран" : "не выбран"))
    }
}
