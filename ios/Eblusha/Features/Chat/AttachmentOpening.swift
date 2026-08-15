import AVKit
import QuickLook
import SwiftUI

// Открытие вложений: видео проигрывается, файл уходит в системный просмотр/«Поделиться».
// В Kotlin это делал ChatScreen (AttachmentView → Intent.ACTION_VIEW); здесь тот же смысл
// нативными средствами. Секретные вложения перед показом расшифровываются в кэш-файл.

/// Что открыть поверх чата: локальный файл (расшифрованный или скачанный) либо прямой URL.
struct AttachmentPreview: Identifiable {
    let id = UUID()
    let url: URL
    let isVideo: Bool
}

/// Плеер видео на весь экран.
struct VideoPlayerSheet: View {
    let url: URL
    let onClose: () -> Void

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Color.black.ignoresSafeArea()
            VideoPlayer(player: AVPlayer(url: url))
                .ignoresSafeArea()
            Button(action: onClose) {
                Image(systemName: "xmark")
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(.white)
                    .padding(12)
                    .background(.black.opacity(0.45), in: Circle())
            }
            .padding(16)
        }
    }
}

/// Системный предпросмотр документа (QuickLook) с кнопкой «Поделиться».
struct DocumentPreviewSheet: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> UINavigationController {
        let controller = QLPreviewController()
        controller.dataSource = context.coordinator
        return UINavigationController(rootViewController: controller)
    }

    func updateUIViewController(_ controller: UINavigationController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(url: url) }

    final class Coordinator: NSObject, QLPreviewControllerDataSource {
        let url: URL
        init(url: URL) { self.url = url }
        func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }
        func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem {
            url as NSURL
        }
    }
}

enum AttachmentOpener {
    /// Готовит вложение к показу: секретное расшифровывает, обычное скачивает во временный
    /// файл (QuickLook и AVPlayer по сетевому URL с авторизацией не работают — прокси
    /// /api/files отдаёт содержимое только по токену).
    @MainActor
    static func prepare(
        _ att: MessageAttachment,
        decryptSecret: ((MessageAttachment) async -> URL?)?
    ) async -> AttachmentPreview? {
        let isVideo = att.type == "VIDEO"
        if att.secretNonce != nil, let decryptSecret {
            guard let local = await decryptSecret(att) else { return nil }
            return AttachmentPreview(url: local, isVideo: isVideo)
        }
        guard let resolved = resolveMediaUrl(att.url), let remote = URL(string: resolved) else {
            return nil
        }
        guard let local = await download(remote, suggestedName: att.name) else { return nil }
        return AttachmentPreview(url: local, isVideo: isVideo)
    }

    private static func download(_ url: URL, suggestedName: String?) async -> URL? {
        var request = URLRequest(url: url)
        // Прокси файлов требует тот же bearer, что и остальной API.
        if let token = AppContainer.shared.sessionStore.currentAccessToken() {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        do {
            let (tmp, _) = try await URLSession.shared.download(for: request)
            // Имя из сообщения — чтобы в просмотре и «Поделиться» файл назывался по-людски.
            let name = (suggestedName?.isEmpty == false ? suggestedName! : url.lastPathComponent)
            let destination = FileManager.default.temporaryDirectory
                .appendingPathComponent("eb-attach-\(UUID().uuidString)")
                .appendingPathComponent(name)
            try FileManager.default.createDirectory(
                at: destination.deletingLastPathComponent(), withIntermediateDirectories: true
            )
            try FileManager.default.moveItem(at: tmp, to: destination)
            return destination
        } catch {
            NSLog("AttachmentOpener: не удалось скачать вложение: %@", String(describing: error))
            return nil
        }
    }
}

/// Картинка секретного чата: по своему url лежит шифртекст, поэтому рисуем её только
/// после расшифровки ключом треда в локальный файл (порт rememberSecretDecrypted).
struct SecretImageView: View {
    let att: MessageAttachment
    let decrypt: ((MessageAttachment) async -> URL?)?

    @State private var local: URL?
    @State private var failed = false

    var body: some View {
        Group {
            if let local, let image = UIImage(contentsOfFile: local.path) {
                Image(uiImage: image).resizable().scaledToFill()
            } else if failed {
                ZStack {
                    Rectangle().fill(Eb.surface300)
                    Image(systemName: "lock.slash")
                        .foregroundStyle(Eb.textMuted)
                }
            } else {
                ZStack {
                    Rectangle().fill(Eb.surface300)
                    ProgressView()
                }
            }
        }
        .task(id: att.url) {
            guard local == nil, let decrypt else { return }
            if let url = await decrypt(att) { local = url } else { failed = true }
        }
    }
}
