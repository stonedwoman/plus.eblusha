import SwiftUI

@main
struct EblushaApp: App {
    // Токены APNs выдаёт UIApplicationDelegate — SwiftUI-сцена их не видит.
    @UIApplicationDelegateAdaptor(PushAppDelegate.self) private var pushDelegate

    var body: some Scene {
        WindowGroup {
            #if DEBUG
            // Стенд экрана установления звонка (аргумент -connectDemo) — только в отладке.
            if let scenario = CallConnectingDemo.requestedScenario {
                CallConnectingDemo(scenarioId: scenario)
            } else {
                RootView()
            }
            #else
            RootView()
            #endif
        }
    }
}
