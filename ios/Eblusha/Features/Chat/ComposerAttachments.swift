import SwiftUI
import PhotosUI
import UIKit
import UniformTypeIdentifiers

// Порт стейджинга вложений из `ui/chat/ChatScreen.kt` (pickAttachment / очередь чипов /
// прогресс аплоада). Веб-паритет: выбранное НЕ отправляется сразу — встаёт чипами над
// композером, подпись набирается после, отправка — кнопкой (мимо-тап не шлёт мгновенно).
// Вместо системного GetMultipleContents Android'а — два источника: PhotosPicker (до 10
// фото из галереи, без разрешения на всю библиотеку) и fileImporter (до 10 документов).

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
                Label("Фото", systemImage: "photo.on.rectangle")
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
        .photosPicker(
            isPresented: $showPhotosPicker,
            selection: $photoItems,
            maxSelectionCount: 10,
            matching: .images
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

    /// Читает выбор галереи в байты. Галерея не отдаёт исходное имя файла —
    /// генерим человекочитаемое по времени и порядку выбора.
    private func readPhotoItems(_ items: [PhotosPickerItem]) {
        reading = true
        // @MainActor: стейт и колбэки вью-модели трогаем только с главного;
        // тяжёлое (декод HEIC) уезжает в detached-задачи.
        Task { @MainActor in
            var files: [OutgoingFile] = []
            for (i, item) in items.enumerated() {
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
                let stamp = photoNameStamp.string(from: Date())
                files.append(OutgoingFile(
                    bytes: data, name: "photo-\(stamp)-\(i + 1).\(ext)", mime: mime
                ))
            }
            onPicked(files)
            reading = false
        }
    }

    /// Читает выбранные документы с диска (вне главного потока — файлы до 100 МБ).
    private func readFileURLs(_ urls: [URL]) {
        reading = true
        Task.detached {
            var files: [OutgoingFile] = []
            for url in urls {
                guard let file = readPickedFile(url) else {
                    await MainActor.run {
                        onError("Не удалось прочитать выбранные файлы")
                        reading = false
                    }
                    return
                }
                files.append(file)
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
private func readPickedFile(_ url: URL) -> OutgoingFile? {
    let scoped = url.startAccessingSecurityScopedResource()
    defer { if scoped { url.stopAccessingSecurityScopedResource() } }
    // Размер проверяем ДО чтения: многогигабайтное видео убивало бы процесс OOM-ом ещё до
    // проверки лимита в отправке (ревью).
    let declaredSize = (try? url.resourceValues(forKeys: [.fileSizeKey]))?.fileSize
    if let declaredSize, declaredSize > 100 * 1024 * 1024 { return nil }
    guard let data = try? Data(contentsOf: url) else { return nil }
    let mime = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType
        ?? "application/octet-stream"
    return OutgoingFile(bytes: data, name: url.lastPathComponent, mime: mime)
}

/// Штамп для имён фото из галереи (у PhotosPicker нет исходного имени файла).
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

    var body: some View {
        VStack(spacing: 0) {
            // Прогресс загрузки вложений: полоса + процент + отмена (веб-паритет).
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
            // Очередь вложений: чипы с крестиками (очередь чистится ТОЛЬКО при успехе
            // отправки — сбой/отмена оставляют чипы на месте).
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

    // Чип: картинка — миниатюрой 64×64, прочее — иконка + имя 96×64. Кнопка-карандаш
    // фоторедактора появится вместе с портом PhotoEditor (vm.replaceStaged уже готов).
    private func stagedChip(_ f: OutgoingFile, index: Int) -> some View {
        ZStack(alignment: .topTrailing) {
            if f.mime.hasPrefix("image/") {
                StagedThumb(data: f.bytes)
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
