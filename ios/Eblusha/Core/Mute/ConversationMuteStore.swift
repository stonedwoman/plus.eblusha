import Foundation
import Combine
import UIKit

// «Без звука» на стороне приложения: состояние бесед, его источники, действие пользователя,
// таймер истечения. Контракт сервера — docs/conversation-mute.md.
//
// Источники и их свежесть (asOf, часы сервера):
//  - GET /conversations — serverNow ответа (старый сервер без поля — время отправки запроса);
//  - `conversation:mute:snapshot` при каждом подключении сокета — serverNow, ЗАМЕНА целиком (так
//    долетает «Включить звук», нажатый, пока телефон был без связи);
//  - `conversation:mute` — `at` (заглушили/включили здесь или на другом своём устройстве);
//  - ответ своего POST — serverNow.
// Применяется только не старее сохранённого.
//
// Состояние лежит в общей группе приложений (MuteSharedState) — его читает Notification Service
// Extension. Только главный поток: обработчики сокета, вью и уведомления системы — все на main.

/// Событие `conversation:mute` {conversationId, mutedUntil, mutedForever, at, byDeviceId?}.
struct ConversationMuteEvent: Equatable {
    let conversationId: String
    let untilMs: Int64?
    let atMs: Int64?
    let byDeviceId: String?

    static func parse(_ dict: [String: Any]) -> ConversationMuteEvent? {
        guard let id = dict["conversationId"] as? String, !id.isEmpty else { return nil }
        // Поле есть всегда: null — «звук включён». Нет поля вовсе — событие битое, не трогаем.
        guard dict.keys.contains("mutedUntil") else { return nil }
        let until = MuteWire.until(dict["mutedUntil"], forever: dict["mutedForever"])
        if case .invalid = until { return nil }
        let device = (dict["byDeviceId"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        return ConversationMuteEvent(
            conversationId: id, untilMs: until.ms, atMs: MuteWire.isoMs(dict["at"]), byDeviceId: device
        )
    }
}

/// Снапшот `conversation:mute:snapshot` {items:[{conversationId, mutedUntil, mutedForever}], serverNow}.
struct ConversationMuteSnapshot: Equatable {
    /// Только заглушённые сейчас беседы. Всех остальных снапшот объявляет незаглушёнными.
    let items: [String: Int64]
    let serverNowMs: Int64?

    static func parse(_ dict: [String: Any]) -> ConversationMuteSnapshot? {
        guard let raw = dict["items"] as? [Any] else { return nil }
        var items: [String: Int64] = [:]
        for case let item as [String: Any] in raw {
            guard let id = item["conversationId"] as? String, !id.isEmpty else { continue }
            if let ms = MuteWire.until(item["mutedUntil"], forever: item["mutedForever"]).ms {
                items[id] = ms
            }
        }
        return ConversationMuteSnapshot(items: items, serverNowMs: MuteWire.isoMs(dict["serverNow"]))
    }
}

/// Ответ POST /conversations/:id/mute.
struct ConversationMuteResponse: Decodable {
    let conversationId: String
    var mutedUntil: String?
    var mutedForever: Bool = false
    var serverNow: String?

    private enum CodingKeys: String, CodingKey { case conversationId, mutedUntil, mutedForever, serverNow }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        conversationId = try c.decode(String.self, forKey: .conversationId)
        mutedUntil = try c.decodeIfPresent(String.self, forKey: .mutedUntil)
        mutedForever = (try? c.decodeIfPresent(Bool.self, forKey: .mutedForever)) ?? false
        serverNow = try c.decodeIfPresent(String.self, forKey: .serverNow)
    }

    var untilMs: Int64? { MuteWire.until(mutedUntil, forever: mutedForever).ms }
}

/// Тело POST: ровно одно из {for: пресет} или {until: null}. JSONEncoder по умолчанию null не пишет
/// (decodeIfPresent-симметрия), а серверу «Включить звук» нужен именно явный `until: null`.
struct ConversationMuteRequest: Encodable {
    let preset: MutePreset?

    private enum CodingKeys: String, CodingKey {
        case preset = "for"
        case until
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        if let preset {
            try c.encode(preset.rawValue, forKey: .preset)
        } else {
            try c.encodeNil(forKey: .until)
        }
    }
}

/// Разбор полей «Без звука» с провода.
enum MuteWire {
    enum Until: Equatable {
        case none
        case at(Int64)
        case invalid

        var ms: Int64? {
            if case .at(let ms) = self { return ms }
            return nil
        }
    }

    /// mutedUntil (ISO | null) + mutedForever. «Навсегда» без даты — всё равно «навсегда».
    static func until(_ raw: Any?, forever: Any?) -> Until {
        if raw == nil || raw is NSNull {
            return PushMuteDecision.flag(forever) ? .at(MuteRules.foreverMs) : .none
        }
        guard let ms = isoMs(raw) else { return .invalid }
        if PushMuteDecision.flag(forever) { return .at(max(ms, MuteRules.foreverMs)) }
        return .at(ms)
    }

    static func isoMs(_ raw: Any?) -> Int64? {
        guard let s = raw as? String else { return nil }
        return parseIsoToMillis(s)
    }
}

/// Подтверждение или ошибка после действия — короткая плашка над экраном (MuteToastOverlay).
struct MuteToast: Equatable, Identifiable {
    let id = UUID()
    let text: String
    let isError: Bool
}

final class ConversationMuteStore: ObservableObject {
    static let shared = ConversationMuteStore()

    @Published private(set) var state: MuteSharedState
    /// Тик часов «Без звука»: таймер истечения, возврат в приложение. Вью пересчитывают isMuted.
    @Published private(set) var tick = 0
    /// Последнее подтверждение/ошибка действия (показывает MuteToastOverlay).
    @Published var toast: MuteToast?
    /// Беседы, по которым летит запрос (повторный тап не шлём).
    @Published private(set) var inFlight: Set<String> = []

    /// Любая перемена «Без звука» (значок приложения пересчитывается по ней).
    let changes = PassthroughSubject<Void, Never>()

    private let defaults: UserDefaults
    private let apiProvider: () -> APIClient?
    private let userProvider: () -> String?
    private let localNow: () -> Date
    /// Замеры смещения часов (сервер − телефон) за последние 10 минут.
    private var clockSamples: [(at: Date, offsetMs: Int64)] = []
    private var expiryWork: DispatchWorkItem?
    private var observers: [NSObjectProtocol] = []

    static let clockWindow: TimeInterval = 600

    init(
        defaults: UserDefaults = MuteShared.defaults(),
        api: (() -> APIClient?)? = nil,
        currentUser: (() -> String?)? = nil,
        now: @escaping () -> Date = Date.init
    ) {
        self.defaults = defaults
        self.apiProvider = api ?? { AppContainer.shared.api }
        self.userProvider = currentUser ?? { AppContainer.shared.sessionStore.currentUserId() }
        self.localNow = now
        self.state = MuteSharedState.load(from: defaults)
        // Возврат в приложение: таймер мог проспать (часы монотонного таймера стоят во сне).
        observers.append(NotificationCenter.default.addObserver(
            forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main
        ) { [weak self] _ in
            self?.refreshClock()
        })
        scheduleExpiry()
    }

    deinit {
        observers.forEach(NotificationCenter.default.removeObserver)
        expiryWork?.cancel()
    }

    // MARK: - Чтение

    /// now по часам сервера (с поправкой на смещение часов телефона).
    var nowMs: Int64 { Int64(localNow().timeIntervalSince1970 * 1000) + state.serverOffsetMs }

    /// Действующий срок (истёкший — nil).
    func untilMs(_ conversationId: String) -> Int64? {
        MuteRules.effectiveUntil(untilMs: state.untilMs(conversationId), nowMs: nowMs)
    }

    func isMuted(_ conversationId: String) -> Bool {
        untilMs(conversationId) != nil
    }

    /// «до 18:30» / «навсегда»; nil — не заглушено.
    func label(_ conversationId: String) -> String? {
        untilMs(conversationId).map { MuteText.until($0, now: displayNow) }
    }

    /// «Без звука до 18:30» / «Без звука навсегда»; nil — не заглушено.
    func tip(_ conversationId: String) -> String? {
        untilMs(conversationId).map { MuteText.tip($0, now: displayNow) }
    }

    /// Срок показывается в часах телефона, но «сегодня/завтра» считается от поправленного now.
    private var displayNow: Date { Date(timeIntervalSince1970: Double(nowMs) / 1000) }

    // MARK: - Источники

    /// Список бесед. `items` — только строки, в которых сервер прислал поле (старый сервер полей не
    /// шлёт — тогда ничего не трогаем). `serverNowMs` nil — старый сервер: asOf = время запроса.
    func applyList(owner: String?, items: [String: Int64?], serverNowMs: Int64?, requestedAtMs: Int64) {
        guard !items.isEmpty || serverNowMs != nil else { return }
        if let serverNowMs { addClockSample(serverNowMs) }
        let asOf = serverNowMs ?? (requestedAtMs + state.serverOffsetMs)
        var next = stateFor(owner: owner)
        for (id, until) in items {
            Self.merge(&next, id: id, untilMs: until, asOfMs: asOf, setAtMs: nil)
        }
        commit(next)
    }

    /// Снапшот при подключении сокета — замена целиком.
    func applySnapshot(_ snapshot: ConversationMuteSnapshot) {
        if let ms = snapshot.serverNowMs { addClockSample(ms) }
        let asOf = snapshot.serverNowMs ?? nowMs
        var next = stateFor(owner: currentUserId())
        for id in Set(next.entries.keys).union(snapshot.items.keys) {
            Self.merge(&next, id: id, untilMs: snapshot.items[id], asOfMs: asOf, setAtMs: nil)
        }
        commit(next)
    }

    /// Событие `conversation:mute`.
    func applyEvent(_ event: ConversationMuteEvent) {
        if let at = event.atMs { addClockSample(at) }
        let asOf = event.atMs ?? nowMs
        var next = stateFor(owner: currentUserId())
        Self.merge(&next, id: event.conversationId, untilMs: event.untilMs, asOfMs: asOf, setAtMs: event.atMs)
        commit(next)
    }

    /// Ответ своего POST.
    func applyResponse(_ response: ConversationMuteResponse) {
        let serverNow = MuteWire.isoMs(response.serverNow)
        if let serverNow { addClockSample(serverNow) }
        var next = stateFor(owner: currentUserId())
        Self.merge(
            &next, id: response.conversationId, untilMs: response.untilMs,
            asOfMs: serverNow ?? nowMs, setAtMs: serverNow
        )
        commit(next)
    }

    /// Применить знание о беседе, если оно не старее сохранённого. Момент изменения переживает
    /// повторы того же значения (список после события), а новое значение без момента его сбрасывает.
    static func merge(_ state: inout MuteSharedState, id: String, untilMs: Int64?, asOfMs: Int64, setAtMs: Int64?) {
        let known = state.entries[id]
        if let known, known.asOfMs > asOfMs { return }
        let setAt: Int64?
        if let setAtMs {
            setAt = setAtMs
        } else if let known, known.untilMs == untilMs {
            setAt = known.setAtMs
        } else {
            setAt = nil
        }
        state.entries[id] = MuteEntry(untilMs: untilMs, asOfMs: asOfMs, setAtMs: setAt)
    }

    // MARK: - Действие пользователя

    /// «Без звука на …» (preset) или «Включить звук» (nil). Не оптимистично: значок появляется по
    /// ответу сервера (доли секунды), зато откатывать нечего. Свой же `conversation:mute` придёт
    /// следом и ничего не изменит (тот же asOf).
    func setMute(_ conversationId: String, preset: MutePreset?, completion: ((Bool) -> Void)? = nil) {
        guard !inFlight.contains(conversationId), let api = apiProvider() else {
            completion?(false)
            return
        }
        inFlight.insert(conversationId)
        Task { @MainActor in
            defer { self.inFlight.remove(conversationId) }
            do {
                let response: ConversationMuteResponse = try await api.post(
                    "conversations/\(conversationId)/mute", body: ConversationMuteRequest(preset: preset)
                )
                self.applyResponse(response)
                self.toast = MuteToast(text: preset?.doneText ?? MuteText.unmuted, isError: false)
                completion?(true)
            } catch {
                // 400/404 (старый сервер без ручки — 404 без code)/429/нет сети — для человека одно.
                NSLog("Mute: не удалось изменить звук беседы: %@", String(describing: error))
                self.toast = MuteToast(text: MuteText.failed, isError: true)
                completion?(false)
            }
        }
    }

    /// Выход из аккаунта: настройки принадлежали прошлой сессии.
    func resetForLogout() {
        clockSamples = []
        commit(MuteSharedState())
        toast = nil
    }

    // MARK: - Часы и истечение

    /// Пересчитать «сейчас»: возврат в приложение, переподключение.
    func refreshClock() {
        tick &+= 1
        scheduleExpiry()
        changes.send()
    }

    /// Смещение = наибольший замер (serverNow − время прихода) за 10 минут: замер занижен на время
    /// в пути, и наименее задержанный ближе всех к правде.
    private func addClockSample(_ serverMs: Int64) {
        let now = localNow()
        let offset = serverMs - Int64(now.timeIntervalSince1970 * 1000)
        clockSamples.append((now, offset))
        clockSamples.removeAll { now.timeIntervalSince($0.at) > Self.clockWindow || $0.at > now }
        let best = clockSamples.map(\.offsetMs).max() ?? 0
        if best != state.serverOffsetMs {
            var next = state
            next.serverOffsetMs = best
            state = next
        }
    }

    private func scheduleExpiry() {
        expiryWork?.cancel()
        expiryWork = nil
        let now = nowMs
        guard let next = MuteRules.nextExpiry(state.entries.values.map(\.untilMs), nowMs: now) else { return }
        let work = DispatchWorkItem { [weak self] in self?.refreshClock() }
        expiryWork = work
        // +50 мс: проснуться уже ПОСЛЕ срока, а не за миг до него.
        DispatchQueue.main.asyncAfter(deadline: .now() + Double(next - now) / 1000 + 0.05, execute: work)
    }

    // MARK: - Внутренности

    private func stateFor(owner: String?) -> MuteSharedState {
        guard let owner, state.owner != owner else { return state }
        // Другой аккаунт на телефоне: чужие настройки не наследуем.
        var fresh = MuteSharedState()
        fresh.owner = owner
        fresh.serverOffsetMs = state.serverOffsetMs
        return fresh
    }

    private func commit(_ next: MuteSharedState) {
        if next != state { state = next }
        state.save(to: defaults)
        tick &+= 1
        scheduleExpiry()
        changes.send()
    }

    private func currentUserId() -> String? {
        userProvider()
    }
}
