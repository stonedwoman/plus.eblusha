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
struct ReactionPickerSheet: View {

    let onPick: (String) -> Void
    let onDismiss: () -> Void

    @State private var query = ""
    @State private var category: EmojiCatalog.Category = .popular

    private var shown: [String] {
        let text = query.trimmed()
        guard !text.isEmpty else { return EmojiCatalog.emoji(in: category) }
        return EmojiCatalog.search(text)
    }

    private let columns = Array(repeating: GridItem(.flexible(), spacing: 6), count: 8)

    var body: some View {
        NavigationStack {
            VStack(spacing: 10) {
                if query.trimmed().isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 6) {
                            ForEach(EmojiCatalog.Category.allCases, id: \.self) { item in
                                Button {
                                    category = item
                                } label: {
                                    Text(item.icon)
                                        .font(.title3)
                                        .frame(width: 38, height: 34)
                                        .background(
                                            item == category ? Eb.brand.opacity(0.25) : Eb.surface100,
                                            in: RoundedRectangle(cornerRadius: 9)
                                        )
                                }
                                .buttonStyle(.plain)
                            }
                        }
                        .padding(.horizontal, 12)
                    }
                }

                ScrollView {
                    LazyVGrid(columns: columns, spacing: 6) {
                        ForEach(shown, id: \.self) { emoji in
                            Button {
                                onPick(emoji)
                            } label: {
                                Text(emoji)
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
    }
}

/// Набор эмодзи для пикера. Веб тянет полный список Fluent-ассетов с сервера; здесь —
/// компактный каталог популярного, чтобы не тащить в бандл несколько тысяч картинок.
enum EmojiCatalog {

    enum Category: String, CaseIterable {
        case popular, smileys, people, nature, food, places, activities, objects, symbols

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
            }
        }
    }

    static func emoji(in category: Category) -> [String] {
        switch category {
        case .popular: return popular
        case .smileys: return smileys
        case .people: return people
        case .nature: return nature
        case .food: return food
        case .places: return places
        case .activities: return activities
        case .objects: return objects
        case .symbols: return symbols
        }
    }

    static var all: [String] {
        Category.allCases.filter { $0 != .popular }.flatMap { emoji(in: $0) }
    }

    /// Поиск по названию: у эмодзи из каталога есть русские подписи для частого.
    static func search(_ text: String) -> [String] {
        let needle = text.lowercased()
        let matched = names.filter { $0.value.contains(where: { $0.contains(needle) }) }.map(\.key)
        return matched.isEmpty ? all : matched
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
        "😳", "🥺", "😦", "😨", "😰", "😥", "😢", "😭", "😱", "😖", "😣", "😞",
        "😓", "😩", "😫", "🥱", "😤", "😡", "😠", "🤬", "😈", "👿", "💀", "💩",
    ]

    private static let people = [
        "👋", "🤚", "✋", "🖖", "👌", "🤌", "🤏", "✌️", "🤞", "🤟", "🤘", "🤙",
        "👈", "👉", "👆", "👇", "☝️", "👍", "👎", "✊", "👊", "🤛", "🤜", "👏",
        "🙌", "👐", "🤲", "🤝", "🙏", "💪", "🦾", "🖐️", "💅", "👀", "👁️", "👄",
        "🧠", "🫀", "👶", "🧒", "👦", "👧", "🧑", "👨", "👩", "🧔", "👴", "👵",
        "🙇", "🤦", "🤷", "💁", "🙅", "🙆", "🙋", "🧏", "💃", "🕺", "👯", "🧘",
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
        "🥂", "🍷", "🥃", "🍸", "🍹", "🧉", "🥄", "🍴",
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
        "🕳️", "💬", "💭", "🗯️", "♻️", "✅", "❌", "⭕", "❗", "❓", "‼️", "⁉️",
        "⚠️", "🚫", "🔞", "📵", "🔅", "🔆", "〽️", "⚜️", "🔱", "📛", "🔰", "⭐",
        "🌟", "✨", "⚡", "🔥", "❄️", "🎵", "🎶", "➕", "➖", "➗", "✖️", "🟰",
        "♾️", "🆗", "🆕", "🆒", "🆓", "🔝", "🔜", "🔙", "🔚", "🔛", "🔄", "🔃",
    ]

    /// Подписи для поиска. Полного словаря имён у системы нет, поэтому — популярное.
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
