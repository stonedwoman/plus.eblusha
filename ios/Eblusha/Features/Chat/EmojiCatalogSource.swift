import Foundation

/// Запись индекса эмодзи: сам символ и строка для поиска.
///
/// Один в один `FluentReactionEmojiEntry` из веба
/// (frontend/src/ui/pages/chats/fluentReactionAssets.ts): в файле индекса каждая запись —
/// пара `[эмодзи, ключевые слова]`, где слова уже нормализованы (нижний регистр, «ё»→«е»,
/// без диакритики: поэтому там «лаик» и «рокерскии»). Первое слово группы Unicode
/// («smileys emotion», «people body», …) служит и признаком категории.
struct EmojiIndexEntry: Sendable, Equatable {
    let emoji: String
    let search: String
}

/// Нормализация строки поиска — порт `normalizeFluentReactionSearch`
/// (fluentReactionAssets.ts:17-27). Нужна, чтобы запрос приводился к тому же виду, в
/// котором ключевые слова лежат в индексе: иначе «лайк» не найдёт «лаик», а «ёлка» — «елка».
enum EmojiSearchText {

    /// Регистр вниз, «ё»→«е», NFKD с отбрасыванием диакритики, всё кроме букв и цифр —
    /// разделитель; пробелы сжимаются, края обрезаются.
    static func normalize(_ value: String) -> String {
        let lowered = value.lowercased().replacingOccurrences(of: "ё", with: "е")
        let decomposed = lowered.decomposedStringWithCompatibilityMapping
        var out = ""
        out.reserveCapacity(decomposed.unicodeScalars.count)
        var needsSeparator = false
        for scalar in decomposed.unicodeScalars {
            // Комбинирующие знаки (в том числе краткая над «й») выбрасываем — ровно то же
            // делает веб регуляркой [̀-ͯ] после normalize('NFKD').
            if scalar.value >= 0x0300 && scalar.value <= 0x036F { continue }
            if Character(scalar).isLetter || Character(scalar).isNumber {
                if needsSeparator && !out.isEmpty { out.append(" ") }
                needsSeparator = false
                out.unicodeScalars.append(scalar)
            } else {
                needsSeparator = true
            }
        }
        return out
    }

    /// Слова запроса: совпасть должны ВСЕ (AND), как в вебе.
    static func terms(_ value: String) -> [String] {
        normalize(value).split(separator: " ").map(String.init)
    }
}

/// Индекс эмодзи для пикера: тот же файл, что грузит веб — `/fluent-emoji/reactions.json`
/// (3145 записей, EN+RU ключевые слова). Порядок записей значим: первые
/// `EmojiCatalog.popularCount` — «популярные», как в MessageReactionRail.tsx.
///
/// Источники по убыванию свежести:
/// 1. скачанная копия в Caches — чтобы подхватывать обновления индекса на сервере;
/// 2. тот же файл в бандле (`Resources/fluent-emoji-reactions.json`) — пикер обязан
///    работать без сети и на первом запуске;
/// 3. пусто — тогда `EmojiCatalog` отдаёт свой аварийный встроенный список.
///
/// Сеть трогаем один раз за запуск и только в фоне: индекс меняется раз в полгода,
/// а 369 КБ на каждый показ пикера — расточительство.
enum EmojiCatalogSource {

    /// Статический файл фронта (frontend/public/fluent-emoji/reactions.json), отдаёт nginx.
    private static let remotePath = "/fluent-emoji/reactions.json"
    private static let bundleResource = "fluent-emoji-reactions"

    /// Горячий снимок. Под мьютексом, а не под @MainActor: его читают синхронно из тела
    /// View (полоса стикеров фоторедактора зовёт `EmojiCatalog.emoji(in:)` прямо в body).
    private static let hot = Mutex<[EmojiIndexEntry]>([])
    /// Одна задача загрузки на всех: два пикера подряд не должны читать файл дважды.
    private static let loader = Mutex<Task<[EmojiIndexEntry], Never>?>(nil)
    private static let refreshedThisLaunch = Mutex(false)
    private static let warmedUp = Mutex(false)

    /// Снимок без ожидания: пусто, пока индекс ещё не прочитан.
    static func cached() -> [EmojiIndexEntry] {
        hot.withLock { $0 }
    }

    /// Индекс с ожиданием первой загрузки. Пустой результат означает «индекса нет»
    /// (не попал в бандл и сеть недоступна) — вызывающий переходит на встроенный список.
    static func entries() async -> [EmojiIndexEntry] {
        let hit = cached()
        if !hit.isEmpty {
            scheduleRemoteRefresh()
            return hit
        }
        let task = loader.withLock { (slot: inout Task<[EmojiIndexEntry], Never>?) -> Task<[EmojiIndexEntry], Never> in
            if let running = slot { return running }
            let created = Task.detached(priority: .userInitiated) { await loadOnce() }
            slot = created
            return created
        }
        let result = await task.value
        // Провал не кэшируем: следующий показ пикера попробует снова (могла появиться сеть).
        if result.isEmpty { loader.withLock { $0 = nil } }
        return result
    }

    /// Ленивый прогрев из синхронного контекста (полоса «популярных» в фоторедакторе):
    /// сама отрисовка получит встроенный список, а к следующему кадру подъедет индекс.
    /// Один раз за запуск: зовётся из тела View, то есть потенциально на каждый кадр.
    static func warmUp() {
        guard cached().isEmpty else { return }
        let start = warmedUp.withLock { (done: inout Bool) -> Bool in
            if done { return false }
            done = true
            return true
        }
        guard start else { return }
        Task.detached(priority: .utility) { _ = await entries() }
    }

    // MARK: - Загрузка

    private static func loadOnce() async -> [EmojiIndexEntry] {
        let local = readLocal()
        if !local.isEmpty {
            publish(local)
            scheduleRemoteRefresh()
            return local
        }
        // Локальной копии нет вообще — тогда сеть уже не «обновление», а единственный шанс.
        if let remote = await fetchRemote() {
            refreshedThisLaunch.withLock { $0 = true }
            return remote
        }
        return []
    }

    private static func readLocal() -> [EmojiIndexEntry] {
        if let file = cacheFileURL(), cacheBeatsBundle(file),
           let data = try? Data(contentsOf: file), let parsed = decode(data) {
            return parsed
        }
        if let file = bundleFileURL(), let data = try? Data(contentsOf: file), let parsed = decode(data) {
            return parsed
        }
        return []
    }

    private static func scheduleRemoteRefresh() {
        let start = refreshedThisLaunch.withLock { (done: inout Bool) -> Bool in
            if done { return false }
            done = true
            return true
        }
        guard start else { return }
        Task.detached(priority: .utility) { _ = await fetchRemote() }
    }

    private static func fetchRemote() async -> [EmojiIndexEntry]? {
        guard let url = URL(string: AppConfig.server.origin + remotePath) else { return nil }
        var request = URLRequest(url: url)
        request.timeoutInterval = 25
        // Индекс — публичный файл фронта: ни Bearer, ни x-device-id здесь не нужны.
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            guard (200..<300).contains(code), let parsed = decode(data) else { return nil }
            writeCache(data)
            publish(parsed)
            return parsed
        } catch {
            // Молча: пикер уже работает на локальной копии, ругаться пользователю незачем.
            return nil
        }
    }

    private static func publish(_ list: [EmojiIndexEntry]) {
        guard !list.isEmpty else { return }
        hot.withLock { $0 = list }
    }

    private static func decode(_ data: Data) -> [EmojiIndexEntry]? {
        guard let rows = try? JSONDecoder().decode([[String]].self, from: data) else { return nil }
        let parsed = rows.compactMap { row -> EmojiIndexEntry? in
            guard row.count >= 2, !row[0].isEmpty else { return nil }
            return EmojiIndexEntry(emoji: row[0], search: row[1])
        }
        return parsed.isEmpty ? nil : parsed
    }

    // MARK: - Файлы

    private static func bundleFileURL() -> URL? {
        Bundle.main.url(forResource: bundleResource, withExtension: "json")
    }

    private static func cacheFileURL() -> URL? {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?
            .appendingPathComponent("emoji-index", isDirectory: true)
            .appendingPathComponent("reactions.json")
    }

    /// Скачанная копия годится, только пока она свежее встроенной: после обновления
    /// приложения в бандле может лежать индекс новее того, что скачали месяцы назад.
    private static func cacheBeatsBundle(_ cache: URL) -> Bool {
        guard let bundle = bundleFileURL() else { return true }
        return modified(cache) > modified(bundle)
    }

    private static func modified(_ url: URL) -> Date {
        let values = try? url.resourceValues(forKeys: [.contentModificationDateKey])
        return values?.contentModificationDate ?? .distantPast
    }

    private static func writeCache(_ data: Data) {
        guard let file = cacheFileURL() else { return }
        try? FileManager.default.createDirectory(
            at: file.deletingLastPathComponent(), withIntermediateDirectories: true
        )
        try? data.write(to: file, options: .atomic)
    }
}
