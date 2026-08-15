import SwiftUI
import UIKit
import QuartzCore

// Порт корня `ui/call/CallScreen.kt` (фон + шторка сворачивания + выбор экрана по фазе)
// плюс компактная плашка свёрнутого звонка.
//
// Отличия платформы (семантика сохранена):
//  - системной кнопки «назад» на iOS нет — Android-BackHandler (в разговоре свернуть,
//    входящий глотает back) не нужен: оверлей лежит поверх навигации и сам её глушит;
//  - IncomingCallService.goQuiet (убрать всплывашку с дублирующими кнопками, когда наш
//    полноэкранный входящий уже виден) не нужен: рингтоном владеет CallRinger в CallManager;
//  - на Android свёрнутый звонок подсвечивал шапку конкретного чата; здесь плашка живёт
//    в самом оверлее и видна над ЛЮБЫМ экраном (как полоска на ПК).

/// Корневой оверлей звонков. Кладётся в ZStack RootView ПОВЕРХ всего приложения:
/// пока фаза не idle, поверх навигации живёт полноэкранный экран звонка
/// (входящий / дозвон / разговор), а свёрнутый звонок — компактная плашка сверху:
/// разговор продолжается, пользователь ходит по чатам.
struct CallOverlay: View {
    @ObservedObject var manager: CallManager

    var body: some View {
        ZStack(alignment: .top) {
            // Полный оверлей монтируется и во время интерактивного вытягивания из плашки:
            // невидимый (progress≈1), он РЕАЛЬНО следует за пальцем через minimizeProgress.
            if manager.phase != .idle && (!manager.minimized || manager.expandDragActive) {
                CallScreenContainer(manager: manager)
            }
            // Плашка живёт, пока звонок свёрнут, И пока идёт вытягивание: узел с активным
            // жестом не должен исчезнуть из-под пальца (порт комментария из шапки
            // Android-чата). Растворяется синхронно с разворотом оверлея.
            if (manager.phase.isActive || manager.phase == .outgoing)
                && (manager.minimized || manager.expandDragActive) {
                MinimizedCallPill(manager: manager)
                    .opacity(manager.minimizeProgress)
                    .padding(.top, 6)
            }
        }
    }
}

// MARK: - Полноэкранный контейнер (порт композабла CallScreen)

private struct CallScreenContainer: View {
    @ObservedObject var manager: CallManager
    /// Последний translation жеста: SwiftUI отдаёт абсолютный сдвиг, а прогресс
    /// двигается инкрементами — как detectVerticalDragGestures в Kotlin.
    @State private var lastDragY: CGFloat?

    private var collapsible: Bool { manager.phase.isActive || manager.phase == .outgoing }

    var body: some View {
        GeometryReader { geo in
            let progress = collapsible ? manager.minimizeProgress : 0

            ZStack {
                Eb.paper.ignoresSafeArea()
                switch manager.phase {
                case .incoming:
                    IncomingCallView(manager: manager)
                case .outgoing:
                    RingingView(
                        title: manager.title,
                        subtitle: manager.isVideoCall ? "Видеозвонок…" : "Звоним…",
                        avatarUrl: manager.avatarUrl,
                        onCancel: manager.hangUp
                    )
                case .connecting, .inCall:
                    CallView(manager: manager)
                case .idle:
                    EmptyView()
                }
            }
            // Шторка: тянем оверлей ВВЕРХ — он уезжает к плашке, растворяясь по мере
            // движения; параллельно (через minimizeProgress) проявляется сама плашка.
            // Отпустили раньше трети пути — опускается обратно.
            .offset(y: -progress * geo.size.height * 0.25)
            .opacity(1 - progress)
            .gesture(
                collapseDrag(height: geo.size.height),
                including: collapsible ? .all : .subviews
            )
        }
        .onAppear {
            // Оверлей лежит ПОВЕРХ чата, поле ввода под ним сохраняет фокус: развернув
            // звонок во время набора, пользователь получал клавиатуру поверх кнопок
            // «микрофон/камера/завершить». Прячем клавиатуру при появлении оверлея.
            UIApplication.shared.sendAction(
                #selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil
            )
            // Разворот из плашки: оверлей монтируется с progress=1 (невидим) и шторкой
            // опускается вниз до полного. При интерактивном вытягивании авто-анимацию
            // НЕ запускаем — прогрессом рулит палец на плашке.
            if collapsible && manager.minimizeProgress > 0.95 && !manager.expandDragActive {
                Task { @MainActor in
                    await animateCallMinimizeProgress(manager, to: 0)
                }
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

    /// Отпустили: утянули дальше трети — доводим сворачивание, иначе опускаем обратно.
    private func finishDrag() {
        Task { @MainActor in
            let current = manager.minimizeProgress
            if current > 0.3 {
                await animateCallMinimizeProgress(manager, to: 1)
                manager.minimize()
            } else {
                await animateCallMinimizeProgress(manager, to: 0)
            }
        }
    }
}

// MARK: - Плашка свёрнутого звонка

/// Компактная плашка «Идёт звонок» у верхнего края (роль подсвеченной шапки чата с
/// таймером на Android). Тап — развернуть; можно потянуть ВНИЗ — оверлей звонка
/// следует за пальцем.
private struct MinimizedCallPill: View {
    @ObservedObject var manager: CallManager
    @State private var dragging = false

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            HStack(spacing: 8) {
                Image(systemName: "phone.fill")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Eb.online)
                Text("Идёт звонок · " + callTimerLabel(activeSince: manager.activeSince, now: context.date))
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Eb.textPrimary)
                    .lineLimit(1)
                Image(systemName: "chevron.down")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(Eb.textMuted)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 9)
            .background(Eb.surface300, in: Capsule())
            .overlay(Capsule().strokeBorder(Eb.brand.opacity(0.55)))
        }
        .contentShape(Capsule())
        // Тап — развернуть: прогресс НЕ сбрасывается, onAppear оверлея сам опустит шторку.
        .onTapGesture { manager.expand() }
        .gesture(expandDrag)
        .accessibilityLabel("Вернуться в звонок")
    }

    /// Порт вытягивания из шапки Android-чата (startExpandDrag/moveExpandDrag/finishExpandDrag).
    private var expandDrag: some Gesture {
        DragGesture(minimumDistance: 6)
            .onChanged { value in
                if !dragging {
                    dragging = true
                    if manager.minimized { manager.beginInteractiveExpand() }
                }
                // Жест стартует из свёрнутого состояния (progress = 1), поэтому абсолютный
                // сдвиг пальца прямо даёт прогресс: dy>0 (палец вниз) => прогресс падает =>
                // оверлей выезжает за пальцем.
                let collapseDistance = UIScreen.main.bounds.height * 0.45
                manager.setMinimizeProgress(1 - Double(value.translation.height) / Double(collapseDistance))
            }
            .onEnded { _ in
                dragging = false
                // Отпустили: вытянули больше трети — доводим разворот, иначе прячем обратно.
                Task { @MainActor in
                    let current = manager.minimizeProgress
                    if current < 0.7 {
                        await animateCallMinimizeProgress(manager, to: 0)
                    } else {
                        await animateCallMinimizeProgress(manager, to: 1)
                        manager.minimize()
                    }
                    manager.endInteractiveExpand()
                }
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
/// оверлей и плашка (а в перспективе и шапка чата) — локальная SwiftUI-анимация каждого
/// из них разъехалась бы.
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
