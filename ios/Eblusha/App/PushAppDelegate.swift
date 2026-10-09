import UIKit

/// UIApplicationDelegate для пушей — встраивается в SwiftUI-приложение через
/// `@UIApplicationDelegateAdaptor(PushAppDelegate.self)` в EblushaApp (правка
/// описана в integration_notes; сам EblushaApp.swift — общий файл).
///
/// Роль Android-эквивалентов: Application.onCreate (ранняя инициализация Firebase
/// из PushTokens.ensureFirebase) + FirebaseMessagingService.onNewToken.
final class PushAppDelegate: NSObject, UIApplicationDelegate {

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        // Сессию поднимаем ПЕРВОЙ строкой: когда процесс стартует по VoIP-пушу, SwiftUI-
        // сцены ещё нет, и warmup() из RootView не выполнится — без него у сетевого слоя
        // нет токена, сокет не подключится, и принятый звонок умрёт на пустом месте.
        AppContainer.shared.warmup()
        // Дисковый кэш картинок: по умолчанию URLCache крошечный, и переписка с фото
        // перекачивалась бы целиком после каждого запуска.
        ImageLoader.configureDiskCache()
        // Порядок неслучаен и откладывать нельзя (порт комментария ensureFirebase):
        // когда процесс поднят ПО VoIP-ПУШУ, PKPushRegistry обязан существовать с
        // делегатом до конца didFinishLaunching — иначе пуш потерян, звонок не
        // репортован, и iOS убивает приложение.
        MessageNotifications.shared.activate()
        VoIPPushHandler.shared.start()
        CallKitController.shared.activate()
        return true
    }

    // MARK: - Alert-токен (remote notifications)

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        PushRepository.shared.updateAlertToken(deviceToken)
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        // Симулятор / нет сети до APNs — не ошибка приложения: доставку онлайн-клиенту
        // по-прежнему везёт сокет (та же «мягкость», что у прошивок без Google-сервисов).
        NSLog("PushAppDelegate: alert-токен не выдан: %@", String(describing: error))
    }

    // MARK: - Тихий background-пуш (call-cancel, read на alert-токен)

    /// Тихие пуши на alert-токен БЕЗ баннера (content-available=1, см. src/push/apns.ts):
    ///  - call-cancel — молча убрать экран входящего;
    ///  - read — беседу прочитали на ДРУГОМ устройстве: снять её баннеры из Центра
    ///    уведомлений. Окно фонового пуша короткое, поэтому completionHandler зовём сразу,
    ///    как только баннеры сняты (getDeliveredNotifications отвечает за миллисекунды).
    func application(
        _ application: UIApplication,
        didReceiveRemoteNotification userInfo: [AnyHashable: Any],
        fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void
    ) {
        if let read = ReadPush.parse(userInfo) {
            MessageNotifications.shared.clearDelivered(
                conversationId: read.conversationId, deliveredBefore: read.deliveredUpTo
            ) { removed in
                NSLog("PushAppDelegate: read-пуш, снято баннеров: %d", removed)
                DispatchQueue.main.async { completionHandler(.newData) }
            }
            return
        }
        if userInfo["kind"] as? String == "call-cancel" {
            CallKitController.shared.reportRemoteEnded(
                conversationId: userInfo["conversationId"] as? String
            )
        }
        completionHandler(.noData)
    }
}
