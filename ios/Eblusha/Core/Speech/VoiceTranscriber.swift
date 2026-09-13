import AVFoundation
import Foundation
import Speech

/// Распознавание голосовых — СТРОГО на устройстве.
///
/// Whisper на сервере мы сознательно не ставим: бокс делит четыре ядра со звонками
/// (LiveKit живёт там же), и 30-секундное голосовое отнимало бы у них десятки секунд
/// процессора. Плюс главное: секретные чаты сервер расшифровать не может в принципе —
/// у него только шифртекст. Системный распознаватель решает обе беды сразу: работает
/// офлайн, мгновенно и одинаково для обычных и секретных бесед.
///
/// `requiresOnDeviceRecognition = true` — не украшение: без него Speech отправляет аудио
/// на серверы Apple. Для мессенджера с E2EE это неприемлемо, поэтому при отсутствии
/// офлайн-модели мы честно отказываемся, а не тихо уходим в облако.
enum VoiceTranscriptionError: LocalizedError {
    /// Человек отказал в доступе к распознаванию.
    case denied
    /// Офлайн-модель языка не загружена (диктовка выключена в системе).
    case unavailableOnDevice
    /// Распознавание не справилось (тишина, шум, битый файл).
    case failed

    var errorDescription: String? {
        switch self {
        case .denied:
            return "Распознавание запрещено в настройках"
        case .unavailableOnDevice:
            return "Офлайн-распознавание недоступно. Включите диктовку: Настройки → Основные → Клавиатура → Включить диктовку"
        case .failed:
            return "Не удалось разобрать речь"
        }
    }
}

enum VoiceTranscriber {

    /// Кого просим распознавать. Сначала язык системы (на нём и говорят чаще всего),
    /// потом русский как запасной — лишь бы модель была офлайн.
    private static func recognizer() -> SFSpeechRecognizer? {
        var locales: [Locale] = []
        if let preferred = Locale.preferredLanguages.first {
            locales.append(Locale(identifier: preferred))
        }
        locales.append(Locale(identifier: "ru_RU"))

        for locale in locales {
            guard let candidate = SFSpeechRecognizer(locale: locale) else { continue }
            // isAvailable — распознаватель вообще готов; supportsOnDeviceRecognition —
            // есть ли офлайн-модель. Нужны оба: без второго мы ушли бы в облако Apple.
            if candidate.isAvailable, candidate.supportsOnDeviceRecognition {
                return candidate
            }
        }
        return nil
    }

    /// Разрешение спрашиваем при первом запросе расшифровки, а не на старте приложения:
    /// системный диалог посреди чата понятен, на первом экране — нет.
    static func authorize() async -> SFSpeechRecognizerAuthorizationStatus {
        let current = SFSpeechRecognizer.authorizationStatus()
        guard current == .notDetermined else { return current }
        return await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { status in
                continuation.resume(returning: status)
            }
        }
    }

    /// Расшифровка локального файла. Возвращает готовый текст либо кидает понятную ошибку.
    static func transcribe(fileURL: URL) async throws -> String {
        guard await authorize() == .authorized else { throw VoiceTranscriptionError.denied }
        guard let recognizer = recognizer() else { throw VoiceTranscriptionError.unavailableOnDevice }

        let request = SFSpeechURLRecognitionRequest(url: fileURL)
        // Аудио не покидает телефон — ради этого всё и затевалось.
        request.requiresOnDeviceRecognition = true
        // Промежуточные результаты нам не нужны: показываем готовую фразу целиком.
        request.shouldReportPartialResults = false
        // Голосовое — это надиктованная речь, а не команда ассистенту.
        request.taskHint = .dictation
        // Точки и запятые: без них длинная расшифровка читается сплошным потоком.
        request.addsPunctuation = true

        return try await withCheckedThrowingContinuation { continuation in
            // Speech может дёрнуть обработчик и с результатом, и с ошибкой — продолжение
            // же допускает ровно одно возобновление, иначе падение процесса.
            let once = ResumeOnce()
            recognizer.recognitionTask(with: request) { result, error in
                if let result, result.isFinal {
                    let text = result.bestTranscription.formattedString
                        .trimmingCharacters(in: .whitespacesAndNewlines)
                    once.run {
                        if text.isEmpty {
                            continuation.resume(throwing: VoiceTranscriptionError.failed)
                        } else {
                            continuation.resume(returning: text)
                        }
                    }
                    return
                }
                if error != nil {
                    once.run { continuation.resume(throwing: VoiceTranscriptionError.failed) }
                }
            }
        }
    }
}

/// Однократное возобновление продолжения: обработчик Speech вызывается не один раз.
private final class ResumeOnce: @unchecked Sendable {
    private let lock = NSLock()
    private var done = false

    func run(_ body: () -> Void) {
        lock.lock()
        let first = !done
        done = true
        lock.unlock()
        if first { body() }
    }
}
