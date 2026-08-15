import Foundation
import Combine
import AVFoundation
import AudioToolbox
import UIKit
import LiveKit

/// Порт `feature/call/CallManager.kt`.
///
/// Координирует сигналинг звонка (Socket.IO) с медиакомнатой LiveKit. Единственный
/// экземпляр владеет активным звонком. Голос — прежде всего: микрофон публикуется
/// сразу; видео присоединяется позже.
///
/// Отличия платформы (семантика сохранена 1:1):
///  - вместо StateFlow<CallState> — @Published-свойства + плоский enum CallPhase;
///  - вместо IncomingCallService — CallRinger (AVAudioPlayer + системная вибрация);
///  - вместо OngoingCallService — аудиосессия .playAndRecord/.voiceChat и фоновый
///    режим audio из Info.plist: звук живёт со свёрнутым приложением без сервиса;
///  - вместо audioswitch — маршрутами владеет AVAudioSession (override на динамик);
///  - вместо ChatDao — кеш бесед ChatRepository.conversationMeta().
final class CallManager: NSObject, ObservableObject {

    // MARK: - Published-состояние для UI

    /// Фаза звонка (порт CallState; .connecting/.inCall — Active(connecting: true/false)).
    @Published private(set) var phase: CallPhase = .idle
    /// Беседа активного/входящего/исходящего звонка.
    @Published private(set) var conversationId: String?
    /// Заголовок звонка: имя звонящего (входящий) или название беседы (исходящий/активный).
    @Published private(set) var title: String = ""
    /// Аватар собеседника 1:1 для карточки звонка; у групп nil.
    @Published private(set) var avatarUrl: String?
    /// Видеозвонок ли это (флаг из invite/incoming; НЕ равен «камера включена»).
    @Published private(set) var isVideoCall = false
    @Published private(set) var micOn = true
    @Published private(set) var cameraOn = false
    @Published private(set) var speakerOn = false
    @Published private(set) var participants: [CallParticipant] = []
    @Published private(set) var e2eeEnabled = false
    /// Выбранная камера (deviceId); nil — по умолчанию (фронтальная LiveKit).
    @Published private(set) var selectedCameraId: String?
    /// Момент перехода в разговор — для таймера длительности в UI и свёрнутой полоске.
    @Published private(set) var activeSince: Date?

    // ---- Свёрнутый звонок -----------------------------------------------------------
    // Звонок можно убрать в компактную полоску над любым экраном (как на ПК): разговор
    // продолжается, а пользователь ходит по чатам. Полный оверлей возвращается тапом
    // или вытягиванием полоски вниз.
    @Published private(set) var minimized = false

    /// Прогресс шторки 0..1: 0 — полный оверлей, 1 — звонок свёрнут в шапку чата.
    /// Пишется жестом в оверлее звонка; шапка чата читает его, чтобы подсветка
    /// проявлялась СИНХРОННО с тем, как оверлей уезжает вверх и растворяется.
    @Published private(set) var minimizeProgress: Double = 0

    /// Интерактивное вытягивание оверлея из шапки пальцем: оверлей монтируется
    /// невидимым, но авто-анимацию разворота НЕ запускаем — прогрессом рулит жест
    /// в экране чата. Пока флаг поднят, шапка продолжает показывать «Идёт звонок»
    /// и язычок, чтобы узел с активным жестом не исчез из-под пальца.
    @Published private(set) var expandDragActive = false

    /// Живая медиакомната — наружу, чтобы видеорендеры могли привязаться к её трекам.
    var activeRoom: Room? { room }

    // MARK: - Зависимости и внутреннее состояние

    private let realtime: RealtimeClient
    private let liveKit: LiveKitRepository
    private let session: SessionStore
    private let chatRepository: ChatRepository

    private var cancellables = Set<AnyCancellable>()

    private var room: Room?
    private var autoHangupTask: Task<Void, Never>?
    private var pingTask: Task<Void, Never>?
    private var speakerSyncTask: Task<Void, Never>?

    // Задержка, интероперабельная с data-channel-протоколом веба `eb.ping`.
    private var localRttMs: Int?
    private var remotePing: [String: RemotePing] = [:] // identity -> его рассылка

    private var isVideo: Bool { isVideoCall }
    private var hadRemote = false

    // Выбор камеры (фронтальная / задняя / конкретный задний объектив).
    // Список статичен для устройства → кешируем.
    private var activeCameraId: String?
    private var cameraCache: [CameraOption]?

    // Видео включается само ТОЛЬКО когда мы начали видеозвонок или приняли
    // «с видео» — никогда по умолчанию.
    private var startCameraOn = false
    // Аватар собеседника (1:1) из локального кеша бесед; заполняет UI звонка + чужую плитку.
    private var peerAvatarUrl: String?

    private let ringer = CallRinger()
    private var proximityObserver: NSObjectProtocol?
    private var speakerBeforeEar: Bool?

    init(
        realtime: RealtimeClient,
        liveKit: LiveKitRepository,
        session: SessionStore,
        chatRepository: ChatRepository
    ) {
        self.realtime = realtime
        self.liveKit = liveKit
        self.session = session
        self.chatRepository = chatRepository
        super.init()

        realtime.events
            .receive(on: DispatchQueue.main)
            .sink { [weak self] event in self?.handleRealtimeEvent(event) }
            .store(in: &cancellables)

        // Порт вызова onAppBackgrounded() из MainActivity: подписка здесь, чтобы
        // общие файлы (RootView) не пришлось трогать.
        AppLifecycle.shared.$isForeground
            .removeDuplicates()
            .receive(on: DispatchQueue.main)
            .sink { [weak self] foreground in
                if !foreground { self?.onAppBackgrounded() }
            }
            .store(in: &cancellables)
    }

    // MARK: - События реального времени

    private func handleRealtimeEvent(_ event: RealtimeEvent) {
        switch event {
        case .callIncoming(let cid, _, let fromName, let video):
            onIncoming(conversationId: cid, fromName: fromName, video: video)
        case .callAccepted(let cid, let byUserId, _):
            onAccepted(conversationId: cid, byUserId: byUserId)
        case .callDeclined(let cid, let byUserId):
            onDeclined(conversationId: cid, byUserId: byUserId)
        case .callEnded(let cid, _):
            if conversationId == cid { endLocally() }
        case .socketReconnected:
            // Реконнект чат-сокета посреди звонка: сервер уже выкинул наш старый
            // сокет из комнаты звонка и через 15 секунд завершит её, если не
            // заявиться заново. Из-за отсутствия этого re-join живой звонок
            // умирал ровно через минуту с «Звонок продлился…».
            if phase.isActive, let cid = conversationId {
                realtime.joinCallRoom(conversationId: cid, video: isVideo)
            }
        default:
            break
        }
    }

    // MARK: - Разрешения

    func hasAudioPermission() -> Bool {
        AVAudioApplication.shared.recordPermission == .granted
    }

    private func hasCameraPermission() -> Bool {
        AVCaptureDevice.authorizationStatus(for: .video) == .authorized
    }

    // В Kotlin разрешения запрашивал экран; здесь ядро добирает их само перед
    // публикацией треков — UI-слою не нужно успевать раньше подключения комнаты.
    private func requestAudioPermission() async -> Bool {
        if hasAudioPermission() { return true }
        return await AVAudioApplication.requestRecordPermission()
    }

    private func requestCameraPermission() async -> Bool {
        if hasCameraPermission() { return true }
        return await AVCaptureDevice.requestAccess(for: .video)
    }

    // MARK: - Публичные действия

    func startOutgoing(conversationId: String, title: String, video: Bool) {
        guard phase == .idle else { return }
        self.conversationId = conversationId
        self.isVideoCall = video
        self.hadRemote = false
        self.startCameraOn = video // звонок начали мы → его флаг видео решает судьбу нашей камеры
        self.title = title
        self.avatarUrl = nil
        self.micOn = true
        self.cameraOn = false
        self.speakerOn = false
        self.participants = []
        self.phase = .outgoing
        // Аудиосессию поднимаем уже на дозвоне: микрофон публикуется при подключении
        // комнаты (ещё в «Звоним…»), и без активной сессии свёрнутое приложение теряло
        // звук до принятия (роль OngoingCallService.start на Android).
        configureAudioSession()
        resolvePeerAvatar(conversationId)
        realtime.inviteCall(conversationId: conversationId, video: video)
        connectRoom(conversationId)
    }

    /// `withVideo` — пользователь нажал «принять С видео»; обычный приём оставляет камеру выключенной.
    func acceptIncoming(withVideo: Bool) {
        guard phase == .incoming, let cid = conversationId else { return }
        ringer.stop() // роль IncomingCallService.stop
        hadRemote = false
        startCameraOn = withVideo // видео на приёме НИКОГДА не включается само, только явным выбором
        realtime.acceptCall(conversationId: cid, video: isVideoCall)
        micOn = true
        cameraOn = false
        speakerOn = false
        participants = []
        phase = .connecting // порт Active(connecting = true)
        onBecameActive()
        connectRoom(cid)
    }

    func declineIncoming() {
        guard phase == .incoming, let cid = conversationId else { return }
        realtime.declineCall(conversationId: cid)
        reset()
    }

    func hangUp() {
        if let cid = conversationId {
            realtime.endCall(conversationId: cid)
            realtime.leaveCallRoom(conversationId: cid)
        }
        disconnectRoom()
        reset()
    }

    func toggleMic() {
        guard phase.isActive else { return }
        let on = !micOn
        micOn = on
        Task { @MainActor in
            _ = try? await self.room?.localParticipant.setMicrophone(enabled: on)
        }
    }

    func toggleSpeaker() {
        guard phase.isActive else { return }
        setSpeakerRoute(!speakerOn)
    }

    func toggleCamera() {
        guard phase.isActive else { return }
        let on = !cameraOn
        cameraOn = on
        Task { @MainActor in
            _ = try? await self.room?.localParticipant.setCamera(enabled: on)
            if on {
                try? await Task.sleep(nanoseconds: 350_000_000)
                await self.applySelectedCamera()
            }
            try? await Task.sleep(nanoseconds: 300_000_000)
            self.refresh()
        }
    }

    // MARK: - Выбор камеры

    /// Физические камеры на выбор (фронтальная / задняя / конкретный задний объектив).
    func availableCameras() -> [CameraOption] {
        if let cameraCache { return cameraCache }
        let list = enumerateCameras()
        cameraCache = list
        return list
    }

    /// Переключает публикуемый камерный трек на `deviceId` (включая камеру, если была выключена).
    func selectCamera(deviceId: String) {
        activeCameraId = deviceId
        guard phase.isActive else { return }
        selectedCameraId = deviceId
        cameraOn = true
        Task { @MainActor in
            if self.currentCameraTrack() == nil {
                _ = try? await self.room?.localParticipant.setCamera(enabled: true)
                try? await Task.sleep(nanoseconds: 350_000_000)
            }
            await self.applySelectedCamera()
            try? await Task.sleep(nanoseconds: 300_000_000)
            self.refresh()
        }
    }

    private func currentCameraTrack() -> LocalVideoTrack? {
        room?.localParticipant.trackPublications.values
            .first { $0.source == .camera }?
            .track as? LocalVideoTrack
    }

    /// Наводит живой камерный трек на `activeCameraId` (no-op, если не выбран или трека нет).
    private func applySelectedCamera() async {
        guard let id = activeCameraId,
              let track = currentCameraTrack(),
              let capturer = track.capturer as? CameraCapturer,
              let device = Self.captureDevice(uniqueID: id) else { return }
        _ = try? await capturer.set(options: CameraCaptureOptions(device: device))
    }

    /// На iOS тип объектива известен прямо из deviceType — вычислять поле зрения,
    /// как на Android (labelBackCameras по FOV), не нужно: смысл меток тот же.
    private func enumerateCameras() -> [CameraOption] {
        let discovery = AVCaptureDevice.DiscoverySession(
            deviceTypes: [.builtInUltraWideCamera, .builtInWideAngleCamera, .builtInTelephotoCamera],
            mediaType: .video,
            position: .unspecified
        )
        var front: [AVCaptureDevice] = []
        var back: [AVCaptureDevice] = []
        var external: [AVCaptureDevice] = []
        for device in discovery.devices {
            switch device.position {
            case .front: front.append(device)
            case .back: back.append(device)
            default: external.append(device)
            }
        }
        var out: [CameraOption] = []
        for (i, device) in front.enumerated() {
            out.append(CameraOption(
                deviceId: device.uniqueID,
                label: front.count == 1 ? "Фронтальная" : "Фронтальная \(i + 1)",
                facing: .front
            ))
        }
        out.append(contentsOf: Self.labelBackCameras(back))
        for (i, device) in external.enumerated() {
            out.append(CameraOption(
                deviceId: device.uniqueID,
                label: external.count == 1 ? "Внешняя" : "Внешняя \(i + 1)",
                facing: .external
            ))
        }
        return out
    }

    /// Имена задних объективов: широчайший — «Сверхширокая», дальше «Основная»/«Телефото».
    private static func labelBackCameras(_ devices: [AVCaptureDevice]) -> [CameraOption] {
        if devices.count <= 1 {
            return devices.map { CameraOption(deviceId: $0.uniqueID, label: "Задняя", facing: .back) }
        }
        func bucket(_ device: AVCaptureDevice) -> String {
            switch device.deviceType {
            case .builtInUltraWideCamera: return "Сверхширокая"
            case .builtInTelephotoCamera: return "Телефото"
            default: return "Основная"
            }
        }
        // Широчайшая первой — как сортировка по FOV на Android.
        func rank(_ device: AVCaptureDevice) -> Int {
            switch device.deviceType {
            case .builtInUltraWideCamera: return 0
            case .builtInTelephotoCamera: return 2
            default: return 1
            }
        }
        let sorted = devices.sorted { rank($0) < rank($1) }
        var counts: [String: Int] = [:]
        for device in sorted { counts[bucket(device), default: 0] += 1 }
        var seen: [String: Int] = [:]
        return sorted.map { device in
            let b = bucket(device)
            let label: String
            if counts[b] == 1 {
                label = b
            } else {
                let n = (seen[b] ?? 0) + 1
                seen[b] = n
                label = "\(b) \(n)"
            }
            return CameraOption(deviceId: device.uniqueID, label: label, facing: .back)
        }
    }

    private static func captureDevice(uniqueID: String) -> AVCaptureDevice? {
        AVCaptureDevice.DiscoverySession(
            deviceTypes: [.builtInUltraWideCamera, .builtInWideAngleCamera, .builtInTelephotoCamera],
            mediaType: .video,
            position: .unspecified
        ).devices.first { $0.uniqueID == uniqueID }
    }

    // MARK: - Свёрнутый звонок

    func minimize() {
        if phase.isActive || phase == .outgoing {
            minimized = true
            minimizeProgress = 1
        }
    }

    func expand() {
        // Прогресс НЕ сбрасываем: оверлей монтируется невидимым (1.0) и сам
        // анимирует шторку вниз до полного — см. появление экрана звонка.
        minimized = false
    }

    func setMinimizeProgress(_ value: Double) {
        minimizeProgress = min(1, max(0, value))
    }

    func beginInteractiveExpand() {
        if phase.isActive || phase == .outgoing {
            expandDragActive = true
            minimized = false
        }
    }

    func endInteractiveExpand() {
        expandDragActive = false
    }

    // MARK: - Входящие

    /// Звонок пришёл ПУШЕМ — приложение было выгружено, сокета нет.
    ///
    /// Состояние надо посеять до показа экрана: кнопка «Принять» уходит в
    /// `acceptIncoming`, а тот выходит молча, если фаза не incoming. Дальше
    /// подключение сокета догонит настоящее событие call:incoming — повтор
    /// безопасен, onIncoming отсеивает не-idle.
    func onPushIncoming(conversationId: String, callerName: String, video: Bool, avatarUrl: String?) {
        guard phase == .idle else { return }
        self.conversationId = conversationId
        peerAvatarUrl = avatarUrl
        title = callerName
        isVideoCall = video
        self.avatarUrl = avatarUrl
        phase = .incoming
    }

    private func onIncoming(conversationId cid: String, fromName: String, video: Bool) {
        guard phase == .idle else { return }
        // БЕЗ этого события конца звонка игнорировались: их обработчики сверяют
        // conversationId, а он выставлялся только при исходящем/принятии. Отменённый
        // звонящим (call:ended) или принятый на другом моём устройстве звонок
        // продолжал звонить здесь до бесконечности.
        conversationId = cid
        let callerName = fromName.isEmpty ? "Входящий звонок" : fromName
        // Полноэкранный UI поднимаем мгновенно; аватар доедет тактом позже (чтение кеша).
        title = callerName
        isVideoCall = video
        avatarUrl = nil
        phase = .incoming
        Task { @MainActor in
            let conv = await self.chatRepository.conversationMeta(cid)
            let avatar = (conv?.isGroup == false)
                ? conv?.avatarUrl.flatMap { $0.isEmpty ? nil : $0 }
                : nil
            self.peerAvatarUrl = avatar
            if self.phase == .incoming, self.conversationId == cid {
                self.avatarUrl = avatar
            }
            // После асинхронного чтения кеша звонок мог уже погаснуть (события приходят
            // пачкой после реконнекта: incoming и сразу ended/accepted). Запускать
            // рингер по погашенному звонку нельзя — он остался бы звонить навсегда:
            // endLocally уже отработал, и стирать его больше некому.
            guard self.phase == .incoming, self.conversationId == cid else { return }
            self.ringer.start() // роль IncomingCallService: рингтон + вибрация
        }
    }

    private func onAccepted(conversationId cid: String, byUserId: String) {
        // Звонок принят на ДРУГОМ моём устройстве (сервер рассылает call:accepted и
        // остальным устройствам принявшего) — этот рингер обязан замолчать.
        if phase == .incoming {
            if conversationId == cid && byUserId == session.currentUserId() {
                endLocally()
            }
            return
        }
        guard phase == .outgoing, conversationId == cid else { return }
        micOn = true
        cameraOn = false
        speakerOn = false
        participants = buildParticipants()
        phase = (room == nil) ? .connecting : .inCall // порт Active(connecting = room == null)
        onBecameActive()
    }

    private func onDeclined(conversationId cid: String, byUserId: String) {
        if phase == .incoming {
            // Пока звонок ВХОДЯЩИЙ, decline гасит его только когда отклонил
            // Я САМ на другом своём устройстве. Чужой decline (участник
            // группы отказался) моего рингера не касается.
            if conversationId == cid && byUserId == session.currentUserId() {
                endLocally()
            }
        } else if conversationId == cid || phase == .outgoing {
            // Исходящий/активный: в 1:1 decline собеседника честно завершает
            // звонок. В ГРУППЕ отказ одного участника не повод бросать
            // остальных — гасим только свой собственный decline.
            Task { @MainActor in
                let isGroup = await self.chatRepository.conversationMeta(cid)?.isGroup == true
                if !isGroup || byUserId == self.session.currentUserId() {
                    if self.conversationId == cid || self.phase == .outgoing {
                        self.endLocally()
                    }
                }
            }
        }
    }

    /// Подтягивает аватар собеседника 1:1 из кеша бесед → в UI звонка и на чужую плитку.
    private func resolvePeerAvatar(_ cid: String) {
        Task { @MainActor in
            let conv = await self.chatRepository.conversationMeta(cid)
            let avatar = (conv?.isGroup == false)
                ? conv?.avatarUrl.flatMap { $0.isEmpty ? nil : $0 }
                : nil
            self.peerAvatarUrl = avatar
            switch self.phase {
            case .incoming, .outgoing:
                if self.conversationId == cid { self.avatarUrl = avatar }
            case .connecting, .inCall:
                self.refresh()
            case .idle:
                break
            }
        }
    }

    // MARK: - Комната LiveKit

    private func connectRoom(_ cid: String) {
        Task { @MainActor in
            switch await self.liveKit.fetchToken(conversationId: cid) {
            case .failure:
                self.endLocally()
            case .success(let token):
                // 1:1-звонки используют LiveKit E2EE (веб его требует); группам сервер вернёт nil.
                let e2eeKey = await self.liveKit.fetchE2eeKey(conversationId: cid)
                // Пока ходили за токеном и ключом, звонок могли отклонить/отменить.
                // Без проверки здесь собиралась «зомби-комната»: состояние уже Idle,
                // а Room подключался и ПУБЛИКОВАЛ МИКРОФОН без всякого UI.
                if self.conversationId != cid || self.phase == .idle {
                    NSLog("CallManager: звонок завершился во время подключения — комнату не собираем")
                    return
                }
                self.e2eeEnabled = e2eeKey != nil
                let r = Room(delegate: self, roomOptions: self.buildRoomOptions(e2eeKeyBase64: e2eeKey))
                self.room = r
                do {
                    try await r.connect(url: token.url, token: token.token)
                } catch {
                    // Молча умирать нельзя: это единственное место, где видно,
                    // ПОЧЕМУ звонок не собрался (сеть/токен/TLS).
                    NSLog("CallManager: room connect failed %@: %@", token.url, String(describing: error))
                    self.endLocally()
                }
            }
        }
    }

    /// Групповой звонок: комната подключена — звонок ИДЁТ, даже если в ней пока никто,
    /// кроме нас (первый вошедший). call:accepted для групп никто не шлёт, поэтому без
    /// этого перехода экран застревал в «Звоним…» навсегда при живом соединении.
    /// 1:1 не трогаем: там «Звоним…» честно ждёт call:accepted от собеседника.
    private func promoteGroupOutgoingToActive() {
        guard phase == .outgoing, let cid = conversationId else { return }
        Task { @MainActor in
            let isGroup = await self.chatRepository.conversationMeta(cid)?.isGroup == true
            guard isGroup else { return }
            // Структурная проверка, не ссылочная: пока ждали кеш, важен лишь факт
            // «мы всё ещё дозваниваемся в ту же беседу».
            guard self.phase == .outgoing, self.conversationId == cid else { return }
            self.micOn = true
            self.cameraOn = false
            self.speakerOn = false
            self.participants = self.buildParticipants()
            self.phase = .inCall
            self.onBecameActive()
        }
    }

    /// Настраивает E2EE 1:1 для интеропа с вебом. Нативный libwebrtc FrameCryptor
    /// выводит AES-ключ через PBKDF2(passphrase, salt="LKFrameEncryptionKey", 100000,
    /// SHA-256) — НЕ HKDF. Веб интеропится только когда его ExternalE2EEKeyProvider
    /// тоже идёт путём PBKDF2, а так происходит, когда `setKey` получает СТРОКУ
    /// (с буфером он взял бы HKDF → разные ключи → DECRYPTIONFAILED). Поэтому обе
    /// стороны прогоняют через PBKDF2 одну и ту же base64-строку-пароль: здесь через
    /// `setKey(key: String)` (UTF-8 → PBKDF2), на вебе через `setKey(string)`.
    /// Индекс 0 совпадает с вебом (отправитель шифрует последним индексом ключа,
    /// а веб держит только индекс 0).
    private func buildRoomOptions(e2eeKeyBase64: String?) -> RoomOptions {
        guard let e2eeKeyBase64 else { return RoomOptions() }
        let key = e2eeKeyBase64.trimmed()
        // Сверяем, что сервер вернул ожидаемый 32-байтовый ключ (паролем для криптора
        // служит сама base64-СТРОКА, не эти раскодированные байты).
        guard let decoded = Data(base64Encoded: key), decoded.count == 32 else {
            NSLog("CallE2EE: неожиданный e2ee-ключ — комната без E2EE")
            return RoomOptions()
        }
        let keyProvider = BaseKeyProvider(isSharedKey: true)
        keyProvider.setKey(key: key)
        NSLog("CallE2EE: общий E2EE-пароль установлен (PBKDF2)")
        return RoomOptions(e2eeOptions: E2EEOptions(keyProvider: keyProvider))
    }

    private func enableLocalTracks() {
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 400_000_000)
            guard let local = self.room?.localParticipant else { return }
            if await self.requestAudioPermission() {
                _ = try? await local.setMicrophone(enabled: true)
                // Статистику публикации (RTT для eb.ping) стримит сам трек — подписываемся.
                local.trackPublications.values
                    .first { $0.source == .microphone }?
                    .track?.add(delegate: self)
            }
            // Камера включается сама ТОЛЬКО когда мы начали видеозвонок или приняли
            // «с видео» — никогда по умолчанию. (&& не пускает await в автоклаужер.)
            var cameraEnabled = false
            if self.startCameraOn {
                cameraEnabled = await self.requestCameraPermission()
            }
            if cameraEnabled {
                _ = try? await local.setCamera(enabled: true)
                try? await Task.sleep(nanoseconds: 350_000_000)
                await self.applySelectedCamera() // уважаем заранее выбранную камеру; иначе no-op (фронтальная)
            }
            if self.phase.isActive { self.cameraOn = cameraEnabled }
            try? await Task.sleep(nanoseconds: 600_000_000)
            self.refresh()
        }
    }

    private func refresh() {
        // Порт refresh(): только для Active-состояния; connecting=false → .inCall.
        guard phase.isActive else { return }
        phase = .inCall
        participants = buildParticipants()
        selectedCameraId = activeCameraId
    }

    private func buildParticipants() -> [CallParticipant] {
        guard let room else { return [] }
        var list = [makeParticipant(room.localParticipant, isLocal: true)]
        for participant in room.remoteParticipants.values {
            list.append(makeParticipant(participant, isLocal: false))
        }
        return list
    }

    private func maybeAutoHangup() {
        guard hadRemote else { return }
        if (room?.remoteParticipants.count ?? 0) > 0 { return }
        autoHangupTask?.cancel()
        autoHangupTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            if Task.isCancelled { return }
            if (self.room?.remoteParticipants.count ?? 0) == 0 { self.hangUp() }
        }
    }

    // MARK: - Задержка (интероп с веб-`eb.ping`)

    private struct RemotePing {
        let rtt: Int
        let playoutMs: Int
    }

    private func startPingLoop() {
        pingTask?.cancel()
        pingTask = Task { @MainActor in
            while !Task.isCancelled {
                // RTT приезжает асинхронно из статистики трека (TrackDelegate) — даём
                // ей осесть перед рассылкой, как на Android после запроса webrtc-статистики.
                try? await Task.sleep(nanoseconds: 350_000_000)
                if Task.isCancelled { return }
                await self.broadcastPing()
                self.refresh() // свежие цифры пинга — на плитки
                try? await Task.sleep(nanoseconds: 2_000_000_000)
            }
        }
    }

    /// Рассылает наш RTT по топику `eb.ping`, чтобы веб/собеседники видели нашу задержку.
    private func broadcastPing() async {
        guard let rtt = localRttMs, let room else { return }
        let payload: [String: Any] = [
            "t": "eb.ping", "v": 2,
            "rtt": rtt, "playoutMs": 0,
            "from": room.localParticipant.identity?.stringValue ?? "",
            "ts": Int64(Date().timeIntervalSince1970 * 1000),
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: payload) else { return }
        try? await room.localParticipant.publish(
            data: data,
            options: DataPublishOptions(topic: "eb.ping", reliable: false)
        )
    }

    private func onPingData(_ data: Data, topic: String, participant: RemoteParticipant?) {
        // LiveKit ненадёжно заполняет topic на приёме (у веба та же пометка), поэтому
        // отсекаем только когда topic ЕСТЬ и он не наш — иначе проваливаемся дальше и
        // верим дискриминатору `t` в самом payload.
        if !topic.isEmpty && topic != "eb.ping" { return }
        guard let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              obj["t"] as? String == "eb.ping" else { return }
        let rtt = (obj["rtt"] as? NSNumber)?.intValue ?? 0
        guard rtt > 0 else { return }
        // eb.ping часто приходит с participant == nil, а веб-payload не несёт identity
        // отправителя. Резолвим: явная identity → своё поле `from` → единственный
        // удалённый участник (покрывает 1:1 — основной случай). Групповому пингу нужна
        // identity в payload — это будущая правка на стороне веба.
        let from = (obj["from"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        let soleRemote = (room?.remoteParticipants.count == 1)
            ? room?.remoteParticipants.values.first?.identity?.stringValue
            : nil
        guard let identity = participant?.identity?.stringValue ?? from ?? soleRemote else { return }
        let playout = max(0, (obj["playoutMs"] as? NSNumber)?.intValue ?? 0)
        remotePing[identity] = RemotePing(rtt: rtt, playoutMs: playout)
        refresh() // сразу вывести свежий чужой пинг на плитку
    }

    // MARK: - Участники

    private func makeParticipant(_ p: Participant, isLocal: Bool) -> CallParticipant {
        let meta = Self.parseMetadata(p.metadata)
        func metaString(_ key: String) -> String? {
            (meta?[key] as? String).flatMap { $0.isEmpty ? nil : $0 }
        }
        let resolvedName = metaString("displayName")
            ?? ((p.name?.isEmpty == false) ? p.name : nil)
            ?? p.identity?.stringValue
            ?? (isLocal ? "Я" : "Участник")
        // Чужой аватар: сперва метаданные самого участника, иначе аватар собеседника 1:1.
        let avatar = metaString("avatarUrl")
            ?? (isLocal ? session.currentUser()?.avatarUrl : peerAvatarUrl)
        let videoTrack = Self.findVideoTrack(p, isLocal: isLocal)
        // Локально — наш замер RTT; удалённо — веб-оценка в одну сторону
        // (среднее двух RTT + их playout).
        let pingMs: Int?
        if isLocal {
            pingMs = localRttMs
        } else {
            let rp = p.identity.flatMap { remotePing[$0.stringValue] }
            if let rp, let local = localRttMs {
                pingMs = (rp.rtt + local) / 2 + rp.playoutMs
            } else if let rp {
                pingMs = rp.rtt + rp.playoutMs
            } else {
                pingMs = nil
            }
        }
        let screenPub = Self.screenSharePublication(p)
        // Identity = "<userId>#<deviceSuffix>" (веб-комментарий в CallOverlay); метаданные надёжнее.
        let userId = metaString("userId")
            ?? p.identity?.stringValue.components(separatedBy: "#").first.flatMap { $0.isEmpty ? nil : $0 }
        let micPub = p.trackPublications.values.first { $0.source == .microphone }
        return CallParticipant(
            id: p.identity?.stringValue ?? p.sid?.stringValue ?? "",
            userId: userId,
            name: resolvedName,
            avatarUrl: avatar,
            isLocal: isLocal,
            muted: micPub == nil || micPub!.isMuted,
            speaking: p.isSpeaking,
            hasVideo: videoTrack != nil,
            videoTrack: videoTrack,
            connectionQuality: p.connectionQuality,
            pingMs: pingMs,
            isScreenSharing: screenPub != nil && !screenPub!.isMuted
        )
    }

    private static func findVideoTrack(_ p: Participant, isLocal: Bool) -> VideoTrack? {
        // Активная демонстрация экрана важнее камеры.
        if let screen = screenSharePublication(p), !screen.isMuted,
           let track = screen.track as? VideoTrack {
            return track
        }
        if isLocal {
            guard let cam = p.trackPublications.values.first(where: { $0.source == .camera }),
                  !cam.isMuted else { return nil }
            return cam.track as? VideoTrack
        }
        // Выключенная удалённая камера остаётся опубликованной-но-заглушённой — считаем
        // это «нет видео», чтобы плитка показывала аватар (и авто-прожектор ушёл
        // единственной оставшейся камере).
        return p.trackPublications.values
            .first { $0.kind == .video && !$0.isMuted }?
            .track as? VideoTrack
    }

    private static func screenSharePublication(_ p: Participant) -> TrackPublication? {
        p.trackPublications.values.first { $0.source == .screenShareVideo }
    }

    private static func parseMetadata(_ raw: String?) -> [String: Any]? {
        guard let raw, let data = raw.data(using: .utf8) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    // MARK: - Завершение

    private func disconnectRoom() {
        autoHangupTask?.cancel(); autoHangupTask = nil
        pingTask?.cancel(); pingTask = nil
        localRttMs = nil
        remotePing.removeAll()
        activeCameraId = nil
        startCameraOn = false
        peerAvatarUrl = nil
        if let r = room {
            // room зануляем ДО асинхронного disconnect: иначе didDisconnectWithError
            // этой же комнаты снова позвал бы endLocally по уже мёртвому звонку.
            room = nil
            Task { await r.disconnect() }
        }
    }

    /// Завершает звонок локально (собеседник завершил/отклонил, сбой подключения
    /// или отвал комнаты).
    private func endLocally() {
        if phase == .idle { return }
        if let cid = conversationId { realtime.leaveCallRoom(conversationId: cid) }
        disconnectRoom()
        reset()
    }

    /// Единая точка входа в разговор: таймер полоски + аудиосессия разговора
    /// (роль OngoingCallService на Android; здесь звук в фоне держит режим audio).
    private func onBecameActive() {
        if activeSince == nil { activeSince = Date() }
        configureAudioSession()
        enableProximity()
        syncSpeakerState()
    }

    private func reset() {
        ringer.stop() // роль IncomingCallService.stop
        disableProximity()
        activeSince = nil
        minimized = false
        minimizeProgress = 0
        expandDragActive = false
        autoHangupTask?.cancel(); autoHangupTask = nil
        pingTask?.cancel(); pingTask = nil
        localRttMs = nil
        remotePing.removeAll()
        activeCameraId = nil
        selectedCameraId = nil
        startCameraOn = false
        peerAvatarUrl = nil
        room = nil
        conversationId = nil
        isVideoCall = false
        hadRemote = false
        e2eeEnabled = false
        micOn = true
        cameraOn = false
        speakerOn = false
        participants = []
        title = ""
        avatarUrl = nil
        phase = .idle
        // Роль OngoingCallService.stop: разговор кончился — отпускаем аудиосессию,
        // возвращая звук другим приложениям.
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    // MARK: - Аудиосессия и маршрут звука

    /// Сессия разговора: .playAndRecord + .voiceChat (эхоподавление, разговорный
    /// динамик по умолчанию), BT-гарнитуры разрешены.
    private func configureAudioSession() {
        let audioSession = AVAudioSession.sharedInstance()
        do {
            try audioSession.setCategory(
                .playAndRecord,
                mode: .voiceChat,
                options: [.allowBluetooth, .allowBluetoothA2DP]
            )
            try audioSession.setActive(true)
        } catch {
            NSLog("CallManager: не удалось настроить аудиосессию: %@", String(describing: error))
        }
    }

    /// Куда реально играет звук: спрашиваем текущий маршрут AVAudioSession, а не state.
    private func currentRouteIsSpeaker() -> Bool {
        AVAudioSession.sharedInstance().currentRoute.outputs
            .contains { $0.portType == .builtInSpeaker }
    }

    /// Смотрим АКТИВНЫЙ маршрут разговора, а не «что вообще спарено»: почти у всех
    /// спарены BT-наушники (A2DP для музыки), и проверка «в списке есть гарнитура»
    /// глушила бы датчик приближения вовсе, даже когда звонок идёт через сам телефон.
    private func headsetConnected() -> Bool {
        let headsetPorts: [AVAudioSession.Port] = [
            .headphones, .bluetoothHFP, .bluetoothA2DP, .bluetoothLE, .usbAudio,
        ]
        return AVAudioSession.sharedInstance().currentRoute.outputs
            .contains { headsetPorts.contains($0.portType) }
    }

    /// Маршрут звука + отражение в состоянии. ВАЖНО: на iOS маршрутом владеет
    /// AVAudioSession: override(.speaker) — аналог выбора Speakerphone в audioswitch
    /// на Android, а .none возвращает системный маршрут — гарнитуру/BT, если они
    /// подключены, иначе разговорный динамик (слепой выбор «трубки» уводил бы звук
    /// из подключённой гарнитуры).
    private func setSpeakerRoute(_ on: Bool) {
        do {
            try AVAudioSession.sharedInstance().overrideOutputAudioPort(on ? .speaker : .none)
        } catch {
            NSLog("CallManager: не удалось переключить динамик: %@", String(describing: error))
        }
        if phase.isActive { speakerOn = on }
    }

    /// Синхронизация флага speakerOn с реальностью после старта аудиосессии: система
    /// (и LiveKit) в видеозвонке может выбрать громкую сама, а state создавался
    /// с false — кнопка «динамик» первым нажатием «включала» бы уже включённое.
    private func syncSpeakerState() {
        speakerSyncTask?.cancel()
        speakerSyncTask = Task { @MainActor in
            // Ждём, пока комната (и с ней реальный маршрут звука) оживёт: на пути
            // «принял звонок» onBecameActive() случается ДО подключения комнаты,
            // и одиночная проверка через фиксированную паузу стабильно приходила
            // бы в пустоту.
            for _ in 0..<20 {
                try? await Task.sleep(nanoseconds: 400_000_000)
                if Task.isCancelled || !self.phase.isActive { return }
                guard self.room != nil else { continue }
                let speaker = self.currentRouteIsSpeaker()
                if self.speakerOn != speaker { self.speakerOn = speaker }
                // Телефон уже поднесён к уху, а маршрут ожил только сейчас —
                // догоняем: уводим звук в трубку, как того просил датчик.
                if speaker, self.speakerBeforeEar != nil {
                    self.speakerBeforeEar = true
                    self.setSpeakerRoute(false)
                }
                return
            }
        }
    }

    // MARK: - Датчик приближения
    // Классика телефонных звонков: поднёс к уху — звук уходит в разговорный динамик,
    // экран гаснет (гашением при включённом мониторинге занимается сама iOS, wakelock
    // не нужен); отодвинул — экран включается и, если была громкая связь, она
    // возвращается. При включённой камере не вмешиваемся: видеозвонок к уху не
    // прикладывают.

    private func enableProximity() {
        guard proximityObserver == nil else { return }
        UIDevice.current.isProximityMonitoringEnabled = true
        proximityObserver = NotificationCenter.default.addObserver(
            forName: UIDevice.proximityStateDidChangeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            guard let self else { return }
            let near = UIDevice.current.proximityState
            // Не вмешиваемся: без разговора, с камерой (видеозвонок к уху не подносят),
            // в свёрнутом виде (человек листает чаты с телефоном в руке) и с
            // гарнитурой (к уху с ней не прикладываются, а рвать её маршрут вредно).
            if !self.phase.isActive || self.cameraOn || self.minimized || self.headsetConnected() {
                self.onEarProximity(near: false)
                return
            }
            self.onEarProximity(near: near)
        }
    }

    private func onEarProximity(near: Bool) {
        if near && phase.isActive {
            if speakerBeforeEar == nil {
                // По ФАКТИЧЕСКОМУ маршруту, не по state: state рождался со
                // speakerOn=false, а в видеозвонке система играет через громкую —
                // ветка «на ухо» иначе не выполнялась бы никогда (экран гас,
                // звук оставался громким).
                let actuallySpeaker = currentRouteIsSpeaker()
                NSLog("CallManager: proximity near — earpiece (маршрут speaker=%d)", actuallySpeaker ? 1 : 0)
                speakerBeforeEar = actuallySpeaker
                if actuallySpeaker { setSpeakerRoute(false) }
            }
        } else {
            let wasSpeaker = speakerBeforeEar
            speakerBeforeEar = nil
            if wasSpeaker == true { setSpeakerRoute(true) }
        }
    }

    private func disableProximity() {
        if let observer = proximityObserver {
            NotificationCenter.default.removeObserver(observer)
        }
        proximityObserver = nil
        UIDevice.current.isProximityMonitoringEnabled = false
        speakerSyncTask?.cancel(); speakerSyncTask = nil
        speakerBeforeEar = nil
    }

    // MARK: - Жизненный цикл приложения

    /// Приложение ушло в фон. Камера в фоне всё равно умирает (iOS отбирает её у
    /// обычного приложения) — выключаем сами, чтобы собеседники видели честную
    /// «камера выключена», а не замёрзший кадр. Звук продолжает жить через фоновый
    /// режим audio. Обратно камеру пользователь включает сам.
    func onAppBackgrounded() {
        guard phase.isActive, cameraOn else { return }
        toggleCamera()
    }
}

// MARK: - RoomDelegate

extension CallManager: RoomDelegate {

    func roomDidConnect(_ room: Room) {
        DispatchQueue.main.async {
            guard room === self.room else { return }
            if let cid = self.conversationId {
                self.realtime.joinCallRoom(conversationId: cid, video: self.isVideoCall)
            }
            self.enableLocalTracks()
            self.startPingLoop()
            self.promoteGroupOutgoingToActive()
            self.refresh()
        }
    }

    func room(_ room: Room, didDisconnectWithError error: LiveKitError?) {
        DispatchQueue.main.async {
            guard room === self.room else { return }
            // Раньше причина глоталась молча, и любой сетевой отказ выглядел как
            // вечное «Звоним…» — отличить TURN/ICE/токен было нечем.
            NSLog("CallManager: комната отключилась: %@", String(describing: error))
            self.endLocally()
        }
    }

    func room(_ room: Room, participantDidConnect participant: RemoteParticipant) {
        DispatchQueue.main.async {
            guard room === self.room else { return }
            self.hadRemote = true
            self.refresh()
        }
    }

    func room(_ room: Room, participantDidDisconnect participant: RemoteParticipant) {
        DispatchQueue.main.async {
            guard room === self.room else { return }
            self.refresh()
            self.maybeAutoHangup()
        }
    }

    func room(
        _ room: Room, participant: RemoteParticipant?, didReceiveData data: Data,
        forTopic topic: String, encryptionType: EncryptionType
    ) {
        DispatchQueue.main.async {
            guard room === self.room else { return }
            self.onPingData(data, topic: topic, participant: participant)
        }
    }

    // Порт `else -> refresh()` из observeRoom: любое движение треков/статусов
    // пересобирает список участников.

    func room(_ room: Room, participant: RemoteParticipant, didSubscribeTrack publication: RemoteTrackPublication) {
        refreshOnMain(room)
    }

    func room(_ room: Room, participant: RemoteParticipant, didUnsubscribeTrack publication: RemoteTrackPublication) {
        refreshOnMain(room)
    }

    func room(_ room: Room, participant: RemoteParticipant, didPublishTrack publication: RemoteTrackPublication) {
        refreshOnMain(room)
    }

    func room(_ room: Room, participant: RemoteParticipant, didUnpublishTrack publication: RemoteTrackPublication) {
        refreshOnMain(room)
    }

    func room(_ room: Room, participant: LocalParticipant, didPublishTrack publication: LocalTrackPublication) {
        refreshOnMain(room)
    }

    func room(_ room: Room, participant: LocalParticipant, didUnpublishTrack publication: LocalTrackPublication) {
        refreshOnMain(room)
    }

    func room(_ room: Room, participant: Participant, trackPublication: TrackPublication, didUpdateIsMuted isMuted: Bool) {
        refreshOnMain(room)
    }

    func room(_ room: Room, participant: Participant, didUpdateConnectionQuality quality: ConnectionQuality) {
        refreshOnMain(room)
    }

    func room(_ room: Room, didUpdateSpeakingParticipants participants: [Participant]) {
        refreshOnMain(room)
    }

    func room(_ room: Room, participant: Participant, didUpdateMetadata metadata: String?) {
        refreshOnMain(room)
    }

    private func refreshOnMain(_ room: Room) {
        DispatchQueue.main.async {
            guard room === self.room else { return }
            self.refresh()
        }
    }
}

// MARK: - TrackDelegate (замер RTT публикации)

extension CallManager: TrackDelegate {

    /// Порт measureLocalRtt: на Android RTT читался из candidate-pair webrtc-статистики
    /// по запросу; iOS-SDK сам стримит статистику подписанному делегату — берём
    /// currentRoundTripTime candidate-pair, а если его нет — RTCP-оценку из
    /// remote-inbound-rtp нашей публикации.
    func track(_ track: Track, didUpdateStatistics statistics: TrackStatistics, simulcastStatistics: [String: TrackStatistics]) {
        let rttSeconds = statistics.iceCandidatePair.compactMap(\.currentRoundTripTime).first
            ?? statistics.remoteInboundRtpStream.compactMap(\.roundTripTime).first
        guard let rttSeconds, rttSeconds > 0 else { return }
        DispatchQueue.main.async {
            self.localRttMs = Int(rttSeconds * 1000)
        }
    }
}

// MARK: - Рингтон входящего (роль IncomingCallService)

/// Играет рингтон + вибрацию входящего звонка. Android-сервис брал системный рингтон
/// (Settings.System.DEFAULT_RINGTONE_URI); iOS доступа к системному рингтону не даёт —
/// играем файл из бандла (`incoming_call.caf|m4a|mp3|wav`), а пока он не добавлен,
/// остаётся периодическая системная вибрация.
private final class CallRinger {

    private var player: AVAudioPlayer?
    private var vibrateTimer: Timer?

    func start() {
        stop()
        // Категория playback: рингтон должен звучать из громкого динамика,
        // разговорная сессия (.playAndRecord/.voiceChat) поднимется на принятии.
        let audioSession = AVAudioSession.sharedInstance()
        try? audioSession.setCategory(.playback, mode: .default)
        try? audioSession.setActive(true)
        for ext in ["caf", "m4a", "mp3", "wav"] {
            if let url = Bundle.main.url(forResource: "incoming_call", withExtension: ext),
               let ringPlayer = try? AVAudioPlayer(contentsOf: url) {
                ringPlayer.numberOfLoops = -1 // порт isLooping = true
                ringPlayer.play()
                player = ringPlayer
                break
            }
        }
        // Android вибрирует паттерном [1000, 500] по кругу; на iOS свой паттерн задать
        // нельзя — ближайший аналог: системная вибрация, повторяемая таймером.
        AudioServicesPlaySystemSound(kSystemSoundID_Vibrate)
        vibrateTimer = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { _ in
            AudioServicesPlaySystemSound(kSystemSoundID_Vibrate)
        }
    }

    func stop() {
        player?.stop()
        player = nil
        vibrateTimer?.invalidate()
        vibrateTimer = nil
    }
}
