import Foundation
import Combine

/// Порт `feature/social/ContactsViewModel.kt`.
///
/// Kotlin-оригинал берёт eblid/код регистрации из ProfileRepository; здесь те же методы
/// временно живут в ContactsRepository (см. комментарий там) — до порта фазы 6.
@MainActor
final class ContactsViewModel: ObservableObject {

    struct UiState {
        var loading = true
        var contacts: [Contact] = []
        var incoming: [Contact] = []
        /// Наши неотвеченные заявки («Ожидание подтверждения»).
        var outgoing: [Contact] = []
        var query = ""
        var searching = false
        var results: [ChatUser] = []
        var myEblid: String?
        var invite: InviteCode?
        var inviteRefreshing = false
        var error: String?
        var info: String?
    }

    @Published private(set) var ui = UiState()

    private let repo: ContactsRepository
    private var searchTask: Task<Void, Never>?
    private var cancellables: Set<AnyCancellable> = []

    init(repo: ContactsRepository, realtime: RealtimeClient? = nil) {
        self.repo = repo
        load()
        loadProfile()
        loadInvite()
        // Живые заявки (веб-паритет): входящая/принятая/отклонённая заявка обновляет экран сама.
        realtime?.events
            .receive(on: DispatchQueue.main)
            .sink { [weak self] event in
                if case .contactsChanged = event { self?.load() }
            }
            .store(in: &cancellables)
    }

    func load() {
        Task {
            ui.loading = ui.contacts.isEmpty
            ui.error = nil
            let accepted = await repo.listAccepted()
            let incoming = await repo.listIncoming()
            let outgoing = await repo.listOutgoing()
            ui.loading = false
            switch accepted {
            case .success(let list): ui.contacts = list
            case .failure(let message, _): ui.error = message // contacts не трогаем (как оригинал)
            }
            if case .success(let list) = incoming { ui.incoming = list } else { ui.incoming = [] }
            if case .success(let list) = outgoing { ui.outgoing = list } else { ui.outgoing = [] }
        }
    }

    private func loadProfile() {
        Task {
            if case .success(let me) = await repo.me() { ui.myEblid = me.eblid }
        }
    }

    func loadInvite() {
        Task {
            if case .success(let invite) = await repo.inviteCode() { ui.invite = invite }
        }
    }

    func refreshInvite() {
        guard !ui.inviteRefreshing else { return }
        Task {
            ui.inviteRefreshing = true
            switch await repo.refreshInviteCode() {
            case .success(let invite):
                ui.inviteRefreshing = false
                ui.invite = invite
            case .failure(let message, _):
                ui.inviteRefreshing = false
                ui.error = message
            }
        }
    }

    func onQueryChange(_ q: String) {
        ui.query = q
        searchTask?.cancel()
        if q.trimmed().count < 2 {
            ui.results = []
            ui.searching = false
            return
        }
        searchTask = Task {
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled else { return }
            ui.searching = true
            switch await repo.search(q) {
            case .success(let results):
                // Ответ применяем, только если запрос всё ещё актуален (порт ui.query == q).
                if ui.query == q {
                    ui.searching = false
                    ui.results = results
                }
            case .failure(let message, _):
                ui.searching = false
                ui.error = message
            }
        }
    }

    func add(identifier: String) {
        Task {
            switch await repo.add(identifier: identifier) {
            case .success:
                ui.info = "Запрос отправлен"
                ui.query = ""
                ui.results = []
            case .failure(let message, _):
                ui.error = message
            }
        }
    }

    /// Заявка по userId из результата поиска — логин наружу не выносим (веб-правило).
    func addById(userId: String) {
        Task {
            switch await repo.addByUserId(userId) {
            case .success:
                ui.info = "Запрос отправлен"
                ui.query = ""
                ui.results = []
            case .failure(let message, _):
                ui.error = message
            }
        }
    }

    func respond(_ contact: Contact, action: String) {
        Task {
            if case .success = await repo.respond(contactId: contact.contactId, action: action) {
                load()
            }
        }
    }

    func removeContact(_ contact: Contact) {
        Task {
            if case .success = await repo.removeContact(contactId: contact.contactId) {
                load()
            }
        }
    }

    func startDm(userId: String, onOpened: @escaping (ConversationRef) -> Void) {
        Task {
            switch await repo.startDirectConversation(userId: userId) {
            case .success(let ref): onOpened(ref)
            case .failure(let message, _): ui.error = message
            }
        }
    }

    func startSecret(userId: String, onOpened: @escaping (ConversationRef) -> Void) {
        Task {
            switch await repo.startSecretConversation(userId: userId) {
            // Открываем тред сразу — пока он PENDING, экран чата сам блокируется
            // карточкой «ждём подтверждения», пока собеседник не примет.
            case .success(let start): onOpened(start.ref)
            case .failure(let message, _): ui.error = message
            }
        }
    }

    func clearMessages() {
        ui.info = nil
        ui.error = nil
    }
}
