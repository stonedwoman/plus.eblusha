import SwiftUI
import AVFoundation
import UIKit

/// Порт `ui/social/QrScanner.kt`.
///
/// На Android это CameraX + zxing (НЕ ML Kit: он тянет Google Play Services, которых нет
/// на де-гуглённых устройствах — а именно там живёт большая часть аудитории). На iOS
/// декодер QR встроен в систему — AVCaptureSession + AVCaptureMetadataOutput, без
/// сторонних зависимостей. Первый распознанный код отдаётся в onResult ровно один раз,
/// после чего анализ останавливается.
struct QrScannerView: View {
    var onResult: (String) -> Void

    @State private var status = AVCaptureDevice.authorizationStatus(for: .video)

    var body: some View {
        switch status {
        case .authorized:
            QrCameraView(onResult: onResult)
        case .notDetermined:
            // Системный диалог разрешения; ответ переключает состояние без пересоздания вью.
            Color.black
                .onAppear {
                    AVCaptureDevice.requestAccess(for: .video) { granted in
                        DispatchQueue.main.async {
                            status = granted ? .authorized : .denied
                        }
                    }
                }
        default:
            VStack(spacing: 12) {
                Text("Чтобы отсканировать код, нужен доступ к камере.")
                    .font(.subheadline)
                    .foregroundStyle(Eb.textPrimary)
                    .multilineTextAlignment(.center)
                Button("Разрешить камеру") {
                    // Отказ уже дан — повторно спросить нельзя, ведём в настройки системы.
                    if let url = URL(string: UIApplication.openSettingsURLString) {
                        UIApplication.shared.open(url)
                    }
                }
                .buttonStyle(.borderedProminent)
                .tint(Eb.brand)
            }
            .padding(16)
            .frame(maxWidth: .infinity)
        }
    }
}

/// Готовый лист «Наведите камеру на QR»: заголовок + сканер + отмена
/// (зеркало обёртки сканера из ChatScreen.kt Android-клиента).
struct QrScanSheet: View {
    let onResult: (String) -> Void

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 12) {
            Text("Наведите камеру на QR")
                .font(.headline)
                .foregroundStyle(Eb.textPrimary)
                .padding(.top, 16)
            QrScannerView(onResult: onResult)
                .frame(maxWidth: .infinity)
                .frame(height: 300)
                .background(Color.black)
                .clipShape(RoundedRectangle(cornerRadius: 12))
                .padding(.horizontal, 16)
            Button("Отмена") { dismiss() }
                .buttonStyle(.bordered)
                .tint(Eb.textMuted)
                .padding(.bottom, 16)
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Eb.surface200)
        .presentationDetents([.medium])
    }
}

// MARK: - Камера

private struct QrCameraView: UIViewRepresentable {
    let onResult: (String) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onResult: onResult) }

    func makeUIView(context: Context) -> PreviewView {
        let view = PreviewView()
        // FILL_CENTER из оригинала: кадр заполняет рамку с обрезкой краёв.
        view.videoPreviewLayer.videoGravity = .resizeAspectFill
        context.coordinator.start(on: view)
        return view
    }

    func updateUIView(_ uiView: PreviewView, context: Context) {
        context.coordinator.onResult = onResult
    }

    static func dismantleUIView(_ uiView: PreviewView, coordinator: Coordinator) {
        // Аналог onDispose: закрыли экран — камера обязана погаснуть.
        coordinator.stop()
    }

    /// UIView, чей слой — AVCaptureVideoPreviewLayer (роль PreviewView из CameraX):
    /// системный слой сам следит за размером, отдельного layout-кода не нужно.
    final class PreviewView: UIView {
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
        var videoPreviewLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
    }

    final class Coordinator: NSObject, AVCaptureMetadataOutputObjectsDelegate {
        var onResult: (String) -> Void

        private let session = AVCaptureSession()
        /// Конфигурация и запуск — вне главного потока (startRunning блокирует),
        /// роль single-thread executor из оригинала.
        private let sessionQueue = DispatchQueue(label: "org.eblusha.qr-scanner")
        /// Однократность: события метаданных продолжают приходить и после успеха,
        /// поэтому колбэк защищён флагом, а не только остановкой камеры (порт delivered).
        private var delivered = false

        init(onResult: @escaping (String) -> Void) {
            self.onResult = onResult
        }

        func start(on view: PreviewView) {
            view.videoPreviewLayer.session = session
            sessionQueue.async {
                self.session.beginConfiguration()
                // DEFAULT_BACK_CAMERA из оригинала: обычная задняя камера.
                guard let device = AVCaptureDevice.default(for: .video),
                      let input = try? AVCaptureDeviceInput(device: device),
                      self.session.canAddInput(input) else {
                    self.session.commitConfiguration()
                    return
                }
                self.session.addInput(input)
                let output = AVCaptureMetadataOutput()
                guard self.session.canAddOutput(output) else {
                    self.session.commitConfiguration()
                    return
                }
                self.session.addOutput(output)
                output.setMetadataObjectsDelegate(self, queue: .main)
                // Типы ограничиваем ПОСЛЕ addOutput — до него список доступных пуст
                // (зеркало DecodeHintType.POSSIBLE_FORMATS = QR_CODE).
                output.metadataObjectTypes = [.qr]
                self.session.commitConfiguration()
                self.session.startRunning()
            }
        }

        func stop() {
            sessionQueue.async {
                if self.session.isRunning { self.session.stopRunning() }
            }
        }

        func metadataOutput(
            _ output: AVCaptureMetadataOutput,
            didOutput metadataObjects: [AVMetadataObject],
            from connection: AVCaptureConnection
        ) {
            guard !delivered,
                  let object = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
                  object.type == .qr,
                  let text = object.stringValue, !text.isEmpty else { return }
            delivered = true
            stop()
            onResult(text)
        }
    }
}
