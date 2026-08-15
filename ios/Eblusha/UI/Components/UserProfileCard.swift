import SwiftUI
import UIKit

/// Универсальная карточка пользователя (порт `ui/components/UserProfileCard.kt`, который
/// сам — порт веб-`UserProfileCard.tsx`, v1–v4): баннер с градиентом из палитры аватара
/// (или из id), аватар с кольцом поверх баннера, имя + живой статус + био, EBLID (копия),
/// «В Еблуше с», кнопки «Написать»/«К беседе» + «Секретный чат», заявка в друзья,
/// общие беседы, полноэкранный просмотр аватаров с историей.
///
/// ПРИВАТНОСТЬ: login-username никогда не показывается — вместо него EBLID (веб-правило).

/// Мгновенные данные для отрисовки, пока грузится полный профиль.
struct UserCardSeed: Identifiable, Equatable {
    let userId: String
    let name: String
    let avatarUrl: String?

    var id: String { userId }
}

/// Содержимое sheet-карточки: показывать через `.sheet(item:)` у родителя
/// (в Compose ModalBottomSheet живёт внутри компонента, в SwiftUI лист держит родитель).
struct UserCardSheet: View {
    let seed: UserCardSeed
    let onOpenConversation: (ConversationRef) -> Void
    let onDismiss: () -> Void
    /// false — контекст, из которого нельзя перейти в чат (напр. поверх звонка): кнопки
    /// «Написать»/«Секретный чат» и «Общие беседы» скрываются, остаётся профиль + друзья.
    var showConversationActions = true

    private let contactsRepo = AppContainer.shared.contactsRepository
    private let chatRepo = AppContainer.shared.chatRepository

    @State private var profile: UserCardProfile?
    @State private var relation: UserRelation?
    @State private var sharedGroups: [Conversation] = []
    @State private var existingDm: Conversation?
    @State private var isSelf = false
    @State private var liveStatus: String?
    @State private var busy = false
    @State private var notice: String?
    @State private var viewer: ViewerStart?

    private struct ViewerStart: Identifiable {
        let index: Int
        var id: Int { index }
    }

    var body: some View {
        let name = profile?.name ?? seed.name
        let avatars: [String] = (profile?.avatars.isEmpty == false)
            ? profile!.avatars
            : [profile?.avatarUrl ?? seed.avatarUrl].compactMap { $0 }
        let currentAvatar = avatars.first
        let status = liveStatus ?? profile?.status

        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                CardHero(
                    userId: seed.userId,
                    name: name,
                    avatarUrl: currentAvatar,
                    avatarCount: avatars.count,
                    status: status,
                    lastSeenMs: profile?.lastSeenMs,
                    bio: profile?.bio,
                    onClose: onDismiss,
                    onOpenAvatar: currentAvatar != nil ? { viewer = ViewerStart(index: 0) } : nil
                )

                VStack(alignment: .leading, spacing: 8) {
                    // EBLID + «В Еблуше с» — как инфо-строки веба.
                    if let eblid = profile?.eblid {
                        InfoRow(label: "EBLID", value: eblid, copyable: true)
                    }
                    if let created = profile?.createdAtMs {
                        InfoRow(label: "В Еблуше с", value: joinedLabel(created), copyable: false)
                    }

                    if !isSelf {
                        if showConversationActions { actionButtons }
                        friendButton
                        if showConversationActions && !sharedGroups.isEmpty { sharedGroupsBlock }
                    }

                    if let notice {
                        Text(notice)
                            .font(.system(size: 13))
                            .foregroundStyle(Eb.brand)
                            .padding(.top, 2)
                    }
                    if profile == nil {
                        HStack {
                            Spacer()
                            ProgressView().controlSize(.small)
                            Spacer()
                        }
                        .padding(.vertical, 6)
                    }
                }
                .padding(.horizontal, 16)

                Spacer().frame(height: 16)
            }
        }
        .background(Eb.surface200)
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.hidden) // dragHandle = null из оригинала
        .task(id: seed.userId) { await loadAll() }
        // Живой статус, пока карточка открыта (как socket presence:update в вебе).
        .onReceive(
            AppContainer.shared.realtimeClient.events.receive(on: DispatchQueue.main)
        ) { event in
            if case .presence(let userId, let status, _) = event, userId == seed.userId {
                liveStatus = status
            }
        }
        .fullScreenCover(item: $viewer) { start in
            AvatarViewer(
                name: name,
                avatars: avatars,
                startIndex: start.index,
                onDismiss: { viewer = nil }
            )
        }
    }

    private func loadAll() async {
        isSelf = chatRepo.currentUserId() == seed.userId
        async let profileResult = contactsRepo.userCard(seed.userId)
        if !isSelf {
            async let relationResult = contactsRepo.relationWith(seed.userId)
            async let groupsResult = chatRepo.sharedGroupsWith(seed.userId)
            async let dmResult = chatRepo.existingDirectWith(seed.userId)
            if case .success(let r) = await relationResult { relation = r }
            sharedGroups = await groupsResult
            existingDm = await dmResult
        }
        if case .success(let p) = await profileResult { profile = p }
    }

    // MARK: - Кнопки «Написать»/«К беседе» + «Секретный чат»

    private var actionButtons: some View {
        HStack(spacing: 8) {
            CardActionButton(
                icon: "bubble.left.fill",
                label: existingDm != nil ? "К БЕСЕДЕ" : "НАПИСАТЬ",
                filled: true,
                enabled: !busy
            ) {
                if let dm = existingDm {
                    onOpenConversation(ConversationRef(id: dm.id, title: dm.title))
                    onDismiss()
                } else {
                    busy = true
                    Task {
                        switch await contactsRepo.startDirectConversation(userId: seed.userId) {
                        case .success(let ref):
                            onOpenConversation(ref)
                            onDismiss()
                        case .failure(let message, _):
                            notice = message
                        }
                        busy = false
                    }
                }
            }
            CardActionButton(
                icon: "lock.fill",
                label: "СЕКРЕТНЫЙ ЧАТ",
                filled: false,
                enabled: !busy
            ) {
                busy = true
                Task {
                    switch await contactsRepo.startSecretConversation(userId: seed.userId) {
                    // PENDING-чат сам блокируется карточкой «ждём подтверждения».
                    case .success(let start):
                        onOpenConversation(start.ref)
                        onDismiss()
                    case .failure(let message, _):
                        notice = message
                    }
                    busy = false
                }
            }
        }
    }

    // MARK: - Кнопка дружбы (порт FriendButton)

    @ViewBuilder
    private var friendButton: some View {
        // nil (ещё грузится) и FRIEND — кнопка не нужна.
        if let relation {
            switch relation.kind {
            case .friend:
                EmptyView()
            case .none:
                CardActionButton(
                    icon: "person.badge.plus",
                    label: "ДОБАВИТЬ В ДРУЗЬЯ",
                    filled: false,
                    enabled: !busy
                ) {
                    busy = true
                    Task {
                        switch await contactsRepo.addByUserId(seed.userId) {
                        case .success:
                            self.relation = UserRelation(.outgoing)
                        case .failure(let message, _):
                            notice = message
                        }
                        busy = false
                    }
                }
            case .incoming:
                if let contactId = relation.contactId {
                    Button {
                        busy = true
                        Task {
                            switch await contactsRepo.respond(contactId: contactId, action: "accept") {
                            case .success:
                                self.relation = UserRelation(.friend, contactId)
                            case .failure(let message, _):
                                notice = message
                            }
                            busy = false
                        }
                    } label: {
                        HStack(spacing: 6) {
                            Image(systemName: "checkmark")
                                .font(.system(size: 14, weight: .semibold))
                            Text("ПРИНЯТЬ ЗАЯВКУ В ДРУЗЬЯ")
                                .font(.system(size: 12, weight: .bold))
                        }
                        .foregroundStyle(Eb.online)
                        .frame(maxWidth: .infinity)
                        .frame(height: 44)
                        .background(Eb.online.opacity(0.16), in: RoundedRectangle(cornerRadius: 12))
                        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Eb.online.opacity(0.5)))
                    }
                    .buttonStyle(.plain)
                    .disabled(busy)
                }
            case .outgoing:
                HStack(spacing: 6) {
                    Image(systemName: "hourglass")
                        .font(.system(size: 13))
                    Text("ЗАПРОС ОТПРАВЛЕН")
                        .font(.system(size: 12, weight: .bold))
                }
                .foregroundStyle(Eb.textMuted)
                .frame(maxWidth: .infinity)
                .frame(height: 44)
                .background(Eb.surface300, in: RoundedRectangle(cornerRadius: 12))
            }
        }
    }

    // MARK: - Общие беседы

    private var sharedGroupsBlock: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("ОБЩИЕ БЕСЕДЫ · \(sharedGroups.count)")
                .font(.system(size: 12, weight: .bold))
                .foregroundStyle(Eb.textMuted)
                .padding(.top, 6)
                .padding(.leading, 2)
            ForEach(sharedGroups) { g in
                HStack(spacing: 10) {
                    AvatarView(name: g.title, avatarUrl: g.avatarUrl, size: 34)
                    Text(g.title)
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(Eb.textPrimary)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                .background(Eb.surface300, in: RoundedRectangle(cornerRadius: 12))
                .contentShape(Rectangle())
                .onTapGesture {
                    onOpenConversation(ConversationRef(id: g.id, title: g.title))
                    onDismiss()
                }
            }
        }
    }
}

// MARK: - Герой: баннер + аватар с кольцом + имя/статус/био

private struct CardHero: View {
    let userId: String
    let name: String
    let avatarUrl: String?
    let avatarCount: Int
    let status: String?
    let lastSeenMs: Int64?
    let bio: String?
    let onClose: () -> Void
    let onOpenAvatar: (() -> Void)?

    // Палитра из аватара (веб useAvatarPalette); фолбэк — стабильный оттенок из id.
    @State private var palette: AvatarPalette?

    var body: some View {
        let hue = palette?.hue ?? hashHue(userId)
        let sat = palette?.sat ?? 0.58

        VStack(alignment: .leading, spacing: 0) {
            ZStack(alignment: .topLeading) {
                // Баннер: 3-стопный градиент hsl (hue, hue+22, hue-24), как в вебе.
                LinearGradient(
                    colors: [
                        colorHSL(hue, sat, 0.32),
                        colorHSL((hue + 22).truncatingRemainder(dividingBy: 360), sat, 0.20),
                        colorHSL((hue + 336).truncatingRemainder(dividingBy: 360), sat, 0.12),
                    ],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                )
                .frame(height: 104)
                .frame(maxWidth: .infinity)

                HStack {
                    Spacer()
                    Button(action: onClose) {
                        Image(systemName: "xmark")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(.white)
                            .frame(width: 32, height: 32)
                            .background(Color.black.opacity(0.28), in: Circle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Закрыть")
                    .padding(8)
                }

                // Аватар в кольце surface-200, перекрывает баннер (веб: marginTop -42).
                ZStack(alignment: .bottomTrailing) {
                    AvatarView(name: name, avatarUrl: avatarUrl, size: 82)
                        .padding(4)
                        .background(Eb.surface200, in: Circle())
                    if avatarCount > 1 {
                        Text("\(avatarCount)")
                            .font(.system(size: 10, weight: .bold))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 5)
                            .padding(.vertical, 1)
                            .background(Color.black.opacity(0.55), in: RoundedRectangle(cornerRadius: 8))
                    }
                }
                .padding(.leading, 20)
                .padding(.top, 62)
                .onTapGesture { onOpenAvatar?() }
            }
            .frame(height: 152, alignment: .top) // 62 (сдвиг) + 90 (аватар с кольцом)

            VStack(alignment: .leading, spacing: 0) {
                Text(name)
                    .font(.system(size: 20, weight: .bold))
                    .foregroundStyle(Eb.textPrimary)
                    .lineLimit(2)
                Spacer().frame(height: 3)
                let line = presenceLine(status: status, lastSeenMs: lastSeenMs)
                HStack(spacing: 6) {
                    // Иконка устройства вместо точки — тот же значок, что на аватарах в списках.
                    PresenceBadge(
                        userId: userId,
                        status: status,
                        ringSize: 14,
                        dotSize: 8,
                        ringColor: .clear
                    )
                    Text(line.text)
                        .font(.system(size: 13))
                        .foregroundStyle(line.color)
                }
                if let bio, !bio.trimmed().isEmpty {
                    Spacer().frame(height: 6)
                    Text(bio)
                        .font(.system(size: 14))
                        .foregroundStyle(Eb.textPrimary.opacity(0.92))
                        .lineSpacing(3)
                }
            }
            .padding(EdgeInsets(top: 6, leading: 20, bottom: 10, trailing: 20))
        }
        .task(id: avatarUrl ?? "") {
            palette = await avatarPalette(resolveMediaUrl(avatarUrl))
        }
    }
}

// MARK: - Кнопки

private struct CardActionButton: View {
    let icon: String
    let label: String
    let filled: Bool
    var enabled = true
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Image(systemName: icon)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(filled ? .white : Eb.brand)
                Text(label)
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(filled ? .white : Eb.textPrimary)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity)
            .frame(height: 44)
            .background(filled ? Eb.brand : Eb.surface100, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(filled ? Eb.brand : Eb.borderStrong))
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
    }
}

private struct InfoRow: View {
    let label: String
    let value: String
    let copyable: Bool

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 1) {
                Text(label)
                    .font(.system(size: 11))
                    .foregroundStyle(Eb.textMuted)
                Text(value)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(Eb.textPrimary)
            }
            Spacer(minLength: 0)
            if copyable {
                Button {
                    UIPasteboard.general.string = value
                } label: {
                    Image(systemName: "doc.on.doc")
                        .font(.system(size: 13))
                        .foregroundStyle(Eb.brand)
                        .frame(width: 28, height: 28)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Копировать")
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .background(Eb.surface300, in: RoundedRectangle(cornerRadius: 12))
    }
}

// MARK: - Полноэкранный просмотр аватаров (текущий + история)

private struct AvatarViewer: View {
    let name: String
    let avatars: [String]
    let startIndex: Int
    let onDismiss: () -> Void

    @State private var page: Int

    init(name: String, avatars: [String], startIndex: Int, onDismiss: @escaping () -> Void) {
        self.name = name
        self.avatars = avatars
        self.startIndex = startIndex
        self.onDismiss = onDismiss
        _page = State(initialValue: startIndex)
    }

    var body: some View {
        ZStack {
            Color.black.opacity(0.94).ignoresSafeArea()

            TabView(selection: $page) {
                ForEach(avatars.indices, id: \.self) { i in
                    fullImage(avatars[i])
                        .tag(i)
                        .padding(.bottom, avatars.count > 1 ? 72 : 0)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: .never))

            VStack {
                HStack {
                    Spacer()
                    Button(action: onDismiss) {
                        Image(systemName: "xmark")
                            .foregroundStyle(.white)
                            .frame(width: 36, height: 36)
                            .background(Color.white.opacity(0.12), in: Circle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Закрыть")
                    .padding(12)
                }
                Spacer()
                if avatars.count > 1 {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(avatars.indices, id: \.self) { i in
                                thumb(avatars[i], selected: i == page)
                                    .onTapGesture {
                                        withAnimation { page = i }
                                    }
                            }
                        }
                        .padding(.horizontal, 12)
                    }
                    .padding(.bottom, 10)
                }
            }
        }
    }

    @ViewBuilder
    private func fullImage(_ raw: String) -> some View {
        if let resolved = resolveMediaUrl(raw), let url = URL(string: resolved) {
            AsyncImage(url: url) { phase in
                if let image = phase.image {
                    image.resizable().scaledToFit()
                } else {
                    ProgressView().tint(.white)
                }
            }
        } else {
            Color.clear
        }
    }

    @ViewBuilder
    private func thumb(_ raw: String, selected: Bool) -> some View {
        Group {
            if let resolved = resolveMediaUrl(raw), let url = URL(string: resolved) {
                AsyncImage(url: url) { phase in
                    if let image = phase.image {
                        image.resizable().scaledToFill()
                    } else {
                        Color.black
                    }
                }
            } else {
                Color.black
            }
        }
        .frame(width: 52, height: 52)
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .strokeBorder(selected ? Eb.brand : Color.white.opacity(0.25), lineWidth: 2)
        )
        .contentShape(Rectangle())
    }
}

// MARK: - Помощники

private let presenceGrey = Color(hex: 0x9CA3AF)

/// Статусная строка карточки (порт веб-`formatPresence` + statusDotColor).
private func presenceLine(status: String?, lastSeenMs: Int64?) -> (text: String, color: Color) {
    switch status?.uppercased() {
    case "ONLINE": return ("В сети", Eb.online)
    case "IN_CALL": return ("В звонке", Color(hex: 0xEF4444))
    case "BACKGROUND": return ("В фоне", Color(hex: 0xFACC15))
    case "AWAY": return ("Отошёл", Color(hex: 0xF59E0B))
    default: break
    }
    guard let lastSeenMs, lastSeenMs > 0 else { return ("Не в сети", presenceGrey) }
    let diff = Int64(Date().timeIntervalSince1970 * 1000) - lastSeenMs
    let text: String
    switch diff {
    case ..<60_000:
        text = "был(а) онлайн только что"
    case ..<3_600_000:
        text = "был(а) онлайн \(diff / 60_000) мин назад"
    case ..<86_400_000:
        text = "был(а) онлайн \(diff / 3_600_000) ч назад"
    default:
        let formatter = DateFormatter()
        formatter.dateFormat = "dd.MM.yyyy 'в' HH:mm"
        text = "был(а) онлайн "
            + formatter.string(from: Date(timeIntervalSince1970: Double(lastSeenMs) / 1000))
    }
    return (text, presenceGrey)
}

/// «В Еблуше с ноября 2025» — месяц в родительном падеже + год.
private func joinedLabel(_ ms: Int64) -> String {
    let months = [
        "января", "февраля", "марта", "апреля", "мая", "июня",
        "июля", "августа", "сентября", "октября", "ноября", "декабря",
    ]
    let parts = Calendar.current.dateComponents(
        [.month, .year], from: Date(timeIntervalSince1970: Double(ms) / 1000)
    )
    return "\(months[((parts.month ?? 1) - 1 + 12) % 12]) \(parts.year ?? 0)"
}

/// Стабильный оттенок из id — тот же хэш, что у веб-фолбэка баннера
/// (hashCode Java-строки по UTF-16, чтобы совпадать с Android-клиентом).
private func hashHue(_ id: String) -> Double {
    var h: Int32 = 0
    for unit in id.utf16 {
        h = h &* 31 &+ Int32(unit)
    }
    return Double(h.magnitude % 360)
}

/// HSL → Color (SwiftUI принимает HSB; та же математика, что в AvatarView).
private func colorHSL(_ hue: Double, _ sat: Double, _ light: Double) -> Color {
    let brightness = light + sat * min(light, 1 - light)
    let hsbSat = brightness == 0 ? 0 : 2 * (1 - light / brightness)
    return Color(hue: hue / 360, saturation: hsbSat, brightness: brightness)
}

private struct AvatarPalette: Equatable {
    let hue: Double
    let sat: Double
}

/**
 * Палитра аватара (порт веб-`useAvatarPalette`): даунскейл до 22×22, средний цвет с весом
 * по насыщенности (тёмное/белое отбрасывается); если средний серый — берём оттенок самого
 * сочного пикселя. nil (нет аватара / не загрузился) → фолбэк на hashHue.
 */
private func avatarPalette(_ urlString: String?) async -> AvatarPalette? {
    guard let urlString, let url = URL(string: urlString) else { return nil }
    guard let (data, _) = try? await URLSession.shared.data(from: url),
          let image = UIImage(data: data)?.cgImage else { return nil }

    let side = 22
    var pixels = [UInt8](repeating: 0, count: side * side * 4)
    let drawn: Bool = pixels.withUnsafeMutableBytes { buffer in
        guard let context = CGContext(
            data: buffer.baseAddress,
            width: side, height: side,
            bitsPerComponent: 8, bytesPerRow: side * 4,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return false }
        context.interpolationQuality = .medium
        context.draw(image, in: CGRect(x: 0, y: 0, width: side, height: side))
        return true
    }
    guard drawn else { return nil }

    var rs = 0.0, gs = 0.0, bs = 0.0, wsum = 0.0
    var bestSat = 0.0, bestHue = 0.0
    for i in stride(from: 0, to: pixels.count, by: 4) {
        if pixels[i + 3] < 200 { continue }
        let r = Double(pixels[i]), g = Double(pixels[i + 1]), b = Double(pixels[i + 2])
        let (h, s, l) = rgbToHSL(r, g, b)
        if l < 0.08 || l > 0.95 { continue } // почти чёрное/белое — мимо
        let w = 0.15 + s
        rs += r * w
        gs += g * w
        bs += b * w
        wsum += w
        if s > bestSat {
            bestSat = s
            bestHue = h
        }
    }
    if wsum <= 0 { return nil }
    let (h, s, _) = rgbToHSL(rs / wsum, gs / wsum, bs / wsum)
    let hue = (s < 0.15 && bestSat > 0.2) ? bestHue : h
    let sat = min(0.7, max(0.3, max(s, bestSat * 0.7)))
    return AvatarPalette(hue: hue, sat: sat)
}

/// RGB (0–255) → HSL (h 0–360, s/l 0–1) — аналог ColorUtils.RGBToHSL.
private func rgbToHSL(_ r: Double, _ g: Double, _ b: Double) -> (Double, Double, Double) {
    let rf = r / 255, gf = g / 255, bf = b / 255
    let maxV = max(rf, gf, bf)
    let minV = min(rf, gf, bf)
    let l = (maxV + minV) / 2
    let d = maxV - minV
    if d == 0 { return (0, 0, l) }
    let s = d / (1 - abs(2 * l - 1))
    var h: Double
    if maxV == rf {
        h = ((gf - bf) / d).truncatingRemainder(dividingBy: 6)
    } else if maxV == gf {
        h = (bf - rf) / d + 2
    } else {
        h = (rf - gf) / d + 4
    }
    h *= 60
    if h < 0 { h += 360 }
    return (h, min(1, max(0, s)), l)
}
