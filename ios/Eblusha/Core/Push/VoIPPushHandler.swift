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

            // Звонок уже идёт или уже показан приложением по сокету — второй экран не
            // нужен: два UI одновременно, и системная «отклонить» положила бы трубку
            // живому разговору. Перед PushKit всё равно обязаны отчитаться — гасим фантом.
            let manager = AppContainer.shared.callManager
            if manager.phase != .idle {
                CallKitController.shared.reportPhantomAndEnd(completion: completion)
                DispatchQueue.main.async { AppContainer.shared.realtimeClient.connect() }
                return
            }

            // 1) ОБЯЗАТЕЛЬНЫЙ немедленный CallKit-репорт (см. шапку файла).
            CallKitController.shared.reportIncomingCall(
                conversationId: conversationId,
                callerName: callerName,
                video: video,
                completion: completion
            )
            DispatchQueue.main.async {
                // 2) Посеять состояние CallManager: кнопка «Принять» (CXAnswerCallAction)
                //    уходит в acceptIncoming, а тот молча выходит, если фаза не incoming.
                //    Повтор безопасен: настоящий call:incoming из сокета отсеется по не-idle.
                AppContainer.shared.callManager.onPushIncoming(
                    conversationId: conversationId,
                    callerName: callerName,
                    video: video,
                    avatarUrl: nil
                )
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
                // подняться, а честного call:ended без него не будет. declineIncoming
                // эмитит decline в уже завершённый звонок — на сервере это no-op,
                // зато рингер/экран умирают гарантированно.
                let manager = AppContainer.shared.callManager
                if manager.phase == .incoming,
                   conversationId == nil || manager.conversationId == conversationId {
                    manager.declineIncoming()
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
