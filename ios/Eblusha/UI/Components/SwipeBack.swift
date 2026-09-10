import SwiftUI
import UIKit

/// Возврат назад свайпом от края экрана — от левого и от правого.
///
/// Экраны приложения прячут системную панель навигации ради собственных шапок, а вместе
/// с ней iOS отключает штатный жест «назад»: выйти из чата можно было только попав
/// пальцем в маленький шеврон в углу. Полагаться на возврат системного распознавателя
/// оказалось ненадёжно, поэтому вешаем свои краевые жесты — они срабатывают только у
/// самой кромки и прокрутке ленты не мешают.
///
/// Правый край добавлен намеренно: на большом телефоне дотянуться до левого края одной
/// рукой неудобно.
private struct EdgeSwipeBack: UIViewRepresentable {

    let onBack: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onBack: onBack) }

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
    }

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {

        var onBack: () -> Void
        /// Жест уже сработал в этом проходе — второй раз не закрываем.
        private var fired = false
        private weak var attached: UIView?

        init(onBack: @escaping () -> Void) {
            self.onBack = onBack
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
            for edge in [UIRectEdge.left, UIRectEdge.right] {
                let recognizer = UIScreenEdgePanGestureRecognizer(
                    target: self, action: #selector(handle(_:))
                )
                recognizer.edges = edge
                recognizer.delegate = self
                recognizer.name = Self.marker
                host.addGestureRecognizer(recognizer)
            }
        }

        @objc private func handle(_ recognizer: UIScreenEdgePanGestureRecognizer) {
            switch recognizer.state {
            case .began:
                fired = false
            case .changed:
                guard !fired else { return }
                let dx = recognizer.translation(in: recognizer.view).x
                // Порог как у системного «назад»: короткое касание края не считается.
                let pulled = recognizer.edges == .left ? dx : -dx
                if pulled > 60 {
                    fired = true
                    onBack()
                }
            default:
                fired = false
            }
        }

        /// Жест живёт рядом с прокруткой: у кромки выигрывает он, дальше — лента.
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
    /// Возврат назад свайпом от левого или правого края экрана.
    func edgeSwipeBack(_ onBack: @escaping () -> Void) -> some View {
        background(EdgeSwipeBack(onBack: onBack).frame(width: 0, height: 0))
    }

    /// Прежнее имя оставлено, чтобы не править вызовы: системный жест возвращать
    /// бесполезно при скрытой панели, поэтому здесь тот же краевой свайп.
    func enableSwipeBack() -> some View { self }
}
