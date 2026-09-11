import Combine
import Foundation

/// Досыл секретных сообщений, когда экран чата закрыт.
///
/// Текст, набранный до прихода ключа треда, лежит в `SecretOutbox` (см. его) и досылается
/// экраном беседы. Но ключ часто приезжает уже после того, как человек ушёл в список чатов:
/// в вебе досылом занимается сама страница чатов, которая живёт всё время, а на iOS экран
/// беседы к этому моменту уничтожен. Поэтому тем же занят этот наблюдатель на уровне
/// приложения: он слушает приход ключей и отправляет всё, что накопилось, по любой беседе.
@MainActor
final class SecretOutboxFlusher {

    private let secret: SecretRepository
    private let chats: ChatRepository
    private var cancellables = Set<AnyCancellable>()
    /// Беседы, по которым досыл уже идёт: приход двух ключей подряд не должен отправить
    /// один и тот же текст дважды.
    private var inFlight = Set<String>()

    init(secret: SecretRepository, chats: ChatRepository) {
        self.secret = secret
        self.chats = chats
    }

    func start() {
        guard cancellables.isEmpty else { return }
        secret.keyImported
            .receive(on: DispatchQueue.main)
            .sink { [weak self] threadId in
                Task { @MainActor in await self?.flush(threadId) }
            }
            .store(in: &cancellables)
    }

    /// Отправить всё, что ждёт по этой беседе. Экран чата делает то же самое сам, поэтому
    /// записи снимаются из очереди сразу после успеха — повторов не будет.
    private func flush(_ conversationId: String) async {
        guard !inFlight.contains(conversationId) else { return }
        let queued = SecretOutbox.all(conversationId)
        guard !queued.isEmpty, secret.hasThreadKey(conversationId) else { return }
        inFlight.insert(conversationId)
        defer { inFlight.remove(conversationId) }

        let peers = await chats.conversationPeerUserIds(conversationId)
        guard !peers.isEmpty else { return }
        for entry in queued {
            // Ключ мог пропасть между итерациями (тред закрыли) — тогда остаток ждёт дальше.
            guard secret.hasThreadKey(conversationId) else { return }
            let result = await secret.sendText(
                conversationId: conversationId,
                peerUserIds: peers,
                text: entry.text,
                msgId: entry.msgId
            )
            switch result {
            case .success:
                SecretOutbox.remove(conversationId, id: entry.id)
            case .failure:
                // Сеть отвалилась — остальное отправит следующий приход ключа или экран чата.
                return
            }
        }
    }
}
