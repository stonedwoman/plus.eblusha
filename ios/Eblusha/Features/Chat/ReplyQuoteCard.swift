import SwiftUI

// Карточка цитаты в пузыре — порт веб-«мини-пузыря» ответа:
// `ChatMessageRow.tsx:636-745` (вложенный пузырь, затонированный цветом АВТОРА ЦИТАТЫ:
// имя 13/700 его цветом, миниатюра до 112×72, текст, время справа) плюс правила
// содержимого из `replyQuoteVisual` (MessagesPane.tsx:1717-1730) и
// `previewTextForReplyDraft` / `replySnippetIsGenericRu` (chatsMessages.ts:155-187).
//
// Почему карточка живёт отдельным файлом: она нужна и ленте (которая считает, ЧТО в ней
// показать), и строке сообщения (которая её рисует), а ChatView.swift и без неё большой.

// MARK: - Что показывать в карточке

/// Готовый предпросмотр цитаты: лента считает его один раз за проход, карточка только
/// рисует. Equatable — модель строки сравнивается при диффе ленты.
struct ReplyQuotePreview: Equatable {
    /// Вложение под миниатюру (фото или видео с постером); nil — картинки нет.
    var thumb: MessageAttachment?
    /// Подпись цитаты. nil — подпись скрыта, потому что она родовая («Фото») и её уже
    /// заменила миниатюра (веб: hideLineForThumb).
    var text: String?
    /// Время оригинала (ReplyInfo.createdAt) — мелкой строкой в карточке.
    var createdAt: Int64?
}

/// Родовые подписи: при наличии миниатюры они не несут информации и скрываются —
/// порт `replySnippetIsGenericRu`.
private let genericQuoteLines: Set<String> = [
    "", "Фото", "Видео", "Голосовое сообщение", "Вложение", "Файл", "Сообщение",
]

/// Текст цитаты по самому оригиналу — порт `previewTextForReplyDraft`: сначала контент,
/// потом тип первого вложения. Слова «Вложение» пользователь не понимает, поэтому у файла
/// показываем его имя, а уже в крайнем случае «Файл».
private func previewTextForQuote(_ quoted: Message?) -> String {
    guard let quoted else { return "Сообщение" }
    let raw = (quoted.content ?? "").trimmed()
    if !raw.isEmpty { return raw.count > 200 ? "\(raw.prefix(197))…" : raw }
    guard let first = quoted.attachments.first else { return "Сообщение" }
    switch first.type {
    case "IMAGE": return "Фото"
    case "VIDEO": return "Видео"
    case "AUDIO": return "Голосовое сообщение"
    default:
        let name = (first.name ?? "").trimmed()
        return name.isEmpty ? "Файл" : name
    }
}

/// Вложение под миниатюру: как в вебе (`resolveFirstImageAttachmentUrl`) — первое фото.
/// Видео добавлено сверх веба: его серверный постер у нас уже разобран (posterUrl), а без
/// кадра карточка ответа на видео выглядит пустой. У секретного видео постера нет —
/// шифрованный файл сервер не превьюит, поэтому такие пропускаем.
private func replyQuoteThumbAttachment(_ quoted: Message?) -> MessageAttachment? {
    guard let quoted else { return nil }
    if let image = quoted.attachments.first(where: { $0.type == "IMAGE" }) { return image }
    return quoted.attachments.first {
        $0.type == "VIDEO" && $0.secretNonce == nil && ($0.posterUrl?.isEmpty == false)
    }
}

/// Собрать предпросмотр цитаты. `quoted` — оригинал из УЖЕ загруженной истории: серверный
/// `replyTo` вложений не отдаёт (src/routes/messages.ts), поэтому миниатюра берётся из
/// ленты, ровно как веб делает `fullList.find(...)`.
func makeReplyQuotePreview(reply: ReplyInfo, quoted: Message?) -> ReplyQuotePreview {
    let thumb = replyQuoteThumbAttachment(quoted)
    let snippet = (reply.content ?? "").trimmed()
    var line = snippet.isEmpty ? previewTextForQuote(quoted) : snippet
    // Веб режет цитату на 240 символах: длинный ответ иначе прячет сам ответ.
    if line.count > 240 { line = "\(line.prefix(237))…" }
    let hideLineForThumb = thumb != nil && genericQuoteLines.contains(line)
    let showText = !line.isEmpty && !hideLineForThumb
    // Ни картинки, ни текста — пишем «Сообщение», чтобы карточка не была пустой плашкой.
    let text: String?
    if showText {
        text = line
    } else if thumb == nil {
        text = "Сообщение"
    } else {
        text = nil
    }
    return ReplyQuotePreview(thumb: thumb, text: text, createdAt: reply.createdAt)
}

// MARK: - Мост «лента → карточка»

private struct ReplyQuotePreviewsKey: EnvironmentKey {
    static let defaultValue: [String: ReplyQuotePreview] = [:]
}

extension EnvironmentValues {
    /// Предпросмотры цитат строки: id цитируемого сообщения → что показать в карточке.
    /// Через окружение, а не параметром: считает их лента (только она видит всю историю),
    /// а рисует карточка глубоко внутри пузыря — иначе данные пришлось бы тащить через
    /// всю сигнатуру MessageRow.
    var replyQuotePreviews: [String: ReplyQuotePreview] {
        get { self[ReplyQuotePreviewsKey.self] }
        set { self[ReplyQuotePreviewsKey.self] = newValue }
    }
}

// MARK: - Карточка

/// Мини-пузырь цитаты внутри пузыря сообщения: полоса и имя цветом автора цитаты, фон —
/// его же тон, миниатюра вложения, подпись, время. Тап уводит к оригиналу.
struct ReplyQuoteCard: View {
    let reply: ReplyInfo
    /// Имя автора цитаты; пустое — «Участник» (веб: quotedAuthorLabel).
    let authorName: String
    /// Цвет автора цитаты: полоса и имя (веб: nameColorForUser).
    let accent: Color
    /// Фон мини-пузыря — тон автора цитаты (веб: groupIncomingBubbleBg).
    let background: Color
    /// Расшифровка секретного вложения (в обычном чате nil) — миниатюра секретки иначе
    /// показывала бы шифртекст.
    var decryptSecretAttachment: ((MessageAttachment) async -> URL?)?
    let onTap: () -> Void

    @Environment(\.replyQuotePreviews) private var previews

    var body: some View {
        // Пока оригинал не подгружен, показываем то, что дал сервер в replyTo.
        let preview = previews[reply.id] ?? makeReplyQuotePreview(reply: reply, quoted: nil)
        HStack(alignment: .top, spacing: 7) {
            // Полоса цвета автора: по ней взгляд отличает, кому отвечают, ещё до чтения имени.
            Rectangle()
                .fill(accent)
                .frame(width: 2)
            VStack(alignment: .leading, spacing: 5) {
                // Имя и время в одной строке, а не время отдельной строкой справа, как в
                // вебе: право-выравнивание в SwiftUI требует Spacer/maxWidth: .infinity, а
                // он растягивает ВЕСЬ пузырь на всю ширину (та же грабля, что у metaRow).
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(authorName.isEmpty ? "Участник" : authorName)
                        .font(.system(size: 13, weight: .bold))
                        .foregroundStyle(accent)
                        .lineLimit(1)
                    if let at = preview.createdAt {
                        Text(formatQuoteTimeLabel(at))
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(Eb.textMuted)
                            .lineLimit(1)
                    }
                }
                if let thumb = preview.thumb {
                    thumbView(thumb)
                }
                if let text = preview.text {
                    Text(text)
                        .font(.system(size: 13))
                        .foregroundStyle(Eb.textPrimary.opacity(0.95))
                        .lineLimit(3)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(.vertical, 6)
        .padding(.horizontal, 8)
        .background(background, in: RoundedRectangle(cornerRadius: 10))
        .overlay(
            RoundedRectangle(cornerRadius: 10).strokeBorder(Color.white.opacity(0.05))
        )
        .contentShape(Rectangle())
        .onTapGesture { onTap() }
    }

    @ViewBuilder
    private func thumbView(_ att: MessageAttachment) -> some View {
        let box = replyQuoteThumbBox(att)
        if att.secretNonce != nil {
            // Секретное вложение по своему url отдаёт шифртекст — рисуем только после
            // расшифровки ключом треда (тот же путь, что у плиток в пузыре).
            SecretImageView(att: att, decrypt: decryptSecretAttachment)
                .frame(width: box.width, height: box.height)
                .clipped()
                .clipShape(RoundedRectangle(cornerRadius: 8))
        } else {
            CachedImage(url: replyQuoteThumbUrl(att), contentMode: .fill) {
                Rectangle().fill(Eb.surface300)
            }
            .frame(width: box.width, height: box.height)
            .clipped()
            .clipShape(RoundedRectangle(cornerRadius: 8))
        }
    }
}

/// Адрес миниатюры: у фото — само вложение, у видео — его постер; всегда через `?thumb=1`,
/// чтобы карточка не тянула полноразмерный кадр.
private func replyQuoteThumbUrl(_ att: MessageAttachment) -> URL? {
    let raw = att.type == "VIDEO" ? att.posterUrl : att.url
    return thumbMediaUrl(raw).flatMap { URL(string: $0) }
}

/// Размер миниатюры считается ДО загрузки — как плитки в пузыре: иначе появление картинки
/// меняло бы высоту ячейки и лента дёргалась бы. Бокс веба: до 112×72.
private func replyQuoteThumbBox(_ att: MessageAttachment) -> CGSize {
    let maxW: CGFloat = 112
    let maxH: CGFloat = 72
    let width = CGFloat(att.width ?? 0)
    let height = CGFloat(att.height ?? 0)
    // Без метаданных пропорцию знать неоткуда — берём весь бокс (картинка обрежется по
    // центру, как objectFit: cover в вебе).
    guard width > 0, height > 0 else { return CGSize(width: maxW, height: maxH) }
    // Кламп 0.2…5, как в веб-сетке: битые метаданные иначе дают полоску в пиксель.
    let ratio = min(max(height / width, 0.2), 5)
    var boxW = maxW
    var boxH = (maxW * ratio).rounded()
    if boxH > maxH {
        boxH = maxH
        boxW = (maxH / ratio).rounded()
    }
    return CGSize(width: boxW, height: boxH)
}

// MARK: - Время цитаты

private let quoteShortDayFormatter: DateFormatter = {
    let f = DateFormatter()
    f.locale = Locale(identifier: "ru_RU")
    f.timeZone = TimeZone.autoupdatingCurrent
    f.dateFormat = "d MMM"
    return f
}()
private let quoteShortDayYearFormatter: DateFormatter = {
    let f = DateFormatter()
    f.locale = Locale(identifier: "ru_RU")
    f.timeZone = TimeZone.autoupdatingCurrent
    f.dateFormat = "d MMM yyyy"
    return f
}()

/// Время в маленьком пузыре цитаты — порт `formatSmallBubbleTimeLabel` +
/// `formatRuRelativeSendDay`: сегодня «19:32», иначе «19:32, вчера» / «19:32, 3 дня назад»
/// / «19:32, 14 авг».
func formatQuoteTimeLabel(_ millis: Int64) -> String {
    let clock = formatClockTime(millis)
    let date = Date(timeIntervalSince1970: Double(millis) / 1000)
    let calendar = Calendar.current
    let days = calendar.dateComponents(
        [.day],
        from: calendar.startOfDay(for: date),
        to: calendar.startOfDay(for: Date())
    ).day ?? 0
    if days <= 0 { return clock }
    if days == 1 { return "\(clock), вчера" }
    // Веб держит «N дней назад» до 45 суток, дальше — краткая дата.
    if days <= 45 { return "\(clock), \(ruQuoteDaysAgo(days))" }
    let sameYear = calendar.isDate(date, equalTo: Date(), toGranularity: .year)
    let formatter = sameYear ? quoteShortDayFormatter : quoteShortDayYearFormatter
    return "\(clock), \(formatter.string(from: date))"
}

/// «2 дня назад» / «5 дней назад» / «21 день назад» — порт `ruPluralDaysAgo`.
private func ruQuoteDaysAgo(_ days: Int) -> String {
    let n = max(2, days)
    let mod100 = n % 100
    let mod10 = n % 10
    if mod100 >= 11 && mod100 <= 14 { return "\(n) дней назад" }
    if mod10 == 1 { return "\(n) день назад" }
    if mod10 >= 2 && mod10 <= 4 { return "\(n) дня назад" }
    return "\(n) дней назад"
}
