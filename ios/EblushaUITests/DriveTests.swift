import XCTest

/// «Пульт» симулятора. На маке нет ни idb, ни cliclick, а `simctl` не умеет ни тапать, ни
/// тянуть — без этого миниатюру звонка (перетаскивание, магниты, язычок) не проверить без
/// человека. Единственный тест читает сценарий из окружения `EB_DRIVE` (у xcodebuild —
/// `TEST_RUNNER_EB_DRIVE`) и выполняет шаги по порядку; разделитель — «;».
///
///   launch[:аргументы через пробел]   запустить приложение (перезапускает, если уже идёт)
///   activate                          вывести на экран, не перезапуская (запустит, если не идёт)
///   terminate                         закрыть
///   sleep:сек                         пауза
///   shot:имя                          PNG-скриншот в каталог EB_SHOTS (по умолчанию /tmp/ebshots)
///   dump:имя                          дерево доступности в EB_SHOTS/имя.txt — искать подписи
///   tap:x,y                           тап по точке (pt, от левого верхнего угла экрана)
///   tapText:подстрока                 тап по тексту (staticText)
///   tapButton:подстрока               тап по кнопке с такой подписью
///   tapAny:подстрока                  тап по любому элементу с такой подписью
///   tapField:N / tapSecure:N          тап по N-му текстовому / парольному полю
///   type:текст                        набрать в поле с фокусом
///   typeEnv:ПЕРЕМЕННАЯ                набрать значение переменной окружения (пароль сюда, а не в скрипт)
///   drag:x1,y1,x2,y2                  протяжка пальцем
///   dragHold:x1,y1,x2,y2,сек,имя      протяжка с выдержкой в конце и скриншотом посреди неё
///   wait:подстрока|сек                дождаться элемента с подписью
///
/// Отчёт о шагах — EB_SHOTS/drive.log. Секреты в сценарий не писать: только `typeEnv`.
final class DriveTests: XCTestCase {

    private var notes: [String] = []
    private var shotsDir = "/tmp/ebshots"

    override func setUpWithError() throws {
        continueAfterFailure = true
    }

    func testDrive() throws {
        let env = ProcessInfo.processInfo.environment
        shotsDir = env["EB_SHOTS"] ?? shotsDir
        try? FileManager.default.createDirectory(atPath: shotsDir, withIntermediateDirectories: true)
        defer { flushLog() }

        let script = env["EB_DRIVE"] ?? ""
        let app = XCUIApplication(bundleIdentifier: "org.eblusha.plus")

        for rawStep in script.split(separator: ";") {
            let step = rawStep.trimmingCharacters(in: .whitespacesAndNewlines)
            if step.isEmpty { continue }
            let command: String
            let argument: String
            if let colon = step.firstIndex(of: ":") {
                command = String(step[..<colon])
                argument = String(step[step.index(after: colon)...])
            } else {
                command = step
                argument = ""
            }
            note("> \(step)")

            switch command {
            case "launch":
                app.launchArguments = argument.split(separator: " ").map(String.init)
                app.launch()
            case "activate":
                app.activate()
            case "terminate":
                app.terminate()
            case "sleep":
                Thread.sleep(forTimeInterval: Double(argument) ?? 1)
            case "shot":
                shot(argument)
            case "dump":
                try? app.debugDescription.write(toFile: "\(shotsDir)/\(argument).txt", atomically: true, encoding: .utf8)
            case "tap":
                let p = numbers(argument)
                guard p.count >= 2 else { fail("tap: нужны x,y"); continue }
                coordinate(app, p[0], p[1]).tap()
            case "tapText":
                tap(app.staticTexts, argument)
            case "tapButton":
                tap(app.buttons, argument)
            case "tapAny":
                tap(app.descendants(matching: .any), argument)
            case "tapField":
                app.textFields.element(boundBy: Int(argument) ?? 0).tap()
            case "tapSecure":
                app.secureTextFields.element(boundBy: Int(argument) ?? 0).tap()
            case "type":
                app.typeText(argument)
            case "typeEnv":
                if let value = env[argument] {
                    app.typeText(value)
                } else {
                    fail("typeEnv: нет переменной \(argument)")
                }
            case "drag":
                let p = numbers(argument)
                guard p.count >= 4 else { fail("drag: нужны x1,y1,x2,y2"); continue }
                coordinate(app, p[0], p[1]).press(forDuration: 0.15, thenDragTo: coordinate(app, p[2], p[3]))
            case "dragHold":
                // x1,y1,x2,y2,сек,имя — довели палец и держим; на половине выдержки экран
                // снимается из фонового потока (жест держит главный) — так видно призрак магнита.
                let parts = argument.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
                guard parts.count >= 6,
                      let x1 = Double(parts[0]), let y1 = Double(parts[1]),
                      let x2 = Double(parts[2]), let y2 = Double(parts[3]),
                      let hold = Double(parts[4]) else { fail("dragHold: нужны x1,y1,x2,y2,сек,имя"); continue }
                let name = parts[5]
                let done = DispatchGroup()
                done.enter()
                DispatchQueue.global().asyncAfter(deadline: .now() + hold * 0.5) {
                    self.shot(name)
                    done.leave()
                }
                coordinate(app, CGFloat(x1), CGFloat(y1)).press(
                    forDuration: 0.15,
                    thenDragTo: coordinate(app, CGFloat(x2), CGFloat(y2)),
                    withVelocity: .default,
                    thenHoldForDuration: hold
                )
                done.wait()
            case "wait":
                let parts = argument.split(separator: "|", maxSplits: 1).map(String.init)
                let timeout = parts.count > 1 ? (Double(parts[1]) ?? 10) : 10
                let element = app.descendants(matching: .any)
                    .matching(NSPredicate(format: "label CONTAINS[c] %@", parts[0]))
                    .firstMatch
                if element.waitForExistence(timeout: timeout) {
                    note("дождались «\(parts[0])»")
                } else {
                    fail("не дождались «\(parts[0])» за \(timeout) с")
                }
            default:
                fail("неизвестный шаг «\(command)»")
            }
        }
    }

    // MARK: - Помощники

    private func coordinate(_ app: XCUIApplication, _ x: CGFloat, _ y: CGFloat) -> XCUICoordinate {
        app.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0)).withOffset(CGVector(dx: x, dy: y))
    }

    private func numbers(_ argument: String) -> [CGFloat] {
        argument.split(separator: ",").compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }.map { CGFloat($0) }
    }

    private func tap(_ query: XCUIElementQuery, _ text: String) {
        let element = query.matching(NSPredicate(format: "label CONTAINS[c] %@", text)).firstMatch
        if element.waitForExistence(timeout: 5) {
            element.tap()
            note("тап «\(text)»: ok")
        } else {
            fail("не найден «\(text)»")
        }
    }

    private func shot(_ name: String) {
        let png = XCUIScreen.main.screenshot().pngRepresentation
        let path = "\(shotsDir)/\(name).png"
        do {
            try png.write(to: URL(fileURLWithPath: path))
            note("скриншот \(path)")
        } catch {
            fail("скриншот не записался: \(error)")
        }
    }

    private let notesLock = NSLock()

    private func note(_ text: String) {
        notesLock.lock()
        notes.append(text)
        notesLock.unlock()
        NSLog("EBDRIVE %@", text)
    }

    private func fail(_ text: String) {
        note("ОШИБКА: \(text)")
        XCTFail(text)
    }

    private func flushLog() {
        try? notes.joined(separator: "\n").write(toFile: "\(shotsDir)/drive.log", atomically: true, encoding: .utf8)
    }
}
