import SwiftUI

// «Без звука» в интерфейсе: пункты меню беседы, значок, выбор срока для свайпа и плашка
// подтверждения. Подписи — MuteText/MutePreset (одинаковые на всех платформах), состояние —
// ConversationMuteStore.

/// Первый пункт меню беседы (долгое нажатие на плитку, «Ещё» в шапке): «Без звука» → вложенное
/// меню сроков, либо «Включить звук» с подзаголовком «до 18:30» / «навсегда».
struct MuteMenuItems: View {
    let conversationId: String
    @ObservedObject private var store = ConversationMuteStore.shared

    var body: some View {
        if store.isMuted(conversationId) {
            Button {
                store.setMute(conversationId, preset: nil)
            } label: {
                // Второй Text в подписи пункта меню iOS рисует подзаголовком под названием.
                Label(MuteText.unmute, systemImage: "bell")
                Text(store.label(conversationId) ?? "")
            }
        } else {
            Menu {
                MutePresetButtons(conversationId: conversationId)
            } label: {
                Label(MuteText.mute, systemImage: "bell.slash")
            }
        }
    }
}

/// «1 час» … «Навсегда» — для подменю и для листа выбора срока.
struct MutePresetButtons: View {
    let conversationId: String

    var body: some View {
        ForEach(MutePreset.allCases) { preset in
            Button(preset.title) {
                ConversationMuteStore.shared.setMute(conversationId, preset: preset)
            }
        }
    }
}

/// Перечёркнутый колокольчик после названия беседы (плитка, шапка). Цвет приглушённый: это
/// пометка, а не призыв. Доступное имя — «Без звука», значение — срок («Без звука до 18:30»).
struct MutedBellIcon: View {
    var size: CGFloat = 12
    var tip: String?

    var body: some View {
        Image(systemName: "bell.slash.fill")
            .font(.system(size: size, weight: .semibold))
            .foregroundStyle(Eb.textMuted)
            .fixedSize()
            .accessibilityLabel(MuteText.mute)
            .accessibilityValue(tip ?? "")
            .help(tip ?? MuteText.mute)
    }
}

/// Плашка «Без звука на 1 час» / «Звук включён» / «Не удалось изменить звук беседы» поверх экрана.
/// Своих тостов у iOS-клиента не было — подтверждение действия иначе нечем показать, а ошибку
/// молча проглатывать нельзя.
struct MuteToastOverlay: ViewModifier {
    @ObservedObject private var store = ConversationMuteStore.shared

    func body(content: Content) -> some View {
        content.overlay(alignment: .bottom) {
            if let toast = store.toast {
                HStack(spacing: 8) {
                    Image(systemName: toast.isError ? "exclamationmark.circle" : (toast.text == MuteText.unmuted ? "bell" : "bell.slash"))
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(toast.isError ? Eb.error : Eb.textMuted)
                    Text(toast.text)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(Eb.textPrimary)
                        .lineLimit(2)
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(Eb.surface300, in: Capsule())
                .overlay(Capsule().strokeBorder(Eb.borderStrong))
                .shadow(color: .black.opacity(0.25), radius: 8, y: 3)
                // Над нижней панелью списка и над полем ввода беседы.
                .padding(.bottom, 150)
                .padding(.horizontal, 24)
                .transition(.opacity.combined(with: .move(edge: .bottom)))
                .allowsHitTesting(false)
                .accessibilityAddTraits(.isStaticText)
                .task(id: toast.id) {
                    try? await Task.sleep(for: .seconds(2.2))
                    if store.toast?.id == toast.id {
                        withAnimation(.easeOut(duration: 0.25)) { store.toast = nil }
                    }
                }
            }
        }
        .animation(.easeOut(duration: 0.2), value: store.toast)
    }
}

extension View {
    /// Плашка подтверждения «Без звука» (MuteToastOverlay).
    func muteToast() -> some View { modifier(MuteToastOverlay()) }

    /// Лист «Без звука на…» для свайпа по плитке: пять сроков и «Отмена».
    func mutePicker(_ target: Binding<Conversation?>) -> some View {
        confirmationDialog(
            MuteText.pickerTitle,
            isPresented: Binding(
                get: { target.wrappedValue != nil },
                set: { if !$0 { target.wrappedValue = nil } }
            ),
            titleVisibility: .visible,
            presenting: target.wrappedValue
        ) { conversation in
            MutePresetButtons(conversationId: conversation.id)
            Button(MuteText.cancel, role: .cancel) {}
        }
    }
}
