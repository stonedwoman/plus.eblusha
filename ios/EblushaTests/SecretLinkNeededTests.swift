import Combine
import XCTest
@testable import Eblusha

/// Баг iPhone владельца (живой тест секреток 2026-10-04): секретку принял ДРУГОЙ его аппарат,
/// iPhone сам просил ключ (key_request), ключ уходил — а экран на секунду показывал чат и снова
/// закрывался карточкой «Чат открыт на другом устройстве / Сканировать QR».
///
/// Причина (журналы nginx и таблица DevicePrekey): у id iPhone на сервере лежали OPK прежней
/// идентичности — выход на сборке до H13 стёр Keychain, но оставил id, вход перерегистрировал
/// тот же id с новой идентичностью и новыми OPK, а старые 50 остались. Сервер раздаёт OPK самыми
/// старыми первыми, поэтому КАЖДЫЙ ключ iPhone запечатывался на мёртвый OPK: пакет приходил в
/// инбокс (841 байт на каждом pull), не вскрывался («cannot open package» → .retry) и не
/// подтверждался никогда, ключ треда не появлялся, карточка оставалась. «Секунда» — это лента
/// с замками до ответа GET /devices (hasOtherDevices), после которого рисуется карточка.
///
/// Эти проверки собраны ТОЛЬКО на прежних API: на коде до исправления они падают.
final class SecretLinkNeededTests: XCTestCase {
    private var rig: SecretTestRig!
    private var subscriptions: Set<AnyCancellable> = []

    private let thread = "thread-ln"
    private var peer: FakeDevice!
    /// Другой аппарат владельца, принявший секретку (у него ключ треда).
    private var acceptedDevice: FakeDevice!

    override func setUp() {
        super.setUp()
        peer = FakeDevice(userId: "user-peer", deviceId: "dev-peer-1")
        rig = SecretTestRig()
        rig.bootstrapLocally()
        acceptedDevice = FakeDevice(userId: rig.me, deviceId: "dev-me-accepted")
        rig.server.myDevices.append(rig.deviceRecord(id: acceptedDevice.deviceId, identity: acceptedDevice.identity.publicKey))
        rig.server.addSecretThread(thread, participants: [rig.me, peer.userId])
        rig.server.bundles = [peer.userId: [peer.deviceId]]
    }

    override func tearDown() {
        subscriptions.removeAll()
        rig.tearDown()
        rig = nil
        super.tearDown()
    }

    private var myId: String { rig.deviceIds.deviceId() }

    /// Ответ принявшего аппарата на key_request: claim нашего САМОГО СТАРОГО OPK (как сервер
    /// отдаёт отправителю) и пакет thread_key на него.
    private func answerFromAcceptedDevice(key: Data) throws -> [String: Any] {
        let prekey = try XCTUnwrap(rig.server.takeServerPrekey(myId), "у устройства нет невыданных OPK")
        return rig.keyPackageItem(
            from: acceptedDevice, prekey: prekey, packageKind: "thread_key",
            payload: rig.threadKeyPayload(threadId: thread, key: key, style: .standard),
            headerThreadId: thread, style: .standard
        )
    }

    /// Пакет на мёртвый OPK не висит в инбоксе вечно: подтверждается, мёртвые OPK сжигаются,
    /// отправителя просят переслать — и пересланный (на живой OPK) вскрывается.
    func testKeyPackageSealedToDeadPrekeyHealsInsteadOfHangingForever() async throws {
        let seeded = rig.seedMyServerPrekeys(dead: 3, live: 4, others: [acceptedDevice.deviceId])
        let key = SecretCrypto.randomKey()
        let imported = Box<[String]>([])
        rig.repo.keyImported.sink { imported.value.append($0) }.store(in: &subscriptions)

        let dead = try answerFromAcceptedDevice(key: key)
        XCTAssertEqual((dead["headerJson"] as? [String: Any])?["prekeyId"] as? String, seeded.dead[0])
        rig.server.inbox = [dead]
        await rig.repo.syncInbox()

        // До исправления: пакет не подтверждался никогда (retry каждые 3,5 с, отравление через
        // 30 минут), ключ не появлялся, и экран так и висел на карточке привязки.
        XCTAssertEqual(rig.server.ackedIds, [dead["msgId"] as! String], "мёртвый пакет не клинит инбокс")
        XCTAssertNil(rig.keyStore.threadKey(thread))
        XCTAssertEqual(rig.server.serverPrekeyIds(myId).first, seeded.live[0], "оставшиеся мёртвые OPK сожжены")
        XCTAssertEqual(rig.server.claims(of: myId, by: myId), 2, "сожгли ровно два оставшихся мёртвых")
        let resend = rig.server.sentKeyRequests.filter { $0.to == acceptedDevice.deviceId }
        XCTAssertEqual(resend.count, 1, "отправителя попросили переслать ключ")
        XCTAssertEqual(resend.first?.header["threadId"] as? String, thread)
        XCTAssertEqual(resend.first?.header["requesterDeviceId"] as? String, myId)
        XCTAssertEqual(resend.first?.header["reasonCode"] as? String, "OPK_SECRET_MISS")

        // Принявший аппарат пересылает — теперь сервер отдаёт ему живой OPK.
        let again = try answerFromAcceptedDevice(key: key)
        XCTAssertEqual((again["headerJson"] as? [String: Any])?["prekeyId"] as? String, seeded.live[0])
        rig.server.inbox = [again]
        await rig.repo.syncInbox()
        XCTAssertEqual(rig.keyStore.threadKey(thread), key, "ключ треда на месте — карточка снимется")
        XCTAssertEqual(imported.value, [thread])
    }

    /// Свой key_request (вход в бесключевую секретку) сначала очищает голову очереди OPK: иначе
    /// ответ запечатан на мёртвый OPK и не вскроется никогда.
    func testRequestThreadKeyBurnsDeadPrekeysBeforeAsking() async throws {
        let seeded = rig.seedMyServerPrekeys(dead: 4, live: 3, others: [acceptedDevice.deviceId])

        await rig.repo.requestThreadKey(threadId: thread, userIds: [peer.userId])

        XCTAssertEqual(rig.server.serverPrekeyIds(myId), seeded.live, "все мёртвые сожжены, живые целы")
        XCTAssertEqual(rig.server.claims(of: myId, by: myId), 4)
        let requests = rig.server.sentKeyRequests.map(\.to)
        XCTAssertEqual(Set(requests), [peer.deviceId, acceptedDevice.deviceId])
        let calls = rig.server.calls.map { "\($0.method) \($0.path)" }
        let lastClaim = try XCTUnwrap(calls.lastIndex(of: "POST e2ee/prekeys/claim"))
        let firstSend = try XCTUnwrap(calls.firstIndex(of: "POST secret/send"))
        XCTAssertLessThan(lastClaim, firstSend, "сначала голова очереди, потом просьбы о ключе")

        // И ответ на эту просьбу вскрывается сразу.
        let key = SecretCrypto.randomKey()
        rig.server.inbox = [try answerFromAcceptedDevice(key: key)]
        await rig.repo.syncInbox()
        XCTAssertEqual(rig.keyStore.threadKey(thread), key)
    }
}

/// Сценарий владельца целиком, на вью-модели экрана: секретка ACTIVE, создатель — собеседник,
/// принял ДРУГОЙ аппарат владельца, на этом устройстве ключей нет вовсе (карточка привязки
/// показывается), у id на сервере — мёртвые OPK. Принявший аппарат честно отвечает на каждый
/// key_request. Ожидание: ключ доходит, экран открывается и обратно не закрывается.
@MainActor
final class SecretLinkNeededViewModelTests: XCTestCase {
    private var rig: SecretTestRig!
    private var subscriptions: Set<AnyCancellable> = []
    private let thread = "thread-owner"
    private var acceptedDevice: FakeDevice!

    override func setUp() async throws {
        rig = SecretTestRig()
        rig.bootstrapLocally()
        acceptedDevice = FakeDevice(userId: rig.me, deviceId: "dev-me-accepted")
        rig.server.myDevices.append(rig.deviceRecord(id: acceptedDevice.deviceId, identity: acceptedDevice.identity.publicKey))
        rig.server.addSecretThread(thread, participants: [rig.me, "user-peer"])
        rig.server.conversationExtras[thread] = [
            "secretStatus": "ACTIVE",
            "createdById": "user-peer",
            "secretPeerDeviceId": acceptedDevice.deviceId,
            "title": "Казёл",
        ]
        rig.server.bundles = ["user-peer": ["dev-peer-1"]]
        rig.server.extraRoute = { method, path, _ in
            switch (method, path) {
            case ("GET", "secret/history"):
                return (200, FakeServer.data(["items": [], "hasMore": false]))
            default:
                return nil
            }
        }
    }

    override func tearDown() async throws {
        subscriptions.removeAll()
        rig.tearDown()
        rig = nil
    }

    private func waitUntil(_ timeout: TimeInterval, _ condition: () -> Bool) async {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() && Date() < deadline {
            try? await Task.sleep(for: .milliseconds(50))
        }
    }

    /// Условие карточки «Чат открыт на другом устройстве» (SecretChatOverlay).
    private func linkCardShown(_ ui: ChatViewModel.UiState) -> Bool {
        ui.isSecret && !ui.secretReady && !ui.secretInvite && !ui.secretWaiting
            && ui.hasOtherDevices && !ui.hasAnySecretKeys
    }

    /// Принявший аппарат отвечает на каждую НОВУЮ просьбу о ключе (как стенд 2026-10-04):
    /// claim нашего самого старого OPK, пакет thread_key, secret:notify → разбор инбокса.
    private func startAcceptedDeviceResponder(key: Data) -> Task<Void, Never> {
        let answered = Box(0)
        let server = rig.server
        let repo = rig.repo
        let device = acceptedDevice!
        let rigRef = rig!
        let myId = rig.deviceIds.deviceId()
        let thread = self.thread
        return Task.detached {
            while !Task.isCancelled {
                let asks = server.sentKeyRequests.filter { $0.to == device.deviceId }.count
                if asks > answered.value, let prekey = server.takeServerPrekey(myId) {
                    answered.value = asks
                    let item = rigRef.keyPackageItem(
                        from: device, prekey: prekey, packageKind: "thread_key",
                        payload: rigRef.threadKeyPayload(threadId: thread, key: key),
                        headerThreadId: thread
                    )
                    server.enqueueInbox(item)
                    await repo.syncInbox() // secret:notify
                }
                try? await Task.sleep(for: .milliseconds(100))
            }
        }
    }

    private func openChat() -> ChatViewModel {
        ChatViewModel(
            repo: ChatRepository(api: rig.api, session: rig.session),
            realtime: RealtimeClient(session: rig.session, deviceIdProvider: rig.deviceIds, api: rig.api),
            conversationId: thread, secretRepo: rig.repo,
            callCover: Just(false).eraseToAnyPublisher(), foreground: Just(true).eraseToAnyPublisher()
        )
    }

    func testChatAcceptedOnAnotherOwnDeviceOpensAndStaysOpen() async throws {
        rig.seedMyServerPrekeys(dead: 2, live: 6, others: [acceptedDevice.deviceId])
        let key = SecretCrypto.randomKey()
        let vm = openChat()
        let responder = startAcceptedDeviceResponder(key: key)
        defer { responder.cancel() }

        await waitUntil(12) { vm.ui.secretReady }
        XCTAssertTrue(vm.ui.secretReady, "ключ дошёл — экран открыт (до исправления: вечная карточка)")
        XCTAssertEqual(rig.keyStore.threadKey(thread), key)
        XCTAssertFalse(linkCardShown(vm.ui))

        // «На секунду показывается, потом опять это же»: дальше экран не закрывается — ни
        // фоновые циклы (полл инбокса, проверка устройств), ни сверка истории.
        await waitUntil(5) { vm.ui.hasOtherDevices }
        try? await Task.sleep(for: .seconds(4))
        XCTAssertTrue(vm.ui.secretReady)
        XCTAssertTrue(vm.ui.hasAnySecretKeys, "устройство больше не «новое»")
        XCTAssertFalse(linkCardShown(vm.ui), "карточка привязки не возвращается")
        withExtendedLifetime(vm) {}
    }

    /// «LinkNeeded не снимается, хотя ключ есть»: ответ на наш key_request приходит, пока экран
    /// ещё открывается (у владельца key_request уходит ~27 устройствам по одному — секунды).
    /// keyImported, отправленный до подписки экрана, раньше терялся, а полл-«ремень» только
    /// досылал очередь — карточка висела при ключе в хранилище до переоткрытия.
    func testKeyArrivingWhileTheScreenIsStillOpeningIsNotLost() async throws {
        rig.seedMyServerPrekeys(dead: 0, live: 6, others: [acceptedDevice.deviceId])
        // Медленная сеть экрана: каждая отправка key_request и история отвечают не сразу — ключ
        // успевает приехать и импортироваться, пока initSecret ещё идёт (как у владельца).
        rig.server.responseDelays = ["POST secret/send": 0.4, "GET secret/history": 1.5]
        let key = SecretCrypto.randomKey()
        let vm = openChat()
        let responder = startAcceptedDeviceResponder(key: key)
        defer { responder.cancel() }

        await waitUntil(5) { rig.keyStore.threadKey(thread) != nil }
        XCTAssertEqual(rig.keyStore.threadKey(thread), key, "ключ импортирован, пока экран открывался")
        await waitUntil(8) { vm.ui.secretReady }
        XCTAssertTrue(vm.ui.secretReady, "экран заметил ключ, пришедший до подписки")
        XCTAssertFalse(linkCardShown(vm.ui))
        withExtendedLifetime(vm) {}
    }

    /// Обратная сторона исправления: новое своё устройство, которому ключ НИКТО не передал
    /// (другие аппараты молчат), по-прежнему видит карточку «Сканировать QR». Ни лечение OPK,
    /// ни «ремни» экрана (полл, adoptKeyIfArrived) её не снимают и живые OPK не жгут.
    func testNewOwnDeviceWithoutTransferredKeyStillAsksForQr() async throws {
        let seeded = rig.seedMyServerPrekeys(dead: 0, live: 4, others: [acceptedDevice.deviceId])
        let vm = openChat()
        await waitUntil(8) { vm.ui.hasOtherDevices }
        // Хотя бы один круг фонового полла (3,5 с) с adoptKeyIfArrived.
        try? await Task.sleep(for: .seconds(4.5))
        XCTAssertTrue(linkCardShown(vm.ui), "ключа нет — карточка привязки на месте")
        XCTAssertFalse(vm.ui.secretReady)
        XCTAssertNil(rig.keyStore.threadKey(thread))
        XCTAssertEqual(rig.server.serverPrekeyIds(rig.deviceIds.deviceId()), seeded.live, "живые OPK не тронуты")
        XCTAssertTrue(rig.server.sentKeyRequests.contains { $0.to == acceptedDevice.deviceId })

        // «Ключ импортирован» без ключа в хранилище (Keychain не записал связку) экран не
        // открывает: истина — хранилище, а не событие.
        rig.repo.keyImported.send(thread)
        try? await Task.sleep(for: .milliseconds(300))
        XCTAssertFalse(vm.ui.secretReady)
        XCTAssertTrue(linkCardShown(vm.ui))

        // Ключ ДРУГОГО треда не открывает этот.
        rig.keyStore.setThreadKey("thread-other", key: SecretCrypto.randomKey())
        rig.repo.keyImported.send("thread-other")
        try? await Task.sleep(for: .seconds(4))
        XCTAssertFalse(vm.ui.secretReady)
        XCTAssertNil(rig.keyStore.threadKey(thread))
        withExtendedLifetime(vm) {}
    }

    /// Ключ уже лежит на устройстве к открытию экрана (снимок после ключа) — чат открыт сразу,
    /// без карточки и без просьб о ключе.
    func testKeyAlreadyStoredOpensImmediatelyWithoutAsking() async throws {
        rig.seedMyServerPrekeys(dead: 0, live: 2, others: [acceptedDevice.deviceId])
        rig.keyStore.setThreadKey(thread, key: SecretCrypto.randomKey())
        let vm = openChat()
        await waitUntil(5) { vm.ui.secretReady }
        XCTAssertTrue(vm.ui.secretReady)
        await waitUntil(5) { vm.ui.hasOtherDevices }
        XCTAssertFalse(linkCardShown(vm.ui))
        XCTAssertTrue(rig.server.sentKeyRequests.isEmpty)
        withExtendedLifetime(vm) {}
    }
}
