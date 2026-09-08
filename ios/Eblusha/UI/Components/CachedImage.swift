import SwiftUI
import UIKit

/// Кэш картинок ленты. Заменяет `AsyncImage`, у которого нет ни памяти, ни дедупликации:
/// он заново качает картинку КАЖДЫЙ раз, когда ячейка возвращается на экран, и рисует
/// заглушку до конца загрузки. В LazyVStack это означает, что при прокрутке назад высота
/// ячеек скачет туда-сюда, а лента дёргается под пальцем.
///
/// Здесь три уровня: горячая память (декодированные UIImage), общий URLCache на диске
/// (переживает перезапуск) и дедупликация одновременных запросов одного url.
actor ImageLoader {

    static let shared = ImageLoader()

    /// Декодированные картинки. NSCache сам вытесняет по давлению памяти — считаем
    /// «стоимость» в байтах, иначе лимит по числу объектов ничего не значит.
    private let memory: NSCache<NSURL, UIImage> = {
        let cache = NSCache<NSURL, UIImage>()
        cache.totalCostLimit = 96 * 1024 * 1024
        return cache
    }()

    /// Уже идущие загрузки: десять ячеек с одним аватаром дают один запрос, а не десять.
    private var inFlight: [URL: Task<UIImage?, Never>] = [:]

    /// Синхронный «горячий» доступ — единственный способ отрисовать вернувшуюся ячейку
    /// сразу с картинкой, без кадра с заглушкой и без скачка высоты.
    nonisolated func cached(_ url: URL) -> UIImage? {
        Self.hot.withLock { $0[url] }
    }

    /// Зеркало memory для синхронного чтения из main-потока (актор синхронно не спросить).
    /// Держим здесь только то, что реально показано на экране, — словарь ограничен.
    private nonisolated static let hot = Mutex<[URL: UIImage]>([:])
    private nonisolated static let hotLimit = 120

    private nonisolated static func putHot(_ url: URL, _ image: UIImage) {
        hot.withLock { map in
            if map.count >= hotLimit, let victim = map.keys.first { map.removeValue(forKey: victim) }
            map[url] = image
        }
    }

    func load(_ url: URL) async -> UIImage? {
        if let hit = memory.object(forKey: url as NSURL) {
            Self.putHot(url, hit)
            return hit
        }
        if let running = inFlight[url] { return await running.value }
        let task = Task<UIImage?, Never> { [weak self] in
            var request = URLRequest(url: url)
            // Картинки неизменяемы (url содержит ключ объекта), поэтому диск важнее сети.
            request.cachePolicy = .returnCacheDataElseLoad
            guard let (data, response) = try? await URLSession.shared.data(for: request),
                  let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode),
                  let image = UIImage(data: data)
            else { return nil }
            await self?.store(image, for: url, bytes: data.count)
            return image
        }
        inFlight[url] = task
        let image = await task.value
        inFlight[url] = nil
        return image
    }

    private func store(_ image: UIImage, for url: URL, bytes: Int) {
        memory.setObject(image, forKey: url as NSURL, cost: bytes)
        Self.putHot(url, image)
    }

    /// Зовётся на старте: дисковый кэш по умолчанию крошечный, а переписка — это сотни
    /// картинок, которые не должны качаться заново после каждого запуска.
    nonisolated static func configureDiskCache() {
        URLCache.shared = URLCache(
            memoryCapacity: 32 * 1024 * 1024,
            diskCapacity: 512 * 1024 * 1024,
            diskPath: "eblusha-images"
        )
    }
}

/// Минимальный мьютекс: Synchronization.Mutex доступен с iOS 18, а держать ради него
/// планку версии не хочется — здесь достаточно NSLock.
final class Mutex<Value>: @unchecked Sendable {
    private var value: Value
    private let lock = NSLock()
    init(_ value: Value) { self.value = value }
    func withLock<R>(_ body: (inout Value) -> R) -> R {
        lock.lock()
        defer { lock.unlock() }
        return body(&value)
    }
}

/// Картинка из сети с кэшем и БЕЗ скачков высоты.
///
/// `aspectRatio` — известное отношение сторон (у вложений сервер отдаёт width/height):
/// место под картинку занимается сразу, до загрузки, поэтому появление изображения не
/// двигает соседние сообщения. Без него занимаем `fallbackHeight`.
struct CachedImage<Placeholder: View>: View {

    let url: URL?
    /// Известное отношение сторон: место под картинку занимается ДО загрузки.
    var aspectRatio: CGFloat?
    /// Высота-заглушка, когда пропорции неизвестны. nil — размер задаёт вызывающий
    /// (аватары: у них уже есть .frame снаружи, и своя высота тут всё бы поломала).
    var fallbackHeight: CGFloat?
    var contentMode: ContentMode = .fill
    @ViewBuilder var placeholder: () -> Placeholder

    @State private var image: UIImage?
    /// Загрузка уже провалилась — не долбим сеть на каждом появлении ячейки.
    @State private var failed = false

    var body: some View {
        content
            .task(id: url) { await loadIfNeeded() }
    }

    @ViewBuilder
    private var content: some View {
        if let image {
            Image(uiImage: image)
                .resizable()
                .aspectRatio(contentMode: contentMode)
        } else {
            placeholder()
                .modifier(ReservedSpace(aspectRatio: aspectRatio, height: fallbackHeight))
        }
    }

    private func loadIfNeeded() async {
        guard let url else { return }
        // Синхронный кэш-хит: если картинка уже в памяти, первый же кадр рисуется с ней.
        if let hot = ImageLoader.shared.cached(url) {
            if image !== hot { image = hot }
            return
        }
        guard !failed else { return }
        let loaded = await ImageLoader.shared.load(url)
        if let loaded {
            image = loaded
        } else {
            failed = true
        }
    }
}

extension CachedImage where Placeholder == Color {
    init(url: URL?, aspectRatio: CGFloat? = nil, fallbackHeight: CGFloat? = nil, contentMode: ContentMode = .fill) {
        self.init(
            url: url,
            aspectRatio: aspectRatio,
            fallbackHeight: fallbackHeight,
            contentMode: contentMode,
            placeholder: { Eb.surface300 }
        )
    }
}

/// Заглушка занимает ровно столько же, сколько займёт картинка.
private struct ReservedSpace: ViewModifier {
    let aspectRatio: CGFloat?
    let height: CGFloat?

    @ViewBuilder
    func body(content: Content) -> some View {
        if let aspectRatio, aspectRatio > 0 {
            content.aspectRatio(aspectRatio, contentMode: .fit)
        } else if let height {
            content.frame(height: height)
        } else {
            content
        }
    }
}
