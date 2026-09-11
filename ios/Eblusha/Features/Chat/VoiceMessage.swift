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

/// Голосовое секретного чата: по своему url вложение отдаёт ШИФРТЕКСТ, поэтому плеер
/// получает URL только после расшифровки ключом треда в локальный файл. Веб-паритет
/// (ChatMessageRow.tsx, ветка AUDIO): пока идёт расшифровка — спиннер «Расшифровка аудио…»,
/// при сбое — «Не удалось расшифровать аудио», и только потом обычный VoiceMessagePlayer.
struct SecretVoiceMessagePlayer: View {
    let att: MessageAttachment
    let durationSec: Int?
    let waveform: [Int]?
    /// Расшифровка в кэш-файл (ChatViewModel.decryptSecretAttachment).
    let decrypt: ((MessageAttachment) async -> URL?)?
    var onSurface: Color = Eb.textPrimary

    @State private var local: URL?
    @State private var failed = false
    /// url вложения, к которому относятся local/failed. Ячейка ленты переиспользуется под
    /// ДРУГОЕ сообщение на том же месте списка, а @State подмену переживает — без этой
    /// метки в пузыре остался бы (и играл) расшифрованный файл ПРЕДЫДУЩЕГО голосового.
    @State private var resolvedFor: String?

    var body: some View {
        // Годен только результат ЭТОГО вложения; чужой считаем отсутствующим — покажем спиннер.
        let ready = resolvedFor == att.url ? local : nil
        let broken = resolvedFor == att.url && failed
        Group {
            if let ready {
                VoiceMessagePlayer(
                    url: ready.absoluteString,
                    durationSec: durationSec,
                    waveform: waveform,
                    onSurface: onSurface
                )
            } else if broken {
                Text("Не удалось расшифровать аудио")
                    .font(.caption)
                    .foregroundStyle(Eb.error)
            } else {
                // Плашка со спиннером ровно как в вебе: та же поверхность, кант и подпись.
                HStack(spacing: 8) {
                    ProgressView()
                        .tint(Eb.brand)
                        .scaleEffect(0.7)
                        .frame(width: 16, height: 16)
                    Text("Расшифровка аудио…")
                        .font(.footnote)
                        .foregroundStyle(Eb.textMuted)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
                .background(Eb.surface100, in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(Eb.border, lineWidth: 1))
            }
        }
        // id по url: в переиспользованной ячейке ленты должна начаться расшифровка
        // вложения НОВОГО сообщения, а не остаться подвешенной на прежнем.
        .task(id: att.url) {
            // Одна попытка на вложение: и успех, и провал помечаются resolvedFor, поэтому
            // рекомпозиции не перезапускают расшифровку и ошибка не долбит в цикле.
            guard resolvedFor != att.url else { return }
            // Без замыкания расшифровки играть нечего — честная ошибка лучше вечного спиннера.
            guard let decrypt else {
                local = nil
                failed = true
                resolvedFor = att.url
                return
            }
            let file = await decrypt(att)
            // Пока качались/расшифровывались байты, ячейку могли отдать другому сообщению
            // (тогда .task отменён): чужой результат в свой @State не пишем.
            guard !Task.isCancelled else { return }
            local = file.map { playableAudioURL($0, mime: att.mime) }
            failed = (file == nil)
            resolvedFor = att.url
        }
    }
}

/// Расширение локального аудиофайла по mime. AVPlayer определяет контейнер локального
/// файла по расширению (для file:// нет Content-Type), а без него молча уходит в .failed.
private func audioFileExtension(for mime: String?) -> String {
    let m = (mime ?? "").lowercased()
    if m.contains("mpeg") || m.contains("mp3") { return "mp3" }
    if m.contains("wav") { return "wav" }
    if m.contains("aiff") { return "aiff" }
    if m.contains("caf") { return "caf" }
    // Диктофоны iOS и Android пишут m4a (AAC в mp4-контейнере) — это же дефолт и для
    // неизвестного/веб-webm mime: другой контейнер AVPlayer всё равно не проиграет,
    // так что попытка с m4a — максимум, что можно сделать.
    return "m4a"
}

/// Готовит расшифрованный секретный файл к воспроизведению: SecretRepository кладёт кэш
/// под хеш БЕЗ расширения, поэтому рядом создаётся жёсткая ссылка с расширением.
/// Ссылка, а не копия — второй копии расшифрованных байтов на диске не нужно; лежит она
/// в том же каталоге и с тем же префиксом треда, поэтому purgeThreadLocal стирает её
/// вместе с самим кэшем и расшифровка не переживает закрытие секретки.
private func playableAudioURL(_ file: URL, mime: String?) -> URL {
    guard file.pathExtension.isEmpty else { return file }
    let fm = FileManager.default
    let alias = file.appendingPathExtension(audioFileExtension(for: mime))
    if fm.fileExists(atPath: alias.path) { return alias }
    do {
        try fm.linkItem(at: file, to: alias)
        return alias
    } catch {
        // Гонка соседнего пузыря (ссылку уже создали) или ФС без жёстких ссылок:
        // берём готовый алиас, иначе копию, и лишь в крайнем случае файл как есть.
        if fm.fileExists(atPath: alias.path) { return alias }
        do {
            try fm.copyItem(at: file, to: alias)
            return alias
        } catch {
            return file
        }
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
