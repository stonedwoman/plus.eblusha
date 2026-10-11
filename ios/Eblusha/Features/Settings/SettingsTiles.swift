import SwiftUI

// Плитки обзора «Центра управления» (SPEC §1.2, §3.5): подложка-кнопка на всю плитку, поверх
// неё содержимое с живым состоянием; действия плитки — отдельные кнопки СВЕРХУ, вложенных кнопок
// в кнопке нет. Плитка целиком — вход в раздел. Нажатие: масштаб .98 и подсветка #2B303A.

// MARK: - Подложка

private struct TileSurfaceStyle: ButtonStyle {
    var attention: Bool
    var matched: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        let pressed = configuration.isPressed
        configuration.label
            .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(pressed ? Eb.surface300 : Eb.surface200))
            .overlay(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .strokeBorder(ring(pressed: pressed), lineWidth: 1)
            )
            .scaleEffect(pressed && !reduceMotion ? 0.98 : 1)
            .animation(.easeOut(duration: 0.12), value: pressed)
    }

    private func ring(pressed: Bool) -> Color {
        if attention { return Eb.danger.opacity(0.55) }
        if matched { return Eb.brand600 }
        return pressed ? Eb.borderHover : Eb.border
    }
}

/// Плитка: голова (квадрат-значок, имя, янтарная точка, «!»), содержимое, действие поверх.
struct SettingsTile<Content: View, Action: View>: View {
    let section: SettingsSectionID
    let accessibilityName: String
    var attention = false
    var dot = false
    var banner = false
    var minHeight: CGFloat = 156
    var zoom: Namespace.ID
    var onOpen: () -> Void
    @ViewBuilder var content: Content
    @ViewBuilder var action: Action

    var body: some View {
        ZStack(alignment: .bottomLeading) {
            Button(action: onOpen) {
                VStack(alignment: .leading, spacing: 0) {
                    if banner {
                        ZStack(alignment: .topLeading) {
                            ProfileBanner().frame(height: 52)
                            head.padding(.horizontal, 14).padding(.top, 10)
                        }
                        content
                    } else {
                        head.padding(.horizontal, 14).padding(.top, 14)
                        content
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                .contentShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            }
            .buttonStyle(TileSurfaceStyle(attention: attention, matched: false))
            .matchedTransitionSource(id: section.id, in: zoom) { source in
                source.clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            }
            .accessibilityLabel(accessibilityName)
            .accessibilityHint("Открыть раздел")
            action
                .padding(.leading, 14)
                .padding(.bottom, 14)
        }
        .frame(minHeight: minHeight)
    }

    private var head: some View {
        HStack(spacing: 8) {
            EbIconSquare(symbol: section.symbol, side: 28, icon: 14, radius: 8)
            Text(section.title)
                .ebFont(14.5, .bold, relativeTo: .subheadline)
                .foregroundStyle(Eb.textPrimary)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
            if dot {
                Circle().fill(Eb.brand600).frame(width: 8, height: 8)
                    .padding(3)
                    .background(Circle().fill(Eb.brand600.opacity(0.18)))
                    .accessibilityHidden(true)
            }
            Spacer(minLength: 4)
            if attention {
                Text("!")
                    .font(.system(size: 11, weight: .heavy))
                    .foregroundStyle(.white)
                    .frame(width: 18, height: 18)
                    .background(Circle().fill(Eb.danger))
                    .overlay(Circle().strokeBorder(Eb.surface200, lineWidth: 2))
                    .accessibilityHidden(true)
            }
        }
    }
}

extension SettingsTile where Action == EmptyView {
    init(
        section: SettingsSectionID, accessibilityName: String, attention: Bool = false, dot: Bool = false,
        banner: Bool = false, minHeight: CGFloat = 156, zoom: Namespace.ID, onOpen: @escaping () -> Void,
        @ViewBuilder content: () -> Content
    ) {
        self.init(
            section: section, accessibilityName: accessibilityName, attention: attention, dot: dot,
            banner: banner, minHeight: minHeight, zoom: zoom, onOpen: onOpen,
            content: content, action: { EmptyView() }
        )
    }
}

// MARK: - Мини-строка плитки

/// Строка 36 высотой: значок 15 янтарём и значение 13.5 SemiBold с многоточием; ошибка — красная
/// плёнка, значок и текст #FECACA. Над ней разделитель (кроме первой).
struct TileMiniRow: View {
    let symbol: String
    let text: String
    var isError = false
    var first = false

    var body: some View {
        VStack(spacing: 0) {
            if !first { Rectangle().fill(Eb.border).frame(height: 1) }
            HStack(spacing: 8) {
                EbIcon(name: isError ? "exclamationmark.circle" : symbol, size: 15, color: isError ? Eb.danger : Eb.brand600)
                    .frame(width: 17)
                Text(text)
                    .ebFont(13, .semibold)
                    .foregroundStyle(isError ? Eb.dangerText : Eb.textPrimary)
                    .lineLimit(isError ? 2 : 1)
                    .minimumScaleFactor(0.82)
                Spacer(minLength: 0)
            }
            .padding(.vertical, 8)
            .frame(minHeight: 36)
            .background(isError ? Eb.danger.opacity(0.06) : .clear)
        }
        .padding(.horizontal, 14)
    }
}

// MARK: - Содержимое плиток

/// «Профиль»: баннер, аватар 60, имя 20 сливками, капсулы EBLID и ручного статуса.
struct ProfileTileContent: View {
    let name: String
    let avatarUrl: String?
    let eblid: String?
    let status: SettingsText.StatusOption
    var hint: String?

    private var eblidCapsule: some View { EbEblidCapsule(eblid: eblid, height: 26) }

    private var statusCapsule: some View {
        EbCapsule(height: 26) {
            Circle().fill(status.color).frame(width: 8, height: 8)
            Text(status.label).ebFont(12.5).foregroundStyle(Eb.textMuted).lineLimit(1).fixedSize()
        }
        .accessibilityHidden(true)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 14) {
                AvatarView(name: name, avatarUrl: avatarUrl, size: 60)
                    .overlay(Circle().strokeBorder(Eb.surface200, lineWidth: 4).padding(-4))
                VStack(alignment: .leading, spacing: 6) {
                    Text(name)
                        .ebFont(20, .bold, relativeTo: .title3)
                        .tracking(-0.3)
                        .foregroundStyle(Eb.logoCream)
                        .lineLimit(1)
                    // Крупный шрифт: капсулы встают друг под другом, а не ломают строку.
                    ViewThatFits(in: .horizontal) {
                        HStack(spacing: 6) { eblidCapsule; statusCapsule }
                        VStack(alignment: .leading, spacing: 6) { eblidCapsule; statusCapsule }
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 14)
            .padding(.top, 16)
            .padding(.bottom, hint == nil ? 16 : 6)
            if let hint {
                Text(hint)
                    .ebFont(13.5, .semibold)
                    .foregroundStyle(Eb.logoCream)
                    .padding(.horizontal, 14)
                    .padding(.bottom, 14)
            }
        }
    }
}

/// «Соединение»: крупно «Напрямую» / «Через СПб» и моно-капсула с адресом. Низа нет: на iOS
/// ретранслятора нет.
struct ConnectionTileContent: View {
    let server: AppConfig.Server

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(server.routeTitle)
                .ebFont(23, .bold, relativeTo: .title2)
                .tracking(-0.3)
                .foregroundStyle(Eb.logoCream)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
            EbCapsule(height: 26, horizontal: 10) {
                Text(server.title).ebFont(12, mono: true).foregroundStyle(Eb.textMuted).lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 14)
        .padding(.top, 12)
        .padding(.bottom, 14)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

/// «Звук и видео»: доступ к микрофону и камере. Нет доступа — строка красная; кнопка «Настройки»
/// ложится поверх плитки внизу (`SettingsTile.action`), здесь для неё оставлено место.
struct AvTileContent: View {
    let mic: PermissionState
    let cam: PermissionState
    var reserveAction: Bool

    var body: some View {
        VStack(spacing: 0) {
            TileMiniRow(symbol: "mic", text: PermissionText.tileLine("Микрофон", mic), isError: mic.isDenied, first: true)
            TileMiniRow(symbol: "video", text: PermissionText.tileLine("Камера", cam), isError: cam.isDenied)
            if reserveAction { Color.clear.frame(height: 46) }
            Spacer(minLength: 0)
        }
        .padding(.top, 10)
    }
}

/// «Безопасность»: число устройств 23 + слово 15, «где открыт аккаунт», внизу — ключи.
struct SecurityTileContent: View {
    let state: SecurityTileState

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            switch state {
            case .loading:
                HStack(spacing: 10) {
                    ProgressView().controlSize(.small).tint(Eb.logoCream)
                    Text("Загружаем…").ebFont(14).foregroundStyle(Eb.logoCream)
                }
                .padding(.top, 14)
                Spacer(minLength: 0)
            case .failed:
                Text("Не загрузилось")
                    .ebFont(20, .bold, relativeTo: .title3)
                    .foregroundStyle(Eb.dangerText)
                    .padding(.top, 10)
                Text("Не удалось загрузить список устройств.")
                    .ebFont(13.5).foregroundStyle(Eb.textMuted)
                    .padding(.top, 4)
                Spacer(minLength: 0)
            case .ready(let count, let keysReady):
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text("\(count)")
                        .ebFont(23, .bold, relativeTo: .title2, digits: true)
                        .foregroundStyle(Eb.logoCream)
                    Text(SettingsText.plural(count, "устройство", "устройства", "устройств"))
                        .ebFont(15, .semibold)
                        .foregroundStyle(Eb.logoCream)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                }
                .padding(.top, 10)
                Text("где открыт аккаунт")
                    .ebFont(13.5).foregroundStyle(Eb.textMuted)
                    .padding(.top, 2)
                Spacer(minLength: 8)
                HStack(spacing: 8) {
                    if keysReady {
                        EbIcon(name: "checkmark", size: 14, color: Eb.brand600, weight: .semibold)
                        Text("ключи готовы").ebFont(13.5).foregroundStyle(Eb.textMuted)
                    } else {
                        EbIcon(name: "info.circle", size: 14, color: Eb.brand600)
                        Text("ключи не готовы").ebFont(13.5, .semibold).foregroundStyle(Eb.brand600)
                    }
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.bottom, 14)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

/// «Приложение»: видео, звуки, уведомления.
struct AppTileContent: View {
    let autoplay: VideoAutoplayMode
    let soundIncoming: Bool
    let soundOutgoing: Bool
    let notifications: NotificationSummary?

    var body: some View {
        let notif = SettingsSummary.notificationsLine(notifications)
        VStack(spacing: 0) {
            TileMiniRow(symbol: "play.circle", text: SettingsSummary.videoLine(autoplay), first: true)
            TileMiniRow(symbol: "speaker.wave.2", text: SettingsSummary.soundsLine(incoming: soundIncoming, outgoing: soundOutgoing))
            TileMiniRow(symbol: "bell", text: notif.text, isError: notif.isError)
            Spacer(minLength: 0)
        }
        .padding(.top, 10)
    }
}
