import Foundation

/// Текст секретных чатов, набранный ДО прихода ключа треда.
///
/// Веб держит такую очередь в состоянии страницы чатов (ChatsPage.tsx: pendingByConv +
/// secretBootQueueRef), поэтому переключение бесед её не рушит. На iOS ChatViewModel живёт
/// в @StateObject внутри ChatView, и возврат в список чатов уничтожал очередь вместе с
/// набранным текстом — сообщение пропадало навсегда. Отсюда отдельное хранилище, живущее
/// дольше экрана (как DraftStore), плюс запись на диск: ключ треда может приехать через
/// минуты, а приложение к этому моменту уже успевает быть выгруженным системой.
///
/// Почему plaintext в песочнице, а не Keychain: это ещё НЕ секретное сообщение — шифровать
/// его нечем (ключа треда нет), а Keychain под накопительную очередь не годится по объёму.
/// Файл лежит в контейнере приложения (защита класса «после первой разблокировки», вне
/// бэкапов) и стирается при выходе из аккаунта через clear().
enum SecretOutbox {

    /// Одно ждущее сообщение.
    struct Entry: Codable, Equatable, Identifiable {
        /// Временный id оптимистичного пузыря в ленте (с `pendingIdPrefix`): по нему flush
        /// снимает пузырь, подставляя на его место настоящее серверное сообщение.
        let id: String
        /// Итоговый msgId для secret/messages/push. Фиксируется ЗАРАНЕЕ и переживает
        /// перезапуск, поэтому повтор после потерянного ответа сервера идемпотентен
        /// (тот же id = no-op), а не создаёт второе сообщение.
        let msgId: String
        let text: String
        let createdAtMs: Int64
    }

    /// Префикс временных id — по нему лента отличает «ждёт ключ» от отправленного.
    static let pendingIdPrefix = "secret-pending-"

    static func isPending(_ messageId: String) -> Bool {
        messageId.hasPrefix(pendingIdPrefix)
    }

    /// Возраст, после которого досылать уже неприлично (неделю назад набранный текст
    /// вывалился бы в чат без всякого контекста). Отсекается при чтении с диска.
    private static let maxAgeMs: Int64 = 7 * 24 * 60 * 60 * 1000
    /// Потолок на беседу: очередь — страховка, а не способ вести переписку без ключа.
    private static let maxPerConversation = 100

    // Под замком, а не под @MainActor: clear() зовётся из общего clearLocalData(),
    // который живёт вне главного актора (выход из аккаунта).
    private static let store = Mutex<[String: [Entry]]>(readDisk())

    /// Поставить текст в очередь беседы. Возвращает запись — вызывающий рисует по ней
    /// оптимистичный пузырь с тем же id.
    @discardableResult
    static func add(_ conversationId: String, text: String) -> Entry {
        let entry = Entry(
            id: pendingIdPrefix + UUID().uuidString.lowercased(),
            msgId: UUID().uuidString.lowercased(),
            text: text,
            createdAtMs: Int64(Date().timeIntervalSince1970 * 1000)
        )
        store.withLock { map in
            // Заодно выкидываем беседы, чья очередь давно просрочена: без этого чистка
            // по возрасту случалась только при чтении с диска, то есть на долгоживущем
            // процессе память росла бы бесконечно.
            let cutoff = Int64(Date().timeIntervalSince1970 * 1000) - maxAgeMs
            for (key, list) in map where key != conversationId {
                let kept = list.filter { $0.createdAtMs >= cutoff }
                if kept.isEmpty {
                    map.removeValue(forKey: key)
                } else if kept.count != list.count {
                    map[key] = kept
                }
            }
            var list = map[conversationId] ?? []
            list.append(entry)
            if list.count > maxPerConversation {
                list.removeFirst(list.count - maxPerConversation)
            }
            map[conversationId] = list
            scheduleWrite(map)
        }
        return entry
    }

    /// Всё ждущее по беседе, в порядке набора — flush отправляет именно в этом порядке.
    static func all(_ conversationId: String) -> [Entry] {
        store.withLock { $0[conversationId] ?? [] }
    }

    static func count(_ conversationId: String) -> Int {
        store.withLock { $0[conversationId]?.count ?? 0 }
    }

    /// Отправлено — снимаем запись. Ключ беседы удаляем вместе с последней записью,
    /// иначе файл копил бы пустые массивы по всем когда-либо открытым секреткам.
    static func remove(_ conversationId: String, id: String) {
        store.withLock { map in
            guard var list = map[conversationId] else { return }
            let before = list.count
            list.removeAll { $0.id == id }
            guard list.count != before else { return }
            if list.isEmpty {
                map.removeValue(forKey: conversationId)
            } else {
                map[conversationId] = list
            }
            scheduleWrite(map)
        }
    }

    /// Беседы больше нет (секретка закрыта/приглашение отклонено) — досылать некуда.
    static func clear(_ conversationId: String) {
        store.withLock { map in
            guard map.removeValue(forKey: conversationId) != nil else { return }
            scheduleWrite(map)
        }
    }

    /// Выход из аккаунта: чужой неотправленный текст новому владельцу сессии не достаётся.
    static func clear() {
        store.withLock { map in
            map.removeAll()
            // Номер двигаем и здесь: снимки, уже стоящие в очереди на запись, обязаны
            // устареть — иначе один из них вернул бы стёртую очередь на диск.
            bumpGeneration()
        }
        // Единственная синхронная запись: после выхода из аккаунта файла на диске быть
        // не должно ДАЖЕ если процесс сейчас же убьют, а удаление пустого файла дешёвое.
        diskQueue.sync { writeDisk([:]) }
    }

    // MARK: - Диск

    private static let fileURL: URL = {
        let fm = FileManager.default
        // Application Support, а не Caches: систему не должно тянуть вычистить ещё не
        // отправленный текст под давлением места.
        let base = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? fm.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        try? fm.createDirectory(at: base, withIntermediateDirectories: true)
        return base.appendingPathComponent("secret-outbox.json")
    }()

    private static func readDisk() -> [String: [Entry]] {
        guard let data = try? Data(contentsOf: fileURL),
              let decoded = try? JSONDecoder().decode([String: [Entry]].self, from: data)
        else { return [:] }
        let cutoff = Int64(Date().timeIntervalSince1970 * 1000) - maxAgeMs
        var fresh: [String: [Entry]] = [:]
        for (conversationId, list) in decoded {
            let kept = list.filter { $0.createdAtMs >= cutoff }
            if !kept.isEmpty { fresh[conversationId] = kept }
        }
        return fresh
    }

    /// Отдельная последовательная очередь: досыл снимает записи по одной, и запись файла
    /// под замком на главном потоке означала бы сериализацию json на каждое сообщение
    /// очереди — то есть подтормаживание ленты ровно в момент отправки.
    private static let diskQueue = DispatchQueue(label: "org.eblusha.secret-outbox")
    /// Номер последнего изменения памяти: на диск едет только актуальный снимок, а
    /// промежуточные (пачка из десятков remove подряд) отбрасываются, не кодируясь.
    private static let diskGeneration = Mutex(0)

    /// Зовётся ТОЛЬКО под замком store: снимок и его номер обязаны быть согласованы,
    /// иначе гонка двух мутаций записала бы на диск более старое состояние.
    private static func scheduleWrite(_ map: [String: [Entry]]) {
        let generation = bumpGeneration()
        diskQueue.async {
            // Пока снимок ждал очереди, память успела измениться ещё раз — пишет последний.
            // Замок store здесь НЕ берём сознательно: запись на диск не должна от него
            // зависеть, иначе синхронное сохранение при выходе встало бы в клинч.
            guard diskGeneration.withLock({ (value: inout Int) -> Int in value }) == generation else { return }
            writeDisk(map)
        }
    }

    @discardableResult
    private static func bumpGeneration() -> Int {
        diskGeneration.withLock { (value: inout Int) -> Int in
            value += 1
            return value
        }
    }

    /// Зовётся ТОЛЬКО с diskQueue: файл обязан совпадать с памятью, а последовательная
    /// очередь ещё и упорядочивает конкурентные сохранения.
    private static func writeDisk(_ map: [String: [Entry]]) {
        if map.isEmpty {
            try? FileManager.default.removeItem(at: fileURL)
            return
        }
        guard let data = try? JSONEncoder().encode(map) else { return }
        // .atomic: обрыв процесса на полуслове не оставит битый json, из которого
        // потерялась бы ВСЯ очередь, а не одна запись. Класс защиты — умолчание контейнера
        // (нечитаем до первой разблокировки после перезагрузки), отдельно его не режем.
        try? data.write(to: fileURL, options: [.atomic])
        // Текст секретного чата не должен уезжать в iCloud/iTunes-бэкап. Флаг ставится на
        // существующий файл, поэтому — после записи, а не при вычислении пути.
        var url = fileURL
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? url.setResourceValues(values)
    }
}
