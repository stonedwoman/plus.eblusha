import AudioToolbox
import Foundation

/// Звуки чата: входящее сообщение и подтверждённая отправка.
///
/// Почему AudioServices, а не AVAudioPlayer: системный звук не заводит своей
/// аудиосессии — он не глушит чужую музыку, не прерывает запись голосового и не спорит
/// с сессией звонка (у CallManager она .playAndRecord/.voiceChat). Плата за это —
/// формат: AudioServices берёт CAF/AIF/WAV с PCM или IMA4 и НЕ берёт mp3, поэтому
/// веб-овский `frontend/public/notify.mp3` лежит в бандле перегнанным в
/// `Resources/notify.caf` (моно 44.1 кГц, PCM 16 бит, подрезанный хвост тишины).
///
/// Беззвучный переключатель телефона системный звук уважает сам, и своей проверки тут
/// нет и быть не может: API «в каком положении переключатель» iOS не даёт.
///
/// Правила «когда звучать» взяты у ВЕБА, а не у Telegram — для открытого чата они прямо
/// противоположны. Веб (useChatSocketSubscriptions.ts: `!isMine && (!isViewing ||
/// !visible)`) молчит, когда беседа на экране, и звучит во всех остальных случаях; у нас
/// «не видно» означает фон, а в фоне уже звучит пуш (MessageNotifications), поэтому
/// остаётся ровно одно окно: приложение на переднем плане, беседа не открыта.
@MainActor
enum ChatSounds {

    // MARK: - Настройки

    // Два независимых тумблера, как в Telegram: входящие и отправка — разные привычки,
    // в групповом чате чаще всего гасят именно входящие. Ключи наружу: настройки читают
    // их через @AppStorage, а не через это перечисление, иначе экран не перерисуется.
    static let incomingKey = "eblusha.sound.incoming"
    static let outgoingKey = "eblusha.sound.outgoing"

    /// По умолчанию звуки включены — веб-паритет (там звук входящего играет всегда).
    private static func enabled(_ key: String) -> Bool {
        UserDefaults.standard.object(forKey: key) as? Bool ?? true
    }

    // MARK: - Контекст, по которому решается «звучать ли»

    /// Беседа, открытая на экране прямо сейчас; nil — открытой беседы нет.
    /// Ставит ChatView на onAppear/onDisappear.
    private static var activeConversationId: String?

    /// Идёт запись голосового: любой щелчок попал бы в дорожку.
    private static var recording = false

    /// Последнее озвученное сообщение и когда. Сервер шлёт про одно сообщение и
    /// `message:new`, и `message:notify` — без этой пары звук был бы двойным.
    private static var lastSoundedId: String?
    private static var lastSoundedAt: TimeInterval = 0

    static func setActiveConversation(_ conversationId: String?) {
        activeConversationId = conversationId
    }

    /// Экран беседы ушёл. Именно СВОЙ id, а не голое обнуление: при переходе из чата в чат
    /// onAppear новой беседы случается раньше onDisappear старой, и обнуление стёрло бы
    /// уже открытую — она бы зазвучала сама себе.
    static func leaveConversation(_ conversationId: String) {
        guard activeConversationId == conversationId else { return }
        activeConversationId = nil
    }

    static func setRecording(_ value: Bool) {
        recording = value
    }

    // MARK: - События

    /// Пришло сообщение по сокету (из общеприложенческой подписки списка бесед).
    /// Все условия — здесь, чтобы вызывающему не приходилось их повторять.
    static func messageArrived(
        conversationId: String, messageId: String, senderId: String, currentUserId: String?
    ) {
        guard enabled(incomingKey) else { return }
        // Своё же эхо: сокет возвращает и наши отправки.
        guard senderId != currentUserId else { return }
        // В фоне и на локскрине звучит пуш — второй звук был бы эхом самого себя.
        guard AppLifecycle.shared.isForeground else { return }
        // Беседа открыта на экране: человек и так видит сообщение (правило веба).
        guard conversationId != activeConversationId else { return }
        let now = Date().timeIntervalSince1970
        guard lastSoundedId != messageId || now - lastSoundedAt > 3 else { return }
        lastSoundedId = messageId
        lastSoundedAt = now
        play(.incoming)
    }

    /// Сервер подтвердил отправку. Именно подтверждение, а не нажатие кнопки: на плохой
    /// сети звук по нажатию врал бы про то, чего ещё не случилось.
    static func messageSent() {
        guard enabled(outgoingKey) else { return }
        // Отправка могла подтвердиться, пока приложение уже в фоне (очередь дослала своё):
        // звук из кармана человеку ничего не сообщает и только пугает.
        guard AppLifecycle.shared.isForeground else { return }
        play(.outgoing)
    }

    // MARK: - Воспроизведение

    private enum Kind: String {
        case incoming
        case outgoing
    }

    /// Собственный файл и запасной СИСТЕМНЫЙ звук на случай, если файла в сборке нет.
    /// 1003 — «сообщение получено», 1004 — «сообщение отправлено»: своего свиста
    /// отправки у нас нет (в вебе его нет вовсе), а системный ровно про это и есть.
    private static func source(_ kind: Kind) -> (resource: String?, fallback: SystemSoundID) {
        switch kind {
        case .incoming: return ("notify", 1003)
        case .outgoing: return ("message-sent", 1004)
        }
    }

    /// Идентификаторы живут до конца процесса: их создание читает файл с диска, а звук
    /// играет по нескольку раз в минуту. Disposal поэтому не нужен вовсе.
    private static var loaded: [String: SystemSoundID] = [:]

    /// Очередь под сам вызов: первый разбор файла делает системный сервис синхронно, и
    /// на главном потоке это стоило бы кадра прокрутки ленты.
    private static let queue = DispatchQueue(label: "org.eblusha.chat-sounds")

    private static func play(_ kind: Kind) {
        // Запись голосового глушит звук: щелчок лёг бы в записываемое сообщение.
        // Звонок занимает динамик и микрофон в ЛЮБОЙ фазе, включая гудки и входящий
        // (там уже играет CallRinger), а не только в разговоре.
        guard !recording, AppContainer.shared.callManager.phase == .idle else { return }
        let id = soundID(kind)
        queue.async { AudioServicesPlaySystemSound(id) }
    }

    private static func soundID(_ kind: Kind) -> SystemSoundID {
        if let cached = loaded[kind.rawValue] { return cached }
        let spec = source(kind)
        var id = spec.fallback
        if let name = spec.resource,
           let url = Bundle.main.url(forResource: name, withExtension: "caf") {
            var created: SystemSoundID = 0
            // Неудача — не повод молчать: остаётся системный звук того же смысла.
            if AudioServicesCreateSystemSoundID(url as CFURL, &created) == kAudioServicesNoError {
                id = created
            }
        }
        loaded[kind.rawValue] = id
        return id
    }
}

