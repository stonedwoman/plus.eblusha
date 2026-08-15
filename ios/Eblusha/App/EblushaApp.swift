import SwiftUI

@main
struct EblushaApp: App {
    // Токены APNs выдаёт UIApplicationDelegate — SwiftUI-сцена их не видит.
    @UIApplicationDelegateAdaptor(PushAppDelegate.self) private var pushDelegate

    var body: some Scene {
        WindowGroup {
            RootView()
        }
    }
}
