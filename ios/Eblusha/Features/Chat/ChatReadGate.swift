import Foundation
import Combine

/// «Прочитано» (облачное `mark-conversation-read` и сигнал секретки) — только пока беседа РЕАЛЬНО
/// на экране: экран беседы показан, приложение на переднем плане и беседу не закрывает
/// полноэкранный звонок.
///
/// Зачем жёстко: с read-sync сервер на каждое «прочитано» гасит уведомления этой беседы на ВСЕХ
/// устройствах человека (Android, ПК, другой айфон — сокетом, FCM и APNs). А вью-модель беседы
/// живёт и тогда, когда её не видно: звонок держит сокет в фоне, экран лежит под оверлеем звонка,
/// снятый с экрана чат ещё доживает последние задачи. Раньше любое входящее в такой чат сразу
/// квитировалось — и уведомление о нём гасло везде через долю секунды, хотя человек его не видел.
/// Android (CloudReadGate: экран RESUMED) и ПК (окно на виду) делают так же.
///
/// Правило: стала видна — отметить сейчас (сервер квитирует беседу целиком, то есть всё, что
/// пришло, пока не смотрели); новое входящее — только пока видна. Не потокобезопасна: главный поток.
struct ChatReadGate {
    /// Экран беседы показан (onAppear … onDisappear).
    private(set) var screenShown = false
    /// Приложение на переднем плане (AppLifecycle.isForeground: шторка и Пункт управления его не
    /// снимают — переписка под ними остаётся на экране).
    private(set) var appForeground: Bool
    /// Поверх всего приложения развёрнут экран звонка (входящий, дозвон, разговор). Свёрнутая
    /// плитка беседу не закрывает.
    private(set) var coveredByCall = false

    init(appForeground: Bool) {
        self.appForeground = appForeground
    }

    var visible: Bool { screenShown && appForeground && !coveredByCall }

    /// Обновить признаки. Возвращает true, если беседа ТОЛЬКО ЧТО стала видна — пора отметить её
    /// прочитанной.
    @discardableResult
    mutating func update(screenShown: Bool? = nil, appForeground: Bool? = nil, coveredByCall: Bool? = nil) -> Bool {
        let was = visible
        if let screenShown { self.screenShown = screenShown }
        if let appForeground { self.appForeground = appForeground }
        if let coveredByCall { self.coveredByCall = coveredByCall }
        return visible && !was
    }

    /// Оверлей звонка закрывает экран целиком, пока звонок идёт и не свёрнут в плитку
    /// (то же условие, по которому CallOverlay рисует полноэкранный CallScreenContainer).
    static func callCovers(phase: CallPhase, minimized: Bool) -> Bool {
        phase != .idle && !minimized
    }

    /// «Экран звонка закрывает беседу» живьём — для подписки вью-модели беседы.
    static func callCoverPublisher(_ manager: CallManager) -> AnyPublisher<Bool, Never> {
        manager.$phase
            .combineLatest(manager.$minimized)
            .map { callCovers(phase: $0, minimized: $1) }
            .eraseToAnyPublisher()
    }
}
