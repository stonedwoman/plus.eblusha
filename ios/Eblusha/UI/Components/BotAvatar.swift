import SwiftUI

// Внешность бота «Еблуша»: фирменная «Б» вместо аватара, метка «бот», оранжевая полоса пузыря.
// Цвета — логотипа (Eb.logoB — оранжевая «Б» на фоне paper, как иконка приложения), а не
// загруженная картинка бота: бот узнаётся с первого взгляда и без сети.

/// Тёплый фон пузыря бота: входящий пузырь с оранжевым оттенком, чтобы ответ бота не путали с
/// репликой собеседника даже без полосы.
let botBubbleBackground = Color(hex: 0x262019)

/// Аватар бота: большая оранжевая «Б» на тёмном круге с тонким оранжевым кантом.
struct BotAvatar: View {
    var size: CGFloat = 28

    var body: some View {
        ZStack {
            Circle().fill(Eb.paper)
            Circle().strokeBorder(Eb.logoB.opacity(0.55), lineWidth: max(1, size / 28))
            Text("Б")
                .font(.system(size: size * 0.56, weight: .heavy))
                .foregroundStyle(Eb.logoB)
                // Кегль считается от размера аватара — системное увеличение шрифта не должно
                // выталкивать букву за круг.
                .dynamicTypeSize(.large)
        }
        .frame(width: size, height: size)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Еблуша, бот")
    }
}

/// Метка «бот» рядом с именем.
struct BotTag: View {
    var body: some View {
        Text("бот")
            .font(.system(size: 10, weight: .bold))
            .foregroundStyle(Eb.brand600)
            .padding(.horizontal, 5)
            .padding(.vertical, 1)
            .background(Eb.brand.opacity(0.18), in: Capsule())
            .accessibilityHidden(true)
    }
}

/// Имя бота над пузырём: «Еблуша» оранжевым + метка «бот».
struct BotNameLine: View {
    var name: String = SystemBotStore.displayName

    var body: some View {
        HStack(spacing: 5) {
            Text(name)
                .font(.caption.weight(.semibold))
                .foregroundStyle(Eb.logoB)
                .lineLimit(1)
            BotTag()
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(name), бот")
    }
}

/// Плашка «Еблуша» в поле ввода: режим «Спросить» включён. Тап убирает её (обычное сообщение).
struct BotAskChip: View {
    let onDismiss: () -> Void

    var body: some View {
        Button(action: onDismiss) {
            HStack(spacing: 4) {
                Text("Б")
                    .font(.system(size: 13, weight: .heavy))
                    .foregroundStyle(.white)
                Text("Еблуша")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(.white)
                Image(systemName: "xmark")
                    .font(.system(size: 8, weight: .bold))
                    .foregroundStyle(.white.opacity(0.75))
            }
            .padding(.horizontal, 8)
            .frame(height: 22)
            .background(Eb.brand, in: Capsule())
            .dynamicTypeSize(.large)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Спросить Еблушу")
        .accessibilityHint("Убрать — сообщение уйдёт обычным")
    }
}
