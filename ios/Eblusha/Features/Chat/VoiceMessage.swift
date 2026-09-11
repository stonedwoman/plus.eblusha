import AVFoundation
import Combine
import SwiftUI
import UIKit

// Порт голосовых сообщений из `ui/chat/ChatScreen.kt`: кнопка микрофона и строка записи
// для композера (LiveWaveform + formatRecordTime) и waveform-плеер AUDIO-вложений
// (VoiceMessagePlayer + WaveformBars + pseudoWaveform).
//
// Кнопка микрофона с тех пор переехала на удержание (см. VoiceRecordGesture.swift): тап
// больше не включает микрофон, запись идёт, пока палец на кнопке, влево — отмена, вверх —
// фиксация. После остановки зафиксированной записи есть ещё черновик на прослушивание.

/// Порт `formatRecordTime` из ChatScreen.kt: «М:СС».
func formatRecordTime(_ ms: Int64) -> String {
    let totalSec = Int(ms / 1000)
    return String(format: "%d:%02d", totalSec / 60, totalSec % 60)
}

// MARK: - Запись

/// Записанное, но ещё не отправленное голосовое.
struct VoiceDraft {
    /// Копия во временном каталоге — нужна только чтобы дать послушать: плеер умеет
    /// играть URL, а не байты. nil — записать копию не вышло, прослушивание недоступно.
    let url: URL?
    /// Байты .m4a для отправки (их же вернул VoiceRecorder.stop()).
    let data: Data
    let durationSec: Int
    let waveform: [Int]
}

/// Состояние голосовой ветки композера: удержание → (отмена | отправка | фиксация) →
/// черновик на прослушивание. Живёт рядом с VoiceRecorder, а не внутри него: рекордер
/// знает про микрофон и файл, а про пальцы и панели — эта коробка.
final class VoiceComposerState: ObservableObject {

    enum Phase {
        /// Микрофон в покое.
        case idle
        /// Идёт запись, палец на кнопке.
        case holding
        /// Идёт запись, палец не нужен (сдвинули вверх).
        case locked
    }

    @Published private(set) var phase: Phase = .idle
    @Published private(set) var draft: VoiceDraft?
    /// Всплывающая подсказка над микрофоном: короткий тап, отказ в доступе, сбой старта.
    @Published private(set) var hint: String?

    private var hintTask: Task<Void, Never>?

    /// Композер показывает строку вместо ряда ввода. Во время удержания — НЕ показывает:
    /// кнопка-носитель жеста обязана остаться в иерархии, иначе удержание оборвётся ровно
    /// в момент старта записи.
    var showsBar: Bool { phase == .locked || draft != nil }

    var isHolding: Bool { phase == .holding }

    // MARK: удержание

    /// Палец опустился на микрофон. false — записи не будет (нет доступа к микрофону или
    /// он не открылся); в этом случае подсказка уже показана.
    @discardableResult
    func beginHold(recorder: VoiceRecorder) -> Bool {
        guard phase == .idle, draft == nil else { return false }
        switch AVAudioApplication.shared.recordPermission {
        case .granted:
            break
        case .undetermined:
            // Первый в жизни запрос приходит СИСТЕМНЫМ алертом поверх экрана и рвёт
            // удержание. Записью такую попытку не считаем: спрашиваем разрешение и просим
            // повторить — иначе запись стартовала бы вслепую под чужим алертом.
            showHint("Разрешите доступ к микрофону и повторите")
            Task { _ = await VoiceRecorder.requestPermission() }
            return false
        default:
            showHint("Микрофон запрещён в «Настройках»")
            return false
        }
        do {
            try recorder.start()
        } catch {
            showHint("Микрофон недоступен")
            return false
        }
        phase = .holding
        VoiceHoldGuard.isActive = true
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        return true
    }

    /// Отпустили позже порога — голосовое уходит адресату одним движением.
    func finishHold(recorder: VoiceRecorder, send: (Data, Int, [Int]) -> Void) {
        guard phase == .holding else { return }
        endHold()
        if let result = recorder.stop() {
            send(result.data, result.durationSec, result.waveform)
        }
    }

    /// Отпустили раньше 0.4 с: это тап, а не запись. Молча выбрасывать нельзя — человек
    /// нажал на микрофон и вправе узнать, почему ничего не произошло.
    func cancelAsTap(recorder: VoiceRecorder) {
        endHold()
        recorder.cancel()
        showHint("Удерживайте кнопку для записи")
    }

    /// Увели палец влево — записи как будто и не было.
    func cancelHold(recorder: VoiceRecorder) {
        guard phase == .holding else { return }
        endHold()
        recorder.cancel()
        UIImpactFeedbackGenerator(style: .rigid).impactOccurred()
    }

    /// Увели палец вверх — запись продолжается без пальца.
    func lock() {
        guard phase == .holding else { return }
        phase = .locked
        // Палец больше не держит запись: свайп-назад снова разрешён.
        VoiceHoldGuard.isActive = false
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
    }

    /// Путь для VoiceOver и для тех, кому удержание недоступно: обычное нажатие сразу
    /// открывает зафиксированную запись со строкой «корзина — стоп — отправить».
    func startLocked(recorder: VoiceRecorder) {
        guard beginHold(recorder: recorder) else { return }
        lock()
    }

    // MARK: зафиксированная запись и черновик

    /// «Отправить» из зафиксированной записи: стоп и сразу отправка — типовой случай не
    /// должен дорожать на лишний тап.
    func sendLocked(recorder: VoiceRecorder, send: (Data, Int, [Int]) -> Void) {
        guard let result = recorder.stop() else {
            cancelAll(recorder: recorder)
            return
        }
        phase = .idle
        VoiceHoldGuard.isActive = false
        send(result.data, result.durationSec, result.waveform)
    }

    /// «Стоп» из зафиксированной записи: не отправляем, а даём послушать и передумать.
    func stopForPreview(recorder: VoiceRecorder) {
        guard let result = recorder.stop() else {
            cancelAll(recorder: recorder)
            return
        }
        phase = .idle
        VoiceHoldGuard.isActive = false
        draft = VoiceDraft(
            url: Self.stash(result.data),
            data: result.data,
            durationSec: result.durationSec,
            waveform: result.waveform
        )
    }

    /// «Отправить» из панели предпросмотра.
    func sendDraft(_ send: (Data, Int, [Int]) -> Void) {
        guard let draft else { return }
        send(draft.data, draft.durationSec, draft.waveform)
        dropDraft()
    }

    /// Полный сброс: корзина, уход с экрана, переезд композера на другую беседу. Без него
    /// черновик уехал бы в ЧУЖУЮ переписку.
    func cancelAll(recorder: VoiceRecorder) {
        endHold()
        recorder.cancel()
        dropDraft()
    }

    private func endHold() {
        phase = .idle
        VoiceHoldGuard.isActive = false
    }

    private func dropDraft() {
        if let url = draft?.url { try? FileManager.default.removeItem(at: url) }
        draft = nil
    }

    private func showHint(_ text: String) {
        hintTask?.cancel()
        hint = text
        hintTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 1_800_000_000)
            guard !Task.isCancelled else { return }
            self?.hint = nil
        }
    }

    /// VoiceRecorder.stop() свой временный файл удаляет (байты он уже вернул), поэтому для
    /// прослушивания кладём копию обратно во временный каталог. Лишняя копия живёт от
    /// остановки до отправки или корзины — для голосового это десятки килобайт.
    private static func stash(_ data: Data) -> URL? {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("voice-draft-\(Int64(Date().timeIntervalSince1970 * 1000)).m4a")
        do {
            try data.write(to: url)
            return url
        } catch {
            return nil
        }
    }
}

/// Кнопка микрофона в композере. Запись идёт, ПОКА палец на кнопке: короткое касание
/// записью не считается, сдвиг влево отменяет, сдвиг вверх фиксирует. Жест — UIKit-ный
/// (VoiceHoldGesture), сама кнопка остаётся SwiftUI.
struct VoiceRecordButton: View {

    @ObservedObject var recorder: VoiceRecorder
    @ObservedObject var state: VoiceComposerState
    var sending = false
    /// Отпустили после порога — голосовое уходит сразу (Data, длительность, волна 0..100).
    let onSend: (Data, Int, [Int]) -> Void

    /// Смещение пальца от точки нажатия. Держим ЗДЕСЬ, а не в общем состоянии: иначе
    /// каждый кадр перетаскивания перестраивал бы композер целиком, а это тот же главный
    /// поток, что и жест, — палец начал бы подлагивать.
    @State private var offset: CGSize = .zero

    /// Ширина строки ввода: подложка записи и подсказка держатся за микрофон, а накрыть
    /// должны всю строку. Композер своей ширины не сообщает, поэтому берём ширину окна
    /// минус горизонтальные отступы панели (10 pt с каждой стороны).
    private static let rowWidth: CGFloat = {
        let window = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first { $0.isKeyWindow }
        return max((window?.bounds.width ?? 380) - 20, 200)
    }()

    /// Заполненность замка — доля пройденного вверх пути (порт `|смещение| / 105`).
    private var lockFill: Double {
        Double(min(max(-offset.height, 0) / VoiceHoldMetrics.lockTravel, 1))
    }

    /// Насколько уехала подсказка «влево — отмена»: первые 10 pt считаем дрожанием пальца.
    private var hintShift: CGFloat {
        min(offset.width + VoiceHoldMetrics.activationOffset, 0)
    }

    /// Палец уже за «предупреждающим» порогом — подсказка краснеет.
    private var nearCancel: Bool { offset.width <= -VoiceHoldMetrics.dismissOffset }

    var body: some View {
        Image(systemName: "mic.fill")
            .font(.system(size: 17))
            .foregroundStyle(state.isHolding ? Color.white : Eb.brand)
            .frame(width: 38, height: 38)
            .background(state.isHolding ? Eb.brand : Color.clear, in: Circle())
            .scaleEffect(state.isHolding ? 1.25 : 1)
            // Полоса записи — именно .background: она накрывает строку ввода слева, но сам
            // микрофон остаётся поверх неё.
            .background(alignment: .trailing) { recordingStrip }
            .overlay { lockPanel }
            .overlay(alignment: .bottomTrailing) { hintBubble }
            // Анимации — ПОСЛЕ всех слоёв, которые они должны охватывать, и ДО жеста:
            // .animation(_:value:) действует на то, что навешано выше него по цепочке.
            .animation(.spring(response: 0.3, dampingFraction: 0.7), value: state.isHolding)
            .animation(.easeOut(duration: 0.2), value: state.hint)
            .overlay { gestureLayer }
            .accessibilityElement(children: .ignore)
            .accessibilityAddTraits(.isButton)
            .accessibilityLabel("Голосовое сообщение")
            .accessibilityHint("Удерживайте для записи: влево — отмена, вверх — фиксация")
            // VoiceOver до удержания не добирается (касания забирает он), поэтому обычная
            // активация начинает запись сразу в зафиксированном режиме.
            .accessibilityAction { state.startLocked(recorder: recorder) }
    }

    // MARK: жест

    private var gestureLayer: some View {
        VoiceHoldGesture(
            onBegan: {
                guard !sending, !state.showsBar else { return }
                offset = .zero
                state.beginHold(recorder: recorder)
            },
            onChanged: { moved, speed in
                guard state.isHolding else { return }
                offset = moved
                // Влево — отмена: либо ушли достаточно далеко, либо дёрнули достаточно
                // резко. Проверяем ПЕРВОЙ: рывок влево почти всегда несёт и немного «вверх».
                if moved.width <= VoiceHoldMetrics.cancelDistanceX
                    || (moved.width <= -VoiceHoldMetrics.activationOffset
                        && speed.width <= VoiceHoldMetrics.cancelVelocityX) {
                    offset = .zero
                    state.cancelHold(recorder: recorder)
                    return
                }
                if moved.height <= VoiceHoldMetrics.lockDistanceY
                    || (moved.height <= -VoiceHoldMetrics.activationOffset
                        && speed.height <= VoiceHoldMetrics.lockVelocityY) {
                    offset = .zero
                    state.lock()
                }
            },
            onEnded: { _, duration in
                offset = .zero
                guard state.isHolding else { return }
                if duration < VoiceHoldMetrics.tapDuration {
                    state.cancelAsTap(recorder: recorder)
                } else {
                    state.finishHold(recorder: recorder, send: onSend)
                }
            },
            onCancelled: {
                offset = .zero
                // Зафиксированную запись потеря касания не трогает: палец ей не нужен, а
                // касание она теряет как раз потому, что кнопка уехала из иерархии.
                guard state.isHolding else { return }
                state.cancelHold(recorder: recorder)
            }
        )
        .accessibilityHidden(true)
    }

    // MARK: полоса записи под пальцем

    @ViewBuilder private var recordingStrip: some View {
        if state.isHolding {
            ZStack {
                // Непрозрачная подложка цвета панели: строка ввода под ней осталась живой
                // (она носит жест), но видеть её во время записи не нужно.
                Rectangle().fill(Eb.surface200)
                HStack(spacing: 0) {
                    Circle()
                        .fill(Color(hex: 0xE5484D))
                        .frame(width: 10, height: 10)
                    Spacer().frame(width: 10)
                    Text(formatRecordTime(recorder.elapsedMs))
                        .font(.footnote.weight(.medium))
                        .monospacedDigit()
                        .foregroundStyle(Eb.textPrimary)
                    Spacer(minLength: 12)
                    slideToCancel
                    Spacer(minLength: 12)
                }
                // Справа остаётся место под сам микрофон.
                .padding(.trailing, 46)
                .padding(.leading, 4)
            }
            .frame(width: Self.rowWidth, height: 44)
            .allowsHitTesting(false)
            .transition(.opacity)
        }
    }

    private var slideToCancel: some View {
        HStack(spacing: 6) {
            Image(systemName: "chevron.left")
                .font(.system(size: 12, weight: .semibold))
            Text("Влево — отмена")
                .font(.system(size: 14))
        }
        .foregroundStyle(nearCancel ? Eb.error : Eb.textMuted)
        // Подсказка едет ЗА пальцем и тает по мере приближения к порогу отмены.
        .offset(x: hintShift)
        .opacity(1 - min(Double(-hintShift) / Double(-VoiceHoldMetrics.cancelDistanceX), 1) * 0.6)
    }

    // MARK: замок над кнопкой

    @ViewBuilder private var lockPanel: some View {
        if state.isHolding {
            VStack(spacing: 3) {
                Image(systemName: lockFill >= 1 ? "lock.fill" : "lock.open.fill")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(lockFill >= 1 ? Eb.brand : Eb.textMuted)
                Image(systemName: "chevron.up")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(Eb.textMuted.opacity(1 - lockFill))
            }
            .frame(width: 34, height: 52)
            .background(Eb.surface300, in: Capsule())
            // Кант заполняется по мере пути вверх — видно, сколько осталось до фиксации.
            .overlay(Capsule().strokeBorder(Eb.brand.opacity(lockFill), lineWidth: 2))
            // Панель едет за пальцем, но не дальше, чем нужно для фиксации.
            .offset(y: -58 + max(offset.height, -VoiceHoldMetrics.lockTravel))
            .allowsHitTesting(false)
            .transition(.opacity)
        }
    }

    // MARK: подсказка после короткого тапа

    @ViewBuilder private var hintBubble: some View {
        if let hint = state.hint {
            Text(hint)
                .font(.footnote)
                .foregroundStyle(Eb.textPrimary)
                .padding(.horizontal, 12)
                .padding(.vertical, 7)
                .background(Eb.surface300, in: Capsule())
                .overlay(Capsule().strokeBorder(Eb.border))
                .fixedSize()
                .offset(y: -46)
                .allowsHitTesting(false)
                .transition(.opacity)
        }
    }
}

/// Строка, заменяющая ряд ввода композера, когда палец уже не нужен: либо зафиксированная
/// запись, либо записанный черновик на прослушивание. Высота обеих веток — ровно 38 pt,
/// как у ряда ввода: иначе onHeightChanged дёргал бы ленту на каждом касании микрофона.
struct VoiceComposerBar: View {

    @ObservedObject var recorder: VoiceRecorder
    @ObservedObject var state: VoiceComposerState
    var sending = false
    let onSend: (Data, Int, [Int]) -> Void

    var body: some View {
        Group {
            if let draft = state.draft {
                VoicePreviewBar(
                    draft: draft,
                    sending: sending,
                    onDrop: { state.cancelAll(recorder: recorder) },
                    onSend: { state.sendDraft(onSend) }
                )
            } else {
                VoiceRecordBar(
                    recorder: recorder,
                    sending: sending,
                    onCancel: { state.cancelAll(recorder: recorder) },
                    onStop: { state.stopForPreview(recorder: recorder) },
                    onSend: { state.sendLocked(recorder: recorder, send: onSend) }
                )
            }
        }
        .frame(height: 38)
    }
}

/// Зафиксированная запись (порт recording-ветки EblushaComposer, плюс «стоп»):
/// корзина — [красная точка + таймер + живая волна] — стоп — отправить.
struct VoiceRecordBar: View {

    @ObservedObject var recorder: VoiceRecorder
    var sending = false
    let onCancel: () -> Void
    /// Стоп: остановить и дать послушать (отправка при этом НЕ происходит).
    let onStop: () -> Void
    /// Отправить прямо из записи, без прослушивания, — один жест на типовой случай.
    let onSend: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            Button(action: onCancel) {
                Image(systemName: "trash")
                    .font(.system(size: 17))
                    .foregroundStyle(Eb.error)
                    .frame(width: 38, height: 38)
            }
            .accessibilityLabel("Отменить запись")

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
                    .frame(height: 22)
                    .frame(maxWidth: .infinity)
            }
            .padding(.horizontal, 14)
            .frame(height: 38)
            .background(Eb.surface300, in: Capsule())

            Button(action: onStop) {
                Image(systemName: "stop.fill")
                    .font(.system(size: 14))
                    .foregroundStyle(Eb.textPrimary)
                    .frame(width: 34, height: 34)
                    .background(Eb.surface300, in: Circle())
            }
            .accessibilityLabel("Остановить и прослушать")

            Button(action: onSend) {
                Image(systemName: "arrow.up")
                    .font(.system(size: 17, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 38, height: 38)
                    .background(Eb.brand, in: Circle())
            }
            .disabled(sending)
            .accessibilityLabel("Отправить голосовое")
        }
    }
}

/// Черновик до отправки (порядок как в панели предпросмотра Telegram): корзина —
/// play/pause 26×26 — таблетка с волной — длительность — отправка.
struct VoicePreviewBar: View {

    let draft: VoiceDraft
    var sending = false
    let onDrop: () -> Void
    let onSend: () -> Void

    @StateObject private var playback = VoicePlayback()

    var body: some View {
        let totalMs = playback.totalMs > 0 ? playback.totalMs : Int64(draft.durationSec) * 1000
        let progress = totalMs > 0 ? Double(playback.positionMs) / Double(totalMs) : 0
        // На паузе в начале показываем полную длительность, дальше — текущую позицию.
        let shownMs = playback.positionMs > 0 ? playback.positionMs : totalMs

        HStack(spacing: 8) {
            Button(action: onDrop) {
                Image(systemName: "trash")
                    .font(.system(size: 17))
                    .foregroundStyle(Eb.error)
                    .frame(width: 38, height: 38)
            }
            .accessibilityLabel("Удалить запись")

            HStack(spacing: 10) {
                Button {
                    guard let url = draft.url else { return }
                    playback.toggle(urlString: url.absoluteString)
                } label: {
                    Image(systemName: playback.playing ? "pause.fill" : "play.fill")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(.white)
                        .frame(width: 26, height: 26)
                        .background(Eb.brand, in: Circle())
                }
                .buttonStyle(.plain)
                .disabled(draft.url == nil)
                .accessibilityLabel(playback.playing ? "Пауза" : "Прослушать")

                // Волна статична: перерисовывать её на каждом кадре воспроизведения нельзя,
                // достаточно перекраски баров по позиции.
                WaveformBars(
                    bars: draft.waveform,
                    progress: progress,
                    played: Eb.brand,
                    idle: Eb.textMuted.opacity(0.6)
                )
                .frame(height: 13)
                .frame(maxWidth: .infinity)

                Text(formatRecordTime(shownMs))
                    .font(.caption)
                    .monospacedDigit()
                    .foregroundStyle(Eb.textMuted)
                    .frame(width: 35, alignment: .trailing)
            }
            .padding(.horizontal, 10)
            .frame(height: 38)
            .background(Eb.surface300, in: Capsule())

            Button(action: onSend) {
                Image(systemName: "arrow.up")
                    .font(.system(size: 17, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 38, height: 38)
                    .background(Eb.brand, in: Circle())
            }
            .buttonStyle(VoiceSendPressStyle())
            .disabled(sending)
            .accessibilityLabel("Отправить голосовое")
        }
    }
}

/// Отклик кнопки отправки на нажатие: сжатие 0.4 с, возврат 0.25 с. Стиль, а не свой
/// жест: SwiftUI-жест поверх кнопки отнимал бы у неё само нажатие.
private struct VoiceSendPressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.85 : 1)
            .animation(
                .easeInOut(duration: configuration.isPressed ? 0.4 : 0.25),
                value: configuration.isPressed
            )
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
