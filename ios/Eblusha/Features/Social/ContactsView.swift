import SwiftUI
import UIKit

// Порт `ui/social/ContactsScreen.kt`: поиск по EBLID, карточки «Мой EBLID»/«Код
// регистрации», секции заявок и список друзей. Плюс вход в QR-сканер (кнопка в поиске):
// добавление друга по отсканированному EBLID.

private let offlineDot = Color(hex: 0x6B7280)

struct ContactsView: View {
    let onBack: (() -> Void)?
    let onOpenConversation: (ConversationRef) -> Void

    @StateObject private var vm: ContactsViewModel

    // Универсальная карточка пользователя (тап по строке друга/результата поиска).
    @State private var userCard: UserCardSeed?
    @State private var showScanner = false

    init(onBack: (() -> Void)?, onOpenConversation: @escaping (ConversationRef) -> Void) {
        self.onBack = onBack
        self.onOpenConversation = onOpenConversation
        _vm = StateObject(wrappedValue: ContactsViewModel(
            repo: AppContainer.shared.contactsRepository,
            realtime: AppContainer.shared.realtimeClient
        ))
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    content
                }
                .padding(12)
            }
        }
        .background(Eb.surface200)
        .sheet(item: $userCard) { seed in
            UserCardSheet(
                seed: seed,
                onOpenConversation: { ref in
                    userCard = nil
                    onOpenConversation(ref)
                },
                onDismiss: { userCard = nil }
            )
        }
        .sheet(isPresented: $showScanner) {
            QrScanSheet { text in
                showScanner = false
                // QR несёт EBLID — добавляем как identifier (тот же путь, что ручной ввод).
                vm.add(identifier: text)
            }
        }
    }

    // Шапка: назад + заголовок с подзаголовком (порт TopAppBar).
    private var header: some View {
        HStack(spacing: 6) {
            if let onBack {
                Button(action: onBack) {
                    Image(systemName: "chevron.left")
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(Eb.textPrimary)
                        .frame(width: 40, height: 40)
                }
                .buttonStyle(.plain)
            }
            VStack(alignment: .leading, spacing: 1) {
                Text("Контакты")
                    .font(.headline)
                    .foregroundStyle(Eb.textPrimary)
                Text("Поиск по EBLID и список друзей")
                    .font(.caption)
                    .foregroundStyle(Eb.textMuted)
            }
            Spacer()
        }
        .padding(.horizontal, onBack == nil ? 16 : 6)
        .padding(.vertical, 8)
    }

    @ViewBuilder
    private var content: some View {
        searchField

        if let info = vm.ui.info {
            Text(info).foregroundStyle(Eb.brand)
        }
        if let error = vm.ui.error {
            Text(error).foregroundStyle(Eb.error)
        }

        if vm.ui.query.trimmed().count >= 2 {
            ForEach(vm.ui.results) { user in
                FriendRow(
                    userId: user.id,
                    name: user.name,
                    // Логин не показываем — это секрет входа (веб-правило: только EBLID).
                    subtitle: user.online ? "в сети" : "Пользователь Еблуши",
                    avatarUrl: user.avatarUrl,
                    online: user.online,
                    onClick: { userCard = UserCardSeed(userId: user.id, name: user.name, avatarUrl: user.avatarUrl) }
                ) {
                    MiniButton(icon: "person.badge.plus", description: "Добавить") {
                        vm.addById(userId: user.id)
                    }
                }
            }
            if vm.ui.searching { LoadingRow() }
        } else {
            HStack(alignment: .top, spacing: 10) {
                EblidCard(eblid: vm.ui.myEblid)
                InviteCard(
                    code: vm.ui.invite?.code,
                    expiresAtMs: vm.ui.invite?.expiresAtMs,
                    refreshing: vm.ui.inviteRefreshing,
                    onRefresh: vm.refreshInvite
                )
            }

            if !vm.ui.incoming.isEmpty {
                SectionHeader("Запросы в друзья")
                ForEach(vm.ui.incoming) { c in
                    FriendRow(
                        userId: c.user.id,
                        name: c.user.name,
                        subtitle: "хочет добавить вас",
                        avatarUrl: c.user.avatarUrl,
                        online: c.user.online,
                        onClick: { userCard = UserCardSeed(userId: c.user.id, name: c.user.name, avatarUrl: c.user.avatarUrl) }
                    ) {
                        MiniButton(icon: "checkmark", description: "Принять", tint: Eb.online) {
                            vm.respond(c, action: "accept")
                        }
                        MiniButton(icon: "xmark", description: "Отклонить", tint: Eb.error) {
                            vm.respond(c, action: "reject")
                        }
                    }
                }
            }

            if !vm.ui.outgoing.isEmpty {
                SectionHeader("Ожидание подтверждения")
                ForEach(vm.ui.outgoing) { c in
                    FriendRow(
                        userId: c.user.id,
                        name: c.user.name,
                        subtitle: "запрос отправлен",
                        avatarUrl: c.user.avatarUrl,
                        online: c.user.online,
                        onClick: { userCard = UserCardSeed(userId: c.user.id, name: c.user.name, avatarUrl: c.user.avatarUrl) }
                    ) {
                        MiniButton(icon: "xmark", description: "Отменить запрос") {
                            vm.removeContact(c)
                        }
                    }
                }
            }

            SectionHeader("Мои друзья")
            if vm.ui.loading {
                LoadingRow()
            } else if vm.ui.contacts.isEmpty {
                Text("Пока никого — добавьте друга по EBLID через поиск выше")
                    .foregroundStyle(Eb.textMuted)
                    .padding(4)
            }
            ForEach(vm.ui.contacts) { c in
                FriendRow(
                    userId: c.user.id,
                    name: c.user.name,
                    subtitle: c.user.online ? "в сети" : "Контакт",
                    subtitleColor: c.user.online ? Eb.online : nil,
                    avatarUrl: c.user.avatarUrl,
                    online: c.user.online,
                    // Тап по строке — карточка (веб-паритет); «Написать» остаётся кнопкой.
                    onClick: { userCard = UserCardSeed(userId: c.user.id, name: c.user.name, avatarUrl: c.user.avatarUrl) }
                ) {
                    MiniButton(icon: "xmark", description: "Удалить") {
                        vm.removeContact(c)
                    }
                    MiniButton(icon: "lock.fill", description: "Секретный чат") {
                        vm.startSecret(userId: c.user.id, onOpened: onOpenConversation)
                    }
                    MiniButton(icon: "bubble.left.fill", description: "Написать", filled: true) {
                        vm.startDm(userId: c.user.id, onOpened: onOpenConversation)
                    }
                }
            }
        }
    }

    private var searchField: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(Eb.textMuted)
            TextField(
                "",
                text: Binding(get: { vm.ui.query }, set: vm.onQueryChange),
                prompt: Text("Поиск по имени или EBLID").foregroundStyle(Eb.textMuted)
            )
            .foregroundStyle(Eb.textPrimary)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            // Вход в сканер: добавление по QR с EBLID (разрешение камеры уже в Info.plist).
            Button {
                showScanner = true
            } label: {
                Image(systemName: "qrcode.viewfinder")
                    .foregroundStyle(Eb.brand)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Сканировать QR")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 12)
        .background(Eb.surface100, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Eb.borderStrong))
    }
}

// MARK: - Строка друга / результата поиска

private struct FriendRow<Actions: View>: View {
    /// Нужен, чтобы показать иконку устройства (карта устройств — общая, по userId).
    let userId: String?
    let name: String
    let subtitle: String
    var subtitleColor: Color?
    let avatarUrl: String?
    let online: Bool
    let onClick: () -> Void
    let actions: Actions

    init(
        userId: String?,
        name: String,
        subtitle: String,
        subtitleColor: Color? = nil,
        avatarUrl: String?,
        online: Bool,
        onClick: @escaping () -> Void,
        @ViewBuilder actions: () -> Actions
    ) {
        self.userId = userId
        self.name = name
        self.subtitle = subtitle
        self.subtitleColor = subtitleColor
        self.avatarUrl = avatarUrl
        self.online = online
        self.onClick = onClick
        self.actions = actions()
    }

    var body: some View {
        HStack(spacing: 10) {
            ZStack(alignment: .bottomTrailing) {
                AvatarView(name: name, avatarUrl: avatarUrl, size: 42)
                PresenceBadge(
                    userId: userId,
                    status: online ? "ONLINE" : "OFFLINE",
                    onlineFallback: online,
                    ringSize: 14,
                    dotSize: 9
                )
            }
            VStack(alignment: .leading, spacing: 1) {
                Text(name)
                    .fontWeight(.semibold)
                    .foregroundStyle(Eb.textPrimary)
                    .lineLimit(1)
                Text(subtitle)
                    .font(.footnote)
                    .foregroundStyle(subtitleColor ?? Eb.textMuted)
                    .lineLimit(1)
            }
            Spacer(minLength: 4)
            HStack(spacing: 6) { actions }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(Eb.surface200, in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Eb.borderStrong))
        .contentShape(Rectangle())
        .onTapGesture(perform: onClick)
    }
}

// MARK: - Мини-кнопка действия строки

private struct MiniButton: View {
    let icon: String
    let description: String
    var tint: Color = Eb.textPrimary
    var filled = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            ZStack {
                RoundedRectangle(cornerRadius: 10).fill(filled ? Eb.brand : Eb.surface100)
                RoundedRectangle(cornerRadius: 10).strokeBorder(filled ? Eb.brand : Eb.borderStrong)
                Image(systemName: icon)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(filled ? .white : tint)
            }
            .frame(width: 36, height: 36)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(description)
    }
}

// MARK: - Карточки «Мой EBLID» и «Код регистрации»

private struct EblidCard: View {
    let eblid: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text("Мой EBLID")
                    .font(.caption)
                    .foregroundStyle(Eb.textMuted)
                Spacer()
                if let eblid {
                    Button {
                        UIPasteboard.general.string = eblid
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
            Text(eblid ?? "—")
                .font(.title3.weight(.bold))
                .foregroundStyle(Eb.textPrimary)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Eb.surface200, in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Eb.borderStrong))
    }
}

private struct InviteCard: View {
    let code: String?
    let expiresAtMs: Int64?
    let refreshing: Bool
    let onRefresh: () -> Void

    @State private var remaining: Int64 = 0

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 0) {
                Text("Код регистрации")
                    .font(.caption)
                    .foregroundStyle(Eb.textMuted)
                Spacer()
                if let code {
                    Button {
                        UIPasteboard.general.string = code
                    } label: {
                        Image(systemName: "doc.on.doc")
                            .font(.system(size: 13))
                            .foregroundStyle(Eb.brand)
                            .frame(width: 28, height: 28)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Копировать")
                }
                Button(action: onRefresh) {
                    Image(systemName: "arrow.clockwise")
                        .font(.system(size: 13))
                        .foregroundStyle(Eb.brand)
                        .frame(width: 28, height: 28)
                }
                .buttonStyle(.plain)
                .disabled(refreshing)
                .accessibilityLabel("Обновить")
            }
            Text(code ?? "—")
                .font(.title3.weight(.bold))
                .foregroundStyle(Eb.textPrimary)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
            if expiresAtMs != nil && remaining > 0 {
                Text("Обновится через \(formatCountdown(remaining))")
                    .font(.caption2)
                    .foregroundStyle(Eb.brand)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Eb.surface200, in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Eb.borderStrong))
        // Порт LaunchedEffect(code, expiresAtMs): тикаем раз в секунду, на нуле — refresh.
        .task(id: "\(code ?? "")_\(expiresAtMs ?? 0)") {
            guard let expiresAtMs else { return }
            while !Task.isCancelled {
                remaining = expiresAtMs - Int64(Date().timeIntervalSince1970 * 1000)
                if remaining <= 0 {
                    onRefresh()
                    break
                }
                try? await Task.sleep(for: .seconds(1))
            }
        }
    }
}

// MARK: - Вспомогательные

private struct SectionHeader: View {
    let text: String
    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(Eb.brand)
            .padding(.leading, 4)
            .padding(.top, 8)
    }
}

private struct LoadingRow: View {
    var body: some View {
        HStack {
            Spacer()
            ProgressView().controlSize(.small)
            Spacer()
        }
        .padding(16)
    }
}

private func formatCountdown(_ ms: Int64) -> String {
    let totalSec = max(ms / 1000, 0)
    return String(format: "%02d:%02d", totalSec / 60, totalSec % 60)
}
