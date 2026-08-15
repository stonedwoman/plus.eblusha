import Foundation
import Combine
import UIKit

/// Порт `core/app/AppLifecycle.kt`: общий флаг «приложение на переднем плане»
/// плюс одноразовый запрос «открой эту беседу» (тап по уведомлению).
///
/// В Android флаг двигает ProcessLifecycleOwner; здесь — системные уведомления
/// UIApplication. По флагу решаем, показывать ли уведомление о сообщении (не
/// уведомляем о том, что пришло, пока человек в приложении) и что докладывать
/// в presence:state.
final class AppLifecycle: ObservableObject {
    static let shared = AppLifecycle()

    @Published private(set) var isForeground = false

    struct OpenTarget: Equatable {
        let conversationId: String
        let title: String
    }

    @Published private(set) var pendingOpen: OpenTarget?

    private var observers: [NSObjectProtocol] = []

    private init() {
        let center = NotificationCenter.default
        observers.append(center.addObserver(
            forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main
        ) { [weak self] _ in self?.isForeground = true })
        observers.append(center.addObserver(
            forName: UIApplication.willResignActiveNotification, object: nil, queue: .main
        ) { [weak self] _ in self?.isForeground = false })
    }

    /// Из тапа по уведомлению; потребляется навигацией для перехода в беседу.
    func requestOpenConversation(conversationId: String, title: String) {
        pendingOpen = OpenTarget(conversationId: conversationId, title: title)
    }

    func consumePendingOpen() {
        pendingOpen = nil
    }
}
