import SwiftUI

// Порт секретных карточек `ui/chat/ChatScreen.kt`: оверлеи «Ждём подтверждения» и
// «Секретный чат» (принять/отклонить), карточка привязки нового устройства
// (SecretDeviceLinkJoinCard — QR-сканер + 8-значный код) и диалог доверенного
// устройства (SecretDeviceLinkInviteDialog — QR + код + TTL-таймер + «Код истёк»).
//
// Плюс видимые состояния защиты (веб-паритет MessagesPane): спиннер «Настраиваем
// защиту…» внутри SecretChatOverlay, плашка «Настраивается… ждём ключи» и карточка
// «ключи не доехали» над композером, чип состояния для шапки.
//
// Подключение к ChatView — см. integration_notes: оверлей вешается на messageList,
// диалог приглашения — sheet, плашки состояния — первой строкой композера
// (ChatComposer сам их рисует по своим secret*-параметрам), чип — в headerTitle.

/// Зелёный секреток (веб-паритет), как в ChatListView.
private let secretGreen = Color(hex: 0x22C55E)
private let secretGreenSoft = Color(hex: 0x86EFAC)

// MARK: - Оверлей секретного экрана

/// Единый оверлей поверх ленты: выбирает карточку по состоянию (порт трёх
/// matchParentSize-боксов ChatScreen.kt). Ничего не рисует в обычном ACTIVE-состоянии.
struct SecretChatOverlay: View {
    let ui: ChatViewModel.UiState
    /// Имя собеседника (заголовок беседы) — для текстов карточек.
    let title: String
    // Состояния ниже приходят снаружи (в UiState их нет) и ОБЯЗАНЫ иметь значения по
    // умолчанию: иначе уже написанный вызов из ChatView перестал бы компилироваться.
    /// Ключа треда ещё нет, но экран не перехвачен ни одной карточкой — показываем, что
    /// работа идёт (веб: readyState == 'bootstrapping').
    var bootstrapping = false
    /// Короткий пульс «Готово» сразу после прихода ключа (веб: secretBootDonePulse, ~0.7 с).
    var donePulse = false
    let onAccept: () -> Void
    let onDecline: () -> Void
    let onOpenScanner: () -> Void
    let onCloseScanner: () -> Void
    let onScanned: (String) -> Void
    let onCodeChange: (String) -> Void
    let onSubmitCode: () -> Void

    var body: some View {
        // МЫ создали приглашение — чат виден, но заблокирован до accept'а собеседника.
        if ui.secretWaiting {
            dimmed {
                SecretCardShell {
                    Text("🔒").font(.system(size: 34))
                    Text("Ждём подтверждения")
                        .font(.system(size: 17, weight: .bold))
                        .foregroundStyle(Eb.textPrimary)
                    Text("Попросите \(title) принять приглашение — секретный чат откроется, "
                        + "как только его подтвердят на одном из устройств собеседника.")
                        .font(.subheadline)
                        .foregroundStyle(Eb.textMuted)
                        .multilineTextAlignment(.center)
                    Button {
                        onDecline()
                    } label: {
                        Text(ui.secretInviteBusy ? "…" : "Отменить приглашение")
                    }
                    .buttonStyle(.bordered)
                    .tint(Eb.textMuted)
                    .disabled(ui.secretInviteBusy)
                    .padding(.top, 12)
                }
            }
        }
        // Приглашение собеседнику: принять нужно на ЭТОМ устройстве — до того ключей нет.
        else if ui.secretInvite {
            dimmed {
                SecretCardShell {
                    Text("🔒").font(.system(size: 34))
                    Text("Секретный чат")
                        .font(.system(size: 17, weight: .bold))
                        .foregroundStyle(Eb.textPrimary)
                    Text("\(title) приглашает вас в зашифрованный чат. Примите на этом "
                        + "устройстве, чтобы получить ключи. Остальные устройства подключите "
                        + "через «Добавить устройство».")
                        .font(.subheadline)
                        .foregroundStyle(Eb.textMuted)
                        .multilineTextAlignment(.center)
                    HStack(spacing: 10) {
                        Button("Отклонить", action: onDecline)
                            .buttonStyle(.bordered)
                            .tint(Eb.textMuted)
                        Button(ui.secretInviteBusy ? "…" : "Принять", action: onAccept)
                            .buttonStyle(.borderedProminent)
                            .tint(Eb.brand)
                    }
                    .disabled(ui.secretInviteBusy)
                    .padding(.top, 12)
                }
            }
        }
        // Секретка открыта на ДРУГОМ нашем устройстве: ключа здесь нет, но он есть у своих —
        // просим его по QR/коду прямо в чате (веб: DeviceLinkInline variant="join" оверлеем).
        // Условие как в вебе — устройство БЕЗ ЕДИНОГО ключа секреток (то есть новое). Если
        // ключи других тредов уже есть, ключ ЭТОГО треда приедет от создателя сам, и
        // перехватывать экран нельзя (иначе оверлей вылезал бы сразу после «Принять»).
        else if ui.isSecret && !ui.secretReady && !ui.secretInvite && !ui.secretWaiting
            && ui.hasOtherDevices && !ui.hasAnySecretKeys {
            dimmed {
                SecretDeviceLinkJoinCard(
                    ui: ui,
                    onOpenScanner: onOpenScanner,
                    onCloseScanner: onCloseScanner,
                    onScanned: onScanned,
                    onCodeChange: onCodeChange,
                    onSubmitCode: onSubmitCode
                )
            }
        }
        // Ключей нет, но ни одна карточка экран не перехватила (обычный случай: ключ
        // этого треда едет от создателя). В вебе тут центральный спиннер, и без него
        // промежуток между «Принять» и приходом ключа выглядит как пустой чат.
        else if bootstrapping || donePulse {
            bootstrapProgress
        }
    }

    /// Порт центрального оверлея MessagesPane: спиннер с подписью, а по приходу ключа —
    /// короткая галочка «Готово». Вуали НЕТ и касания не перехватываются (веб:
    /// pointerEvents none) — под ним можно листать историю и писать в композер.
    private var bootstrapProgress: some View {
        VStack(spacing: 10) {
            if donePulse {
                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 30))
                    .foregroundStyle(secretGreenSoft)
            } else {
                ProgressView()
            }
            // Веб-вариант «Ждём подтверждение…» (создатель ждёт квитанцию) на iOS занимает
            // полноэкранная карточка secretWaiting — отдельного состояния под него нет.
            Text(donePulse ? "Готово" : "Настраиваем защиту…")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(Eb.textMuted)
        }
        .padding(16)
        .opacity(0.95)
        .allowsHitTesting(false)
    }

    /// Полупрозрачная вуаль на всю ленту (порт matchParentSize + surface200 α0.97).
    private func dimmed<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        ZStack {
            Eb.surface200.opacity(0.97).ignoresSafeArea(edges: .horizontal)
            content()
                .padding(24)
        }
    }
}

/// Общий каркас секретной карточки: surface300, скругление 16, кант borderStrong.
private struct SecretCardShell<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        VStack(spacing: 6) {
            content
        }
        .padding(20)
        .frame(maxWidth: 340)
        .background(Eb.surface300, in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Eb.borderStrong))
    }
}

// MARK: - Карточка «получить ключи с другого устройства» (мы — НОВОЕ устройство)

/// Порт SecretDeviceLinkJoinCard: сканер QR доверенного устройства либо ручной ввод
/// 8-значного кода; после отправки запроса — спиннер «подтвердите на том устройстве».
struct SecretDeviceLinkJoinCard: View {
    let ui: ChatViewModel.UiState
    let onOpenScanner: () -> Void
    let onCloseScanner: () -> Void
    let onScanned: (String) -> Void
    let onCodeChange: (String) -> Void
    let onSubmitCode: () -> Void

    var body: some View {
        VStack(spacing: 6) {
            if ui.linkScanning {
                Text("Наведите камеру на QR")
                    .font(.system(size: 16, weight: .bold))
                    .foregroundStyle(Eb.textPrimary)
                QrScannerView(onResult: onScanned)
                    .frame(maxWidth: .infinity)
                    .frame(height: 300)
                    .background(Color.black)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                    .padding(.top, 8)
                Button("Отмена", action: onCloseScanner)
                    .buttonStyle(.bordered)
                    .tint(Eb.textMuted)
                    .frame(maxWidth: .infinity)
                    .padding(.top, 8)
            } else {
                Text("🔒").font(.system(size: 34))
                Text("Чат открыт на другом устройстве")
                    .font(.system(size: 17, weight: .bold))
                    .foregroundStyle(Eb.textPrimary)
                    .multilineTextAlignment(.center)
                Text("Ключи от этой переписки есть на устройстве, где вы её начали. "
                    + "Откройте там этот же секретный чат, выберите «⋮ → Добавить устройство» "
                    + "и отсканируйте код.")
                    .font(.subheadline)
                    .foregroundStyle(Eb.textMuted)
                    .multilineTextAlignment(.center)
                if ui.linkRequestedOn != nil {
                    HStack(spacing: 10) {
                        ProgressView().controlSize(.small)
                        Text("Запрос отправлен — подтвердите на том устройстве")
                            .font(.footnote)
                            .foregroundStyle(Eb.textMuted)
                    }
                    .padding(.top, 10)
                }
                Button {
                    onOpenScanner()
                } label: {
                    Label("Сканировать QR", systemImage: "qrcode.viewfinder")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .tint(Eb.brand)
                .disabled(ui.linkBusy)
                .padding(.top, 10)
                HStack(spacing: 8) {
                    TextField(
                        "Код из 8 цифр",
                        text: Binding(get: { ui.linkCode }, set: onCodeChange)
                    )
                    .keyboardType(.numberPad)
                    .foregroundStyle(Eb.textPrimary)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 9)
                    .background(Eb.surface100, in: RoundedRectangle(cornerRadius: 10))
                    .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Eb.border))
                    Button("ОК", action: onSubmitCode)
                        .buttonStyle(.borderedProminent)
                        .tint(Eb.brand)
                        .disabled(ui.linkCode.trimmed().isEmpty || ui.linkBusy)
                }
                .padding(.top, 6)
                if let error = ui.linkError {
                    Text(error)
                        .font(.footnote)
                        .foregroundStyle(Eb.error)
                        .padding(.top, 6)
                }
            }
        }
        .padding(20)
        .frame(maxWidth: 360)
        .background(Eb.surface300, in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Eb.borderStrong))
    }
}

// MARK: - Диалог «Добавить устройство» (мы — ДОВЕРЕННОЕ устройство)

/// Порт SecretDeviceLinkInviteDialog: QR + 8 цифр, TTL 5 минут, одноразово. Когда ключи
/// уехали — карточка превращается в подтверждение ««X» подключён». Показывать sheet'ом,
/// пока linkInvite != nil || linkedOut != nil (закрытие → dismissLinkInvite()).
struct SecretDeviceLinkInviteSheet: View {
    let invite: DeviceLinkInvite?
    let leftMs: Int64
    let linkedOut: LinkedDevice?
    let onRefresh: () -> Void
    let onDismiss: () -> Void

    /// Кодирование QR — вне главного потока: на нём оно давало заметный подтормоз.
    @State private var qr: UIImage?

    var body: some View {
        VStack(spacing: 0) {
            if let linkedOut {
                linkedOutCard(linkedOut)
            } else if let invite {
                inviteCard(invite)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Eb.surface200)
        .presentationDetents([.large])
    }

    /// Ключи уехали: подтверждение с именем устройства (««iPhone» подключён»).
    private func linkedOutCard(_ device: LinkedDevice) -> some View {
        VStack(spacing: 6) {
            Spacer()
            ZStack {
                Circle().fill(secretGreen.opacity(0.12))
                Circle().strokeBorder(secretGreen.opacity(0.35))
                Image(systemName: "checkmark")
                    .font(.system(size: 30, weight: .semibold))
                    .foregroundStyle(secretGreenSoft)
            }
            .frame(width: 64, height: 64)
            .padding(.bottom, 8)
            Text(device.name.isEmpty ? "Устройство подключено" : "«\(device.name)» подключён")
                .font(.system(size: 18, weight: .bold))
                .foregroundStyle(Eb.textPrimary)
                .multilineTextAlignment(.center)
            Text(device.threadCount > 0
                ? "Устройство получило доступ к секретным чатам: \(device.threadCount)."
                : "Устройство получило доступ к секретным чатам.")
                .font(.subheadline)
                .foregroundStyle(Eb.textMuted)
                .multilineTextAlignment(.center)
            Spacer()
            Button("Готово", action: onDismiss)
                .buttonStyle(.borderedProminent)
                .tint(Eb.brand)
                .padding(.bottom, 24)
        }
        .padding(.horizontal, 24)
    }

    private func inviteCard(_ invite: DeviceLinkInvite) -> some View {
        let expired = leftMs <= 0
        let progress = min(max(Double(leftMs) / (5 * 60_000), 0), 1)
        return ScrollView {
            VStack(spacing: 12) {
                Text("Добавить устройство")
                    .font(.headline)
                    .foregroundStyle(Eb.textPrimary)
                    .padding(.top, 20)
                Text("Ключи уедут напрямую, сервер их не увидит.")
                    .font(.footnote)
                    .foregroundStyle(Eb.textMuted)
                    .multilineTextAlignment(.center)
                // Шаги вместо длинной инструкции одной строкой.
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(Array([
                        "Откройте Еблушу на новом устройстве",
                        "Зайдите в этот же секретный чат",
                        "Отсканируйте QR или введите код",
                    ].enumerated()), id: \.offset) { i, step in
                        HStack(spacing: 10) {
                            Text("\(i + 1)")
                                .font(.system(size: 11, weight: .bold))
                                .foregroundStyle(Eb.textPrimary)
                                .frame(width: 20, height: 20)
                                .background(Eb.surface300, in: Circle())
                            Text(step)
                                .font(.footnote)
                                .foregroundStyle(Eb.textMuted)
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                if let qr {
                    Image(uiImage: qr)
                        .resizable()
                        .interpolation(.none) // модули QR не размывать — иначе не считается
                        .scaledToFit()
                        .padding(8)
                        .frame(width: 200, height: 200)
                        .background(Color.white, in: RoundedRectangle(cornerRadius: 14))
                        .opacity(expired ? 0.35 : 1)
                }
                Text(chunkedCode(invite.code))
                    .font(.system(size: 26, weight: .bold))
                    .foregroundStyle(expired ? Eb.textMuted : Eb.brand)
                ProgressView(value: progress)
                    .tint(expired ? Eb.error : (progress < 0.25 ? Eb.away : secretGreen))
                Text(expired
                    ? "Код истёк — обновите его"
                    : String(format: "Действует ещё %02d:%02d", leftMs / 1000 / 60, leftMs / 1000 % 60))
                    .font(.footnote)
                    .foregroundStyle(expired ? Eb.error : Eb.textMuted)
                HStack(spacing: 8) {
                    Circle().fill(secretGreen).frame(width: 8, height: 8)
                    Text("Ждём новое устройство…")
                        .font(.footnote)
                        .foregroundStyle(Eb.textMuted)
                }
                HStack(spacing: 10) {
                    Button(expired ? "Создать новый код" : "Обновить код", action: onRefresh)
                        .buttonStyle(.bordered)
                        .tint(Eb.textMuted)
                    Button("Закрыть", action: onDismiss)
                        .buttonStyle(.borderedProminent)
                        .tint(Eb.brand)
                }
                .padding(.vertical, 12)
            }
            .padding(.horizontal, 24)
        }
        // Пересобрать QR при смене приглашения («Обновить код» меняет token).
        .task(id: invite.token) {
            let payload = invite.qrPayload
            qr = await Task.detached(priority: .userInitiated) {
                generateQrImage(payload, size: 512)
            }.value
        }
    }

    /// «12345678» → «1234 5678» (порт code.chunked(4).joinToString(" ")).
    private func chunkedCode(_ code: String) -> String {
        var parts: [String] = []
        var rest = Substring(code)
        while !rest.isEmpty {
            parts.append(String(rest.prefix(4)))
            rest = rest.dropFirst(4)
        }
        return parts.joined(separator: " ")
    }
}

// MARK: - Строки состояния защиты над композером

/// Бирюзовая часть цвета плашек состояния (веб: rgba(13,148,136,…) поверх surface).
private let secretTeal = Color(hex: 0x0D9488)
/// Красный плашек ошибки (веб: rgba(239,68,68,…)) — ярче общего Eb.error на фоне.
private let secretRed = Color(hex: 0xEF4444)

/// Порт бирюзовой плашки MessagesPane: первая строка композера, пока ключа треда нет.
/// Отправка при этом НЕ блокируется — sendSecret копит текст и дошлёт его сам по приходу
/// ключа, поэтому в плашке показываем размер очереди (веб: activeSecretQueuedCount):
/// молча копящиеся сообщения читаются как «мессенджер съел сообщение».
struct SecretKeysWaitingBar: View {
    let queued: Int

    var body: some View {
        Text(queued > 0
            ? "🔒 Настраивается… ждём ключи от собеседника. \(queued) сообщ. в очереди — "
                + "отправим автоматически."
            : "🔒 Настраивается… ждём ключи от собеседника. Можно писать — отправим автоматически.")
            .font(.footnote)
            .foregroundStyle(Eb.textPrimary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(secretTeal.opacity(0.14), in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Eb.border))
            // Отступы носит сама плашка: композер о её геометрии знать не должен.
            .padding(.horizontal, 10)
            .padding(.top, 8)
    }
}

/// Порт красной плашки MessagesPane «Не удалось получить ключи…»: ключи не доехали
/// (собеседник оффлайн, старый клиент, потерянный key package). Без неё айфон крутился
/// молча и не давал ни диагностики, ни выхода.
///
/// Действия отдаются наружу замыканиями, а не зовут вьюмодель: экран сам решает, что
/// такое «повторить обмен ключами» (republish OPK + key_request + syncInbox) и куда
/// ведёт привязка устройства.
struct SecretKeysErrorCard: View {
    /// Код первопричины из движка (веб: ROOT_CAUSE, по умолчанию NO_KEYPACKAGE).
    let code: String
    /// У аккаунта есть ДРУГИЕ устройства — только тогда ключи реально можно забрать у них.
    let canLinkDevice: Bool
    /// Повтор обмена ключами уже идёт — кнопки гасим, чтобы не слать запрос пачкой.
    var busy = false
    let onRetry: () -> Void
    let onLinkDevice: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("⚠️ Секретный чат недоступен на этом устройстве.")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(Eb.textPrimary)
            Text("Не удалось получить ключи для секретного чата (\(code)).")
                .font(.footnote)
                .foregroundStyle(Eb.error)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 8) {
                Button(busy ? "…" : "Восстановить", action: onRetry)
                    .buttonStyle(.borderedProminent)
                    .tint(Eb.brand)
                if canLinkDevice {
                    Button("Привязать устройство", action: onLinkDevice)
                        .buttonStyle(.bordered)
                        .tint(Eb.textMuted)
                }
            }
            .font(.footnote)
            .disabled(busy)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(secretRed.opacity(0.10), in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(secretRed.opacity(0.30)))
        .padding(.horizontal, 10)
        .padding(.top, 8)
    }
}

// MARK: - Чип состояния защиты в шапке

/// Состояние защиты секретного треда для шапки (порт activeSecretUiState.readyState).
enum SecretProtectionState: Equatable {
    /// Ключ треда на руках — чат реально шифрует.
    case ready
    /// Ключа ещё нет, обмен идёт.
    case bootstrapping
    /// Ключи не доехали (сработал таймаут ожидания).
    case failed
}

/// Порт янтарной плашки-бейджа под названием беседы: по шапке должно быть видно, готов
/// ли чат шифровать. Ставится вместо серой подписи «🔒 секретный чат», которая выглядела
/// одинаково и во время настройки, и при рабочем ключе.
struct SecretHeaderStatusChip: View {
    let state: SecretProtectionState

    var body: some View {
        Text(text)
            .font(.caption.weight(.bold))
            .foregroundStyle(state == .failed ? Eb.error : Eb.textPrimary)
            .lineLimit(1)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(Eb.away.opacity(0.10), in: RoundedRectangle(cornerRadius: 5))
            .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(Eb.away.opacity(0.24)))
    }

    private var text: String {
        switch state {
        case .ready: return "🔒 Защищено"
        case .bootstrapping: return "🔒 Настраивается…"
        case .failed: return "⚠️ Ошибка ключей"
        }
    }
}
