import Foundation

// Порт `core/util/MediaUrl.kt` — зеркало веб-`convertToProxyUrl` (frontend/src/utils/media.ts).
// Объекты хранилища — шифрованные блобы (.eblusha/.bin), которые читаемы только через
// расшифровывающий прокси `/api/files/` на origin API; сырой S3-URL отдаёт шифртекст.

private let ebStorageBlobSuffix = try! NSRegularExpression(
    pattern: #"\d{10,}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.eblusha$"#,
    options: [.caseInsensitive]
)

// Результат разбора кэшируется: функция гоняет регулярку и режет строку, а зовут её на
// КАЖДЫЙ рендер аватара и картинки — в групповой ленте это десятки раз за кадр.
private let resolvedUrlCache = Mutex<[String: String]>([:])
private let resolvedUrlCacheLimit = 600

/// Сброс при смене источника (AppConfig.server): в ключах кэша лежит прежний origin.
func resetMediaUrlCache() {
    resolvedUrlCache.withLock { $0.removeAll() }
}

func resolveMediaUrl(_ url: String?) -> String? {
    guard let url else { return nil }
    if let hit = resolvedUrlCache.withLock({ $0[url] }) { return hit }
    let value = resolveMediaUrlUncached(url)
    if let value {
        resolvedUrlCache.withLock { map in
            if map.count >= resolvedUrlCacheLimit { map.removeAll() }
            map[url] = value
        }
    }
    return value
}

private func resolveMediaUrlUncached(_ url: String) -> String? {
    let raw = url.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !raw.isEmpty else { return nil }
    if raw.hasPrefix("blob:") || raw.hasPrefix("data:") { return raw }
    // Локальные URI (расшифрованные E2EE-вложения) — как есть, без прокси.
    if raw.hasPrefix("file:") { return raw }

    let origin = AppConfig.socketBaseURL.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    func proxy(_ path: String) -> String {
        origin + (path.hasPrefix("/") ? path : "/\(path)")
    }

    // Любой URL, оканчивающийся шифрованным блобом → канонический uploads/-ключ через прокси.
    let beforeQuery = raw.components(separatedBy: "?")[0].components(separatedBy: "#")[0]
    let lastHint = beforeQuery.hasSuffix("/")
        ? ""
        : (beforeQuery.components(separatedBy: "/").last ?? "")
    if !lastHint.isEmpty,
       ebStorageBlobSuffix.firstMatch(
           in: lastHint, range: NSRange(lastHint.startIndex..., in: lastHint)
       ) != nil {
        return proxy("/api/files/uploads/\(lastHint)")
    }

    if raw.hasPrefix("http://") || raw.hasPrefix("https://") {
        guard let parsed = URLComponents(string: raw) else { return proxy("/api/files/\(raw)") }
        let pathname = parsed.percentEncodedPath
        let query = parsed.percentEncodedQuery.map { "?\($0)" } ?? ""
        // Уже прокси-URL → оставляем путь; любой другой абсолютный медиа — через прокси.
        return pathname.hasPrefix("/api/files/")
            ? "\(origin)\(pathname)\(query)"
            : proxy("/api/files\(pathname)\(query)")
    }

    if raw.hasPrefix("/") { return "\(origin)\(raw)" }
    return proxy("/api/files/\(raw)")
}

/// Как resolveMediaUrl, но просит серверное превью через `?thumb=1` (files.ts отдаёт
/// маленький .thumb.eblusha-дериватив, для старых аплоадов — полную картинку). Для
/// пузырей/плиток альбома/лент вьюера; полноэкранная картинка — resolveMediaUrl.
func thumbMediaUrl(_ url: String?) -> String? {
    guard let resolved = resolveMediaUrl(url) else { return nil }
    guard resolved.hasPrefix("http") else { return resolved }
    return resolved + (resolved.contains("?") ? "&thumb=1" : "?thumb=1")
}

/// Картинка превью ссылки лежит на ЧУЖОМ сервере (i.ytimg.com, og:image сайта), и гнать её
/// через наш `/api/files/` нельзя: прокси ищет объект в своём хранилище, отвечает 404, и
/// карточка остаётся с пустым местом под картинку. Веб грузит такой адрес напрямую
/// (LinkPreviewCard.tsx: `src={imageUrl}`), здесь то же самое. Через прокси идут только
/// свои файлы: относительные пути, прокси-адреса и шифрованные блобы хранилища.
func linkPreviewImageUrl(_ url: String?) -> String? {
    guard let raw = url?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else {
        return nil
    }
    guard raw.hasPrefix("http://") || raw.hasPrefix("https://"),
          let parsed = URLComponents(string: raw), parsed.host?.isEmpty == false
    else {
        return resolveMediaUrl(raw)
    }
    // Свой прокси — прежним путём (там расшифровка и подпись).
    if parsed.path.hasPrefix("/api/files/") {
        return resolveMediaUrl(raw)
    }
    // Шифрованный блоб хранилища, отданный сырым S3-адресом, — тоже наш.
    let lastSegment = parsed.path.components(separatedBy: "/").last ?? ""
    if !lastSegment.isEmpty,
       ebStorageBlobSuffix.firstMatch(
           in: lastSegment, range: NSRange(lastSegment.startIndex..., in: lastSegment)
       ) != nil {
        return resolveMediaUrl(raw)
    }
    // Дальше — обычный веб-адрес, в том числе НА НАШЕМ домене: og:image страницы
    // eblusha.org и её favicon лежат у веб-сервера, а не в хранилище, и через
    // /api/files/ отвечают 404 (ровно пустое место вместо картинки). Такие грузим
    // напрямую, как и чужие.
    // Простой http iOS не пропустит (App Transport Security), а картинка почти всегда
    // отдаётся и по https — поднимаем схему, иначе кадра не будет вовсе.
    if raw.hasPrefix("http://") {
        var upgraded = parsed
        upgraded.scheme = "https"
        return upgraded.string ?? raw
    }
    return raw
}
