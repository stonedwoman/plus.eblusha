import SwiftUI
import UIKit
import Photos
import UniformTypeIdentifiers

// Свой лист прикрепления вместо системного меню из двух пунктов. Путь «отправить фото»
// стоил двух полноэкранных переходов (меню → чужой пикер → наш редактор), и переписка
// пропадала с глаз дважды. Здесь последние кадры медиатеки лежат сразу под пальцем:
// выбор в порядке тапов с НОМЕРАМИ на кадрах (порядок кадров и есть порядок альбома),
// под сеткой — «Фото или видео» (системный пикер на весь архив), «Камера», «Файл».
//
// Лист НИЧЕГО не отправляет: по «Отправить N» он закрывается и отдаёт выбранное наверх
// тем же колбэком, что и раньше (onPicked → ChatComposer.openPicked → картинки в
// редактор, прочее в очередь чипов). Веб-паритет сохранён: улетает всё только кнопкой
// композера, подпись набирается в поле ввода.
//
// Цена своей сетки — разрешение на медиатеку, которого системный PhotosPicker не просит.
// Поэтому: спрашиваем ОДИН раз и только по явному намерению (лист открыт тапом по
// скрепке), отказ не ломает ничего — строки под сеткой работают без доступа, а на месте
// сетки появляется объяснение и кнопка в настройки. Ограниченный доступ («выбранные
// фото») — полноценный режим: сетка показывает разрешённое, отдельная строка зовёт
// системный докладчик «выбрать ещё».

/// Сколько последних кадров тянем в сетку. Это «последние», а не «вся медиатека»: за
/// полным архивом есть строка «Фото или видео» с системным пикером, а держать в памяти
/// тысячи PHAsset и их миниатюры ради прокрутки вниз незачем.
private let attachmentSheetFetchLimit = 150

/// Потолок выбора за раз — тот же, что был у системного пикера (maxSelectionCount: 10)
/// и что переваривает очередь вью-модели (10 картинок + 10 прочих).
private let attachmentSheetSelectionLimit = 10

/// Размер миниатюры в ПИКСЕЛЯХ (PHImageManager меряет в них, а не в точках): плитка
/// шириной ~130 pt на @3x просит ~390 px, но для сетки хватает и меньшего — лишние
/// пиксели стоят памяти на каждом кадре.
private let attachmentTileTargetSize = CGSize(width: 240, height: 240)

/// Опции миниатюры — ОДИН объект на всё приложение, и для предзагрузки, и для запроса
/// плитки: PHCachingImageManager отдаёт кэш только при совпадающих опциях, а
/// PHImageRequestOptions — обычный класс без сравнения по значению, так что от новых
/// экземпляров кэш считал бы запросы разными и стал бы мёртвым грузом. Photos копирует
/// опции себе, поэтому общий экземпляр безопасен.
///
/// `.highQualityFormat` выбран не за качество, а за то, что колбэк зовётся ровно один раз
/// (у `.opportunistic` их несколько, и continuation упала бы на втором).
/// Сеть выключена намеренно: миниатюры лежат локально даже при «оптимизации хранилища»,
/// а тянуть оригинал из iCloud ради плитки — трафик на пустом месте.
private let attachmentTileOptions: PHImageRequestOptions = {
    let options = PHImageRequestOptions()
    options.deliveryMode = .highQualityFormat
    options.resizeMode = .fast
    options.isNetworkAccessAllowed = false
    options.isSynchronous = false
    return options
}()

// MARK: - Источник кадров

/// Последние кадры медиатеки + состояние доступа. Отдельным объектом, а не @State листа:
/// доступ спрашивается один раз, а кэш миниатюр должен пережить перестроения тела.
@MainActor
final class RecentMediaLibrary: ObservableObject {

    /// Кадры от новых к старым (при ограниченном доступе — только разрешённые).
    @Published private(set) var assets: [PHAsset] = []
    @Published private(set) var status: PHAuthorizationStatus = .notDetermined
    /// Первый заход закончился — до него сетка показывает спиннер, а не «пусто».
    @Published private(set) var loaded = false

    /// Кэширующий менеджер: без него прокрутка сетки на тысяче фото идёт рывками —
    /// каждая плитка декодировалась бы заново в момент появления.
    let imageManager = PHCachingImageManager()
    private var caching = false

    var canRead: Bool { status == .authorized || status == .limited }

    /// Спрашиваем доступ и забираем последние кадры. Зовётся из `.task` листа, то есть
    /// системный запрос показывается только тому, кто уже нажал скрепку.
    func load() async {
        var current = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        if current == .notDetermined {
            current = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
        }
        status = current
        guard current == .authorized || current == .limited else {
            assets = []
            loaded = true
            return
        }
        let options = PHFetchOptions()
        options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
        // Только фото и видео: аудио и «прочее» медиатеки в чат всё равно уходят файлом.
        options.predicate = NSPredicate(
            format: "mediaType == %d OR mediaType == %d",
            PHAssetMediaType.image.rawValue,
            PHAssetMediaType.video.rawValue
        )
        options.fetchLimit = attachmentSheetFetchLimit
        let result = PHAsset.fetchAssets(with: options)
        // Разворачиваем в массив сразу: ForEach должен уметь считать и адресовать кадры,
        // а PHFetchResult этого не умеет.
        var list: [PHAsset] = []
        list.reserveCapacity(result.count)
        for index in 0..<result.count { list.append(result.object(at: index)) }
        stopCaching()
        assets = list
        loaded = true
        imageManager.startCachingImages(
            for: list,
            targetSize: attachmentTileTargetSize,
            contentMode: .aspectFill,
            options: attachmentTileOptions
        )
        caching = true
    }

    /// Гасим предзагрузку, когда лист ушёл с экрана: держать в памяти полторы сотни
    /// миниатюр после закрытия незачем.
    func stopCaching() {
        guard caching else { return }
        imageManager.stopCachingImagesForAllAssets()
        caching = false
    }

    /// Ограниченный доступ: системный докладчик «какие фото видит приложение».
    /// По закрытию перечитываем — иначе добавленные кадры в сетке не появятся.
    func presentLimitedPicker() {
        guard let top = PhotoViewerActions.topViewController() else { return }
        PHPhotoLibrary.shared().presentLimitedLibraryPicker(from: top) { _ in
            Task { @MainActor in await self.load() }
        }
    }
}

// MARK: - Лист

/// Содержимое листа прикрепления. Про камеру, системный пикер и файлы лист ничего не
/// знает — он только зовёт колбэки владельца (AttachmentPickerButton), который закроет
/// лист и откроет нужное с задержкой (два модальных показа подряд SwiftUI склеивает).
struct AttachmentSheetView: View {

    /// Показывать ли строку «Камера» (на симуляторе и без колбэка её нет).
    let cameraAvailable: Bool
    /// Выбранные кадры в порядке тапов — этот же порядок станет порядком альбома.
    let onPickAssets: ([PHAsset]) -> Void
    let onSystemPicker: () -> Void
    let onCamera: () -> Void
    let onFiles: () -> Void

    @StateObject private var library = RecentMediaLibrary()
    /// localIdentifier'ы в порядке ВЫБОРА, а не в порядке медиатеки: из него берутся
    /// номера на кадрах и порядок файлов в альбоме.
    @State private var selected: [String] = []

    private let columns = Array(
        repeating: GridItem(.flexible(), spacing: 2), count: 3
    )

    var body: some View {
        VStack(spacing: 0) {
            gallery
            Divider().overlay(Eb.border)
            actions
            if !selected.isEmpty { sendBar }
        }
        .background(Eb.surface200)
        .animation(.spring(response: 0.3, dampingFraction: 0.85), value: selected.isEmpty)
        // Полудетент — чтобы переписка осталась видимой сверху (ради этого лист и
        // затевался); тянется до полного для долгой прокрутки сетки.
        .presentationDetents([.fraction(0.72), .large])
        .presentationDragIndicator(.visible)
        .presentationBackground(Eb.surface200)
        .task { await library.load() }
        .onDisappear { library.stopCaching() }
    }

    // MARK: Сетка / состояния доступа

    @ViewBuilder
    private var gallery: some View {
        if !library.loaded {
            placeholder { ProgressView().tint(Eb.textMuted) }
        } else if library.canRead {
            if library.assets.isEmpty {
                placeholder {
                    Text("В медиатеке пока нет снимков")
                        .font(.subheadline)
                        .foregroundStyle(Eb.textMuted)
                }
            } else {
                ScrollView {
                    LazyVGrid(columns: columns, spacing: 2) {
                        ForEach(library.assets, id: \.localIdentifier) { asset in
                            AttachmentSheetTile(
                                asset: asset,
                                manager: library.imageManager,
                                number: number(of: asset),
                                onTap: { toggle(asset) }
                            )
                        }
                    }
                    .padding(.horizontal, 2)
                    .padding(.top, 2)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        } else {
            placeholder { deniedExplanation }
        }
    }

    /// Отказ — не тупик: строки под сеткой работают без всякого доступа, поэтому текст
    /// объясняет и это, а не только ведёт в настройки.
    private var deniedExplanation: some View {
        VStack(spacing: 10) {
            Image(systemName: "photo.on.rectangle.angled")
                .font(.system(size: 34))
                .foregroundStyle(Eb.textMuted)
            Text("Доступ к медиатеке закрыт")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Eb.textPrimary)
            Text("Разрешите доступ к фото — и последние кадры будут прямо здесь. Без него выбрать снимок всё равно можно: «Фото или видео» ниже.")
                .font(.system(size: 13))
                .foregroundStyle(Eb.textMuted)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            Button {
                // Отказ уже дан — второй раз система не спросит, ведём в настройки.
                if let url = URL(string: UIApplication.openSettingsURLString) {
                    UIApplication.shared.open(url)
                }
            } label: {
                // Собственная метка, а не Button(title:): у стандартного стиля цвет берётся
                // из tint, и Eb.brand через foregroundStyle до текста бы не дошёл.
                Text("Открыть настройки")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Eb.brand)
            }
            .buttonStyle(.plain)
            .padding(.top, 2)
        }
        .padding(.horizontal, 28)
    }

    private func placeholder<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        VStack {
            Spacer(minLength: 0)
            content()
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: Строки под сеткой

    private var actions: some View {
        VStack(spacing: 0) {
            if selected.count >= attachmentSheetSelectionLimit {
                Text("Больше \(attachmentSheetSelectionLimit) кадров за раз не уйдёт")
                    .font(.system(size: 11))
                    .foregroundStyle(Eb.textMuted)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 16)
                    .padding(.top, 8)
            }
            // Ограниченный доступ: дать добавить кадров, не уходя в настройки.
            if library.status == .limited {
                row("Выбрать ещё фото", icon: "photo.badge.plus") {
                    library.presentLimitedPicker()
                }
            }
            row("Фото или видео", icon: "photo.on.rectangle", action: onSystemPicker)
            if cameraAvailable {
                row("Камера", icon: "camera", action: onCamera)
            }
            row("Файл", icon: "doc", action: onFiles)
        }
        .padding(.vertical, 4)
    }

    private func row(_ title: String, icon: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 14) {
                Image(systemName: icon)
                    .font(.system(size: 18))
                    .foregroundStyle(Eb.brand)
                    .frame(width: 30, height: 30)
                Text(title)
                    .font(.system(size: 16))
                    .foregroundStyle(Eb.textPrimary)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 16)
            .frame(height: 48)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    /// «Отправить N» — счётчик прямо в кнопке: сколько кадров уйдёт, видно до закрытия
    /// листа. Отправки как таковой тут нет (картинки ещё пройдут редактор), но для
    /// человека это именно отправка — она продолжится сама.
    private var sendBar: some View {
        Button {
            let assets = selectedAssets
            guard !assets.isEmpty else { return }
            selected = []
            onPickAssets(assets)
        } label: {
            Text("Отправить \(selected.count)")
                .font(.system(size: 16, weight: .semibold).monospacedDigit())
                .foregroundStyle(.white)
                .frame(maxWidth: .infinity)
                .frame(height: 48)
                .background(Eb.brand, in: RoundedRectangle(cornerRadius: 12))
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 12)
        .padding(.top, 4)
        .padding(.bottom, 10)
        .transition(.move(edge: .bottom).combined(with: .opacity))
    }

    // MARK: Выбор

    private func number(of asset: PHAsset) -> Int? {
        guard let index = selected.firstIndex(of: asset.localIdentifier) else { return nil }
        return index + 1
    }

    private func toggle(_ asset: PHAsset) {
        let id = asset.localIdentifier
        if let index = selected.firstIndex(of: id) {
            // Снятие выбора из середины перенумеровывает хвост — номера считаются от
            // позиции в списке, а не хранятся на кадрах.
            selected.remove(at: index)
        } else {
            guard selected.count < attachmentSheetSelectionLimit else {
                UINotificationFeedbackGenerator().notificationOccurred(.warning)
                return
            }
            selected.append(id)
        }
        UISelectionFeedbackGenerator().selectionChanged()
    }

    /// Кадры в порядке выбора (а не в порядке медиатеки).
    private var selectedAssets: [PHAsset] {
        let byId = Dictionary(
            library.assets.map { ($0.localIdentifier, $0) }, uniquingKeysWith: { first, _ in first }
        )
        return selected.compactMap { byId[$0] }
    }
}

// MARK: - Плитка кадра

/// Квадрат медиатеки с номером выбора. Номер, а не галочка: он отвечает сразу на два
/// вопроса — что уйдёт и в каком порядке собеседник это увидит.
private struct AttachmentSheetTile: View {

    let asset: PHAsset
    let manager: PHCachingImageManager
    /// Номер в порядке выбора; nil — кадр не выбран.
    let number: Int?
    let onTap: () -> Void

    @State private var image: UIImage?
    /// Для какого кадра лежит картинка. Ячейки сетки переиспользуются, и без ключа
    /// уехавшая плитка показала бы чужой снимок (та же ловушка, что с resolvedFor).
    @State private var loadedFor = ""

    var body: some View {
        Color.clear
            .aspectRatio(1, contentMode: .fit)
            .overlay {
                if let image {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFill()
                } else {
                    Eb.surface300
                }
            }
            .clipped()
            .overlay(alignment: .bottomLeading) { durationBadge }
            .clipShape(RoundedRectangle(cornerRadius: 6))
            // Выбранный кадр поджимается и обводится — видно даже когда номер закрыт
            // пальцем.
            .scaleEffect(number == nil ? 1 : 0.9)
            .overlay {
                RoundedRectangle(cornerRadius: 6)
                    .stroke(Eb.brand, lineWidth: number == nil ? 0 : 2)
                    .scaleEffect(number == nil ? 1 : 0.9)
            }
            .overlay(alignment: .topTrailing) { numberBadge }
            .contentShape(Rectangle())
            .onTapGesture(perform: onTap)
            .animation(.spring(response: 0.3, dampingFraction: 0.62), value: number)
            .task(id: asset.localIdentifier) {
                guard loadedFor != asset.localIdentifier || image == nil else { return }
                loadedFor = asset.localIdentifier
                image = nil
                let wanted = asset.localIdentifier
                let loaded = await requestTileImage(manager, asset: asset)
                // Пока грузили, ячейка могла уехать под другой кадр.
                guard loadedFor == wanted else { return }
                image = loaded
            }
    }

    @ViewBuilder
    private var numberBadge: some View {
        if let number {
            Text("\(number)")
                .font(.system(size: 13, weight: .bold).monospacedDigit())
                .foregroundStyle(.white)
                .frame(width: 26, height: 26)
                .background(Eb.brand, in: Circle())
                .overlay(Circle().stroke(.white.opacity(0.9), lineWidth: 1.5))
                .padding(6)
                // Пружиной из точки: появление номера — ответ на тап, его надо заметить.
                .transition(.scale(scale: 0.2).combined(with: .opacity))
        }
    }

    @ViewBuilder
    private var durationBadge: some View {
        if asset.mediaType == .video {
            HStack(spacing: 3) {
                Image(systemName: "play.fill")
                    .font(.system(size: 8, weight: .bold))
                Text(attachmentDurationText(asset.duration))
                    .font(.system(size: 11, weight: .semibold).monospacedDigit())
            }
            .foregroundStyle(.white)
            .padding(.horizontal, 5)
            .padding(.vertical, 2)
            .background(.black.opacity(0.55), in: Capsule())
            .padding(4)
        }
    }
}

/// Миниатюра плитки. Континуация резюмируется ровно один раз — за это отвечает
/// `.highQualityFormat` в опциях (см. attachmentTileOptions).
@MainActor
private func requestTileImage(_ manager: PHImageManager, asset: PHAsset) async -> UIImage? {
    await withCheckedContinuation { (continuation: CheckedContinuation<UIImage?, Never>) in
        manager.requestImage(
            for: asset,
            targetSize: attachmentTileTargetSize,
            contentMode: .aspectFill,
            options: attachmentTileOptions
        ) { image, _ in
            continuation.resume(returning: image)
        }
    }
}

/// Длительность ролика в «м:сс» / «ч:мм:сс».
private func attachmentDurationText(_ seconds: Double) -> String {
    let total = Int(seconds.rounded())
    let hours = total / 3600
    let minutes = (total % 3600) / 60
    let secs = total % 60
    if hours > 0 { return String(format: "%d:%02d:%02d", hours, minutes, secs) }
    return String(format: "%d:%02d", minutes, secs)
}

// MARK: - Чтение выбранных кадров в OutgoingFile

/// Отказ при чтении кадра, с ГОТОВЫМ текстом для баннера (String сам по себе Error не
/// является, а заводить общий тип ошибок ради одного текста незачем).
struct AssetPickFailure: Error {
    let message: String
}

/// Выбранные кадры → готовые к отправке файлы, в ТОМ ЖЕ порядке. Всё-или-ничего, как у
/// остальных входов (readPickedFile / readPhotoItems): недочитанный набор не стейджится
/// частично, а причина отказа уходит готовым текстом в общий баннер.
@MainActor
func readPickedAssets(_ assets: [PHAsset]) async -> Result<[OutgoingFile], AssetPickFailure> {
    var files: [OutgoingFile] = []
    let stamp = photoNameStamp.string(from: Date())
    for (index, asset) in assets.enumerated() {
        let isVideo = asset.mediaType == .video
        let fallback = "\(isVideo ? "video" : "photo")-\(stamp)-\(index + 1)"
        let outcome: Result<OutgoingFile, AssetPickFailure>
        if isVideo {
            outcome = await readVideoAsset(asset, fallbackName: fallback)
        } else {
            outcome = await readImageAsset(asset, fallbackName: fallback)
        }
        switch outcome {
        case .success(let file):
            files.append(file)
        case .failure(let failure):
            return .failure(failure)
        }
    }
    return .success(files)
}

/// Снимок — байтами оригинала (а не перерисованным UIImage): так целы EXIF и качество.
/// `.version = .current` — с правками из «Фото», то есть ровно тот кадр, который человек
/// видел в сетке.
@MainActor
private func readImageAsset(_ asset: PHAsset, fallbackName: String) async -> Result<OutgoingFile, AssetPickFailure> {
    let options = PHImageRequestOptions()
    options.version = .current
    options.deliveryMode = .highQualityFormat
    // Здесь сеть НУЖНА: оригинал может лежать только в iCloud, и без неё выбранный в
    // сетке кадр молча не отправился бы.
    options.isNetworkAccessAllowed = true
    options.isSynchronous = false
    let loaded: (Data?, String?) = await withCheckedContinuation {
        (continuation: CheckedContinuation<(Data?, String?), Never>) in
        PHImageManager.default().requestImageDataAndOrientation(
            for: asset, options: options
        ) { data, uti, _, _ in
            continuation.resume(returning: (data, uti))
        }
    }
    let original = originalFileName(of: asset)
    guard var data = loaded.0 else {
        return .failure(AssetPickFailure(message: "Не удалось прочитать «\(original ?? fallbackName)»"))
    }
    let type = loaded.1.flatMap { UTType($0) }
    var mime = type?.preferredMIMEType ?? "image/jpeg"
    var ext = type?.preferredFilenameExtension ?? "jpg"
    // HEIC/HEIF не рендерится ни вебом, ни Android-клиентом — перекодируем в JPEG
    // (ровно то же делает путь системного пикера).
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
    let name = attachmentFileName(base: original, fallback: fallbackName, ext: ext)
    if Int64(data.count) > attachmentSizeLimitBytes {
        return .failure(AssetPickFailure(
            message: oversizeAttachmentMessage(name: name, bytes: Int64(data.count))
        ))
    }
    return .success(OutgoingFile(bytes: data, name: name, mime: mime))
}

/// Ролик выгружаем ФАЙЛОМ на диск и читаем отображением (mmap): `requestImageData` для
/// видео не годится, а поднимать полугигабайтный ролик в память целиком — верный способ
/// потерять процесс раньше, чем дело дойдёт до проверки размера.
@MainActor
private func readVideoAsset(_ asset: PHAsset, fallbackName: String) async -> Result<OutgoingFile, AssetPickFailure> {
    let resources = PHAssetResource.assetResources(for: asset)
    // .fullSizeVideo — результат правки в «Фото» (обрезка, замедление): отправляем то,
    // что человек видит, а не исходник до правок.
    guard let resource = resources.first(where: { $0.type == .fullSizeVideo })
        ?? resources.first(where: { $0.type == .video })
        ?? resources.first else {
        return .failure(AssetPickFailure(message: "Не удалось прочитать «\(fallbackName)»"))
    }
    let rawExt = (resource.originalFilename as NSString).pathExtension.lowercased()
    let ext = rawExt.isEmpty ? "mov" : rawExt
    let mime = UTType(filenameExtension: ext)?.preferredMIMEType ?? "video/quicktime"
    let name = attachmentFileName(base: resource.originalFilename, fallback: fallbackName, ext: ext)

    pruneOutgoingStaging()
    let url = outgoingStagingDirectory().appendingPathComponent("\(UUID().uuidString)-\(name)")
    // writeData отказывается писать поверх существующего файла.
    try? FileManager.default.removeItem(at: url)
    let options = PHAssetResourceRequestOptions()
    options.isNetworkAccessAllowed = true
    let failure: Error? = await withCheckedContinuation {
        (continuation: CheckedContinuation<Error?, Never>) in
        PHAssetResourceManager.default().writeData(for: resource, toFile: url, options: options) { error in
            continuation.resume(returning: error)
        }
    }
    if failure != nil {
        try? FileManager.default.removeItem(at: url)
        return .failure(AssetPickFailure(message: "Не удалось прочитать «\(name)»"))
    }
    let size = (try? url.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0
    if Int64(size) > attachmentSizeLimitBytes {
        try? FileManager.default.removeItem(at: url)
        return .failure(AssetPickFailure(
            message: oversizeAttachmentMessage(name: name, bytes: Int64(size))
        ))
    }
    guard let data = try? Data(contentsOf: url, options: .mappedIfSafe) else {
        return .failure(AssetPickFailure(message: "Не удалось прочитать «\(name)»"))
    }
    return .success(OutgoingFile(bytes: data, name: name, mime: mime))
}

/// Исходное имя файла кадра (у медиатеки оно есть, в отличие от системного пикера).
private func originalFileName(of asset: PHAsset) -> String? {
    PHAssetResource.assetResources(for: asset).first?.originalFilename
}

/// Имя вложения: исходное, но с расширением ПОД ФАКТИЧЕСКИЙ формат — после
/// перекодировки HEIC→JPEG имя «IMG_0001.HEIC» врало бы и серверу, и получателю.
private func attachmentFileName(base: String?, fallback: String, ext: String) -> String {
    let source = base ?? fallback
    let stem = (source as NSString).deletingPathExtension
    let cleaned = stem.replacingOccurrences(of: "/", with: "-").replacingOccurrences(of: ":", with: "-")
    return "\(cleaned.isEmpty ? fallback : cleaned).\(ext)"
}
