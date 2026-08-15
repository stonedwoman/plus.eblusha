import SwiftUI

// Порт свайп-ответа из MessageRow (`ui/chat/ChatScreen.kt`, ~1478-1528): пузырь тянется
// к центру, позади проявляется стрелка ответа; отпускание за порогом — ответ.

/// Порог срабатывания и максимум протяжки — как в эталоне (52dp / 84dp).
private let replyThresholdPx: CGFloat = 52
private let maxDragPx: CGFloat = 84

/// Модификатор строки сообщения: горизонтальный drag с отдачей onReply() за порогом.
/// Ответный свайп: входящие тянутся ВПРАВО (к центру), свои — ВЛЕВО (свои пузыри
/// прижаты к правому краю).
struct SwipeToReply: ViewModifier {
    let isMine: Bool
    /// false в режиме выбора — там строка живёт тапами, жест не должен их перехватывать
    /// (Kotlin: pointerInput(m.id, selectionMode) { if (!selectionMode) ... }).
    var enabled = true
    let onReply: () -> Void

    @State private var offsetX: CGFloat = 0
    /// nil — направление жеста ещё не решено; false — движение вертикальное, отдано
    /// скроллу ленты (решается один раз за жест, чтобы диагональ не дёргала пузырь).
    @State private var horizontalLock: Bool?

    func body(content: Content) -> some View {
        content
            .offset(x: offsetX)
            // Стрелка ответа проявляется по мере протяжки пузыря к центру
            // (слева у входящих, справа у своих) — позади сдвигаемого содержимого.
            .background(alignment: isMine ? .trailing : .leading) {
                Image(systemName: "arrowshape.turn.up.left")
                    .font(.system(size: 22))
                    .foregroundStyle(Eb.brand)
                    .padding(.horizontal, 10)
                    .opacity(min(abs(offsetX) / replyThresholdPx, 1))
            }
            // .subviews выключает сам жест, не трогая жесты содержимого (тапы/меню).
            .gesture(drag, including: enabled ? .all : .subviews)
    }

    private var drag: some Gesture {
        // minimumDistance даёт вертикальному скроллу ленты выиграть чистое листание.
        DragGesture(minimumDistance: 12)
            .onChanged { value in
                if horizontalLock == nil {
                    horizontalLock =
                        abs(value.translation.width) > abs(value.translation.height)
                }
                guard horizontalLock == true else { return }
                // Свои: -max..0 (влево), входящие: 0..max (вправо) — как в эталоне.
                let swipeMin: CGFloat = isMine ? -maxDragPx : 0
                let swipeMax: CGFloat = isMine ? 0 : maxDragPx
                offsetX = min(max(value.translation.width, swipeMin), swipeMax)
            }
            .onEnded { _ in
                let trigger = abs(offsetX) >= replyThresholdPx
                withAnimation(.spring(duration: 0.25)) { offsetX = 0 }
                horizontalLock = nil
                if trigger { onReply() }
            }
    }
}

extension View {
    /// Свайп-ответ для строки сообщения: `.swipeToReply(isMine: m.isMine, ...)`.
    func swipeToReply(
        isMine: Bool, enabled: Bool = true, onReply: @escaping () -> Void
    ) -> some View {
        modifier(SwipeToReply(isMine: isMine, enabled: enabled, onReply: onReply))
    }
}
