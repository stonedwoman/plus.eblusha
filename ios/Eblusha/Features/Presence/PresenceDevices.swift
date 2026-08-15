import Foundation
import Combine

/// Порт `feature/presence/PresenceDevices.kt`.
///
/// С какого устройства человек сейчас в сети: телефон, ПК-клиент или браузер.
/// Хранилище общее и плоское намеренно: точку присутствия рисуют пять независимых
/// экранов, и трое из них знают о собеседнике только «онлайн: да/нет». Тащить новое
/// поле через пять слоёв DTO ради иконки — дороже, чем одна карта, которую пишет
/// realtime-слой и читает кто угодно.
final class PresenceDevices: ObservableObject {
    static let shared = PresenceDevices()

    /// userId → "mobile" | "desktop" | "web"
    @Published private(set) var devices: [String: String] = [:]

    private static func normalize(_ device: String?) -> String? {
        guard let lowered = device?.lowercased(),
              ["mobile", "desktop", "web"].contains(lowered) else { return nil }
        return lowered
    }

    func update(userId: String, device: String?) {
        onMain {
            if let normalized = Self.normalize(device) {
                if self.devices[userId] != normalized { self.devices[userId] = normalized }
            } else if self.devices[userId] != nil {
                self.devices.removeValue(forKey: userId)
            }
        }
    }

    func updateAll(_ items: [(userId: String, device: String?)]) {
        guard !items.isEmpty else { return }
        onMain {
            var next = self.devices
            for (userId, device) in items {
                if let normalized = Self.normalize(device) {
                    next[userId] = normalized
                } else {
                    next.removeValue(forKey: userId)
                }
            }
            if next != self.devices { self.devices = next }
        }
    }

    func clear() {
        onMain {
            if !self.devices.isEmpty { self.devices = [:] }
        }
    }

    private func onMain(_ body: @escaping () -> Void) {
        if Thread.isMainThread { body() } else { DispatchQueue.main.async(execute: body) }
    }
}
