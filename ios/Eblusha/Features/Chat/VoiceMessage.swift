import AVFoundation
import Combine
import SwiftUI

// Порт голосовых сообщений из `ui/chat/ChatScreen.kt`: кнопка микрофона и строка записи
// для композера (LiveWaveform + formatRecordTime) и waveform-плеер AUDIO-вложений
// (VoiceMessagePlayer + WaveformBars + pseudoWaveform).

/// Порт `formatRecordTime` из ChatScreen.kt: «М:СС».
func formatRecordTime(_ ms: Int64) -> String {
    let totalSec = Int(ms / 1000)
    return String(format: "%d:%02d", totalSec / 60, totalSec % 60)
}

// MARK: - Запись

/// Кнопка микрофона в композере (Android/веб: рядом с отправкой; на iOS показывается
/// при пустом драфте — её место занимает кнопка отправки текста).
struct VoiceRecordButton: View {
    @ObservedObject var recorder: VoiceRecorder
    var sending = false

    var body: some View {
        Button {
            Task {
                // Порт onStartRecord: сначала разрешение, затем старт; отказ/сбой старта —
                // тихий no-op (в Kotlin start() возвращает false и ничего не происходит).
                guard await VoiceRecorder.requestPermission() else { return }
                try? recorder.start()
            }
        } label: {
            Image(systemName: "mic.fill")
                .font(.system(size: 17))
                .foregroundStyle(Eb.brand)
                .frame(width: 38, height: 38)
        }
        .disabled(sending || recorder.isRecording)
    }
}

/// Строка записи, заменяющая ряд ввода композера (порт recording-ветки EblushaComposer):
/// отмена — [красная точка + таймер + живая волна] — отправить.
struct VoiceRecordBar: View {
    @ObservedObject var recorder: VoiceRecorder
    var sending = false
    /// (байты .m4a, длительность в сек, волна 0..100) — наверх, в ChatViewModel.sendVoice.
    let onSend: (Data, Int, [Int]) -> Void

    var body: some View {
        HStack(spacing: 8) {
            Button {
                recorder.cancel()
            } label: {
                Image(systemName: "trash")
                    .font(.system(size: 17))
                    .foregroundStyle(Eb.error)
                    .frame(width: 38, height: 38)
            }

            HStack(spacing: 0) {
                // Красная точка «идёт запись» (Kotlin: Color(0xFFE5484D)).
                Circle().fill(Color(hex: 0xE5484D)).frame(width: 10, height: 10)
                Spacer().frame(width: 10)
                Text(formatRecordTime(recorder.elapsedMs))
                    .font(.footnote.weight(.medium))
                    .monospacedDigit()
                    .foregroundStyle(Eb.textPrimary)
                Spacer().frame(width: 12)
                LiveWaveform(amps: recorder.liveAmps)
                    .frame(height: 24)
                    .frame(maxWidth: .infinity)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(Eb.surface300, in: RoundedRectangle(cornerRadius: 24))

            Button {
                // Порт onSendRecord: nil (ничего пригодного не записалось) — просто выходим.
                if let result = recorder.stop() {
                    onSend(result.data, result.durationSec, result.waveform)
                }
            } label: {
                Image(systemName: "arrow.up")
                    .font(.system(size: 17, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 38, height: 38)
                    .background(Eb.brand, in: Circle())
            }
            .disabled(sending)
        }
    }
}

/// Живые бары записи: свежая амплитуда прижата к ПРАВОМУ краю, старые уходят влево
/// (фиксированная ширина слота — порт LiveWaveform).
private struct LiveWaveform: View {
    let amps: [Float]

    var body: some View {
        Canvas { context, size in
            guard !amps.isEmpty else { return }
            let slot: CGFloat = 4
            let barW: CGFloat = 2
            let maxBars = max(Int(size.width / slot), 1)
            let visible = amps.count > maxBars ? Array(amps.suffix(maxBars)) : amps
            let midY = size.height / 2
            for (i, a) in visible.enumerated() {
                // Свежий (последний) бар у правого края; каждый старее — на слот левее.
                let x = size.width - (CGFloat(visible.count - i) - 0.5) * slot
                let h = CGFloat(min(max(a, 0.06), 1)) * size.height
                var path = Path()
                path.move(to: CGPoint(x: x, y: midY - h / 2))
                path.addLine(to: CGPoint(x: x, y: midY + h / 2))
                context.stroke(
                    path,
                    with: .color(Eb.brand),
                    style: StrokeStyle(lineWidth: barW, lineCap: .round)
                )
            }
        }
    }
}

// MARK: - Плеер AUDIO-вложений

/// Порт VoiceMessagePlayer из ChatScreen.kt: play/pause, волна, чьи бары закрашиваются
/// прогрессом воспроизведения, и метка «текущее / всего». Стримит `resolveMediaUrl(url)`
/// через AVPlayer; использует сохранённую [waveform], а без неё — детерминированную
/// псевдоволну из URL.
struct VoiceMessagePlayer: View {
    let url: String
    let durationSec: Int?
    let waveform: [Int]?
    var onSurface: Color = Eb.textPrimary

    @StateObject private var playback = VoicePlayback()

    var body: some View {
        let bars = (waveform?.isEmpty == false)
            ? waveform!
            : pseudoWaveform(seed: url, bars: VoiceRecorder.bars)
        let totalMs = playback.totalMs > 0 ? playback.totalMs : Int64(durationSec ?? 0) * 1000
        let progress = totalMs > 0 ? Double(playback.positionMs) / Double(totalMs) : 0

        HStack(spacing: 10) {
            Button {
                playback.toggle(urlString: resolveMediaUrl(url) ?? url)
            } label: {
                Group {
                    if playback.preparing {
                        ProgressView()
                            .tint(.white)
                            .scaleEffect(0.8)
                    } else {
                        Image(systemName: playback.playing ? "pause.fill" : "play.fill")
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundStyle(.white)
                    }
                }
                .frame(width: 40, height: 40)
                .background(Eb.brand, in: Circle())
            }
            .buttonStyle(.plain)

            VStack(alignment: .leading, spacing: 2) {
                WaveformBars(
                    bars: bars,
                    progress: progress,
                    played: Eb.brand,
                    idle: onSurface.opacity(0.3)
                )
                .frame(height: 26)
                .frame(maxWidth: .infinity)
                Text("\(formatRecordTime(playback.positionMs)) / \(formatRecordTime(totalMs))")
                    .font(.caption2)
                    .monospacedDigit()
                    .foregroundStyle(onSurface.opacity(0.7))
            }
        }
        .frame(minWidth: 200, maxWidth: 280)
        .padding(.vertical, 2)
    }
}

/// Обёртка AVPlayer со стейтом для SwiftUI — роль колбэков MediaPlayer из Kotlin
/// (onPrepared/onCompletion/onError + цикл positionMs).
private final class VoicePlayback: ObservableObject {
    @Published var playing = false
    @Published var preparing = false
    @Published var positionMs: Int64 = 0
    @Published var totalMs: Int64 = 0

    private var player: AVPlayer?
    private var timeObserver: Any?
    private var cancellables: Set<AnyCancellable> = []

    /// Порт toggle: пауза ↔ продолжить; первый тап лениво готовит плеер и стартует сам.
    func toggle(urlString: String) {
        if playing {
            player?.pause()
            playing = false
        } else if let player {
            activatePlaybackSession()
            player.play()
            playing = true
        } else if !preparing {
            guard let url = URL(string: urlString) else { return }
            preparing = true
            activatePlaybackSession()
            let item = AVPlayerItem(url: url)
            let p = AVPlayer(playerItem: item)
            player = p

            // Готовность (аналог onPrepared): узнаём настоящую длительность и играем.
            item.publisher(for: \.status)
                .receive(on: DispatchQueue.main)
                .sink { [weak self] status in
                    guard let self else { return }
                    switch status {
                    case .readyToPlay:
                        self.preparing = false
                        let duration = item.duration
                        if duration.isNumeric, duration.seconds > 0 {
                            self.totalMs = Int64(duration.seconds * 1000)
                        }
                        self.playing = true
                    case .failed:
                        // Аналог onErrorListener: тихо гасим оба флага.
                        self.preparing = false
                        self.playing = false
                    default:
                        break
                    }
                }
                .store(in: &cancellables)

            // Конец трека (аналог onCompletionListener): стоп и перемотка в начало.
            NotificationCenter.default.publisher(for: .AVPlayerItemDidPlayToEndTime, object: item)
                .receive(on: DispatchQueue.main)
                .sink { [weak self] _ in
                    self?.playing = false
                    self?.positionMs = 0
                    self?.player?.seek(to: .zero)
                }
                .store(in: &cancellables)

            // Позиция каждые ~60 мс (как цикл positionMs при delay(60) в Kotlin).
            timeObserver = p.addPeriodicTimeObserver(
                forInterval: CMTime(seconds: 0.06, preferredTimescale: 600),
                queue: .main
            ) { [weak self] time in
                guard let self, time.isNumeric else { return }
                self.positionMs = Int64(time.seconds * 1000)
            }
            p.play()
        }
    }

    /// Категория .playback: голосовые слышны и с выключенным переключателем звонка —
    /// как на Android/вебе, где тумблер беззвучного не глушит воспроизведение медиа.
    private func activatePlaybackSession() {
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .default)
        try? AVAudioSession.sharedInstance().setActive(true)
    }

    deinit {
        if let timeObserver, let player { player.removeTimeObserver(timeObserver) }
        player?.pause()
    }
}

/// Статичная волна: бары 0..100, закрашенные [played] до [progress] (0..1), остальное [idle]
/// (порт WaveformBars).
private struct WaveformBars: View {
    let bars: [Int]
    let progress: Double
    let played: Color
    let idle: Color

    var body: some View {
        Canvas { context, size in
            guard !bars.isEmpty else { return }
            let slot = size.width / CGFloat(bars.count)
            let barW = max(slot * 0.5, 1.5)
            let midY = size.height / 2
            let activeIdx = Int(progress * Double(bars.count))
            for (i, v) in bars.enumerated() {
                let h = min(max(CGFloat(v) / 100, 0.08), 1) * size.height
                let x = CGFloat(i) * slot + slot / 2
                var path = Path()
                path.move(to: CGPoint(x: x, y: midY - h / 2))
                path.addLine(to: CGPoint(x: x, y: midY + h / 2))
                context.stroke(
                    path,
                    with: .color(i <= activeIdx ? played : idle),
                    style: StrokeStyle(lineWidth: barW, lineCap: .round)
                )
            }
        }
    }
}

/// Детерминированные «случайные» бары (20..89) из строки-сида — когда настоящей волны нет
/// (порт pseudoWaveform).
private func pseudoWaveform(seed: String, bars: Int) -> [Int] {
    // hashCode Java-строки (UTF-16, переполнение Int32) — чтобы псевдоволна совпадала
    // с Android-клиентом у тех же URL.
    var h32: Int32 = 0
    for u in seed.utf16 { h32 = 31 &* h32 &+ Int32(u) }
    var h = Int64(h32)
    return (0..<bars).map { _ in
        h = h &* 1_103_515_245 &+ 12345
        return 20 + Int(abs(h % 70))
    }
}
