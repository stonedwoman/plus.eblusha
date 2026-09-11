import SwiftUI
import PhotosUI
import UIKit
import CoreTransferable
import UniformTypeIdentifiers

// Порт стейджинга вложений из `ui/chat/ChatScreen.kt` (pickAttachment / очередь чипов /
// прогресс аплоада). Веб-паритет: выбранное НЕ отправляется сразу — встаёт чипами над
// композером, подпись набирается после, отправка — кнопкой (мимо-тап не шлёт мгновенно).
// Вместо системного GetMultipleContents Android'а — два источника: PhotosPicker (до 10
// фото И видео из галереи, без разрешения на всю библиотеку) и fileImporter (до 10
// документов). Видео идёт в «прочие» (как в Kotlin, где GetMultipleContents не различает):
// капы вью-модели — 10 картинок + 10 остальных, лимит размера — серверный (см. ниже).

/// Потолок вложения — РОВНО серверный: multer `limits.fileSize` (src/routes/upload.ts) при
/// nginx `client_max_body_size 1024m`. Своего, более жёсткого лимита у клиента больше нет:
/// прежние 100 МБ отказывали в том, что браузер с того же телефона отправлял спокойно
/// (в вебе проверки размера нет вообще, крупное просто уходит чанками).
let attachmentSizeLimitBytes: Int64 = 1024 * 1024 * 1024

/// Текст отказа по размеру — один на все входы (оба пикера и вью-модель): и сколько весит
/// файл, и какой потолок. Раньше путь документов отдавал на негабарит просто nil, и человек
/// видел «Не удалось прочитать выбранные файлы» — то есть про размер не узнавал вовсе.
func oversizeAttachmentMessage(name: String, bytes: Int64) -> String {
    let actual = ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file)
    let limit = ByteCountFormatter.string(fromByteCount: attachmentSizeLimitBytes, countStyle: .file)
    return "Файл «\(name)» весит \(actual) — сервер принимает вложения до \(limit)"
}

/// Отказ при чтении выбранного, с ГОТОВЫМ текстом для баннера: отличает «слишком большой»
/// от «не читается», чего прежний `-> OutgoingFile?` сделать не мог.
private struct PickFailure: Error {
    let message: String
}

// MARK: - Кнопка-скрепка с пикерами

/// Скрепка композера: меню «Фото» (галерея) / «Файл» (документы). Выбранное читается в
/// байты и уходит наверх готовыми OutgoingFile — вью-модель кладёт их в очередь
/// (vm.stageFiles). Всё-или-ничего, как readPickedFile в Kotlin: недочитанный набор
/// не стейджится частично.
struct AttachmentPickerButton: View {
    let disabled: Bool
    /// Пикер вернул прочитанные файлы (vm.stageFiles).
    let onPicked: ([OutgoingFile]) -> Void
    /// Сбой чтения выбранного — в общий баннер ошибок (vm.setError).
    let onError: (String) -> Void

    @State private var showPhotosPicker = false
    @State private var showFileImporter = false
    @State private var photoItems: [PhotosPickerItem] = []
    /// Чтение выбранного в память может занять секунды — на это время скрепка гаснет.
    @State private var reading = false

    var body: some View {
        Menu {
            Button {
                showPhotosPicker = true
            } label: {
                Label("Фото или видео", systemImage: "photo.on.rectangle")
            }
            Button {
                showFileImporter = true
            } label: {
                Label("Файл", systemImage: "doc")
            }
        } label: {
            if reading {
                ProgressView()
                    .frame(width: 38, height: 38)
            } else {
                Image(systemName: "paperclip")
                    .font(.title3)
                    .foregroundStyle(Eb.textMuted)
                    .frame(width: 38, height: 38)
            }
        }
        .disabled(disabled || reading)
        // Мультивыбор: несколько фото станут ОДНИМ сообщением-альбомом (веб-паритет;
        // картинки первыми; текст композера станет подписью альбома, как на вебе).
        // Видео берётся тем же пикером (Kotlin GetMultipleContents тоже не различал).
        .photosPicker(
            isPresented: $showPhotosPicker,
            selection: $photoItems,
            maxSelectionCount: 10,
            matching: .any(of: [.images, .videos])
        )
        .onChange(of: photoItems) { _, items in
            guard !items.isEmpty else { return }
            photoItems = []
            readPhotoItems(items)
        }
        .fileImporter(
            isPresented: $showFileImporter,
            allowedContentTypes: [.item],
            allowsMultipleSelection: true
        ) { result in
            switch result {
            case .success(let urls):
                readFileURLs(Array(urls.prefix(10)))
            case .failure:
                onError("Не удалось прочитать выбранные файлы")
            }
        }
    }

    /// Читает выбор галереи (фото И видео) в байты. Галерея не отдаёт исходное имя
    /// файла — генерим человекочитаемое по времени и порядку выбора.
    private func readPhotoItems(_ items: [PhotosPickerItem]) {
        reading = true
        // @MainActor: стейт и колбэки вью-модели трогаем только с главного;
        // тяжёлое (декод HEIC) уезжает в detached-задачи.
        Task { @MainActor in
            pruneStagingDirectory()
            var files: [OutgoingFile] = []
            for (i, item) in items.enumerated() {
                let stamp = photoNameStamp.string(from: Date())
                // Видео определяем по UTType ДО чтения: у ролика свой mime/имя и нет
                // ветки перекодировки HEIC.
                if let movieType = item.supportedContentTypes.first(where: {
                    $0.conforms(to: .movie) || $0.conforms(to: .audiovisualContent)
                }) {
                    // mime по UTType: галерея iPhone отдаёт QuickTime (.mov) или MP4;
                    // прочее падает в video/mp4 — веб и Android оба типа проигрывают.
                    let mime: String
                    let ext: String
                    if movieType.conforms(to: .quickTimeMovie) {
                        mime = "video/quicktime"
                        ext = "mov"
                    } else if movieType.conforms(to: .mpeg4Movie) {
                        mime = "video/mp4"
                        ext = "mp4"
                    } else {
                        mime = movieType.preferredMIMEType ?? "video/mp4"
                        ext = movieType.preferredFilenameExtension ?? "mp4"
                    }
                    switch await readMovieItem(item, name: "video-\(stamp)-\(i + 1).\(ext)", mime: mime) {
                    case .success(let file):
                        files.append(file)
                    case .failure(let failure):
                        onError(failure.message)
                        reading = false
                        return
                    }
                    continue
                }
                guard var data = try? await item.loadTransferable(type: Data.self) else {
                    onError("Не удалось прочитать выбранные файлы")
                    reading = false
                    return
                }
                let type = item.supportedContentTypes.first
                var mime = type?.preferredMIMEType ?? "image/jpeg"
                var ext = type?.preferredFilenameExtension ?? "jpg"
                // HEIC/HEIF не рендерится ни вебом, ни Android-клиентом — перекодируем в
                // JPEG (то же делает iOS Safari при выборе фото в веб-клиенте).
                if mime == "image/heic" || mime == "image/heif" {
                    let source = data
                    if let jpeg = await Task.detached(operation: {
                        UIImage(data: source)?.jpegData(compressionQuality: 0.9)
                    }).value {
                        data = jpeg
                        mime = "image/jpeg"
                        ext = "jpg"
                    }
                }
                files.append(OutgoingFile(
                    bytes: data, name: "photo-\(stamp)-\(i + 1).\(ext)", mime: mime
                ))
            }
            onPicked(files)
            reading = false
        }
    }

    /// Ролик из галереи забираем ФАЙЛОМ и держим отображением в память (mmap), а не
    /// чтением в Data: `loadTransferable(type: Data.self)` поднимал бы в память весь ролик
    /// целиком, и полугигабайтное видео убивало процесс раньше, чем дело доходило до
    /// проверки размера. Отображённые страницы подгружаются по мере нарезки на чанки.
    private func readMovieItem(
        _ item: PhotosPickerItem, name: String, mime: String
    ) async -> Result<OutgoingFile, PickFailure> {
        if let movie = try? await item.loadTransferable(type: PickedMovie.self) {
            let size = fileSizeOf(movie.url) ?? 0
            if size > attachmentSizeLimitBytes {
                try? FileManager.default.removeItem(at: movie.url)
                return .failure(PickFailure(message: oversizeAttachmentMessage(name: name, bytes: size)))
            }
            guard let data = try? Data(contentsOf: movie.url, options: .mappedIfSafe) else {
                return .failure(PickFailure(message: "Не удалось прочитать «\(name)»"))
            }
            return .success(OutgoingFile(bytes: data, name: name, mime: mime))
        }
        // Запасной путь: у части элементов галереи файлового представления нет вовсе —
        // тогда читаем байтами, как раньше, и проверяем размер уже после чтения.
        guard let data = try? await item.loadTransferable(type: Data.self) else {
            return .failure(PickFailure(message: "Не удалось прочитать «\(name)»"))
        }
        if Int64(data.count) > attachmentSizeLimitBytes {
            return .failure(PickFailure(
                message: oversizeAttachmentMessage(name: name, bytes: Int64(data.count))
            ))
        }
        return .success(OutgoingFile(bytes: data, name: name, mime: mime))
    }

    /// Читает выбранные документы с диска (вне главного потока: файл бывает гигабайтным).
    private func readFileURLs(_ urls: [URL]) {
        reading = true
        Task.detached {
            pruneStagingDirectory()
            var files: [OutgoingFile] = []
            for url in urls {
                switch readPickedFile(url) {
                case .success(let file):
                    files.append(file)
                case .failure(let failure):
                    await MainActor.run {
                        onError(failure.message)
                        reading = false
                    }
                    return
                }
            }
            let picked = files
            await MainActor.run {
                onPicked(picked)
                reading = false
            }
        }
    }
}

/// Порт `readPickedFile` из ChatScreen.kt: security-scoped чтение выбранного документа
/// в байты + видимое имя + mime.
private func readPickedFile(_ url: URL) -> Result<OutgoingFile, PickFailure> {
    let scoped = url.startAccessingSecurityScopedResource()
    defer { if scoped { url.stopAccessingSecurityScopedResource() } }
    let name = url.lastPathComponent
    // Размер проверяем ДО чтения: многогигабайтный файл не должен даже начинать читаться.
    if let declared = fileSizeOf(url), declared > attachmentSizeLimitBytes {
        return .failure(PickFailure(message: oversizeAttachmentMessage(name: name, bytes: declared)))
    }
    // Копию кладём к себе и читаем отображением (mmap), а не Data(contentsOf:): документ
    // провайдера («Файлы», iCloud) перестаёт быть доступен, как только кончится
    // security-scoped доступ, а отправка большого файла идёт минутами. Отображение к тому
    // же не держит весь файл в памяти — страницы подтягиваются по мере нарезки на чанки.
    let copy = outgoingStagingDirectory().appendingPathComponent("\(UUID().uuidString)-\(name)")
    try? FileManager.default.removeItem(at: copy)
    do {
        try FileManager.default.copyItem(at: url, to: copy)
    } catch {
        return .failure(PickFailure(message: "Не удалось прочитать «\(name)»"))
    }
    guard let data = try? Data(contentsOf: copy, options: .mappedIfSafe) else {
        return .failure(PickFailure(message: "Не удалось прочитать «\(name)»"))
    }
    let mime = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType
        ?? "application/octet-stream"
    return .success(OutgoingFile(bytes: data, name: name, mime: mime))
}

/// Размер файла на диске (nil — не спросить: нет доступа или это не файл).
private func fileSizeOf(_ url: URL) -> Int64? {
    guard let size = (try? url.resourceValues(forKeys: [.fileSizeKey]))?.fileSize else { return nil }
    return Int64(size)
}

/// Временная папка для копий выбранного. Элемент PhotosPicker и security-scoped документ
/// живут до конца выбора, а отправка идёт минутами — поэтому файл забираем себе.
/// Не private: сюда же пишет локальные превью оптимистичный пузырь (ChatViewModel), и
/// подметает эту папку один и тот же уборщик.
func outgoingStagingDirectory() -> URL {
    let dir = FileManager.default.temporaryDirectory
        .appendingPathComponent("outgoing-staging", isDirectory: true)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
}

/// Убирает то, что пережило прошлые отправки (упавшие, отменённые, убитые перезапуском).
/// Удалять отображённый в память файл безопасно: mmap держит содержимое, пока им
/// пользуются, а место на диске освобождается сразу.
private func pruneStagingDirectory() {
    let deadline = Date().addingTimeInterval(-3600)
    let urls = (try? FileManager.default.contentsOfDirectory(
        at: outgoingStagingDirectory(), includingPropertiesForKeys: [.contentModificationDateKey]
    )) ?? []
    for url in urls {
        let modified = (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?
            .contentModificationDate
        if let modified, modified > deadline { continue }
        try? FileManager.default.removeItem(at: url)
    }
}

/// Файловое представление ролика из галереи: система отдаёт свой временный файл, мы
/// копируем его к себе (копия переживает закрытие пикера) и дальше работаем с ним.
private struct PickedMovie: Transferable {
    let url: URL

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(contentType: .movie) { movie in
            SentTransferredFile(movie.url)
        } importing: { received in
            let ext = received.file.pathExtension.isEmpty ? "mov" : received.file.pathExtension
            let copy = outgoingStagingDirectory().appendingPathComponent("\(UUID().uuidString).\(ext)")
            try FileManager.default.copyItem(at: received.file, to: copy)
            return PickedMovie(url: copy)
        }
    }
}

/// Штамп для имён фото/видео из галереи (у PhotosPicker нет исходного имени файла).
private let photoNameStamp: DateFormatter = {
    let formatter = DateFormatter()
    formatter.dateFormat = "yyyyMMdd-HHmmss"
    return formatter
}()

// MARK: - Полоса над композером: прогресс + очередь чипов

/// Полосы над полем ввода (порт bottomBar-колонки ChatScreen.kt): прогресс загрузки
/// вложений (полоса + процент + отмена) и очередь вложений — миниатюры/чипы с
/// крестиками; подпись набирается в самом поле ввода.
struct ComposerAttachmentsBar: View {
    let staged: [OutgoingFile]
    /// 0..1; nil — аплоад не идёт (зеркало ui.uploadProgress вью-модели).
    let uploadProgress: Float?
    let onRemoveStaged: (Int) -> Void
    let onCancelUpload: () -> Void
    /// Тап по чипу картинки — открыть её в редакторе.
    var onEditStaged: ((Int) -> Void)?

    var body: some View {
        VStack(spacing: 0) {
            // Полоса прогресса осталась только секретному пути: в обычном чате прогресс и
            // отмена живут на самом пузыре в ленте (ui.outgoing), а композер в это время
            // свободен — как в вебе, где отправляемое сразу видно в переписке.
            if let progress = uploadProgress {
                HStack(spacing: 10) {
                    ProgressView(value: Double(min(max(progress, 0), 1)))
                        .progressViewStyle(.linear)
                        .tint(Eb.brand)
                    Text("\(Int(progress * 100))%")
                        .font(.caption)
                        .foregroundStyle(Eb.textMuted)
                    Button(action: onCancelUpload) {
                        Image(systemName: "xmark")
                            .font(.system(size: 12, weight: .bold))
                            .foregroundStyle(Eb.textMuted)
                            .frame(width: 28, height: 28)
                    }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 4)
                .background(Eb.surface200)
            }
            // Очередь вложений: чипы с крестиками. Чистится в момент отправки (веб-паритет):
            // собранное тут же встаёт пузырём в ленте, а сбой ждёт повтора там же, а не здесь.
            if !staged.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(Array(staged.enumerated()), id: \.element.id) { i, f in
                            stagedChip(f, index: i)
                        }
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                }
                .background(Eb.surface200)
            }
        }
    }

    // Чип: картинка — миниатюрой 64×64 (тап — в редактор), прочее — иконка + имя 96×64.
    private func stagedChip(_ f: OutgoingFile, index: Int) -> some View {
        ZStack(alignment: .topTrailing) {
            if f.mime.hasPrefix("image/") {
                StagedThumb(data: f.bytes)
                    .overlay(alignment: .bottomLeading) {
                        Image(systemName: "pencil")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundStyle(.white)
                            .frame(width: 18, height: 18)
                            .background(Color.black.opacity(0.6), in: Circle())
                            .padding(2)
                    }
                    .contentShape(Rectangle())
                    .onTapGesture { onEditStaged?(index) }
            } else {
                VStack(alignment: .leading, spacing: 3) {
                    Image(systemName: f.mime.hasPrefix("video/") ? "play.circle.fill" : "doc.fill")
                        .font(.system(size: 16))
                        .foregroundStyle(Eb.textMuted)
                    Text(f.name)
                        .font(.system(size: 10))
                        .foregroundStyle(Eb.textPrimary)
                        .lineLimit(2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(6)
                .frame(width: 96, height: 64, alignment: .leading)
                .background(Eb.surface300, in: RoundedRectangle(cornerRadius: 10))
            }
            // Крестик удаления поверх угла чипа.
            Button {
                onRemoveStaged(index)
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 18, height: 18)
                    .background(Color.black.opacity(0.6), in: Circle())
            }
            .padding(2)
        }
    }
}

/// Миниатюра чипа картинки: полноразмер (байты бывают до 25 МБ) декодится ОДИН раз в
/// фоне и ужимается — иначе каждый проход body жевал бы мегабайты на главном потоке
/// (роль Coil AsyncImage(model = bytes) из Kotlin).
private struct StagedThumb: View {
    let data: Data
    @State private var thumb: UIImage?

    var body: some View {
        Group {
            if let thumb {
                Image(uiImage: thumb)
                    .resizable()
                    .scaledToFill()
            } else {
                Rectangle().fill(Eb.surface300)
            }
        }
        .frame(width: 64, height: 64)
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .task(id: data.count) {
            guard thumb == nil else { return }
            let source = data
            thumb = await Task.detached(operation: {
                UIImage(data: source)?.preparingThumbnail(of: CGSize(width: 128, height: 128))
            }).value
        }
    }
}

// MARK: - Накладка отправляемого пузыря (прогресс, отмена, повтор)

/// Что показать поверх оптимистичного пузыря и что делать с ним. Едет через окружение:
/// пузырь сидит глубоко внутри MessageRow, и протаскивать это через всю его сигнатуру не
/// за что — тем же приёмом туда попадают превью цитат (replyQuotePreviews).
struct OutgoingUploadBadge {
    var state: OutgoingUpload?
    var onCancel: () -> Void = {}
    var onRetry: () -> Void = {}
    var onDiscard: () -> Void = {}
}

private struct OutgoingUploadKey: EnvironmentKey {
    static let defaultValue = OutgoingUploadBadge()
}

extension EnvironmentValues {
    var outgoingUpload: OutgoingUploadBadge {
        get { self[OutgoingUploadKey.self] }
        set { self[OutgoingUploadKey.self] = newValue }
    }
}

/// Накладка на ещё не отправленный пузырь: пока грузится — затемнение, кольцо прогресса с
/// процентами и крестик отмены (в вебе прогресс наливается прямо поверх картинки,
/// ChatMessageRow.tsx:1016); если упало — «Не отправилось» с повтором и удалением.
/// Затемнение заодно съедает тапы: открывать просмотрщик на ещё не отправленном кадре
/// нечем, а долгое нажатие предлагало бы переслать несуществующее сообщение.
struct OutgoingUploadOverlay: View {
    let badge: OutgoingUploadBadge

    var body: some View {
        if let state = badge.state {
            ZStack {
                Color.black.opacity(state.failed ? 0.4 : 0.35)
                if state.failed {
                    failedControls
                } else {
                    progressRing(state.progress)
                }
            }
            .contentShape(Rectangle())
            .clipShape(RoundedRectangle(cornerRadius: 14))
        }
    }

    private var failedControls: some View {
        VStack(spacing: 6) {
            Text("Не отправилось")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.white)
            // Причина — на самом пузыре: баннер над композером показывает только ПОСЛЕДНЮЮ
            // ошибку, а упавших отправок может висеть несколько, каждая со своей.
            if let reason = badge.state?.error, !reason.isEmpty {
                Text(reason)
                    .font(.system(size: 11))
                    .foregroundStyle(.white.opacity(0.85))
                    .multilineTextAlignment(.center)
                    .lineLimit(2)
                    .padding(.horizontal, 10)
            }
            HStack(spacing: 8) {
                Button(action: badge.onRetry) {
                    Label("Повторить", systemImage: "arrow.clockwise")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .background(.black.opacity(0.55), in: Capsule())
                }
                .buttonStyle(.plain)
                Button(action: badge.onDiscard) {
                    Image(systemName: "trash")
                        .font(.system(size: 13, weight: .bold))
                        .foregroundStyle(.white)
                        .frame(width: 30, height: 30)
                        .background(.black.opacity(0.55), in: Circle())
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func progressRing(_ progress: Float) -> some View {
        // Кольцо всегда чуть-чуть залито (0.02): на нулевом прогрессе пустой круг читался
        // бы как «ничего не происходит».
        let value = CGFloat(min(max(progress, 0), 1))
        return Button(action: badge.onCancel) {
            ZStack {
                Circle()
                    .fill(.black.opacity(0.55))
                    .frame(width: 58, height: 58)
                Circle()
                    .stroke(Color.white.opacity(0.25), lineWidth: 3)
                    .frame(width: 46, height: 46)
                Circle()
                    .trim(from: 0, to: max(0.02, value))
                    .stroke(Color.white, style: StrokeStyle(lineWidth: 3, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                    .frame(width: 46, height: 46)
                Image(systemName: "xmark")
                    .font(.system(size: 14, weight: .bold))
                    .foregroundStyle(.white)
            }
            .overlay(alignment: .bottom) {
                Text("\(Int(value * 100))%")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 1)
                    .background(.black.opacity(0.55), in: Capsule())
                    .offset(y: 14)
            }
        }
        .buttonStyle(.plain)
    }
}
