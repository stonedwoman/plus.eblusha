import SwiftUI
import UIKit

// Меню сообщения: сам пузырь поднимается над размытым замороженным фоном, над ним —
// таблетка быстрых реакций, под ним — карточка действий. Вместо нижнего листа, который
// накрывал ровно то сообщение, по которому нажали.
//
// Подача — телеграмовская (числа: затемнение 60 % за 0.2 с, прилёт пружиной ~0.42 с
// почти критического демпфирования, панель на 7 pt ниже пузыря, радиус 14, поля 12 pt,
// блок зажат между верхней безопасной зоной + 8 pt и нижней вставкой, закрытие 0.2 с).
// Состав и порядок пунктов — веб-овские, они живут в MessageActionsSheet.swift.
//
// Открывается из ChatView через fullScreenCover(item:) с выключенной системной анимацией:
// появление и уход рисует сам оверлей, шторка снизу поверх этого была бы двойным движением.

// MARK: - Что уносим в оверлей

/// Копия пузыря: растр и его рамка в координатах окна на момент открытия.
///
/// Именно растр, а не второй экземпляр SwiftUI-вида. Перестроить пузырь в оверлее нечем:
/// его вид зависит от `MessageRowModel` (пачка пересылки, предпросмотры цитат, место в
/// ране, накладка отправки), а наружу лента отдаёт только `Message`. И даже с моделью
/// живые куски пузыря — прогресс загрузки, бегунок голосового — начались бы во второй
/// копии заново и разъехались бы с настоящими. Цена решения: на время меню копия
/// застывшая (волна голосового не бежит). Это видно, но это честно: меню живёт секунды,
/// а вторая живая копия рассинхронизировалась бы навсегда.
struct MessageBubbleCopy {
    let image: UIImage
    /// Рамка пузыря в координатах окна.
    let frame: CGRect
}

/// Цель меню: сообщение, копия его пузыря и замороженный снимок экрана под меню.
struct MessageActionsTarget: Identifiable {

    let message: Message
    /// nil — ячейки уже нет на экране: открываемся и закрываемся простым затуханием.
    let bubble: MessageBubbleCopy?
    /// Фон под меню — ОДИН снимок, а не живая лента. Лента под открытым меню продолжает
    /// жить (приходят сообщения, ячейки переиспользуются), и если бы она просвечивала
    /// сквозь прозрачный fullScreenCover, фон уезжал бы под поднятым пузырём.
    let backdrop: UIImage?
    /// Рамка окна на момент открытия — в ней же лежит `bubble.frame`.
    let screen: CGRect
    let safeTop: CGFloat
    let safeBottom: CGFloat

    var id: String { message.id }
}

// MARK: - Снимки

/// Снимки для меню: экран целиком и пузырь из ячейки ленты.
enum MessageActionsCapture {

    /// Замороженный снимок ключевого окна плюс его геометрия.
    ///
    /// `afterScreenUpdates: false` — рисуем то, что уже на экране: `true` прогнал бы
    /// лишний проход раскладки ровно в тот момент, когда палец ждёт отклика.
    static func target(for message: Message, bubble: MessageBubbleCopy?) -> MessageActionsTarget {
        guard let window = keyWindow() else {
            return MessageActionsTarget(
                message: message, bubble: bubble, backdrop: nil,
                screen: UIScreen.main.bounds, safeTop: 0, safeBottom: 0
            )
        }
        let format = UIGraphicsImageRendererFormat.preferred()
        format.opaque = true
        let image = UIGraphicsImageRenderer(bounds: window.bounds, format: format).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: false)
        }
        return MessageActionsTarget(
            message: message,
            bubble: bubble,
            backdrop: image,
            screen: window.bounds,
            safeTop: window.safeAreaInsets.top,
            safeBottom: window.safeAreaInsets.bottom
        )
    }

    /// Растр куска вьюхи — им лента снимает пузырь из своей ячейки.
    static func crop(of view: UIView, rect: CGRect) -> UIImage? {
        guard rect.width > 1, rect.height > 1 else { return nil }
        let format = UIGraphicsImageRendererFormat.preferred()
        format.opaque = false
        return UIGraphicsImageRenderer(size: rect.size, format: format).image { context in
            context.cgContext.translateBy(x: -rect.minX, y: -rect.minY)
            view.drawHierarchy(in: view.bounds, afterScreenUpdates: false)
        }
    }

    private static func keyWindow() -> UIWindow? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let windows = scenes.filter { $0.activationState == .foregroundActive }.flatMap(\.windows)
            + scenes.flatMap(\.windows)
        return windows.first(where: \.isKeyWindow) ?? windows.first
    }
}

// MARK: - Оверлей

struct MessageActionsOverlay: View {

    let target: MessageActionsTarget
    let quickSlots: [String]
    let canForward: Bool
    /// Свежая рамка пузыря в окне на момент закрытия: пока меню открыто, в ленту могли
    /// прийти сообщения и сдвинуть строку. nil — строки на экране нет, просто гаснем.
    let bubbleFrameProvider: (String) -> CGRect?

    let onReact: (String) -> Void
    let onReply: () -> Void
    let onCopy: () -> Void
    let onForward: () -> Void
    let onEdit: () -> Void
    let onDelete: () -> Void
    let onSelect: () -> Void
    /// Снять оверлей. Вызывается ПОСЛЕ анимации ухода.
    let onClose: () -> Void

    private enum Phase: Equatable { case start, open, closing }

    @State private var phase: Phase = .start
    /// Куда летит копия при закрытии; nil — гаснем на месте.
    @State private var landing: CGRect?
    /// Полный выбор эмодзи раскрывается прямо отсюда — поэтому ушёл костыль с ожиданием
    /// закрытия нижнего листа перед показом пикера.
    @State private var pickerShown = false

    // MARK: Метрики (числа спецификации)

    /// Зазор между таблеткой реакций и пузырём.
    private static let railGap: CGFloat = 18
    /// Панель действий — на 7 pt ниже пузыря.
    private static let cardGap: CGFloat = 7
    /// Поля от краёв экрана: карточка 12 pt, таблетка реакций 11 pt.
    private static let cardMargin: CGFloat = 12
    private static let railMargin: CGFloat = 11
    /// Копию ужимаем, но не в кашу: ниже этого масштаба текст уже не прочесть, и вместо
    /// ужимания показываем верх пузыря с затуханием низа.
    private static let minScale: CGFloat = 0.6

    /// Прилёт — пружина ~0.42 с почти критического демпфирования. Телеграмовские
    /// «duration 0.42, damping 104» — коэффициенты их собственного солвера, буквально их
    /// переносить нельзя; берём ту же длительность и почти отсутствующий перелёт.
    private static let arrival = Animation.spring(response: 0.42, dampingFraction: 0.95)
    private static let leaving = Animation.easeInOut(duration: 0.2)

    /// Кривая слоёв, которые просто проявляются и гаснут: затемнение, размытие, таблетка.
    private var fade: Animation {
        phase == .closing ? Self.leaving : .easeOut(duration: 0.2)
    }

    var body: some View {
        let layout = computeLayout()
        ZStack(alignment: .topLeading) {
            backdrop
            dimming
            // Тап мимо меню закрывает его. Слой стоит НАД затемнением и ПОД содержимым,
            // иначе он съедал бы нажатия по пунктам.
            Color.clear
                .contentShape(Rectangle())
                .onTapGesture { close() }
            if let copy = target.bubble {
                bubbleCopy(copy, layout: layout)
            }
            railGroup(layout: layout)
            cardGroup(layout: layout)
        }
        .frame(width: target.screen.width, height: target.screen.height, alignment: .topLeading)
        .ignoresSafeArea()
        // Фон презентации прозрачный: всё, что видно, рисует этот оверлей.
        .presentationBackground(.clear)
        .sheet(isPresented: $pickerShown) {
            ReactionPickerSheet(
                onPick: { emoji in
                    pickerShown = false
                    // Сначала уезжает лист выбора и только потом само меню: снимать
                    // оверлей из-под ещё анимирующегося листа UIKit не любит.
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { react(emoji) }
                },
                onDismiss: { pickerShown = false }
            )
        }
        .onAppear { phase = .open }
    }

    // MARK: Слои

    /// Замороженный экран: чуть наезжает и уходит в размытие.
    ///
    /// На снимке остаётся и сам пузырь, с которого сняли копию, — «вырезать» его из
    /// растра нечем. Под размытием и 60-процентной чернотой призрак не читается, а на
    /// старте копия стоит ровно на нём, так что раздвоения в момент подъёма нет.
    @ViewBuilder
    private var backdrop: some View {
        if let image = target.backdrop {
            Image(uiImage: image)
                .resizable()
                .scaledToFill()
                .frame(width: target.screen.width, height: target.screen.height)
                .scaleEffect(phase == .open ? 1.04 : 1)
                .blur(radius: phase == .open ? 16 : 0, opaque: true)
                .clipped()
                .animation(fade, value: phase)
                .allowsHitTesting(false)
        }
    }

    private var dimming: some View {
        Color.black
            .opacity(phase == .open ? 0.6 : 0)
            .animation(fade, value: phase)
            .allowsHitTesting(false)
    }

    /// Копия пузыря: летит из своей строки на место над меню и обратно.
    ///
    /// Размер копии постоянный, двигаются только `scaleEffect` и `position` — это чистые
    /// трансформации, без перерасчёта раскладки на каждом кадре.
    private func bubbleCopy(_ copy: MessageBubbleCopy, layout: MenuLayout) -> some View {
        let size = CGSize(width: copy.frame.width, height: layout.crop)
        return Image(uiImage: copy.image)
            .resizable()
            .frame(width: copy.frame.width, height: copy.frame.height)
            .frame(width: size.width, height: size.height, alignment: .top)
            .clipped()
            // Обрезанному пузырю низ гасим, чтобы срез не читался как обрыв картинки.
            .mask(alignment: .top) {
                cropMask(cropped: layout.crop < copy.frame.height - 0.5, height: size.height)
            }
            .scaleEffect(bubbleScale(layout: layout), anchor: .center)
            .position(bubbleCenter(copy, layout: layout, height: size.height))
            .opacity(phase == .closing && landing == nil ? 0 : 1)
            .animation(phase == .closing ? Self.leaving : Self.arrival, value: phase)
            .allowsHitTesting(false)
    }

    @ViewBuilder
    private func cropMask(cropped: Bool, height: CGFloat) -> some View {
        if cropped {
            LinearGradient(
                stops: [
                    .init(color: .black, location: 0),
                    .init(color: .black, location: max(0, (height - 28) / max(height, 1))),
                    .init(color: .clear, location: 1),
                ],
                startPoint: .top,
                endPoint: .bottom
            )
        } else {
            Color.black
        }
    }

    /// Таблетка реакций и хвост из двух кругов, показывающий на сообщение.
    private func railGroup(layout: MenuLayout) -> some View {
        ZStack(alignment: .topLeading) {
            if target.bubble != nil {
                Circle()
                    .fill(Eb.surface200.opacity(0.92))
                    .frame(width: 16, height: 16)
                    .position(x: layout.tailBig.x, y: layout.tailBig.y)
                Circle()
                    .fill(Eb.surface200.opacity(0.92))
                    .frame(width: 8, height: 8)
                    .position(x: layout.tailSmall.x, y: layout.tailSmall.y)
            }
            MessageQuickReactionsRail(
                quickSlots: quickSlots,
                mine: { emoji in
                    target.message.reactions.first { $0.emoji == emoji }?.mine ?? false
                },
                onPick: { react($0) },
                onMore: { pickerShown = true },
                shown: phase == .open
            )
            .frame(width: layout.rail.width, height: layout.rail.height)
            .position(x: layout.rail.midX, y: layout.rail.midY)
        }
        .opacity(phase == .open ? 1 : 0)
        .animation(fade, value: phase)
    }

    /// Карточка действий: скейл 0.01 → 1 той же пружиной, прозрачность за 0.05 с.
    private func cardGroup(layout: MenuLayout) -> some View {
        MessageActionsCard(items: items, onPick: { item in close(then: item.action) })
            .frame(width: layout.card.width)
            .scaleEffect(
                phase == .open ? 1 : 0.01,
                anchor: layout.alignRight ? UnitPoint.topTrailing : UnitPoint.topLeading
            )
            .animation(phase == .closing ? Self.leaving : Self.arrival, value: phase)
            .opacity(phase == .open ? 1 : 0)
            .animation(
                phase == .closing ? Self.leaving : Animation.easeOut(duration: 0.05), value: phase
            )
            .frame(width: layout.card.width, height: layout.card.height)
            .position(x: layout.card.midX, y: layout.card.midY)
    }

    // MARK: Действия

    private var items: [MessageActionItem] {
        messageActionItems(
            message: target.message,
            canForward: canForward,
            onReply: onReply,
            onCopy: onCopy,
            onForward: onForward,
            onEdit: onEdit,
            onSelect: onSelect,
            onDelete: onDelete
        )
    }

    private func react(_ emoji: String) {
        // Отклик даём только на ПОСТАНОВКУ реакции: снятие в вебе и в Telegram молчит.
        let alreadyMine = target.message.reactions.first { $0.emoji == emoji }?.mine ?? false
        if !alreadyMine {
            UISelectionFeedbackGenerator().selectionChanged()
        }
        onReact(emoji)
        close()
    }

    /// Уход: 0.2 с обратно в строку, и только потом снимаем оверлей.
    ///
    /// Действие пункта выполняем ПОСЛЕ снятия — половина пунктов открывает свой лист
    /// (переслать, изменить), а лист поверх ещё не убранного fullScreenCover система
    /// просто не покажет.
    private func close(then after: (() -> Void)? = nil) {
        guard phase != .closing else { return }
        landing = target.bubble == nil ? nil : bubbleFrameProvider(target.message.id)
        phase = .closing
        let dismiss = onClose
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
            dismiss()
            guard let after = after else { return }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.06, execute: after)
        }
    }

    // MARK: Геометрия

    /// Посчитанные места блока в координатах окна.
    private struct MenuLayout {
        var bubble: CGRect
        var scale: CGFloat
        /// Сколько высоты исходного пузыря показываем (в его собственном масштабе).
        var crop: CGFloat
        var rail: CGRect
        var card: CGRect
        var tailBig: CGPoint
        var tailSmall: CGPoint
        var alignRight: Bool
    }

    private func bubbleScale(layout: MenuLayout) -> CGFloat {
        switch phase {
        case .start: return 1
        case .open: return layout.scale
        case .closing: return landing == nil ? layout.scale : 1
        }
    }

    /// Центр копии. В строке (и на старте, и при возврате) копия стоит по верху пузыря:
    /// при обрезке её высота меньше настоящей, и «по центру» она бы прыгнула.
    private func bubbleCenter(
        _ copy: MessageBubbleCopy, layout: MenuLayout, height: CGFloat
    ) -> CGPoint {
        switch phase {
        case .start:
            return CGPoint(x: copy.frame.midX, y: copy.frame.minY + height / 2)
        case .open:
            return CGPoint(x: layout.bubble.midX, y: layout.bubble.midY)
        case .closing:
            guard let landing = landing else {
                return CGPoint(x: layout.bubble.midX, y: layout.bubble.midY)
            }
            return CGPoint(x: landing.midX, y: landing.minY + height / 2)
        }
    }

    /// Блок «таблетка + пузырь + карточка» целиком зажат между верхней безопасной зоной
    /// плюс 8 pt и нижней вставкой. Высокий пузырь (альбом, длинный текст) сначала
    /// ужимается, а если и этого мало — показывается верхом с затуханием низа: ужимать
    /// его дальше бессмысленно, читать будет нечего.
    ///
    /// Колонку двигаем, а ленту — нет: под меню она заморожена снимком, и любой её сдвиг
    /// увёл бы цель обратного полёта.
    private func computeLayout() -> MenuLayout {
        let screen = target.screen.size
        let top = target.safeTop + 8
        let bottom = screen.height - max(target.safeBottom, Self.cardMargin)

        let cardWidth = min(MessageActionsCard.width, screen.width - Self.cardMargin * 2)
        let cardHeight = MessageActionsCard.height(rows: items.count)
        let railWidth = min(
            MessageQuickReactionsRail.width(slots: quickSlots.count + 1),
            screen.width - Self.railMargin * 2
        )
        let railHeight = MessageQuickReactionsRail.height

        // Ячейки на экране нет: меню встаёт по центру и просто проявляется. Тот же расчёт,
        // только «пузырь» — точка посреди экрана.
        let source = target.bubble?.frame
            ?? CGRect(x: screen.width / 2, y: screen.height / 2, width: 0, height: 0)

        let column = railHeight + Self.railGap + Self.cardGap + cardHeight
        // Нижняя граница запаса: на маленьком экране с длинным меню лучше чуть вылезти,
        // чем поделить на отрицательное число.
        let available = max(bottom - top - column, 160)

        var scale: CGFloat = 1
        var crop = source.height
        if source.height > available {
            scale = max(available / source.height, Self.minScale)
            crop = min(source.height, available / scale)
        }

        let width = source.width * scale
        let height = crop * scale

        var y = source.minY
        let columnTop = y - Self.railGap - railHeight
        if columnTop < top { y += top - columnTop }
        let columnBottom = y + height + Self.cardGap + cardHeight
        if columnBottom > bottom { y -= columnBottom - bottom }
        y = max(y, top + railHeight + Self.railGap)

        // Свои сообщения прижаты к правому краю, входящие — к левому: и ужимание, и
        // таблетка, и карточка цепляются за ту же сторону, за которую цепляется пузырь.
        let alignRight = target.message.isMine
        let bubbleX = clamp(
            alignRight ? source.maxX - width : source.minX,
            min: Self.cardMargin, max: screen.width - Self.cardMargin - width
        )
        let bubble = CGRect(x: bubbleX, y: y, width: width, height: height)

        let cardX = clamp(
            alignRight ? bubble.maxX - cardWidth : bubble.minX,
            min: Self.cardMargin, max: screen.width - Self.cardMargin - cardWidth
        )
        let card = CGRect(
            x: cardX, y: bubble.maxY + Self.cardGap, width: cardWidth, height: cardHeight
        )

        let railX = clamp(
            alignRight ? bubble.maxX - railWidth : bubble.minX,
            min: Self.railMargin, max: screen.width - Self.railMargin - railWidth
        )
        let rail = CGRect(
            x: railX, y: bubble.minY - Self.railGap - railHeight,
            width: railWidth, height: railHeight
        )

        // Хвост живёт в зазоре под таблеткой и смотрит внутрь, в сторону пузыря.
        let tailX = alignRight ? rail.maxX - 20 : rail.minX + 20
        let inward: CGFloat = alignRight ? -15 : 15

        return MenuLayout(
            bubble: bubble,
            scale: scale,
            crop: crop,
            rail: rail,
            card: card,
            tailBig: CGPoint(x: tailX, y: rail.maxY + 8),
            tailSmall: CGPoint(x: tailX + inward, y: rail.maxY + 15),
            alignRight: alignRight
        )
    }

    private func clamp(_ value: CGFloat, min lower: CGFloat, max upper: CGFloat) -> CGFloat {
        guard upper > lower else { return lower }
        return Swift.min(Swift.max(value, lower), upper)
    }
}
