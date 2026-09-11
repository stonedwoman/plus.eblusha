import SwiftUI

/// Быстрые реакции и полный выбор эмодзи — порт веб-поведения
/// (`chats/reactionFavoritesStore.ts` + `components/MessageReactionRail.tsx`).
///
/// На iOS до этого был жёстко зашитый ряд из шести эмодзи и никакого способа поставить
/// что-то другое: если с веба поставили «🤘», ответить тем же с телефона было нельзя.
enum ReactionFavorites {

    /// Ровно те же четыре умолчания, что и в вебе.
    static let defaults = ["👍", "😂", "❤️", "🤘"]

    private static let maxStored = 96

    private static func key(_ userId: String) -> String {
        "eblusha.reaction-fav.v1.\(userId)"
    }

    /// Недавно выбранные пользователем, свежие первыми.
    static func recent(userId: String?) -> [String] {
        guard let userId, !userId.isEmpty else { return [] }
        return UserDefaults.standard.stringArray(forKey: key(userId)) ?? []
    }

    /// Четыре слота быстрого ряда: сначала недавние, затем умолчания (веб: getQuickReactionSlots).
    static func quickSlots(userId: String?) -> [String] {
        var seen = Set<String>()
        var out: [String] = []
        for emoji in recent(userId: userId) + defaults where !seen.contains(emoji) {
            seen.insert(emoji)
            out.append(emoji)
            if out.count == 4 { break }
        }
        return out
    }

    /// Запоминаем ТОЛЬКО постановку реакции, не снятие (как в вебе).
    static func record(userId: String?, emoji: String) {
        guard let userId, !userId.isEmpty, !emoji.isEmpty else { return }
        var order = recent(userId: userId).filter { $0 != emoji }
        order.insert(emoji, at: 0)
        UserDefaults.standard.set(Array(order.prefix(maxStored)), forKey: key(userId))
    }
}

/// Полный выбор эмодзи: поиск и категории, как в веб-пикере.
///
/// Каталог приезжает из `EmojiCatalogSource` (тот же индекс, что у веба) — поэтому
/// читаем его в `.task`, а не строим в теле: 3145 записей разбираются вне главного потока.
struct ReactionPickerSheet: View {

    let onPick: (String) -> Void
    let onDismiss: () -> Void

    @State private var query = ""
    @State private var category: EmojiCatalog.Category = .popular
    /// Снимок индекса на время показа листа. Пустой — работаем на встроенном списке.
    @State private var index: [EmojiIndexEntry] = EmojiCatalogSource.cached()
    @State private var loading = true

    private var shown: [EmojiIndexEntry] {
        let text = query.trimmed()
        guard !text.isEmpty else { return EmojiCatalog.entries(in: category, index: index) }
        return EmojiCatalog.search(text, index: index)
    }

    private var searching: Bool { !query.trimmed().isEmpty }

    private let columns = Array(repeating: GridItem(.flexible(), spacing: 6), count: 8)

    var body: some View {
        NavigationStack {
            VStack(spacing: 10) {
                categoryRail
                content
            }
            .padding(.top, 8)
            .background(Eb.paper)
            .searchable(text: $query, prompt: "Поиск эмодзи")
            .navigationTitle("Реакция")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Закрыть", action: onDismiss)
                }
            }
        }
        .presentationDetents([.medium, .large])
        .task {
            // Индекс мог уже лежать в памяти — тогда это мгновенно и без мигания.
            index = await EmojiCatalogSource.entries()
            loading = false
        }
    }

    /// Полоса категорий. Как в вебе: видна всегда, но при поиске ни одна не подсвечена,
    /// а тап по категории сбрасывает запрос (MessageReactionRail.tsx:433-450).
    private var categoryRail: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(EmojiCatalog.Category.allCases, id: \.self) { item in
                    Button {
                        category = item
                        query = ""
                    } label: {
                        Text(item.icon)
                            .font(.title3)
                            .frame(width: 38, height: 34)
                            .background(
                                item == category && !searching ? Eb.brand.opacity(0.25) : Eb.surface100,
                                in: RoundedRectangle(cornerRadius: 9)
                            )
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(item.title)
                }
            }
            .padding(.horizontal, 12)
        }
    }

    @ViewBuilder
    private var content: some View {
        let list = shown
        ScrollView {
            if list.isEmpty {
                // Промах поиска — это пустой результат, а не «весь каталог» (как было раньше).
                Text(loading && index.isEmpty ? "Загрузка" : "Ничего не найдено")
                    .font(.callout)
                    .foregroundStyle(Eb.textMuted)
                    .frame(maxWidth: .infinity)
                    .padding(.top, 32)
            } else {
                LazyVGrid(columns: columns, spacing: 6) {
                    ForEach(list, id: \.emoji) { entry in
                        Button {
                            onPick(entry.emoji)
                        } label: {
                            Text(entry.emoji)
                                .font(.system(size: 30))
                                .frame(maxWidth: .infinity, minHeight: 42)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 12)
                .padding(.bottom, 20)
            }
        }
    }
}

/// Каталог эмодзи пикера. Данные — индекс из `EmojiCatalogSource` (тот же файл, что у
/// веба); этот тип лишь делит его на категории и ищет по ключевым словам, повторяя
/// `emojiEntryMatchesCategory` и фильтр поиска из MessageReactionRail.tsx.
///
/// Встроенный список ниже — аварийный: он выручает, только если индекса нет ни в кэше,
/// ни в бандле (обычно этого не бывает, файл лежит в Resources).
enum EmojiCatalog {

    /// «Популярные» — первые N записей индекса, как POPULAR_EMOJI_COUNT в вебе.
    static let popularCount = 143

    enum Category: String, CaseIterable {
        case popular, smileys, people, nature, food, places, activities, objects, symbols, flags

        /// Значок вкладки — те же эмодзи, что в REACTION_EMOJI_CATEGORIES веба.
        var icon: String {
            switch self {
            case .popular: return "⭐"
            case .smileys: return "😀"
            case .people: return "👋"
            case .nature: return "🐶"
            case .food: return "🍔"
            case .places: return "✈️"
            case .activities: return "⚽"
            case .objects: return "💡"
            case .symbols: return "🔣"
            case .flags: return "🏳️"
            }
        }

        var title: String {
            switch self {
            case .popular: return "Популярные"
            case .smileys: return "Лица и эмоции"
            case .people: return "Люди и жесты"
            case .nature: return "Животные и природа"
            case .food: return "Еда и напитки"
            case .places: return "Места и транспорт"
            case .activities: return "Активности"
            case .objects: return "Объекты"
            case .symbols: return "Символы"
            case .flags: return "Флаги"
            }
        }

        /// Признак категории внутри строки ключевых слов — это название группы Unicode,
        /// которое генератор индекса кладёт в `search`. У «популярных» признака нет:
        /// они определяются позицией в индексе.
        var marker: String? {
            switch self {
            case .popular: return nil
            case .smileys: return "smileys emotion"
            case .people: return "people body"
            case .nature: return "animals nature"
            case .food: return "food drink"
            case .places: return "travel places"
            case .activities: return "activities"
            case .objects: return "objects"
            case .symbols: return "symbols"
            case .flags: return "flags"
            }
        }
    }

    /// Записи категории. Индекс пуст — отдаём встроенный аварийный список.
    static func entries(in category: Category, index: [EmojiIndexEntry]) -> [EmojiIndexEntry] {
        guard !index.isEmpty else {
            return fallback(in: category).map { EmojiIndexEntry(emoji: $0, search: "") }
        }
        guard let marker = category.marker else { return Array(index.prefix(popularCount)) }
        return index.filter { $0.search.contains(marker) }
    }

    /// Поиск как в вебе (MessageReactionRail.tsx:184-196): запрос нормализуется, бьётся на
    /// слова, и запись подходит, только если содержит ВСЕ слова. Отдельная ветка — когда от
    /// запроса после нормализации ничего не осталось (вставили сам эмодзи): ищем по символу.
    ///
    /// Промах возвращает пустой массив: раньше здесь отдавался весь каталог, из-за чего
    /// поиск выглядел сломанным — любое незнакомое слово «показывало всё».
    static func search(_ text: String, index: [EmojiIndexEntry]) -> [EmojiIndexEntry] {
        let raw = text.trimmed()
        guard !raw.isEmpty else { return [] }
        guard !index.isEmpty else {
            return fallbackSearch(raw).map { EmojiIndexEntry(emoji: $0, search: "") }
        }
        let terms = EmojiSearchText.terms(raw)
        guard !terms.isEmpty else { return index.filter { $0.emoji.contains(raw) } }
        return index.filter { entry in terms.allSatisfy { entry.search.contains($0) } }
    }

    /// Старое синхронное API (полоса стикеров в фоторедакторе зовёт его прямо из body).
    /// Отдаёт то, что уже есть в памяти, и попутно просит прогреть индекс.
    static func emoji(in category: Category) -> [String] {
        let index = EmojiCatalogSource.cached()
        if index.isEmpty { EmojiCatalogSource.warmUp() }
        return entries(in: category, index: index).map(\.emoji)
    }

    // MARK: - Аварийный встроенный список

    private static func fallback(in category: Category) -> [String] {
        let list: [String]
        switch category {
        case .popular: list = popular
        case .smileys: list = smileys
        case .people: list = people
        case .nature: list = nature
        case .food: list = food
        case .places: list = places
        case .activities: list = activities
        case .objects: list = objects
        case .symbols: list = symbols
        case .flags: list = flags
        }
        return deduplicated(list)
    }

    /// Поиск по встроенному списку: полного словаря имён у системы нет, поэтому здесь
    /// только ходовые подписи. Настоящий поиск живёт в индексе (см. `search`).
    private static func fallbackSearch(_ text: String) -> [String] {
        let needle = EmojiSearchText.normalize(text)
        guard !needle.isEmpty else {
            return deduplicated(Category.allCases.flatMap { fallback(in: $0) }).filter { $0.contains(text) }
        }
        return names
            .filter { pair in pair.value.contains { EmojiSearchText.normalize($0).contains(needle) } }
            .map(\.key)
            .sorted()
    }

    /// Одинаковые эмодзи внутри списка ломали бы `ForEach(id: \.emoji)`.
    private static func deduplicated(_ list: [String]) -> [String] {
        var seen = Set<String>()
        return list.filter { seen.insert($0).inserted }
    }

    private static let popular = [
        "👍", "😂", "❤️", "🤘", "🔥", "👏", "🙏", "😍", "😊", "😢", "😮", "😡",
        "🎉", "💯", "🤔", "👀", "😅", "🙈", "💩", "🤝", "✅", "❌", "⚡", "🌚",
    ]

    private static let smileys = [
        "😀", "😃", "😄", "😁", "😆", "😅", "😂", "🤣", "🙂", "🙃", "😉", "😊",
        "😇", "😍", "🥰", "😘", "😗", "😚", "😋", "😛", "😜", "🤪", "😝", "🤑",
        "🤗", "🤭", "🤫", "🤔", "🤐", "😐", "😑", "😶", "😏", "😒", "🙄", "😬",
        "😔", "😪", "🤤", "😴", "😷", "🤒", "🤕", "🤢", "🤮", "🥵", "🥶", "😵",
        "🤯", "🤠", "🥳", "😎", "🤓", "🧐", "😕", "😟", "🙁", "😮", "😯", "😲",
        "😳", "🥺", "🥲", "😦", "😨", "😰", "😥", "😢", "😭", "😱", "😖", "😣",
        "😞", "😓", "😩", "😫", "🥱", "😤", "😡", "😠", "🤬", "😈", "👿", "💀",
    ]

    private static let people = [
        "👋", "🤚", "✋", "🖖", "👌", "🤌", "🤏", "✌️", "🤞", "🤟", "🤘", "🤙",
        "👈", "👉", "👆", "👇", "☝️", "👍", "👎", "✊", "👊", "🤛", "🤜", "👏",
        "🙌", "👐", "🤲", "🤝", "🙏", "💪", "🦾", "🖐️", "💅", "👀", "👁️", "👄",
        "🫡", "🫢", "🫶", "🫂", "🧠", "🫀", "👶", "🧒", "👦", "👧", "🧑", "👨",
        "👩", "🧔", "👴", "👵", "🙇", "🤦", "🤷", "💁", "🙅", "🙆", "🙋", "🧏",
        "💃", "🕺", "👯", "🧘",
    ]

    private static let nature = [
        "🐶", "🐱", "🐭", "🐹", "🐰", "🦊", "🐻", "🐼", "🐨", "🐯", "🦁", "🐮",
        "🐷", "🐸", "🐵", "🙈", "🙉", "🙊", "🐒", "🦄", "🐴", "🦓", "🦌", "🐺",
        "🐗", "🐘", "🦏", "🐫", "🦒", "🐆", "🐅", "🐊", "🐢", "🦎", "🐍", "🐙",
        "🦑", "🦐", "🦀", "🐡", "🐠", "🐟", "🐬", "🐳", "🐋", "🦈", "🐦", "🐧",
        "🕊️", "🦅", "🦉", "🦋", "🐌", "🐛", "🐜", "🐝", "🌵", "🌲", "🌳", "🌴",
        "🌱", "🌿", "☘️", "🍀", "🍁", "🍂", "🍃", "🌸", "🌹", "🌺", "🌻", "🌼",
        "🌙", "⭐", "🌟", "✨", "⚡", "🔥", "🌈", "☀️", "⛅", "☁️", "🌧️", "❄️",
    ]

    private static let food = [
        "🍏", "🍎", "🍐", "🍊", "🍋", "🍌", "🍉", "🍇", "🍓", "🫐", "🍈", "🍒",
        "🍑", "🥭", "🍍", "🥥", "🥝", "🍅", "🥑", "🍆", "🥔", "🥕", "🌽", "🌶️",
        "🥒", "🥬", "🥦", "🧄", "🧅", "🍄", "🥜", "🌰", "🍞", "🥐", "🥖", "🥨",
        "🧀", "🥚", "🍳", "🥞", "🧇", "🥓", "🍔", "🍟", "🍕", "🌭", "🥪", "🌮",
        "🌯", "🥙", "🍜", "🍲", "🍣", "🍱", "🍤", "🍚", "🍦", "🍩", "🍪", "🎂",
        "🍰", "🧁", "🍫", "🍬", "🍭", "🍯", "☕", "🍵", "🧃", "🥤", "🍺", "🍻",
        "🥂", "🍷", "🥃", "🍸", "🍹", "🧉", "🍾", "🥄", "🍴",
    ]

    private static let places = [
        "🚗", "🚕", "🚙", "🚌", "🚎", "🏎️", "🚓", "🚑", "🚒", "🚐", "🚚", "🚛",
        "🚜", "🛴", "🚲", "🛵", "🏍️", "🚨", "🚔", "🚍", "🚝", "🚄", "🚅", "🚈",
        "🚂", "🚆", "🚊", "🚉", "✈️", "🛫", "🛬", "🚀", "🛸", "🚁", "⛵", "🚤",
        "🛳️", "⚓", "🏠", "🏡", "🏢", "🏥", "🏦", "🏨", "🏫", "🏰", "🗼", "🗽",
        "⛰️", "🏔️", "🌋", "🏕️", "🏖️", "🏝️", "🌅", "🌄", "🌆", "🌃", "🌌", "🌉",
    ]

    private static let activities = [
        "⚽", "🏀", "🏈", "⚾", "🥎", "🎾", "🏐", "🏉", "🥏", "🎱", "🏓", "🏸",
        "🥅", "🏒", "🏑", "🥍", "🏏", "⛳", "🏹", "🎣", "🥊", "🥋", "🎽", "🛹",
        "🛼", "⛸️", "🥌", "🎿", "⛷️", "🏂", "🏋️", "🤼", "🤸", "🤺", "🤾", "🏌️",
        "🏇", "🧘", "🏄", "🏊", "🤽", "🚣", "🧗", "🚴", "🚵", "🎯", "🎮", "🕹️",
        "🎲", "🧩", "🎭", "🎨", "🎬", "🎤", "🎧", "🎼", "🎹", "🥁", "🎷", "🎺",
        "🎸", "🪕", "🎻", "🏆", "🥇", "🥈", "🥉", "🏅", "🎖️", "🎗️", "🎫", "🎟️",
        "🎄", "🎃", "🎁",
    ]

    private static let objects = [
        "💡", "🔦", "🕯️", "🧯", "🛢️", "💸", "💵", "💰", "💳", "💎", "⚖️", "🧰",
        "🔧", "🔨", "⚒️", "🛠️", "⛏️", "🔩", "⚙️", "🧱", "⛓️", "🧲", "🔫", "💣",
        "🧨", "🔪", "🗡️", "⚔️", "🛡️", "🚬", "⚰️", "🏺", "🔮", "📿", "💈", "⚗️",
        "🔭", "🔬", "🕳️", "💊", "💉", "🩹", "🩺", "🚪", "🛏️", "🛋️", "🚽", "🚿",
        "🛁", "🧴", "🧷", "🧹", "🧺", "🧻", "🧼", "🪣", "📱", "💻", "⌨️", "🖥️",
        "🖨️", "🖱️", "💽", "💾", "📀", "📷", "📹", "🎥", "📞", "☎️", "📟", "📠",
        "📺", "📻", "⏰", "⌚", "⏳", "📡", "🔋", "🔌", "📚", "📖", "📝", "✏️",
        "📌", "📎", "🔗", "📅", "📊", "📈", "📉", "🗂️", "📁", "🗑️", "🔒", "🔑",
    ]

    private static let symbols = [
        "❤️", "🧡", "💛", "💚", "💙", "💜", "🖤", "🤍", "🤎", "💔", "❣️", "💕",
        "💞", "💓", "💗", "💖", "💘", "💝", "💯", "💢", "💥", "💫", "💦", "💨",
        "💬", "💭", "🗯️", "♻️", "✅", "❌", "⭕", "❗", "❓", "‼️", "⁉️", "⚠️",
        "🚫", "🔞", "📵", "🔅", "🔆", "〽️", "⚜️", "🔱", "📛", "🔰", "🎵", "🎶",
        "➕", "➖", "➗", "✖️", "🟰", "♾️", "🆗", "🆕", "🆒", "🆓", "🔝", "🔜",
        "🔙", "🔚", "🔛", "🔄", "🔃",
    ]

    /// Индекс веба хранит ровно эти восемь флагов (страновых в наборе Fluent нет).
    private static let flags = [
        "🏳️", "🏴", "🏁", "🚩", "🎌", "🏴‍☠️", "🏳️‍🌈", "🏳️‍⚧️",
    ]

    /// Подписи для поиска по встроенному списку. Полного словаря имён у системы нет,
    /// поэтому — только ходовое; настоящие ключевые слова приходят с индексом.
    private static let names: [String: [String]] = [
        "👍": ["палец", "лайк", "класс", "ок"],
        "👎": ["дизлайк", "палец вниз"],
        "❤️": ["сердце", "любовь"],
        "😂": ["смех", "слёзы", "ржу"],
        "🤣": ["ржу", "смех"],
        "🔥": ["огонь", "пожар", "жара"],
        "👏": ["хлопок", "аплодисменты", "браво"],
        "🙏": ["спасибо", "молитва", "пожалуйста"],
        "😍": ["влюблён", "сердечки", "восторг"],
        "😢": ["грусть", "слеза", "плач"],
        "😭": ["плач", "рыдание"],
        "😡": ["злость", "гнев"],
        "🎉": ["праздник", "ура", "конфетти"],
        "💯": ["сто", "точно", "полностью"],
        "🤔": ["думаю", "вопрос", "хм"],
        "👀": ["глаза", "смотрю"],
        "🤘": ["коза", "рок"],
        "✅": ["галочка", "готово", "да"],
        "❌": ["крест", "нет", "отмена"],
        "🤝": ["рукопожатие", "договор"],
        "💩": ["какашка", "плохо"],
        "🚀": ["ракета", "запуск", "быстро"],
        "☕": ["кофе", "чай"],
        "🍕": ["пицца", "еда"],
        "🐶": ["собака", "пёс"],
        "🐱": ["кот", "кошка"],
    ]
}
