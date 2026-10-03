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
    /// Устройство (пере)зарегистрировано на сервере — можно привязывать push-токены.
    var onDeviceBootstrapped: (() -> Void)?

    /// Расшифрованные сообщения тредов, пришедшие через инбокс (realtime-путь).
    let incoming = PassthroughSubject<DecryptedSecretMessage, Never>()

    /// threadId, чей ключ только что импортирован — сбросить очередь отправки / передешифровать.
    let keyImported = PassthroughSubject<String, Never>()

    /// Число импортированных ключей, когда связка приехала с доверенного устройства.
    let deviceLinked = PassthroughSubject<Int, Never>()

    /// Мы отдали связку ключей другому своему устройству (имя + сколько тредов).
    let deviceLinkedOut = PassthroughSubject<LinkedDevice, Never>()

    /// Ключ треда автоматически сменён по пакету проверенного участника (решение владельца).
    struct KeyRotation: Equatable {
        let threadId: String
        let senderUserId: String
    }

    /// Не молча (H01): экран беседы показывает плашку «ключ шифрования сменился», как тост веба.
    let keyRotated = PassthroughSubject<KeyRotation, Never>()

    /// X5: НАШ id отозван (бутстрап увидел revoked, register 409/410 «revoked»). Ключи уже
    /// стёрты и id сменён; RootView выходит из аккаунта (как `device:revoked`). Новый id в этой
    /// сессии не регистрируется — только после следующего входа.
    let deviceRevokedLocally = PassthroughSubject<String, Never>()

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

    // Участники SECRET-тредов, в которых мы состоим: threadId → userId участников (H01/H03).
    // Состав 1:1-секретки не меняется, поэтому кэш только положительный; промах — повод
    // перечитать список бесед (не чаще membershipRefetchMs).
    private var membershipCache: [String: Set<String>] = [:]
    private var membershipFetchStartedMs: Int64 = 0
    // H04: prekeys_needed пополняет пул не чаще раза в prekeysNeededThrottleMs.
    private var lastPrekeysNeededReplenishMs: Int64 = 0
    // connect_error DEVICE_REVOKED сыплется на каждый реконнект — сверяемся со списком
    // устройств не чаще раза в revocationCheckThrottleMs.
    private var lastRevocationCheckMs: Int64 = 0
    // Треды, где ключ сменился, пока экран беседы не был открыт: плашка покажется при открытии.
    private var rotationNotices: Set<String> = []
    // X5: номер сессии (SessionStore.generation), в которой замечен отзыв нашего id. Пока эта
    // сессия жива — ни одной регистрации: иначе отозванный (украденный) телефон в окне живого
    // access-токена заводил бы НОВОЕ живое устройство аккаунта и снова получал ключи и пуши.
    private var revokedInSession: Int64 = -1

    // Бутстрап может стереть ключи и сменить id (X5/H13) — параллельный бутстрап в этот
    // момент зарегистрировал бы на сервере уже стёртую идентичность. Сериализуем.
    private let bootstrapGate = AsyncSemaphore(1)

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
    /// Сколько невыданных OPK на сервере достаточно, чтобы новых не публиковать (как веб:
    /// MIN_SERVER_PREKEY_RESERVE). Иначе каждый prekeys_needed добавлял бы +50 секретов.
    static let minServerPrekeyReserve = 20
    /// Серверный потолок невыданных OPK на устройство (devices.ts MAX_UNCONSUMED_PREKEYS_PER_DEVICE).
    static let serverPrekeyCap = 250
    private static let prekeysNeededThrottleMs: Int64 = 60_000
    private static let membershipRefetchMs: Int64 = 2_000
    private static let revocationCheckThrottleMs: Int64 = 30_000

    // MARK: - Бутстрап устройства

    /// Генерирует идентичность + prekeys этого устройства и регистрирует их
    /// (идемпотентно для устройства). false — сбой сети/сервера, повторить позже.
    @discardableResult
    func ensureDeviceBootstrap() async -> Bool {
        if registrationBlocked() { return false }
        if keyStore.isBootstrapped() { return true }
        return await bootstrapGate.withPermit { await self.bootstrapLocked() }
    }

    /// Отзыв нашего id замечен в текущей сессии — до выхода ничего не регистрируем.
    func registrationBlocked() -> Bool {
        let generation = session.generation()
        return stateLock.withStateLock { revokedInSession == generation }
    }

    /// Отметить отзыв (только при живой сессии: отметка «после выхода» заперла бы следующий вход).
    func noteDeviceRevoked() {
        guard session.currentRefreshToken() != nil else { return }
        let generation = session.generation()
        stateLock.withStateLock { revokedInSession = generation }
    }

    /// X5: наш id отозван — стереть ключи, новый id, запрет регистрации до выхода и сигнал
    /// RootView на выход (как веб на `device:revoked` и Android `onDeviceRevoked`).
    private func handleOwnDeviceRevoked(reason: String) {
        wipeDeviceKeys(reason: reason)
        noteDeviceRevoked()
        deviceRevokedLocally.send(reason)
    }

    private func bootstrapLocked() async -> Bool {
        if registrationBlocked() { return false }
        if keyStore.isBootstrapped() { return true } // пока ждали замок, бутстрап уже прошёл
        if !SecretCrypto.selfTest() {
            NSLog("SecretE2EE: SecretCrypto self-test FAILED — interop will not work")
        }
        // Keychain не ответил (до первой разблокировки после ребута) — это НЕ «идентичности
        // нет»: новая поверх старой разошлась бы с тем, что знает сервер. Повторим позже.
        let identityState = keyStore.identityState()
        if identityState == .unavailable {
            NSLog("SecretE2EE: keychain unavailable — device bootstrap postponed")
            return false
        }
        var rotated = false
        // Что сервер знает о текущем id (nil — спросить не удалось: решаем без него).
        let status = await ownDeviceStatus()
        if status == .revoked {
            // X5: отозванный id не воскрешаем перерегистрацией (сервер пока снимает отзыв
            // молча) — и не заводим вместо него НОВОЕ устройство в этой же сессии: ключи
            // стираются, id меняется, и приложение выходит из аккаунта. Новое устройство —
            // только после следующего входа (ключи секреток оно получит через привязку).
            handleOwnDeviceRevoked(reason: "device id is revoked")
            return false
        } else if identityState == .missing,
                  status == .live || (status == nil && deviceIdProvider.wasRegistered(deviceIdProvider.deviceId())) {
            // H13: идентичность стёрта (выход, сбой), а id прежний. Под ним на сервере лежат
            // неизрасходованные OPK, секретов к которым больше нет, — claim отдаёт самые
            // старые, и пакеты ключей не вскрылись бы. Новый id = чистое новое устройство.
            let fresh = deviceIdProvider.rotate()
            NSLog("SecretE2EE: device keys were wiped but the id is registered — rotated to %@", fresh)
            rotated = true
        }
        for attempt in 0..<2 {
            let identity = keyStore.loadOrCreateIdentity()
            let (uploads, secrets) = Self.generatePrekeys(Self.prekeyBatch)
            keyStore.addPrekeySecrets(secrets)
            let pub = SecretCrypto.b64UrlEncode(identity.publicKey)
            let deviceId = deviceIdProvider.deviceId()
            do {
                let accepted = try await devices.register(RegisterDeviceRequest(
                    deviceId: deviceId,
                    name: "iPhone",
                    platform: "ios",
                    publicKey: pub,
                    identityPublicKey: pub,
                    prekeys: uploads
                ))
                dropRejectedPrekeys(published: secrets.keys, accepted: accepted)
                deviceIdProvider.markRegistered(deviceId)
                keyStore.setBootstrapped()
                NSLog("SecretE2EE: device E2EE bootstrap complete")
                if rotated { onDeviceIdRotated?() }
                onDeviceBootstrapped?()
                return true
            } catch let error as HTTPError where (error.code == 409 || error.code == 410) && attempt == 0 {
                // Сервер регистрацию отверг — эти prekeys он не принял.
                keyStore.removePrekeySecrets(secrets.keys)
                if await isRevokedConflict(error) {
                    // Будущий серверный запрет (S5): отозванный id не регистрируется — и новый
                    // в этой сессии тоже (выход; см. выше).
                    handleOwnDeviceRevoked(reason: "register refused: device revoked")
                    return false
                } else {
                    // 409 = этот id установки закреплён за ДРУГИМ аккаунтом. Без ротации
                    // бутстрап не проходил бы НИКОГДА, а x-device-id указывал бы на чужое
                    // устройство → /secret/inbox/pull 400 и realtime секреток мёртв.
                    let fresh = deviceIdProvider.rotate()
                    NSLog("SecretE2EE: device id was taken by another account — rotated to %@", fresh)
                }
                rotated = true
            } catch {
                // Сбой сети: секреты НЕ удаляем — регистрация могла дойти, а ответ потеряться.
                NSLog("SecretE2EE: device bootstrap failed: %@", String(describing: error))
                if rotated { onDeviceIdRotated?() }
                return false
            }
        }
        if rotated { onDeviceIdRotated?() }
        return false
    }

    /// Что сервер знает о нашем устройстве.
    enum OwnDeviceStatus: Equatable {
        case live
        case revoked
        /// Сервер такого id у нас не знает (не регистрировались, восстановление БД).
        case missing
    }

    static func ownDeviceStatus(_ devices: [DeviceDto], myId: String) -> OwnDeviceStatus {
        guard let mine = devices.first(where: { $0.id == myId }) else { return .missing }
        return mine.revokedAt == nil ? .live : .revoked
    }

    /// nil — спросить не удалось (сеть, нет сессии).
    func ownDeviceStatus() async -> OwnDeviceStatus? {
        guard let list = try? await devices.list().devices else { return nil }
        return Self.ownDeviceStatus(list, myId: deviceIdProvider.deviceId())
    }

    private func isRevokedConflict(_ error: HTTPError) async -> Bool {
        if error.code == 410 { return true }
        let body = String(data: error.body, encoding: .utf8)?.lowercased() ?? ""
        if body.contains("revoked") { return true }
        return await ownDeviceStatus() == .revoked
    }

    /// Стирает ВЕСЬ ключевой материал устройства и заводит новый id (отзыв, X5).
    private func wipeDeviceKeys(reason: String) {
        try? FileManager.default.removeItem(at: Self.attCacheDirectory())
        stateLock.withStateLock {
            localInvite = nil
            membershipCache.removeAll()
        }
        invalidateReceivers(nil)
        keyStore.clear()
        let fresh = deviceIdProvider.rotate()
        NSLog("SecretE2EE: %@ — device keys wiped, new device id %@", reason, fresh)
    }

    /// Что делать с сигналом отзыва из сокета.
    enum RevocationVerdict: Equatable {
        /// Отозвано именно это устройство (или весь аккаунт) — выйти и стереть ключи (как веб).
        case logout
        /// Id ещё не зарегистрирован (бутстрап не успел) — зарегистрироваться и переподключиться.
        case rebootstrap
        case ignore
    }

    /// `device:revoked` сервер шлёт в комнату устройства (deviceId) или всего аккаунта
    /// ("*": бан/удаление). connect_error `DEVICE_REVOKED` значит лишь, что ни один id
    /// рукопожатия не жив, — это и отзыв, и «новый id ещё не успел зарегистрироваться»;
    /// различаем по списку устройств (Б6: самолечение не отключать).
    static func revocationVerdict(
        revokedDeviceId: String?,
        viaConnectError: Bool,
        myDeviceId: String,
        status: OwnDeviceStatus?
    ) -> RevocationVerdict {
        if !viaConnectError {
            guard let id = revokedDeviceId?.trimmed(), id == "*" || id == myDeviceId else { return .ignore }
            return .logout
        }
        // Рукопожатие шло со старым id (его уже сменили) — сокет и так пересобирается.
        if let id = revokedDeviceId, id != myDeviceId { return .ignore }
        switch status {
        case .revoked?: return .logout
        case .missing?: return .rebootstrap
        case .live?, nil: return .ignore // не смогли спросить: мёртвая сессия умрёт на 401 сама
        }
    }

    func revocationVerdict(revokedDeviceId: String?, viaConnectError: Bool) async -> RevocationVerdict {
        let myId = deviceIdProvider.deviceId()
        guard viaConnectError else {
            return Self.revocationVerdict(
                revokedDeviceId: revokedDeviceId, viaConnectError: false, myDeviceId: myId, status: nil
            )
        }
        if let id = revokedDeviceId, id != myId { return .ignore }
        let now = nowMs()
        let allowed: Bool = stateLock.withStateLock {
            guard now - lastRevocationCheckMs > Self.revocationCheckThrottleMs else { return false }
            lastRevocationCheckMs = now
            return true
        }
        guard allowed else { return .ignore }
        return Self.revocationVerdict(
            revokedDeviceId: revokedDeviceId,
            viaConnectError: true,
            myDeviceId: myId,
            status: await ownDeviceStatus()
        )
    }

    /// Устройство отозвано (или не зарегистрировано), а сессия жива: сбросить флаг
    /// бутстрапа и пройти его заново — он сам решит, нужен ли новый id.
    func rebootstrapDevice() async -> Bool {
        keyStore.clearBootstrapped()
        return await ensureDeviceBootstrap()
    }

    /// Пополняет пул one-time prekeys (сервер сообщает об иссякании: kind="prekeys_needed",
    /// перед accept, привязкой и ручным «Повторить»).
    ///
    /// H04: публикует, только если на сервере невыданных меньше minServerPrekeyReserve
    /// (иначе каждый prekeys_needed добавлял бы +50 секретов без предела), и ровно столько,
    /// сколько сервер примет; секреты не принятых сервером ключей тут же удаляются.
    @discardableResult
    func replenishPrekeys(count: Int = SecretRepository.prekeyBatch) async -> Bool {
        let deviceId = deviceIdProvider.deviceId()
        var toPublish = count
        if let available = await serverAvailablePrekeys(deviceId) {
            guard available < Self.minServerPrekeyReserve else { return true }
            toPublish = min(count, max(0, Self.serverPrekeyCap - available))
            guard toPublish > 0 else { return true }
        }
        let (uploads, secrets) = Self.generatePrekeys(toPublish)
        // Секреты пишем ДО публикации: ключ, выданный сервером раньше, чем мы успели бы
        // сохранить его секрет, не вскрылся бы никогда.
        keyStore.addPrekeySecrets(secrets)
        do {
            let accepted = try await devices.publishPrekeys(
                deviceId: deviceId,
                PublishPrekeysRequest(prekeys: uploads)
            )
            dropRejectedPrekeys(published: secrets.keys, accepted: accepted)
            keyStore.prunePrekeySecrets()
            return true
        } catch let error as HTTPError where (400..<500).contains(error.code) {
            // Сервер отказал явно (отозвано/неизвестно/лимит) — ничего не принял, секреты бесполезны.
            keyStore.removePrekeySecrets(secrets.keys)
            NSLog("SecretE2EE: prekey replenish refused: HTTP %d", error.code)
            return false
        } catch {
            NSLog("SecretE2EE: prekey replenish failed: %@", String(describing: error))
            return false
        }
    }

    /// Пополнение по сигналу prekeys_needed — не чаще раза в минуту: шторм таких конвертов
    /// (в проде их 15 тыс.) иначе превращался бы в шторм публикаций.
    private func replenishPrekeysOnDemand() async {
        let now = nowMs()
        let allowed: Bool = stateLock.withStateLock {
            guard now - lastPrekeysNeededReplenishMs > Self.prekeysNeededThrottleMs else { return false }
            lastPrekeysNeededReplenishMs = now
            return true
        }
        guard allowed else { return }
        await replenishPrekeys()
    }

    /// Сколько невыданных OPK видит сервер у нашего устройства; nil — не знаем.
    private func serverAvailablePrekeys(_ deviceId: String) async -> Int? {
        guard let list = try? await devices.list().devices,
              let mine = list.first(where: { $0.id == deviceId }),
              mine.revokedAt == nil else { return nil }
        return mine.availablePrekeys
    }

    /// Сервер принимает не больше 250 невыданных OPK; не принятые перечислены неявно —
    /// их нет в insertedKeyIds. Их секреты хранить незачем.
    private func dropRejectedPrekeys<S: Sequence>(published: S, accepted: PrekeysAcceptedResponse)
    where S.Element == String {
        guard let inserted = accepted.insertedKeyIds else { return } // старый сервер: не знаем
        let insertedSet = Set(inserted)
        let rejected = published.filter { !insertedSet.contains($0) }
        if !rejected.isEmpty { keyStore.removePrekeySecrets(rejected) }
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
            // H12: элементы, которые не разобрались (заголовок неверной формы), подтверждаем —
            // иначе они навсегда стоят в голове очереди (сервер отдаёт первые 50) и клинят
            // все входящие: ключи, сообщения, связывание.
            var acks: [String] = resp.undecodableMsgIds
            if !resp.undecodableMsgIds.isEmpty {
                NSLog("SecretE2EE: %d malformed inbox envelope(s) skipped and acked", resp.undecodableMsgIds.count)
            }
            guard !items.isEmpty || !acks.isEmpty else { return }
            let myDeviceId = deviceIdProvider.deviceId()
            // OPK, которыми вскрыли пакеты: удалятся через сутки после ack (одноразовые, H04).
            var usedPrekeys: [String] = []
            var prekeysNeeded = false
            for item in items {
                let h = item.headerJson
                if h.kind == "key_package", h.packageKind == "thread_key" {
                    switch await importKeyPackage(item) {
                    case .imported(let threadId, let change):
                        acks.append(item.msgId)
                        poisonAttempts.removeValue(forKey: item.msgId)
                        if let prekeyId = h.prekeyId { usedPrekeys.append(prekeyId) }
                        keyImported.send(threadId)
                        if change == .replaced {
                            // Ключ сменился (автоматически, от проверенного участника) — не молча.
                            let rotation = KeyRotation(threadId: threadId, senderUserId: item.senderUserId?.trimmed() ?? "")
                            stateLock.withStateLock { _ = rotationNotices.insert(threadId) }
                            keyRotated.send(rotation)
                        }
                        // Квитанция инициатору, чтобы он перестал переслать (веб-паритет).
                        if let initiator = h.initiatorDeviceId?.trimmed(), !initiator.isEmpty, initiator != myDeviceId {
                            try? await sendControl(
                                toDeviceId: initiator,
                                header: SecretHeader(
                                    kind: "control",
                                    threadId: threadId,
                                    type: "key_receipt",
                                    fromDeviceId: myDeviceId
                                )
                            )
                        }
                    case .rejected(let reason, let opened):
                        NSLog("SecretE2EE: thread_key %@ rejected: %@", item.msgId, reason)
                        acks.append(item.msgId)
                        poisonAttempts.removeValue(forKey: item.msgId)
                        if opened, let prekeyId = h.prekeyId { usedPrekeys.append(prekeyId) }
                    case .retry(let reason):
                        NSLog("SecretE2EE: thread_key %@ postponed: %@", item.msgId, reason)
                        registerPoisonFailure(item.msgId, acks: &acks)
                    case .deferred(let reason):
                        // Не ack и не отравление: ждём сети, срок жизни конверта ведёт сервер.
                        NSLog("SecretE2EE: thread_key %@ deferred: %@", item.msgId, reason)
                    case .linked:
                        acks.append(item.msgId)
                    }
                } else if h.kind == "key_package", h.packageKind == "device_link_keys" {
                    // Привязка устройства: связка ВСЕХ ключей тредов с доверенного устройства.
                    switch await importDeviceLinkKeys(item) {
                    case .linked, .imported:
                        acks.append(item.msgId)
                        poisonAttempts.removeValue(forKey: item.msgId)
                        if let prekeyId = h.prekeyId { usedPrekeys.append(prekeyId) }
                    case .rejected(let reason, let opened):
                        NSLog("SecretE2EE: device_link_keys %@ rejected: %@", item.msgId, reason)
                        acks.append(item.msgId)
                        poisonAttempts.removeValue(forKey: item.msgId)
                        if opened, let prekeyId = h.prekeyId { usedPrekeys.append(prekeyId) }
                    case .retry(let reason):
                        NSLog("SecretE2EE: device_link_keys %@ postponed: %@", item.msgId, reason)
                        registerPoisonFailure(item.msgId, acks: &acks)
                    case .deferred(let reason):
                        NSLog("SecretE2EE: device_link_keys %@ deferred: %@", item.msgId, reason)
                    }
                } else if h.kind == "link_device_join" {
                    // Другое НАШЕ устройство просит связку ключей, предъявляя token/code
                    // нашего приглашения. Отдаём ТОЛЬКО при совпадении с активным локальным
                    // приглашением (веб отдаёт без проверки — намеренно строже: иначе любое
                    // добавленное в аккаунт устройство молча выкачивало бы все ключи).
                    // Своё-без-приглашения НЕ ack-ается (доживёт TTL до момента, когда
                    // пользователь откроет приглашение); чужое и негодное — ack (X3).
                    if await handleLinkDeviceJoin(item) { acks.append(item.msgId) }
                } else if h.kind == "control" {
                    switch await handleControl(item) {
                    case .done: acks.append(item.msgId)
                    case .retry: registerPoisonFailure(item.msgId, acks: &acks)
                    }
                } else if h.kind == "prekeys_needed" {
                    prekeysNeeded = true // один раз на пачку, с троттлом и сверкой с сервером (H04)
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
            if prekeysNeeded { await replenishPrekeysOnDemand() }
            // Сервер принимает в ack только UUID и отвергает ВЕСЬ запрос из-за одного кривого
            // id — такой (неоткуда ему взяться, но всё же) не должен держать остальные.
            let ackable = orderedDistinct(acks.filter { UUID(uuidString: $0) != nil })
            if !ackable.isEmpty {
                try await api.postIgnoringResponse("secret/inbox/ack", body: SecretAckRequest(msgIds: ackable))
            }
            if !usedPrekeys.isEmpty {
                keyStore.markPrekeysUsed(usedPrekeys)
                keyStore.prunePrekeySecrets()
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
            let me = self.session.currentUserId()
            var query = [
                URLQueryItem(name: "threadId", value: conversationId),
                URLQueryItem(name: "limit", value: String(limit)),
            ]
            if let cursor { query.append(URLQueryItem(name: "cursor", value: cursor)) }
            // Строки неверной формы разбор страницы пропускает (H12), а не падает целиком.
            let resp: SecretHistoryResponse = try await self.api.get("secret/history", query: query)
            if resp.skippedCount > 0 {
                NSLog("SecretE2EE: history of %@: %d malformed row(s) skipped", conversationId, resp.skippedCount)
            }
            let keys = self.keyStore.threadKeysForDecrypt(conversationId) // текущий, затем прежние
            let messages = resp.items.compactMap { item -> DecryptedSecretMessage? in
                // Пер-строчный guard: одна битая строка не должна валить страницу навсегда.
                guard let nonceB64 = item.headerJson.nonce else { return nil }
                let plain = Self.openWithKeys(keys, cipherB64: item.ciphertext, nonceB64: nonceB64)
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

    enum ControlOutcome: Equatable {
        case done
        /// Проверить запрос сейчас нечем (сеть) — оставить в инбоксе (с учётом отравления).
        case retry
    }

    /// Адресат ответа на key_request — ТОЛЬКО устройство, названное в заголовке
    /// (requesterDeviceId, у старых — fromDeviceId). senderDeviceId — это did отправителя без
    /// проверки владельца (X8): запасным адресатом ключа он больше не служит.
    static func keyRequestTarget(_ h: SecretHeader, myDeviceId: String) -> String? {
        let candidate = (h.requesterDeviceId ?? h.fromDeviceId)?.trimmed() ?? ""
        guard !candidate.isEmpty, candidate != myDeviceId else { return nil }
        return candidate
    }

    /// Другое устройство просит ключ треда (пропущенный/протухший пакет) — пересылаем,
    /// если держим. H03: ключ уходит только УЧАСТНИКУ этого SECRET-треда (senderUserId
    /// ставит сервер из авторизации) и только на его ЖИВОЕ устройство — раньше его получал
    /// любой, кто знал threadId и назвал в заголовке любое устройство.
    private func handleControl(_ item: SecretInboxItemDto) async -> ControlOutcome {
        let h = item.headerJson
        switch h.type ?? "" {
        case "key_request", "key_resend_request":
            guard let threadId = h.threadId?.trimmed(), !threadId.isEmpty else { return .done }
            guard let requester = Self.keyRequestTarget(h, myDeviceId: deviceIdProvider.deviceId()) else {
                return .done
            }
            guard let key = keyStore.threadKey(threadId), let identity = keyStore.identity() else { return .done }
            guard let sender = item.senderUserId?.trimmed(), !sender.isEmpty else { return .done }
            switch await threadMembership(threadId) {
            case .unknown:
                return .retry
            case .notMember:
                NSLog("SecretE2EE: key_request for %@ ignored — not our secret thread", threadId)
                return .done
            case .members(let members):
                guard members.contains(sender) else {
                    NSLog("SecretE2EE: key_request for %@ from non-participant %@ ignored", threadId, sender)
                    return .done
                }
            }
            // Устройство-адресат обязано быть живым устройством САМОГО просящего (bundles
            // отдают только не отозванные).
            guard let senderDevices = try? await devices.prekeyBundles(userId: sender).bundles.map(\.deviceId) else {
                return .retry
            }
            guard senderDevices.contains(requester) else {
                NSLog("SecretE2EE: key_request for %@ names device %@ not owned by %@ — ignored", threadId, requester, sender)
                return .done
            }
            invalidateReceivers(threadId) // заговорило устройство, о котором мы могли не знать
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
            return .done
        default:
            return .done // key_receipt и прочее — информационные
        }
    }

    // MARK: - Участники секретных тредов (H01/H03)

    enum ThreadMembership: Equatable {
        /// SECRET-тред, в котором мы состоим; userId всех участников (включая нас).
        case members(Set<String>)
        /// Не наш тред, не секретный или не существует.
        case notMember
        /// Проверить не удалось (сеть) — решать позже.
        case unknown
    }

    func threadMembership(_ threadId: String) async -> ThreadMembership {
        if let cached = stateLock.withStateLock({ membershipCache[threadId] }) { return .members(cached) }
        // Промах: перечитываем список бесед. Если свежий (моложе membershipRefetchMs)
        // список уже есть и треда в нём нет — тред не наш: шторм чужих конвертов не
        // превращается в шторм GET /conversations.
        let startedAt = nowMs()
        let fresh: Bool = stateLock.withStateLock { startedAt - membershipFetchStartedMs < Self.membershipRefetchMs }
        if fresh { return .notMember }
        guard let snapshot = await fetchSecretMemberships() else { return .unknown }
        stateLock.withStateLock {
            membershipCache.merge(snapshot) { _, new in new }
            membershipFetchStartedMs = max(membershipFetchStartedMs, startedAt)
        }
        return snapshot[threadId].map { .members($0) } ?? .notMember
    }

    /// threadId → участники для всех SECRET-тредов, где мы состоим; nil — сбой сети.
    private func fetchSecretMemberships() async -> [String: Set<String>]? {
        guard let resp: SecretMembershipListResponse = try? await api.get("conversations") else { return nil }
        return Self.secretMemberships(resp)
    }

    static func secretMemberships(_ resp: SecretMembershipListResponse) -> [String: Set<String>] {
        var out: [String: Set<String>] = [:]
        for row in resp.conversations.compactMap(\.value) {
            let conv = row.conversation
            let isSecret = conv.type?.uppercased() == "SECRET" || conv.isSecret == true
            guard isSecret, !conv.id.isEmpty else { continue }
            out[conv.id] = Set(conv.participants.map(\.userId).filter { !$0.isEmpty })
        }
        return out
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

    /// Итог разбора key_package.
    enum KeyPackageOutcome: Equatable {
        case imported(threadId: String, change: SecretKeyStore.ThreadKeyChange)
        /// Связка ключей с другого своего устройства: сколько ключей добавлено.
        case linked(added: Int)
        /// Негоден и годным не станет — подтвердить. opened: секрет OPK уже потрачен.
        case rejected(reason: String, opened: Bool)
        /// Сейчас не вскрыть — повторить на следующем pull (с отравлением: 20 попыток / 30 мин).
        case retry(reason: String)
        /// Проверить не удалось (сеть, Keychain, нет сессии) — НЕ подтверждать и НЕ считать
        /// отравлением: конверт живёт до серверного срока. Иначе ~20 сбоев тяжёлого
        /// GET /conversations (как раз сразу после «Принять» на плохой сети) выбрасывали
        /// честный ключ треда без импорта — веб в этом случае тоже не подтверждает.
        case deferred(reason: String)
    }

    enum ThreadKeyPayload: Equatable {
        case valid(threadId: String, key: Data)
        case invalid(String)
    }

    /// Что именно импортировать из вскрытого thread_key (Б1, Б2):
    ///  - вид пакета ВНУТРИ (если указан) обязан совпасть с packageKind заголовка — иначе
    ///    заголовок thread_key вёз бы внутри другой вид пакета;
    ///  - тред — из payload, а без него — из заголовка. Отсутствие threadId в заголовке —
    ///    норма (Б1: в проде 1527 таких пакетов от старых клиентов); если тред есть в обоих,
    ///    они обязаны совпасть — членство проверяется по тому же треду, в который ляжет ключ;
    ///  - ключ — ровно 32 байта (проверка ДО записи в Keychain: негодный ключ иначе оседал бы
    ///    в хранилище навсегда, отравляя тред).
    static func validateThreadKeyPayload(_ payload: [String: Any], header: SecretHeader) -> ThreadKeyPayload {
        let expectedKind = header.packageKind ?? "thread_key"
        if let rawKind = payload["kind"] {
            guard let kind = rawKind as? String, kind == expectedKind else {
                return .invalid("payload kind does not match header packageKind")
            }
        }
        var payloadThread: String?
        if let raw = payload["threadId"] {
            guard let value = raw as? String else { return .invalid("payload threadId is not a string") }
            let trimmed = value.trimmed()
            payloadThread = trimmed.isEmpty ? nil : trimmed
        }
        let headerTrimmed = header.threadId?.trimmed() ?? ""
        let headerThread: String? = headerTrimmed.isEmpty ? nil : headerTrimmed
        if let payloadThread, let headerThread, payloadThread != headerThread {
            return .invalid("payload threadId differs from header threadId")
        }
        guard let threadId = payloadThread ?? headerThread else { return .invalid("no threadId") }
        guard let keyB64 = payload["key"] as? String,
              let key = SecretCrypto.b64UrlDecode(keyB64),
              key.count == SecretCrypto.keyBytes else { return .invalid("thread key is not 32 bytes") }
        return .valid(threadId: threadId, key: key)
    }

    /// H01: ключ треда принимаем только от УЧАСТНИКА этого SECRET-треда (senderUserId ставит
    /// сервер из авторизации — подделать его нельзя). Смена ключа от проверенного участника —
    /// автоматическая (решение владельца), но прежний ключ остаётся для старой истории.
    private func importKeyPackage(_ item: SecretInboxItemDto) async -> KeyPackageOutcome {
        guard let plain = openKeyPackage(item) else {
            // Нет секрета OPK / не сошлось: как и раньше — повтор, затем отравление.
            return .retry(reason: "cannot open package")
        }
        guard let payload = (try? JSONSerialization.jsonObject(with: plain)) as? [String: Any] else {
            return .rejected(reason: "payload is not a JSON object", opened: true)
        }
        let threadId: String
        let key: Data
        switch Self.validateThreadKeyPayload(payload, header: item.headerJson) {
        case .invalid(let reason):
            return .rejected(reason: reason, opened: true)
        case .valid(let validThread, let validKey):
            threadId = validThread
            key = validKey
        }
        guard let sender = item.senderUserId?.trimmed(), !sender.isEmpty else {
            return .rejected(reason: "no senderUserId", opened: true)
        }
        switch await threadMembership(threadId) {
        case .unknown:
            return .deferred(reason: "thread membership unknown")
        case .notMember:
            return .rejected(reason: "not our secret thread", opened: true)
        case .members(let members):
            guard members.contains(sender) else {
                return .rejected(reason: "sender \(sender) is not a participant", opened: true)
            }
        }
        let change = keyStore.replaceThreadKey(threadId, key: key)
        switch change {
        case .rejected:
            return .deferred(reason: "keychain unavailable")
        case .replaced:
            NSLog("SecretE2EE: thread key for %@ changed by participant %@ — previous key kept for history", threadId, sender)
        case .added, .unchanged:
            NSLog("SecretE2EE: imported secret thread key for %@", threadId)
        }
        return .imported(threadId: threadId, change: change)
    }

    // MARK: - Расшифровка сообщений

    /// Текущий ключ треда, затем прежние (история, запечатанная до смены ключа).
    private func openWithThreadKeys(_ threadId: String, cipherB64: String, nonceB64: String) -> Data? {
        Self.openWithKeys(keyStore.threadKeysForDecrypt(threadId), cipherB64: cipherB64, nonceB64: nonceB64)
    }

    static func openWithKeys(_ keys: [Data], cipherB64: String, nonceB64: String) -> Data? {
        guard !keys.isEmpty,
              let cipher = SecretCrypto.b64UrlDecode(cipherB64),
              let nonce = SecretCrypto.b64UrlDecode(nonceB64) else { return nil }
        for key in keys {
            if let plain = SecretCrypto.secretBoxOpen(cipher: cipher, nonce: nonce, key: key) { return plain }
        }
        return nil
    }

    private func decryptThreadItem(threadId: String, item: SecretInboxItemDto) -> DecryptedSecretMessage? {
        let me = session.currentUserId()
        guard let nonceB64 = item.headerJson.nonce else { return nil }
        let plain = openWithThreadKeys(threadId, cipherB64: item.ciphertext, nonceB64: nonceB64)
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
        let keys = keyStore.threadKeysForDecrypt(threadId) // текущий, затем прежние
        guard !keys.isEmpty else { return nil }
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
                // Прогресс — в общий реестр под ключом ИСХОДНОГО url вложения: ровно его
                // знает плитка в пузыре, поэтому кольцо появляется на самом кадре.
                // cancellable: false — отменённая расшифровка оставила бы плитку с
                // замком навсегда, а повторить её человеку нечем.
                guard let cipher = await MediaDownloadCenter.downloadData(
                    URLRequest(url: remote),
                    key: url,
                    cancellable: false,
                    session: self.downloadSession
                ) else { return nil }
                // Guard обязателен: битый base64-nonce из враждебного дескриптора не
                // должен ронять процесс — сообщение-то остаётся в истории.
                guard let nonce = SecretCrypto.b64UrlDecode(nonceB64),
                      let plain = keys.lazy.compactMap({
                          SecretCrypto.secretBoxOpen(cipher: cipher, nonce: nonce, key: $0)
                      }).first else {
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
    ///
    /// H13: и заводим НОВЫЙ id устройства. Под прежним id на сервере остаются его
    /// неизрасходованные one-time prekeys, а их секреты мы только что стёрли; войди мы снова
    /// под тем же id с новой идентичностью — claim отдавал бы самые старые OPK, и пакеты
    /// ключей на них не вскрылись бы, пока те не выработаются. Новый id = чистое устройство
    /// (так же делает веб: deviceWipe стирает и device-info с id).
    func clearLocalData() {
        try? FileManager.default.removeItem(at: Self.attCacheDirectory())
        stateLock.withStateLock {
            localInvite = nil
            membershipCache.removeAll()
            membershipFetchStartedMs = 0
            lastPrekeysNeededReplenishMs = 0
            rotationNotices.removeAll()
        }
        invalidateReceivers(nil)
        keyStore.clear()
        deviceIdProvider.rotate()
    }

    /// Есть ли непоказанная плашка «ключ сменился» для треда; показ её снимает.
    func takeKeyRotationNotice(_ threadId: String) -> Bool {
        stateLock.withStateLock { rotationNotices.remove(threadId) != nil }
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

    enum LinkJoinDecision: Equatable {
        /// Чужой, пустой или заведомо негодный запрос — подтвердить и забыть.
        case ack
        /// Своё устройство, но приглашения сейчас нет/не то, или проверить нечем — оставить:
        /// запрос мог прийти раньше, чем пользователь открыл приглашение, и доживёт TTL (600 с).
        case keep
        case send(requester: String)
    }

    /// Решение по link_device_join (X3, Б8). Связку отдаём ТОЛЬКО если выполнено всё сразу:
    ///  - запрос прислал НАШ аккаунт (senderUserId ставит сервер) с НАШЕГО живого устройства
    ///    (deviceId любого пользователя виден всем через bundles — чужой запрос отправить
    ///    тривиально);
    ///  - предъявлен token/код ЖИВОГО приглашения, показанного на этом устройстве.
    /// Проверка «чужое» — ДО проверки приглашения: чужой запрос подтверждается сразу, иначе
    /// 50 таких конвертов от любого пользователя клинили бы инбокс (сервер отдаёт первые 50),
    /// а серверный S3 «свой-своему» этот случай не закрывает.
    static func decideLinkJoin(
        header h: SecretHeader,
        senderUserId: String?,
        me: String?,
        myDeviceId: String,
        myDevices: [DeviceDto]?,
        invite: DeviceLinkInvite?
    ) -> LinkJoinDecision {
        let requester = (h.requesterDeviceId ?? "").trimmed()
        if requester.isEmpty || requester == myDeviceId { return .ack }
        guard let me else { return .keep }                       // без сессии не решаем
        guard senderUserId?.trimmed() == me else { return .ack } // чужой аккаунт
        guard let myDevices else { return .keep }                // список не получили — позже
        guard myDevices.contains(where: { $0.id == requester && $0.revokedAt == nil }) else {
            return .ack // не наше или отозванное устройство
        }
        guard let invite, !invite.expired else { return .keep }
        // Токен — b64url, сверяется как есть (регистр значим); код — по цифрам (H14).
        let token = (h.token ?? "").trimmed()
        let tokenMatches = !token.isEmpty && constantTimeEquals(Data(token.utf8), Data(invite.token.utf8))
        let digitsOnly = (h.code ?? "").filter(\.isNumber)
        let codeMatches = !digitsOnly.isEmpty && constantTimeEquals(Data(digitsOnly.utf8), Data(invite.code.utf8))
        guard tokenMatches || codeMatches else { return .keep } // может, для приглашения на другом нашем устройстве
        return .send(requester: requester)
    }

    /// Ответ на link_device_join. true — конверт подтвердить.
    private func handleLinkDeviceJoin(_ item: SecretInboxItemDto) async -> Bool {
        let h = item.headerJson
        let me = session.currentUserId()
        let myDeviceId = deviceIdProvider.deviceId()
        let requester = (h.requesterDeviceId ?? "").trimmed()
        // Список устройств нужен только запросу от своего аккаунта — чужой отсекаем без сети.
        var myDevices: [DeviceDto]?
        if !requester.isEmpty, requester != myDeviceId, let me, item.senderUserId?.trimmed() == me {
            myDevices = try? await devices.list().devices
        }
        let decision = Self.decideLinkJoin(
            header: h,
            senderUserId: item.senderUserId,
            me: me,
            myDeviceId: myDeviceId,
            myDevices: myDevices,
            invite: currentInvite()
        )
        switch decision {
        case .ack:
            if !requester.isEmpty, requester != myDeviceId {
                NSLog("SecretE2EE: link_device_join from foreign/unknown device %@ — acked, keys NOT sent", requester)
            }
            return true
        case .keep:
            NSLog("SecretE2EE: link_device_join from %@ kept — no matching invite on this device (yet)", requester)
            return false
        case .send(let target):
            let count: Int
            do {
                count = try await sendDeviceLinkKeys(toDeviceId: target)
            } catch {
                NSLog("SecretE2EE: device_link_keys to %@ failed: %@", target, String(describing: error))
                return false // повторим на следующем pull, пока жив TTL
            }
            clearInvite() // приглашение одноразовое
            NSLog("SecretE2EE: device_link_keys sent to %@ (%d keys)", target, count)
            // Имя устройства знает только сервер — резолвим, чтобы UI сказал ««iPhone» подключён».
            let name = myDevices?.first(where: { $0.id == target })?.name ?? ""
            deviceLinkedOut.send(LinkedDevice(name: name, threadCount: count))
            // Серверное приглашение (если это был путь LINK_DEVICE) гасим, чтобы не висело.
            if let token = h.token, !token.trimmed().isEmpty {
                try? await api.postIgnoringResponse(
                    "devices/pairing/consume", body: PairingConsumeRequest(token: token)
                )
            }
            return true
        }
    }

    /// Сравнение без раннего выхода по первому несовпавшему байту.
    static func constantTimeEquals(_ a: Data, _ b: Data) -> Bool {
        guard a.count == b.count else { return false }
        var diff: UInt8 = 0
        for (x, y) in zip(a, b) { diff |= x ^ y }
        return diff == 0
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

    /// X4: связку ключей принимаем только от СВОЕГО ЖИВОГО устройства, и только если пакет
    /// запечатан его ЗАРЕГИСТРИРОВАННОЙ идентичностью. Пакет шифруется на наш публичный
    /// prekey, который сервер отдаёт кому угодно, а initiatorDeviceId — просто поле заголовка
    /// (id чужих устройств видны всем через bundles). Поэтому сверяем: отправитель — наш
    /// аккаунт (senderUserId ставит сервер), устройство не отозвано, initiatorIdentityKey
    /// побайтно равен его ключу на сервере (DH на этом ключе и даёт вскрытие пакета).
    static func verifyDeviceLinkSender(
        header h: SecretHeader,
        senderUserId: String?,
        me: String?,
        myDevices: [DeviceDto]
    ) -> Bool {
        guard let me, senderUserId?.trimmed() == me else { return false }
        let initiator = (h.initiatorDeviceId ?? "").trimmed()
        guard !initiator.isEmpty,
              let device = myDevices.first(where: { $0.id == initiator }),
              device.revokedAt == nil else { return false }
        guard let claimed = h.initiatorIdentityKey.flatMap(SecretCrypto.b64UrlDecode),
              claimed.count == SecretCrypto.keyBytes else { return false }
        // Веб регистрирует ключ в base64, Android/iOS — в b64url: сравниваем байты.
        let registered = [device.identityPublicKey, device.publicKey]
            .compactMap { $0.flatMap(SecretCrypto.b64UrlDecode) }
        return registered.contains { constantTimeEquals($0, claimed) }
    }

    /// Приём связки: расшифровка тем же handshake, что и thread_key, затем merge
    /// (без перетирания существующих ключей).
    private func importDeviceLinkKeys(_ item: SecretInboxItemDto) async -> KeyPackageOutcome {
        guard let me = session.currentUserId() else { return .deferred(reason: "no session") }
        guard item.senderUserId?.trimmed() == me else {
            // Чужая связка подсунула бы подставные ключи для тредов, которых у нас нет.
            return .rejected(reason: "sent by another account", opened: false)
        }
        let myDevices: [DeviceDto]
        do {
            myDevices = try await devices.list().devices
        } catch {
            // Раньше сбой сети здесь означал «не наше» и честная связка терялась (ack).
            return .deferred(reason: "devices list unavailable")
        }
        guard Self.verifyDeviceLinkSender(
            header: item.headerJson, senderUserId: item.senderUserId, me: me, myDevices: myDevices
        ) else {
            return .rejected(
                reason: "initiator \(item.headerJson.initiatorDeviceId ?? "?") is not our live device with this identity",
                opened: false
            )
        }
        guard let plain = openKeyPackage(item) else { return .retry(reason: "cannot open package") }
        guard let payload = (try? JSONSerialization.jsonObject(with: plain)) as? [String: Any] else {
            return .rejected(reason: "payload is not a JSON object", opened: true)
        }
        if let rawKind = payload["kind"] {
            // Б2: вид пакета внутри обязан совпасть с заголовком.
            guard (rawKind as? String) == "device_link_keys" else {
                return .rejected(reason: "payload kind does not match header packageKind", opened: true)
            }
        }
        guard let keysObj = (payload["threadKeys"] as? [String: Any])?["keys"] as? [String: Any] else {
            return .rejected(reason: "no threadKeys.keys in payload", opened: true)
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
        return .linked(added: added)
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
