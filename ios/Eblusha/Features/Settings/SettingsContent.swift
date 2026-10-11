import Foundation
import SwiftUI

// «Центр управления» на iOS — содержание без интерфейса: какие разделы есть, как они
// называются, что пишут итоги у строк, как строятся сеансы, указатель поиска и раскладка
// плиток. Всё здесь — чистые функции и значения: проверяются XCTest (EblushaTests/
// SettingsCenterTests.swift) без экрана и без сети. Тексты — натива 2.0.11
// (settings-unify/REFERENCE.md), где строка та же; своё — только там, где её на ПК нет.

// MARK: - Разделы

/// Разделы «Центра управления» на iOS. Порядок = порядок плиток и обхода диктором (SPEC §1.1).
/// «Обновления» нет (iOS обновляется через TestFlight), «Игры» определяет только ПК.
enum SettingsSectionID: String, CaseIterable, Identifiable, Hashable {
    case profile, conn, av, security, app

    var id: String { rawValue }

    var title: String {
        switch self {
        case .profile: return "Профиль"
        case .conn: return "Соединение"
        case .av: return "Звук и видео"
        case .security: return "Безопасность"
        case .app: return "Приложение"
        }
    }

    /// SF Symbol (SPEC §3.4).
    var symbol: String {
        switch self {
        case .profile: return "person"
        case .conn: return "globe"
        case .av: return "mic"
        case .security: return "shield"
        case .app: return "macwindow"
        }
    }

    var subtitle: String {
        switch self {
        case .profile: return "Ваше фото и имя видны собеседникам."
        case .conn: return "Через какой адрес работает приложение."
        case .av: return "Доступ к микрофону и камере для звонков."
        case .security: return "Секретные чаты и устройства, где открыт аккаунт."
        case .app: return "Видео в переписке, звуки и уведомления."
        }
    }

    /// Плитка на всю ширину при двух колонках: «Профиль» (и «Обновления» там, где они есть).
    var isWideTile: Bool { self == .profile }
}

// MARK: - Итог у строки

/// Итог у своей строки (SPEC §3.7). Вид выводится не из текста, а ставится явно.
struct RowMessage: Equatable {
    enum Kind: Equatable { case ok, busy, err, note, lock, dim }
    let kind: Kind
    let text: String

    static func ok(_ text: String) -> RowMessage { .init(kind: .ok, text: text) }
    static func busy(_ text: String) -> RowMessage { .init(kind: .busy, text: text) }
    static func err(_ text: String) -> RowMessage { .init(kind: .err, text: text) }
    static func note(_ text: String) -> RowMessage { .init(kind: .note, text: text) }
    static func dim(_ text: String) -> RowMessage { .init(kind: .dim, text: text) }
}

// MARK: - Указатель поиска

/// Одна строка указателя поиска. `id` — тот же ключ, что у натива и у остальных клиентов
/// (SPEC §1.3): расхождения ловит тест `testIndexIdsMatchSpec`.
struct SettingsSearchRow: Identifiable, Equatable {
    let id: String
    /// nil — строка вне разделов («Выйти из Еблуши»).
    let section: SettingsSectionID?
    let title: String
    let caption: String
    /// Синонимы через пробел.
    let keywords: String

    var rowAnchor: String { "row-" + id }
}

enum SettingsSearch {

    /// Указатель iOS: строки §1.3, которые есть на этой платформе (колонка «iOS»), порядок = порядок
    /// плиток. Пояснения те же, что на экране раздела; синонимы — натива, для новых строк — SPEC §3.9.
    static let rows: [SettingsSearchRow] = [
        .init(id: "p-photo", section: .profile, title: "Фото профиля",
              caption: "В круг попадёт центральная часть фото. Новое фото сохраняется сразу.",
              keywords: "аватар аватарка картинка снимок фотография"),
        .init(id: "p-name", section: .profile, title: "Отображаемое имя",
              caption: "Под этим именем вас увидят другие пользователи.",
              keywords: "ник никнейм"),
        .init(id: "p-eblid", section: .profile, title: "EBLID",
              caption: "Ваш номер в Еблуше — по нему вас находят в «Контактах».",
              keywords: "номер айди id идентификатор"),
        .init(id: "p-ltime", section: .profile, title: "Показывать моё местное время",
              caption: "Собеседники в личных чатах видят в шапке беседы, который у вас час, и город по часовому поясу.",
              keywords: "время часы часовой пояс город таймзона timezone местное"),
        .init(id: "p-bot", section: .profile, title: "Чат с Еблушей",
              caption: "Личный чат с ботом: там можно писать без обращения. В остальных беседах зовите «Еблуша, …».",
              keywords: "бот еблуша eblusha bot ассистент помощник нейросеть ии ai вопрос спросить valheim вальхейм"),
        .init(id: "c-server", section: .conn, title: "Сервер",
              caption: "Если напрямую сервер не открывается, попробуйте через СПб. Смена сервера — это выход из аккаунта.",
              keywords: "адрес напрямую спб санкт-петербург блокировка vpn прокси eblusha.org источник зеркало"),
        .init(id: "a-permmic", section: .av, title: "Доступ к микрофону",
              caption: "Без него вас не слышно в звонках и не записать голосовое.",
              keywords: "разрешение доступ микрофон гарнитура mic"),
        .init(id: "a-permcam", section: .av, title: "Доступ к камере",
              caption: "Без него собеседники не увидят ваше видео.",
              keywords: "разрешение доступ камера вебка"),
        .init(id: "s-link", section: .security, title: "Подключить этот телефон",
              caption: "Покажите код телефона на уже подключённом устройстве («Подтвердить по коду») — и сюда придут ключи секретных чатов.",
              keywords: "привязать связать qr код новое устройство секретные ключи"),
        .init(id: "s-sess", section: .security, title: "Активные сеансы",
              caption: "Телефоны, браузеры и приложения, где открыт ваш аккаунт.",
              keywords: "устройства телефон браузер отключить разлогинить ключи"),
        .init(id: "ap-autoplay", section: .app, title: "Автовоспроизведение видео",
              caption: "Короткие видео в переписке оживают сами — без звука и только пока плитка на экране.",
              keywords: "видео wifi вайфай автозапуск ролики"),
        .init(id: "ap-sndin", section: .app, title: "Звук входящих сообщений",
              caption: "Короткий звук, когда приходит сообщение, а беседа не открыта.",
              keywords: "звук входящие сообщения"),
        .init(id: "ap-sndout", section: .app, title: "Звук отправки",
              caption: "Короткий звук, когда сообщение ушло.",
              keywords: "звук отправка"),
        .init(id: "ap-notif", section: .app, title: "Уведомления",
              caption: "Сообщения и звонки, пока Еблуша закрыта.",
              keywords: "уведомления пуш push оповещения баннеры значок"),
        .init(id: "x-exit", section: nil, title: "Выйти из Еблуши",
              caption: "Выход из аккаунта на этом телефоне.",
              keywords: "выход выйти разлогиниться аккаунт"),
    ]

    /// Ключ строки → её запись (для текущего значения у выдачи и прокрутки к строке).
    static func row(_ id: String) -> SettingsSearchRow? { rows.first { $0.id == id } }

    /// Сравнение без регистра и «ё» = «е». Работает по символам, а не по строке целиком:
    /// длина не меняется, и найденные диапазоны ложатся на исходный текст один в один.
    static func normalizedChars(_ s: String) -> [Character] {
        s.map { ch in
            let lowered = String(ch).lowercased()
            let c = lowered.count == 1 ? Character(lowered) : ch
            return c == "ё" ? "е" : c
        }
    }

    static func normalize(_ s: String) -> String { String(normalizedChars(s)) }

    /// Слова запроса: слова короче двух знаков отбрасываются (из одной буквы поиска нет).
    static func words(_ query: String) -> [String] {
        normalize(query)
            .split(whereSeparator: { $0.isWhitespace })
            .map(String.init)
            .filter { $0.count >= 2 }
    }

    /// Строка подходит, если КАЖДОЕ слово запроса есть в названии, пояснении, синонимах или
    /// имени раздела (REF §10). Порядок — порядок указателя.
    static func match(_ query: String, in rows: [SettingsSearchRow] = SettingsSearch.rows) -> [SettingsSearchRow] {
        let ws = words(query)
        guard !ws.isEmpty else { return [] }
        return rows.filter { row in
            let hay = normalize([row.title, row.caption, row.keywords, row.section?.title ?? ""].joined(separator: " "))
            return ws.allSatisfy { hay.contains($0) }
        }
    }

    /// Запрос «настоящий»: есть хотя бы одно слово от двух знаков.
    static func isActive(_ query: String) -> Bool { !words(query).isEmpty }

    /// Диапазоны найденных слов в `text` — для подсветки.
    static func highlightRanges(in text: String, words ws: [String]) -> [Range<Int>] {
        guard !ws.isEmpty else { return [] }
        let hay = normalizedChars(text)
        var marks = [Bool](repeating: false, count: hay.count)
        for w in ws {
            let needle = Array(w)
            guard !needle.isEmpty, hay.count >= needle.count else { continue }
            var i = 0
            while i + needle.count <= hay.count {
                if Array(hay[i..<(i + needle.count)]) == needle {
                    for k in i..<(i + needle.count) { marks[k] = true }
                    i += needle.count
                } else {
                    i += 1
                }
            }
        }
        var out: [Range<Int>] = []
        var start: Int?
        for (idx, mark) in marks.enumerated() {
            if mark, start == nil { start = idx }
            if !mark, let s = start { out.append(s..<idx); start = nil }
        }
        if let s = start { out.append(s..<marks.count) }
        return out
    }

    /// Текст с подсветкой найденных слов: фон `rgba(227,139,10,.30)` и сливочный текст (SPEC §3.1).
    static func highlighted(_ text: String, query: String) -> AttributedString {
        var attr = AttributedString(text)
        for range in highlightRanges(in: text, words: words(query)) {
            let lower = attr.index(attr.startIndex, offsetByCharacters: range.lowerBound)
            let upper = attr.index(attr.startIndex, offsetByCharacters: range.upperBound)
            attr[lower..<upper].backgroundColor = Eb.brand600.opacity(0.30)
            attr[lower..<upper].foregroundColor = Eb.logoCream
        }
        return attr
    }

    /// Подстрока выдачи (12.5 Muted): выдержка из пояснения с начала слова за два слова до
    /// совпадения; нашлось только в названии — начало пояснения; только по синониму —
    /// «по слову «…»».
    static func excerpt(_ row: SettingsSearchRow, query: String) -> String {
        let ws = words(query)
        guard let first = ws.first else { return "" }
        let cap = Array(row.caption)
        let capNorm = normalizedChars(row.caption)
        for w in ws {
            let needle = Array(w)
            guard capNorm.count >= needle.count else { continue }
            var i = 0
            while i + needle.count <= capNorm.count {
                if Array(capNorm[i..<(i + needle.count)]) == needle {
                    // Отступить на ~два слова и выровнять на начало слова.
                    var start = max(0, i - 18)
                    while start > 0, cap[start - 1] != " " { start -= 1 }
                    let end = min(cap.count, start + 64)
                    return (start > 0 ? "…" : "") + String(cap[start..<end]) + (end < cap.count ? "…" : "")
                }
                i += 1
            }
        }
        if normalize(row.title).contains(first) {
            return String(row.caption.prefix(60))
        }
        let kw = row.keywords.split(separator: " ").map(String.init)
        if let hit = kw.first(where: { normalize($0).contains(first) }) {
            return "по слову «\(hit)»"
        }
        return ""
    }
}

// MARK: - Раскладка плиток обзора

/// Пары плиток обзора на телефоне (SPEC §2.3): «Профиль» (и «Обновления») — во всю ширину,
/// остальные парами в порядке разделов; нечётная последняя — тоже во всю ширину; уже 360 — одна
/// колонка; от 600 — три, широкие плитки занимают две.
enum SettingsGridLayout {
    struct Cell: Equatable {
        let section: SettingsSectionID
        let span: Int
    }

    static func columns(forWidth width: CGFloat, largeText: Bool) -> Int {
        if largeText { return 1 }
        if width < 360 { return 1 }
        if width >= 600 { return 3 }
        return 2
    }

    static func rows(for sections: [SettingsSectionID], columns: Int) -> [[Cell]] {
        let cols = max(1, columns)
        if cols == 1 { return sections.map { [Cell(section: $0, span: 1)] } }
        var rows: [[Cell]] = []
        var current: [Cell] = []
        var used = 0

        func flush() {
            guard !current.isEmpty else { return }
            // Свободное место в строке достаётся последней плитке: пустых «дыр» в сетке нет.
            if used < cols, let last = current.popLast() {
                current.append(Cell(section: last.section, span: last.span + (cols - used)))
            }
            rows.append(current)
            current = []
            used = 0
        }

        for section in sections {
            let span = section.isWideTile ? min(2, cols) : 1
            if cols == 2 && section.isWideTile {
                // Широкая при двух колонках — всегда своей строкой.
                flush()
                rows.append([Cell(section: section, span: 2)])
                continue
            }
            if used + span > cols { flush() }
            current.append(Cell(section: section, span: span))
            used += span
            if used == cols { flush() }
        }
        flush()
        return rows
    }
}

// MARK: - Тексты и числа

enum SettingsText {

    /// Склонение: 1 устройство, 2 устройства, 5 устройств.
    static func plural(_ n: Int, _ one: String, _ few: String, _ many: String) -> String {
        let m10 = n % 10, m100 = n % 100
        if m10 == 1 && m100 != 11 { return one }
        if (2...4).contains(m10) && !(10..<20).contains(m100) { return few }
        return many
    }

    static func devicesCount(_ n: Int) -> String {
        "\(n) " + plural(n, "устройство", "устройства", "устройств")
    }

    static func matches(_ n: Int) -> String {
        "\(n) " + plural(n, "совпадение", "совпадения", "совпадений")
    }

    static func settingsCount(_ n: Int) -> String {
        "\(n) " + plural(n, "настройка", "настройки", "настроек")
    }

    /// «Еблуша для iPhone 1.0 · сборка 1036» (SPEC §1.4). Метка — номер сборки у TestFlight
    /// и короткий хеш коммита у отладочной; нет метки — только версия.
    static func versionLine(version: String?, buildTag: String?) -> String {
        let v = (version ?? "").trimmingCharacters(in: .whitespaces)
        let tag = (buildTag ?? "").trimmingCharacters(in: .whitespaces)
        let base = "Еблуша для iPhone " + (v.isEmpty ? "?" : v)
        return tag.isEmpty ? base : base + " · сборка " + tag
    }

    static func versionLineFromBundle() -> String {
        versionLine(
            version: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String,
            buildTag: Bundle.main.infoDictionary?["EblushaBuildTag"] as? String
        )
    }

    // MARK: Итоги «Местного времени» и «Чата с Еблушей» (тексты натива)

    /// Итог у строки «Показывать моё местное время» (REF §8.1). Ошибки сервиса приходят
    /// прежними короткими фразами iOS — здесь они приводятся к текстам натива.
    static func localTimeMessage(
        share: Bool?, saving: Bool, serverSupported: Bool?, peerLine: String?, error: String?
    ) -> RowMessage? {
        if saving { return .busy("Сохраняем…") }
        if let error { return .err(normalizedSaveError(error)) }
        if serverSupported == false {
            return .note("Сейчас недоступно: сервер ещё не умеет показывать местное время.")
        }
        if share == false { return .dim("Скрыто: собеседники не видят ваше время.") }
        if let peerLine { return .ok("Собеседники видят: \(peerLine)") }
        if share == true {
            return .note("Собеседники увидят ваше время, как только устройство сообщит часовой пояс.")
        }
        return nil
    }

    /// Итог у строки «Чат с Еблушей» (REF §8.1).
    static func botMessage(enabled: Bool, saving: Bool, error: String?) -> RowMessage? {
        if saving { return .busy("Сохраняем…") }
        if let error { return .err(normalizedSaveError(error)) }
        return enabled ? .dim("Включён: «Еблуша» в списке бесед.") : .dim("Выключен.")
    }

    /// Фразы сервисов iOS («Слишком часто — …», «Не удалось сохранить настройку», «Нет связи …»)
    /// → тексты натива.
    static func normalizedSaveError(_ raw: String) -> String {
        let lower = raw.lowercased()
        if lower.contains("слишком часто") || lower.contains("слишком много") {
            return "Слишком много переключений — попробуйте через минуту."
        }
        if lower.contains("не удалось сохранить") {
            return "Не удалось сохранить настройку. Попробуйте ещё раз."
        }
        if lower.contains("нет связи") || lower.contains("нет соединения") {
            return "Нет связи с сервером. Попробуйте ещё раз."
        }
        return raw
    }

    /// «15:01, Бухарест» — что собеседники видят прямо сейчас.
    static func peerLine(_ info: LocalTimeInfo, now: Date) -> String {
        let zone = TimeZone(identifier: info.timeZone) ?? TimeZone(secondsFromGMT: info.offsetMinutes * 60) ?? .current
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        let comps = calendar.dateComponents([.hour, .minute], from: now)
        let time = String(format: "%02d:%02d", comps.hour ?? 0, comps.minute ?? 0)
        let place = info.city ?? LocalTimeFormat.offsetLabel(seconds: LocalTimeFormat.offsetSeconds(info, at: now))
        return "\(time), \(place)"
    }
}

// MARK: - Разрешения (только чтение)

/// Состояние системного разрешения. `restricted` (экранное время, профиль) для человека —
/// то же, что запрет: включить в приложении нельзя.
enum PermissionState: Equatable {
    case granted, notDetermined, denied

    var isDenied: Bool { self == .denied }
}

struct NotificationSummary: Equatable {
    var state: PermissionState
    var alert: Bool
    var sound: Bool
    var badge: Bool

    /// Разрешены ли сами уведомления (хотя бы баннеры в Центре или звук).
    var isOn: Bool { state == .granted && (alert || sound || badge) }
}

enum PermissionText {
    static func micMessage(_ state: PermissionState) -> RowMessage {
        switch state {
        case .granted: return .ok("Разрешён.")
        case .notDetermined: return .note("iOS спросит при первом звонке или записи голосового.")
        case .denied: return .err("Нет доступа к микрофону. Разрешите его в настройках iOS.")
        }
    }

    static func camMessage(_ state: PermissionState) -> RowMessage {
        switch state {
        case .granted: return .ok("Разрешён.")
        case .notDetermined: return .note("iOS спросит при первом включении камеры.")
        case .denied: return .err("Нет доступа к камере. Разрешите её в настройках iOS.")
        }
    }

    static func notificationMessage(_ n: NotificationSummary?) -> RowMessage? {
        guard let n else { return nil }
        switch n.state {
        case .notDetermined:
            return .note("iOS ещё не спрашивал разрешение — спросит при следующем входе.")
        case .denied:
            return .err("Уведомления выключены — сообщения придут, только когда Еблуша открыта.")
        case .granted:
            var parts: [String] = []
            if n.alert { parts.append("баннеры") }
            if n.sound { parts.append("звук") }
            if n.badge { parts.append("значок") }
            if parts.isEmpty {
                return .err("Уведомления выключены — сообщения придут, только когда Еблуша открыта.")
            }
            return .ok("Разрешены: " + parts.joined(separator: ", ") + ".")
        }
    }

    /// Мини-строка плитки «Звук и видео».
    static func tileLine(_ label: String, _ state: PermissionState) -> String {
        switch state {
        case .granted: return "\(label): есть"
        case .notDetermined: return "\(label): спросим"
        case .denied: return "\(label): нет доступа"
        }
    }

    /// Строка колонки / диктора раздела «Звук и видео» (SPEC §1.2).
    static func avState(mic: PermissionState, cam: PermissionState) -> (text: String, isError: Bool) {
        if mic.isDenied { return ("Нет доступа к микрофону", true) }
        if cam.isDenied { return ("Нет доступа к камере", true) }
        if mic == .granted && cam == .granted { return ("микрофон и камера — есть", false) }
        return ("микрофон и камера — спросим", false)
    }
}

// MARK: - Сеансы

/// Сеанс на экране: несколько записей одного и того же устройства (тот же адрес, имя, платформа)
/// сводятся в одну строку с «+N», как на вебе.
struct SessionRowData: Identifiable, Equatable {
    let session: DeviceSession
    /// Сколько ещё записей свёрнуто в эту строку («+N»).
    let extra: Int
    var id: String { session.id }
}

enum SessionPresentation {

    /// «Android», «iOS», «Windows», «Браузер», «macOS»… вместо сырого слова сервера.
    static func platformLabel(_ raw: String?) -> String {
        let p = (raw ?? "").trimmingCharacters(in: .whitespaces)
        let l = p.lowercased()
        if l.isEmpty { return "Устройство" }
        if l.contains("ipad") { return "iPadOS" }
        if l.contains("ios") || l.contains("iphone") { return "iOS" }
        if l.contains("android") { return "Android" }
        if l.contains("windows") || l == "win32" || l == "win" { return "Windows" }
        if l.contains("mac") { return "macOS" }
        if l.contains("linux") { return "Linux" }
        if l == "web" || l.contains("browser") || l.contains("браузер") { return "Браузер" }
        return p.prefix(1).uppercased() + p.dropFirst()
    }

    /// SF Symbol: телефон / планшет / ПК / браузер (SPEC §3.4).
    static func symbol(_ raw: String?) -> String {
        let l = (raw ?? "").lowercased()
        if l.contains("ipad") || l.contains("tablet") { return "ipad" }
        if l.contains("ios") || l.contains("iphone") || l.contains("android") { return "iphone" }
        if l == "web" || l.contains("browser") || l.contains("браузер") { return "globe" }
        return "desktopcomputer"
    }

    /// Строки сеансов: одинаковые (имя, платформа, адрес, место) — одна строка с «+N». Строкой-
    /// представителем становится своя запись, если она в группе есть, иначе самая свежая.
    static func group(_ sessions: [DeviceSession]) -> [SessionRowData] {
        func norm(_ s: String?) -> String { (s ?? "").trimmingCharacters(in: .whitespaces).lowercased() }
        var order: [String] = []
        var groups: [String: [DeviceSession]] = [:]
        for s in sessions {
            let base = [norm(s.name), norm(s.platform), norm(s.ip), norm(s.location)].joined(separator: "|")
            let key = base == "|||" ? "id:\(s.id)" : base
            if groups[key] == nil { order.append(key) }
            groups[key, default: []].append(s)
        }
        let rows: [SessionRowData] = order.compactMap { key in
            guard let list = groups[key], !list.isEmpty else { return nil }
            let rep = list.first(where: { $0.isCurrent })
                ?? list.max(by: { ($0.lastSeenMs ?? 0) < ($1.lastSeenMs ?? 0) })!
            return SessionRowData(session: rep, extra: list.count - 1)
        }
        // Своё устройство первым, дальше по свежести — как в списке сервера.
        return rows.sorted { a, b in
            if a.session.isCurrent != b.session.isCurrent { return a.session.isCurrent }
            return (a.session.lastSeenMs ?? 0) > (b.session.lastSeenMs ?? 0)
        }
    }

    /// Есть ли своё устройство в списке. Без этого `POST /devices/revoke-others` отозвал бы ВСЕ
    /// устройства аккаунта, включая сам телефон (inventory-ios §7.3).
    static func currentInList(_ sessions: [DeviceSession]) -> Bool { sessions.contains { $0.isCurrent } }

    static func hasOthers(_ sessions: [DeviceSession]) -> Bool { sessions.contains { !$0.isCurrent } }

    /// «Все другие» доступна, только когда своё устройство в списке и есть кого отключать.
    static func canRevokeOthers(_ sessions: [DeviceSession]) -> Bool {
        currentInList(sessions) && hasOthers(sessions)
    }

    static func revokeOthersHint(_ sessions: [DeviceSession]) -> String? {
        if !currentInList(sessions) { return "Сначала это устройство должно появиться в списке" }
        if !hasOthers(sessions) { return "Других устройств нет" }
        return nil
    }

    /// «сейчас в сети» / «был в сети сегодня, 11:52» / «вчера, 23:05» / «был в сети 02.10.2026, 18:52».
    static func seenLine(
        lastSeenMs: Int64?, isCurrent: Bool, now: Date = Date(), calendar: Calendar = .current
    ) -> String? {
        if isCurrent { return "сейчас в сети" }
        guard let ms = lastSeenMs else { return nil }
        let date = Date(timeIntervalSince1970: Double(ms) / 1000)
        var cal = calendar
        cal.locale = Locale(identifier: "ru_RU")
        let time = { () -> String in
            let c = cal.dateComponents([.hour, .minute], from: date)
            return String(format: "%02d:%02d", c.hour ?? 0, c.minute ?? 0)
        }()
        if cal.isDate(date, inSameDayAs: now) { return "был в сети сегодня, \(time)" }
        if let y = cal.date(byAdding: .day, value: -1, to: now), cal.isDate(date, inSameDayAs: y) {
            return "был в сети вчера, \(time)"
        }
        let c = cal.dateComponents([.day, .month, .year], from: date)
        return String(format: "был в сети %02d.%02d.%04d, ", c.day ?? 0, c.month ?? 0, c.year ?? 0) + time
    }

    /// Строка 13.5 Muted: «Android · Бухарест, Румыния · 95.76.10.12»; пустые части опускаются.
    static func metaLine(_ s: DeviceSession) -> String {
        [platformLabel(s.platform), s.location, s.ip]
            .compactMap { $0 }
            .filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
            .joined(separator: " · ")
    }
}

// MARK: - Плитка «Безопасность»

enum SecurityTileState: Equatable {
    case loading
    case failed
    case ready(count: Int, keysReady: Bool)
}
