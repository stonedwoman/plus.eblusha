import SwiftUI
import XCTest
@testable import Eblusha

// «Центр управления» на iOS (Features/Settings): указатель поиска и совпадение, раскладка плиток,
// тексты и сводка по разделам, сеансы, разрешения, «янтарь в полоску» и вью-модель настроек
// (панель сохранения, вопросы на месте, защита «Все другие»). Без сети: чистые функции и
// вью-модель поверх подменного SettingsProfileAPI.

// MARK: - Поиск

final class SettingsSearchTests: XCTestCase {

    /// SPEC §1.3, колонка «iOS»: те же `id`, что у натива и остальных клиентов. Расхождение —
    /// ошибка: поиск и прыжок к строке ищут строки по этим ключам.
    func testIndexIdsMatchSpec() {
        let expected: [String] = [
            "p-photo", "p-name", "p-bio", "p-eblid", "p-status", "p-ltime", "p-bot",
            "c-server",
            "a-permmic", "a-permcam",
            "s-link", "s-sess",
            "ap-autoplay", "ap-sndin", "ap-sndout", "ap-notif",
            "x-exit",
        ]
        XCTAssertEqual(SettingsSearch.rows.map(\.id), expected)
        XCTAssertEqual(Set(SettingsSearch.rows.map(\.id)).count, SettingsSearch.rows.count, "id не должны повторяться")
    }

    /// На iOS нет «Обновлений» и «Игр», а строки ПК и веба (пароль, ретранслятор, обработка голоса)
    /// не должны попадать в указатель.
    func testIndexHasOnlyIosRows() {
        let ids = Set(SettingsSearch.rows.map(\.id))
        for foreign in ["s-pass", "c-relay", "a-echo", "a-ns", "a-agc", "a-shres", "ap-yt", "ap-fsi", "u-ver", "u-install", "u-news"] {
            XCTAssertFalse(ids.contains(foreign), foreign)
        }
        let sections = Set(SettingsSearch.rows.compactMap(\.section))
        XCTAssertEqual(sections, Set(SettingsSectionID.allCases))
    }

    func testSectionOrderIsNativeOrder() {
        XCTAssertEqual(SettingsSectionID.allCases.map(\.rawValue), ["profile", "conn", "av", "security", "app"])
        XCTAssertEqual(SettingsSectionID.allCases.map(\.title), ["Профиль", "Соединение", "Звук и видео", "Безопасность", "Приложение"])
        // Строки указателя идут в порядке разделов.
        let order = SettingsSearch.rows.compactMap(\.section).map { SettingsSectionID.allCases.firstIndex(of: $0)! }
        XCTAssertEqual(order, order.sorted())
    }

    func testWordsDropShortAndFoldYo() {
        XCTAssertEqual(SettingsSearch.words("  Отошёл  а  ДНД "), ["отошел", "днд"])
        XCTAssertTrue(SettingsSearch.words("я").isEmpty)
        XCTAssertFalse(SettingsSearch.isActive(" а "))
        XCTAssertTrue(SettingsSearch.isActive("ab"))
    }

    func testYoMatchesYe() {
        // «Отошёл» лежит в синонимах строки статуса: ё = е в обе стороны.
        XCTAssertEqual(SettingsSearch.match("отошел").map(\.id), ["p-status"])
        XCTAssertEqual(SettingsSearch.match("ОТОШЁЛ").map(\.id), ["p-status"])
    }

    func testAllWordsMustMatch() {
        // «звук» есть у строк звуков и (по имени раздела «Звук и видео») у доступа к микрофону и камере.
        let sound = SettingsSearch.match("звук").map(\.id)
        XCTAssertEqual(sound, ["a-permmic", "a-permcam", "ap-autoplay", "ap-sndin", "ap-sndout"])
        // Второе слово сужает: «звук отправка» — только звук отправки.
        XCTAssertEqual(SettingsSearch.match("звук отправка").map(\.id), ["ap-sndout"])
        // Слово из одной буквы не считается.
        XCTAssertEqual(SettingsSearch.match("звук о").map(\.id), sound)
        XCTAssertTrue(SettingsSearch.match("звук ыыыы").isEmpty)
        XCTAssertTrue(SettingsSearch.match("").isEmpty)
    }

    func testMatchesSynonymsAndSectionName() {
        XCTAssertTrue(SettingsSearch.match("vpn").map(\.id).contains("c-server"))
        XCTAssertTrue(SettingsSearch.match("push").map(\.id).contains("ap-notif"))
        // Имя раздела участвует: «безопасность» находит строки раздела.
        XCTAssertEqual(SettingsSearch.match("безопасность").map(\.id), ["s-link", "s-sess"])
        XCTAssertEqual(SettingsSearch.match("выйти").map(\.id), ["x-exit"])
    }

    func testHighlightRangesAreCaseAndYoInsensitive() {
        let ranges = SettingsSearch.highlightRanges(in: "Отошёл или ОТОШЕЛ", words: ["отошел"])
        XCTAssertEqual(ranges, [0..<6, 11..<17])
        XCTAssertTrue(SettingsSearch.highlightRanges(in: "что-то", words: []).isEmpty)
        // Два слова, пересекающиеся диапазоны сливаются.
        XCTAssertEqual(SettingsSearch.highlightRanges(in: "микрофон", words: ["микро", "крофо"]), [0..<7])
    }

    func testHighlightedKeepsTextIntact() {
        let text = SettingsSearch.highlighted("Звук отправки", query: "звук")
        XCTAssertEqual(String(text.characters), "Звук отправки")
        var marked = 0
        for run in text.runs where run.backgroundColor != nil { marked += text[run.range].characters.count }
        XCTAssertEqual(marked, 4)
    }

    func testExcerpt() {
        let row = SettingsSearch.row("ap-autoplay")!
        // Нашлось в пояснении: выдержка со словом.
        let e = SettingsSearch.excerpt(row, query: "плитка")
        XCTAssertTrue(e.lowercased().contains("плитка"), e)
        // Нашлось в названии: начало пояснения.
        XCTAssertTrue(SettingsSearch.excerpt(row, query: "автовоспроизведение").hasPrefix("Короткие видео"))
        // Только по синониму.
        XCTAssertEqual(SettingsSearch.excerpt(SettingsSearch.row("c-server")!, query: "vpn"), "по слову «vpn»")
    }
}

// MARK: - Раскладка плиток

final class SettingsGridLayoutTests: XCTestCase {

    private let sections = SettingsSectionID.allCases

    func testColumnsByWidth() {
        XCTAssertEqual(SettingsGridLayout.columns(forWidth: 320, largeText: false), 1)
        XCTAssertEqual(SettingsGridLayout.columns(forWidth: 359, largeText: false), 1)
        XCTAssertEqual(SettingsGridLayout.columns(forWidth: 360, largeText: false), 2)
        XCTAssertEqual(SettingsGridLayout.columns(forWidth: 440, largeText: false), 2)
        XCTAssertEqual(SettingsGridLayout.columns(forWidth: 600, largeText: false), 3)
        // Крупный шрифт: половинные плитки становятся во всю ширину.
        XCTAssertEqual(SettingsGridLayout.columns(forWidth: 440, largeText: true), 1)
    }

    func testTwoColumnsProfileFullThenPairs() {
        let rows = SettingsGridLayout.rows(for: sections, columns: 2)
        XCTAssertEqual(rows.map { $0.map(\.section) }, [[.profile], [.conn, .av], [.security, .app]])
        XCTAssertEqual(rows.map { $0.map(\.span) }, [[2], [1, 1], [1, 1]])
    }

    func testOddLastTileTakesFullWidth() {
        let four = Array(sections.dropLast())   // профиль + три: пара и одна лишняя
        let rows = SettingsGridLayout.rows(for: four, columns: 2)
        XCTAssertEqual(rows.map { $0.map(\.section) }, [[.profile], [.conn, .av], [.security]])
        XCTAssertEqual(rows.last?.first?.span, 2)
    }

    func testOneColumn() {
        let rows = SettingsGridLayout.rows(for: sections, columns: 1)
        XCTAssertEqual(rows.count, 5)
        XCTAssertTrue(rows.allSatisfy { $0.count == 1 && $0[0].span == 1 })
    }

    func testThreeColumnsWideTileTakesTwo() {
        let rows = SettingsGridLayout.rows(for: sections, columns: 3)
        XCTAssertEqual(rows.map { $0.map(\.section) }, [[.profile, .conn], [.av, .security, .app]])
        XCTAssertEqual(rows.map { $0.map(\.span) }, [[2, 1], [1, 1, 1]])
        // В каждой строке места ровно на всю сетку.
        XCTAssertTrue(rows.allSatisfy { $0.map(\.span).reduce(0, +) == 3 })
    }
}

// MARK: - Тексты, склонение, сводка

final class SettingsTextTests: XCTestCase {

    func testPlural() {
        XCTAssertEqual(SettingsText.devicesCount(1), "1 устройство")
        XCTAssertEqual(SettingsText.devicesCount(2), "2 устройства")
        XCTAssertEqual(SettingsText.devicesCount(4), "4 устройства")
        XCTAssertEqual(SettingsText.devicesCount(5), "5 устройств")
        XCTAssertEqual(SettingsText.devicesCount(11), "11 устройств")
        XCTAssertEqual(SettingsText.devicesCount(21), "21 устройство")
        XCTAssertEqual(SettingsText.devicesCount(0), "0 устройств")
        XCTAssertEqual(SettingsText.settingsCount(4), "4 настройки")
        XCTAssertEqual(SettingsText.matches(1), "1 совпадение")
    }

    func testVersionLine() {
        XCTAssertEqual(SettingsText.versionLine(version: "1.0", buildTag: "1036"), "Еблуша для iPhone 1.0 · сборка 1036")
        XCTAssertEqual(SettingsText.versionLine(version: "1.0", buildTag: " "), "Еблуша для iPhone 1.0")
        XCTAssertEqual(SettingsText.versionLine(version: nil, buildTag: nil), "Еблуша для iPhone ?")
    }

    func testServerRouteTitles() {
        XCTAssertEqual(AppConfig.Server.main.routeTitle, "Напрямую")
        XCTAssertEqual(AppConfig.Server.mirror.routeTitle, "Через СПб")
        XCTAssertEqual(AppConfig.Server.main.title, "eblusha.org")
        XCTAssertEqual(AppConfig.Server.mirror.title, "ru.eblusha.org")
    }

    func testStatusOptions() {
        XCTAssertEqual(SettingsText.statusOptions.map(\.value), ["ONLINE", "AWAY", "DND", "OFFLINE"])
        XCTAssertEqual(SettingsText.statusOption("dnd").label, "Не беспокоить")
        XCTAssertEqual(SettingsText.statusOption("BACKGROUND").value, "ONLINE")
        XCTAssertEqual(SettingsText.statusOption(nil).value, "ONLINE")
    }

    func testLocalTimeMessages() {
        // Тексты натива (REF §8.1); сервис iOS отдаёт свои короткие фразы — они приводятся.
        XCTAssertEqual(SettingsText.localTimeMessage(share: true, saving: true, serverSupported: true, peerLine: nil, error: nil), .busy("Сохраняем…"))
        XCTAssertEqual(SettingsText.localTimeMessage(share: true, saving: false, serverSupported: true, peerLine: "15:01, Бухарест", error: nil), .ok("Собеседники видят: 15:01, Бухарест"))
        XCTAssertEqual(SettingsText.localTimeMessage(share: false, saving: false, serverSupported: true, peerLine: nil, error: nil), .dim("Скрыто: собеседники не видят ваше время."))
        XCTAssertEqual(SettingsText.localTimeMessage(share: true, saving: false, serverSupported: true, peerLine: nil, error: nil),
                       .note("Собеседники увидят ваше время, как только устройство сообщит часовой пояс."))
        XCTAssertEqual(SettingsText.localTimeMessage(share: true, saving: false, serverSupported: false, peerLine: nil, error: nil),
                       .note("Сейчас недоступно: сервер ещё не умеет показывать местное время."))
        XCTAssertEqual(SettingsText.localTimeMessage(share: true, saving: false, serverSupported: true, peerLine: nil, error: "Слишком часто — попробуйте через минуту"),
                       .err("Слишком много переключений — попробуйте через минуту."))
        XCTAssertEqual(SettingsText.localTimeMessage(share: true, saving: false, serverSupported: true, peerLine: nil, error: "Не удалось сохранить настройку"),
                       .err("Не удалось сохранить настройку. Попробуйте ещё раз."))
        XCTAssertNil(SettingsText.localTimeMessage(share: nil, saving: false, serverSupported: nil, peerLine: nil, error: nil))
    }

    func testBotMessages() {
        XCTAssertEqual(SettingsText.botMessage(enabled: true, saving: false, error: nil), .dim("Включён: «Еблуша» в списке бесед."))
        XCTAssertEqual(SettingsText.botMessage(enabled: false, saving: false, error: nil), .dim("Выключен."))
        XCTAssertEqual(SettingsText.botMessage(enabled: false, saving: true, error: nil), .busy("Сохраняем…"))
        XCTAssertEqual(SettingsText.botMessage(enabled: false, saving: false, error: "Слишком часто — попробуйте через минуту"),
                       .err("Слишком много переключений — попробуйте через минуту."))
    }

    func testPeerLine() {
        let info = LocalTimeInfo(timeZone: "Europe/Bucharest", city: "Бухарест", offsetMinutes: 180)
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC")!
        let noon = cal.date(from: DateComponents(year: 2026, month: 1, day: 15, hour: 12, minute: 5))!
        // Зимой Бухарест = UTC+2.
        XCTAssertEqual(SettingsText.peerLine(info, now: noon), "14:05, Бухарест")
        let noCity = LocalTimeInfo(timeZone: "Etc/GMT-7", city: nil, offsetMinutes: 420)
        XCTAssertEqual(SettingsText.peerLine(noCity, now: noon), "19:05, UTC+7")
    }

    func testSummaryStrings() {
        var i = SettingsInputs()
        i.profileName = "Роман"
        i.eblid = "2498"
        XCTAssertEqual(SettingsSummary.make(.profile, inputs: i).state, "Роман · EBLID 2498")
        i.hasUnsaved = true
        XCTAssertEqual(SettingsSummary.make(.profile, inputs: i).state, "Есть несохранённое")
        XCTAssertFalse(SettingsSummary.make(.profile, inputs: i).attention)
        i.saveFailed = true
        XCTAssertTrue(SettingsSummary.make(.profile, inputs: i).attention)

        i.server = .mirror
        XCTAssertEqual(SettingsSummary.make(.conn, inputs: i).state, "Через СПб · ru.eblusha.org")

        i.mic = .granted; i.cam = .granted
        XCTAssertEqual(SettingsSummary.make(.av, inputs: i).state, "микрофон и камера — есть")
        i.cam = .denied
        let av = SettingsSummary.make(.av, inputs: i)
        XCTAssertEqual(av.state, "Нет доступа к камере")
        XCTAssertTrue(av.attention)
        XCTAssertEqual(av.accessibilityName(.av), "Звук и видео: Нет доступа к камере, требует внимания")

        i.sessionsCount = 4
        XCTAssertEqual(SettingsSummary.make(.security, inputs: i).state, "4 устройства")
        i.sessionsLoading = true
        XCTAssertEqual(SettingsSummary.make(.security, inputs: i).state, "Загружаем…")
        i.sessionsLoading = false; i.sessionsFailed = true
        XCTAssertTrue(SettingsSummary.make(.security, inputs: i).attention)

        i.autoplay = .wifi
        XCTAssertEqual(SettingsSummary.make(.app, inputs: i).state, "Видео: только Wi-Fi")
        i.notifications = NotificationSummary(state: .denied, alert: false, sound: false, badge: false)
        XCTAssertTrue(SettingsSummary.make(.app, inputs: i).attention)
        XCTAssertEqual(SettingsSummary.make(.app, inputs: i).accessibilityName(.app), "Приложение: Уведомления выключены, требует внимания")
    }

    func testTileLines() {
        XCTAssertEqual(SettingsSummary.soundsLine(incoming: true, outgoing: true), "Звуки включены")
        XCTAssertEqual(SettingsSummary.soundsLine(incoming: false, outgoing: false), "Звуки выключены")
        XCTAssertEqual(SettingsSummary.soundsLine(incoming: true, outgoing: false), "Звуки: частично")
        XCTAssertEqual(SettingsSummary.videoLine(.wifi), "Видео: по Wi-Fi")
        XCTAssertEqual(SettingsSummary.notificationsLine(NotificationSummary(state: .granted, alert: true, sound: true, badge: true)).text, "Уведомления: да")
        XCTAssertTrue(SettingsSummary.notificationsLine(NotificationSummary(state: .denied, alert: false, sound: false, badge: false)).isError)
    }
}

// MARK: - Разрешения

final class PermissionTextTests: XCTestCase {

    func testMicAndCamMessages() {
        XCTAssertEqual(PermissionText.micMessage(.granted), .ok("Разрешён."))
        XCTAssertEqual(PermissionText.micMessage(.denied), .err("Нет доступа к микрофону. Разрешите его в настройках iOS."))
        XCTAssertEqual(PermissionText.camMessage(.denied), .err("Нет доступа к камере. Разрешите её в настройках iOS."))
        XCTAssertEqual(PermissionText.camMessage(.notDetermined).kind, .note)
    }

    func testNotificationMessage() {
        XCTAssertNil(PermissionText.notificationMessage(nil))
        XCTAssertEqual(PermissionText.notificationMessage(NotificationSummary(state: .granted, alert: true, sound: true, badge: true)),
                       .ok("Разрешены: баннеры, звук, значок."))
        XCTAssertEqual(PermissionText.notificationMessage(NotificationSummary(state: .granted, alert: true, sound: false, badge: true)),
                       .ok("Разрешены: баннеры, значок."))
        XCTAssertEqual(PermissionText.notificationMessage(NotificationSummary(state: .denied, alert: false, sound: false, badge: false))?.kind, .err)
        // Разрешено, но всё выключено вручную — для человека то же, что запрет.
        XCTAssertEqual(PermissionText.notificationMessage(NotificationSummary(state: .granted, alert: false, sound: false, badge: false))?.kind, .err)
        XCTAssertEqual(PermissionText.notificationMessage(NotificationSummary(state: .notDetermined, alert: false, sound: false, badge: false))?.kind, .note)
    }

    func testAvState() {
        XCTAssertEqual(PermissionText.avState(mic: .denied, cam: .granted).text, "Нет доступа к микрофону")
        XCTAssertTrue(PermissionText.avState(mic: .denied, cam: .granted).isError)
        XCTAssertEqual(PermissionText.avState(mic: .granted, cam: .notDetermined).text, "микрофон и камера — спросим")
        XCTAssertEqual(PermissionText.tileLine("Камера", .denied), "Камера: нет доступа")
        XCTAssertEqual(PermissionText.tileLine("Микрофон", .granted), "Микрофон: есть")
    }
}

// MARK: - Сеансы

final class SessionPresentationTests: XCTestCase {

    private func session(
        _ id: String, name: String = "Устройство", platform: String? = "ios", ip: String? = "1.1.1.1",
        location: String? = "Бухарест, Румыния", seen: Int64? = 0, keys: Bool = true, current: Bool = false
    ) -> DeviceSession {
        DeviceSession(id: id, name: name, platform: platform, location: location, ip: ip,
                      lastSeenMs: seen, keysReady: keys, isCurrent: current)
    }

    func testPlatformLabelAndSymbol() {
        XCTAssertEqual(SessionPresentation.platformLabel("ios"), "iOS")
        XCTAssertEqual(SessionPresentation.platformLabel("android"), "Android")
        XCTAssertEqual(SessionPresentation.platformLabel("web"), "Браузер")
        XCTAssertEqual(SessionPresentation.platformLabel("Windows"), "Windows")
        XCTAssertEqual(SessionPresentation.platformLabel("macos"), "macOS")
        XCTAssertEqual(SessionPresentation.platformLabel(nil), "Устройство")
        XCTAssertEqual(SessionPresentation.platformLabel("tizen"), "Tizen")
        XCTAssertEqual(SessionPresentation.symbol("ios"), "iphone")
        XCTAssertEqual(SessionPresentation.symbol("android"), "iphone")
        XCTAssertEqual(SessionPresentation.symbol("ipad"), "ipad")
        XCTAssertEqual(SessionPresentation.symbol("web"), "globe")
        XCTAssertEqual(SessionPresentation.symbol("windows"), "desktopcomputer")
        XCTAssertEqual(SessionPresentation.symbol(nil), "desktopcomputer")
    }

    func testGroupingFoldsDuplicates() {
        let list = [
            session("a", name: "Еблуша для ПК", platform: "windows", seen: 100),
            session("b", name: "Еблуша для ПК", platform: "windows", seen: 300),
            session("c", name: "Pixel 8", platform: "android", seen: 200),
        ]
        let rows = SessionPresentation.group(list)
        XCTAssertEqual(rows.map(\.session.id), ["b", "c"])
        XCTAssertEqual(rows.map(\.extra), [1, 0])
    }

    func testGroupingKeepsCurrentAsRepresentativeAndFirst() {
        let list = [
            session("old", name: "iPhone", seen: 999),
            session("me", name: "iPhone", seen: 1, current: true),
            session("web", name: "Chrome", platform: "web", seen: 500),
        ]
        let rows = SessionPresentation.group(list)
        // Свой сеанс в группе — представитель, даже если он не самый свежий; и он первый.
        XCTAssertEqual(rows.map(\.session.id), ["me", "web"])
        XCTAssertEqual(rows.first?.extra, 1)
        XCTAssertTrue(SessionPresentation.currentInList(list))
    }

    func testCanRevokeOthersNeedsOwnDeviceAndOthers() {
        let me = session("me", current: true)
        let other = session("x", name: "Другой")
        XCTAssertTrue(SessionPresentation.canRevokeOthers([me, other]))
        // Своего нет: revoke-others отозвал бы все устройства, включая телефон.
        XCTAssertFalse(SessionPresentation.canRevokeOthers([other]))
        XCTAssertEqual(SessionPresentation.revokeOthersHint([other]), "Сначала это устройство должно появиться в списке")
        // Некого отключать.
        XCTAssertFalse(SessionPresentation.canRevokeOthers([me]))
        XCTAssertEqual(SessionPresentation.revokeOthersHint([me]), "Других устройств нет")
        XCTAssertNil(SessionPresentation.revokeOthersHint([me, other]))
        XCTAssertFalse(SessionPresentation.canRevokeOthers([]))
    }

    func testSeenLine() {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC")!
        let now = cal.date(from: DateComponents(year: 2026, month: 10, day: 11, hour: 15, minute: 0))!
        func ms(_ d: DateComponents) -> Int64 { Int64(cal.date(from: d)!.timeIntervalSince1970 * 1000) }
        XCTAssertEqual(SessionPresentation.seenLine(lastSeenMs: nil, isCurrent: true, now: now, calendar: cal), "сейчас в сети")
        XCTAssertEqual(SessionPresentation.seenLine(lastSeenMs: ms(.init(year: 2026, month: 10, day: 11, hour: 11, minute: 52)), isCurrent: false, now: now, calendar: cal),
                       "был в сети сегодня, 11:52")
        XCTAssertEqual(SessionPresentation.seenLine(lastSeenMs: ms(.init(year: 2026, month: 10, day: 10, hour: 23, minute: 5)), isCurrent: false, now: now, calendar: cal),
                       "был в сети вчера, 23:05")
        XCTAssertEqual(SessionPresentation.seenLine(lastSeenMs: ms(.init(year: 2026, month: 10, day: 2, hour: 18, minute: 52)), isCurrent: false, now: now, calendar: cal),
                       "был в сети 02.10.2026, 18:52")
        XCTAssertNil(SessionPresentation.seenLine(lastSeenMs: nil, isCurrent: false, now: now, calendar: cal))
    }

    func testMetaLineDropsEmptyParts() {
        XCTAssertEqual(SessionPresentation.metaLine(session("a", platform: "android", ip: "95.76.10.12")), "Android · Бухарест, Румыния · 95.76.10.12")
        XCTAssertEqual(SessionPresentation.metaLine(session("a", platform: "ios", ip: nil, location: " ")), "iOS")
    }
}

// MARK: - «Янтарь в полоску»

final class AmberStripeTests: XCTestCase {

    /// Точки градиента считаются по правилу CSS: L = |w·sinθ| + |h·cosθ|, от центра вдоль
    /// (sinθ, −cosθ). Та же формула у `Ui/AmberStripe.cs` натива и у Android.
    func testGradientPointsFollowCssRule() {
        let size = CGSize(width: 100, height: 100)
        let p = AmberStripe.gradientPoints(angle: 158, size: size)
        let t = 158.0 * .pi / 180
        let length = 100 * abs(sin(t)) + 100 * abs(cos(t))
        XCTAssertEqual(p.start.x, 50 - CGFloat(sin(t) * length / 2), accuracy: 0.001)
        XCTAssertEqual(p.start.y, 50 + CGFloat(cos(t) * length / 2), accuracy: 0.001)
        XCTAssertEqual(p.end.x, 50 + CGFloat(sin(t) * length / 2), accuracy: 0.001)
        // Градиент идёт сверху вниз и немного вправо.
        XCTAssertLessThan(p.start.y, p.end.y)
        XCTAssertLessThan(p.start.x, p.end.x)
        // 180° — строго вертикаль через центр.
        let v = AmberStripe.gradientPoints(angle: 180, size: CGSize(width: 40, height: 80))
        XCTAssertEqual(v.start.x, 20, accuracy: 0.001)
        XCTAssertEqual(v.start.y, 0, accuracy: 0.001)
        XCTAssertEqual(v.end.y, 80, accuracy: 0.001)
    }

    func testBrandTokens() {
        // Опасный красный — #EF4444, а не `error` #F87171 (SPEC §3.1).
        XCTAssertNotEqual(Eb.danger, Eb.error)
    }
}

// MARK: - Вью-модель

/// Подмена сети: ответы настраиваются, вызовы записываются.
private final class FakeSettingsAPI: SettingsProfileAPI {
    var profile = UserProfile(id: "me", username: "roman", eblid: "2498", displayName: "Роман", bio: "Привет", avatarUrl: nil, status: "ONLINE")
    var sessions: [DeviceSession] = []
    var failProfile = false
    var failSessions = false
    var failUpdate = false
    var failStatus = false
    var failRevoke = false
    var failRevokeOthers = false
    var failPairing = false

    private(set) var updates: [(name: String?, bio: String?, avatar: String?)] = []
    private(set) var revoked: [String] = []
    private(set) var revokeOthersCalls = 0
    private(set) var statusCalls: [String] = []

    func me() async -> ApiResult<UserProfile> {
        failProfile ? .failure(message: "сеть") : .success(profile)
    }

    func updateProfile(displayName: String?, bio: String?, avatarUrl: String?) async -> ApiResult<UserProfile> {
        updates.append((displayName, bio, avatarUrl))
        if failUpdate { return .failure(message: "сеть") }
        profile = UserProfile(
            id: profile.id, username: profile.username, eblid: profile.eblid,
            displayName: displayName ?? profile.displayName, bio: bio ?? profile.bio,
            avatarUrl: avatarUrl ?? profile.avatarUrl, status: profile.status
        )
        return .success(profile)
    }

    func updateStatus(_ status: String) async -> ApiResult<UserProfile> {
        statusCalls.append(status)
        if failStatus { return .failure(message: "сеть") }
        profile = UserProfile(
            id: profile.id, username: profile.username, eblid: profile.eblid, displayName: profile.displayName,
            bio: profile.bio, avatarUrl: profile.avatarUrl, status: status
        )
        return .success(profile)
    }

    func uploadAvatar(bytes: Data, mime: String) async -> ApiResult<String> { .success("/media/new.jpg") }

    func startDevicePairing() async -> ApiResult<DevicePairing> {
        failPairing ? .failure(message: "сеть") : .success(DevicePairing(token: "t", code: "C", expiresAt: nil))
    }

    func listSessions() async -> ApiResult<[DeviceSession]> {
        failSessions ? .failure(message: "сеть") : .success(sessions)
    }

    func revokeSession(deviceId: String) async -> ApiResult<Void> {
        revoked.append(deviceId)
        if failRevoke { return .failure(message: "сеть") }
        sessions.removeAll { $0.id == deviceId }
        return .success(())
    }

    func revokeOtherSessions() async -> ApiResult<Void> {
        revokeOthersCalls += 1
        if failRevokeOthers { return .failure(message: "сеть") }
        sessions.removeAll { !$0.isCurrent }
        return .success(())
    }
}

@MainActor
final class SettingsViewModelTests: XCTestCase {

    private func device(_ id: String, name: String = "Устройство", current: Bool = false) -> DeviceSession {
        DeviceSession(id: id, name: name, platform: "ios", location: nil, ip: nil, lastSeenMs: 1, keysReady: true, isCurrent: current)
    }

    /// Все `Task` вью-модели отвечают мгновенно (подменный API): достаточно дать им отработать.
    private func settle() async {
        try? await Task.sleep(nanoseconds: 120_000_000)
    }

    private func makeLoaded(_ api: FakeSettingsAPI = FakeSettingsAPI()) async -> (SettingsViewModel, FakeSettingsAPI) {
        let vm = SettingsViewModel(api: api)
        vm.refresh()
        await settle()
        return (vm, api)
    }

    // Профиль и панель сохранения

    func testLoadFillsFields() async {
        let (vm, _) = await makeLoaded()
        XCTAssertEqual(vm.ui.profile?.name, "Роман")
        XCTAssertEqual(vm.ui.displayName, "Роман")
        XCTAssertEqual(vm.ui.bio, "Привет")
        XCTAssertFalse(vm.isDirty)
        XCTAssertEqual(vm.saveBarState, .hidden)
    }

    func testEditingShowsDirtyBarWithDetail() async {
        let (vm, _) = await makeLoaded()
        vm.onDisplayNameChange("Роман К.")
        XCTAssertEqual(vm.saveBarState, .dirty(detail: "Новое имя уйдёт одним запросом."))
        vm.onBioChange("Другое")
        XCTAssertEqual(vm.saveBarState, .dirty(detail: "Новые имя и «О себе» уйдут одним запросом."))
        // Возврат к прежнему — несохранённого нет (пробелы по краям не считаются).
        vm.onDisplayNameChange(" Роман ")
        vm.onBioChange("Привет")
        XCTAssertFalse(vm.isDirty)
        XCTAssertEqual(vm.saveBarState, .hidden)
    }

    func testSaveSendsNameAndBioInOneRequestThenShowsSaved() async {
        let (vm, api) = await makeLoaded()
        vm.onDisplayNameChange("Роман К.")
        vm.onBioChange("Новое о себе")
        var result: Bool?
        vm.save { result = $0 }
        XCTAssertEqual(vm.saveBarState, .saving)
        await settle()
        XCTAssertEqual(result, true)
        XCTAssertEqual(api.updates.count, 1)
        XCTAssertEqual(api.updates.first?.name, "Роман К.")
        XCTAssertEqual(api.updates.first?.bio, "Новое о себе")
        XCTAssertEqual(vm.saveBarState, .saved)
        XCTAssertFalse(vm.isDirty)
        // «Изменения сохранены.» уходит сама через 2,8 с — проверяем только что состояние верное.
    }

    func testSaveFailureKeepsDraftAndOffersRetry() async {
        let api = FakeSettingsAPI()
        api.failUpdate = true
        let (vm, _) = await makeLoaded(api)
        vm.onDisplayNameChange("Роман К.")
        var result: Bool?
        vm.save { result = $0 }
        await settle()
        XCTAssertEqual(result, false)
        XCTAssertEqual(vm.saveBarState, .failed)
        XCTAssertEqual(vm.ui.displayName, "Роман К.", "правка не потеряна")
        // Повтор после починки сети.
        api.failUpdate = false
        vm.save()
        await settle()
        XCTAssertEqual(vm.saveBarState, .saved)
    }

    func testEmptyNameIsNotSentAndShowsRowError() async {
        let (vm, api) = await makeLoaded()
        vm.onDisplayNameChange("   ")
        var result: Bool?
        vm.save { result = $0 }
        await settle()
        XCTAssertEqual(result, false)
        XCTAssertTrue(api.updates.isEmpty, "пустое имя сервер не принимает — запрос не уходит")
        XCTAssertEqual(vm.msgs["p-name"], .err("Введите отображаемое имя."))
        // Правка имени снимает ошибку.
        vm.onDisplayNameChange("Р")
        XCTAssertNil(vm.msgs["p-name"])
    }

    func testClearingBioSendsEmptyString() async {
        let (vm, api) = await makeLoaded()
        vm.onBioChange("")
        vm.save()
        await settle()
        XCTAssertEqual(api.updates.first?.bio, "", "стёртое «О себе» уходит пустой строкой — иначе его не стереть")
        XCTAssertEqual(vm.ui.bio, "")
    }

    func testDiscardRestoresServerValues() async {
        let (vm, api) = await makeLoaded()
        vm.onDisplayNameChange("Другое")
        vm.onBioChange("Иное")
        vm.discardDraft()
        XCTAssertEqual(vm.ui.displayName, "Роман")
        XCTAssertEqual(vm.ui.bio, "Привет")
        XCTAssertFalse(vm.isDirty)
        XCTAssertTrue(api.updates.isEmpty)
    }

    func testRefreshDoesNotOverwriteDraft() async {
        let (vm, _) = await makeLoaded()
        vm.onDisplayNameChange("Правлю")
        vm.loadProfile()
        await settle()
        XCTAssertEqual(vm.ui.displayName, "Правлю")
    }

    func testDraftTypedBeforeProfileArrivesSurvivesLoad() async {
        let vm = SettingsViewModel(api: FakeSettingsAPI())
        vm.onDisplayNameChange("Раньше загрузки")
        vm.loadProfile()
        await settle()
        XCTAssertEqual(vm.ui.displayName, "Раньше загрузки")
        XCTAssertTrue(vm.isDirty)
    }

    func testProfileLoadFailureIsReported() async {
        let api = FakeSettingsAPI()
        api.failProfile = true
        let (vm, _) = await makeLoaded(api)
        XCTAssertNil(vm.ui.profile)
        XCTAssertTrue(vm.ui.profileFailed)
        XCTAssertEqual(vm.saveBarState, .hidden)
    }

    // Статус

    func testStatusIsOptimisticAndRollsBackWithRowMessage() async {
        let api = FakeSettingsAPI()
        api.failStatus = true
        let (vm, _) = await makeLoaded(api)
        vm.setStatus("DND")
        XCTAssertEqual(vm.ui.profile?.status, "DND", "оптимистично")
        await settle()
        XCTAssertEqual(vm.ui.profile?.status, "ONLINE", "сбой — вернулся прежний")
        XCTAssertEqual(vm.msgs["p-status"], .err("Не удалось сохранить настройку. Попробуйте ещё раз."))
        api.failStatus = false
        vm.setStatus("AWAY")
        await settle()
        XCTAssertEqual(vm.ui.profile?.status, "AWAY")
        XCTAssertNil(vm.msgs["p-status"])
        XCTAssertEqual(api.statusCalls, ["DND", "AWAY"])
    }

    func testStatusSameValueDoesNothing() async {
        let (vm, api) = await makeLoaded()
        vm.setStatus("ONLINE")
        await settle()
        XCTAssertTrue(api.statusCalls.isEmpty)
    }

    func testStatusDoesNotTouchDraft() async {
        let (vm, _) = await makeLoaded()
        vm.onDisplayNameChange("Правка")
        vm.setStatus("AWAY")
        await settle()
        XCTAssertEqual(vm.ui.displayName, "Правка")
        XCTAssertTrue(vm.isDirty)
    }

    // Сеансы

    func testSessionsLoadFailureShowsEboxState() async {
        let api = FakeSettingsAPI()
        api.failSessions = true
        let (vm, _) = await makeLoaded(api)
        XCTAssertTrue(vm.ui.sessionsFailed)
        XCTAssertFalse(vm.ui.sessionsLoaded)
        // «Повторить» после починки сети.
        api.failSessions = false
        api.sessions = [device("me", current: true)]
        vm.loadSessions()
        await settle()
        XCTAssertFalse(vm.ui.sessionsFailed)
        XCTAssertTrue(vm.ui.sessionsLoaded)
        XCTAssertEqual(vm.ui.sessions.count, 1)
    }

    func testRevokeAsksInPlaceThenRevokes() async {
        let api = FakeSettingsAPI()
        api.sessions = [device("me", current: true), device("x", name: "Pixel")]
        let (vm, _) = await makeLoaded(api)
        let other = vm.ui.sessions.first { !$0.isCurrent }!
        vm.askRevoke(other)
        XCTAssertEqual(vm.ui.askRevokeID, "x")
        XCTAssertTrue(api.revoked.isEmpty, "без подтверждения ничего не уходит")
        vm.cancelAsk()
        XCTAssertNil(vm.ui.askRevokeID)
        vm.askRevoke(other)
        vm.confirmRevoke()
        await settle()
        XCTAssertEqual(api.revoked, ["x"])
        XCTAssertEqual(vm.msgs["s-sess"], .ok("Устройство отключено"))
        XCTAssertEqual(vm.ui.sessions.map(\.id), ["me"])
    }

    func testCannotAskToRevokeOwnDevice() async {
        let api = FakeSettingsAPI()
        api.sessions = [device("me", current: true), device("x")]
        let (vm, _) = await makeLoaded(api)
        vm.askRevoke(vm.ui.sessions.first { $0.isCurrent }!)
        XCTAssertNil(vm.ui.askRevokeID)
    }

    func testRevokeFailureShowsRowError() async {
        let api = FakeSettingsAPI()
        api.failRevoke = true
        api.sessions = [device("me", current: true), device("x")]
        let (vm, _) = await makeLoaded(api)
        vm.askRevoke(vm.ui.sessions.first { !$0.isCurrent }!)
        vm.confirmRevoke()
        await settle()
        XCTAssertEqual(vm.msgs["s-sess"], .err("Не удалось отключить устройство"))
        XCTAssertEqual(vm.ui.sessions.count, 2)
    }

    func testRevokeOthersAsksThenRevokesOnlyWithOwnDeviceInList() async {
        let api = FakeSettingsAPI()
        api.sessions = [device("me", current: true), device("a"), device("b")]
        let (vm, _) = await makeLoaded(api)
        XCTAssertTrue(vm.canRevokeOthers)
        vm.askRevokeAll()
        XCTAssertTrue(vm.ui.askRevokeOthers)
        XCTAssertEqual(api.revokeOthersCalls, 0)
        vm.confirmRevokeAll()
        await settle()
        XCTAssertEqual(api.revokeOthersCalls, 1)
        XCTAssertEqual(vm.msgs["s-sess"], .ok("Другие устройства отключены"))
        XCTAssertEqual(vm.ui.sessions.map(\.id), ["me"])
    }

    /// Главная защита: без своего устройства в списке `revoke-others` отозвал бы ВСЕ устройства,
    /// включая сам телефон. Вопрос даже не открывается, а запрос не уходит.
    func testRevokeOthersBlockedWithoutOwnDevice() async {
        let api = FakeSettingsAPI()
        api.sessions = [device("a"), device("b")]
        let (vm, _) = await makeLoaded(api)
        XCTAssertFalse(vm.canRevokeOthers)
        vm.askRevokeAll()
        XCTAssertFalse(vm.ui.askRevokeOthers)
        vm.confirmRevokeAll()
        await settle()
        XCTAssertEqual(api.revokeOthersCalls, 0)
    }

    /// Состояние изменилось, пока вопрос висел (список обновился без своего устройства).
    func testConfirmRevokeAllRechecksGuard() async {
        let api = FakeSettingsAPI()
        api.sessions = [device("me", current: true), device("a")]
        let (vm, _) = await makeLoaded(api)
        vm.askRevokeAll()
        api.sessions = [device("a")]
        vm.loadSessions()
        await settle()
        vm.confirmRevokeAll()
        await settle()
        XCTAssertEqual(api.revokeOthersCalls, 0)
        XCTAssertFalse(vm.ui.askRevokeOthers)
    }

    func testRevokeOthersFailureKeepsList() async {
        let api = FakeSettingsAPI()
        api.failRevokeOthers = true
        api.sessions = [device("me", current: true), device("a")]
        let (vm, _) = await makeLoaded(api)
        vm.askRevokeAll()
        vm.confirmRevokeAll()
        await settle()
        XCTAssertEqual(vm.msgs["s-sess"]?.kind, .err)
        XCTAssertEqual(vm.ui.sessions.count, 2)
    }

    // Привязка

    func testPairingStartsAndFailureShowsRowError() async {
        let api = FakeSettingsAPI()
        let (vm, _) = await makeLoaded(api)
        vm.startPairing()
        await settle()
        XCTAssertEqual(vm.ui.pairing?.code, "C")
        vm.dismissPairing()
        XCTAssertNil(vm.ui.pairing)
        api.failPairing = true
        vm.startPairing()
        await settle()
        XCTAssertNil(vm.ui.pairing)
        XCTAssertEqual(vm.msgs["s-link"], .err("Не удалось создать код. Попробуйте ещё раз."))
    }

    // Фото

    func testAvatarUploadSavesImmediatelyWithCurrentFields() async {
        let (vm, api) = await makeLoaded()
        vm.uploadAvatar(bytes: Data([1, 2, 3]), mime: "image/jpeg")
        await settle()
        XCTAssertEqual(api.updates.count, 1)
        XCTAssertEqual(api.updates.first?.avatar, "/media/new.jpg")
        XCTAssertEqual(vm.ui.profile?.avatarUrl, "/media/new.jpg")
        XCTAssertEqual(vm.msgs["p-photo"], .ok("Фото сохранено."))
    }
}
