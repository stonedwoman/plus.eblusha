import Foundation
import PushKit

/// Приёмник VoIP-пушей (PushKit) — iOS-аналог FCM-сервиса звонков на Android.
///
/// Сервер шлёт на topic `<bundle>.voip` весь PushPayload как есть (src/push/apns.ts):
/// {kind: "call", conversationId, callerId, callerName, video} либо
/// {kind: "call-cancel", conversationId}. Wire-формат — байт-в-байт с src/push/types.ts.
///
/// ЖЕЛЕЗНОЕ ПРАВИЛО iOS 13+: каждый VoIP-пуш обязан НЕМЕДЛЕННО породить
/// reportNewIncomingCall (или закрыть уже репортованный звонок) — приложение,
/// «съевшее» пуш без CallKit-репорта, система убивает и перестаёт будить вовсе.
/// Поэтому CallKit — ПЕРВЫМ действием, всё остальное (состояние CallManager,
/// подключение сокета) — после.
final class VoIPPushHandler: NSObject, PKPushRegistryDelegate {

    static let shared = VoIPPushHandler()

    private var registry: PKPushRegistry?

    /// Зовётся из PushAppDelegate ДО конца didFinishLaunching: когда процесс поднят
    /// ПО ПУШУ, PKPushRegistry без делегата к моменту доставки теряет пуш — та же
    /// причина, по которой Android инициализирует Firebase в Application.onCreate
    /// (см. комментарий в PushTokens.kt).
    func start() {
        guard registry == nil else { return }
        let r = PKPushRegistry(queue: .main)
        r.delegate = self
        r.desiredPushTypes = [.voIP]
        registry = r
    }

    // MARK: - PKPushRegistryDelegate

    func pushRegistry(
        _ registry: PKPushRegistry,
        didUpdate pushCredentials: PKPushCredentials,
        for type: PKPushType
    ) {
        guard type == .voIP else { return }
        PushRepository.shared.updateVoipToken(pushCredentials.token)
    }

    func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {
        guard type == .voIP else { return }
        PushRepository.shared.invalidateVoipToken()
    }

    func pushRegistry(
        _ registry: PKPushRegistry,
        didReceiveIncomingPushWith payload: PKPushPayload,
        for type: PKPushType,
        completion: @escaping () -> Void
    ) {
        guard type == .voIP else {
            completion()
            return
        }
        let dict = payload.dictionaryPayload
        let kind = dict["kind"] as? String
        let conversationId = dict["conversationId"] as? String

        if kind == "call", let conversationId {
            let callerName = (dict["callerName"] as? String)
                .flatMap { $0.isEmpty ? nil : $0 } ?? "Входящий звонок"
            let video = Self.boolValue(dict["video"])

            // Сессия могла не подняться: процесс мог стартовать этим самым пушем.
            AppContainer.shared.warmup()

            // Вышли из аккаунта, а DELETE токена не дошёл (не было сети): у APNs, в отличие
            // от FCM, нет deleteToken, и сервер продолжает будить телефон звонками ЧУЖОГО
            // аккаунта. Показывать их нельзя, но перед PushKit отчитаться обязаны.
            guard AppContainer.shared.sessionStore.currentRefreshToken() != nil else {
                CallKitController.shared.reportPhantomAndEnd(completion: completion)
                return
            }

            let manager = AppContainer.shared.callManager
            if manager.phase != .idle {
                if manager.phase == .incoming, manager.conversationId == conversationId {
                    // Сокет опередил пуш: тот же звонок уже показан приложением и доложен
                    // CallKit из onPhaseChange — докладываем тем же UUID, без фантома.
                    CallKitController.shared.reportIncomingCall(
                        conversationId: conversationId,
                        callerName: callerName,
                        video: video,
                        completion: completion
                    )
                } else {
                    // Другой звонок уже идёт — второй экран не нужен, а системная «отклонить»
                    // положила бы трубку живому разговору. Отчитываемся фантомом.
                    CallKitController.shared.reportPhantomAndEnd(completion: completion)
                }
                DispatchQueue.main.async { AppContainer.shared.realtimeClient.connect() }
                return
            }

            // 1) Посеять состояние CallManager — синхронно, мы на main: кнопка «Принять»
            //    (CXAnswerCallAction) уходит в acceptIncoming, а тот молча выходит, если
            //    фаза не incoming; completion репорта ниже сверяется с этой фазой.
            //    Наблюдатель фазы в CallKitController сработает уже после репорта (async)
            //    и увидит выставленный callUUID — второго репорта не будет.
            manager.onPushIncoming(
                conversationId: conversationId,
                callerName: callerName,
                video: video,
                avatarUrl: nil
            )
            // 2) ОБЯЗАТЕЛЬНЫЙ немедленный CallKit-репорт (см. шапку файла) — в том же
            //    проходе run loop, что и этот делегат.
            CallKitController.shared.reportIncomingCall(
                conversationId: conversationId,
                callerName: callerName,
                video: video,
                completion: completion
            )
            DispatchQueue.main.async {
                // 3) Догнать сигналинг: приложение могло быть выгружено, и только живой
                //    сокет принесёт call:ended/accepted и повезёт наш call:accept.
                AppContainer.shared.realtimeClient.connect()
            }
            return
        }

        if kind == "call-cancel" {
            AppContainer.shared.warmup()
            // Закрыть системный звонок (или отчитаться фантомом — правило пуш=репорт).
            CallKitController.shared.handleCancelPush(conversationId: conversationId, completion: completion)
            DispatchQueue.main.async {
                // Экран входящего внутри приложения гасим тоже: сокет мог ещё не
                // подняться, а честного call:ended без него не будет. Гасим БЕЗ сигнала
                // серверу (dismissIncoming): звонок он уже снял сам, потому и прислал
                // отбой. Отложенный call:decline в очереди RealtimeClient был бы отправлен
                // при подключении — и убил бы НОВЫЙ звонок, если звонящий успел перезвонить.
                let manager = AppContainer.shared.callManager
                if manager.phase == .incoming,
                   conversationId == nil || manager.conversationId == conversationId {
                    manager.dismissIncoming()
                }
                AppContainer.shared.realtimeClient.connect()
            }
            return
        }

        // Неизвестный payload — всё равно обязаны отчитаться перед CallKit.
        NSLog("VoIPPushHandler: неизвестный voip-пуш kind=%@", kind ?? "nil")
        CallKitController.shared.reportPhantomAndEnd(completion: completion)
    }

    /// `video` в JSON — честный Bool, но FCM-путь на Android возил строки; принимаем оба.
    private static func boolValue(_ raw: Any?) -> Bool {
        if let b = raw as? Bool { return b }
        if let n = raw as? NSNumber { return n.boolValue }
        if let s = raw as? String { return s == "true" || s == "1" }
        return false
    }
}
