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
                } else if scenario.hasPrefix("header") {
                    // Стенд шапки беседы со строкой местного времени собеседника.
                    ChatHeaderDemo(scenarioId: scenario)
                } else if scenario.hasPrefix("mute") {
                    // Стенд «Без звука»: список с заглушёнными беседами, меню, свайп, плашка.
                    MuteDemo(scenarioId: scenario)
                } else if scenario.hasPrefix("bot") {
                    // Стенд бота «Еблуша»: пузыри, «Уточнить», карточка карты, режим «Спросить».
                    BotChatDemo(scenarioId: scenario)
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
