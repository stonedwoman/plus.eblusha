import Foundation
import Combine

// Кто где сейчас звонит — одна карта на всё приложение.
//
// Сервер рассылает состояние звонка беседы событиями `call:status` (в комнату беседы) и
// `call:status:bulk` (ответ на наш запрос снапшота) — src/realtime/socket.ts:1046, 2782-2811.
// Веб держит это в `activeCalls` (ChatsPage.tsx:678, 1060-1175); здесь та же карта живёт
// синглтоном, потому что читателей несколько и они не связаны навигацией: плитка списка,
// шапка открытой беседы и кнопки звонка в панели. Держать её в ChatListViewModel нельзя —
// списка в стеке может уже не быть, а шапка про звонок знать обязана.

/// Сырой `call:status` (и значение внутри `call:status:bulk`).
struct CallStatusPayload: Decodable {
    let conversationId: String
    var active = false
    var startedAt: Int64?
    var participants: [String] = []

    private enum CodingKeys: String, CodingKey { case conversationId, active, startedAt, participants }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        conversationId = try c.decode(String.self, forKey: .conversationId)
        active = try c.decodeIfPresent(Bool.self, forKey: .active) ?? false
        startedAt = try c.decodeIfPresent(Int64.self, forKey: .startedAt)
        participants = try c.decodeIfPresent([String].self, forKey: .participants) ?? []
    }
}

/// Снапшот по запросу: conversationId → состояние.
struct CallStatusBulkPayload: Decodable {
    var statuses: [String: CallStatusPayload] = [:]

    private enum CodingKeys: String, CodingKey { case statuses }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        statuses = try c.decodeIfPresent([String: CallStatusPayload].self, forKey: .statuses) ?? [:]
    }
}

final class CallStatusStore: ObservableObject {
    static let shared = CallStatusStore()

    /// Состояние звонка ОДНОЙ беседы.
    struct Entry: Equatable {
        var active = false
        var startedAt: Int64?
        /// Когда звонок кончился. Сервер этого поля не шлёт — момент завершения знает
        /// только клиент, поймавший переход active → inactive (ровно как веб,
        /// ChatsPage.tsx:1105-1116). Нужен для «Завершён N мин назад».
        var endedAt: Int64?
        /// userId участников звонка (по ним видно, что мы уже в нём с другого устройства).
        var participants: [String] = []
    }

    /// conversationId → состояние. Пишется только с главного потока.
    @Published private(set) var calls: [String: Entry] = [:]

    private init() {}

    func apply(_ payload: CallStatusPayload) {
        onMain {
            var next = self.calls
            if self.merge(payload, into: &next) { self.calls = next }
        }
    }

    func applyBulk(_ statuses: [String: CallStatusPayload]) {
        guard !statuses.isEmpty else { return }
        onMain {
            var next = self.calls
            var changed = false
            for payload in statuses.values {
                if self.merge(payload, into: &next) { changed = true }
            }
            if changed { self.calls = next }
        }
    }

    /// Выход из аккаунта: чужой сессии наши звонки не показываем.
    func clear() {
        onMain {
            if !self.calls.isEmpty { self.calls = [:] }
        }
    }

    /// true, если запись реально изменилась. Возврат «не изменилось» важен для перфа:
    /// bulk прилетает на каждый реконнект, и без сверки каждый ответ дёргал бы
    /// перерисовку всего списка (та же причина, что у веб-проверки в ChatsPage.tsx:1078).
    private func merge(_ payload: CallStatusPayload, into map: inout [String: Entry]) -> Bool {
        let current = map[payload.conversationId]
        if payload.active {
            let startedAt = (payload.startedAt ?? 0) > 0
                ? payload.startedAt
                : (current?.startedAt ?? nowMs())
            let next = Entry(
                active: true, startedAt: startedAt, endedAt: nil, participants: payload.participants
            )
            guard next != current else { return false }
            map[payload.conversationId] = next
            return true
        }
        // Про беседу, о которой мы ничего не знали, «звонка нет» — не новость.
        guard let current else { return false }
        guard current.active || !current.participants.isEmpty else { return false }
        // Момент завершения: если звонок был активен — это «сейчас»; иначе оставляем
        // прежний. Метка раньше начала звонка бессмысленна (дала бы «Завершён час назад»
        // сразу после разговора) — такую тоже считаем «сейчас».
        var endedAt = current.active ? nowMs() : current.endedAt
        if let ended = endedAt, let started = current.startedAt, ended <= started { endedAt = nowMs() }
        let next = Entry(
            active: false, startedAt: current.startedAt, endedAt: endedAt, participants: []
        )
        guard next != current else { return false }
        map[payload.conversationId] = next
        return true
    }

    private func nowMs() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }

    /// События сокета приходят на главной очереди, но синглтон зовут и из фоновых задач —
    /// @Published обязан меняться только на main.
    private func onMain(_ body: @escaping () -> Void) {
        if Thread.isMainThread { body() } else { DispatchQueue.main.async(execute: body) }
    }
}
