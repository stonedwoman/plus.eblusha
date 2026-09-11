import Combine
import Foundation
import ImageIO
import Photos
import SwiftUI
import UIKit
import UniformTypeIdentifiers

// Общие типы просмотрщика фото (контракт: файл 1). На них опираются ZoomableImageView,
// PhotoViewerController и PhotoViewerView — имена и сигнатуры здесь менять нельзя без
// правки всех соседей. Загрузка кадров и системные действия (Фото / буфер / шаринг)
// тоже живут здесь, чтобы контроллер и хром не знали ни про сеть, ни про E2EE.

// MARK: - Модели

/// Один кадр галереи: вложение плюс контекст сообщения для шапки, подписи и действий.
struct PhotoViewerItem: Identifiable, Equatable {
    let id: String                 // "\(messageId)#\(indexInMessage)"
    let attachment: MessageAttachment
    let messageId: String
    let senderName: String
    let isMine: Bool
    let createdAt: Int64           // миллисекунды эпохи
    let caption: String?           // текст сообщения, если есть (пустое → nil)
}

extension PhotoViewerItem {
    /// Удобный конструктор для координатора: id собирается по правилу контракта, пустая
    /// или пробельная подпись превращается в nil — хром проверяет только `caption != nil`.
    init(
        messageId: String,
        indexInMessage: Int,
        attachment: MessageAttachment,
        senderName: String,
        isMine: Bool,
        createdAt: Int64,
        caption: String?
    ) {
        let trimmed = caption?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        self.init(
            id: "\(messageId)#\(indexInMessage)",
            attachment: attachment,
            messageId: messageId,
            senderName: senderName,
            isMine: isMine,
            createdAt: createdAt,
            caption: trimmed.isEmpty ? nil : trimmed
        )
    }

    /// Пропорции кадра из метаданных вложения (сервер отдаёт width/height): страница
    /// занимает правильную геометрию ДО прихода картинки, и полный кадр потом не прыгает.
    var aspectSize: CGSize? {
        guard let w = attachment.width, let h = attachment.height, w > 0, h > 0 else { return nil }
        return CGSize(width: w, height: h)
    }

    /// E2EE-вложение: по url лежит шифртекст, картинка есть только после decrypt.
    var isSecret: Bool { attachment.secretNonce != nil }

    /// Видео-кадр галереи: страница с плеером (VideoPage.swift) вместо ZoomableImageView.
    /// Вид медиа не отдельным полем: тип уже лежит во вложении, а второй источник правды
    /// разошёлся бы с фильтрами ленты (там тот же `type == "VIDEO"`).
    var isVideo: Bool { attachment.type == "VIDEO" }
}

/// Что открыто: все фото беседы в хронологическом порядке + стартовый кадр. Identifiable
/// ради fullScreenCover(item:); sourceFrame — рамка тапнутой плитки в координатах окна,
/// из неё кадр «вырастает» при открытии и в неё улетает при закрытии.
struct PhotoViewerGallery: Identifiable {
    let id = UUID()
    let items: [PhotoViewerItem]
    let startIndex: Int
    let sourceFrame: CGRect?       // nil — без анимации из плитки
    /// Актуальная рамка плитки кадра в координатах окна на момент закрытия: лента могла
    /// проскроллиться, пока просмотрщик открыт, а после листания закрывается уже другой
    /// кадр. nil — плитки на экране нет, закрываемся уменьшением с затуханием.
    var sourceFrameProvider: ((PhotoViewerItem) -> CGRect?)? = nil
    /// Спрятать плитку-источник в ленте (nil — вернуть все плитки на место). Под летящей
    /// копией кадра не должно быть той же картинки: последние миллисекунды возврата зритель
    /// иначе видит её дважды, а в альбоме кадр приземляется на самого себя. Зовёт
    /// просмотрщик: на открытии, на каждой смене центрального кадра и по концу полёта.
    var setHiddenTile: ((PhotoViewerItem?) -> Void)? = nil
}

/// Что делает хром по кнопкам; всё исполняет координатор (ChatView) — у него есть
/// вью-модель чата, а у просмотрщика её нет и быть не должно.
struct PhotoViewerCallbacks {
    var onClose: () -> Void
    var onReply: (PhotoViewerItem) -> Void
    var onForward: (PhotoViewerItem) -> Void
    var onDelete: (PhotoViewerItem) -> Void          // только для isMine
    var onShowInChat: (PhotoViewerItem) -> Void      // закрыть и промотать к сообщению
    /// Центральный кадр сменился (пролистали галерею или прыгнули по ленте миниатюр):
    /// чат под просмотрщиком подводит плитку этого кадра в видимую область, чтобы закрытие
    /// всегда попадало в плитку, а не гасло уменьшением. Прокрутка не видна — сверху
    /// непрозрачный фон просмотрщика.
    var onCurrentItemChanged: ((PhotoViewerItem) -> Void)? = nil
    /// В секретных чатах пересылки и удаления нет — кнопки прячутся, а не молчат.
    var canForward: Bool = true
    var canDelete: Bool = true

    /// Пустые обработчики — для превью и тестов, где координатора нет.
    static let noop = PhotoViewerCallbacks(
        onClose: {}, onReply: { _ in }, onForward: { _ in }, onDelete: { _ in }, onShowInChat: { _ in }
    )
}

/// Мост SwiftUI-хрома и UIKit-контроллера. Живёт в PhotoViewerView как @StateObject:
/// контроллер публикует индекс/видимость/прогресс закрытия, хром — отдаёт команды.
@MainActor final class PhotoViewerProxy: ObservableObject {
    @Published var currentIndex: Int
    @Published var chromeVisible: Bool = true
    /// 0…1 — прогресс интерактивного закрытия; хром гаснет как (1 - progress).
    @Published var dismissProgress: CGFloat = 0
    /// Команды хрома контроллеру (ставит контроллер при появлении).
    var jump: ((Int, Bool) -> Void)?          // индекс, animated
    var requestDismiss: (() -> Void)?         // закрыть с анимацией (в плитку, если можно)

    init(currentIndex: Int) {
        self.currentIndex = currentIndex
    }
}

/// Состояние ПОЛНОРАЗМЕРНОГО кадра. Миниатюра живёт отдельно (thumb(for:)) и может быть
/// при любом состоянии — в том числе при .failed, тогда страница показывает её + подпись.
enum PhotoViewerLoadState { case idle, loading, loaded, failed }

// MARK: - Загрузка кадров

/// Загрузка кадров: миниатюра (thumbMediaUrl — обычно уже в кэше ImageLoader из ленты) и
/// полноразмер (resolveMediaUrl), секретные — через decrypt в локальный файл, из него же
/// режется и миниатюра. Предзагрузка соседей ±1, полноразмеры дальше ±2 выбрасываются:
/// каждый — десятки мегабайт RGBA, а листать можно сотню фото подряд.
@MainActor final class PhotoViewerImageStore: ObservableObject {

    let items: [PhotoViewerItem]
    private let decrypt: ((MessageAttachment) async -> URL?)?

    private var thumbs: [String: UIImage] = [:]
    private var fulls: [String: UIImage] = [:]
    private var states: [String: PhotoViewerLoadState] = [:]
    /// Миниатюра не загрузилась — второй раз не просим (ошибку помним, сеть не долбим).
    private var thumbFailed: Set<String> = []
    /// Поколение загрузки полноразмера: результат устаревшей задачи (после выброса
    /// из окна ±2 или предупреждения памяти) отбрасывается, а не оседает в памяти.
    private var generation: [String: Int] = [:]
    /// Расшифрованные файлы секретных вложений (лежат в кэше SecretRepository).
    private var secretFiles: [String: URL] = [:]
    /// Готовые к проигрыванию файлы секретных видео: ссылка на расшифрованный файл с
    /// расширением (у file:// нет Content-Type, и контейнер AVPlayer узнаёт только по нему).
    private var videoFiles: [String: URL] = [:]
    /// Готовые файлы для «Поделиться»/«Сохранить» — с человеческим именем и расширением.
    private var shareFiles: [String: URL] = [:]
    /// Центр последнего prefetch — по нему решаем, что оставить при нехватке памяти.
    private var lastCenter: Int = 0

    /// Задачи лежат в потокобезопасном мешке, а не в изолированном словаре: deinit у
    /// @MainActor-класса nonisolated, и отменить загрузки оттуда иначе нельзя.
    private let tasks = Mutex<[String: Task<Void, Never>]>([:])
    private let memoryObserver = Mutex<NSObjectProtocol?>(nil)
    /// Свой каталог во временных файлах — сносится целиком в deinit.
    private let tmpDir: URL
    /// Потолок стороны декодированного полноразмера в пикселях (см. fullDecodeCap).
    private let fullMaxPixel: CGFloat

    /// Порог «огромного» кадра: до 12 Мп декодируем как есть (зум показывает настоящие
    /// пиксели), выше — даунсэмплим до fullMaxPixel через ImageIO.
    nonisolated private static let downsampleThresholdPixels: Double = 12_000_000
    /// Миниатюра секретного кадра: лента миниатюр 48×64 pt @3x + подложка blur-up —
    /// 512 px хватает с запасом, а память копеечная.
    nonisolated private static let secretThumbMaxPixel: CGFloat = 512

    init(items: [PhotoViewerItem], decrypt: ((MessageAttachment) async -> URL?)?) {
        self.items = items
        self.decrypt = decrypt
        self.tmpDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("eb-photo-viewer-\(UUID().uuidString)", isDirectory: true)
        self.fullMaxPixel = Self.fullDecodeCap()

        let token = NotificationCenter.default.addObserver(
            forName: UIApplication.didReceiveMemoryWarningNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in self?.handleMemoryWarning() }
        }
        memoryObserver.withLock { $0 = token }
    }

    deinit {
        tasks.withLock { bag in
            bag.values.forEach { $0.cancel() }
            bag.removeAll()
        }
        if let token = memoryObserver.withLock({ $0 }) {
            NotificationCenter.default.removeObserver(token)
        }
        let dir = tmpDir
        Task.detached(priority: .utility) {
            try? FileManager.default.removeItem(at: dir)
        }
    }

    // MARK: Публичное API (контракт)

    /// Миниатюра. Для обычных вложений — из кэша ImageLoader (лента уже показывала её),
    /// при промахе тихо запускает загрузку и опубликует результат позже. Для секретных
    /// thumbMediaUrl отдал бы шифртекст, поэтому до расшифровки (ensureLoaded) — nil.
    func thumb(for item: PhotoViewerItem) -> UIImage? {
        if let hit = thumbs[item.id] { return hit }
        if item.isSecret { return nil }
        guard let url = thumbURL(item) else { return nil }
        if let hot = ImageLoader.shared.cached(url) {
            thumbs[item.id] = hot
            return hot
        }
        scheduleThumbLoad(item, url: url)
        return nil
    }

    func full(for item: PhotoViewerItem) -> UIImage? {
        fulls[item.id]
    }

    func state(for item: PhotoViewerItem) -> PhotoViewerLoadState {
        states[item.id] ?? .idle
    }

    /// Текущий + соседи ±1; остальные не грузим. Заодно выбрасываем полноразмеры дальше
    /// ±2 и отменяем их незавершённые загрузки — иначе быстрое листание оставляет за
    /// собой хвост из десятков декодированных кадров.
    func prefetch(around index: Int) {
        guard !items.isEmpty else { return }
        lastCenter = index
        // Текущий — первым: сеть и декодер общие, а ждут именно его.
        if items.indices.contains(index) { ensureLoaded(items[index]) }
        for i in [index - 1, index + 1] where items.indices.contains(i) {
            ensureLoaded(items[i])
        }
        evictFar(from: index)
    }

    /// Запустить загрузку одного кадра. Провал помним: повторный вызов сеть не трогает
    /// (для явного повтора есть retry(_:)).
    func ensureLoaded(_ item: PhotoViewerItem) {
        let id = item.id
        // Видео полноразмером не грузим вовсе: его страница стримит байты плеером (прокси
        // /api/files отдаёт Range), а для геометрии, полёта кадра и ленты миниатюр хватает
        // серверного постера — он приходит обычным путём миниатюры.
        if item.isVideo {
            _ = thumb(for: item)
            if states[id] != .loaded { publish { states[id] = .loaded } }
            return
        }
        switch states[id] ?? .idle {
        case .loading, .loaded, .failed: return
        case .idle: break
        }
        let gen = (generation[id] ?? 0) + 1
        generation[id] = gen
        publish { states[id] = .loading }

        let decrypt = self.decrypt
        let cap = fullMaxPixel
        // Замыкание наследует MainActor: изолированное состояние трогаем напрямую, а
        // self держим слабо — закрытый просмотрщик не должен жить до конца скачивания.
        let task = Task { [weak self] in
            if item.isSecret {
                guard let decrypt, let file = await decrypt(item.attachment) else {
                    self?.finishFull(id, generation: gen, image: nil)
                    return
                }
                guard let self, !Task.isCancelled, self.generation[id] == gen else { return }
                self.secretFiles[id] = file
                if self.thumbs[id] == nil {
                    // Миниатюра — из того же файла, но маленькая: нужна ленте миниатюр
                    // и как подложка, пока декодируется полный кадр.
                    let small = await Self.decode(
                        fileURL: file, maxPixel: Self.secretThumbMaxPixel, alwaysDownsample: true
                    )
                    if let small { self.applyThumb(id, small) }
                }
                let big = await Self.decode(fileURL: file, maxPixel: cap, alwaysDownsample: false)
                self.finishFull(id, generation: gen, image: big)
            } else {
                guard let url = Self.fullURL(item), let data = await Self.download(url) else {
                    self?.finishFull(id, generation: gen, image: nil)
                    return
                }
                guard !Task.isCancelled else { return }
                let big = await Self.decode(data: data, maxPixel: cap, alwaysDownsample: false)
                self?.finishFull(id, generation: gen, image: big)
            }
        }
        tasks.withLock { $0[Self.fullKey(id)] = task }
    }

    /// Повторить провалившуюся загрузку (кнопка «Повторить» в хроме, если появится).
    func retry(_ item: PhotoViewerItem) {
        guard states[item.id] == .failed else { return }
        publish { states[item.id] = .idle }
        ensureLoaded(item)
    }

    /// Локальный файл полноразмера для «Поделиться»/«Сохранить»: секретный — жёсткая
    /// ссылка на расшифрованный файл под человеческим именем (у кэша имя-хэш без
    /// расширения, а Фото и шаринг определяют тип по расширению), обычный — скачивается
    /// во временный каталог (URLCache отдаст с диска, если кадр уже смотрели).
    func localFile(for item: PhotoViewerItem) async -> URL? {
        // Видео здесь не готовим: Self.download тянет файл целиком в память (десятки
        // мегабайт), а в Фото такой файл всё равно уходит не картинкой. Поэтому у видео
        // хром прячет «Сохранить», «Копировать» и «Поделиться» — см. PhotoViewerView.
        guard !item.isVideo else { return nil }
        let id = item.id
        if let ready = shareFiles[id], FileManager.default.fileExists(atPath: ready.path) {
            return ready
        }
        let folder = tmpDir.appendingPathComponent(Self.safeName(id), isDirectory: true)

        if item.isSecret {
            var source = secretFiles[id]
            if source == nil, let decrypt { source = await decrypt(item.attachment) }
            guard let source else { return nil }
            secretFiles[id] = source
            let target = folder.appendingPathComponent(
                Self.fileName(for: item, sniff: CGImageSourceCreateWithURL(source as CFURL, nil))
            )
            let placed = await Task.detached(priority: .userInitiated) {
                Self.place(source, at: target)
            }.value
            guard placed else { return nil }
            shareFiles[id] = target
            return target
        }

        guard let url = Self.fullURL(item), let data = await Self.download(url) else { return nil }
        let target = folder.appendingPathComponent(
            Self.fileName(for: item, sniff: CGImageSourceCreateWithData(data as CFData, nil))
        )
        let written = await Task.detached(priority: .userInitiated) {
            Self.write(data, to: target)
        }.value
        guard written else { return nil }
        shareFiles[id] = target
        return target
    }

    /// Откуда играть видео. Обычное — потоковый URL прокси: /api/files отвечает
    /// Accept-Ranges и 206, поэтому AVPlayer тянет байты по мере воспроизведения (так же
    /// давно играет VoiceMessagePlayer). Секретное стримить нельзя в принципе — по url
    /// лежит ШИФРТЕКСТ, поэтому оно расшифровывается в файл ключом треда, ровно как
    /// секретное голосовое (SecretVoiceMessagePlayer).
    func videoSource(for item: PhotoViewerItem) async -> URL? {
        guard item.isVideo else { return nil }
        let id = item.id
        if let ready = videoFiles[id], FileManager.default.fileExists(atPath: ready.path) {
            return ready
        }
        guard item.isSecret else { return Self.fullURL(item) }

        var source = secretFiles[id]
        if source == nil, let decrypt { source = await decrypt(item.attachment) }
        guard let source else { return nil }
        secretFiles[id] = source
        let mime = item.attachment.mime
        // Ссылку создаём вне главного потока: это обращение к файловой системе.
        let playable = await Task.detached(priority: .userInitiated) {
            Self.playableVideoFile(source, mime: mime)
        }.value
        videoFiles[id] = playable
        return playable
    }

    // MARK: Внутреннее состояние

    /// objectWillChange — ДО мутации, как того требует ObservableObject.
    private func publish(_ mutate: () -> Void) {
        objectWillChange.send()
        mutate()
    }

    private func applyThumb(_ id: String, _ image: UIImage) {
        publish { thumbs[id] = image }
    }

    private func finishFull(_ id: String, generation gen: Int, image: UIImage?) {
        _ = tasks.withLock { $0.removeValue(forKey: Self.fullKey(id)) }
        // Устаревшее поколение: кадр уже выброшен из окна или перезапрошен заново.
        guard generation[id] == gen else { return }
        publish {
            if let image {
                fulls[id] = image
                states[id] = .loaded
            } else {
                states[id] = .failed
            }
        }
    }

    private func scheduleThumbLoad(_ item: PhotoViewerItem, url: URL) {
        let id = item.id
        let key = Self.thumbKey(id)
        guard !thumbFailed.contains(id) else { return }
        guard tasks.withLock({ $0[key] == nil }) else { return }
        let task = Task { [weak self] in
            let image = await ImageLoader.shared.load(url)
            guard let self, !Task.isCancelled else { return }
            _ = self.tasks.withLock { $0.removeValue(forKey: key) }
            if let image {
                self.applyThumb(id, image)
            } else {
                self.thumbFailed.insert(id)
            }
        }
        tasks.withLock { $0[key] = task }
    }

    /// Окно ±2 вокруг текущего: что дальше — выбрасываем из памяти (диск всё помнит:
    /// URLCache для обычных, кэш расшифровки для секретных), незавершённое — отменяем.
    private func evictFar(from index: Int) {
        let keep = (index - 2)...(index + 2)
        var toDrop: [String] = []
        for (offset, item) in items.enumerated() where !keep.contains(offset) {
            // У видео в fulls ничего нет (постер — это миниатюра, она копеечная), а сброс
            // состояния только гонял бы .loaded → .idle → .loaded на каждом листании.
            guard !item.isVideo else { continue }
            let state = states[item.id] ?? .idle
            if state == .loaded || state == .loading { toDrop.append(item.id) }
        }
        guard !toDrop.isEmpty else { return }
        publish {
            for id in toDrop {
                if let task = tasks.withLock({ $0.removeValue(forKey: Self.fullKey(id)) }) {
                    task.cancel()
                }
                generation[id] = (generation[id] ?? 0) + 1
                fulls.removeValue(forKey: id)
                states[id] = .idle
            }
        }
    }

    /// Предупреждение памяти: оставляем только текущий полноразмер, соседи перечитаются
    /// с диска, когда до них долистают.
    private func handleMemoryWarning() {
        let keepId = items.indices.contains(lastCenter) ? items[lastCenter].id : nil
        let toDrop = fulls.keys.filter { $0 != keepId }
        guard !toDrop.isEmpty else { return }
        publish {
            for id in toDrop {
                generation[id] = (generation[id] ?? 0) + 1
                fulls.removeValue(forKey: id)
                states[id] = .idle
            }
        }
    }

    // MARK: URL и файлы

    /// Миниатюра кадра: у фото — серверное превью самого файла, у видео — кадр-постер
    /// (metadata.posterKey): по url видео лежат его байты, и превью из них не делается.
    /// Тот же адрес берёт плитка в ленте (VideoAttachmentTile), поэтому постер к моменту
    /// открытия уже в кэше ImageLoader — копия для полёта получает картинку сразу.
    private func thumbURL(_ item: PhotoViewerItem) -> URL? {
        let source = item.isVideo ? item.attachment.posterUrl : item.attachment.url
        return thumbMediaUrl(source).flatMap { URL(string: $0) }
    }

    nonisolated private static func fullURL(_ item: PhotoViewerItem) -> URL? {
        resolveMediaUrl(item.attachment.url).flatMap { URL(string: $0) }
    }

    nonisolated private static func fullKey(_ id: String) -> String { "full:" + id }
    nonisolated private static func thumbKey(_ id: String) -> String { "thumb:" + id }

    /// Имя каталога/файла из id ("msg#0"): только буквы, цифры, «-» и «_».
    nonisolated private static func safeName(_ id: String) -> String {
        String(id.map { ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") ? $0 : "_" })
    }

    /// Имя файла для шаринга: имя из сообщения, а расширение — из него же, иначе по
    /// реальному формату (ImageIO), иначе по mime, иначе jpg. Без расширения Фото и
    /// share-sheet не понимают, что это картинка.
    nonisolated private static func fileName(for item: PhotoViewerItem, sniff: CGImageSource?) -> String {
        let att = item.attachment
        var base = (att.name ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "/", with: "-")
            .replacingOccurrences(of: ":", with: "-")
        if base.isEmpty || base.hasPrefix(".") { base = "photo-" + safeName(item.id) }
        if !(base as NSString).pathExtension.isEmpty { return base }
        var ext: String?
        if let sniff, let uti = CGImageSourceGetType(sniff) {
            ext = UTType(uti as String)?.preferredFilenameExtension
        }
        if ext == nil, let mime = att.mime, !mime.isEmpty {
            ext = UTType(mimeType: mime)?.preferredFilenameExtension
        }
        return base + "." + (ext ?? "jpg")
    }

    /// Жёсткая ссылка на файл кэша (мгновенно, без второй копии на диске); если не
    /// вышло (другой том) — обычная копия.
    nonisolated private static func place(_ source: URL, at target: URL) -> Bool {
        let fm = FileManager.default
        do {
            try fm.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
            if fm.fileExists(atPath: target.path) { try fm.removeItem(at: target) }
            do {
                try fm.linkItem(at: source, to: target)
            } catch {
                try fm.copyItem(at: source, to: target)
            }
            return true
        } catch {
            NSLog("PhotoViewer: не удалось подготовить файл для шаринга: %@", String(describing: error))
            return false
        }
    }

    /// Расширение локального видеофайла по mime — без него AVPlayer не определит
    /// контейнер file://-ресурса и молча уйдёт в .failed (та же грабля, что у аудио).
    nonisolated private static func videoFileExtension(for mime: String?) -> String {
        let m = (mime ?? "").lowercased()
        if m.contains("quicktime") || m.contains("mov") { return "mov" }
        if m.contains("m4v") { return "m4v" }
        // webm/mkv AVPlayer всё равно не проиграет, так что mp4 — лучшая догадка для всего
        // остального: и камеры телефонов, и веб-загрузки пишут именно его.
        return "mp4"
    }

    /// Готовит расшифрованный секретный файл к проигрыванию: кэш SecretRepository кладёт
    /// его под хеш БЕЗ расширения, поэтому рядом создаётся жёсткая ссылка с расширением.
    /// Именно рядом, а не в своём tmp: ссылка лежит в том же каталоге с тем же префиксом
    /// треда, и purgeThreadLocal стирает её вместе с кэшем — расшифровка не переживает
    /// закрытие секретки (так же сделано для секретных голосовых).
    nonisolated private static func playableVideoFile(_ file: URL, mime: String?) -> URL {
        guard file.pathExtension.isEmpty else { return file }
        let fm = FileManager.default
        let alias = file.appendingPathExtension(videoFileExtension(for: mime))
        if fm.fileExists(atPath: alias.path) { return alias }
        do {
            try fm.linkItem(at: file, to: alias)
            return alias
        } catch {
            // Гонка соседней страницы (ссылку уже создали) или ФС без жёстких ссылок.
            if fm.fileExists(atPath: alias.path) { return alias }
            do {
                try fm.copyItem(at: file, to: alias)
                return alias
            } catch {
                return file
            }
        }
    }

    nonisolated private static func write(_ data: Data, to target: URL) -> Bool {
        do {
            try FileManager.default.createDirectory(
                at: target.deletingLastPathComponent(), withIntermediateDirectories: true
            )
            try data.write(to: target, options: .atomic)
            return true
        } catch {
            NSLog("PhotoViewer: не удалось записать файл: %@", String(describing: error))
            return false
        }
    }

    // MARK: Сеть и декодирование (вне главного потока)

    /// Полноразмер через тот же URLSession, что и лента: картинка неизменяема (в url —
    /// ключ объекта), поэтому диск важнее сети. Bearer — как в AttachmentOpener: прокси
    /// /api/files может требовать токен.
    nonisolated private static func download(_ url: URL) async -> Data? {
        var request = URLRequest(url: url)
        request.cachePolicy = .returnCacheDataElseLoad
        if url.scheme?.lowercased().hasPrefix("http") == true,
           let token = AppContainer.shared.sessionStore.currentAccessToken() {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        guard let (data, response) = try? await URLSession.shared.data(for: request) else { return nil }
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) { return nil }
        return data.isEmpty ? nil : data
    }

    nonisolated private static func decode(data: Data, maxPixel: CGFloat, alwaysDownsample: Bool) async -> UIImage? {
        await Task.detached(priority: .userInitiated) {
            guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
            return decodeSync(source: source, maxPixel: maxPixel, alwaysDownsample: alwaysDownsample)
        }.value
    }

    nonisolated private static func decode(fileURL: URL, maxPixel: CGFloat, alwaysDownsample: Bool) async -> UIImage? {
        await Task.detached(priority: .userInitiated) {
            guard let source = CGImageSourceCreateWithURL(fileURL as CFURL, nil) else { return nil }
            return decodeSync(source: source, maxPixel: maxPixel, alwaysDownsample: alwaysDownsample)
        }.value
    }

    /// Декодирование через ImageIO-«миниатюру» даже для полного размера: она сразу даёт
    /// готовый битмап в памяти (UIImage(data:) декодирует лениво при первом рисовании —
    /// это рывок на главном потоке) и сама применяет EXIF-поворот. Огромные кадры
    /// (>12 Мп) режутся до maxPixel — иначе один HEIC с камеры съедает 200 МБ.
    nonisolated private static func decodeSync(source: CGImageSource, maxPixel: CGFloat, alwaysDownsample: Bool) -> UIImage? {
        var target = maxPixel
        if !alwaysDownsample {
            let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]
            let w = (props?[kCGImagePropertyPixelWidth] as? NSNumber)?.doubleValue ?? 0
            let h = (props?[kCGImagePropertyPixelHeight] as? NSNumber)?.doubleValue ?? 0
            if w > 0, h > 0, w * h <= downsampleThresholdPixels {
                target = CGFloat(max(w, h))
            }
        }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: Int(target.rounded(.up)),
        ]
        guard let cg = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
            return nil
        }
        return UIImage(cgImage: cg)
    }

    /// ≈2.5× длинной стороны экрана в пикселях (хватает для двойного тапа 2.5×), но не
    /// больше 4096: в памяти одновременно до трёх полноразмеров (окно ±1 плюс хвост до
    /// ±2), и 4096² RGBA ≈ 64 МБ на кадр — это уже потолок для младших моделей.
    private static func fullDecodeCap() -> CGFloat {
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        let native = (scene?.screen ?? UIScreen.main).nativeBounds
        let side = max(native.width, native.height)
        return min(max(side, 1) * 2.5, 4096)
    }
}

// MARK: - Действия над кадром

/// Результат действия — текст тоста или ошибка.
enum PhotoViewerActionResult: Equatable {
    case saved, copied, shared, failed(String)

    /// Готовый текст для тоста хрома; nil — тост не нужен (шаринг показал свой UI).
    var toastText: String? {
        switch self {
        case .saved: return "Сохранено в Фото"
        case .copied: return "Скопировано"
        case .shared: return nil
        case .failed(let text): return text
        }
    }
}

@MainActor enum PhotoViewerActions {

    /// Сохранить в Фото. Предпочитаем файл: creationRequestForAssetFromImage(atFileURL:)
    /// кладёт оригинал (HEIC/EXIF целы), из UIImage получился бы перекодированный JPEG.
    static func save(_ image: UIImage, fileURL: URL?) async -> PhotoViewerActionResult {
        // .addOnly работает только при NSPhotoLibraryAddUsageDescription в Info.plist —
        // без ключа система роняет процесс. Пока ключа нет, просим полный доступ: его
        // описание (NSPhotoLibraryUsageDescription) в проекте есть.
        let hasAddOnlyKey = Bundle.main.object(forInfoDictionaryKey: "NSPhotoLibraryAddUsageDescription") != nil
        let level: PHAccessLevel = hasAddOnlyKey ? .addOnly : .readWrite

        var status = PHPhotoLibrary.authorizationStatus(for: level)
        if status == .notDetermined {
            status = await PHPhotoLibrary.requestAuthorization(for: level)
        }
        guard status == .authorized || status == .limited else {
            return .failed("Нет доступа к Фото — разрешите в Настройках")
        }

        if let fileURL, FileManager.default.fileExists(atPath: fileURL.path) {
            // Блок performChanges — @Sendable: захваченную var мутировать нельзя, поэтому
            // результат передаём через Mutex (тот же, что у ImageLoader).
            let created = Mutex(false)
            do {
                try await PHPhotoLibrary.shared().performChanges {
                    let ok = PHAssetChangeRequest.creationRequestForAssetFromImage(atFileURL: fileURL) != nil
                    created.withLock { $0 = ok }
                }
                if created.withLock({ $0 }) { return .saved }
            } catch {
                // Фото не приняли файл (формат/расширение) — ниже сохраняем декодированный
                // кадр, теряя только метаданные.
                NSLog("PhotoViewer: сохранение файла в Фото не удалось: %@", String(describing: error))
            }
        }

        do {
            try await PHPhotoLibrary.shared().performChanges {
                _ = PHAssetChangeRequest.creationRequestForAsset(from: image)
            }
            return .saved
        } catch {
            NSLog("PhotoViewer: сохранение в Фото не удалось: %@", String(describing: error))
            return .failed("Не удалось сохранить в Фото")
        }
    }

    static func copy(_ image: UIImage) -> PhotoViewerActionResult {
        UIPasteboard.general.image = image
        return .copied
    }

    /// Share-sheet из верхнего контроллера (сцена → keyWindow → цепочка presented):
    /// просмотрщик сам показан через fullScreenCover, и SwiftUI-модификаторы поверх него
    /// ненадёжны. Файл предпочтительнее картинки — получатель получит оригинал с именем.
    static func share(fileURL: URL?, image: UIImage, from view: UIView?) {
        let items: [Any]
        if let fileURL {
            items = [fileURL]
        } else {
            items = [image]
        }
        let controller = UIActivityViewController(activityItems: items, applicationActivities: nil)
        guard let top = topViewController() else { return }
        // На iPad share-sheet — popover, без якоря UIKit роняет приложение.
        if let popover = controller.popoverPresentationController {
            if let view {
                popover.sourceView = view
                popover.sourceRect = view.bounds
            } else {
                popover.sourceView = top.view
                popover.sourceRect = CGRect(x: top.view.bounds.midX, y: top.view.bounds.midY, width: 1, height: 1)
                popover.permittedArrowDirections = []
            }
        }
        top.present(controller, animated: true)
    }

    /// Самый верхний контроллер активной сцены — на него вешаем системные листы.
    static func topViewController() -> UIViewController? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let active = scenes.filter { $0.activationState == .foregroundActive }
        let windows = active.flatMap(\.windows) + scenes.flatMap(\.windows)
        guard let window = windows.first(where: \.isKeyWindow) ?? windows.first,
              let root = window.rootViewController else { return nil }
        return descend(root)
    }

    private static func descend(_ controller: UIViewController) -> UIViewController {
        if let presented = controller.presentedViewController { return descend(presented) }
        if let nav = controller as? UINavigationController, let visible = nav.visibleViewController {
            return descend(visible)
        }
        if let tabs = controller as? UITabBarController, let selected = tabs.selectedViewController {
            return descend(selected)
        }
        return controller
    }
}
