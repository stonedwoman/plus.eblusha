import SwiftUI
import LiveKit

// Порт `ActiveCallUi` (+ `RingingUi`, плитки, панель управления) из `ui/call/CallScreen.kt`:
// раскладка в духе веб-CallOverlay — сетка/спотлайт участников, панель управления снизу.
//
// Отличия платформы (семантика сохранена):
//  - «Показ экрана» СВОЕГО экрана на iOS требует Broadcast Upload Extension — его в этой
//    фазе нет, поэтому кнопки нет; чужая демонстрация рендерится как обычно (CallManager
//    отдаёт её трек приоритетнее камеры);
//  - диалог «Настройки звонка» на Android содержал единственный пункт «Громкая связь» —
//    здесь этот переключатель живёт прямо на панели управления.

// Локальные цвета плиток (порт констант из CallScreen.kt).
private let tileBlack = Color(hex: 0x0B0D11)
private let tileAvatarBg = Color(hex: 0x15191F)
private let chipScrim = Color(hex: 0x0B0D11, opacity: 0.8) // 0xCC ≈ 80%
private let chipGold = Color(hex: 0xFFC46B)
private let callWarn = Color(hex: 0xF59E0B)

/// Экран активного звонка (фазы .connecting/.inCall).
struct CallView: View {
    @ObservedObject var manager: CallManager

    // Карточка пользователя по тапу на плитке участника (в вебе такого пока нет — мобильные первые).
    @State private var userCard: UserCardSeed?
    // Спотлайт per-плитка: максимум одна плитка в фокусе. `manualActive` — пользователь сам
    // трогал спотлайт, и его выбор (включая «назад к сетке» = nil) перекрывает авто-логику.
    @State private var manualActive = false
    @State private var manualSpotlight: String?

    var body: some View {
        let participants = manager.participants
        let withVideo = participants.filter(\.hasVideo)
        let screenSharer = participants.first(where: { $0.isScreenSharing })
        // Авто-спотлайт: демонстрация экрана всегда побеждает; иначе — единственная активная камера.
        let autoSpotlight = screenSharer?.id
            ?? ((participants.count > 1 && withVideo.count == 1) ? withVideo[0].id : nil)
        let spotlightId = manualActive ? manualSpotlight : autoSpotlight
        let focus = spotlightId.flatMap { id in participants.first(where: { $0.id == id }) }

        ZStack(alignment: .topLeading) {
            Eb.paper.ignoresSafeArea()

            VStack(spacing: 0) {
                Group {
                    if participants.isEmpty {
                        Text("Соединение…")
                            .foregroundStyle(Eb.textMuted)
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                    } else if let focus {
                        SpotlightTilesView(
                            focus: focus,
                            others: participants.filter { $0.id != focus.id },
                            e2ee: manager.e2eeEnabled,
                            spotlightId: spotlightId,
                            onToggleSpotlight: { toggleSpotlight($0, current: spotlightId) },
                            onOpenUser: openUser
                        )
                    } else {
                        // Сетка: все участники столбиком, каждому равная доля высоты.
                        VStack(spacing: 8) {
                            ForEach(participants) { participant in
                                ParticipantTileView(
                                    participant: participant,
                                    e2ee: manager.e2eeEnabled,
                                    isSpotlighted: false,
                                    onToggleSpotlight: { toggleSpotlight(participant.id, current: spotlightId) },
                                    onOpenUser: { openUser(participant) }
                                )
                                .frame(maxWidth: .infinity, maxHeight: .infinity)
                            }
                        }
                    }
                }
                .padding(8)
                .frame(maxWidth: .infinity, maxHeight: .infinity)

                collapseHandle
                CallControlBar(manager: manager)
            }

            ConnectionBadgeView(
                connecting: manager.phase == .connecting,
                activeSince: manager.activeSince
            )
            .padding(16)
        }
        .sheet(item: $userCard) { seed in
            UserCardSheet(
                seed: seed,
                onOpenConversation: { ref in
                    // Звонок сворачивается в плашку — из карточки участника можно уйти
                    // прямо в переписку, разговор продолжается.
                    userCard = nil
                    manager.minimize()
                    AppLifecycle.shared.requestOpenConversation(conversationId: ref.id, title: ref.title)
                },
                onDismiss: { userCard = nil },
                showConversationActions: true
            )
        }
    }

    private func toggleSpotlight(_ id: String, current spotlightId: String?) {
        manualActive = true
        manualSpotlight = (spotlightId == id) ? nil : id
    }

    private func openUser(_ participant: CallParticipant) {
        guard let userId = participant.userId else { return }
        userCard = UserCardSeed(userId: userId, name: participant.name, avatarUrl: participant.avatarUrl)
    }

    /// Ручка шторки: явные шевроны ВВЕРХ — за них (и вертикальным жестом по всему
    /// оверлею) звонок тянется вверх и сворачивается в плашку; тап делает то же самое.
    private var collapseHandle: some View {
        // Три шеврона В РЯД — однозначное «тяни ВВЕРХ» (центральный ярче).
        HStack(spacing: 10) {
            ForEach(0..<3, id: \.self) { i in
                Image(systemName: "chevron.up")
                    .font(.system(size: 20, weight: .semibold))
                    .foregroundStyle(Eb.textMuted.opacity(i == 1 ? 0.95 : 0.45))
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.bottom, 2)
        .contentShape(Rectangle())
        .onTapGesture {
            Task { @MainActor in
                await animateCallMinimizeProgress(manager, to: 1)
                manager.minimize()
            }
        }
        .accessibilityLabel("Свернуть звонок")
    }
}

// MARK: - Экран дозвона (исходящий)

/// Порт `RingingUi`: аватар + «Звоним…»/«Видеозвонок…» + отмена.
struct RingingView: View {
    let title: String
    let subtitle: String
    let avatarUrl: String?
    let onCancel: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            Spacer()
            AvatarView(name: title, avatarUrl: avatarUrl, size: 120)
            Spacer().frame(height: 16)
            Text(title)
                .font(.system(size: 28, weight: .semibold))
                .foregroundStyle(.white)
                .multilineTextAlignment(.center)
            Text(subtitle)
                .font(.system(size: 14))
                .foregroundStyle(Eb.textMuted)
            Spacer()
            CallBigButton(
                systemName: "phone.down.fill",
                container: Eb.error,
                label: "Отменить",
                action: onCancel
            )
            Spacer().frame(height: 40)
        }
        .padding(24)
    }
}

// MARK: - Спотлайт

/// Порт `SpotlightTiles`: лента остальных участников сверху, фокусная плитка — во весь остаток.
private struct SpotlightTilesView: View {
    let focus: CallParticipant
    let others: [CallParticipant]
    let e2ee: Bool
    let spotlightId: String?
    let onToggleSpotlight: (String) -> Void
    let onOpenUser: (CallParticipant) -> Void

    var body: some View {
        VStack(spacing: 8) {
            if !others.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(others) { participant in
                            ParticipantTileView(
                                participant: participant,
                                e2ee: e2ee,
                                isSpotlighted: participant.id == spotlightId,
                                onToggleSpotlight: { onToggleSpotlight(participant.id) },
                                onOpenUser: { onOpenUser(participant) }
                            )
                            .frame(width: 150)
                        }
                    }
                }
                .frame(height: 110)
            }
            ParticipantTileView(
                participant: focus,
                e2ee: e2ee,
                isSpotlighted: focus.id == spotlightId,
                onToggleSpotlight: { onToggleSpotlight(focus.id) },
                onOpenUser: { onOpenUser(focus) }
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}

// MARK: - Плитка участника

private struct ParticipantTileView: View {
    let participant: CallParticipant
    let e2ee: Bool
    let isSpotlighted: Bool
    let onToggleSpotlight: () -> Void
    let onOpenUser: () -> Void

    var body: some View {
        ZStack {
            if participant.hasVideo, let track = participant.videoTrack {
                // Центрированный fit-рендер → «contain»/леттербокс на чёрной плитке.
                CallVideoView(track: track, mirror: participant.isLocal)
            } else {
                GeometryReader { geo in
                    ZStack {
                        tileAvatarBg
                        AvatarView(
                            name: participant.name,
                            avatarUrl: participant.avatarUrl,
                            size: min(geo.size.width, geo.size.height) * 0.42
                        )
                    }
                    .frame(width: geo.size.width, height: geo.size.height)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(tileBlack)
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .overlay(alignment: .bottomLeading) { nameChip }
        .overlay(alignment: .bottomTrailing) { pingOrBars }
        .overlay(alignment: .topTrailing) { spotlightButton }
        .overlay {
            if participant.speaking {
                RoundedRectangle(cornerRadius: 14).strokeBorder(Eb.brand, lineWidth: 2.5)
            }
        }
        .contentShape(RoundedRectangle(cornerRadius: 14))
        // Тап — карточка участника; двойной тап — спотлайт (как и раньше).
        .gesture(
            TapGesture(count: 2).onEnded { onToggleSpotlight() }
                .exclusively(before: TapGesture().onEnded { onOpenUser() })
        )
    }

    /// Нижний левый чип: 🔒 (E2EE) + перечёркнутый микрофон (mute) + имя + « (мы)».
    private var nameChip: some View {
        HStack(spacing: 5) {
            if e2ee {
                Image(systemName: "lock.fill")
                    .font(.system(size: 11))
                    .foregroundStyle(chipGold)
                    .accessibilityLabel("Зашифровано")
            }
            if participant.muted {
                Image(systemName: "mic.slash.fill")
                    .font(.system(size: 11))
                    .foregroundStyle(Eb.error)
                    .accessibilityLabel("Микрофон выключен")
            }
            Text(participant.name + (participant.isLocal ? " (мы)" : ""))
                .font(.system(size: 12))
                .foregroundStyle(.white)
                .lineLimit(1)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(chipScrim, in: Capsule())
        .overlay(Capsule().strokeBorder(Color.white.opacity(0.12)))
        .padding(8)
    }

    /// Пинг вытесняет иконку качества связи: «N мс», а полоски сигнала — только
    /// пока пинга ещё нет.
    @ViewBuilder
    private var pingOrBars: some View {
        Group {
            if let ping = participant.pingMs {
                Text("\(ping) мс")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(pingColor(ping))
            } else {
                SignalBarsView(quality: participant.connectionQuality)
            }
        }
        .padding(10)
    }

    /// Спотлайт-кнопка плитки (правый верх). В фокусе может быть только одна плитка.
    private var spotlightButton: some View {
        Button(action: onToggleSpotlight) {
            Image(systemName: isSpotlighted
                ? "arrow.down.right.and.arrow.up.left"
                : "arrow.up.left.and.arrow.down.right")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(isSpotlighted ? Eb.brand : .white)
                .frame(width: 34, height: 34)
                .background(chipScrim, in: RoundedRectangle(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.white.opacity(0.12)))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(isSpotlighted ? "Убрать из спотлайта" : "В спотлайт")
        .padding(8)
    }
}

private func pingColor(_ ms: Int) -> Color {
    if ms <= 200 { return Eb.online }
    if ms <= 500 { return callWarn }
    return Eb.error
}

private struct SignalBarsView: View {
    let quality: ConnectionQuality

    var body: some View {
        let (filled, color) = Self.style(quality)
        HStack(alignment: .bottom, spacing: 2) {
            ForEach(1..<5, id: \.self) { i in
                RoundedRectangle(cornerRadius: 1)
                    .fill(i <= filled ? color : Color.white.opacity(0.22))
                    .frame(width: 3, height: CGFloat(3 + i * 3))
            }
        }
    }

    private static func style(_ quality: ConnectionQuality) -> (Int, Color) {
        switch quality {
        case .excellent: return (4, Eb.online)
        case .good: return (3, Eb.online)
        case .poor: return (2, callWarn)
        case .lost: return (1, Eb.error)
        default: return (0, Color.white.opacity(0.5))
        }
    }
}

// MARK: - Бейдж подключения

private struct ConnectionBadgeView: View {
    let connecting: Bool
    let activeSince: Date?

    var body: some View {
        // Длительность считает сам UI из activeSince (тик раз в секунду); на Android
        // таймер жил в полоске шапки чата — здесь он на бейдже, чтобы длительность
        // была видна и в развёрнутом звонке.
        TimelineView(.periodic(from: .now, by: 1)) { context in
            Text(label(now: context.date))
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(.white)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(chipScrim, in: Capsule())
                .overlay(Capsule().strokeBorder(Color.white.opacity(0.12)))
        }
    }

    private func label(now: Date) -> String {
        if connecting { return "Подключение…" }
        guard let activeSince else { return "Подключено" }
        return "Подключено · " + callDurationLabel(since: activeSince, now: now)
    }
}

// MARK: - Панель управления

/// Порт `CallControlBar`: mute / камера / выбор объектива / громкая связь / завершить.
private struct CallControlBar: View {
    @ObservedObject var manager: CallManager

    var body: some View {
        VStack(spacing: 0) {
            Divider().overlay(Eb.border)
            HStack(spacing: 8) {
                CallControlButton(
                    systemName: manager.micOn ? "mic.fill" : "mic.slash.fill",
                    label: "Микрофон",
                    tint: manager.micOn ? .white : Eb.error
                ) { manager.toggleMic() }
                // Камера и выбор объектива доступны в ЛЮБОМ звонке (аудио или видео):
                // «видео» — характеристика приглашения, а не отдельный режим. Камера
                // стартует выключенной, если звонок не начинался с видео.
                CallControlButton(
                    systemName: manager.cameraOn ? "video.fill" : "video.slash.fill",
                    label: "Камера",
                    tint: manager.cameraOn ? .white : Eb.error
                ) { manager.toggleCamera() }
                let cameras = manager.availableCameras()
                if cameras.count > 1 {
                    CameraPickerMenu(
                        cameras: cameras,
                        selectedId: manager.selectedCameraId,
                        onSelect: { manager.selectCamera(deviceId: $0) }
                    )
                }
                CallControlButton(
                    systemName: manager.speakerOn ? "speaker.wave.2.fill" : "speaker.slash.fill",
                    label: "Громкая связь",
                    tint: manager.speakerOn ? Eb.brand : .white
                ) { manager.toggleSpeaker() }
                Spacer()
                CallControlButton(
                    systemName: "phone.down.fill",
                    label: "Завершить",
                    tint: .white,
                    background: Eb.error
                ) { manager.hangUp() }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
        }
        .background(Eb.surface200)
    }
}

private struct CallControlButton: View {
    let systemName: String
    let label: String
    var tint: Color = .white
    var background: Color = Eb.surface300
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: 20, weight: .medium))
                .foregroundStyle(tint)
                .frame(width: 50, height: 50)
                .background(background, in: RoundedRectangle(cornerRadius: 14))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
}

/// Порт `CameraPicker`: узкий шеврон рядом с кнопкой камеры → меню физических камер
/// (фронтальная / задние объективы).
private struct CameraPickerMenu: View {
    let cameras: [CameraOption]
    let selectedId: String?
    let onSelect: (String) -> Void

    var body: some View {
        // nil = дефолт LiveKit (фронтальная) → подсвечиваем фронтальную, чтобы меню
        // совпадало с реальностью.
        let highlightedId = selectedId
            ?? cameras.first(where: { $0.facing == .front })?.deviceId
            ?? cameras.first?.deviceId
        Menu {
            Section("Камера") {
                ForEach(cameras) { camera in
                    Button {
                        onSelect(camera.deviceId)
                    } label: {
                        if camera.deviceId == highlightedId {
                            Label(camera.label, systemImage: "checkmark")
                        } else {
                            Text(camera.label)
                        }
                    }
                }
            }
        } label: {
            Image(systemName: "chevron.up")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 30, height: 50)
                .background(Eb.surface300, in: RoundedRectangle(cornerRadius: 14))
        }
        .accessibilityLabel("Выбор камеры")
    }
}

// MARK: - Видеорендер

/// Порт `LiveKitVideoView.kt`. Android-версии приходилось вручную делить EGL-контекст
/// комнаты (initVideoRenderer) и выбирать TextureView вместо SurfaceView; на iOS всё это
/// берёт на себя SwiftUIVideoView из LiveKit SDK — он сам подписывает/отписывает рендерер
/// у трека при монтировании и смене трека, поэтому Room сюда не нужен.
/// `layoutMode: .fit` — «contain»/леттербокс на чёрной плитке (роль WRAP_CONTENT +
/// SCALE_ASPECT_FIT в оригинале); зеркалим только свою камеру, как и там.
private struct CallVideoView: View {
    let track: VideoTrack
    let mirror: Bool

    var body: some View {
        SwiftUIVideoView(track, layoutMode: .fit, mirrorMode: mirror ? .mirror : .auto)
    }
}
