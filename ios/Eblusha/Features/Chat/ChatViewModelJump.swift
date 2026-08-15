import Foundation

// Порт `loadUntil` из `feature/chat/ChatViewModel.kt` (~740-760) — переход к цитате.
//
// Extension живёт в ОТДЕЛЬНОМ файле, поэтому private-члены ChatViewModel ему не видны:
// loadingOlderFlag / claimOlder() / fetchOlderPage() должны стать internal (см.
// integration_notes — точечная правка видимости в ChatViewModel.swift).

extension ChatViewModel {

    /// Листает историю назад, пока messageId не окажется в загруженном списке.
    /// Нужен для перехода к цитате: у сервера нет запроса «окно вокруг сообщения»,
    /// только курсор назад, так что единственный путь — тянуть страницы, пока не дойдём
    /// до нужной. Возвращает false, если история кончилась или сеть подвела.
    func loadUntil(messageId: String, maxPages: Int = 20) async -> Bool {
        for _ in 0..<maxPages {
            if ui.messages.contains(where: { $0.id == messageId }) { return true }
            // Фоновая подгрузка (скролл у верха) могла уже стартовать — дождёмся её,
            // а не бросаем поиск.
            var waited = 0
            while loadingOlderFlag && waited < 60 {
                try? await Task.sleep(for: .milliseconds(100))
                waited += 1
            }
            if ui.messages.contains(where: { $0.id == messageId }) { return true }
            if !claimOlder() { return false }
            if !(await fetchOlderPage()) { return false }
        }
        return ui.messages.contains(where: { $0.id == messageId })
    }
}
