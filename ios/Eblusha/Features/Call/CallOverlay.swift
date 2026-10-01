import SwiftUI
import UIKit
import QuartzCore

// Порт корня `ui/call/CallScreen.kt` (фон + шторка сворачивания + выбор экрана по фазе)
// плюс миниатюра свёрнутого звонка (порт веб-CallMini, см. CallMiniView).
//
// Отличия платформы (семантика сохранена):
//  - системной кнопки «назад» на iOS нет — Android-BackHandler (в разговоре свернуть,
//    входящий глотает back) не нужен: оверлей лежит поверх навигации и сам её глушит;
//  - IncomingCallService.goQuiet (убрать всплывашку с дублирующими кнопками, когда наш
//    полноэкранный входящий уже виден) не нужен: рингтоном владеет CallRinger в CallManager;
//  - на Android свёрнутый звонок подсвечивал шапку конкретного чата; здесь плитка живёт
//    в самом оверлее и видна над ЛЮБЫМ экраном (как на вебе и ПК).

/// Корневой оверлей звонков. Кладётся в ZStack RootView ПОВЕРХ всего приложения:
/// пока фаза не idle, поверх навигации живёт полноэкранный экран звонка
/// (входящий / дозвон / разговор), а свёрнутый разговор — перетаскиваемая плитка 16:9
/// с говорящим: разговор продолжается, пользователь ходит по чатам.
struct CallOverlay: View {
    @ObservedObject var manager: CallManager
    @ObservedObject private var connect: CallConnectController
    /// Прямоугольник плитки (координаты окна), из которого панель разъезжается при развороте.
    @State private var expandFrom: CGRect?
    /// Последний прямоугольник панели звонка — из него плитка прилетает при сворачивании.
    @State private var panelFrame: CGRect?

    init(manager: CallManager) {
        _manager = ObservedObject(wrappedValue: manager)
        _connect = ObservedObject(wrappedValue: manager.connect)
    }

    var body: some View {
        ZStack {
            if manager.phase != .idle && !manager.minimized {
                CallScreenContainer(
                    manager: manager,
                    connect: connect,
                    expandFrom: expandFrom,
                    onPanelFrame: { panelFrame = $0 }
                )
            }
            // Плитка живёт, пока разговор свёрнут. Комната LiveKit остаётся в CallManager:
            // сворачивание — только смена экрана.
            if manager.phase == .inCall && manager.minimized {
                CallMiniView(
                    snapshot: miniSnapshot,
                    flyFrom: panelFrame,
                    onExpand: { rect in
                        expandFrom = rect
                        manager.expand()
                    },
                    onToggleMic: { manager.toggleMic() },
                    onHangUp: { manager.hangUp() }
                )
            }
        }
        // Прямоугольник плитки годится один раз: следующий разворот (например, кнопкой в
        // шапке беседы) не должен стартовать из старого места, а новый звонок — тем более.
        .onChange(of: manager.minimized) { _, minimized in
            if minimized { expandFrom = nil }
        }
        .onChange(of: manager.phase) { _, phase in
            if phase == .idle { expandFrom = nil }
        }
        // Экран установления снова виден (ошибка подключения или шифрования) — он всегда
        // во весь экран: если человек в этот момент был в плитке, разворачиваем.
        .onChange(of: connect.visible) { _, visible in
            if visible && manager.minimized { manager.expand() }
        }
    }

    private var miniSnapshot: CallMiniSnapshot {
        CallMiniSnapshot(
            participants: manager.participants,
            activeSpeakerIds: manager.activeSpeakerIds,
            micOn: manager.micOn,
            cameraOn: manager.cameraOn,
            isGroup: manager.isGroup,
            encrypted: manager.e2eeEnabled,
            connectedAt: manager.activeSince,
            reconnecting: manager.reconnecting
        )
    }
}

// MARK: - Полноэкранный контейнер (порт композабла CallScreen)

private struct CallScreenContainer: View {
    @ObservedObject var manager: CallManager
    @ObservedObject var connect: CallConnectController
    let onPanelFrame: (CGRect) -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// Прямоугольник плитки, из которого панель разъезжается на место (FLIP, как на вебе);
    /// nil — панель уже на месте.
    @State private var entering: CGRect?
    /// Последний translation жеста: SwiftUI отдаёт абсолютный сдвиг, а прогресс
    /// двигается инкрементами — как detectVerticalDragGestures в Kotlin.
    @State private var lastDragY: CGFloat?

    init(
        manager: CallManager,
        connect: CallConnectController,
        expandFrom: CGRect?,
        onPanelFrame: @escaping (CGRect) -> Void
    ) {
        _manager = ObservedObject(wrappedValue: manager)
        _connect = ObservedObject(wrappedValue: connect)
        self.onPanelFrame = onPanelFrame
        _entering = State(initialValue: expandFrom)
    }

    /// Свернуть можно только ИДУЩИЙ разговор: дозвон и подключение всегда во весь экран
    /// (спека миниатюры), а пока виден экран установления — тем более.
    private var collapsible: Bool { manager.canMinimize }

    var body: some View {
        GeometryReader { geo in
            let progress = collapsible ? manager.minimizeProgress : 0
            let frame = geo.frame(in: .global)

            ZStack {
                Eb.paper.ignoresSafeArea()
                switch manager.phase {
                case .incoming:
                    IncomingCallView(manager: manager)
                case .outgoing, .connecting, .inCall:
                    // Один экран от начала вызова до разговора: на дозвоне — «Звоним…» с
                    // кольцами вокруг собеседника, после ответа — этапы подключения. Ветка
                    // общая, чтобы экран не пересоздавался в момент ответа.
                    ZStack {
                        // Разговор монтируется под экраном установления только после ответа.
                        if manager.phase != .outgoing {
                            CallView(manager: manager)
                        }
                        CallConnectingOverlay(controller: connect, video: manager.isVideoCall)
                    }
                case .idle:
                    EmptyView()
                }
            }
            // Шторка: тянем оверлей ВВЕРХ — он уезжает, растворяясь по мере движения.
            // Отпустили дальше трети пути — сворачивается в плитку, иначе опускается обратно.
            .offset(y: -progress * geo.size.height * 0.25)
            .opacity(1 - progress)
            .gesture(
                collapseDrag(height: geo.size.height),
                including: collapsible ? .all : .subviews
            )
            // Разворот из плитки: панель стартует из её прямоугольника и разъезжается на
            // место (translate+scale, 320 мс, прозрачность .4→1) — как FLIP на вебе.
            .scaleEffect(
                x: entering.map { $0.width / max(1, frame.width) } ?? 1,
                y: entering.map { $0.height / max(1, frame.height) } ?? 1,
                anchor: .topLeading
            )
            .offset(
                x: entering.map { $0.minX - frame.minX } ?? 0,
                y: entering.map { $0.minY - frame.minY } ?? 0
            )
            .opacity(entering == nil ? 1 : 0.4)
            .onAppear { onPanelFrame(frame) }
            .onChange(of: geo.size) { _, _ in onPanelFrame(geo.frame(in: .global)) }
        }
        .onAppear {
            // Оверлей лежит ПОВЕРХ чата, поле ввода под ним сохраняет фокус: развернув
            // звонок во время набора, пользователь получал клавиатуру поверх кнопок
            // «микрофон/камера/завершить». Прячем клавиатуру при появлении оверлея.
            UIApplication.shared.sendAction(
                #selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil
            )
            guard entering != nil else { return }
            if reduceMotion {
                entering = nil
                return
            }
            // Стартовый (сжатый) кадр должен отрисоваться до анимации.
            DispatchQueue.main.async {
                withAnimation(callMiniSnapCurve) { entering = nil }
            }
        }
    }

    private func collapseDrag(height: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 12)
            .onChanged { value in
                let collapseDistance = height * 0.45
                let delta = value.translation.height - (lastDragY ?? 0)
                lastDragY = value.translation.height
                manager.setMinimizeProgress(
                    manager.minimizeProgress - Double(delta) / Double(collapseDistance)
                )
            }
            .onEnded { _ in
                lastDragY = nil
                finishDrag()
            }
    }

    /// Отпустили: утянули дальше трети — сворачиваем (плитка прилетит из панели), иначе
    /// опускаем обратно.
    private func finishDrag() {
        if manager.minimizeProgress > 0.3 {
            manager.minimize()
            return
        }
        Task { @MainActor in
            await animateCallMinimizeProgress(manager, to: 0)
        }
    }
}

// MARK: - Общие помощники звонкового UI

/// Порт таймера из шапки Android-чата: «Звоним…» до принятия, дальше m:ss (часы при 1ч+).
func callTimerLabel(activeSince: Date?, now: Date) -> String {
    guard let activeSince else { return "Звоним…" }
    return callDurationLabel(since: activeSince, now: now)
}

/// m:ss / h:mm:ss — формат тот же, что на Android.
func callDurationLabel(since: Date, now: Date) -> String {
    let totalSec = max(0, Int(now.timeIntervalSince(since)))
    let h = totalSec / 3600
    let m = (totalSec % 3600) / 60
    let s = totalSec % 60
    return h > 0
        ? String(format: "%d:%02d:%02d", h, m, s)
        : String(format: "%d:%02d", m, s)
}

/// Порт `androidx.compose.animation.core.animate`: доводит ОБЩИЙ minimizeProgress до цели
/// вручную, малыми шагами. Анимировать надо само значение, а не вью: его синхронно читают
/// оверлей и шторка — локальная SwiftUI-анимация каждого из них разъехалась бы.
@MainActor
func animateCallMinimizeProgress(_ manager: CallManager, to target: Double) async {
    let start = manager.minimizeProgress
    let distance = target - start
    if abs(distance) < 0.001 {
        manager.setMinimizeProgress(target)
        return
    }
    let duration = 0.24
    let startTime = CACurrentMediaTime()
    while true {
        try? await Task.sleep(nanoseconds: 16_000_000) // ~60 fps
        // Звонок кончился посреди анимации — reset() уже обнулил прогресс, не трогаем.
        if manager.phase == .idle { return }
        let t = min(1, (CACurrentMediaTime() - startTime) / duration)
        let eased = 1 - pow(1 - t, 2) // easeOut — на глаз совпадает с дефолтным tween Compose
        manager.setMinimizeProgress(start + distance * eased)
        if t >= 1 { return }
    }
}
