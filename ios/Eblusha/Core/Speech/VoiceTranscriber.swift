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
    /// Ошибка самого движка: несём её текст наружу, иначе диагностировать нечем —
    /// на устройстве логи недоступны, и «не удалось разобрать речь» не говорит ничего.
    case engine(String)

    var errorDescription: String? {
        switch self {
        case .denied:
            return "Распознавание запрещено в настройках"
        case .unavailableOnDevice:
            return "Офлайн-распознавание недоступно. Включите диктовку: Настройки → Основные → Клавиатура → Включить диктовку"
        case .failed:
            return "Не удалось разобрать речь"
        case .engine(let detail):
            return detail
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

        // Две попытки: с автопунктуацией и без неё. Пунктуация офлайн поддержана не для
        // каждого языка, и отказ движка из-за неё терял бы весь текст целиком.
        do {
            return try await recognize(fileURL: fileURL, recognizer: recognizer, punctuation: true)
        } catch VoiceTranscriptionError.engine(let detail) {
            do {
                return try await recognize(fileURL: fileURL, recognizer: recognizer, punctuation: false)
            } catch {
                // Наружу отдаём ПЕРВУЮ ошибку: она про настоящую причину, а повтор —
                // лишь проверка догадки про пунктуацию.
                throw VoiceTranscriptionError.engine(detail)
            }
        }
    }

    private static func recognize(
        fileURL: URL,
        recognizer: SFSpeechRecognizer,
        punctuation: Bool
    ) async throws -> String {
        let request = SFSpeechURLRecognitionRequest(url: fileURL)
        // Аудио не покидает телефон — ради этого всё и затевалось.
        request.requiresOnDeviceRecognition = true
        // Промежуточные результаты нам не нужны: показываем готовую фразу целиком.
        request.shouldReportPartialResults = false
        // Голосовое — это надиктованная речь, а не команда ассистенту.
        request.taskHint = .dictation
        // Точки и запятые: без них длинная расшифровка читается сплошным потоком.
        request.addsPunctuation = punctuation

        // ССЫЛКИ ДЕРЖИМ САМИ. recognitionTask возвращает задачу, и если её не удержать,
        // ARC освобождает задачу вместе с распознавателем прямо посреди работы: приходит
        // отмена, которая снаружи выглядит как «не удалось разобрать речь». Ровно на этом
        // функция и не работала.
        let session = RecognitionSession(recognizer: recognizer)
        return try await withCheckedThrowingContinuation { continuation in
            session.start(request: request) { outcome in
                switch outcome {
                case .text(let text):
                    continuation.resume(returning: text)
                case .failure(let error):
                    continuation.resume(throwing: error)
                }
            }
        }
    }
}

/// Держатель одного распознавания: хранит распознаватель и задачу живыми до конца и
/// возобновляет продолжение ровно один раз (обработчик Speech зовут многократно).
private final class RecognitionSession: @unchecked Sendable {
    enum Outcome {
        case text(String)
        case failure(VoiceTranscriptionError)
    }

    private let lock = NSLock()
    private var finished = false
    private let recognizer: SFSpeechRecognizer
    private var task: SFSpeechRecognitionTask?
    private var completion: ((Outcome) -> Void)?

    init(recognizer: SFSpeechRecognizer) {
        self.recognizer = recognizer
    }

    func start(request: SFSpeechRecognitionRequest, completion: @escaping (Outcome) -> Void) {
        self.completion = completion
        // self в замыкании — СИЛЬНО: задача должна пережить выход из scope. Цикл
        // task → замыкание → self → task рвётся в finish(), где мы обнуляем обе ссылки.
        task = recognizer.recognitionTask(with: request) { result, error in
            if let error {
                let ns = error as NSError
                // kAFAssistantErrorDomain 1110 — «речь не распознана»: тишина или шум,
                // это не поломка, а честный результат.
                if ns.code == 1110 {
                    self.finish(.failure(.failed))
                } else {
                    self.finish(.failure(.engine(
                        "Распознавание не запустилось: \(ns.localizedDescription) [\(ns.domain) \(ns.code)]"
                    )))
                }
                return
            }
            guard let result, result.isFinal else { return }
            let text = result.bestTranscription.formattedString
                .trimmingCharacters(in: .whitespacesAndNewlines)
            self.finish(text.isEmpty ? .failure(.failed) : .text(text))
        }
    }

    private func finish(_ outcome: Outcome) {
        lock.lock()
        let first = !finished
        finished = true
        let handler = completion
        lock.unlock()
        guard first else { return }
        handler?(outcome)
        // Рвём цикл и отпускаем движок.
        completion = nil
        task = nil
    }
}
