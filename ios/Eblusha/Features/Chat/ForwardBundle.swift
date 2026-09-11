import Foundation
import SwiftUI

// Конверт пересылки и склейка пересылок в пачки — порт веб-вида:
//   • рамка + штриховка конверта — frontend/src/style.css:1258-1292 (.msg-forward-bundle-outer);
//   • шапка «Имя из «Чат»» / «Имя из переписки с X» с иконкой Forward —
//     chats/render/MessagesPane.tsx:2061-2098 (пачка) и 2331-2363 (одиночная);
//   • имя автора оригинала своим цветом и ОРИГИНАЛЬНОЕ время внутри конверта —
//     chats/render/ChatMessageRow.tsx:457-469, 277-297 и 1464-1476;
//   • склейка подряд идущих пересылок одного источника — chats/chatsMessages.ts:259-295
//     (computeMultiSourceForwardBundles), тексты шапки — там же, 48-56 и 297-335.
//
// Почему отдельный файл: правила склейки — чистая модель, её считает лента
// (MessageListView, один проход на снимок), а конверт рисует строка сообщения. В
// ChatView.swift это уже не влезает, а модель без вью ещё и проверяема глазами.
//
// Веб заворачивает в конверт ЛЮБУЮ пересылку, даже одиночную (chatsMessages.ts:290:
// пачка из одного сообщения — тоже пачка), иначе «одна пересылка» и «пачка» разъезжались
// по вёрстке. Здесь так же: одиночная пересылка — пачка из одного сообщения.

// MARK: - Правила склейки (константы веба)

/// Предельный размах пачки от первой до последней пересылки — порт MULTI_FWD_MAX_SPAN_MS.
/// Защита от склейки далёких по времени сообщений, оказавшихся рядом в ленте.
private let forwardBundleMaxSpanMillis: Int64 = 7 * 24 * 60 * 60 * 1000
/// Максимальная пауза между двумя соседними пересылками одного конверта — MULTI_FWD_GAP_MS.
private let forwardBundleMaxGapMillis: Int64 = 25_000

// MARK: - Чистые правила источника

/// Собеседник в исходной личке для шапки — порт directChatPeerDisplayForForwardHeader.
/// Поле уже собрано репозиторием из `forwardFrom.directChatPeerName` и корневого
/// `metadata.sourceDmPeerName`; у легаси-пересылок его нет, и веб подставляет автора
/// оригинала — «из переписки с Романом» полезнее, чем «из личной переписки».
func forwardDirectPeerDisplay(_ info: ForwardInfo) -> String {
    if let peer = info.directChatPeerName?.trimmed(), !peer.isEmpty { return peer }
    if !info.isGroupSource {
        let author = info.authorName.trimmed()
        if !author.isEmpty { return author }
    }
    return ""
}

/// Отпечаток ИСТОЧНИКА пересылки — порт forwardSourceFingerprintForBundle: только
/// «откуда» (группа или личка с тем же собеседником), без автора оригинала. Иначе две
/// пересылки разных людей из одного чата не слиплись бы в один конверт.
func forwardSourceFingerprint(_ info: ForwardInfo) -> String {
    if info.isGroupSource {
        let title = (info.sourceChatTitle ?? "").trimmed()
        return "grp:\(title.isEmpty ? "«без названия»" : title)"
    }
    let peer = forwardDirectPeerDisplay(info)
    return "dm:p:\(peer.isEmpty ? "¦" : peer)"
}

/// Ключ цвета автора оригинала — порт forwardHueKey из ChatMessageRow.tsx:164-172.
/// У автора чужого чата нет id среди участников беседы, поэтому цвет берётся хэшем от
/// этой строки; строка собрана как в вебе, значит цвет имени совпадает с веб-клиентом.
func forwardAuthorHueKey(_ info: ForwardInfo) -> String {
    "fwd:\(info.authorName.trimmed())|\((info.sourceChatTitle ?? "").trimmed())"
}

/// Заголовок конверта — порт formatMultiSourceForwardBundleSourceHeader: группы в
/// кавычках, личка как «переписки с Имя», несколько источников через « · ».
/// Имя ПЕРЕСЫЛАЮЩЕГО сюда не подставляется (его приклеивает headerTitle).
func formatForwardBundleSourceHeader(_ infos: [ForwardInfo]) -> String {
    var groupTitles: [String] = []
    var dmPeers: [String] = []
    var hasDmWithoutPeer = false
    for info in infos {
        if info.isGroupSource {
            let title = (info.sourceChatTitle ?? "").trimmed()
            let label = title.isEmpty ? "Группа" : title
            if !groupTitles.contains(label) { groupTitles.append(label) }
            continue
        }
        let peer = forwardDirectPeerDisplay(info)
        if peer.isEmpty {
            hasDmWithoutPeer = true
        } else if !dmPeers.contains(peer) {
            dmPeers.append(peer)
        }
    }
    // Порядок источников не должен зависеть от порядка сообщений: веб сортирует
    // localeCompare(ru), здесь — тот же смысл через локализованное сравнение.
    let byName: (String, String) -> Bool = { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending }
    var parts = groupTitles.sorted(by: byName).map { "«\($0)»" }
    let peers = dmPeers.sorted(by: byName)
    if peers.count == 1 {
        parts.append("переписки с \(peers[0])")
    } else if peers.count > 1 {
        parts.append("переписки с \(peers.joined(separator: " · "))")
    } else if hasDmWithoutPeer {
        parts.append("личной переписки")
    }
    if parts.isEmpty { return "Переслано" }
    return "Из \(parts.joined(separator: " · "))"
}

/// То же, но с маленькой «из» — для склейки с именем пересылающего («Роман из «Работа»»).
/// Порт formatForwardSourcePhraseAfterName (chatsMessages.ts:48-56).
func formatForwardSourcePhraseAfterName(_ infos: [ForwardInfo]) -> String {
    let raw = formatForwardBundleSourceHeader(infos).trimmed()
    if raw.isEmpty { return "пересланное" }
    if raw.hasPrefix("Из ") { return "из \(raw.dropFirst(3))" }
    return raw
}

/// Оригинальное время («19:32, вчера») — веб подменяет им время пузыря у пересылки
/// (ChatMessageRow.tsx:277-283). nil — сервер времени оригинала не передал (легаси).
func forwardOriginalTimeLabel(_ info: ForwardInfo) -> String? {
    guard let millis = info.originalCreatedAt, millis > 0 else { return nil }
    // Тот же формат, что у карточки цитаты: сегодня «19:32», иначе «19:32, вчера».
    return formatQuoteTimeLabel(millis)
}

// MARK: - Пачки

/// Пересылка ли это (и что именно переслано). Удалённые и системные рвут пачку — как в
/// вебе, где цикл на них прерывается.
private func forwardInfoForBundling(_ m: Message) -> ForwardInfo? {
    if m.deleted || m.isSystem { return nil }
    guard let info = m.forwardFrom, !info.authorName.trimmed().isEmpty else { return nil }
    return info
}

/// Пачка подряд идущих пересылок одного пересылающего из одного источника.
struct ForwardBundle: Identifiable, Equatable {
    /// Индекс первого сообщения пачки в поданном массиве (ленте он нужен для склейки строк).
    let start: Int
    /// Сообщения пачки в порядке ленты; всегда хотя бы одно.
    let messages: [Message]
    /// Кто переслал: пачка не склеивается с пересылкой другого человека.
    let forwarderId: String
    /// Общая шапка источника: «Из «Работа»» / «Из переписки с Романом».
    let sourceHeader: String
    /// Та же шапка для склейки с именем: «из «Работа»».
    let sourcePhraseAfterName: String

    var id: String { messages.first?.id ?? "fwd-bundle-\(start)" }
    /// Имя пересылающего — из первого сообщения (у всей пачки он один).
    var forwarderName: String { messages.first?.senderName ?? "" }
    /// Готовая строка шапки, как её пишет веб: «Роман из переписки с Настей».
    var headerTitle: String {
        let name = forwarderName.trimmed()
        return name.isEmpty ? sourcePhraseAfterName : "\(name) \(sourcePhraseAfterName)"
    }
}

/// Склейка подряд идущих пересылок в пачки — порт computeMultiSourceForwardBundles.
/// Чистая функция: ничего не знает про вью, результат зависит только от массива.
/// Правила (все три обязательны): один пересылающий, один отпечаток источника и
/// временные лимиты — пауза между соседними ≤ 25 c, размах пачки ≤ 7 суток.
func computeForwardBundles(_ messages: [Message]) -> [ForwardBundle] {
    var out: [ForwardBundle] = []
    var i = 0
    let n = messages.count
    while i < n {
        guard let info = forwardInfoForBundling(messages[i]) else {
            i += 1
            continue
        }
        let forwarderId = messages[i].senderId
        let firstMillis = messages[i].createdAt
        let fingerprint = forwardSourceFingerprint(info)
        var j = i
        while j + 1 < n {
            let next = messages[j + 1]
            guard let nextInfo = forwardInfoForBundling(next) else { break }
            if next.senderId != forwarderId { break }
            if forwardSourceFingerprint(nextInfo) != fingerprint { break }
            if next.createdAt - firstMillis > forwardBundleMaxSpanMillis { break }
            if next.createdAt - messages[j].createdAt > forwardBundleMaxGapMillis { break }
            j += 1
        }
        let slice = Array(messages[i...j])
        let infos = slice.compactMap { $0.forwardFrom }
        out.append(ForwardBundle(
            start: i,
            messages: slice,
            forwarderId: forwarderId,
            sourceHeader: formatForwardBundleSourceHeader(infos),
            sourcePhraseAfterName: formatForwardSourcePhraseAfterName(infos)
        ))
        i = j + 1
    }
    return out
}

/// Место одного сообщения в своей пачке. Лента раздаёт слоты строкам: общую шапку
/// источника рисует только первая строка пачки, остальные — только конверт.
struct ForwardBundleSlot: Equatable {
    /// id первого сообщения пачки — им пачка и опознаётся.
    let bundleId: String
    let indexInBundle: Int
    let count: Int
    /// «Роман из переписки с Настей» — готовая шапка пачки.
    let headerTitle: String

    var isFirst: Bool { indexInBundle == 0 }
    var isLast: Bool { indexInBundle == count - 1 }
    /// Пачка из нескольких сообщений: по этому признаку видно, что конверт продолжается.
    var isMulti: Bool { count > 1 }
}

/// Слоты по id сообщения — ровно то, что нужно ленте: один проход, дальше строка берёт
/// свой слот словарём. Сообщения без пересылки в словарь не попадают.
func computeForwardBundleSlots(_ messages: [Message]) -> [String: ForwardBundleSlot] {
    var out: [String: ForwardBundleSlot] = [:]
    for bundle in computeForwardBundles(messages) {
        let title = bundle.headerTitle
        for (index, message) in bundle.messages.enumerated() {
            out[message.id] = ForwardBundleSlot(
                bundleId: bundle.id,
                indexInBundle: index,
                count: bundle.messages.count,
                headerTitle: title
            )
        }
    }
    return out
}

// MARK: - Вид конверта

enum ForwardEnvelopeMetrics {
    /// Скругление и толщина рамки — как у веба (border-radius 14, border 2px).
    static let cornerRadius: CGFloat = 14
    static let borderWidth: CGFloat = 2
    /// Горизонтальные паддинги карточки: на столько конверт сужает содержимое внутри
    /// пузыря. Вложения считают свой размер от ширины экрана заранее (albumBudget),
    /// поэтому им эту потерю надо передать, иначе мозаика вылезет за рамку.
    static let horizontalInset: CGFloat = 20
}

/// Штриховка фона конверта — порт repeating-linear-gradient(-32deg …) из style.css:1281.
/// Рисуется одним Path: это дешевле, чем слои изображений, и не зависит от ассетов.
private struct ForwardHatchPattern: Shape {
    /// Шаг между линиями (в вебе — 9px) и наклон в градусах.
    let step: CGFloat = 9
    let angleDegrees: CGFloat = 32

    func path(in rect: CGRect) -> Path {
        var path = Path()
        guard rect.width > 0, rect.height > 0 else { return path }
        let shift = rect.height * tan(angleDegrees * .pi / 180)
        var x = rect.minX - shift
        while x <= rect.maxX + shift {
            path.move(to: CGPoint(x: x, y: rect.maxY))
            path.addLine(to: CGPoint(x: x + shift, y: rect.minY))
            x += step
        }
        return path
    }
}

/// Конверт пересланного сообщения: янтарная рамка со штриховкой, шапка «кто и откуда»
/// сверху (только у первого сообщения пачки), внутри — имя автора оригинала его цветом,
/// содержимое (текст, альбом, файлы) и ОРИГИНАЛЬНОЕ время справа снизу.
///
/// Содержимое приходит слотом, а не собирается здесь: вложения тянут за собой ключи
/// секретного треда, рамки плиток для просмотрщика и нумерацию галереи — всё это уже
/// умеет строка сообщения, и дублировать это внутри конверта значило бы разъезжающийся
/// второй рендер вложений.
struct ForwardEnvelope<Content: View>: View {
    /// Шапка «Роман из переписки с Настей». nil — сообщение не первое в пачке, шапка
    /// уже нарисована выше (веб-паритет: у пачки один заголовок на конверт).
    var header: String? = nil
    /// Цвет шапки — цвет ПЕРЕСЫЛАЮЩЕГО (в вебе nameColorForUser(m.senderId)).
    var headerColor: Color = Eb.textPrimary
    /// Имя автора оригинала; пустое — не рисуем строку вовсе.
    var authorName: String = ""
    /// Цвет автора оригинала — хэш от forwardAuthorHueKey (его нет в участниках беседы).
    var authorColor: Color = Eb.textPrimary
    /// «19:32, вчера» — время оригинала в исходном чате; nil — сервер его не дал.
    var originalTime: String? = nil
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let header, !header.isEmpty {
                HStack(spacing: 5) {
                    Text(header)
                        .font(.system(size: 14, weight: .bold))
                        .foregroundStyle(headerColor)
                    Image(systemName: "arrowshape.turn.up.right")
                        .font(.system(size: 12, weight: .bold))
                        .foregroundStyle(Eb.brand)
                }
                .fixedSize(horizontal: false, vertical: true)
            }
            card
        }
    }

    private var card: some View {
        VStack(alignment: .leading, spacing: 4) {
            let author = authorName.trimmed()
            if !author.isEmpty {
                Text(author)
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(authorColor)
            }
            content()
            if let originalTime, !originalTime.isEmpty {
                // Время оригинала веб кладёт право-выровненной строкой под содержимым
                // (ChatMessageRow.tsx:1464-1476). Spacer с minLength 0 не растягивает
                // конверт: его собственная ширина — ноль, поэтому короткий текст остаётся
                // коротким, а при широком альбоме время просто уезжает вправо.
                HStack(spacing: 0) {
                    Spacer(minLength: 0)
                    Text(originalTime)
                        .font(.system(size: 11))
                        .foregroundStyle(Eb.textMuted)
                }
            }
        }
        .padding(.horizontal, ForwardEnvelopeMetrics.horizontalInset / 2)
        .padding(.vertical, 8)
        .background {
            // Фон конверта: тёплая подложка с уходом в тёмный + диагональная штриховка —
            // те же два слоя, что в .msg-forward-bundle-outer.
            ZStack {
                LinearGradient(
                    stops: [
                        .init(color: Color(hex: 0x3D3020, opacity: 0.55), location: 0),
                        .init(color: Color(hex: 0x161A22, opacity: 0.96), location: 0.55),
                        .init(color: Color(hex: 0x12161E), location: 1),
                    ],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                )
                ForwardHatchPattern()
                    .stroke(Color.white.opacity(0.07), lineWidth: 1)
            }
            .clipShape(RoundedRectangle(cornerRadius: ForwardEnvelopeMetrics.cornerRadius))
        }
        .overlay {
            RoundedRectangle(cornerRadius: ForwardEnvelopeMetrics.cornerRadius)
                .strokeBorder(Eb.brand.opacity(0.5), lineWidth: ForwardEnvelopeMetrics.borderWidth)
        }
        // Янтарное свечение конверта (в вебе — box-shadow): без него рамка на тёмном фоне
        // читается как обычная обводка пузыря.
        .shadow(color: Eb.brand.opacity(0.12), radius: 7, y: 3)
    }
}
