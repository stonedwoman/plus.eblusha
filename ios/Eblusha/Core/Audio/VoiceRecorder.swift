import AVFoundation
import Combine
import Foundation

// Порт `core/audio/VoiceRecorder.kt`.

enum VoiceRecorderError: Error {
    /// Микрофон не открылся / AVAudioRecorder не стартовал (аналог `start() == false` в Kotlin).
    case cannotStart
}

/// Пишет голосовое сообщение в MPEG-4/AAC `.m4a` (mime `audio/mp4` — играется веб-элементом
/// `<audio>`, Android и iOS). В Kotlin UI зовёт `poll()` каждые ~100 мс; здесь вместо этого
/// внутренний таймер ~50 мс читает метеринг averagePower, копит амплитуды для итоговой волны
/// и публикует живой хвост + таймер для композера. `stop()` ужимает накопленное в волну
/// фиксированного размера (значения 0..100).
final class VoiceRecorder: ObservableObject {
    /// Kotlin BARS: волна одного размера у всех клиентов — `metadata.waveform` совместим по проводу.
    static let bars = 48

    @Published private(set) var isRecording = false
    /// Живые амплитуды 0..1 для волны записи (хвост до 120 значений, как recordAmps в ChatScreen.kt).
    @Published private(set) var liveAmps: [Float] = []
    /// Прошедшее время записи (таймер в композере).
    @Published private(set) var elapsedMs: Int64 = 0

    private var recorder: AVAudioRecorder?
    private var fileURL: URL?
    private var startUptime: TimeInterval = 0
    private var amplitudes: [Float] = []
    private var meterTimer: Timer?

    /// Разрешение микрофона (iOS 17+ API; аналог Manifest.permission.RECORD_AUDIO).
    static func requestPermission() async -> Bool {
        await AVAudioApplication.requestRecordPermission()
    }

    /// Начинает запись во временный файл. Бросает, если аудиосессия/микрофон не открылись.
    func start() throws {
        stopInternal(deleteFile: true)
        // .playAndRecord, а не .record: плеер голосовых в ленте не должен глохнуть, пока
        // открыт композер; defaultToSpeaker — звук не уходит в тихий разговорный динамик.
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetooth])
        try session.setActive(true)
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("voice-\(Int64(Date().timeIntervalSince1970 * 1000)).m4a")
        // AAC в контейнере MPEG-4, как у Android-клиента. 48 кГц — нативная частота
        // аудиотракта iPhone (без ресемплинга), 64 кбпс моно голосу достаточно.
        let settings: [String: Any] = [
            AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
            AVSampleRateKey: 48_000,
            AVNumberOfChannelsKey: 1,
            AVEncoderBitRateKey: 64_000,
        ]
        let rec: AVAudioRecorder
        do {
            rec = try AVAudioRecorder(url: url, settings: settings)
        } catch {
            try? FileManager.default.removeItem(at: url)
            deactivateSession()
            throw error
        }
        rec.isMeteringEnabled = true
        guard rec.record() else {
            try? FileManager.default.removeItem(at: url)
            deactivateSession()
            throw VoiceRecorderError.cannotStart
        }
        recorder = rec
        fileURL = url
        amplitudes = []
        liveAmps = []
        elapsedMs = 0
        // systemUptime — монотонные часы (аналог SystemClock.elapsedRealtime): перевод
        // системного времени не ломает таймер и длительность.
        startUptime = ProcessInfo.processInfo.systemUptime
        isRecording = true
        meterTimer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [weak self] _ in
            self?.pollMeter()
        }
    }

    /// Аналог `poll()` из Kotlin: снимает текущий уровень и копит его для волны и живого UI.
    private func pollMeter() {
        guard let rec = recorder else { return }
        rec.updateMeters()
        // averagePower — дБ (−160..0) → линейная амплитуда 0..1 (роль maxAmplitude/32767).
        let linear = pow(10, rec.averagePower(forChannel: 0) / 20)
        amplitudes.append(linear)
        // Средний уровень тише пикового maxAmplitude из Android — подтягиваем живые бары
        // умеренным усилением, чтобы волна в композере выглядела как на Android. На итоговую
        // волну не влияет: buildWaveform() нормирует к собственному пику записи.
        liveAmps.append(min(linear * 4, 1))
        if liveAmps.count > 120 { liveAmps.removeFirst() }
        elapsedMs = Int64((ProcessInfo.processInfo.systemUptime - startUptime) * 1000)
    }

    /// Останавливает и возвращает запись; nil — ничего пригодного не записалось.
    func stop() -> (data: Data, durationSec: Int, waveform: [Int])? {
        guard let rec = recorder, let url = fileURL else { return nil }
        let elapsed = (ProcessInfo.processInfo.systemUptime - startUptime) * 1000
        meterTimer?.invalidate()
        meterTimer = nil
        rec.stop()
        recorder = nil
        fileURL = nil
        isRecording = false
        deactivateSession()
        // Файл нужен только чтобы забрать байты — подчищаем в любом исходе.
        defer { try? FileManager.default.removeItem(at: url) }
        guard let data = try? Data(contentsOf: url), !data.isEmpty else {
            amplitudes = []
            return nil
        }
        // Округление до целой секунды, минимум 1 (как `((elapsed + 500) / 1000)` в Kotlin).
        let durationSec = max(Int((elapsed + 500) / 1000), 1)
        let waveform = buildWaveform()
        amplitudes = []
        return (data, durationSec, waveform)
    }

    func cancel() {
        stopInternal(deleteFile: true)
    }

    private func stopInternal(deleteFile: Bool) {
        meterTimer?.invalidate()
        meterTimer = nil
        let wasRecording = recorder != nil
        recorder?.stop()
        recorder = nil
        if deleteFile, let url = fileURL { try? FileManager.default.removeItem(at: url) }
        fileURL = nil
        amplitudes = []
        if isRecording { isRecording = false }
        if wasRecording { deactivateSession() }
    }

    /// Возвращаем аудиосессию другим приложениям (их музыка возобновляется после нашей записи).
    private func deactivateSession() {
        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
    }

    /// Ужимает накопленные амплитуды в [bars] значений, нормированных 0..100 к пику записи.
    private func buildWaveform() -> [Int] {
        if amplitudes.isEmpty { return Array(repeating: 8, count: Self.bars) }
        // Пику не даём уйти в ноль (в Kotlin — coerceAtLeast(1) на шкале 0..32767).
        let peak = max(amplitudes.max() ?? 0, 0.000_01)
        let chunk = max(Float(amplitudes.count) / Float(Self.bars), 1)
        return (0..<Self.bars).map { i in
            let from = Int(Float(i) * chunk)
            let to = min(Int(Float(i + 1) * chunk), amplitudes.count)
            guard to > from else { return 8 }
            let avg = amplitudes[from..<to].reduce(0, +) / Float(to - from)
            return min(max(Int(avg / peak * 100), 8), 100)
        }
    }

    deinit {
        meterTimer?.invalidate()
        recorder?.stop()
        if let url = fileURL { try? FileManager.default.removeItem(at: url) }
    }
}
