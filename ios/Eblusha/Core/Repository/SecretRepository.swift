import AVFoundation
import Combine
import CryptoKit
import Foundation
import UIKit

/// Порт `data/repository/SecretRepository.kt` — E2EE-движок секретных чатов (V2),
/// байт-в-байт совместимый с вебом и Android (см. SecretCrypto).
///
/// Провижининг: при первом использовании устройство генерирует X25519-идентичность +
/// пачку one-time prekeys и регистрирует их. Ключ треда — случайные 32 байта, которые
/// генерирует ТОЛЬКО СОЗДАТЕЛЬ беседы (веб-инвариант: генерация не-создателем перетёрла
/// бы настоящий ключ на всех веб-устройствах и окирпичила старые шифртексты); ключ
/// раздаётся устройствам через X25519+HKDF key-package handshake (запечатан
/// XSalsa20-Poly1305) и забирается из per-device инбокса. Сообщения — XSalsa20-Poly1305
/// под общим ключом треда, пуш идёт с явным фанаутом по устройствам-получателям, а в
/// реальном времени сигналится сокет-событием "secret:notify".
///
/// Паблишеры (PassthroughSubject — порт MutableSharedFlow) шлют из фоновых задач:
/// подписчикам UI нужен `.receive(on: DispatchQueue.main)`.
final class SecretRepository {
    private let api: APIClient
    private let devices: DevicesRepository
    private let keyStore: SecretKeyStore
    private let deviceIdProvider: DeviceIdProvider
    private let session: SessionStore

    /// Ставится извне (регистрация в AppContainer): пересобрать сокет после смены
    /// device-id (RealtimeClient.reconnectForDeviceChange). Рукопожатие сокета несёт
    /// deviceId: без переподключения сервер держал бы нас в комнате старого устройства
    /// и «secret:notify» не доходил бы.
    var onDeviceIdRotated: (() -> Void)?

    /// Расшифрованные сообщения тредов, пришедшие через инбокс (realtime-путь).
    let incoming = PassthroughSubject<DecryptedSecretMessage, Never>()

    /// threadId, чей ключ только что импортирован — сбросить очередь отправки / передешифровать.
    let keyImported = PassthroughSubject<String, Never>()

    /// Число импортированных ключей, когда связка приехала с доверенного устройства.
    let deviceLinked = PassthroughSubject<Int, Never>()

    /// Мы отдали связку ключей другому своему устройству (имя + сколько тредов).
    let deviceLinkedOut = PassthroughSubject<LinkedDevice, Never>()

    // Нерасшифровываемые key package ретраятся на каждом pull; после веб-лимитов
    // (>20 попыток или >30 мин) — poison-ack, чтобы битый конверт не заклинил инбокс.
    // Трогается ТОЛЬКО под inboxGate.
    private var poisonAttempts: [String: (attempts: Int, firstMs: Int64)] = [:]

    // syncInbox зовётся из нескольких мест (socket notify, пер-чатовый поллинг, логин,
    // путь отправки) — сериализуем: параллельные pull дважды обработали бы один
    // не-ack-нутый батч и гоняли бы poisonAttempts/импорт ключей.
    private let inboxGate = AsyncSemaphore(1)

    // Фанаут устройств-получателей по треду. Переразрешение стоило 2 ПОСЛЕДОВАТЕЛЬНЫХ
    // bundle-раундтрипа перед каждым пушем (доминирующая латентность отправки) — набор
    // меняется только при (де)регистрации устройства, так что короткий TTL +
    // инвалидация на key_request/accept достаточны.
    private let stateLock = NSLock()
    private var receiverCache: [String: (atMs: Int64, ids: [String])] = [:]
    private var lastRebootstrapMs: Int64 = 0
    private var localInvite: DeviceLinkInvite?

    // Пик расшифровки вложения = шифртекст+плейнтекст в памяти (~2× размера). Большие —
    // строго по одному, мелкие — до трёх (параллельный автодекод видимых видео-пузырей
    // иначе съедал бы сотни МБ; порт ревью Android).
    private let bigDecrypts = AsyncSemaphore(1)
    private let smallDecrypts = AsyncSemaphore(3)
    private var attFileGates: [String: AsyncSemaphore] = [:]

    /// Отдельная сессия для скачивания шифрблобов: 30-секундный лимит базового клиента
    /// тесен большим видео (таймаут — пауза без данных, как у аплоадов).
    private let downloadSession: URLSession = {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 120
        return URLSession(configuration: config)
    }()

    init(
        api: APIClient,
        devices: DevicesRepository,
        keyStore: SecretKeyStore,
        deviceIdProvider: DeviceIdProvider,
        session: SessionStore
    ) {
        self.api = api
        self.devices = devices
        self.keyStore = keyStore
        self.deviceIdProvider = deviceIdProvider
        self.session = session
    }

    // MARK: - Константы (порт companion object)

    static let lockedPlaceholder = "🔒 Сообщение зашифровано"
    static let lockedAttachment = "🔒 Вложение зашифровано"
    /// Подкаталог cachesDirectory с РАСШИФРОВАННЫМИ вложениями — чистится при logout.
    static let attCacheDir = "secret-att"
    /// QR доверенного устройства («добавить это устройство ко мне») — веб: deviceLinkInvite.ts.
    static let addDeviceQrPrefix = "EBLUSHA_ADD_DEVICE:"
    /// QR НОВОГО устройства (серверный pairing) — его сканирует доверенное.
    static let linkDeviceQrPrefix = "EBLUSHA_LINK_DEVICE:"
    static let inviteCodeLen = 8
    /// Не private: используется значением по умолчанию replenishPrekeys(count:).
    static let prekeyBatch = 50
    private static let poisonMaxAttempts = 20
    private static let poisonMaxAgeMs: Int64 = 30 * 60_000
    private static let receiverCacheTtlMs: Int64 = 60_000
    private static let rebootstrapCooldownMs: Int64 = 60_000
    /// Порог «большого» вложения: выше — расшифровка строго по одному (2× размер в памяти).
    private static let bigAttachmentBytes: Int64 = 15 * 1024 * 1024
    private static let inviteTtlMs: Int64 = 5 * 60_000

    // MARK: - Бутстрап устройства

    /// Генерирует идентичность + prekeys этого устройства и регистрирует их
    /// (идемпотентно для устройства). false — сбой сети/сервера, повторить позже.
    @discardableResult
    func ensureDeviceBootstrap() async -> Bool {
        if keyStore.isBootstrapped() { return true }
        if !SecretCrypto.selfTest() {
            NSLog("SecretE2EE: SecretCrypto self-test FAILED — interop will not work")
        }
        let identity = keyStore.loadOrCreateIdentity()
        let (uploads, secrets) = Self.generatePrekeys(Self.prekeyBatch)
        keyStore.addPrekeySecrets(secrets)
        let pub = SecretCrypto.b64UrlEncode(identity.publicKey)
        func request() -> RegisterDeviceRequest {
            RegisterDeviceRequest(
                deviceId: deviceIdProvider.deviceId(),
                name: "iPhone",
                platform: "ios",
                publicKey: pub,
                identityPublicKey: pub,
                prekeys: uploads
            )
        }
        do {
            do {
                try await devices.register(request())
            } catch let error as HTTPError where error.code == 409 {
                // 409 = этот id установки закреплён за ДРУГИМ аккаунтом (device-id
                // переживает logout, так что после входа под другим пользователем он
                // занят навсегда). Без ротации бутстрап не проходил бы НИКОГДА, а
                // x-device-id указывал бы на чужое устройство → /secret/inbox/pull 400
                // и realtime секреток мёртв (сообщения только реконсиляцией истории).
                let fresh = deviceIdProvider.rotate()
                NSLog("SecretE2EE: device id was taken by another account — rotated to %@", fresh)
                try await devices.register(request())
                onDeviceIdRotated?()
            }
            keyStore.setBootstrapped()
            NSLog("SecretE2EE: device E2EE bootstrap complete")
            return true
        } catch {
            NSLog("SecretE2EE: device bootstrap failed: %@", String(describing: error))
            return false
        }
    }

    /// Пополняет пул one-time prekeys (сервер сообщает об иссякании: kind="prekeys_needed").
    @discardableResult
    func replenishPrekeys(count: Int = SecretRepository.prekeyBatch) async -> Bool {
        do {
            let (uploads, secrets) = Self.generatePrekeys(count)
            keyStore.addPrekeySecrets(secrets)
            try await devices.publishPrekeys(
                deviceId: deviceIdProvider.deviceId(),
                PublishPrekeysRequest(prekeys: uploads)
            )
            return true
        } catch {
            NSLog("SecretE2EE: prekey replenish failed: %@", String(describing: error))
            return false
        }
    }

    // MARK: - Создание/жизненный цикл треда

    /// Создаёт (или переиспользует) V2-SECRET-тред с собеседником. Если МЫ создатель —
    /// генерируем ключ треда и держим до accept'а; не-создатель ждёт key package из
    /// инбокса. Возвращает id треда/беседы.
    func createSecretThread(peerUserId: String) async -> ApiResult<SecretThreadStart> {
        await safeApiCall {
            await self.ensureDeviceBootstrap()
            let resp: CreateSecretThreadResponse = try await self.api.post(
                "threads/secret", body: CreateSecretThreadRequest(peerUserId: peerUserId)
            )
            if self.keyStore.threadKey(resp.threadId) == nil {
                if resp.created {
                    // Accept-on-one-device: генерируем + сохраняем ключ, но НЕ раздаём.
                    // Ждём accept собеседника на ОДНОМ устройстве (secret:chat:accepted) →
                    // ключуем ровно его. Остальные устройства — через привязку.
                    self.keyStore.setThreadKey(resp.threadId, key: SecretCrypto.randomKey())
                } else {
                    // REUSED-тред без локального ключа (переустановка, новое устройство) —
                    // НИКОГДА не перегенерировать, даже создателю: пиры импортируют с
                    // перезаписью и старые шифртексты окирпичатся. Восстановление — просьба
                    // ко всем устройствам участников переслать существующий ключ.
                    await self.requestThreadKey(threadId: resp.threadId, userIds: [peerUserId])
                }
            }
            return SecretThreadStart(
                threadId: resp.threadId,
                active: resp.thread?.secretStatus?.caseInsensitiveCompare("ACTIVE") == .orderedSame
            )
        }
    }

    /// Просит каждое устройство [userIds] (+ свои другие) переслать ключ треда (control).
    func requestThreadKey(threadId: String, userIds: [String]) async {
        let myDeviceId = deviceIdProvider.deviceId()
        let header = SecretHeader(
            kind: "control",
            threadId: threadId,
            type: "key_request",
            fromDeviceId: myDeviceId,
            requesterDeviceId: myDeviceId
        )
        var targets = userIds
        if let me = session.currentUserId() { targets.append(me) }
        for userId in orderedDistinct(targets) {
            guard let bundles = try? await devices.prekeyBundles(userId: userId).bundles else { continue }
            for bundle in bundles where bundle.deviceId != myDeviceId {
                try? await sendControl(toDeviceId: bundle.deviceId, header: header)
            }
        }
    }

    func hasThreadKey(_ threadId: String) -> Bool {
        keyStore.threadKey(threadId) != nil
    }

    /// Есть ли на этом устройстве хоть один ключ секретки (веб: hasAnySecretThreadKeys).
    func hasAnyThreadKey() -> Bool {
        !keyStore.allThreadKeys().isEmpty
    }

    /// Есть ли у аккаунта другие (не отозванные) устройства — иначе просить ключи не у кого.
    func hasOtherDevices() async -> Bool {
        await devices.hasOtherDevices()
    }

    /// Собеседник принимает приглашение на ЭТОМ устройстве → создатель ключует ровно его.
    func acceptInvite(threadId: String) async -> ApiResult<Void> {
        await safeApiCall {
            await self.ensureDeviceBootstrap()
            // Пополняем one-time prekeys ДО accept'а: создатель заклеймит один, чтобы
            // ключевать нас, каждый accept/re-key сжигает по одному, и ничто другое пул
            // не пополняет (сервер сам не подталкивает).
            await self.replenishPrekeys()
            let _: AcceptSecretThreadResponse = try await self.api.post(
                "threads/secret/\(threadId)/accept",
                body: AcceptSecretThreadRequest(deviceId: self.deviceIdProvider.deviceId())
            )
            await self.syncInbox() // ключ мог уже ждать; иначе его дотянет secret:notify
        }
    }

    /// Отклонить / отменить PENDING-приглашение → CANCELLED (скрыт на всех устройствах).
    func declineInvite(threadId: String) async -> ApiResult<Void> {
        await safeApiCall {
            let _: AcceptSecretThreadResponse = try await self.api.post(
                "threads/secret/\(threadId)/decline",
                body: AcceptSecretThreadRequest(deviceId: self.deviceIdProvider.deviceId())
            )
            // Закрыл секретку → plaintext-кэш и ключ треда уничтожаются.
            await self.purgeThreadLocal(threadId)
        }
    }

    /// Сторона создателя при accept'е: отправить ключ треда РОВНО тому устройству,
    /// на котором собеседник принял (обработчик события secret:chat:accepted).
    func onPeerAccepted(threadId: String, peerDeviceId: String) async {
        invalidateReceivers(threadId) // принявшее устройство должно попасть в следующий фанаут
        guard let key = keyStore.threadKey(threadId), // не мы держим ключ — не наша забота
              let identity = keyStore.identity() else { return }
        do {
            try await sendThreadKeyPackage(
                conversationId: threadId,
                threadKey: key,
                identity: identity,
                fromDeviceId: deviceIdProvider.deviceId(),
                toDeviceId: peerDeviceId
            )
        } catch {
            NSLog("SecretE2EE: share to accepted device %@ failed: %@", peerDeviceId, String(describing: error))
        }
    }

    // NOTE: старый distributeThreadKey (фанаут на ВСЕ устройства) удалён намеренно —
    // accept-on-one-device означает, что ключ ходит только создатель→принявшее-устройство
    // (onPeerAccepted) и через key_request/привязку. Фанаут не возвращать.

    // MARK: - Инбокс

    /// Разбор входящих конвертов: импорт ключей тредов, ответы на control-запросы,
    /// всплытие сообщений тредов. Ack-семантика зеркалит веб: сообщения/control/неизвестное
    /// ack-аются безусловно, а key package — ТОЛЬКО после успешного импорта (копия в
    /// инбоксе единственная — ack неудавшегося импорта уничтожил бы ключ навсегда) или
    /// после отравления.
    func syncInbox() async {
        await inboxGate.withPermit { await syncInboxLocked() }
    }

    private func syncInboxLocked() async {
        do {
            let resp: SecretInboxResponse = try await api.get(
                "secret/inbox/pull", query: [URLQueryItem(name: "limit", value: "50")]
            )
            let items = resp.messages
            guard !items.isEmpty else { return }
            var acks: [String] = []
            for item in items {
                let h = item.headerJson
                if h.kind == "key_package", h.packageKind == "thread_key" {
                    if await importKeyPackage(item) {
                        acks.append(item.msgId)
                        poisonAttempts.removeValue(forKey: item.msgId)
                        if let threadId = h.threadId {
                            keyImported.send(threadId)
                            // Квитанция инициатору, чтобы он перестал переслать (веб-паритет).
                            if let initiator = h.initiatorDeviceId {
                                try? await sendControl(
                                    toDeviceId: initiator,
                                    header: SecretHeader(
                                        kind: "control",
                                        threadId: threadId,
                                        type: "key_receipt",
                                        fromDeviceId: deviceIdProvider.deviceId()
                                    )
                                )
                            }
                        }
                    } else {
                        registerPoisonFailure(item.msgId, acks: &acks)
                    }
                } else if h.kind == "key_package", h.packageKind == "device_link_keys" {
                    // Привязка устройства: связка ВСЕХ ключей тредов с доверенного устройства.
                    if await importDeviceLinkKeys(item) {
                        acks.append(item.msgId)
                        poisonAttempts.removeValue(forKey: item.msgId)
                    } else {
                        registerPoisonFailure(item.msgId, acks: &acks)
                    }
                } else if h.kind == "link_device_join" {
                    // Другое НАШЕ устройство просит связку ключей, предъявляя token/code
                    // нашего приглашения. Отдаём ТОЛЬКО при совпадении с активным локальным
                    // приглашением (веб отдаёт без проверки — намеренно строже: иначе любое
                    // добавленное в аккаунт устройство молча выкачивало бы все ключи).
                    // ack ТОЛЬКО когда запрос обработан (или заведомо чужой): иначе один
                    // прилетевший раньше времени запрос сжигался бы, и повторное «Добавить
                    // устройство» уже не помогло бы — конверт удалён.
                    let handled = (try? await handleLinkDeviceJoin(h)) ?? false
                    if handled { acks.append(item.msgId) }
                } else if h.kind == "control" {
                    try? await handleControl(item)
                    acks.append(item.msgId)
                } else if h.kind == "prekeys_needed" {
                    await replenishPrekeys()
                    acks.append(item.msgId)
                } else if h.kind == "msg" {
                    // Огорожено: один битый конверт (плохой base64/nonce) не должен
                    // прервать pull до ack'а — это заклинило бы инбокс навсегда.
                    if let threadId = item.threadId ?? h.threadId,
                       let decrypted = decryptThreadItem(threadId: threadId, item: item) {
                        incoming.send(decrypted)
                    }
                    acks.append(item.msgId)
                } else {
                    acks.append(item.msgId) // неизвестные kind не должны клинить инбокс
                }
            }
            if !acks.isEmpty {
                try await api.postIgnoringResponse("secret/inbox/ack", body: SecretAckRequest(msgIds: acks))
            }
        } catch {
            NSLog("SecretE2EE: inbox sync failed: %@", String(describing: error))
            // 400/403 = сервер не признаёт наш x-device-id (устройство отозвано, удалено
            // или осталось за прежним аккаунтом). Инбокс сам не оживёт никогда — повторяем
            // бутстрап, он при 409 повернёт device-id. Троттл: без него залипшая ошибка
            // молотила бы регистрацию до серверного рейт-лимита.
            let code = (error as? HTTPError)?.code
            if code == 400 || code == 403 {
                let now = nowMs()
                let allowed: Bool = stateLock.withStateLock {
                    guard now - lastRebootstrapMs > Self.rebootstrapCooldownMs else { return false }
                    lastRebootstrapMs = now
                    return true
                }
                if allowed {
                    keyStore.clearBootstrapped()
                    if await ensureDeviceBootstrap() {
                        NSLog("SecretE2EE: re-bootstrapped after inbox %d", code ?? 0)
                    }
                }
            }
        }
    }

    /// Учёт неудачного импорта key package; после лимитов — poison-ack (вызывать под inboxGate).
    private func registerPoisonFailure(_ msgId: String, acks: inout [String]) {
        let now = nowMs()
        let (attempts, first) = poisonAttempts[msgId] ?? (0, now)
        poisonAttempts[msgId] = (attempts + 1, first)
        if attempts + 1 > Self.poisonMaxAttempts || now - first > Self.poisonMaxAgeMs {
            acks.append(msgId)
            poisonAttempts.removeValue(forKey: msgId)
            NSLog("SecretE2EE: key package %@ poisoned — acked to unblock the inbox", msgId)
        }
    }

    // MARK: - Отправка

    /// Шифрует и пушит текст. НИКОГДА не генерирует ключ треда (инвариант «только
    /// создатель») — вызывающий обязан копить отправки, пока hasThreadKey не true.
    /// msgId задаёт вызывающий → оптимистичный пузырь UI делит финальный id, а повтор
    /// после сетевого сбоя идемпотентен. Возвращает локальное эхо.
    func sendText(
        conversationId: String,
        peerUserIds: [String],
        text: String,
        msgId: String = UUID().uuidString.lowercased()
    ) async -> ApiResult<DecryptedSecretMessage> {
        await safeApiCall {
            guard let key = self.keyStore.threadKey(conversationId) else {
                throw SecretContractError(message: "Ключ шифрования ещё не получен")
            }
            let nonce = SecretCrypto.randomNonce()
            guard let cipher = SecretCrypto.secretBox(message: Data(text.utf8), nonce: nonce, key: key) else {
                throw SecretContractError(message: "Ключ шифрования повреждён")
            }
            let createdAt = Self.isoNow()
            try await self.api.postIgnoringResponse(
                "secret/messages/push",
                body: SecretPushRequest(
                    threadId: conversationId,
                    msgId: msgId,
                    createdAt: createdAt,
                    headerJson: SecretHeader(v: 1, kind: "msg", nonce: SecretCrypto.b64UrlEncode(nonce)),
                    ciphertext: SecretCrypto.b64UrlEncode(cipher),
                    contentType: "text",
                    receiverDeviceIds: await self.gatherReceiverDeviceIds(
                        threadId: conversationId, peerUserIds: peerUserIds
                    )
                )
            )
            return DecryptedSecretMessage(
                id: msgId,
                threadId: conversationId,
                senderId: self.session.currentUserId() ?? "",
                text: text,
                createdAtMs: parseIsoToMillis(createdAt) ?? self.nowMs(),
                isMine: true
            )
        }
    }

    /// E2EE-вложения (веб-протокол, secretThreadMessaging.ts): каждый файл шифруется
    /// КЛЮЧОМ ТРЕДА со своим nonce и грузится НЕПРОЗРАЧНЫМ блобом `{uuid}.enc`
    /// (octet-stream, без имени — сервер не видит ни имён, ни типов, ни nonce). Само
    /// сообщение — зашифрованный тем же ключом JSON-дескриптор со всеми метаданными;
    /// push идёт с contentType="attachment", а headerJson.attachment даёт серверу первый
    /// objectKey для GC-учёта. Файлы 2..N альбома — отдельные best-effort ref-вызовы.
    func sendAttachments(
        conversationId: String,
        peerUserIds: [String],
        files: [OutgoingFile],
        caption: String? = nil,
        durationSec: Int? = nil,     // голосовое: длительность (сек)
        waveform: [Int]? = nil,      // голосовое: бары амплитуды
        onProgress: ((Int64, Int64) -> Void)? = nil,
        isCancelled: (() -> Bool)? = nil,
        msgId: String = UUID().uuidString.lowercased()
    ) async -> ApiResult<DecryptedSecretMessage> {
        await safeApiCall {
            guard !files.isEmpty else { throw SecretContractError(message: "no files to send") }
            guard let key = self.keyStore.threadKey(conversationId) else {
                throw SecretContractError(message: "Ключ шифрования ещё не получен")
            }
            let totalPlain = files.reduce(Int64(0)) { $0 + Int64($1.bytes.count) }
            var donePlain: Int64 = 0
            var items: [SecretAttachmentItemDto] = []
            for f in files {
                let fileNonce = SecretCrypto.randomNonce()
                guard let cipher = SecretCrypto.secretBox(message: f.bytes, nonce: fileNonce, key: key) else {
                    throw SecretContractError(message: "Ключ шифрования повреждён")
                }
                let uploaded = try await self.uploadEncryptedBlob(cipher) { sent in
                    // Прогресс в БАЙТАХ ИСХОДНИКА: шифртекст длиннее на 16 Б — прижимаем,
                    // чтобы полоса не «перепрыгивала» размер файла.
                    onProgress?(donePlain + min(sent, Int64(f.bytes.count)), totalPlain)
                    if isCancelled?() == true { throw UploadCancelledException() }
                }
                donePlain += Int64(f.bytes.count)
                onProgress?(donePlain, totalPlain)
                let attType: String
                if f.mime.hasPrefix("image/") { attType = "IMAGE" }
                else if f.mime.hasPrefix("video/") { attType = "VIDEO" }
                else if f.mime.hasPrefix("audio/") { attType = "AUDIO" }
                else { attType = "FILE" }
                var dims: (width: Int, height: Int)?
                switch attType {
                case "IMAGE": dims = Self.imageDimensions(f.bytes)
                // Веб шлёт размеры и у видео — приёмник резервирует aspect пузыря без «прыжка».
                case "VIDEO": dims = await Self.videoDimensions(f.bytes, mime: f.mime)
                default: dims = nil
                }
                items.append(SecretAttachmentItemDto(
                    objectKey: uploaded.path ?? Self.pathFromFilesUrl(uploaded.url),
                    url: uploaded.url,
                    nonce: SecretCrypto.b64UrlEncode(fileNonce),
                    name: f.name,
                    mime: f.mime,
                    size: Int64(f.bytes.count),
                    attType: attType,
                    width: dims?.width,
                    height: dims?.height,
                    duration: attType == "AUDIO" ? durationSec.map(Double.init) : nil,
                    waveform: attType == "AUDIO" ? waveform?.map(Double.init) : nil
                ))
            }
            let trimmedCaption = caption?.trimmed()
            // JSONEncoder опускает nil-поля — как веб (buildSecretAttachmentView
            // рассчитывает на отсутствие поля, а не на null; порт descriptorJson).
            let descriptor = try JSONEncoder().encode(SecretAttachmentDescriptorDto(
                v: 1,
                text: (trimmedCaption?.isEmpty == false) ? caption : nil,
                attachments: items
            ))
            let msgNonce = SecretCrypto.randomNonce()
            guard let cipherMsg = SecretCrypto.secretBox(message: descriptor, nonce: msgNonce, key: key) else {
                throw SecretContractError(message: "Ключ шифрования повреждён")
            }
            let createdAt = Self.isoNow()
            try await self.api.postIgnoringResponse(
                "secret/messages/push",
                body: SecretPushRequest(
                    threadId: conversationId,
                    msgId: msgId,
                    createdAt: createdAt,
                    headerJson: SecretHeader(
                        v: 1,
                        kind: "msg",
                        nonce: SecretCrypto.b64UrlEncode(msgNonce),
                        attachment: SecretHeaderAttachment(
                            objectKey: items.first?.objectKey ?? "", size: totalPlain
                        )
                    ),
                    ciphertext: SecretCrypto.b64UrlEncode(cipherMsg),
                    contentType: "attachment",
                    receiverDeviceIds: await self.gatherReceiverDeviceIds(
                        threadId: conversationId, peerUserIds: peerUserIds
                    )
                )
            )
            // Альбом: GC-рефы для файлов 2..N. Best-effort, как на вебе: провал не роняет
            // отправку (файл уже доставлен внутри дескриптора) — ref добьёт ночной GC.
            for item in items.dropFirst() {
                guard let objectKey = item.objectKey else { continue }
                try? await self.api.postIgnoringResponse(
                    "secret/attachments/ref",
                    body: SecretAttachmentRefRequest(threadId: conversationId, objectKey: objectKey)
                )
            }
            return DecryptedSecretMessage(
                id: msgId,
                threadId: conversationId,
                senderId: self.session.currentUserId() ?? "",
                text: (trimmedCaption?.isEmpty == false) ? caption ?? "" : "",
                createdAtMs: parseIsoToMillis(createdAt) ?? self.nowMs(),
                isMine: true,
                attachments: items
            )
        }
    }

    /// Шифроблоб на сервер: ≤10 МБ — multipart, больше — чанками (init → части →
    /// complete, аборт при сбое). Копия ChatRepository.uploadFileAdaptive БЕЗ 25-МБ форы
    /// для картинок: шифртекст для сервера не картинка, превью он с него не снимет.
    private func uploadEncryptedBlob(
        _ cipher: Data,
        onSent: (Int64) throws -> Void
    ) async throws -> UploadResponse {
        let blobName = "\(Self.uuid()).enc"
        if cipher.count <= simpleUploadMaxBytes {
            let uploaded: UploadResponse = try await api.uploadMultipart(
                "upload", fileName: blobName, mime: "application/octet-stream", data: cipher
            )
            try onSent(Int64(cipher.count))
            return uploaded
        }
        let initResp: ChunkInitResponse = try await api.post(
            "upload/init",
            body: ChunkInitRequest(
                filename: blobName,
                contentType: "application/octet-stream",
                size: Int64(cipher.count)
            )
        )
        let chunkSize = max(Int(initResp.chunkSize), 1)
        do {
            var offset = 0
            var partNumber = 0
            while offset < cipher.count {
                let end = min(offset + chunkSize, cipher.count)
                try await api.putRawBytes(
                    "upload/\(initResp.uploadId)/part/\(partNumber)",
                    body: cipher.subdata(in: offset..<end)
                )
                try onSent(Int64(end))
                offset = end
                partNumber += 1
            }
            try onSent(Int64(cipher.count)) // финальная проверка отмены ПЕРЕД complete
            return try await api.postEmpty("upload/\(initResp.uploadId)/complete")
        } catch {
            // Аналог NonCancellable: аборт уходит НЕструктурированной задачей, чтобы
            // отмена родительского Task не съела и его (порт ChatRepositoryUploads).
            await Task { try? await api.deleteIgnoringResponse("upload/\(initResp.uploadId)") }.value
            throw error
        }
    }

    // MARK: - История

    /// Страница истории: на проводе newest-first → возвращаем oldest-first для ленты.
    func history(
        conversationId: String,
        cursor: String? = nil,
        limit: Int = 80
    ) async -> ApiResult<SecretHistoryPage> {
        await safeApiCall {
            let key = self.keyStore.threadKey(conversationId)
            let me = self.session.currentUserId()
            var query = [
                URLQueryItem(name: "threadId", value: conversationId),
                URLQueryItem(name: "limit", value: String(limit)),
            ]
            if let cursor { query.append(URLQueryItem(name: "cursor", value: cursor)) }
            let resp: SecretHistoryResponse = try await self.api.get("secret/history", query: query)
            let messages = resp.items.compactMap { item -> DecryptedSecretMessage? in
                // Пер-строчный guard: одна битая строка не должна валить страницу навсегда.
                guard let nonceB64 = item.headerJson.nonce else { return nil }
                var plain: Data?
                if let key,
                   let cipher = SecretCrypto.b64UrlDecode(item.ciphertext),
                   let nonce = SecretCrypto.b64UrlDecode(nonceB64) {
                    plain = SecretCrypto.secretBoxOpen(cipher: cipher, nonce: nonce, key: key)
                }
                let (text, atts) = Self.decodeContent(plain, contentType: item.contentType)
                return DecryptedSecretMessage(
                    id: item.msgId,
                    threadId: conversationId,
                    senderId: item.senderUserId ?? "",
                    text: text,
                    createdAtMs: parseIsoToMillis(item.createdAt) ?? self.nowMs(),
                    isMine: item.senderUserId == me,
                    attachments: atts
                )
            }.sorted { $0.createdAtMs < $1.createdAtMs }
            return SecretHistoryPage(messages: messages, hasMore: resp.hasMore, nextCursor: resp.nextCursor)
        }
    }

    // MARK: - Конверты / control

    /// Оборачивает один конверт в батч POST /secret/send (голые конверты сервер отвергает).
    private func sendEnvelope(_ envelope: SecretDirectEnvelope) async throws {
        try await api.postIgnoringResponse("secret/send", body: SecretSendBatchRequest(messages: [envelope]))
    }

    private func sendControl(toDeviceId: String, header: SecretHeader, ttlSeconds: Int = 900) async throws {
        try await sendEnvelope(SecretDirectEnvelope(
            toDeviceId: toDeviceId,
            msgId: Self.uuid(),
            createdAt: Self.isoNow(),
            ciphertext: SecretCrypto.b64UrlEncode(Data("ctrl".utf8)),
            contentType: "ref",
            headerJson: header,
            ttlSeconds: ttlSeconds
        ))
    }

    /// Другое устройство просит ключ треда (пропущенный/протухший пакет) — пересылаем,
    /// если держим.
    private func handleControl(_ item: SecretInboxItemDto) async throws {
        let h = item.headerJson
        switch h.type ?? "" {
        case "key_request", "key_resend_request":
            guard let threadId = h.threadId else { return }
            guard let requester = h.requesterDeviceId ?? h.fromDeviceId ?? item.senderDeviceId else { return }
            invalidateReceivers(threadId) // заговорило устройство, о котором мы могли не знать
            guard let key = keyStore.threadKey(threadId), let identity = keyStore.identity() else { return }
            do {
                try await sendThreadKeyPackage(
                    conversationId: threadId,
                    threadKey: key,
                    identity: identity,
                    fromDeviceId: deviceIdProvider.deviceId(),
                    toDeviceId: requester
                )
            } catch {
                NSLog("SecretE2EE: key re-send to %@ failed: %@", requester, String(describing: error))
            }
        default:
            break // key_receipt и прочее — информационные
        }
    }

    private func sendThreadKeyPackage(
        conversationId: String,
        threadKey: Data,
        identity: SecretCrypto.KeyPair,
        fromDeviceId: String,
        toDeviceId: String
    ) async throws {
        let claim: ClaimPrekeyResponse = try await devices.claimPrekey(deviceId: toDeviceId)
        guard let prekey = claim.prekey else { return }

        // Сторона отправителя X25519-рукопожатия: DH(identitySecret, targetPrekeyPublic).
        guard let prekeyPublic = SecretCrypto.b64UrlDecode(prekey.publicKey),
              let shared = SecretCrypto.scalarMult(secret: identity.secretKey, peerPublic: prekeyPublic) else {
            throw SecretContractError(message: "битый prekey устройства-получателя")
        }
        let salt = SecretCrypto.randomBytes(32)
        let info = "eblusha:secret_pkg:thread_key:to:\(toDeviceId):from:\(fromDeviceId):prekey:\(prekey.keyId)"
        let sessionKey = SecretCrypto.hkdfSha256(
            ikm: shared, salt: salt, info: Data(info.utf8), length: SecretCrypto.keyBytes
        )

        let payload: [String: Any] = [
            "threadId": conversationId,
            "key": SecretCrypto.b64UrlEncode(threadKey),
            "kind": "thread_key",
            "v": 1,
            "ts": nowMs(),
        ]
        let payloadData = try JSONSerialization.data(withJSONObject: payload)
        let nonce = SecretCrypto.randomNonce()
        guard let cipher = SecretCrypto.secretBox(message: payloadData, nonce: nonce, key: sessionKey) else {
            throw SecretContractError(message: "Не удалось зашифровать пакет")
        }
        try await sendEnvelope(SecretDirectEnvelope(
            toDeviceId: toDeviceId,
            msgId: Self.uuid(),
            createdAt: Self.isoNow(),
            ciphertext: SecretCrypto.b64UrlEncode(cipher),
            contentType: "ref",
            headerJson: SecretHeader(
                v: 1,
                kind: "key_package",
                nonce: SecretCrypto.b64UrlEncode(nonce),
                packageKind: "thread_key",
                threadId: conversationId,
                recipientDeviceId: toDeviceId,
                initiatorDeviceId: fromDeviceId,
                initiatorIdentityKey: SecretCrypto.b64UrlEncode(identity.publicKey),
                prekeyId: prekey.keyId,
                handshakeSalt: SecretCrypto.b64UrlEncode(salt),
                hkdfInfo: info,
                alg: "xsalsa20_poly1305+hkdf_sha256"
            ),
            ttlSeconds: 3600 // веб: thread_key-пакеты живут 1 ч в per-device инбоксе
        ))
    }

    /// Общая расшифровка key_package (thread_key и device_link_keys ходят одним handshake).
    private func openKeyPackage(_ item: SecretInboxItemDto) -> Data? {
        let h = item.headerJson
        guard h.kind == "key_package",
              let prekeyId = h.prekeyId,
              let initiatorIdentity = h.initiatorIdentityKey,
              let saltB64 = h.handshakeSalt,
              let info = h.hkdfInfo, // используется ДОСЛОВНО — несёт to/from/prekey отправителя
              let nonceB64 = h.nonce,
              let myPrekeySecret = keyStore.prekeySecret(prekeyId),
              let initiatorPublic = SecretCrypto.b64UrlDecode(initiatorIdentity),
              let salt = SecretCrypto.b64UrlDecode(saltB64),
              let nonce = SecretCrypto.b64UrlDecode(nonceB64),
              let cipher = SecretCrypto.b64UrlDecode(item.ciphertext) else { return nil }

        // Сторона получателя: DH(myPrekeySecret, initiatorIdentityPublic) == секрет отправителя.
        guard let shared = SecretCrypto.scalarMult(secret: myPrekeySecret, peerPublic: initiatorPublic) else {
            return nil
        }
        let sessionKey = SecretCrypto.hkdfSha256(
            ikm: shared, salt: salt, info: Data(info.utf8), length: SecretCrypto.keyBytes
        )
        return SecretCrypto.secretBoxOpen(cipher: cipher, nonce: nonce, key: sessionKey)
    }

    private func importKeyPackage(_ item: SecretInboxItemDto) async -> Bool {
        guard let plain = openKeyPackage(item),
              let payload = (try? JSONSerialization.jsonObject(with: plain)) as? [String: Any] else {
            return false
        }
        guard let threadId = (payload["threadId"] as? String) ?? item.headerJson.threadId,
              let keyB64 = payload["key"] as? String,
              let key = SecretCrypto.b64UrlDecode(keyB64),
              // Длину проверяем ЗДЕСЬ, до записи в Keychain: пакет приходит из сети, и
              // ключ негодного размера иначе оседал бы в хранилище навсегда, отравляя
              // тред (веб делает ту же проверку в secretThreadKeyStore).
              key.count == SecretCrypto.keyBytes else { return false }
        keyStore.setThreadKey(threadId, key: key)
        NSLog("SecretE2EE: imported secret thread key for %@", threadId)
        return true
    }

    // MARK: - Расшифровка сообщений

    private func decryptThreadItem(threadId: String, item: SecretInboxItemDto) -> DecryptedSecretMessage? {
        let me = session.currentUserId()
        guard let nonceB64 = item.headerJson.nonce else { return nil }
        var plain: Data?
        if let key = keyStore.threadKey(threadId),
           let cipher = SecretCrypto.b64UrlDecode(item.ciphertext),
           let nonce = SecretCrypto.b64UrlDecode(nonceB64) {
            plain = SecretCrypto.secretBoxOpen(cipher: cipher, nonce: nonce, key: key)
        }
        let (text, atts) = Self.decodeContent(plain, contentType: item.contentType)
        return DecryptedSecretMessage(
            id: item.msgId,
            threadId: threadId,
            senderId: item.senderUserId ?? "",
            text: text,
            createdAtMs: parseIsoToMillis(item.createdAt) ?? nowMs(),
            isMine: item.senderUserId == me,
            attachments: atts
        )
    }

    /// Расшифрованные байты → (текст, вложения). Ключа нет → 🔒-текст;
    /// contentType="attachment" → парсим дескриптор, и ЛЮБАЯ битость (не-JSON, v≠1, ни
    /// одного item с url+nonce) даёт «🔒 Вложение зашифровано» — сырой JSON дескриптора
    /// НИКОГДА не показывается (веб-инвариант).
    private static func decodeContent(
        _ plain: Data?, contentType: String?
    ) -> (String, [SecretAttachmentItemDto]) {
        // Нет ключа: contentType — открытая серверная метадата, подписываем как веб.
        guard let plain else {
            return (contentType == "attachment" ? lockedAttachment : lockedPlaceholder, [])
        }
        guard contentType == "attachment" else {
            return (String(decoding: plain, as: UTF8.self), [])
        }
        guard let parsed = try? JSONDecoder().decode(SecretAttachmentDescriptorDto.self, from: plain),
              parsed.v == 1 else {
            return (lockedAttachment, [])
        }
        let usable = parsed.attachments.filter {
            !($0.url ?? "").isEmpty && !($0.nonce ?? "").isEmpty
        }
        guard !usable.isEmpty else { return (lockedAttachment, []) }
        return (parsed.text ?? "", usable)
    }

    // MARK: - Расшифровка вложений в кэш-файл

    /// Скачивает шифртекст вложения и расшифровывает его в кэш-файл
    /// (Caches/secret-att) для показа. Дисковый кэш: повторный вход в чат не тянет и не
    /// расшифровывает файл заново; каталог app-private, чистится в clearLocalData()
    /// при logout. nil — нет ключа / сеть / битый шифртекст (UI показывает
    /// «не удалось расшифровать»).
    func decryptAttachmentToFile(
        threadId: String,
        url: String,
        nonceB64: String,
        expectedSize: Int64? = nil
    ) async -> URL? {
        guard let key = keyStore.threadKey(threadId) else { return nil }
        let dir = Self.attCacheDirectory()
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        // Префикс по треду — чтобы purgeThreadLocal мог удалить кэш ИМЕННО этого треда.
        let cacheName = Self.threadCachePrefix(threadId) + String(Self.sha256Hex("\(url)|\(nonceB64)").prefix(40))
        let out = dir.appendingPathComponent(cacheName)
        if fileExistsNonEmpty(out) { return out }
        // Большие файлы — строго по одному, мелкие — до трёх (см. bigDecrypts).
        let gate = (expectedSize ?? 0) > Self.bigAttachmentBytes ? bigDecrypts : smallDecrypts
        return await gate.withPermit { () async -> URL? in
            // Один мьютекс на конкретный файл: параллельные рекомпозиции (пузырь +
            // просмотрщик) не должны качать и писать один блоб дважды.
            await self.fileGate(cacheName).withPermit { () async -> URL? in
                if self.fileExistsNonEmpty(out) { return out }
                guard let resolved = resolveMediaUrl(url), let remote = URL(string: resolved) else {
                    return nil
                }
                guard let cipher = await self.downloadBytes(remote) else { return nil }
                // Guard обязателен: битый base64-nonce из враждебного дескриптора не
                // должен ронять процесс — сообщение-то остаётся в истории.
                guard let nonce = SecretCrypto.b64UrlDecode(nonceB64),
                      let plain = SecretCrypto.secretBoxOpen(cipher: cipher, nonce: nonce, key: key) else {
                    return nil
                }
                let tmp = dir.appendingPathComponent("\(cacheName).tmp")
                do {
                    try plain.write(to: tmp)
                    try? FileManager.default.removeItem(at: out) // остаток гонки не мешает move
                    try FileManager.default.moveItem(at: tmp, to: out)
                    return out
                } catch {
                    try? FileManager.default.removeItem(at: tmp)
                    return nil
                }
            }
        }
    }

    private func downloadBytes(_ url: URL) async -> Data? {
        guard let (data, response) = try? await downloadSession.data(from: url),
              let http = response as? HTTPURLResponse,
              (200..<300).contains(http.statusCode) else { return nil }
        return data
    }

    private func fileGate(_ cacheName: String) -> AsyncSemaphore {
        stateLock.lock()
        defer { stateLock.unlock() }
        if let existing = attFileGates[cacheName] { return existing }
        let created = AsyncSemaphore(1)
        attFileGates[cacheName] = created
        return created
    }

    private func fileExistsNonEmpty(_ url: URL) -> Bool {
        let attrs = try? FileManager.default.attributesOfItem(atPath: url.path)
        return ((attrs?[.size] as? NSNumber)?.int64Value ?? 0) > 0
    }

    /// Закрытие/отмена секретного чата: расшифрованный кэш вложений и ключ треда не
    /// должны переживать сам тред (веб держит расшифровку только в памяти).
    func purgeThreadLocal(_ threadId: String) async {
        let dir = Self.attCacheDirectory()
        let prefix = Self.threadCachePrefix(threadId)
        if let names = try? FileManager.default.contentsOfDirectory(atPath: dir.path) {
            for name in names where name.hasPrefix(prefix) {
                try? FileManager.default.removeItem(at: dir.appendingPathComponent(name))
            }
        }
        keyStore.removeThreadKey(threadId)
    }

    /// Порт вклада в AppContainer.clearLocalData(): при logout стираем ВЕСЬ ключевой
    /// материал и расшифрованный кэш — они не должны достаться следующему аккаунту.
    func clearLocalData() {
        try? FileManager.default.removeItem(at: Self.attCacheDirectory())
        stateLock.withStateLock { localInvite = nil }
        invalidateReceivers(nil)
        keyStore.clear()
    }

    // MARK: - Привязка устройства по QR

    func currentInvite() -> DeviceLinkInvite? {
        guard let invite = stateLock.withStateLock({ localInvite }), !invite.expired else { return nil }
        return invite
    }

    @discardableResult
    func createInvite() -> DeviceLinkInvite {
        let token = SecretCrypto.b64UrlEncode(SecretCrypto.randomBytes(32))
        let digits = SecretCrypto.randomBytes(Self.inviteCodeLen)
            .map { String(Int($0) % 10) }
            .joined()
        let invite = DeviceLinkInvite(token: token, code: digits, expiresAtMs: nowMs() + Self.inviteTtlMs)
        stateLock.withStateLock { localInvite = invite }
        return invite
    }

    func clearInvite() {
        stateLock.withStateLock { localInvite = nil }
    }

    /// Мы — НОВОЕ устройство: просим связку ключей у всех остальных своих устройств,
    /// предъявляя token (из QR доверенного) или его 8-значный код. Прежде публикуем
    /// свежие prekeys — без них доверенное устройство физически не сможет зашифровать
    /// пакет в нашу сторону. Возвращает число устройств, которым ушёл запрос.
    func requestDeviceLink(tokenOrCode: String) async -> ApiResult<Int> {
        await safeApiCall {
            // Провал здесь фатален и виден: иначе привязка «сработала бы наполовину» молча.
            guard await self.ensureDeviceBootstrap() else {
                throw SecretContractError(message: "Не удалось подготовить ключи устройства — проверьте связь")
            }
            guard await self.replenishPrekeys() else {
                throw SecretContractError(message: "Не удалось опубликовать ключи устройства — попробуйте ещё раз")
            }
            let myDeviceId = self.deviceIdProvider.deviceId()
            let raw = tokenOrCode.trimmed()
            let token = Self.parseAddDeviceQr(raw) ?? (raw.count > Self.inviteCodeLen ? raw : nil)
            let code = token == nil ? String(raw.filter(\.isNumber).prefix(Self.inviteCodeLen)) : nil
            guard token != nil || code?.count == Self.inviteCodeLen else {
                throw SecretContractError(message: "Введите код из \(Self.inviteCodeLen) цифр")
            }
            let targets = try await self.devices.list().devices
                .filter { $0.revokedAt == nil }
                .map(\.id)
                .filter { $0 != myDeviceId }
            guard !targets.isEmpty else {
                throw SecretContractError(message: "Нет других устройств для привязки")
            }
            let createdAt = Self.isoNow()
            let envelopes = targets.map { toDeviceId in
                SecretDirectEnvelope(
                    toDeviceId: toDeviceId,
                    msgId: Self.uuid(),
                    createdAt: createdAt,
                    ciphertext: SecretCrypto.b64UrlEncode(Data("ctrl".utf8)),
                    contentType: "ref",
                    headerJson: SecretHeader(
                        v: 1,
                        kind: "link_device_join",
                        requesterDeviceId: myDeviceId,
                        ts: self.nowMs(),
                        token: token,
                        code: code
                    ),
                    ttlSeconds: 600
                )
            }
            try await self.api.postIgnoringResponse(
                "secret/send", body: SecretSendBatchRequest(messages: envelopes)
            )
            return targets.count
        }
    }

    /// Мы — ДОВЕРЕННОЕ устройство: отсканировали QR серверного приглашения нового
    /// устройства (`EBLUSHA_LINK_DEVICE:`) или ввели его код → узнаём, что за устройство.
    func resolvePairing(tokenOrCode: String) async -> ApiResult<PairingResolveResponse> {
        await safeApiCall {
            let raw = tokenOrCode.trimmed()
            let token = Self.parseLinkDeviceQr(raw) ?? (raw.count > 16 ? raw : nil)
            let body = token != nil
                ? PairingResolveRequest(token: token)
                : PairingResolveRequest(code: raw.uppercased())
            return try await self.api.post("devices/pairing/resolve", body: body)
        }
    }

    /// Мы — доверенное устройство: отдаём связку ключей и гасим серверное приглашение.
    func approvePairing(token: String, newDeviceId: String) async -> ApiResult<Int> {
        await safeApiCall {
            let sent = try await self.sendDeviceLinkKeys(toDeviceId: newDeviceId)
            do {
                try await self.api.postIgnoringResponse(
                    "devices/pairing/consume", body: PairingConsumeRequest(token: token)
                )
            } catch {
                NSLog("SecretE2EE: pairing consume failed: %@", String(describing: error))
            }
            return sent
        }
    }

    /// Ответ на link_device_join. Отдаём связку ТОЛЬКО если выполнено всё сразу:
    ///  - предъявлен token/код ЖИВОГО приглашения, показанного на этом устройстве;
    ///  - запрашивающее устройство — НАШЕ (deviceId любого пользователя виден всем через
    ///    /e2ee/prekeys/bundles, поэтому чужой запрос отправить тривиально).
    /// false = запрос отклонён — конверт НЕ ack-ается и доживёт свой TTL до момента,
    /// когда пользователь действительно откроет приглашение.
    private func handleLinkDeviceJoin(_ h: SecretHeader) async throws -> Bool {
        let requester = (h.requesterDeviceId ?? "").trimmed()
        if requester.isEmpty || requester == deviceIdProvider.deviceId() { return true }
        guard let invite = currentInvite() else {
            NSLog("SecretE2EE: link_device_join from %@ ignored — no active invite on this device", requester)
            return false
        }
        let digitsOnly = (h.code ?? "").filter(\.isNumber)
        let matches = h.token?.trimmed() == invite.token
            || (!digitsOnly.isEmpty && digitsOnly == invite.code)
        guard matches else {
            NSLog("SecretE2EE: link_device_join from %@ ignored — invite mismatch", requester)
            return false
        }
        let listed: DevicesListResponse
        do {
            listed = try await devices.list()
        } catch {
            NSLog("SecretE2EE: link_device_join: device check failed — keys NOT sent")
            return false // не смогли проверить — ключи не отдаём
        }
        guard listed.devices.contains(where: { $0.id == requester && $0.revokedAt == nil }) else {
            NSLog("SecretE2EE: link_device_join from FOREIGN device %@ — rejected", requester)
            return true // чужому конверту в инбоксе делать нечего
        }
        let count = try await sendDeviceLinkKeys(toDeviceId: requester)
        clearInvite() // приглашение одноразовое
        NSLog("SecretE2EE: device_link_keys sent to %@ (%d keys)", requester, count)
        // Имя устройства знает только сервер — резолвим, чтобы UI сказал ««iPhone» подключён».
        let name = (try? await devices.list())?.devices
            .first(where: { $0.id == requester })?.name ?? ""
        deviceLinkedOut.send(LinkedDevice(name: name, threadCount: count))
        // Серверное приглашение (если это был путь LINK_DEVICE) гасим, чтобы не висело.
        if let token = h.token, !token.trimmed().isEmpty {
            try? await api.postIgnoringResponse(
                "devices/pairing/consume", body: PairingConsumeRequest(token: token)
            )
        }
        return true
    }

    /// Шифрует ВСЕ ключи тредов в пакет device_link_keys для устройства toDeviceId.
    private func sendDeviceLinkKeys(toDeviceId: String) async throws -> Int {
        guard let identity = keyStore.identity() else {
            throw SecretContractError(message: "Ключи устройства не готовы")
        }
        let keys = keyStore.allThreadKeys()
        let claim: ClaimPrekeyResponse = try await devices.claimPrekey(deviceId: toDeviceId)
        guard let prekey = claim.prekey else {
            throw SecretContractError(message: "У устройства нет свободных prekey")
        }
        let fromDeviceId = deviceIdProvider.deviceId()
        guard let prekeyPublic = SecretCrypto.b64UrlDecode(prekey.publicKey),
              let shared = SecretCrypto.scalarMult(secret: identity.secretKey, peerPublic: prekeyPublic) else {
            throw SecretContractError(message: "битый prekey устройства-получателя")
        }
        let salt = SecretCrypto.randomBytes(32)
        let info = "eblusha:secret_pkg:device_link_keys:to:\(toDeviceId):from:\(fromDeviceId):prekey:\(prekey.keyId)"
        let sessionKey = SecretCrypto.hkdfSha256(
            ikm: shared, salt: salt, info: Data(info.utf8), length: SecretCrypto.keyBytes
        )

        // Формат payload дословно как у веба (exportSecretThreadKeys):
        // {threadKeys:{version,exportedAt,keys:{id:{key,createdAt,version}}}}
        let now = nowMs()
        var keysObject: [String: Any] = [:]
        for (threadId, key) in keys {
            keysObject[threadId] = [
                "key": SecretCrypto.b64UrlEncode(key),
                "createdAt": now,
                "version": 1,
            ] as [String: Any]
        }
        let payload: [String: Any] = [
            "threadKeys": [
                "version": 1,
                "exportedAt": now,
                "keys": keysObject,
            ] as [String: Any],
            "kind": "device_link_keys",
            "v": 1,
            "ts": now,
        ]
        let payloadData = try JSONSerialization.data(withJSONObject: payload)
        let nonce = SecretCrypto.randomNonce()
        guard let cipher = SecretCrypto.secretBox(message: payloadData, nonce: nonce, key: sessionKey) else {
            throw SecretContractError(message: "Не удалось зашифровать пакет")
        }
        try await sendEnvelope(SecretDirectEnvelope(
            toDeviceId: toDeviceId,
            msgId: Self.uuid(),
            createdAt: Self.isoNow(),
            ciphertext: SecretCrypto.b64UrlEncode(cipher),
            contentType: "ref",
            headerJson: SecretHeader(
                v: 1,
                kind: "key_package",
                nonce: SecretCrypto.b64UrlEncode(nonce),
                packageKind: "device_link_keys",
                recipientDeviceId: toDeviceId,
                initiatorDeviceId: fromDeviceId,
                initiatorIdentityKey: SecretCrypto.b64UrlEncode(identity.publicKey),
                prekeyId: prekey.keyId,
                handshakeSalt: SecretCrypto.b64UrlEncode(salt),
                hkdfInfo: info,
                alg: "xsalsa20_poly1305+hkdf_sha256"
            ),
            ttlSeconds: 3600
        ))
        return keys.count
    }

    /// Приём связки: расшифровка тем же handshake, что и thread_key, затем merge
    /// (без перетирания существующих ключей).
    private func importDeviceLinkKeys(_ item: SecretInboxItemDto) async -> Bool {
        // Связку принимаем ТОЛЬКО от своего устройства: пакет шифруется на наш ПУБЛИЧНЫЙ
        // prekey, который сервер отдаёт кому угодно, так что «расшифровалось» ≠ «прислали
        // свои». Чужая связка подсунула бы подставные ключи для тредов, которых у нас нет.
        let sender = (item.headerJson.initiatorDeviceId ?? "").trimmed()
        let senderIsOurs = ((try? await devices.list())?.devices.contains(where: { $0.id == sender })) ?? false
        guard senderIsOurs else {
            NSLog("SecretE2EE: device_link_keys from foreign device %@ — dropped", sender)
            return true // не наше — ack, чтобы не копилось, но НЕ импортируем
        }
        guard let plain = openKeyPackage(item),
              let payload = (try? JSONSerialization.jsonObject(with: plain)) as? [String: Any],
              let keysObj = (payload["threadKeys"] as? [String: Any])?["keys"] as? [String: Any] else {
            return false
        }
        var incomingKeys: [String: Data] = [:]
        for (threadId, rec) in keysObj {
            guard let keyB64 = (rec as? [String: Any])?["key"] as? String,
                  let bytes = SecretCrypto.b64UrlDecode(keyB64),
                  bytes.count == SecretCrypto.keyBytes else { continue }
            incomingKeys[threadId] = bytes
        }
        let added = keyStore.mergeThreadKeys(incomingKeys)
        NSLog("SecretE2EE: device link: received %d thread keys, %d new", incomingKeys.count, added)
        deviceLinked.send(added)
        for threadId in incomingKeys.keys { keyImported.send(threadId) }
        return true
    }

    private static func parseAddDeviceQr(_ raw: String) -> String? {
        guard raw.contains(addDeviceQrPrefix) else { return nil }
        let token = raw.components(separatedBy: addDeviceQrPrefix).last?.trimmed() ?? ""
        return token.isEmpty ? nil : token
    }

    private static func parseLinkDeviceQr(_ raw: String) -> String? {
        guard raw.contains(linkDeviceQrPrefix) else { return nil }
        let token = raw.components(separatedBy: linkDeviceQrPrefix).last?.trimmed() ?? ""
        return token.isEmpty ? nil : token
    }

    // MARK: - Фанаут получателей

    private func invalidateReceivers(_ threadId: String?) {
        stateLock.withStateLock {
            if let threadId {
                receiverCache.removeValue(forKey: threadId)
            } else {
                receiverCache.removeAll()
            }
        }
    }

    private func gatherReceiverDeviceIds(threadId: String, peerUserIds: [String]) async -> [String] {
        let now = nowMs()
        if let cached = stateLock.withStateLock({ receiverCache[threadId] }),
           now - cached.atMs < Self.receiverCacheTtlMs {
            return cached.ids
        }
        let myDeviceId = deviceIdProvider.deviceId()
        // Устройства собеседников + свои ДРУГИЕ устройства (multi-device sync). Текущее
        // устройство исключено: локальное эхо уже рисует сообщение, а свой же конверт лишь
        // гонял бы notify→pull→ack наперегонки с самой отправкой.
        var targets = peerUserIds
        if let me = session.currentUserId() { targets.append(me) }
        let uniqueTargets = orderedDistinct(targets)
        let results: [Result<[String], Error>] = await withTaskGroup(
            of: (Int, Result<[String], Error>).self
        ) { group in
            for (index, userId) in uniqueTargets.enumerated() {
                group.addTask {
                    do {
                        let bundles = try await self.devices.prekeyBundles(userId: userId).bundles
                        return (index, .success(bundles.map(\.deviceId)))
                    } catch {
                        return (index, .failure(error))
                    }
                }
            }
            var collected = [Result<[String], Error>](repeating: .success([]), count: uniqueTargets.count)
            for await (index, result) in group { collected[index] = result }
            return collected
        }
        let ids = orderedDistinct(results.flatMap { (try? $0.get()) ?? [] }).filter { $0 != myDeviceId }
        // Кэшируем ТОЛЬКО полное разрешение: кэш частичного списка (один пользователь не
        // зарезолвился) молча выкидывал бы все его устройства из фанаута на весь TTL.
        let complete = results.allSatisfy { if case .success = $0 { return true } else { return false } }
        if complete && !ids.isEmpty {
            stateLock.withStateLock { receiverCache[threadId] = (now, ids) }
        }
        return ids
    }

    // MARK: - Мелкие помощники

    private static func generatePrekeys(_ n: Int) -> ([PrekeyUpload], [String: Data]) {
        var uploads: [PrekeyUpload] = []
        uploads.reserveCapacity(n)
        var secrets: [String: Data] = [:]
        for _ in 0..<n {
            let kp = SecretCrypto.generateKeyPair()
            let keyId = uuid()
            let pub = SecretCrypto.b64UrlEncode(kp.publicKey)
            uploads.append(PrekeyUpload(
                keyId: keyId, publicKey: pub, oneTimePreKeyId: keyId, oneTimePreKeyPublic: pub
            ))
            secrets[keyId] = kp.secretKey
        }
        return (uploads, secrets)
    }

    private static func imageDimensions(_ bytes: Data) -> (width: Int, height: Int)? {
        guard let image = UIImage(data: bytes) else { return nil }
        let width = Int(image.size.width * image.scale)
        let height = Int(image.size.height * image.scale)
        guard width > 0, height > 0 else { return nil }
        return (width, height)
    }

    /// Размеры видео (аналог MediaMetadataRetriever): AVURLAsset читает только файл —
    /// пишем плейнтекст во временный и убираем. preferredTransform уже учитывает
    /// портретную съёмку (повёрнутый landscape-поток), как rotation в оригинале.
    private static func videoDimensions(_ bytes: Data, mime: String) async -> (width: Int, height: Int)? {
        let ext = mime.localizedCaseInsensitiveContains("quicktime") ? "mov" : "mp4"
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("secret-dims-\(UUID().uuidString)")
            .appendingPathExtension(ext)
        defer { try? FileManager.default.removeItem(at: tmp) }
        do {
            try bytes.write(to: tmp)
            let asset = AVURLAsset(url: tmp)
            guard let track = try await asset.loadTracks(withMediaType: .video).first else { return nil }
            let (naturalSize, transform) = try await track.load(.naturalSize, .preferredTransform)
            let rect = CGRect(origin: .zero, size: naturalSize).applying(transform)
            let width = Int(abs(rect.width).rounded())
            let height = Int(abs(rect.height).rounded())
            guard width > 0, height > 0 else { return nil }
            return (width, height)
        } catch {
            return nil
        }
    }

    private static func attCacheDirectory() -> URL {
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        return caches.appendingPathComponent(attCacheDir, isDirectory: true)
    }

    private static func threadCachePrefix(_ threadId: String) -> String {
        String(sha256Hex(threadId).prefix(16)) + "_"
    }

    private static func sha256Hex(_ s: String) -> String {
        SHA256.hash(data: Data(s.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    /// UUID в нижнем регистре — как UUID.randomUUID().toString() у Android и uuid веба.
    private static func uuid() -> String { UUID().uuidString.lowercased() }

    /// Instant.now().toString(): ISO с миллисекундами и Z.
    private static func isoNow() -> String {
        millisToIso(Int64(Date().timeIntervalSince1970 * 1000))
    }

    private func nowMs() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }

    private func orderedDistinct(_ values: [String]) -> [String] {
        var seen = Set<String>()
        return values.filter { seen.insert($0).inserted }
    }
}

/// Аналог kotlin `error`/`require`: нарушение контракта — обычная ошибка, а не краш
/// (safeApiCall превратит её в текст баннера, как в оригинале).
private struct SecretContractError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

private extension SecretRepository {
    /// objectKey из "/api/files/{key}" — фолбэк, когда сервер не вернул path
    /// (порт `uploaded.url.substringAfter("/api/files/")`).
    static func pathFromFilesUrl(_ url: String) -> String {
        guard let range = url.range(of: "/api/files/") else { return url }
        return String(url[range.upperBound...])
    }
}

private extension NSLock {
    /// Локальный аналог withLock (fileprivate-хелпер SessionStore недоступен отсюда).
    func withStateLock<T>(_ body: () -> T) -> T {
        lock()
        defer { unlock() }
        return body()
    }
}
