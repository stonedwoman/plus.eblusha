import SwiftUI

@main
struct EblushaApp: App {
    // Токены APNs выдаёт UIApplicationDelegate — SwiftUI-сцена их не видит.
    @UIApplicationDelegateAdaptor(PushAppDelegate.self) private var pushDelegate

    var body: some Scene {
        WindowGroup {
            #if DEBUG
            // Стенды экрана установления звонка и миниатюры (аргумент -connectDemo) — только в отладке.
            if let scenario = CallConnectingDemo.requestedScenario {
                if scenario.hasPrefix("mini") {
                    CallMiniDemo(scenarioId: scenario)
                } else {
                    CallConnectingDemo(scenarioId: scenario)
                }
            } else {
                RootView()
            }
            #else
            RootView()
            #endif
        }
    }
}
