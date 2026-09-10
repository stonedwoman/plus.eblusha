import SwiftUI
import UIKit
import CoreImage
import CoreImage.CIFilterBuiltins

/// Рендер документа редактора: цветокоррекция и размытие через Core Image, штрихи и
/// подписи через Core Graphics, в конце поворот, отражение и обрезка.
///
/// Один и тот же код рисует и итоговый файл, и превью: `render(item:maxDimension:)`
/// с маленьким пределом даёт быстрый кадр для экрана.
enum PhotoEditorRenderer {

    /// Контекст дорогой в создании — один на процесс.
    private static let ciContext = CIContext(options: [.useSoftwareRenderer: false])

    // MARK: - Цветокоррекция

    /// Кадр с применённой коррекцией. `maxDimension` уменьшает картинку до рендера —
    /// для превью на экране полный размер не нужен.
    static func adjusted(_ image: UIImage, _ adjustments: Adjustments, maxDimension: CGFloat? = nil) -> UIImage {
        let base = maxDimension.map { image.downscaled(maxDimension: $0) } ?? image
        guard !adjustments.isIdentity, var ci = CIImage(image: base) else { return base }

        if adjustments.brightness != 0 || adjustments.contrast != 0 || adjustments.saturation != 0 {
            let filter = CIFilter.colorControls()
            filter.inputImage = ci
            filter.brightness = Float(adjustments.brightness * 0.5)
            filter.contrast = Float(1 + adjustments.contrast)
            filter.saturation = Float(max(0, 1 + adjustments.saturation))
            ci = filter.outputImage ?? ci
        }
        if adjustments.warmth != 0 {
            let filter = CIFilter.temperatureAndTint()
            filter.inputImage = ci
            filter.neutral = CIVector(x: 6500, y: 0)
            filter.targetNeutral = CIVector(x: 6500 - adjustments.warmth * 2500, y: 0)
            ci = filter.outputImage ?? ci
        }
        if adjustments.sharpness > 0 {
            let filter = CIFilter.sharpenLuminance()
            filter.inputImage = ci
            filter.sharpness = Float(adjustments.sharpness * 1.5)
            ci = filter.outputImage ?? ci
        }
        if adjustments.vignette > 0 {
            let filter = CIFilter.vignette()
            filter.inputImage = ci
            filter.intensity = Float(adjustments.vignette * 2)
            filter.radius = Float(max(ci.extent.width, ci.extent.height) / 2)
            ci = filter.outputImage ?? ci
        }
        guard let cg = ciContext.createCGImage(ci, from: CGRect(origin: .zero, size: base.size)) else { return base }
        return UIImage(cgImage: cg, scale: base.scale, orientation: .up)
    }

    // MARK: - Размытие

    /// Мозаика на весь кадр — источник для штрихов размытия (маска накладывается поверх).
    static func pixelated(_ image: UIImage, blockFraction: CGFloat = 0.03) -> UIImage {
        guard let ci = CIImage(image: image) else { return image }
        let filter = CIFilter.pixellate()
        filter.inputImage = ci
        filter.scale = Float(max(6, image.size.width * blockFraction))
        filter.center = CGPoint(x: image.size.width / 2, y: image.size.height / 2)
        guard let output = filter.outputImage,
              let cg = ciContext.createCGImage(output, from: CGRect(origin: .zero, size: image.size))
        else { return image }
        return UIImage(cgImage: cg, scale: image.scale, orientation: .up)
    }

    /// Гауссово размытие на весь кадр — мягкий вариант для тех же штрихов.
    static func blurred(_ image: UIImage, radiusFraction: CGFloat = 0.02) -> UIImage {
        guard let ci = CIImage(image: image) else { return image }
        let filter = CIFilter.gaussianBlur()
        filter.inputImage = ci.clampedToExtent()
        filter.radius = Float(max(4, image.size.width * radiusFraction))
        guard let output = filter.outputImage,
              let cg = ciContext.createCGImage(output, from: CGRect(origin: .zero, size: image.size))
        else { return image }
        return UIImage(cgImage: cg, scale: image.scale, orientation: .up)
    }

    // MARK: - Итоговый кадр

    /// Полный конвейер. Координаты слоёв — нормализованные исходного кадра, поэтому
    /// рисуем всё на оригинале, а поворот/отражение/обрезку применяем в самом конце.
    /// Документ и кадр передаются явно: PhotoEditItem живёт на главном потоке, а рендер
    /// зовётся из фоновой задачи.
    static func render(document: PhotoEditDocument, image: UIImage, maxDimension: CGFloat = 4096) -> UIImage {
        let source = image.downscaled(maxDimension: maxDimension)
        if document.isPristine { return source }

        let size = source.size
        let base = adjusted(source, document.adjustments)

        // 1) Слои на оригинале.
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        let painted = UIGraphicsImageRenderer(size: size, format: format).image { context in
            let cg = context.cgContext
            base.draw(in: CGRect(origin: .zero, size: size))

            if !document.blurs.isEmpty {
                drawBlurs(document.blurs, source: base, in: cg, size: size)
            }
            if !document.strokes.isEmpty {
                drawStrokes(document.strokes, in: cg, size: size)
            }
            for sticker in document.stickers {
                drawSticker(sticker, in: cg, size: size)
            }
            for text in document.texts {
                drawText(text, in: cg, size: size)
            }
        }

        // 2) Поворот и отражение.
        let turned = painted.rotated(quarterTurns: document.quarterTurns, flipHorizontally: document.flippedHorizontally)

        // 3) Обрезка в координатах показанного кадра.
        guard !document.crop.isFull, let cg = turned.cgImage else { return turned }
        let crop = document.crop
        let rect = CGRect(
            x: (crop.x * turned.size.width).rounded(.down),
            y: (crop.y * turned.size.height).rounded(.down),
            width: max(1, (crop.w * turned.size.width).rounded()),
            height: max(1, (crop.h * turned.size.height).rounded())
        ).intersection(CGRect(origin: .zero, size: turned.size))
        guard let cropped = cg.cropping(to: rect) else { return turned }
        return UIImage(cgImage: cropped, scale: 1, orientation: .up)
    }

    /// JPEG для отправки; нетронутый кадр уходит исходными байтами без перекодирования.
    static func exportBytes(
        document: PhotoEditDocument, source: OutgoingFile, image: UIImage
    ) -> (bytes: Data, name: String, mime: String) {
        if document.isPristine {
            return (source.bytes, source.name, source.mime)
        }
        let rendered = render(document: document, image: image)
        let data = rendered.jpegData(compressionQuality: 0.9) ?? source.bytes
        var name = source.name
        if let dot = name.lastIndex(of: ".") { name = String(name[..<dot]) }
        return (data, name + ".jpg", "image/jpeg")
    }

    // MARK: - Штрихи

    /// Штрихи рисуются на отдельном прозрачном слое: ластик стирает ТОЛЬКО их, а не кадр.
    static func drawStrokes(_ strokes: [DrawStroke], in cg: CGContext, size: CGSize) {
        cg.saveGState()
        cg.beginTransparencyLayer(auxiliaryInfo: nil)
        for stroke in strokes {
            strokeOne(stroke, in: cg, size: size)
        }
        cg.endTransparencyLayer()
        cg.restoreGState()
    }

    private static func strokeOne(_ stroke: DrawStroke, in cg: CGContext, size: CGSize) {
        guard stroke.points.count > 1 else { return }
        let path = strokePath(stroke.points, size: size)
        let width = max(1, stroke.width * size.width)
        cg.saveGState()
        cg.setLineCap(.round)
        cg.setLineJoin(.round)
        switch stroke.kind {
        case .pen:
            cg.setStrokeColor(UIColor(stroke.color).cgColor)
            cg.setLineWidth(width)
            cg.addPath(path)
            cg.strokePath()
        case .marker:
            cg.setStrokeColor(UIColor(stroke.color).withAlphaComponent(0.45).cgColor)
            cg.setLineWidth(width * 2.2)
            cg.setLineCap(.square)
            cg.addPath(path)
            cg.strokePath()
        case .neon:
            cg.setShadow(offset: .zero, blur: width * 1.6, color: UIColor(stroke.color).cgColor)
            cg.setStrokeColor(UIColor(stroke.color).cgColor)
            cg.setLineWidth(width * 1.4)
            cg.addPath(path)
            cg.strokePath()
            cg.setShadow(offset: .zero, blur: 0, color: nil)
            cg.setStrokeColor(UIColor.white.cgColor)
            cg.setLineWidth(width * 0.55)
            cg.addPath(path)
            cg.strokePath()
        case .arrow:
            cg.setStrokeColor(UIColor(stroke.color).cgColor)
            cg.setFillColor(UIColor(stroke.color).cgColor)
            cg.setLineWidth(width)
            cg.addPath(path)
            cg.strokePath()
            let head = arrowHead(stroke.points, size: size, width: width)
            cg.addPath(head)
            cg.fillPath()
        case .eraser:
            cg.setBlendMode(.clear)
            cg.setLineWidth(width * 2)
            cg.addPath(path)
            cg.strokePath()
        }
        cg.restoreGState()
    }

    /// Сглаженный путь по точкам (квадратичные сплайны через середины отрезков).
    static func strokePath(_ points: [CGPoint], size: CGSize) -> CGPath {
        let path = CGMutablePath()
        let scaled = points.map { CGPoint(x: $0.x * size.width, y: $0.y * size.height) }
        guard let first = scaled.first else { return path }
        path.move(to: first)
        if scaled.count == 2 {
            path.addLine(to: scaled[1])
            return path
        }
        for index in 1..<scaled.count {
            let previous = scaled[index - 1]
            let current = scaled[index]
            let mid = CGPoint(x: (previous.x + current.x) / 2, y: (previous.y + current.y) / 2)
            path.addQuadCurve(to: mid, control: previous)
        }
        if let last = scaled.last { path.addLine(to: last) }
        return path
    }

    /// Наконечник стрелки по направлению последних точек.
    static func arrowHead(_ points: [CGPoint], size: CGSize, width: CGFloat) -> CGPath {
        let path = CGMutablePath()
        let scaled = points.map { CGPoint(x: $0.x * size.width, y: $0.y * size.height) }
        guard scaled.count >= 2 else { return path }
        let tip = scaled[scaled.count - 1]
        // Направление берём с запасом в несколько точек: последние две часто почти совпадают.
        let back = scaled[max(0, scaled.count - 6)]
        let angle = atan2(tip.y - back.y, tip.x - back.x)
        let length = max(width * 4, 12)
        let spread: CGFloat = .pi / 7
        let left = CGPoint(x: tip.x - length * cos(angle - spread), y: tip.y - length * sin(angle - spread))
        let right = CGPoint(x: tip.x - length * cos(angle + spread), y: tip.y - length * sin(angle + spread))
        path.move(to: tip)
        path.addLine(to: left)
        path.addLine(to: right)
        path.closeSubpath()
        return path
    }

    // MARK: - Размытие по штрихам

    private static func drawBlurs(_ blurs: [BlurStroke], source: UIImage, in cg: CGContext, size: CGSize) {
        let soft = blurs.contains { $0.soft } ? blurred(source) : nil
        let mosaic = blurs.contains { !$0.soft } ? pixelated(source) : nil
        for blur in blurs {
            guard blur.points.count > 1, let layer = (blur.soft ? soft : mosaic)?.cgImage else { continue }
            cg.saveGState()
            cg.setLineCap(.round)
            cg.setLineJoin(.round)
            cg.setLineWidth(max(2, blur.width * size.width))
            cg.addPath(strokePath(blur.points, size: size))
            cg.replacePathWithStrokedPath()
            cg.clip()
            // CGContext рисует картинки в перевёрнутой системе координат.
            cg.translateBy(x: 0, y: size.height)
            cg.scaleBy(x: 1, y: -1)
            cg.draw(layer, in: CGRect(origin: .zero, size: size))
            cg.restoreGState()
        }
    }

    // MARK: - Текст и стикеры

    static func textAttributes(_ overlay: TextOverlay, fontSize: CGFloat) -> [NSAttributedString.Key: Any] {
        let font = UIFont.systemFont(ofSize: fontSize, weight: .semibold)
        let color = UIColor(overlay.color)
        var attributes: [NSAttributedString.Key: Any] = [.font: font]
        switch overlay.style {
        case .plain:
            let shadow = NSShadow()
            shadow.shadowColor = UIColor.black.withAlphaComponent(0.6)
            shadow.shadowBlurRadius = fontSize * 0.12
            shadow.shadowOffset = CGSize(width: 0, height: fontSize * 0.04)
            attributes[.foregroundColor] = color
            attributes[.shadow] = shadow
        case .pill:
            attributes[.foregroundColor] = color.isLight ? UIColor.black : UIColor.white
        case .card:
            attributes[.foregroundColor] = color
        case .outline:
            attributes[.foregroundColor] = color
            attributes[.strokeColor] = color.isLight ? UIColor.black : UIColor.white
            attributes[.strokeWidth] = -fontSize * 0.08
        }
        return attributes
    }

    /// Подложка под текст для стилей pill/card (nil — без подложки).
    static func textBackground(_ overlay: TextOverlay) -> UIColor? {
        switch overlay.style {
        case .pill: return UIColor(overlay.color)
        case .card: return .white
        case .plain, .outline: return nil
        }
    }

    private static func drawText(_ overlay: TextOverlay, in cg: CGContext, size: CGSize) {
        let fontSize = max(8, overlay.scale * size.width)
        let attributes = textAttributes(overlay, fontSize: fontSize)
        let string = NSAttributedString(string: overlay.text, attributes: attributes)
        let bounds = string.boundingRect(
            with: CGSize(width: size.width * 0.9, height: .greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin], context: nil
        )
        let padding = CGSize(width: fontSize * 0.5, height: fontSize * 0.25)
        let center = CGPoint(x: overlay.center.x * size.width, y: overlay.center.y * size.height)

        cg.saveGState()
        cg.translateBy(x: center.x, y: center.y)
        cg.rotate(by: overlay.rotation)
        let textRect = CGRect(x: -bounds.width / 2, y: -bounds.height / 2, width: bounds.width, height: bounds.height)
        if let background = textBackground(overlay) {
            let box = textRect.insetBy(dx: -padding.width, dy: -padding.height)
            cg.setFillColor(background.cgColor)
            cg.addPath(CGPath(roundedRect: box, cornerWidth: fontSize * 0.3, cornerHeight: fontSize * 0.3, transform: nil))
            cg.fillPath()
        }
        UIGraphicsPushContext(cg)
        string.draw(with: textRect, options: [.usesLineFragmentOrigin], context: nil)
        UIGraphicsPopContext()
        cg.restoreGState()
    }

    private static func drawSticker(_ sticker: StickerOverlay, in cg: CGContext, size: CGSize) {
        let fontSize = max(8, sticker.scale * size.width)
        let string = NSAttributedString(string: sticker.emoji, attributes: [.font: UIFont.systemFont(ofSize: fontSize)])
        let bounds = string.size()
        let center = CGPoint(x: sticker.center.x * size.width, y: sticker.center.y * size.height)
        cg.saveGState()
        cg.translateBy(x: center.x, y: center.y)
        cg.rotate(by: sticker.rotation)
        UIGraphicsPushContext(cg)
        string.draw(at: CGPoint(x: -bounds.width / 2, y: -bounds.height / 2))
        UIGraphicsPopContext()
        cg.restoreGState()
    }
}

// MARK: - Вспомогательное

extension UIImage {
    /// Уменьшение до предела по большей стороне; меньше предела — как есть.
    func downscaled(maxDimension: CGFloat) -> UIImage {
        let longest = max(size.width, size.height)
        guard longest > maxDimension, longest > 0 else { return self }
        let factor = maxDimension / longest
        let target = CGSize(width: (size.width * factor).rounded(), height: (size.height * factor).rounded())
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        return UIGraphicsImageRenderer(size: target, format: format).image { _ in
            draw(in: CGRect(origin: .zero, size: target))
        }
    }

    /// Поворот на четверти по часовой и отражение по горизонтали.
    func rotated(quarterTurns: Int, flipHorizontally: Bool) -> UIImage {
        let turns = ((quarterTurns % 4) + 4) % 4
        guard turns != 0 || flipHorizontally, let cg = cgImage else { return self }
        let target = turns % 2 == 0 ? size : CGSize(width: size.height, height: size.width)
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        return UIGraphicsImageRenderer(size: target, format: format).image { context in
            let ctx = context.cgContext
            ctx.translateBy(x: target.width / 2, y: target.height / 2)
            if flipHorizontally { ctx.scaleBy(x: -1, y: 1) }
            ctx.rotate(by: CGFloat(turns) * .pi / 2)
            // draw(in:) в UIKit-контексте — без переворота осей.
            UIImage(cgImage: cg).draw(in: CGRect(x: -size.width / 2, y: -size.height / 2, width: size.width, height: size.height))
        }
    }
}

extension UIColor {
    /// Светлый ли цвет — чтобы текст на плашке оставался читаемым.
    var isLight: Bool {
        var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
        getRed(&red, green: &green, blue: &blue, alpha: &alpha)
        return (0.299 * red + 0.587 * green + 0.114 * blue) > 0.7
    }
}
