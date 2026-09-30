import SwiftUI
import LiveKit

// Порт `frontend/src/ui/components/CallMini.tsx` + `callMini.css` — миниатюра свёрнутого
// звонка (спека `docs/call-mini.md`). Выбор говорящего (500 мс удержания, «липкость» в
// тишине), магниты углов, свободное размещение долями, язычок и память места перенесены
// один в один; телефонные числа — из спеки: ширина ≈44 % короткой стороны экрана в пределах
// 150–220 pt, отступ 12, магнит 56, TOP_GUARD = safe area сверху + навбар,
// BOTTOM_GUARD = safe area снизу + композер.
//
// Отличия платформы (семантика сохранена):
//  - веб рендерит плитку порталом в body, чтобы не зависеть от скрытого контейнера оверлея;
//    здесь CallOverlay и так лежит поверх всего приложения в ZStack RootView, а комната
//    LiveKit живёт в CallManager и при сворачивании не разрушается;
//  - кнопок «В угол» и «Камера» на телефоне нет (спека), горячих клавиш тоже;
//  - развернуть — одиночный тап (на ПК двойной клик), перетаскивание — от 4 pt.

// MARK: - Снимок состояния

/// Что показывает плитка. Значения, а не сам CallManager: DEBUG-стенд собирает снимок без
/// комнаты, а плитке всё равно, откуда пришли участники.
struct CallMiniSnapshot {
    var participants: [CallParticipant] = []
    /// Кто говорит прямо сейчас, громкий первым — порядок SDK (room.activeSpeakers).
    var activeSpeakerIds: [String] = []
    var micOn = true
    var cameraOn = false
    var isGroup = false
    var encrypted = false
    /// Момент реального соединения — от него таймер. nil — таймера нет.
    var connectedAt: Date?
    var reconnecting = false
}

// MARK: - Размещение и его память

enum CallMiniSide: String, Codable {
    case left, right
}

/// Где стоит плитка: угол, свободное место ДОЛЯМИ доступного диапазона (при смене размеров
/// остаётся «на том же месте») или язычок у края. JSON тот же, что у веба в localStorage
/// `eb.call.mini`, поэтому Codable свой, а не синтезированный.
enum CallMiniPlacement: Equatable {
    case corner(Int)
    case free(fx: Double, fy: Double)
    case tongue(side: CallMiniSide, y: Double)
}

extension CallMiniPlacement: Codable {
    private enum Keys: String, CodingKey { case kind, corner, fx, fy, side, y }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        switch try c.decode(String.self, forKey: .kind) {
        case "corner":
            let corner = try c.decode(Int.self, forKey: .corner)
            guard (0...3).contains(corner) else {
                throw DecodingError.dataCorruptedError(forKey: .corner, in: c, debugDescription: "угол вне 0…3")
            }
            self = .corner(corner)
        case "free":
            self = .free(fx: try c.decode(Double.self, forKey: .fx), fy: try c.decode(Double.self, forKey: .fy))
        case "tongue":
            self = .tongue(side: try c.decode(CallMiniSide.self, forKey: .side), y: try c.decode(Double.self, forKey: .y))
        default:
            throw DecodingError.dataCorruptedError(forKey: .kind, in: c, debugDescription: "неизвестный kind")
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        switch self {
        case .corner(let corner):
            try c.encode("corner", forKey: .kind)
            try c.encode(corner, forKey: .corner)
        case .free(let fx, let fy):
            try c.encode("free", forKey: .kind)
            try c.encode(fx, forKey: .fx)
            try c.encode(fy, forKey: .fy)
        case .tongue(let side, let y):
            try c.encode("tongue", forKey: .kind)
            try c.encode(side, forKey: .side)
            try c.encode(y, forKey: .y)
        }
    }
}

/// Память места — UserDefaults под тем же ключом, что localStorage веба.
enum CallMiniPlacementStore {
    static let key = "eb.call.mini"

    static func load() -> CallMiniPlacement {
        if let raw = UserDefaults.standard.string(forKey: key),
           let data = raw.data(using: .utf8),
           let placement = try? JSONDecoder().decode(CallMiniPlacement.self, from: data) {
            return placement
        }
        return .corner(1)
    }

    static func save(_ placement: CallMiniPlacement) {
        guard let data = try? JSONEncoder().encode(placement),
              let raw = String(data: data, encoding: .utf8) else { return }
        UserDefaults.standard.set(raw, forKey: key)
    }
}

// MARK: - Геометрия

/// Геометрия плитки на экране — чистые функции от размера окна и safe area (порт size /
/// corners / clampFree / resolve / toFree из CallMini.tsx). Координаты — окно целиком,
/// начало в левом верхнем углу, точка плитки — её левый верхний угол.
struct CallMiniGeometry {
    static let margin: CGFloat = 12
    static let snap: CGFloat = 56
    /// Системная панель навигации над экраном беседы.
    static let navBar: CGFloat = 44
    /// Композер беседы у нижнего края.
    static let composer: CGFloat = 72
    static let tongueHeight: CGFloat = 48

    let screen: CGSize
    let topGuard: CGFloat
    let bottomGuard: CGFloat

    init(screen: CGSize, safeTop: CGFloat, safeBottom: CGFloat) {
        self.screen = screen
        topGuard = safeTop + Self.navBar
        bottomGuard = safeBottom + Self.composer
    }

    var tile: CGSize {
        let width = min(220, max(150, 0.44 * min(screen.width, screen.height)))
        return CGSize(width: width, height: (width * 9 / 16).rounded())
    }

    /// Четыре угла: верх-лево, верх-право, низ-лево, низ-право.
    var corners: [CGPoint] {
        let size = tile
        let m = Self.margin
        return [
            CGPoint(x: m, y: topGuard + m),
            CGPoint(x: screen.width - size.width - m, y: topGuard + m),
            CGPoint(x: m, y: screen.height - size.height - bottomGuard),
            CGPoint(x: screen.width - size.width - m, y: screen.height - size.height - bottomGuard),
        ]
    }

    func nearestCorner(to point: CGPoint) -> Int {
        var best = 0
        var bestDistance = CGFloat.infinity
        for (index, corner) in corners.enumerated() {
            let d = (corner.x - point.x) * (corner.x - point.x) + (corner.y - point.y) * (corner.y - point.y)
            if d < bestDistance {
                bestDistance = d
                best = index
            }
        }
        return best
    }

    func distance(toCorner index: Int, from point: CGPoint) -> CGFloat {
        let corner = corners[index]
        return hypot(corner.x - point.x, corner.y - point.y)
    }

    func clampFree(_ point: CGPoint) -> CGPoint {
        let size = tile
        return CGPoint(
            x: min(max(point.x, 0), max(0, screen.width - size.width)),
            y: min(max(point.y, topGuard), max(topGuard, screen.height - size.height))
        )
    }

    /// Куда тянуть можно: за левый/правый край до 60 % ширины, сверху не выше TOP_GUARD,
    /// снизу — до BOTTOM_GUARD плюс полвысоты плитки.
    func clampDrag(_ point: CGPoint) -> CGPoint {
        let size = tile
        return CGPoint(
            x: min(max(point.x, -size.width * 0.6), screen.width - size.width * 0.4),
            y: min(max(point.y, topGuard), screen.height - size.height - bottomGuard + size.height * 0.5)
        )
    }

    /// Положение по записанному размещению; у язычка плитки нет — nil.
    func resolve(_ placement: CallMiniPlacement) -> CGPoint? {
        switch placement {
        case .corner(let index):
            return corners[min(max(index, 0), 3)]
        case .free(let fx, let fy):
            let size = tile
            return clampFree(CGPoint(
                x: fx * max(0, screen.width - size.width),
                y: topGuard + fy * max(0, screen.height - size.height - topGuard)
            ))
        case .tongue:
            return nil
        }
    }

    func freePlacement(at point: CGPoint) -> CallMiniPlacement {
        let size = tile
        let clamped = clampFree(point)
        return .free(
            fx: clamped.x / max(1, screen.width - size.width),
            fy: (clamped.y - topGuard) / max(1, screen.height - size.height - topGuard)
        )
    }

    func tongueY(_ y: CGFloat) -> CGFloat {
        min(max(y, topGuard + Self.margin), screen.height - Self.tongueHeight - bottomGuard)
    }

    enum Drop: Equatable {
        case tongue(CallMiniSide)
        case corner(Int)
        case free
    }

    /// Куда отпускать: язычок, если вытянули за край на четверть ширины; угол, если
    /// в радиусе магнита; иначе свободное место.
    func drop(at point: CGPoint) -> Drop {
        let width = tile.width
        if point.x < -width * 0.25 { return .tongue(.left) }
        if point.x + width > screen.width + width * 0.25 { return .tongue(.right) }
        let index = nearestCorner(to: point)
        return distance(toCorner: index, from: point) <= Self.snap ? .corner(index) : .free
    }
}

/// m:ss без перехода в часы — как formatElapsed на вебе.
func callMiniElapsed(since: Date, now: Date) -> String {
    let seconds = max(0, Int(now.timeIntervalSince(since)))
    return String(format: "%d:%02d", seconds / 60, seconds % 60)
}

// MARK: - Палитра плитки (числа из callMini.css)

private enum MiniInk {
    static let bg = Color(hex: 0x14171D)
    static let faceInner = Color(hex: 0x2A2420)
    static let scrim = Color(hex: 0x0F1217, opacity: 0.65)
    static let bar = Color(hex: 0x0A0C10)
    static let cream = Color(hex: 0xF4E8C9)
    static let green = Color(hex: 0x22C55E)
    static let danger = Color(hex: 0xEF4444)
    static let amber = Color(hex: 0xE38B0A)
    static let amberBg = Color(hex: 0xD97706, opacity: 0.35)
    static let ghostBorder = Color(hex: 0xE38B0A, opacity: 0.5)
    static let ghostBg = Color(hex: 0xD97706, opacity: 0.05)
    static let shadow = Color(hex: 0x050609)
}

/// cubic-bezier(.2,.8,.2,1) за 320 мс — прилипание к углу, выезд из-за края, прилёт.
let callMiniSnapCurve = Animation.timingCurve(0.2, 0.8, 0.2, 1, duration: 0.32)

// MARK: - Плитка

struct CallMiniView: View {
    let snapshot: CallMiniSnapshot
    /// Прямоугольник панели звонка (координаты окна), из которого плитка прилетает при
    /// сворачивании; nil — появиться сразу на месте.
    let flyFrom: CGRect?
    /// Развернуть; аргумент — прямоугольник плитки, из которого разъедется панель.
    let onExpand: (CGRect) -> Void
    let onToggleMic: () -> Void
    let onHangUp: () -> Void

    /// Говорящий сменяется не мгновенно: короткое «угу» не должно дёргать плитку.
    static let speakerHoldNanos: UInt64 = 500_000_000

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var placement: CallMiniPlacement
    /// Положение, перекрывающее записанное место: пока тянем и пока плитка едет из-за края.
    @State private var overridePos: CGPoint?
    /// Откуда начали тянуть — положение плитки в момент касания.
    @State private var dragStart: CGPoint?
    /// Жест идёт: сбрасывается системой сам, даже если onEnded не пришёл.
    @GestureState private var dragging = false
    /// Точка угла, к которому прилипнем, — под ней рисуется призрак.
    @State private var magnet: CGPoint?
    /// Пока не nil, плитка растянута на прямоугольник панели — стартовый кадр прилёта.
    @State private var entering: CGRect?
    /// Кто в плитке. В тишине остаётся последний показанный.
    @State private var shownId: String?

    init(
        snapshot: CallMiniSnapshot,
        flyFrom: CGRect? = nil,
        onExpand: @escaping (CGRect) -> Void,
        onToggleMic: @escaping () -> Void,
        onHangUp: @escaping () -> Void
    ) {
        self.snapshot = snapshot
        self.flyFrom = flyFrom
        self.onExpand = onExpand
        self.onToggleMic = onToggleMic
        self.onHangUp = onHangUp
        let stored = CallMiniPlacementStore.load()
        _placement = State(initialValue: stored)
        // Язычку прилетать неоткуда: у него нет плитки.
        if case .tongue = stored {
            _entering = State(initialValue: nil)
        } else {
            _entering = State(initialValue: flyFrom)
        }
    }

    // ── кто в плитке ──

    private var remote: [CallParticipant] { snapshot.participants.filter { !$0.isLocal } }
    private var remoteKey: String { remote.map(\.id).joined(separator: "|") }
    private var shown: CallParticipant? { remote.first { $0.id == shownId } ?? remote.first }
    private var shownName: String {
        let name = shown?.name.trimmingCharacters(in: .whitespaces) ?? ""
        return name.isEmpty ? "Собеседник" : name
    }
    private var shownSpeaking: Bool {
        guard let shown else { return false }
        return shown.speaking || snapshot.activeSpeakerIds.contains(shown.id)
    }
    /// Говорящий среди удалённых: по порядку SDK (громкий первым), иначе по флагу участника.
    private var speakingRemote: String? {
        let ids = Set(remote.map(\.id))
        return snapshot.activeSpeakerIds.first { ids.contains($0) } ?? remote.first { $0.speaking }?.id
    }
    private var holdKey: String { (speakingRemote ?? "") + "|" + (shownId ?? "") }
    private var localTrack: VideoTrack? {
        guard snapshot.cameraOn else { return nil }
        return snapshot.participants.first { $0.isLocal }?.videoTrack
    }

    var body: some View {
        // Reader НЕ игнорирует safe area: только так он честно отдаёт её отступы (у
        // игнорирующего они нули). Холст плитки при этом — всё окно: полный размер и
        // сдвиг на отступы. Клавиатуру не учитываем: плитка над ней не прыгает.
        GeometryReader { geo in
            let insets = geo.safeAreaInsets
            let screen = CGSize(
                width: geo.size.width + insets.leading + insets.trailing,
                height: geo.size.height + insets.top + insets.bottom
            )
            let g = CallMiniGeometry(screen: screen, safeTop: insets.top, safeBottom: insets.bottom)
            ZStack(alignment: .topLeading) {
                switch placement {
                case .tongue(let side, let y):
                    tongue(side: side, y: y, g)
                default:
                    if let magnet { ghost(at: magnet, g) }
                    tile(g)
                }
            }
            .frame(width: screen.width, height: screen.height, alignment: .topLeading)
            .offset(x: -insets.leading, y: -insets.top)
            // Жест оборвался без onEnded (системное прерывание) — доводим, как при отпускании.
            .onChange(of: dragging) { _, active in
                guard !active, dragStart != nil else { return }
                dragStart = nil
                magnet = nil
                if let at = overridePos { release(at: at, g) }
            }
        }
        .ignoresSafeArea(.keyboard)
        .onAppear {
            guard entering != nil else { return }
            if reduceMotion {
                entering = nil
                return
            }
            // Кадр с растянутой плиткой должен успеть отрисоваться: иначе анимации не от чего идти.
            DispatchQueue.main.async {
                withAnimation(callMiniSnapCurve) { entering = nil }
            }
        }
        .onChange(of: remoteKey, initial: true) { _, _ in
            if let shownId, remote.contains(where: { $0.id == shownId }) { return }
            shownId = remote.first?.id
        }
        // Смена показанного — только после 500 мс непрерывной речи другого; ключ меняется —
        // задача отменяется, как cleanup эффекта на вебе.
        .task(id: holdKey) {
            guard let speakingRemote, speakingRemote != shownId else { return }
            try? await Task.sleep(nanoseconds: Self.speakerHoldNanos)
            if !Task.isCancelled { shownId = speakingRemote }
        }
    }

    // MARK: Плитка

    private func tile(_ g: CallMiniGeometry) -> some View {
        let size = g.tile
        let rest = g.resolve(placement) ?? g.corners[1]
        let at = overridePos ?? rest
        let shown = self.shown
        let speaking = shownSpeaking
        let expand = { onExpand(CGRect(origin: at, size: size)) }

        return ZStack {
            face(shown: shown, speaking: speaking, size: size)
        }
        .frame(width: size.width, height: size.height)
        .overlay(alignment: .bottomLeading) {
            if let localTrack {
                // Наша камера — маленький «пип» над нижней панелью.
                SwiftUIVideoView(localTrack, layoutMode: .fill, mirrorMode: .mirror)
                    .frame(width: 64, height: 40)
                    .background(Color.black)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                    .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Eb.borderStrong, lineWidth: 1))
                    .allowsHitTesting(false)
                    .padding(.leading, 8)
                    .padding(.bottom, 46)
            }
        }
        .overlay(alignment: .top) { topBar(speaking: speaking, width: size.width, expand: expand) }
        .overlay(alignment: .bottom) { bottomBar }
        .background(MiniInk.bg)
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .overlay(
            RoundedRectangle(cornerRadius: 14)
                .strokeBorder(outlineColor(speaking: speaking), lineWidth: speaking || snapshot.reconnecting ? 2 : 1)
                .animation(reduceMotion ? nil : .easeInOut(duration: 0.2), value: speaking)
        )
        .shadow(
            color: MiniInk.shadow.opacity(dragging ? 0.75 : 0.6),
            radius: dragging ? 30 : 20,
            y: dragging ? 24 : 16
        )
        .contentShape(RoundedRectangle(cornerRadius: 14))
        .onTapGesture(perform: expand)
        .gesture(dragGesture(g))
        .scaleEffect(
            x: entering.map { $0.width / size.width } ?? 1,
            y: entering.map { $0.height / size.height } ?? 1,
            anchor: .topLeading
        )
        .offset(x: entering?.minX ?? at.x, y: entering?.minY ?? at.y)
        .opacity(entering == nil ? 1 : 0.4)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Свёрнутый звонок")
    }

    private func outlineColor(speaking: Bool) -> Color {
        if snapshot.reconnecting { return MiniInk.danger }
        return speaking ? MiniInk.green : Eb.borderStrong
    }

    @ViewBuilder
    private func face(shown: CallParticipant?, speaking: Bool, size: CGSize) -> some View {
        ZStack {
            RadialGradient(
                colors: [MiniInk.faceInner, MiniInk.bg],
                center: UnitPoint(x: 0.3, y: 0.2),
                startRadius: 0,
                endRadius: size.width * 1.2
            )
            if let track = shown?.videoTrack {
                // Показ экрана важнее лица — CallParticipant.videoTrack уже отдаёт его первым.
                SwiftUIVideoView(track, layoutMode: .fill)
                    .background(Color.black)
                    .allowsHitTesting(false)
            } else if let shown {
                MiniSpeakingAvatar(name: shownName, avatarUrl: shown.avatarUrl, size: 76, speaking: speaking)
            } else {
                Text(snapshot.isGroup ? "Пока никого" : "Ждём собеседника")
                    .font(.system(size: 13))
                    .foregroundStyle(Eb.textMuted)
            }
        }
    }

    private func topBar(speaking: Bool, width: CGFloat, expand: @escaping () -> Void) -> some View {
        HStack(spacing: 6) {
            HStack(spacing: 6) {
                if snapshot.encrypted {
                    Image(systemName: "lock.fill")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(MiniInk.amber)
                        .accessibilityLabel("Сквозное шифрование")
                }
                Text(shownName)
                    .lineLimit(1)
                    .truncationMode(.tail)
                if speaking {
                    Text("говорит")
                        .fontWeight(.medium)
                        .foregroundStyle(MiniInk.green)
                        .layoutPriority(1)
                }
            }
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(Eb.textPrimary)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(MiniInk.scrim, in: Capsule())
            .frame(maxWidth: width * 0.7, alignment: .leading)
            Spacer(minLength: 0)
            MiniButton(
                systemName: "arrow.up.left.and.arrow.down.right",
                label: "Развернуть звонок",
                style: .amber,
                action: expand
            )
        }
        .padding(8)
        .background(
            LinearGradient(
                colors: [MiniInk.bar.opacity(0.75), MiniInk.bar.opacity(0)],
                startPoint: .top, endPoint: .bottom
            )
        )
    }

    private var bottomBar: some View {
        HStack(spacing: 6) {
            if snapshot.reconnecting {
                MiniBlinkingText("Переподключение…")
            } else if let since = snapshot.connectedAt {
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    Text(callMiniElapsed(since: since, now: context.date))
                        .font(.system(size: 12, weight: .semibold).monospacedDigit())
                        .foregroundStyle(MiniInk.cream)
                }
            }
            Spacer(minLength: 0)
            MiniButton(
                systemName: snapshot.micOn ? "mic.fill" : "mic.slash.fill",
                label: snapshot.micOn ? "Выключить микрофон" : "Включить микрофон",
                style: snapshot.micOn ? .normal : .off,
                action: onToggleMic
            )
            MiniButton(
                systemName: "phone.down.fill",
                label: snapshot.isGroup ? "Выйти из звонка" : "Завершить звонок",
                style: .danger,
                action: onHangUp
            )
        }
        .padding(8)
        .background(
            LinearGradient(
                colors: [MiniInk.bar.opacity(0), MiniInk.bar.opacity(0.8)],
                startPoint: .top, endPoint: .bottom
            )
        )
    }

    // MARK: Призрак угла

    private func ghost(at point: CGPoint, _ g: CallMiniGeometry) -> some View {
        RoundedRectangle(cornerRadius: 14)
            .fill(MiniInk.ghostBg)
            .overlay(
                RoundedRectangle(cornerRadius: 14)
                    .strokeBorder(style: StrokeStyle(lineWidth: 2, dash: [6]))
                    .foregroundStyle(MiniInk.ghostBorder)
            )
            .frame(width: g.tile.width, height: g.tile.height)
            .offset(x: point.x, y: point.y)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
    }

    // MARK: Перетаскивание

    private func dragGesture(_ g: CallMiniGeometry) -> some Gesture {
        DragGesture(minimumDistance: 4, coordinateSpace: .global)
            .updating($dragging) { _, state, _ in state = true }
            .onChanged { value in
                let base: CGPoint
                if let dragStart {
                    base = dragStart
                } else {
                    base = overridePos ?? g.resolve(placement) ?? g.corners[1]
                    dragStart = base
                }
                let at = g.clampDrag(CGPoint(
                    x: base.x + value.translation.width,
                    y: base.y + value.translation.height
                ))
                overridePos = at
                let index = g.nearestCorner(to: at)
                magnet = g.distance(toCorner: index, from: at) <= CallMiniGeometry.snap ? g.corners[index] : nil
            }
            .onEnded { value in
                guard let base = dragStart else { return }
                dragStart = nil
                magnet = nil
                let at = g.clampDrag(CGPoint(
                    x: base.x + value.translation.width,
                    y: base.y + value.translation.height
                ))
                release(at: at, g)
            }
    }

    private func release(at point: CGPoint, _ g: CallMiniGeometry) {
        switch g.drop(at: point) {
        case .tongue(let side):
            commit(.tongue(side: side, y: point.y), animated: false)
        case .corner(let index):
            commit(.corner(index), animated: true)
        case .free:
            commit(g.freePlacement(at: point), animated: true)
        }
    }

    /// Записать место и отпустить плитку: с анимацией она доезжает от пальца до места.
    /// Смена размещения и сброс перекрытия — в одной транзакции, иначе кадр между ними
    /// показал бы плитку в старом углу.
    private func commit(_ next: CallMiniPlacement, animated: Bool) {
        CallMiniPlacementStore.save(next)
        if animated && !reduceMotion {
            withAnimation(callMiniSnapCurve) {
                placement = next
                overridePos = nil
            }
        } else {
            placement = next
            overridePos = nil
        }
    }

    // MARK: Язычок

    private func tongue(side: CallMiniSide, y: Double, _ g: CallMiniGeometry) -> some View {
        let shown = self.shown
        let speaking = shownSpeaking
        let ty = g.tongueY(y)
        let shape = UnevenRoundedRectangle(
            topLeadingRadius: side == .left ? 0 : 14,
            bottomLeadingRadius: side == .left ? 0 : 14,
            bottomTrailingRadius: side == .left ? 14 : 0,
            topTrailingRadius: side == .left ? 14 : 0
        )

        return Button {
            leaveTongue(g)
        } label: {
            HStack(spacing: 8) {
                if side == .right { tongueChevron(side) }
                if side == .left { tongueAvatar(shown, speaking: speaking) }
                if let since = snapshot.connectedAt {
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        Text(callMiniElapsed(since: since, now: context.date))
                            .font(.system(size: 12, weight: .bold).monospacedDigit())
                            .foregroundStyle(MiniInk.cream)
                    }
                }
                if side == .left { tongueChevron(side) }
                if side == .right { tongueAvatar(shown, speaking: speaking) }
            }
            .padding(.vertical, 8)
            .padding(.leading, side == .left ? 8 : 12)
            .padding(.trailing, side == .left ? 12 : 8)
            .frame(height: CallMiniGeometry.tongueHeight)
            .background(Eb.surface100)
            .clipShape(shape)
            .overlay(shape.strokeBorder(snapshot.reconnecting ? MiniInk.danger : Eb.borderStrong, lineWidth: 1))
            .shadow(color: MiniInk.shadow.opacity(0.5), radius: 12, y: 8)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Показать миниатюру звонка")
        // Кант у самого края — за экран: у веба на этой стороне рамки нет.
        .offset(x: side == .left ? -1 : 1, y: ty)
        .frame(maxWidth: .infinity, alignment: side == .left ? .leading : .trailing)
    }

    private func tongueChevron(_ side: CallMiniSide) -> some View {
        Image(systemName: side == .left ? "chevron.right" : "chevron.left")
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(Eb.textMuted)
    }

    @ViewBuilder
    private func tongueAvatar(_ shown: CallParticipant?, speaking: Bool) -> some View {
        MiniSpeakingAvatar(name: shownName, avatarUrl: shown?.avatarUrl, size: 32, speaking: speaking)
    }

    /// Тап по язычку: плитка выезжает из-за края в ближайший угол этой стороны (верхний или
    /// нижний по y).
    private func leaveTongue(_ g: CallMiniGeometry) {
        guard case .tongue(let side, let y) = placement else { return }
        let upper = y < g.screen.height / 2
        let corner = side == .left ? (upper ? 0 : 2) : (upper ? 1 : 3)
        let target = g.corners[corner]
        overridePos = CGPoint(x: side == .left ? -g.tile.width : g.screen.width, y: target.y)
        placement = .corner(corner)
        CallMiniPlacementStore.save(.corner(corner))
        if reduceMotion {
            overridePos = nil
            return
        }
        DispatchQueue.main.async {
            withAnimation(callMiniSnapCurve) { overridePos = nil }
        }
    }
}

// MARK: - Детали

/// Аватар с зелёным кольцом и расходящимся ореолом, пока человек говорит (keyframes
/// eb-mini-speak: 2 px кольцо + ореол 4→10 px, растворяется, 1,4 с). Фаза — от часов,
/// без состояния: «уменьшить движение» просто останавливает часы.
private struct MiniSpeakingAvatar: View {
    let name: String
    let avatarUrl: String?
    let size: CGFloat
    let speaking: Bool

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        AvatarView(name: name, avatarUrl: avatarUrl, size: size)
            .overlay {
                if speaking {
                    TimelineView(.animation(minimumInterval: 1.0 / 30, paused: reduceMotion)) { context in
                        let phase = context.date.timeIntervalSinceReferenceDate
                            .truncatingRemainder(dividingBy: 1.4) / 1.4
                        // 0 → 1 → 0 за период, каждая половина с CSS ease-out.
                        let k = reduceMotion ? 0 : (phase < 0.5 ? miniEaseOut(phase / 0.5) : miniEaseOut(1 - (phase - 0.5) / 0.5))
                        let spread = 4 + 6 * k
                        ZStack {
                            Circle()
                                .strokeBorder(MiniInk.green, lineWidth: 2)
                                .frame(width: size + 4, height: size + 4)
                            Circle()
                                .stroke(MiniInk.green.opacity(0.15 * (1 - k)), lineWidth: spread - 2)
                                .frame(width: size + 2 + spread, height: size + 2 + spread)
                        }
                    }
                }
            }
    }
}

private func miniEaseOut(_ x: Double) -> Double {
    let t = min(max(x, 0), 1)
    return 1 - (1 - t) * (1 - t)
}

/// «Переподключение…» — мигает 1,2 с (keyframes eb-mini-blink), при «уменьшить движение» горит ровно.
private struct MiniBlinkingText: View {
    let text: String
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(_ text: String) { self.text = text }

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30, paused: reduceMotion)) { context in
            let phase = context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1.2) / 1.2
            let dip = reduceMotion ? 0 : 0.5 - 0.5 * cos(phase * 2 * .pi)
            Text(text)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(MiniInk.danger)
                .lineLimit(1)
                .opacity(1 - 0.65 * dip)
        }
    }
}

/// Кнопка плитки 30×30 (.eb-mini__btn): обычная, приглушённая (микрофон выключен),
/// янтарная («Развернуть») и красная (завершить).
private struct MiniButton: View {
    enum Style { case normal, off, amber, danger }

    let systemName: String
    let label: String
    var style: Style = .normal
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(foreground)
                .frame(width: 30, height: 30)
                .background(background, in: RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(border, lineWidth: 1))
                .opacity(0.9)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }

    private var foreground: Color {
        switch style {
        case .normal: return Eb.textPrimary
        case .off: return Eb.textMuted
        case .amber: return MiniInk.cream
        case .danger: return .white
        }
    }

    private var background: Color {
        switch style {
        case .danger: return MiniInk.danger
        case .amber: return MiniInk.amberBg
        case .normal, .off: return MiniInk.scrim
        }
    }

    private var border: Color {
        switch style {
        case .danger: return MiniInk.danger
        case .amber: return MiniInk.amber
        case .normal, .off: return Color.white.opacity(0.14)
        }
    }
}
