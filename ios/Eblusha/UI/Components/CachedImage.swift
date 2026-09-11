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
        Self.hot.withLock { $0.images[url] }
    }

    /// Зеркало memory для синхронного чтения из main-потока (актор синхронно не спросить).
    /// Держим здесь только то, что реально показано на экране, — словарь ограничен.
    private nonisolated static let hot = Mutex<HotCache>(HotCache())
    private nonisolated static let hotLimit = 120

    /// Словарь + очередь порядка: вытесняем САМЫЙ СТАРЫЙ, а не произвольный по хэшу —
    /// иначе легко выбросить ровно ту картинку, что сейчас на экране.
    private struct HotCache {
        var images: [URL: UIImage] = [:]
        var order: [URL] = []
    }

    private nonisolated static func putHot(_ url: URL, _ image: UIImage) {
        hot.withLock { cache in
            if cache.images[url] == nil {
                cache.order.append(url)
                if cache.order.count > hotLimit {
                    let victim = cache.order.removeFirst()
                    cache.images.removeValue(forKey: victim)
                }
            }
            cache.images[url] = image
        }
    }

    /// Предупреждение памяти: NSCache чистится сам, а этот словарь держит сильные
    /// ссылки — отпускаем всё.
    nonisolated static func purgeHot() {
        hot.withLock { $0 = HotCache() }
    }

    func load(_ url: URL) async -> UIImage? {
        if let hit = memory.object(forKey: url as NSURL) {
            Self.putHot(url, hit)
            return hit
        }
        if let running = inFlight[url] { return await running.value }
        // Локальный файл: превью ещё не отправленного вложения и расшифрованная секретка
        // лежат на диске. Через URLSession они не читаются вовсе — ответ у file:// не
        // HTTP, и проверка статуса ниже отбрасывала бы картинку как несуществующую.
        if url.isFileURL {
            guard let image = UIImage(contentsOfFile: url.path) else { return nil }
            // «Стоимость» для NSCache — по размеру кадра в памяти (4 байта на пиксель):
            // пересжимать картинку только ради числа байт было бы дороже самой загрузки.
            let pixels = Int(image.size.width * image.scale * image.size.height * image.scale)
            store(image, for: url, bytes: pixels * 4)
            return image
        }
        let task = Task<UIImage?, Never> { [weak self] in
            var request = URLRequest(url: url)
            // Картинки неизменяемы (url содержит ключ объекта), поэтому диск важнее сети.
            request.cachePolicy = .returnCacheDataElseLoad
            // Картинка превью ссылки лежит на ЧУЖОМ хосте (i.ytimg.com, og:image сайта).
            // Банка кук у URLSession.shared общая на всё приложение: чужой сервер не
            // должен ни получать из неё что-либо, ни класть туда своё — по такой куке
            // нас потом узнают на любой следующей картинке. Своему origin куки оставляем
            // (там их и ставят), хотя /api/files и обходится без них.
            if url.host != AppConfig.socketBaseURL.host {
                request.httpShouldHandleCookies = false
            }
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
        NotificationCenter.default.addObserver(
            forName: UIApplication.didReceiveMemoryWarningNotification,
            object: nil,
            queue: nil
        ) { _ in purgeHot() }
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
    /// Разрешено ли растягивать картинку крупнее её натурального размера. false нужен
    /// превью ссылок: сервер часто отдаёт вместо og:image крошечный favicon, и растянутый
    /// во всю карточку он превращается в мыло.
    var upscales: Bool = true
    /// Загрузка провалилась (чужой хост ответил 404, отдал не картинку, не ответил вовсе).
    /// Зовущему это нужно, чтобы УБРАТЬ зарезервированное место: серая дыра на месте
    /// картинки читается как поломка.
    var onFailure: ((URL) -> Void)?
    @ViewBuilder var placeholder: () -> Placeholder

    @State private var image: UIImage?
    /// Загрузка уже провалилась — не долбим сеть на каждом появлении ячейки.
    @State private var failed = false
    /// Какой url сейчас показан. Вью переиспользуется под другой адрес (сменился аватар,
    /// строка списка уехала под другое сообщение) — тогда состояние надо сбросить,
    /// иначе показывалась бы прошлая картинка или намертво держался прошлый провал.
    @State private var loadedURL: URL?

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
                .modifier(NaturalSizeCap(size: upscales ? nil : image.size))
        } else {
            placeholder()
                .modifier(ReservedSpace(aspectRatio: aspectRatio, height: fallbackHeight))
        }
    }

    private func loadIfNeeded() async {
        guard let url else {
            image = nil
            loadedURL = nil
            failed = false
            return
        }
        if loadedURL != url {
            loadedURL = url
            failed = false
            image = ImageLoader.shared.cached(url)
        }
        // Синхронный кэш-хит: если картинка уже в памяти, первый же кадр рисуется с ней.
        if let hot = ImageLoader.shared.cached(url) {
            if image !== hot { image = hot }
            return
        }
        guard !failed else { return }
        let loaded = await ImageLoader.shared.load(url)
        // Пока качали, вью могли переиспользовать под другой адрес: `.task(id:)` отменяет
        // ожидание, но тело продолжает выполняться, и чужой результат присвоился бы поверх
        // уже начатой новой загрузки — в ячейке мелькала бы картинка прошлого сообщения.
        guard loadedURL == url else { return }
        if let loaded {
            image = loaded
        } else {
            failed = true
            onFailure?(url)
        }
    }
}

/// «Не крупнее натурального размера» (nil — без ограничения). Ограничивает САМУ картинку
/// внутри уже занятого места, поэтому высоту вокруг не двигает.
private struct NaturalSizeCap: ViewModifier {
    let size: CGSize?

    @ViewBuilder
    func body(content: Content) -> some View {
        if let size, size.width > 0, size.height > 0 {
            content.frame(maxWidth: size.width, maxHeight: size.height)
        } else {
            content
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

// MARK: - Прогресс скачивания медиа

/// Кто сейчас качается и на сколько. Один общий реестр на приложение: скачивание
/// начинают РАЗНЫЕ места (открытие вложения, расшифровка секретного медиа), а показать
/// прогресс надо ровно там, где человек ткнул, — на плитке в ленте.
///
/// Почему реестр, а не поле в модели строки: строка ленты пересобирается diffable-снимком,
/// и гнать в него процент значило бы переконфигурировать ячейку на каждый байт. Здесь же
/// подписан только крошечный оверлей плитки, и публикуем мы лишь смену ЦЕЛОГО процента.
@MainActor
final class MediaDownloadCenter: ObservableObject {

    /// nonisolated, чтобы `MediaDownloadCenter.shared` можно было назвать где угодно —
    /// в том числе в значении по умолчанию @ObservedObject у плитки (значения свойств
    /// вычисляются вне изоляции) и из репозиториев. Изолированы САМИ операции, а не имя.
    nonisolated static let shared = MediaDownloadCenter()

    /// Состояние одной загрузки. `percent == nil` — сервер не сказал Content-Length,
    /// и вместо числа крутится спиннер.
    /// Имя не `Progress`: так называется класс Foundation, который тут же рядом и нужен.
    struct Snapshot: Equatable {
        var percent: Int?
        /// Есть ли что отменять. Расшифровку секретного кадра, например, прерывать нельзя
        /// (повторить её человеку нечем) — тогда крест не рисуем, чтобы он не обманывал.
        var cancellable: Bool = true
    }

    /// Ключ — `MessageAttachment.url` (как он лежит в сообщении, без резолва прокси):
    /// плитка знает только его, и он одинаков у всех показов одного вложения.
    @Published private(set) var items: [String: Snapshot] = [:]

    /// Чем отменять: замыкание владельца загрузки (обычно `task.cancel()`). @Sendable —
    /// его приносят и не-главные акторы (репозиторий секретки качает со своей задачи).
    private var cancels: [String: @Sendable () -> Void] = [:]

    /// nonisolated ради nonisolated `shared`: конструктор ничего изолированного не трогает.
    nonisolated private init() {}

    func progress(for key: String) -> Snapshot? { items[key] }

    /// Начало загрузки. Повторный begin по тому же ключу перетирает прежний отменятель —
    /// это нормально: две качалки одного вложения нам всё равно не нужны.
    func begin(_ key: String, cancel: (@Sendable () -> Void)? = nil) {
        cancels[key] = cancel
        items[key] = Snapshot(percent: nil, cancellable: cancel != nil)
    }

    /// Прогресс в байтах. Публикуем только при смене целого процента: иначе на каждом
    /// чанке перерисовывались бы все подписанные плитки.
    func update(_ key: String, received: Int64, total: Int64) {
        guard var state = items[key] else { return }
        let percent: Int? = total > 0
            ? min(max(Int((Double(received) / Double(total)) * 100), 0), 100)
            : nil
        guard state.percent != percent else { return }
        state.percent = percent
        items[key] = state
    }

    /// Загрузка кончилась (успех, провал или отмена) — снимаем кольцо.
    func finish(_ key: String) {
        cancels[key] = nil
        items[key] = nil
    }

    /// Отмена по кресту в кольце: сперва убираем кольцо, потом дёргаем владельца, чтобы
    /// его собственный `finish` в defer уже ничего не находил и не мигал повторно.
    func cancel(_ key: String) {
        let handler = cancels[key]
        finish(key)
        handler?()
    }
}

/// Кольцо скачивания поверх плитки — тот же визуальный язык, что у отправки
/// (OutgoingUploadOverlay в ComposerAttachments.swift): круг 58, кольцо 46, толщина 3,
/// крест в центре, «NN%» капсулой снизу. Отличие одно: отправка гасит плитку целиком
/// (её ещё нет на сервере), а скачивание идёт поверх настоящего медиа, и чат при этом
/// живой — можно продолжать читать переписку.
struct MediaDownloadRing: View {

    /// Ключ загрузки — `MessageAttachment.url`.
    let key: String
    /// Скругление плитки, чтобы затемнение не вылезало за её углы.
    var cornerRadius: CGFloat = 10

    @ObservedObject private var center = MediaDownloadCenter.shared

    var body: some View {
        if let state = center.progress(for: key) {
            ZStack {
                // Затемнение заодно съедает тапы: повторный тап по качающейся плитке не
                // должен запускать вторую качку, отмена — только крестом.
                Color.black.opacity(0.3)
                Button {
                    MediaDownloadCenter.shared.cancel(key)
                } label: {
                    ring(state.percent, cancellable: state.cancellable)
                }
                .buttonStyle(.plain)
                .disabled(!state.cancellable)
            }
            .clipShape(RoundedRectangle(cornerRadius: cornerRadius))
            // Переход между состояниями кольца — короткий, чтобы процент не «догонял».
            .animation(.easeInOut(duration: 0.2), value: state.percent)
        }
    }

    private func ring(_ percent: Int?, cancellable: Bool) -> some View {
        let value = CGFloat(percent ?? 0) / 100
        return ZStack {
            Circle()
                .fill(.black.opacity(0.55))
                .frame(width: 58, height: 58)
            Circle()
                .stroke(Color.white.opacity(0.25), lineWidth: 3)
                .frame(width: 46, height: 46)
            if let percent {
                // Кольцо всегда чуть залито (0.02): пустой круг читался бы как «ничего
                // не происходит» — то же решение, что в кольце отправки.
                Circle()
                    .trim(from: 0, to: max(0.02, value))
                    .stroke(Color.white, style: StrokeStyle(lineWidth: 3, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                    .frame(width: 46, height: 46)
                    .overlay(alignment: .bottom) {
                        Text("\(percent)%")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 1)
                            .background(.black.opacity(0.55), in: Capsule())
                            .offset(y: 20)
                    }
            } else {
                // Размера файла сервер не сказал — системный спиннер вместо процента.
                // Своя крутящаяся дуга на @State тут уже подводила: при ПОВТОРНОМ показе
                // флаг остаётся взведённым, анимацию нечем перезапустить, и кольцо
                // замирает. У ProgressView этой памяти нет.
                ProgressView()
                    .progressViewStyle(.circular)
                    .tint(.white)
            }
            // Крест — только поверх кольца с процентом: на месте спиннера он наложился бы
            // прямо на него. Тап по кругу отменяет в обоих случаях, рисунка это не меняет.
            if cancellable, percent != nil {
                Image(systemName: "xmark")
                    .font(.system(size: 14, weight: .bold))
                    .foregroundStyle(.white)
            }
        }
        // Крест — единственная кнопка: попасть в него пальцем должно быть легко.
        .contentShape(Circle())
    }
}

/// Тот же прогресс, но для строки файла: там кольцо 58×58 просто не помещается —
/// строка ниже него. Пока загрузки нет, это обычная стрелка «скачать»; во время
/// загрузки — спиннер с процентом на её месте, так что ширина строки не скачет.
struct MediaDownloadBadge: View {

    /// Ключ загрузки — `MessageAttachment.url`.
    let key: String

    @ObservedObject private var center = MediaDownloadCenter.shared

    var body: some View {
        if let state = center.progress(for: key) {
            HStack(spacing: 4) {
                ProgressView()
                    .progressViewStyle(.circular)
                    .controlSize(.mini)
                    .tint(Eb.textMuted)
                if let percent = state.percent {
                    Text("\(percent)%")
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(Eb.textMuted)
                }
            }
        } else {
            Image(systemName: "arrow.down.circle")
                .foregroundStyle(Eb.textMuted)
        }
    }
}

extension MediaDownloadCenter {

    /// Скачать файл, показывая кольцо на плитке с ключом `key`. Возвращает ВРЕМЕННЫЙ файл
    /// (его надо сразу перенести или прочитать), nil — ошибка, отмена крестом или отмена
    /// вызывающей задачи.
    ///
    /// Почему downloadTask с колбэком, а не `URLSession.download(for:delegate:)`: процент
    /// даёт только `URLSessionTask.progress` (или делегат didWriteData), а связка
    /// «свой делегат + async-обёртка» известна тем, что временный файл исчезает раньше,
    /// чем его успевают забрать. Здесь файл переносим сами, прямо в колбэке.
    ///
    /// `cancellable: false` — крест в кольце не рисуем: там, где отменённая загрузка
    /// оставляет плитку навсегда сломанной (расшифровка секретного кадра), кнопка отмены
    /// приносит больше вреда, чем пользы. Отмену ЗАДАЧИ это не отменяет.
    ///
    /// nonisolated: качают и репозитории со своих задач, незачем ради этого прыгать на
    /// главный актор — туда уходят только обновления реестра.
    nonisolated static func download(
        _ request: URLRequest,
        key: String,
        cancellable: Bool = true,
        session: URLSession = .shared
    ) async -> URL? {
        let destination = FileManager.default.temporaryDirectory
            .appendingPathComponent("eb-download-\(UUID().uuidString)")
        let handle = MediaDownloadHandle()
        // Через if, а не тернаром: тип замыкания тут выводится из параметра, и «либо
        // замыкание, либо nil» одной строкой читается компилятором хуже, чем нами.
        var canceller: (@Sendable () -> Void)?
        if cancellable { canceller = { handle.cancel() } }
        await shared.begin(key, cancel: canceller)
        let result: URL? = await withTaskCancellationHandler {
            await withCheckedContinuation { (continuation: CheckedContinuation<URL?, Never>) in
                let task = session.downloadTask(with: request) { url, response, _ in
                    handle.finish()
                    guard let url,
                          let http = response as? HTTPURLResponse,
                          (200..<300).contains(http.statusCode) else {
                        continuation.resume(returning: nil)
                        return
                    }
                    // Системный временный файл живёт только до возврата отсюда.
                    do {
                        try FileManager.default.moveItem(at: url, to: destination)
                        continuation.resume(returning: destination)
                    } catch {
                        continuation.resume(returning: nil)
                    }
                }
                handle.start(task, key: key)
            }
        } onCancel: {
            handle.cancel()
        }
        await shared.finish(key)
        return result
    }

    /// То же, но в память: для шифртекста секретного вложения, который всё равно надо
    /// расшифровывать целиком. Временный файл удаляется сразу после чтения.
    nonisolated static func downloadData(
        _ request: URLRequest,
        key: String,
        cancellable: Bool = true,
        session: URLSession = .shared
    ) async -> Data? {
        guard let file = await download(
            request, key: key, cancellable: cancellable, session: session
        ) else {
            return nil
        }
        defer { try? FileManager.default.removeItem(at: file) }
        return try? Data(contentsOf: file)
    }
}

/// Ручка одной загрузки: её дёргают крестик отмены и отмена вызывающей задачи, а
/// наблюдение за прогрессом живёт ровно столько же, сколько сама загрузка.
/// Колбэки KVO приходят с сетевой очереди, отмена — с главной, поэтому замок обязателен.
private final class MediaDownloadHandle: @unchecked Sendable {

    private let lock = NSLock()
    private var task: URLSessionDownloadTask?
    private var observation: NSKeyValueObservation?
    /// Последний показанный целый процент: в реестр пишем только на его смене, иначе
    /// на каждый принятый чанк будили бы главный поток и перерисовывали плитку.
    private var lastPercent = -1
    private var cancelled = false

    func start(_ task: URLSessionDownloadTask, key: String) {
        lock.lock()
        self.task = task
        let alreadyCancelled = cancelled
        observation = task.progress.observe(\.completedUnitCount) { [weak self] progress, _ in
            self?.report(key: key, progress: progress)
        }
        lock.unlock()
        // Стартуем ВСЕГДА, даже если крест успели нажать до этого момента: колбэк
        // завершения (а значит и продолжение async-функции) гарантированно приходит
        // только у запущенной задачи, отменённая «на суспенде» повисла бы навсегда.
        task.resume()
        if alreadyCancelled { task.cancel() }
    }

    func finish() {
        lock.lock()
        observation = nil
        task = nil
        lock.unlock()
    }

    func cancel() {
        lock.lock()
        cancelled = true
        let running = task
        observation = nil
        task = nil
        lock.unlock()
        running?.cancel()
    }

    private func report(key: String, progress: Progress) {
        let total = progress.totalUnitCount
        let received = progress.completedUnitCount
        let percent = total > 0 ? Int((Double(received) / Double(total)) * 100) : -1
        lock.lock()
        let changed = percent != lastPercent
        if changed { lastPercent = percent }
        lock.unlock()
        guard changed else { return }
        // Реестр живёт на главном акторе — туда и уходим (не чаще раза на процент).
        Task { @MainActor in
            MediaDownloadCenter.shared.update(key, received: received, total: total)
        }
    }
}
