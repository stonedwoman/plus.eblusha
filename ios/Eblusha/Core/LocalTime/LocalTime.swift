import Foundation
import Combine
import UIKit

// Местное время собеседника: в открытом диалоге 1:1 под строкой статуса шапка пишет мелкой
// серой строкой «14:30, Красноярск». Контракт сервера — src/lib/localTime.ts (коммит e4c3a02d):
//  - каждое устройство сообщает свой пояс IANA сокет-событием `localtime:report` при каждом
//    подключении сокета (ПОСЛЕ presence:state) и при смене системного пояса;
//  - сервер показывает собеседникам пояс того устройства, которым человек пользовался последним,
//    и только собеседникам по 1:1 (в том числе секретным); в группах поля нет вовсе;
//  - собеседник приходит в GET /conversations (participants[].user.localTime), в
//    GET /users/:id/local-time и событием `localtime:update`; null — строку не показывать;
//  - своя настройка «Показывать моё местное время» — GET/PUT /status/me/local-time и событие
//    `localtime:settings`. Выключенную настройку сервер терять не должен, поэтому клиент
//    напоминает её (последнее, что слышал ОТ СЕРВЕРА) в каждом localtime:report.
//
// Город по-русски считает сервер (CLDR): клиент пишет то, что пришло, а без города — смещение.

/// Что сервер отдаёт о поясе собеседника.
struct LocalTimeInfo: Decodable, Equatable {
    /// Канонический IANA по ICU сервера («Asia/Krasnoyarsk»; Kolkata приходит как «Asia/Calcutta»,
    /// Kyiv — как «Europe/Kiev»: iOS знает оба вида).
    let timeZone: String
    /// Город по-русски; nil — у пояса города нет (Etc/GMT-7, UTC) — пишем смещение.
    let city: String?
    /// Смещение от UTC в минутах на момент ответа сервера. Только запасной путь, когда база поясов
    /// телефона не знает timeZone: со временем оно устаревает (летнее время).
    let offsetMinutes: Int

    init(timeZone: String, city: String?, offsetMinutes: Int) {
        self.timeZone = timeZone
        self.city = city
        self.offsetMinutes = offsetMinutes
    }

    private enum CodingKeys: String, CodingKey { case timeZone, city, offsetMinutes }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        timeZone = try c.decode(String.self, forKey: .timeZone)
        // Пустой пояс — не пояс: строку по нему не нарисовать.
        guard !timeZone.isEmpty else {
            throw DecodingError.dataCorruptedError(forKey: .timeZone, in: c, debugDescription: "empty timeZone")
        }
        let rawCity: String? = (try? c.decodeIfPresent(String.self, forKey: .city)) ?? nil
        city = rawCity.flatMap { $0.trimmed().isEmpty ? nil : $0 }
        // JSON-число бывает и с дробью — берём целые минуты, а не роняем весь ответ.
        let minutes: Double? = (try? c.decodeIfPresent(Double.self, forKey: .offsetMinutes)) ?? nil
        offsetMinutes = minutes.flatMap { $0.isFinite ? Int($0.rounded()) : nil } ?? 0
    }
}

/// Чистые функции строки и пояса — проверяются XCTest без UI и без сети.
enum LocalTimeFormat {

    /// Смещение собеседника в секундах на момент `date`: по базе поясов телефона, а если она
    /// пояс не знает — по смещению, которое прислал сервер.
    static func offsetSeconds(_ info: LocalTimeInfo, at date: Date) -> Int {
        if let zone = TimeZone(identifier: info.timeZone) {
            return zone.secondsFromGMT(for: date)
        }
        return info.offsetMinutes * 60
    }

    /// «UTC», «UTC+7», «UTC+5:30», «UTC-3», «UTC-9:30».
    static func offsetLabel(seconds: Int) -> String {
        guard seconds != 0 else { return "UTC" }
        let sign = seconds < 0 ? "-" : "+"
        let total = abs(seconds) / 60
        let hours = total / 60
        let minutes = total % 60
        return minutes == 0
            ? "UTC\(sign)\(hours)"
            : "UTC\(sign)\(hours):" + String(format: "%02d", minutes)
    }

    /// «14:30, Красноярск» (24 ч). nil — строку не показывать: время собеседника сейчас совпадает
    /// с моим (одно и то же смещение — время одинаковое, город ничего не добавляет).
    static func line(_ info: LocalTimeInfo, now: Date, myTimeZone: TimeZone) -> String? {
        let peerOffset = offsetSeconds(info, at: now)
        guard peerOffset != myTimeZone.secondsFromGMT(for: now) else { return nil }
        // Время собеседника = UTC + его смещение в этот момент. Так считается и для пояса из
        // базы, и для запасного смещения — одним путём, без форматтера на каждую минуту.
        let shifted = Int64(floor(now.timeIntervalSince1970)) + Int64(peerOffset)
        let minuteOfDay = Int(((shifted % 86_400) + 86_400) % 86_400) / 60
        let time = String(format: "%02d:%02d", minuteOfDay / 60, minuteOfDay % 60)
        let place = info.city ?? offsetLabel(seconds: peerOffset)
        return "\(time), \(place)"
    }

    /// Пояс телефона в виде, который примет сервер (только имена IANA).
    ///
    /// iOS почти всегда отдаёт IANA («Asia/Krasnoyarsk»). Исключение — пояс, собранный из голого
    /// смещения («GMT+0700»): сервер его отвергнет, поэтому целые часы переводим в «Etc/GMT-7»
    /// (знак в Etc наоборот), а дробные не шлём вовсе — показывать будет нечего, но и врать тоже.
    static func ianaIdentifier(_ zone: TimeZone) -> String? {
        let id = zone.identifier
        guard !id.isEmpty else { return nil }
        guard isRawOffsetIdentifier(id) else { return id }
        let seconds = zone.secondsFromGMT()
        guard seconds % 3600 == 0 else { return nil }
        let hours = seconds / 3600
        if hours == 0 { return "Etc/UTC" }
        guard (-12...14).contains(hours) else { return nil }
        return hours > 0 ? "Etc/GMT-\(hours)" : "Etc/GMT+\(-hours)"
    }

    /// «GMT+0700», «GMT-03:30», «UTC+7» — пояс из смещения, а не из базы IANA.
    static func isRawOffsetIdentifier(_ id: String) -> Bool {
        for prefix in ["GMT", "UTC"] where id.hasPrefix(prefix) {
            let rest = id.dropFirst(prefix.count)
            if let first = rest.first, first == "+" || first == "-" { return true }
        }
        return false
    }
}

// MARK: - Пояса собеседников

/// Карта «собеседник → его местное время» (как PresenceGames: плоское общее хранилище, которое
/// пишут сеть и сокет, а читает шапка беседы). Отсутствие записи = строку не показывать.
final class PeerLocalTimeStore: ObservableObject {
    static let shared = PeerLocalTimeStore()

    @Published private(set) var times: [String: LocalTimeInfo] = [:]

    /// Насколько свежо знание о собеседнике: момент НАЧАЛА запроса (список бесед, GET /users/:id/local-time) или
    /// приход события. Ответ на запрос, ушедший раньше события `localtime:update`, событие не перетирает: иначе
    /// собеседник скрыл время, событие убрало строку, а запоздавший список вернул бы её (как Android, ПК и веб).
    private var asOf: [String: Date] = [:]

    /// nil — убрать (не собеседник по 1:1, человек скрыл время, пояс неизвестен). `at` — когда это стало известно
    /// (для ответа на запрос — момент начала запроса).
    func set(userId: String, _ info: LocalTimeInfo?, asOf at: Date = Date()) {
        onMain {
            if let known = self.asOf[userId], known > at { return }
            self.asOf[userId] = at
            if let info {
                if self.times[userId] != info { self.times[userId] = info }
            } else if self.times[userId] != nil {
                self.times.removeValue(forKey: userId)
            }
        }
    }

    /// Пачка из списка бесед: только те собеседники, о ком сервер вообще что-то сказал. `at` — момент начала запроса.
    func apply(_ batch: [String: LocalTimeInfo?], asOf at: Date = Date()) {
        guard !batch.isEmpty else { return }
        onMain {
            var next = self.times
            for (userId, info) in batch {
                if let known = self.asOf[userId], known > at { continue }
                self.asOf[userId] = at
                if let info { next[userId] = info } else { next.removeValue(forKey: userId) }
            }
            if next != self.times { self.times = next }
        }
    }

    func clear() {
        onMain {
            self.asOf = [:]
            if !self.times.isEmpty { self.times = [:] }
        }
    }

    private func onMain(_ body: @escaping () -> Void) {
        if Thread.isMainThread { body() } else { DispatchQueue.main.async(execute: body) }
    }
}

// MARK: - Своя настройка и отчёт о поясе

/// Ответ GET/PUT /status/me/local-time.
struct OwnLocalTimeDto: Decodable {
    var shareLocalTime = true
    var shareLocalTimeAt: Int64 = 0
    var localTime: LocalTimeInfo?

    private enum CodingKeys: String, CodingKey { case shareLocalTime, shareLocalTimeAt, localTime }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        shareLocalTime = try c.decodeIfPresent(Bool.self, forKey: .shareLocalTime) ?? true
        let at: Double? = (try? c.decodeIfPresent(Double.self, forKey: .shareLocalTimeAt)) ?? nil
        shareLocalTimeAt = at.flatMap { $0.isFinite && $0 > 0 ? Int64($0) : nil } ?? 0
        localTime = (try? c.decodeIfPresent(LocalTimeInfo.self, forKey: .localTime)) ?? nil
    }
}

/// Ответ GET /users/:id/local-time.
struct PeerLocalTimeDto: Decodable {
    var userId: String?
    var localTime: LocalTimeInfo?

    private enum CodingKeys: String, CodingKey { case userId, localTime }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        userId = try c.decodeIfPresent(String.self, forKey: .userId)
        localTime = (try? c.decodeIfPresent(LocalTimeInfo.self, forKey: .localTime)) ?? nil
    }
}

/// Тело события `localtime:update` {userId, localTime|null}.
struct LocalTimeUpdatePayload: Decodable {
    let userId: String
    var localTime: LocalTimeInfo?

    private enum CodingKeys: String, CodingKey { case userId, localTime }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        userId = try c.decode(String.self, forKey: .userId)
        // Битый пояс — то же, что null: строку убираем, а не держим устаревшую.
        localTime = (try? c.decodeIfPresent(LocalTimeInfo.self, forKey: .localTime)) ?? nil
    }
}

/// Состояние своей настройки в том виде, в каком его последний раз сообщил СЕРВЕР.
struct LocalTimeShareState: Codable, Equatable {
    var share: Bool
    /// Момент изменения по часам сервера (мс); 0 — ни разу не меняли.
    var at: Int64

    /// Принять ли пришедшее от сервера: только не старее того, что уже знаем. Ответы и события
    /// могут прийти не по порядку (ack старого отчёта после localtime:settings), а откат на
    /// старое состояние потом ушёл бы напоминанием и вернул бы его на сервере.
    static func merge(known: LocalTimeShareState?, incoming: LocalTimeShareState) -> LocalTimeShareState {
        guard let known else { return incoming }
        return incoming.at >= known.at ? incoming : known
    }

    /// Разбор {shareLocalTime, shareLocalTimeAt} из ack/события; nil — поля нет или оно не то.
    static func parse(_ dict: [String: Any]) -> LocalTimeShareState? {
        guard let share = dict["shareLocalTime"] as? Bool else { return nil }
        let rawAt = (dict["shareLocalTimeAt"] as? NSNumber)?.doubleValue ?? 0
        let at = rawAt.isFinite && rawAt > 0 ? Int64(rawAt) : 0
        return LocalTimeShareState(share: share, at: at)
    }
}

/// Отчёт о своём поясе и своя настройка «Показывать моё местное время». Пояс собеседника
/// подкачивает экран беседы (ChatViewModel.refreshPeerLocalTime) через свой репозиторий.
///
/// Только главный поток: всё зовётся из обработчиков сокета (handleQueue = main), из вью и из
/// уведомлений системы с queue: .main.
final class LocalTimeService: ObservableObject {
    static let shared = LocalTimeService()

    /// Своя настройка «Показывать моё местное время» (nil — с сервера ещё ничего не слышали;
    /// переключатель тогда показывает значение по умолчанию — включено).
    @Published private(set) var share: LocalTimeShareState?
    /// Какой пояс сейчас видят собеседники (из GET/PUT); nil — неизвестно.
    @Published private(set) var visibleToPeers: LocalTimeInfo?
    /// Идёт PUT настройки — переключатель погашен.
    @Published private(set) var saving = false
    /// false — сервер ручки не знает (до выкладки e4c3a02d): переключатель честно погашен.
    @Published private(set) var serverSupported: Bool?
    @Published private(set) var error: String?

    /// Пояс, о котором последний раз сообщили (чтобы при возврате из фона заметить смену).
    private var lastReportedZone: String?
    private var observers: [NSObjectProtocol] = []
    private let defaults: UserDefaults
    /// Чья настройка в памяти: при смене аккаунта её надо перечитать с диска.
    private var shareOwner: String?

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        let center = NotificationCenter.default
        // Смена пояса (перелёт, ручная смена в Настройках): сообщаем сразу, не дожидаясь
        // переподключения сокета.
        observers.append(center.addObserver(
            forName: .NSSystemTimeZoneDidChange, object: nil, queue: .main
        ) { [weak self] _ in
            NSTimeZone.resetSystemTimeZone()
            self?.reportIfZoneChanged(force: true)
        })
        // Подстраховка: уведомление о смене пояса, случившейся в фоне, может и не дойти.
        observers.append(center.addObserver(
            forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main
        ) { [weak self] _ in
            NSTimeZone.resetSystemTimeZone()
            self?.reportIfZoneChanged(force: false)
        })
    }

    // MARK: Хранилище настройки (по пользователю)

    private static func storageKey(_ userId: String) -> String { "eb.localtime.share.\(userId)" }

    /// Сохранённая настройка ЭТОГО пользователя. Ключ по userId: напоминание чужой настройкой
    /// (после смены аккаунта на телефоне) выключило бы время совсем другому человеку.
    func storedShare(userId: String) -> LocalTimeShareState? {
        guard let data = defaults.data(forKey: Self.storageKey(userId)) else { return nil }
        return try? JSONDecoder().decode(LocalTimeShareState.self, from: data)
    }

    /// Принять состояние настройки, пришедшее от сервера (ack, GET/PUT, localtime:settings).
    func applyServerShare(_ incoming: LocalTimeShareState, userId: String) {
        let merged = LocalTimeShareState.merge(known: storedShare(userId: userId), incoming: incoming)
        if let data = try? JSONEncoder().encode(merged) {
            defaults.set(data, forKey: Self.storageKey(userId))
        }
        if currentUserId() == userId {
            shareOwner = userId
            if share != merged { share = merged }
        }
    }

    /// Тело localtime:report: пояс + напоминание о настройке (если сервер её уже сообщал).
    /// nil — пояс телефона серверу не передать (дробное смещение без имени IANA).
    static func reportPayload(zone: TimeZone, stored: LocalTimeShareState?) -> [String: Any]? {
        guard let id = LocalTimeFormat.ianaIdentifier(zone) else { return nil }
        var payload: [String: Any] = ["timeZone": id]
        if let stored {
            payload["shareLocalTime"] = stored.share
            payload["shareLocalTimeAt"] = stored.at
        }
        return payload
    }

    // MARK: Отчёт о поясе (сокет)

    /// Сокет подключился (и уже сказал presence:state): сообщить пояс. `emit` — emitWithAck
    /// живого сокета; ack приходит на главный поток.
    func report(emit: (_ payload: [String: Any], _ ack: @escaping ([Any]) -> Void) -> Void) {
        guard let userId = currentUserId() else { return }
        syncOwner(userId)
        guard let payload = Self.reportPayload(zone: TimeZone.current, stored: storedShare(userId: userId)) else {
            NSLog("LocalTime: пояс телефона не в IANA (%@) — не сообщаю", TimeZone.current.identifier)
            return
        }
        let zone = payload["timeZone"] as? String
        lastReportedZone = zone
        emit(payload) { [weak self] data in
            self?.handleReportAck(data, userId: userId, zone: zone)
        }
    }

    private func handleReportAck(_ data: [Any], userId: String, zone: String?) {
        guard let reply = data.first as? [String: Any] else {
            // "NO ACK" — старый сервер без localtime:report: ничего не делаем, следующий
            // коннект спросит снова.
            return
        }
        if reply["ok"] as? Bool == true {
            if let state = LocalTimeShareState.parse(reply) {
                applyServerShare(state, userId: userId)
            }
        } else {
            NSLog("LocalTime: сервер не принял пояс %@: %@", zone ?? "?", String(describing: reply["error"] ?? "?"))
            // rate_limited / error — пусть следующий повод (смена пояса, коннект) повторит.
            if lastReportedZone == zone { lastReportedZone = nil }
        }
    }

    private func reportIfZoneChanged(force: Bool) {
        guard currentUserId() != nil else { return }
        let now = LocalTimeFormat.ianaIdentifier(TimeZone.current)
        guard force || now != lastReportedZone else { return }
        AppContainer.shared.realtimeClient.reportLocalTime()
    }

    /// Событие localtime:settings — настройку поменяли (здесь или на другом своём устройстве).
    func onSettingsEvent(_ dict: [String: Any]) {
        guard let userId = currentUserId(), let state = LocalTimeShareState.parse(dict) else { return }
        applyServerShare(state, userId: userId)
    }

    // MARK: Своя настройка (экран профиля)

    /// Экран профиля открылся: показать то, что знаем, и сверить с сервером.
    func loadOwn() {
        guard let userId = currentUserId() else { return }
        syncOwner(userId)
        error = nil
        Task { @MainActor in
            do {
                let dto: OwnLocalTimeDto = try await AppContainer.shared.api.get("status/me/local-time")
                serverSupported = true
                visibleToPeers = dto.localTime
                let server = LocalTimeShareState(share: dto.shareLocalTime, at: dto.shareLocalTimeAt)
                // Сервер помнит настройку старее нашей (Redis откатился к старому снимку) —
                // напомнить сразу, а не ждать следующего подключения сокета: иначе всё это
                // время собеседники видели бы скрытое время.
                if let stored = storedShare(userId: userId), stored.at > server.at, stored.share != server.share {
                    AppContainer.shared.realtimeClient.reportLocalTime()
                }
                applyServerShare(server, userId: userId)
            } catch let http as HTTPError where http.code == 404 {
                serverSupported = false
            } catch {
                // Нет сети — переключатель остаётся с последним известным значением.
            }
        }
    }

    /// Переключатель. Оптимистично: значение меняется сразу, на сбое возвращается.
    func setShare(_ on: Bool) {
        guard let userId = currentUserId(), !saving else { return }
        syncOwner(userId)
        let before = share
        share = LocalTimeShareState(share: on, at: before?.at ?? 0)
        saving = true
        error = nil
        Task { @MainActor in
            defer { saving = false }
            do {
                let dto: OwnLocalTimeDto = try await AppContainer.shared.api.put(
                    "status/me/local-time", body: ShareBody(shareLocalTime: on)
                )
                serverSupported = true
                visibleToPeers = dto.localTime
                // Ответ PUT — свежайшее состояние сервера: merge его не отвергнет (at растёт).
                applyServerShare(LocalTimeShareState(share: dto.shareLocalTime, at: dto.shareLocalTimeAt), userId: userId)
            } catch let http as HTTPError {
                share = before
                if http.code == 404 {
                    serverSupported = false
                } else {
                    error = http.code == 429 ? "Слишком часто — попробуйте через минуту" : "Не удалось сохранить настройку"
                }
            } catch {
                share = before
                self.error = "Нет связи с сервером"
            }
        }
    }

    private struct ShareBody: Encodable { let shareLocalTime: Bool }

    // MARK: Выход

    /// Выход из аккаунта: настройка в памяти принадлежала прошлой сессии.
    func resetForLogout() {
        share = nil
        shareOwner = nil
        visibleToPeers = nil
        serverSupported = nil
        error = nil
        lastReportedZone = nil
    }

    private func syncOwner(_ userId: String) {
        guard shareOwner != userId else { return }
        shareOwner = userId
        share = storedShare(userId: userId)
        visibleToPeers = nil
    }

    private func currentUserId() -> String? {
        AppContainer.shared.sessionStore.currentUserId()
    }
}
