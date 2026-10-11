import SwiftUI

/// «Янтарь в полоску» — фирменная заливка главной кнопки, включённого тумблера, выбранного
/// сегмента, плитки-выбора (`Ui/AmberStripe.cs` натива, SPEC §3.2). Слои снизу вверх:
///  1. градиент 158° (CSS-правило точек: L = |w·sinθ| + |h·cosθ|): #B45309 → #E38B0A (.48) → #D97706;
///  2. штриховка −32°, шаг 9, линия 1, белый 14 %;
///  3. штриховка +32°, шаг 13, линия 1, чёрный 5 %;
///  4. глянец сверху вниз: белый 20 % → белый 6 % (.55) → чёрный 4 %.
/// Текст на заливке — `Eb.ink` Bold: белый на янтаре даёт 3,2:1.
struct AmberStripe: View {
    var cornerRadius: CGFloat = 12
    /// Бегунок и подписи не должны мерцать при перерисовке: сама заливка статична.
    var body: some View {
        Canvas { ctx, size in
            AmberStripe.draw(&ctx, size: size)
        }
        .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    /// Точки градиента под угол θ (градусы по CSS: 0° — вверх, по часовой) в прямоугольнике w×h.
    static func gradientPoints(angle: Double, size: CGSize) -> (start: CGPoint, end: CGPoint) {
        let t = angle * .pi / 180
        let dx = sin(t), dy = -cos(t)
        let length = abs(Double(size.width) * sin(t)) + abs(Double(size.height) * cos(t))
        let c = CGPoint(x: size.width / 2, y: size.height / 2)
        return (
            CGPoint(x: c.x - CGFloat(dx * length / 2), y: c.y - CGFloat(dy * length / 2)),
            CGPoint(x: c.x + CGFloat(dx * length / 2), y: c.y + CGFloat(dy * length / 2))
        )
    }

    /// Штриховка: линии толщиной 1 через `period`, перпендикулярные оси градиента `angle`.
    private static func hatch(
        _ ctx: inout GraphicsContext, size: CGSize, angle: Double, period: CGFloat, offset: CGFloat, color: Color
    ) {
        let t = angle * .pi / 180
        let dir = CGPoint(x: sin(t), y: -cos(t))       // ось градиента
        let perp = CGPoint(x: cos(t), y: sin(t))       // направление линии
        let length = abs(Double(size.width) * sin(t)) + abs(Double(size.height) * cos(t))
        let c = CGPoint(x: size.width / 2, y: size.height / 2)
        let start = CGPoint(x: c.x - dir.x * CGFloat(length / 2), y: c.y - dir.y * CGFloat(length / 2))
        let reach = hypot(size.width, size.height)
        var path = Path()
        var k: CGFloat = 0
        while k * period < CGFloat(length) {
            let along = k * period + offset
            let p = CGPoint(x: start.x + dir.x * along, y: start.y + dir.y * along)
            path.move(to: CGPoint(x: p.x - perp.x * reach, y: p.y - perp.y * reach))
            path.addLine(to: CGPoint(x: p.x + perp.x * reach, y: p.y + perp.y * reach))
            k += 1
        }
        ctx.stroke(path, with: .color(color), lineWidth: 1)
    }

    fileprivate static func draw(_ ctx: inout GraphicsContext, size: CGSize) {
        let rect = CGRect(origin: .zero, size: size)
        let pts = gradientPoints(angle: 158, size: size)
        ctx.fill(
            Path(rect),
            with: .linearGradient(
                Gradient(stops: [
                    .init(color: Eb.brand700, location: 0),
                    .init(color: Eb.brand600, location: 0.48),
                    .init(color: Eb.brand, location: 1),
                ]),
                startPoint: pts.start, endPoint: pts.end
            )
        )
        hatch(&ctx, size: size, angle: -32, period: 9, offset: 8.5, color: .white.opacity(0.14))
        hatch(&ctx, size: size, angle: 32, period: 13, offset: 12.5, color: .black.opacity(0.05))
        ctx.fill(
            Path(rect),
            with: .linearGradient(
                Gradient(stops: [
                    .init(color: .white.opacity(0.20), location: 0),
                    .init(color: .white.opacity(0.06), location: 0.55),
                    .init(color: .black.opacity(0.04), location: 1),
                ]),
                startPoint: CGPoint(x: size.width / 2, y: 0),
                endPoint: CGPoint(x: size.width / 2, y: size.height)
            )
        )
    }
}

/// Баннер плитки «Профиль»: радиальный янтарь на #2A2320 плюс штриховка −32°, шаг 8, сливки 6 %
/// (SPEC §3.5).
struct ProfileBanner: View {
    var body: some View {
        Canvas { ctx, size in
            let rect = CGRect(origin: .zero, size: size)
            ctx.fill(Path(rect), with: .color(Color(hex: 0x2A2320)))
            let center = CGPoint(x: size.width * 0.25, y: 0)
            ctx.fill(
                Path(rect),
                with: .radialGradient(
                    Gradient(stops: [
                        .init(color: Eb.brand600.opacity(0.62), location: 0),
                        .init(color: Eb.brand700.opacity(0.32), location: 0.45),
                        .init(color: .clear, location: 1),
                    ]),
                    center: center, startRadius: 0, endRadius: max(size.width, size.height) * 0.9
                )
            )
            var hatch = Path()
            let t = -32.0 * .pi / 180
            let dir = CGPoint(x: sin(t), y: -cos(t))
            let perp = CGPoint(x: cos(t), y: sin(t))
            let length = abs(Double(size.width) * sin(t)) + abs(Double(size.height) * cos(t))
            let start = CGPoint(x: size.width / 2 - dir.x * CGFloat(length / 2), y: size.height / 2 - dir.y * CGFloat(length / 2))
            let reach = hypot(size.width, size.height)
            var k: CGFloat = 0
            while k * 8 < CGFloat(length) {
                let p = CGPoint(x: start.x + dir.x * (k * 8 + 7.5), y: start.y + dir.y * (k * 8 + 7.5))
                hatch.move(to: CGPoint(x: p.x - perp.x * reach, y: p.y - perp.y * reach))
                hatch.addLine(to: CGPoint(x: p.x + perp.x * reach, y: p.y + perp.y * reach))
                k += 1
            }
            ctx.stroke(hatch, with: .color(Eb.logoCream.opacity(0.06)), lineWidth: 1)
        }
        .accessibilityHidden(true)
    }
}
