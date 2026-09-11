import SwiftUI

// Медиа в пузыре: мозаика альбома и плитка видео.
//
// Эталон — веб `frontend/src/ui/pages/chats/render/ChatMessageRow.tsx` (renderImageGroup,
// ~1037-1245) и `frontend/src/ui/components/VideoMessageBubble.tsx`. Ключевая мысль веба:
// каждая плитка держит СВОЮ пропорцию кадра (aspect-ratio 1/ratio), а ширины колонок
// подбираются так, чтобы высоты соседей совпали. Поэтому в мозаике нет ни серых полей,
// ни обрезки, и она не похожа на сетку одинаковых квадратов (как было тут раньше).
//
// Вся геометрия считается из МЕТАДАННЫХ вложения, до загрузки картинок: лента — это
// UICollectionView, высота ячейки измеряется один раз, и «распухание» плитки после
// загрузки сдвигало бы всю переписку под пальцем.

/// Геометрия альбома: чистая функция от пропорций кадров и бюджета размеров.
/// Ничего не знает ни о загрузке, ни о SwiftUI — поэтому результат детерминирован и
/// проверяем «на бумаге» (те же пропорции + та же ширина = те же рамки до пикселя).
struct AlbumLayout: Equatable {

    /// Как расставлены видимые плитки. Вью рисует ровно эти варианты.
    enum Arrangement: Equatable {
        /// Одна плитка своим размером.
        case single
        /// Две рядом: ширины по ОБРАТНЫМ пропорциям, высоты совпадают (веб-вариант).
        case row2
        /// Две столбиком: для пары широких кадров (рядом они выродились бы в полоски).
        case column2
        /// Большая слева + две стопкой справа (три кадра, как в вебе).
        case bigLeftStackRight
        /// Сетка 2×2: слева (0, 2), справа (1, 3) — четыре и больше.
        case grid2x2
    }

    let arrangement: Arrangement
    /// Рамки видимых плиток (не больше четырёх) в координатах самого альбома,
    /// по индексу фото в сообщении: tiles[i] — это i-я картинка.
    let tiles: [CGRect]
    /// Размер всего блока — его же занимает контейнер, чтобы плитки не растягивались.
    let size: CGSize
    /// Сколько фото спрятано за «+N» на последней видимой плитке (0 — все видны).
    let extraCount: Int
    /// Зазор между плитками (веб: `.msg-media-grid { gap: 4px }`).
    let spacing: CGFloat
}

extension AlbumLayout {

    /// Больше четырёх веб не показывает — остальные прячет под «+N».
    static let maxVisibleTiles = 4
    static let defaultSpacing: CGFloat = 4
    /// Нижний порог ширины мозаики (веб: `Math.max(220, ...)`) — иначе при высоком
    /// бюджете высоты альбом из портретов сжимался в спичечный коробок.
    static let minWidth: CGFloat = 220

    /// Единственный вход: пропорции кадров (h/w, порядок = порядок фото) и бюджет.
    /// `maxWidth` — сколько места даёт пузырь, `maxHeight` — бюджет высоты (веб gridMaxH).
    static func compute(
        ratios: [CGFloat],
        maxWidth: CGFloat,
        maxHeight: CGFloat,
        // Тип указан явно: значение по умолчанию считается вне контекста типа.
        spacing: CGFloat = AlbumLayout.defaultSpacing
    ) -> AlbumLayout {
        let clamped = ratios.map { clampRatio($0) }
        guard !clamped.isEmpty, maxWidth > 0, maxHeight > 0 else {
            return AlbumLayout(
                arrangement: .single, tiles: [], size: .zero, extraCount: 0, spacing: spacing
            )
        }
        let visible = Array(clamped.prefix(maxVisibleTiles))
        let extra = clamped.count - visible.count
        let chosen = Self.plan(for: visible)
        let width = fittedWidth(
            visible, arrangement: chosen, maxWidth: maxWidth, maxHeight: maxHeight, spacing: spacing
        )
        let tiles = rects(visible, arrangement: chosen, width: width, spacing: spacing)
        let height = tiles.map(\.maxY).max() ?? 0
        return AlbumLayout(
            arrangement: chosen,
            tiles: tiles,
            size: CGSize(width: width, height: height),
            extraCount: extra,
            spacing: spacing
        )
    }

    /// Порт веб-`getRatio`: h/w, крайности зажаты, мусор — квадрат. Панорама 10:1 или
    /// длинный скриншот иначе растянули бы пузырь на весь экран.
    static func clampRatio(_ ratio: CGFloat) -> CGFloat {
        guard ratio.isFinite, ratio > 0 else { return 1 }
        return min(max(ratio, 0.2), 5)
    }

    private static func plan(for ratios: [CGFloat]) -> Arrangement {
        switch ratios.count {
        case 1:
            return .single
        case 2:
            // Веб ставит две картинки только рядом, но два ШИРОКИХ кадра рядом дают две
            // полоски высотой в палец: на телефоне это нечитаемо. Такую пару кладём
            // столбиком (так же делает Telegram); ориентацию знаем из метаданных, то есть
            // решение принимается до загрузки и от неё не зависит.
            return (ratios[0] < 0.9 && ratios[1] < 0.9) ? .column2 : .row2
        case 3:
            return .bigLeftStackRight
        default:
            return .grid2x2
        }
    }

    /// Ширина мозаики: берём максимум, который даёт пузырь, но не такой, при котором
    /// высота вылезет за бюджет (веб: `widthByHeightBudget = gridMaxH / gridHeightCoef`).
    private static func fittedWidth(
        _ ratios: [CGFloat],
        arrangement: Arrangement,
        maxWidth: CGFloat,
        maxHeight: CGFloat,
        spacing: CGFloat
    ) -> CGFloat {
        let coef = heightCoefficient(ratios, arrangement: arrangement)
        let byBudget = coef > 0 ? (maxHeight / coef).rounded(.down) : maxWidth
        // Зазоры в коэффициенте не учитываются (как в вебе): промах на один gap невидим.
        return min(maxWidth, max(min(maxWidth, byBudget), minWidth))
    }

    /// H/W всего блока при данной раскладке — те же формулы, что в вебе.
    private static func heightCoefficient(_ r: [CGFloat], arrangement: Arrangement) -> CGFloat {
        switch arrangement {
        case .single:
            return r[0]
        case .row2:
            let denom = r[0] + r[1]
            return denom > 0 ? (r[0] * r[1]) / denom : 0
        case .column2:
            return r[0] + r[1]
        case .bigLeftStackRight:
            let denom = r[0] + r[1] + r[2]
            return denom > 0 ? (r[0] * (r[1] + r[2])) / denom : 0
        case .grid2x2:
            let denom = r[0] + r[1] + r[2] + r[3]
            return denom > 0 ? ((r[0] + r[2]) * (r[1] + r[3])) / denom : 0
        }
    }

    /// Рамки плиток. В отличие от веба (где ширины задаются флексом, а зазоры «съедают»
    /// высоту) считаем в пикселях С УЧЁТОМ зазоров, поэтому колонки кончаются на одной
    /// линии и блок остаётся честным прямоугольником.
    private static func rects(
        _ r: [CGFloat],
        arrangement: Arrangement,
        width: CGFloat,
        spacing: CGFloat
    ) -> [CGRect] {
        switch arrangement {
        case .single:
            return [CGRect(x: 0, y: 0, width: width, height: (width * r[0]).rounded())]

        case .row2:
            let content = max(width - spacing, 2)
            // Ширины обратно пропорциональны пропорциям: c0*r0 == c1*r1 (высоты равны).
            let left = clampSlot((content * r[1] / (r[0] + r[1])).rounded(), content: content)
            let right = content - left
            let height = (left * r[0]).rounded()
            return [
                CGRect(x: 0, y: 0, width: left, height: height),
                CGRect(x: left + spacing, y: 0, width: right, height: height)
            ]

        case .column2:
            return [
                CGRect(x: 0, y: 0, width: width, height: (width * r[0]).rounded()),
                CGRect(
                    x: 0,
                    y: (width * r[0]).rounded() + spacing,
                    width: width,
                    height: (width * r[1]).rounded()
                )
            ]

        case .bigLeftStackRight:
            let content = max(width - spacing, 2)
            // Левая плитка по высоте равна правой колонке ВМЕСТЕ с её внутренним зазором:
            // a*r0 = b*(r1+r2) + spacing, a + b = content → отсюда b.
            let right = clampSlot(
                ((content * r[0] - spacing) / (r[0] + r[1] + r[2])).rounded(),
                content: content
            )
            let left = content - right
            let total = (left * r[0]).rounded()
            let top = min((right * r[1]).rounded(), max(total - spacing - 1, 1))
            let bottom = max(total - spacing - top, 1)
            return [
                CGRect(x: 0, y: 0, width: left, height: total),
                CGRect(x: left + spacing, y: 0, width: right, height: top),
                CGRect(x: left + spacing, y: top + spacing, width: right, height: bottom)
            ]

        case .grid2x2:
            let content = max(width - spacing, 2)
            // У обеих колонок по два кадра и по одному зазору, поэтому зазор в равенстве
            // высот сокращается: a*(r0+r2) == b*(r1+r3).
            let left = clampSlot(
                (content * (r[1] + r[3]) / (r[0] + r[1] + r[2] + r[3])).rounded(),
                content: content
            )
            let right = content - left
            let topLeft = (left * r[0]).rounded()
            let topRight = (right * r[1]).rounded()
            let total = max(
                topLeft + spacing + (left * r[2]).rounded(),
                topRight + spacing + (right * r[3]).rounded()
            )
            return [
                CGRect(x: 0, y: 0, width: left, height: topLeft),
                CGRect(x: left + spacing, y: 0, width: right, height: topRight),
                CGRect(
                    x: 0,
                    y: topLeft + spacing,
                    width: left,
                    height: max(total - spacing - topLeft, 1)
                ),
                CGRect(
                    x: left + spacing,
                    y: topRight + spacing,
                    width: right,
                    height: max(total - spacing - topRight, 1)
                )
            ]
        }
    }

    /// Слот колонки не должен выродиться в нуль (иначе SwiftUI рисует пустоту).
    private static func clampSlot(_ value: CGFloat, content: CGFloat) -> CGFloat {
        min(max(value, 1), content - 1)
    }
}

/// Альбом фото в пузыре. Рисует мозаику по `AlbumLayout`, отдаёт наружу рамку каждой
/// плитки (по ней просмотрщик вырастает из плитки и улетает в неё же) и сообщает о тапе
/// индексом фото — тем же, которым лента нумерует картинки сообщения.
struct AttachmentAlbumView: View {

    /// Только картинки сообщения, в исходном порядке: индекс плитки = индекс фото.
    let atts: [MessageAttachment]
    /// Сколько места даёт пузырь и какой бюджет высоты (MessageAttachment.albumBudget).
    let maxWidth: CGFloat
    let maxHeight: CGFloat
    /// Расшифровка вложения секретного треда; в обычном чате nil.
    var decryptSecretAttachment: ((MessageAttachment) async -> URL?)?
    /// Система координат, в которой сообщаем рамки (у ленты это «messageCell»).
    var coordinateSpaceName: String = "messageCell"
    /// Рамка плитки: индекс фото → рамка. Хранит её координатор ленты.
    var onTileFrame: (Int, CGRect) -> Void
    /// Тап по плитке: индекс фото (на «+N» — индекс последней видимой).
    var onOpenImage: (Int) -> Void

    var body: some View {
        let layout = AlbumLayout.compute(
            ratios: atts.map(\.albumRatio),
            maxWidth: maxWidth,
            maxHeight: maxHeight
        )
        // Индексы плиток дальше берутся из раскладки, поэтому пустую не рисуем вовсе.
        return Group {
            if layout.tiles.isEmpty {
                EmptyView()
            } else {
                mosaic(layout)
                    .frame(width: layout.size.width, height: layout.size.height, alignment: .topLeading)
                    // Скругление у всего блока, а не у каждой плитки: внутри мозаики
                    // круглые углы соседей читались бы как набор отдельных картинок.
                    .clipShape(RoundedRectangle(cornerRadius: 10))
            }
        }
    }

    @ViewBuilder
    private func mosaic(_ layout: AlbumLayout) -> some View {
        switch layout.arrangement {
        case .single:
            tile(0, layout)
        case .row2:
            HStack(alignment: .top, spacing: layout.spacing) {
                tile(0, layout)
                tile(1, layout)
            }
        case .column2:
            VStack(alignment: .leading, spacing: layout.spacing) {
                tile(0, layout)
                tile(1, layout)
            }
        case .bigLeftStackRight:
            HStack(alignment: .top, spacing: layout.spacing) {
                tile(0, layout)
                VStack(alignment: .leading, spacing: layout.spacing) {
                    tile(1, layout)
                    tile(2, layout)
                }
            }
        case .grid2x2:
            HStack(alignment: .top, spacing: layout.spacing) {
                VStack(alignment: .leading, spacing: layout.spacing) {
                    tile(0, layout)
                    tile(2, layout)
                }
                VStack(alignment: .leading, spacing: layout.spacing) {
                    tile(1, layout)
                    tile(3, layout)
                }
            }
        }
    }

    private func tile(_ index: Int, _ layout: AlbumLayout) -> some View {
        let rect = layout.tiles[index]
        let isLastVisible = index == layout.tiles.count - 1
        return AlbumImageTile(
            att: atts[index],
            size: rect.size,
            decrypt: decryptSecretAttachment
        )
        .overlay {
            // «+N» — только на последней видимой плитке, как в вебе (.msg-media-more).
            if isLastVisible, layout.extraCount > 0 {
                ZStack {
                    Color.black.opacity(0.45)
                    Text("+\(layout.extraCount)")
                        .font(.system(size: 26, weight: .bold))
                        .foregroundStyle(.white)
                }
            }
        }
        .contentShape(Rectangle())
        .onGeometryChange(for: CGRect.self) { $0.frame(in: .named(coordinateSpaceName)) } action: {
            onTileFrame(index, $0)
        }
        .onTapGesture { onOpenImage(index) }
    }
}

/// Одна плитка альбома. Размер задан снаружи раскладкой, поэтому картинка режется по
/// заполнению (`fill`): пропорция плитки уже равна пропорции кадра, обрезать нечего, а
/// вписывание (`fit`) дало бы серые поля внутри мозаики, если метаданных не оказалось.
private struct AlbumImageTile: View {

    let att: MessageAttachment
    let size: CGSize
    let decrypt: ((MessageAttachment) async -> URL?)?

    var body: some View {
        Group {
            if att.secretNonce != nil {
                // В секретке по url лежит ШИФРТЕКСТ: плитка ждёт расшифровки в файл.
                SecretImageView(att: att, decrypt: decrypt)
            } else {
                CachedImage(
                    url: thumbMediaUrl(att.url).flatMap { URL(string: $0) },
                    contentMode: .fill
                ) {
                    Rectangle().fill(Eb.surface100)
                }
            }
        }
        .frame(width: size.width, height: size.height)
        .clipped()
        .background(Eb.surface100)
    }
}

/// Видео в пузыре: кадр-постер, круглая кнопка Play и длительность в углу — вместо
/// безликой строки «movie.mp4 · 12 МБ». Постер серверный (`metadata.posterKey` →
/// `MessageAttachment.posterUrl`), размер плитки считается из метаданных ДО загрузки.
struct VideoAttachmentTile: View {

    let att: MessageAttachment
    /// Размер плитки (MessageAttachment.videoDisplaySize) — фиксирован до загрузки кадра.
    let size: CGSize
    /// Длительность из метаданных вложения; nil — подписи времени нет.
    var durationSec: Int?
    /// Тап: открыть плеер. Скачиванием/расшифровкой занимается вызывающий.
    let onPlay: () -> Void

    var body: some View {
        poster
            .frame(width: size.width, height: size.height)
            .clipped()
            // Тёмная подложка видна, пока постер грузится и когда его нет вовсе.
            .background(Eb.surface300)
            .overlay {
                Image(systemName: "play.fill")
                    .font(.system(size: 22, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 54, height: 54)
                    .background(.black.opacity(0.45), in: Circle())
                    .overlay(Circle().strokeBorder(Color.white.opacity(0.25)))
            }
            .overlay(alignment: .bottomLeading) {
                if let footer {
                    Text(footer)
                        .font(.caption2)
                        .foregroundStyle(.white)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(.black.opacity(0.4), in: Capsule())
                        .padding(8)
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .contentShape(Rectangle())
            .onTapGesture(perform: onPlay)
    }

    @ViewBuilder
    private var poster: some View {
        if let url = posterURL {
            CachedImage(url: url, contentMode: .fill) {
                Rectangle().fill(Eb.surface300)
            }
        } else {
            Rectangle().fill(Eb.surface300)
        }
    }

    /// Постер у секретного видео недоступен (сервер шифртекст не раскадровывает), поэтому
    /// там сразу тёмная подложка — качать шифртекст как картинку бессмысленно.
    private var posterURL: URL? {
        guard att.secretNonce == nil else { return nil }
        return thumbMediaUrl(att.posterUrl).flatMap { URL(string: $0) }
    }

    /// «1:23 · 12 МБ» — тот же угловой текст, что в веб-пузыре видео.
    private var footer: String? {
        var parts: [String] = []
        if let durationSec, durationSec > 0 {
            parts.append(String(format: "%d:%02d", durationSec / 60, durationSec % 60))
        }
        if let bytes = att.size, bytes > 0 {
            parts.append(ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file))
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}
