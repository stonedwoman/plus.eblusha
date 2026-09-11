import SwiftUI
import UIKit
import UniformTypeIdentifiers

// Ввод композера: панель форматирования над выделением, разметка и картинка из буфера.
//
// Эталон — веб. Там поле ввода это contenteditable, над выделением всплывает панель
// B/I/U (frontend/src/ui/pages/chats/render/MessagesPane.tsx, блок .composer-sel-toolbar),
// а отправляется markdown: htmlToMarkdown кладёт `**жирный**`, `_курсив_`, `~~зачёркнуто~~`
// (frontend/src/ui/lib/chatMarkdown.ts). Ещё веб ловит onPaste и картинку из буфера
// кладёт в очередь вложений, а не в текст (MessagesPane.tsx, addComposerImage(file,'paste')).
//
// На iOS ни того, ни другого не было: SwiftUI TextField отдаёт только строку — ни
// выделения, ни собственного меню, ни вставки картинки. Поэтому поле ввода здесь —
// тонкая обёртка над UITextView: она даёт выделение (панель), своё меню и перехват
// «Вставить». Разметка пишется теми же токенами, что уже читает ChatMarkdown.swift,
// то есть сообщение с iOS и с веба выглядит одинаково на обеих сторонах.

// MARK: - Стили

/// Кнопки панели. Токены — ровно те, что понимает ChatMarkdown (`**`, `_`, `~~`, `` ` ``)
/// и ровно те, что кладёт в текст веб, иначе одинаковый ввод давал бы разный результат.
enum ComposerFormatStyle: String, CaseIterable, Identifiable {
    case bold
    case italic
    case strike
    case mono

    var id: String { rawValue }

    var token: String {
        switch self {
        case .bold: return "**"
        case .italic: return "_"
        case .strike: return "~~"
        case .mono: return "`"
        }
    }

    var title: String {
        switch self {
        case .bold: return "Жирный"
        case .italic: return "Курсив"
        case .strike: return "Зачёркнутый"
        case .mono: return "Моноширинный"
        }
    }

    var icon: String {
        switch self {
        case .bold: return "bold"
        case .italic: return "italic"
        case .strike: return "strikethrough"
        case .mono: return "chevron.left.forwardslash.chevron.right"
        }
    }
}

// MARK: - Расстановка маркеров

/// Чистая арифметика разметки: по тексту и выделению считает, что и на что заменить.
/// Вынесена из вью нарочно — это единственное место, где легко ошибиться на символ,
/// и его удобно проверять отдельно от UIKit.
enum ComposerMarkdown {

    /// Одна правка поля: какой кусок заменить, чем и где оставить выделение после.
    struct Edit {
        let range: NSRange
        let replacement: String
        let selection: NSRange
    }

    static func edit(applying style: ComposerFormatStyle, to text: String, selection: NSRange) -> Edit {
        let ns = text as NSString
        let token = style.token
        let tokenLength = (token as NSString).length

        // Диапазон мог приехать из системного меню уже неактуальным — подрезаем по длине.
        var location = max(0, min(selection.location, ns.length))
        var length = max(0, min(selection.length, ns.length - location))

        // Пробелы по краям выделения внутрь маркеров не берём: двойной тап цепляет
        // пробел за словом, а «** жирный **» разметкой не считает ни ChatMarkdown,
        // ни markdown-it в вебе — формат просто не применился бы.
        while length > 0, isWhitespace(ns.character(at: location)) {
            location += 1
            length -= 1
        }
        while length > 0, isWhitespace(ns.character(at: location + length - 1)) {
            length -= 1
        }

        // Ничего не выделено: ставим пустую пару маркеров и прячем каретку между ними —
        // дальше человек просто печатает внутрь.
        guard length > 0 else {
            return Edit(
                range: NSRange(location: location, length: 0),
                replacement: token + token,
                selection: NSRange(location: location + tokenLength, length: 0)
            )
        }

        let body = ns.substring(with: NSRange(location: location, length: length))

        // Повторное нажатие снимает формат (веб: кнопка B на уже жирном тексте). Случай
        // первый — маркеры стоят ВОКРУГ выделения: так выглядит текст сразу после того,
        // как формат применили, и выделение осталось на словах.
        if location >= tokenLength,
           location + length + tokenLength <= ns.length,
           ns.substring(with: NSRange(location: location - tokenLength, length: tokenLength)) == token,
           ns.substring(with: NSRange(location: location + length, length: tokenLength)) == token {
            return Edit(
                range: NSRange(location: location - tokenLength, length: length + tokenLength * 2),
                replacement: body,
                selection: NSRange(location: location - tokenLength, length: length)
            )
        }

        // Случай второй — маркеры попали В выделение (человек выделил «**слово**» целиком).
        if length > tokenLength * 2, body.hasPrefix(token), body.hasSuffix(token) {
            let inner = (body as NSString).substring(
                with: NSRange(location: tokenLength, length: length - tokenLength * 2)
            )
            return Edit(
                range: NSRange(location: location, length: length),
                replacement: inner,
                selection: NSRange(location: location, length: (inner as NSString).length)
            )
        }

        // Выделение остаётся на тех же словах (без маркеров) — можно сразу навесить
        // второй стиль: «**слово**» → «**_слово_**», ChatMarkdown разбирает вложенность.
        return Edit(
            range: NSRange(location: location, length: length),
            replacement: token + body + token,
            selection: NSRange(location: location + tokenLength, length: length)
        )
    }

    private static func isWhitespace(_ unit: unichar) -> Bool {
        guard let scalar = Unicode.Scalar(unit) else { return false }
        return CharacterSet.whitespacesAndNewlines.contains(scalar)
    }
}

// MARK: - Мост SwiftUI ↔ UITextView

/// Общая точка панели форматирования и поля ввода: панель живёт в SwiftUI, выделение —
/// в UIKit. Через объект панель узнаёт, есть ли выделение, и просит применить стиль.
/// Объект держит ChatComposer (@StateObject), поле ввода лишь подписывает свои замыкания.
final class ComposerTextController: ObservableObject {
    /// Выделение непустое и поле в фокусе — панель видна (веб: composerSelectionAnchor).
    @Published fileprivate(set) var hasSelection = false

    fileprivate var applyStyle: ((ComposerFormatStyle) -> Void)?

    func format(_ style: ComposerFormatStyle) { applyStyle?(style) }
}

// MARK: - Панель над полем

/// Панель форматирования. В вебе она всплывает прямо над выделением; на телефоне место
/// над выделением занимает системная лупа и меню «Копировать», поэтому панель стоит
/// строкой над полем ввода — до неё дотягивается большой палец, и она ничего не
/// перекрывает.
struct ComposerFormatBar: View {
    @ObservedObject var controller: ComposerTextController

    var body: some View {
        if controller.hasSelection {
            HStack(spacing: 6) {
                ForEach(ComposerFormatStyle.allCases) { style in
                    Button {
                        controller.format(style)
                    } label: {
                        Image(systemName: style.icon)
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(Eb.textPrimary)
                            .frame(width: 42, height: 30)
                            .background(Eb.surface300, in: RoundedRectangle(cornerRadius: 8))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(style.title)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            .background(Eb.surface200)
        }
    }
}

// MARK: - Поле ввода

/// Поле ввода композера. Вместо TextField — UITextView, потому что нужны три вещи,
/// которых у SwiftUI-поля нет: выделение (для панели), свой пункт меню и перехват
/// «Вставить» для картинки из буфера.
struct ComposerTextView: UIViewRepresentable {

    @Binding var text: String
    /// Фокус двусторонний: поле сообщает о нём ленте (та подтягивает низ под клавиатуру).
    @Binding var focused: Bool
    let controller: ComposerTextController
    /// Картинка из буфера уходит в очередь вложений, а не в текст (веб-паритет).
    let onPasteImages: ([OutgoingFile]) -> Void
    /// Сколько строк видно до прокрутки — порт прежнего .lineLimit(1...5).
    var maxLines: CGFloat = 5

    func makeCoordinator() -> Coordinator { Coordinator(controller: controller) }

    func makeUIView(context: Context) -> ComposerUITextView {
        let coordinator = context.coordinator
        let view = ComposerUITextView()
        view.delegate = coordinator
        view.backgroundColor = .clear
        view.font = UIFont.preferredFont(forTextStyle: .body)
        view.textColor = UIColor(Eb.textPrimary)
        view.tintColor = UIColor(Eb.brand)
        // Отступы те же, что были у TextField (.padding 14/9) — иначе текст сдвинулся бы
        // относительно плашки-подсказки, нарисованной поверх.
        view.textContainerInset = UIEdgeInsets(top: 9, left: 14, bottom: 9, right: 14)
        view.textContainer.lineFragmentPadding = 0
        view.alwaysBounceVertical = false
        // Подсказка нарисована поверх средствами SwiftUI и для VoiceOver невидима.
        view.accessibilityLabel = "Сообщение"
        view.text = text
        view.onPasteImages = { [weak coordinator] in coordinator?.pasteImages() }
        // weak с обеих сторон: замыкание живёт в контроллере, а тот — во вью-иерархии;
        // сильные ссылки замкнули бы контроллер и координатор друг на друге.
        controller.applyStyle = { [weak coordinator, weak view] style in
            guard let coordinator, let view else { return }
            coordinator.apply(style, to: view, range: nil)
        }
        return view
    }

    func updateUIView(_ view: ComposerUITextView, context: Context) {
        let coordinator = context.coordinator
        // Замыкания пересобираются на каждом рендере — координатор должен звать свежие
        // (тот же приём, что в QrCameraView).
        let textBinding = $text
        let focusBinding = $focused
        coordinator.onText = { textBinding.wrappedValue = $0 }
        coordinator.onFocusChanged = { focusBinding.wrappedValue = $0 }
        coordinator.onPastedImages = onPasteImages

        if view.text != text {
            view.text = text
            // Текст подменили снаружи (восстановленный черновик, очистка после отправки):
            // каретку в конец, иначе она осталась бы на старом месте и следующий символ
            // уехал бы в середину.
            let value: String = view.text ?? ""
            view.selectedRange = NSRange(location: (value as NSString).length, length: 0)
            coordinator.publishSelection(view)
        }

        if focused, !view.isFirstResponder {
            view.becomeFirstResponder()
        } else if !focused, view.isFirstResponder {
            view.resignFirstResponder()
        }
    }

    /// Высота поля считается здесь, а не через биндинг: SwiftUI сам перемеряет вью при
    /// изменении текста, и лишнего состояния (а с ним и дребезга) не заводится.
    func sizeThatFits(
        _ proposal: ProposedViewSize, uiView: ComposerUITextView, context: Context
    ) -> CGSize? {
        let line = uiView.font?.lineHeight ?? 20
        let insets = uiView.textContainerInset.top + uiView.textContainerInset.bottom
        let minHeight = (line + insets).rounded(.up)
        let maxHeight = (line * maxLines + insets).rounded(.up)
        let proposed = proposal.width ?? 0
        let width = proposed.isFinite ? proposed : uiView.bounds.width
        // Ширины ещё нет (первый проход, запрос идеального размера) — отдаём одну строку:
        // у UITextView с прокруткой своей высоты нет, и поле схлопнулось бы в ноль.
        guard width > 1 else { return CGSize(width: max(width, 0), height: minHeight) }
        let fitted = uiView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height
        return CGSize(width: width, height: min(max(fitted, minHeight), maxHeight).rounded(.up))
    }

    final class Coordinator: NSObject, UITextViewDelegate {
        let controller: ComposerTextController
        var onText: (String) -> Void = { _ in }
        var onFocusChanged: (Bool) -> Void = { _ in }
        var onPastedImages: ([OutgoingFile]) -> Void = { _ in }

        init(controller: ComposerTextController) {
            self.controller = controller
        }

        func textViewDidChange(_ textView: UITextView) {
            onText(textView.text ?? "")
            publishSelection(textView)
        }

        func textViewDidChangeSelection(_ textView: UITextView) {
            publishSelection(textView)
        }

        func textViewDidBeginEditing(_ textView: UITextView) {
            onFocusChanged(true)
            publishSelection(textView)
        }

        func textViewDidEndEditing(_ textView: UITextView) {
            onFocusChanged(false)
            // Выделение переживает уход фокуса — панель висела бы над пустой клавиатурой.
            setHasSelection(false)
        }

        /// Те же четыре стиля — пунктами системного меню выделения. Меню перекрывает
        /// панель собой, и без этих пунктов формат был бы недоступен, пока меню на экране.
        func textView(
            _ textView: UITextView, editMenuForTextIn range: NSRange, suggestedActions: [UIMenuElement]
        ) -> UIMenu? {
            guard range.length > 0 else { return nil }
            let actions: [UIMenuElement] = ComposerFormatStyle.allCases.map { style in
                UIAction(title: style.title) { [weak self, weak textView] _ in
                    guard let self, let textView else { return }
                    // Применяем по диапазону из меню: пока меню закрывалось, выделение
                    // в поле могло уже схлопнуться.
                    self.apply(style, to: textView, range: range)
                }
            }
            let formatting = UIMenu(
                title: "Форматирование", image: UIImage(systemName: "textformat"), children: actions
            )
            return UIMenu(title: "", children: suggestedActions + [formatting])
        }

        func apply(_ style: ComposerFormatStyle, to textView: UITextView, range: NSRange?) {
            let target = range ?? textView.selectedRange
            let edit = ComposerMarkdown.edit(
                applying: style, to: textView.text ?? "", selection: target
            )
            // Правим через UITextInput, а не присваиванием .text: так замена попадает в
            // системную отмену (встряхнуть → «Отменить») и не сбрасывает всё набранное.
            guard let start = textView.position(from: textView.beginningOfDocument, offset: edit.range.location),
                  let end = textView.position(from: start, offset: edit.range.length),
                  let uiRange = textView.textRange(from: start, to: end)
            else { return }
            textView.replace(uiRange, withText: edit.replacement)
            textView.selectedRange = edit.selection
            onText(textView.text ?? "")
            publishSelection(textView)
        }

        func pasteImages() {
            let files = ComposerClipboard.readImageFiles()
            guard !files.isEmpty else { return }
            onPastedImages(files)
        }

        func publishSelection(_ textView: UITextView) {
            setHasSelection(textView.selectedRange.length > 0 && textView.isFirstResponder)
        }

        /// Флаг публикуем следующим тиком: выделение меняется и во время обновления вью
        /// (updateUIView трогает selectedRange), а менять @Published прямо в этот момент
        /// SwiftUI считает ошибкой и ругается в консоль.
        private func setHasSelection(_ value: Bool) {
            guard controller.hasSelection != value else { return }
            DispatchQueue.main.async { [controller = self.controller] in
                if controller.hasSelection != value { controller.hasSelection = value }
            }
        }
    }
}

/// UITextView, который умеет «Вставить» для картинки. Обычное текстовое поле такой буфер
/// вставить не может и пункт меню просто не показывает — поэтому оба метода переопределены.
final class ComposerUITextView: UITextView {
    /// В буфере картинка: забрать её в очередь вложений.
    var onPasteImages: (() -> Void)?

    override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
        if action == #selector(paste(_:)), UIPasteboard.general.hasImages { return true }
        return super.canPerformAction(action, withSender: sender)
    }

    override func paste(_ sender: Any?) {
        guard UIPasteboard.general.hasImages else {
            super.paste(sender)
            return
        }
        onPasteImages?()
        // Веб (MessagesPane, onPaste) при чистой картинке гасит событие, а при «картинка
        // + текст» вставляет ещё и текст — повторяем ровно это поведение.
        if UIPasteboard.general.hasStrings { super.paste(sender) }
    }
}

// MARK: - Буфер обмена

/// Картинки из буфера обмена готовыми файлами для очереди вложений.
enum ComposerClipboard {

    /// Проверка типов, а не чтение: `hasImages` не трогает содержимое и не показывает
    /// системную плашку «вставлено из …» — поэтому её можно звать при каждом фокусе.
    static var hasImage: Bool { UIPasteboard.general.hasImages }

    /// Исходные байты PNG/GIF/JPEG берём как есть: пересжатие PNG в JPEG убило бы
    /// прозрачность (скопированный стикер лёг бы на чёрный квадрат), а GIF — анимацию.
    /// Всё остальное (HEIC, скриншот, картинка из чужого приложения) перегоняем в JPEG:
    /// HEIC не показывают ни веб, ни Android-клиент.
    static func readImageFiles() -> [OutgoingFile] {
        let pasteboard = UIPasteboard.general
        let stamp = clipboardNameStamp.string(from: Date())
        var files: [OutgoingFile] = []
        for (index, item) in pasteboard.items.enumerated() {
            if let raw = rawImage(in: item, stamp: stamp, order: index + 1) {
                files.append(raw)
                continue
            }
            guard let image = item.values.compactMap({ $0 as? UIImage }).first,
                  let jpeg = image.jpegData(compressionQuality: 0.9)
            else { continue }
            files.append(OutgoingFile(
                bytes: jpeg, name: "photo-\(stamp)-\(index + 1).jpg", mime: "image/jpeg"
            ))
        }
        // Запасной путь: некоторые приложения кладут картинку мимо items (только image).
        if files.isEmpty, let image = pasteboard.image,
           let jpeg = image.jpegData(compressionQuality: 0.9) {
            files.append(OutgoingFile(bytes: jpeg, name: "photo-\(stamp).jpg", mime: "image/jpeg"))
        }
        return files
    }

    private static func rawImage(in item: [String: Any], stamp: String, order: Int) -> OutgoingFile? {
        for kind in rawTypes {
            guard let data = item[kind.type] as? Data, !data.isEmpty else { continue }
            return OutgoingFile(
                bytes: data, name: "photo-\(stamp)-\(order).\(kind.ext)", mime: kind.mime
            )
        }
        return nil
    }

    private static let rawTypes: [(type: String, mime: String, ext: String)] = [
        (UTType.png.identifier, "image/png", "png"),
        (UTType.gif.identifier, "image/gif", "gif"),
        (UTType.jpeg.identifier, "image/jpeg", "jpg"),
    ]
}

/// Штамп для имён: у буфера обмена, как и у галереи, исходного имени файла нет.
private let clipboardNameStamp: DateFormatter = {
    let formatter = DateFormatter()
    formatter.dateFormat = "yyyyMMdd-HHmmss"
    return formatter
}()
