import SwiftUI
import UIKit

/// Возврат свайпом от левого края экрана.
///
/// Все экраны приложения прячут системную панель навигации (`.toolbar(.hidden, ...)`)
/// ради собственных шапок, а вместе с ней iOS отключает и жест «назад»: выйти из чата
/// можно было только попав пальцем в маленький шеврон в углу. Здесь мы возвращаем жест
/// на место, снимая делегата с системного распознавателя — стандартный приём, другого
/// способа у SwiftUI нет.
private struct SwipeBackEnabler: UIViewControllerRepresentable {

    func makeUIViewController(context: Context) -> UIViewController {
        Enabler()
    }

    func updateUIViewController(_ controller: UIViewController, context: Context) {}

    private final class Enabler: UIViewController {
        override func didMove(toParent parent: UIViewController?) {
            super.didMove(toParent: parent)
            enable()
        }

        override func viewDidAppear(_ animated: Bool) {
            super.viewDidAppear(animated)
            enable()
        }

        private func enable() {
            guard let recognizer = navigationController?.interactivePopGestureRecognizer else { return }
            // Делегат по умолчанию запрещает жест при скрытой панели навигации.
            // Снимаем его — тогда работает штатный «назад» с краю.
            recognizer.delegate = nil
            recognizer.isEnabled = true
        }
    }
}

extension View {
    /// Вернуть жест «назад» экрану со скрытой системной панелью навигации.
    func enableSwipeBack() -> some View {
        background(SwipeBackEnabler().frame(width: 0, height: 0))
    }
}
