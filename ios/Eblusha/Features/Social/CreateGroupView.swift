import SwiftUI

// Порт `ui/social/CreateGroupScreen.kt` + `feature/social/CreateGroupViewModel.kt`.
// Данные — через общий ContactsRepository (listAccepted / createGroup), как в Kotlin.

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
    let onBack: () -> Void
    let onCreated: (ConversationRef) -> Void

    @StateObject private var vm: CreateGroupViewModel

    init(onBack: @escaping () -> Void, onCreated: @escaping (ConversationRef) -> Void) {
        self.onBack = onBack
        self.onCreated = onCreated
        _vm = StateObject(wrappedValue: CreateGroupViewModel(
            repo: AppContainer.shared.contactsRepository
        ))
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider().overlay(Eb.border)

            nameRow

            Text("Участники")
                .font(.subheadline.weight(.medium))
                .foregroundStyle(Eb.textMuted)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.leading, 16)
                .padding(.top, 4)
                .padding(.bottom, 8)

            if vm.ui.loading {
                Spacer()
                ProgressView()
                Spacer()
            } else {
                participantsGrid
            }

            bottomBar
        }
        .background(Eb.paper)
        .toolbar(.hidden, for: .navigationBar)
    }

    // MARK: - Шапка (порт TopAppBar: назад + заголовок с подзаголовком)

    private var header: some View {
        HStack(spacing: 10) {
            Button(action: onBack) {
                Image(systemName: "chevron.backward")
                    .font(.title3)
                    .foregroundStyle(Eb.textPrimary)
                    .frame(width: 40, height: 40)
            }
            VStack(alignment: .leading, spacing: 1) {
                Text("Создать групповой чат")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(Eb.textPrimary)
                Text("Добавьте участников и название")
                    .font(.footnote)
                    .foregroundStyle(Eb.textMuted)
            }
            Spacer()
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 4)
        .background(Eb.surface200)
    }

    // MARK: - Название группы

    private var nameRow: some View {
        HStack(spacing: 12) {
            ZStack {
                Circle().fill(Eb.brand)
                Image(systemName: "person.3.fill")
                    .font(.system(size: 20))
                    .foregroundStyle(.white)
            }
            .frame(width: 56, height: 56)

            // В эталоне label «Название группы» + placeholder «Например: Семья, Коллеги…»;
            // в SwiftUI плавающего label нет — placeholder несёт обе роли.
            TextField(
                "", text: nameBinding,
                prompt: Text("Название группы — например: Семья, Коллеги…")
                    .foregroundStyle(Eb.textMuted)
            )
            .foregroundStyle(Eb.textPrimary)
            .padding(12)
            .background(Eb.surface100, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Eb.border))
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }

    private var nameBinding: Binding<String> {
        Binding(get: { vm.ui.name }, set: { vm.onNameChange($0) })
    }

    // MARK: - Сетка участников (порт LazyVerticalGrid 3 колонки)

    private var participantsGrid: some View {
        ScrollView {
            LazyVGrid(
                columns: Array(repeating: GridItem(.flexible(), spacing: 10), count: 3),
                spacing: 10
            ) {
                ForEach(vm.ui.contacts) { contact in
                    ParticipantTile(
                        contact: contact,
                        selected: vm.ui.selected.contains(contact.user.id),
                        onTap: { vm.toggle(contact.user.id) }
                    )
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 4)
        }
    }

    // MARK: - Низ (порт bottomBar: ошибка + кнопка «Создать (N)»)

    private var bottomBar: some View {
        VStack(spacing: 8) {
            if let error = vm.ui.error {
                Text(error)
                    .font(.footnote)
                    .foregroundStyle(Eb.error)
                    .multilineTextAlignment(.center)
            }
            Button {
                vm.create(onCreated: onCreated)
            } label: {
                Group {
                    if vm.ui.creating {
                        ProgressView().tint(.white)
                    } else {
                        Text(
                            vm.ui.selected.isEmpty
                                ? "Выберите участников"
                                : "Создать (\(vm.ui.selected.count))"
                        )
                        .fontWeight(.semibold)
                    }
                }
                .frame(maxWidth: .infinity)
                .frame(height: 38)
            }
            .buttonStyle(.borderedProminent)
            .tint(Eb.brand)
            .disabled(vm.ui.selected.isEmpty || vm.ui.creating)
        }
        .padding(16)
        .background(Eb.surface200)
    }
}

// MARK: - Плитка участника (порт ParticipantTile)

private struct ParticipantTile: View {
    let contact: Contact
    let selected: Bool
    let onTap: () -> Void

    var body: some View {
        VStack(spacing: 6) {
            ZStack(alignment: .bottomTrailing) {
                AvatarView(name: contact.user.name, avatarUrl: contact.user.avatarUrl, size: 48)
                if selected {
                    ZStack {
                        Circle().fill(Eb.surface100)
                        Circle().fill(Eb.brand).frame(width: 15, height: 15)
                        Image(systemName: "checkmark")
                            .font(.system(size: 8, weight: .bold))
                            .foregroundStyle(.white)
                    }
                    .frame(width: 18, height: 18)
                }
            }
            Text(contact.user.name)
                .font(.footnote.weight(.semibold))
                .foregroundStyle(Eb.textPrimary)
                .lineLimit(1)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 12)
        .padding(.horizontal, 6)
        .background(Eb.surface200, in: RoundedRectangle(cornerRadius: 14))
        .overlay(
            RoundedRectangle(cornerRadius: 14)
                .strokeBorder(
                    selected ? Eb.brand : Eb.borderStrong,
                    lineWidth: selected ? 2 : 1
                )
        )
        .contentShape(Rectangle())
        .onTapGesture(perform: onTap)
    }
}
