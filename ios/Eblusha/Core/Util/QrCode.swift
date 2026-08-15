import CoreImage
import UIKit

// Порт `core/util/QrCode.kt`.

/// Кодирует [content] в чёрно-белый QR `UIImage`, либо nil при сбое кодирования.
/// Вместо ZXing — системный CoreImage (CIQRCodeGenerator) с той же коррекцией «H».
/// Мелкая матрица растягивается до [size] БЕЗ сглаживания (samplingNearest) —
/// линейная интерполяция размывала бы модули QR, и сканеры его не читали бы.
func generateQrImage(_ content: String, size: CGFloat = 640) -> UIImage? {
    guard let data = content.data(using: .utf8),
          let filter = CIFilter(name: "CIQRCodeGenerator")
    else { return nil }
    filter.setValue(data, forKey: "inputMessage")
    filter.setValue("H", forKey: "inputCorrectionLevel")
    guard let output = filter.outputImage, output.extent.width > 0 else { return nil }
    let scale = size / output.extent.width
    let scaled = output
        .samplingNearest()
        .transformed(by: CGAffineTransform(scaleX: scale, y: scale))
    guard let cg = CIContext().createCGImage(scaled, from: scaled.extent) else { return nil }
    return UIImage(cgImage: cg)
}
