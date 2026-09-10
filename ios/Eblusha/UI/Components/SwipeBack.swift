import SwiftUI
import UIKit

/// Возврат назад свайпом вправо из ЛЮБОЙ точки экрана — как в Telegram.
///
/// Штатный жест iOS живёт только у левой кромки, и его надо знать и целиться. Поэтому
/// свой жест берётся за дело при явно горизонтальном движении вправо где угодно, а
/// вертикальную прокрутку не трогает. Кромку он уступает системе: с родной панелью
/// навигации там работает интерактивный возврат, и два жеста разом дёргали бы стек.
/// На входящих пузырях чата свайп вправо — ответ на сообщение, туда жест не лезет
/// (см. `shouldBegin`).
private struct EdgeSwipeBack: UIViewRepresentable {

    let onBack: () -> Void
    /// Можно ли начинать жест из этой точки окна. Чат отвечает «нет» на входящих
    /// пузырях: там свайп вправо — ответ на сообщение.
    let shouldBegin: ((CGPoint) -> Bool)?

    func makeCoordinator() -> Coordinator { Coordinator(onBack: onBack, shouldBegin: shouldBegin) }

    func makeUIView(context: Context) -> UIView {
        let view = AttachView()
        view.isUserInteractionEnabled = false
        view.onAttach = { [weak coordinator = context.coordinator] host in
            coordinator?.attach(to: host)
        }
        return view
    }

    func updateUIView(_ view: UIView, context: Context) {
        context.coordinator.onBack = onBack
        context.coordinator.shouldBegin = shouldBegin
    }

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {

        var onBack: () -> Void
        var shouldBegin: ((CGPoint) -> Bool)?
        /// Жест уже сработал в этом проходе — второй раз не закрываем.
        private var fired = false
        private weak var attached: UIView?

        init(onBack: @escaping () -> Void, shouldBegin: ((CGPoint) -> Bool)?) {
            self.onBack = onBack
            self.shouldBegin = shouldBegin
        }

        private static let marker = "eb.edge-back"

        func attach(to host: UIView) {
            guard attached !== host else { return }
            attached = host
            // Вью контроллера может переиспользоваться при повторном заходе на экран —
            // снимаем свои прежние жесты, иначе «назад» сработало бы дважды.
            for existing in host.gestureRecognizers ?? [] where existing.name == Self.marker {
                host.removeGestureRecognizer(existing)
            }
            let recognizer = UIPanGestureRecognizer(target: self, action: #selector(handle(_:)))
            recognizer.delegate = self
            recognizer.name = Self.marker
            host.addGestureRecognizer(recognizer)
        }

        @objc private func handle(_ recognizer: UIPanGestureRecognizer) {
            switch recognizer.state {
            case .began:
                fired = false
            case .changed:
                guard !fired else { return }
                let translation = recognizer.translation(in: recognizer.view)
                // Порог заметно больше случайного дрожания пальца: короткий сдвиг при
                // прокрутке или при свайпе-ответе назад не уводит.
                if translation.x > 90, abs(translation.y) < translation.x {
                    fired = true
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                    onBack()
                }
            default:
                fired = false
            }
        }

        /// Берёмся за дело только при движении ВПРАВО и явно горизонтальном. Вертикальное
        /// движение целиком остаётся прокрутке, движение влево — свайпу-ответу.
        func gestureRecognizerShouldBegin(_ recognizer: UIGestureRecognizer) -> Bool {
            guard let pan = recognizer as? UIPanGestureRecognizer else { return true }
            let velocity = pan.velocity(in: pan.view)
            guard velocity.x > 0, velocity.x > abs(velocity.y) * 1.5 else { return false }
            guard let window = pan.view?.window else { return true }
            let point = pan.location(in: window)
            // Полоса у кромки — территория системного интерактивного «назад».
            if point.x < 24 { return false }
            return shouldBegin?(point) ?? true
        }

        /// Живём рядом с прокруткой и жестами внутри, а не вместо них.
        func gestureRecognizer(
            _ gestureRecognizer: UIGestureRecognizer,
            shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer
        ) -> Bool {
            true
        }
    }

    /// Невидимая вью: нужна только чтобы добраться до вью экрана и повесить жесты на неё.
    private final class AttachView: UIView {
        var onAttach: ((UIView) -> Void)?

        override func didMoveToWindow() {
            super.didMoveToWindow()
            guard window != nil else { return }
            // Поднимаемся до вью контроллера экрана: жест должен видеть касания по всей
            // площади, иначе краевой свайп по ленте до него не дойдёт.
            var candidate: UIView? = self
            while let current = candidate, current.next is UIView { candidate = current.superview }
            if let host = viewController?.view ?? candidate {
                onAttach?(host)
            }
        }

        private var viewController: UIViewController? {
            var responder: UIResponder? = self
            while let current = responder {
                if let controller = current as? UIViewController { return controller }
                responder = current.next
            }
            return nil
        }
    }
}

extension View {
    /// Возврат назад свайпом вправо из любой точки экрана. Имя оставлено прежним, чтобы
    /// не править вызовы.
    func edgeSwipeBack(
        shouldBegin: ((CGPoint) -> Bool)? = nil, _ onBack: @escaping () -> Void
    ) -> some View {
        background(EdgeSwipeBack(onBack: onBack, shouldBegin: shouldBegin).frame(width: 0, height: 0))
    }

    /// Прежнее имя оставлено, чтобы не править вызовы: системный жест возвращать
    /// бесполезно при скрытой панели, поэтому здесь тот же краевой свайп.
    func enableSwipeBack() -> some View { self }
}
