import Foundation
import Combine
import UIKit

// Одни часы на всё приложение для карточек бота (SPEC.md §10.3, SPEC-share §2.7 п. 3–4).
//
// Сервер раз в секунду ничего не шлёт: всё, что зависит от времени, клиент считает сам от
// данных карточки. Поэтому:
//  - тикеров ровно два — секундный (таймер обещания) и минутный («ждём ещё 28 мин»), а не
//    таймер на карточку; тик выровнен по границе секунды/минуты, и каждый тик пересчитывает
//    видимые карточки от `deadlineAt − now` (не уменьшает счётчик — нет дрейфа, после сна и
//    фона сразу верно);
//  - тикают только карточки на экране: вью подписывается в onAppear и отписывается в
//    onDisappear; нет подписчиков или приложение в фоне — тикер стоит;
//  - «сейчас» поправлено на смещение часов сервера: `serverNow` из ответов и событий, медиана
//    трёх последних замеров, применяется только при |смещение| > 2 с.

@MainActor
final class CardTicker: ObservableObject {
    /// «Сейчас» по часам сервера на момент последнего тика.
    @Published private(set) var now: Date

    let period: TimeInterval
    private let clock: CardClock
    private var subscribers: Set<String> = []
    private var timer: Timer?

    init(period: TimeInterval, clock: CardClock) {
        self.period = period
        self.clock = clock
        self.now = clock.now()
    }

    var isRunning: Bool { timer != nil }
    /// Когда следующий тик (для проверки выравнивания по границе).
    var nextFireDate: Date? { timer?.fireDate }
    var subscriberCount: Int { subscribers.count }

    func subscribe(_ token: String) {
        let first = subscribers.isEmpty
        subscribers.insert(token)
        if first {
            // Карточка появилась — сразу верное «сейчас», а не то, что было при прошлом тике.
            tick()
        }
    }

    func unsubscribe(_ token: String) {
        subscribers.remove(token)
        if subscribers.isEmpty { stop() }
    }

    /// Перерасчёт немедленно (вернулись из фона, пришло новое смещение часов).
    func refresh() {
        guard !subscribers.isEmpty else { return }
        tick()
    }

    func stop() {
        timer?.invalidate()
        timer = nil
    }

    fileprivate func tick() {
        timer?.invalidate()
        timer = nil
        now = clock.now()
        guard !subscribers.isEmpty, clock.isForeground else { return }
        // Следующий тик — на границе периода (+5 мс, чтобы точно оказаться ПОСЛЕ неё).
        let t = now.timeIntervalSince1970
        let delay = period - t.truncatingRemainder(dividingBy: period) + 0.005
        let timer = Timer(timeInterval: delay, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated { self?.tick() }
        }
        // .common — иначе таймер замирает, пока палец листает ленту (режим отслеживания).
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }
}

@MainActor
final class CardClock {
    static let shared = CardClock()

    /// Сколько последних замеров `serverNow` держим и с какого смещения начинаем верить.
    static let samplesKept = 3
    static let skewThreshold: TimeInterval = 2

    /// Смещение часов сервера относительно телефона, уже с порогом (0 — не применяем).
    private(set) var skew: TimeInterval = 0
    private var samples: [TimeInterval] = []
    private let localNow: () -> Date
    private(set) var isForeground = true

    private(set) lazy var seconds = CardTicker(period: 1, clock: self)
    private(set) lazy var minutes = CardTicker(period: 60, clock: self)
    private var cancellables: Set<AnyCancellable> = []

    /// `localNow` и `foreground` подменяют только тесты.
    init(localNow: @escaping () -> Date = Date.init, foreground: AnyPublisher<Bool, Never>? = nil) {
        self.localNow = localNow
        let source: AnyPublisher<Bool, Never>
        if let foreground {
            source = foreground
        } else {
            // AppLifecycle узнаёт о переднем плане только из уведомлений: созданный позже них, он
            // начинает с false. Поэтому стартовое значение — у самого приложения, а от
            // AppLifecycle берём только перемены.
            isForeground = UIApplication.shared.applicationState != .background
            source = AppLifecycle.shared.$isForeground.dropFirst().eraseToAnyPublisher()
        }
        source
            .removeDuplicates()
            .receive(on: DispatchQueue.main)
            .sink { [weak self] active in self?.setForeground(active) }
            .store(in: &cancellables)
    }

    /// «Сейчас» по часам сервера.
    func now() -> Date { localNow().addingTimeInterval(skew) }

    /// Замер часов сервера: `serverNow` из ответа или события, полученного только что.
    func noteServerNow(_ serverNow: Date?, receivedAt: Date? = nil) {
        guard let serverNow else { return }
        let sample = serverNow.timeIntervalSince(receivedAt ?? localNow())
        samples.append(sample)
        if samples.count > Self.samplesKept { samples.removeFirst(samples.count - Self.samplesKept) }
        let sorted = samples.sorted()
        let median = sorted.count % 2 == 1
            ? sorted[sorted.count / 2]
            : (sorted[sorted.count / 2 - 1] + sorted[sorted.count / 2]) / 2
        let next = abs(median) > Self.skewThreshold ? median : 0
        guard next != skew else { return }
        skew = next
        seconds.refresh()
        minutes.refresh()
    }

    func setForeground(_ active: Bool) {
        isForeground = active
        if active {
            // Вернулись — сразу верные цифры и новый отсчёт до границы.
            seconds.refresh()
            minutes.refresh()
        } else {
            seconds.stop()
            minutes.stop()
        }
    }

    /// Выход из аккаунта: замеры принадлежали прошлой сессии сервера.
    func reset() {
        samples.removeAll()
        skew = 0
    }
}
