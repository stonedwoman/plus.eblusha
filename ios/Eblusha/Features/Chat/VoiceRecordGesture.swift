import SwiftUI
import UIKit

// Удержание микрофона: свой UIKit-распознаватель вместо SwiftUI-жеста.
//
// Почему UIKit: SwiftUI-жесты в этом проекте уже дважды ломали прокрутку (они объявляют
// себя соседям иначе, чем UIGestureRecognizer, и лента начинала «залипать»). Здесь нужен
// ещё и момент КАСАНИЯ — до него SwiftUI даёт только DragGesture с minimumDistance 0,
// который перехватывает нажатие у кнопки. Поэтому: собственный распознаватель, который
// берётся за дело прямо в touchesBegan и сам считает смещение, скорость и длительность.

/// Пороги удержания. Числа из разбора Telegram-iOS (см. /tmp/tg-voice.md): отпускание
/// раньше 0.4 с — это тап, а не запись; влево дальше -100 pt (или быстрее -400 pt/с) —
/// отмена; вверх дальше -110 pt (или быстрее -400 pt/с) — фиксация; «заполненность»
/// замка — доля пути в 105 pt.
enum VoiceHoldMetrics {
    /// Короче этого удержание записью не считается.
    static let tapDuration: TimeInterval = 0.4
    /// Ниже этого смещения по X запись отменяется.
    static let cancelDistanceX: CGFloat = -100
    /// …либо отменяется сразу по скорости рывка влево.
    static let cancelVelocityX: CGFloat = -400
    /// Выше этого смещения по Y запись фиксируется (палец больше не нужен).
    static let lockDistanceY: CGFloat = -110
    /// …либо фиксируется сразу по скорости рывка вверх.
    static let lockVelocityY: CGFloat = -400
    /// Путь, на котором замок заполняется целиком.
    static let lockTravel: CGFloat = 105
    /// Меньше этого сдвиг считаем дрожанием пальца, а не движением: подсказка не едет
    /// и пороги по скорости не срабатывают.
    static let activationOffset: CGFloat = 10
    /// С этого сдвига влево подсказка «Отмена» краснеет — предупреждение до порога.
    static let dismissOffset: CGFloat = 70
}

/// «Прямо сейчас идёт незафиксированная запись». Нужен снаружи ровно одному месту —
/// свайпу-назад: он срабатывает из любой точки экрана, а уход с экрана зовёт
/// `voiceRecorder.cancel()` в `onDisappear` композера, то есть случайный сдвиг вправо
/// во время удержания стирал бы запись.
enum VoiceHoldGuard {
    /// Пишется и читается только из главного потока (жест и делегат свайпа — оба там).
    static var isActive = false
}

/// Распознаватель удержания: состояние «началось» выставляется в момент касания, дальше
/// копятся смещение от точки нажатия, сглаженная скорость и длительность удержания.
final class VoiceHoldRecognizer: UIGestureRecognizer {

    /// Смещение пальца от точки нажатия, в координатах ОКНА.
    private(set) var offset: CGSize = .zero
    /// Скорость пальца, pt/с, сглаженная (мгновенная скачет так, что пороги -400 pt/с
    /// срабатывали бы на дрожании).
    private(set) var speed: CGSize = .zero
    /// Сколько палец уже на кнопке.
    private(set) var holdDuration: TimeInterval = 0

    private var origin: CGPoint = .zero
    private var lastPoint: CGPoint = .zero
    private var lastStamp: TimeInterval = 0
    private var startStamp: TimeInterval = 0

    override func reset() {
        super.reset()
        offset = .zero
        speed = .zero
        holdDuration = 0
    }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        super.touchesBegan(touches, with: event)
        // Второй палец жест не ведёт: иначе «смещение» прыгнуло бы на чужое касание.
        guard state == .possible, let touch = touches.first else {
            for extra in touches { ignore(extra, for: event) }
            return
        }
        for extra in touches where extra !== touch { ignore(extra, for: event) }
        // Координаты окна, а не вью: композер во время записи может поехать вместе с
        // клавиатурой, и смещение относительно вью врало бы на её высоту.
        origin = touch.location(in: nil)
        lastPoint = origin
        startStamp = touch.timestamp
        lastStamp = touch.timestamp
        offset = .zero
        speed = .zero
        holdDuration = 0
        state = .began
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) {
        super.touchesMoved(touches, with: event)
        guard let touch = touches.first else { return }
        let point = touch.location(in: nil)
        let delta = touch.timestamp - lastStamp
        // На слишком коротком интервале деление даёт тысячи pt/с — такой отсчёт пропускаем.
        if delta >= 0.004 {
            let instant = CGSize(
                width: (point.x - lastPoint.x) / delta,
                height: (point.y - lastPoint.y) / delta
            )
            speed = CGSize(
                width: speed.width * 0.4 + instant.width * 0.6,
                height: speed.height * 0.4 + instant.height * 0.6
            )
            lastPoint = point
            lastStamp = touch.timestamp
        }
        offset = CGSize(width: point.x - origin.x, height: point.y - origin.y)
        holdDuration = touch.timestamp - startStamp
        state = .changed
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) {
        super.touchesEnded(touches, with: event)
        if let touch = touches.first { holdDuration = touch.timestamp - startStamp }
        state = .ended
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) {
        super.touchesCancelled(touches, with: event)
        state = .cancelled
    }
}

/// Слой-носитель жеста: кладётся `.overlay`-ем на SwiftUI-кнопку микрофона. Сама кнопка
/// остаётся SwiftUI — сюда вынесена только работа с касанием.
struct VoiceHoldGesture: UIViewRepresentable {

    /// Палец опустился на кнопку.
    let onBegan: () -> Void
    /// Палец поехал: смещение от точки нажатия и скорость.
    let onChanged: (CGSize, CGSize) -> Void
    /// Палец отпустили: смещение и сколько длилось удержание.
    let onEnded: (CGSize, TimeInterval) -> Void
    /// Касание отобрала система (звонок, уход вью из иерархии).
    let onCancelled: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(owner: self) }

    func makeUIView(context: Context) -> UIView {
        let view = UIView()
        view.backgroundColor = .clear
        // Для VoiceOver слоя не существует: озвучивает и активирует кнопку SwiftUI-обёртка.
        view.isAccessibilityElement = false
        let recognizer = VoiceHoldRecognizer(
            target: context.coordinator,
            action: #selector(Coordinator.handle(_:))
        )
        recognizer.delegate = context.coordinator
        view.addGestureRecognizer(recognizer)
        return view
    }

    func updateUIView(_ view: UIView, context: Context) {
        // Замыкания держат текущее состояние вью — обновляем их на каждой перерисовке.
        context.coordinator.owner = self
    }

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {

        var owner: VoiceHoldGesture

        init(owner: VoiceHoldGesture) {
            self.owner = owner
        }

        @objc func handle(_ recognizer: VoiceHoldRecognizer) {
            switch recognizer.state {
            case .began:
                owner.onBegan()
            case .changed:
                owner.onChanged(recognizer.offset, recognizer.speed)
            case .ended:
                owner.onEnded(recognizer.offset, recognizer.holdDuration)
            case .cancelled, .failed:
                owner.onCancelled()
            default:
                break
            }
        }

        /// Живём рядом с чужими жестами (свайп-назад висит на вью всего экрана), а не
        /// вместо них: запрет привёл бы к тому, что один из двух молча не начинается.
        func gestureRecognizer(
            _ gestureRecognizer: UIGestureRecognizer,
            shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer
        ) -> Bool {
            true
        }
    }
}
