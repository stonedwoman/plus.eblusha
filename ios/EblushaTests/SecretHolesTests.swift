import Combine
import XCTest
@testable import Eblusha

/// Самопроверка правок «дыр секретных чатов» на iOS (ТЗ secret-holes, Часть II, iOS-*/C-*).
/// Каждая проверка гоняет настоящий SecretRepository поверх подменного транспорта — без сети,
/// без боевых данных, с настоящей криптографией. Имена тестов начинаются с id дыры.
final class SecretHolesTests: XCTestCase {
    private var rig: SecretTestRig!
    private var subscriptions: Set<AnyCancellable> = []

    private let thread = "thread-1"
    private var peer: FakeDevice!
    private var evil: FakeDevice!

    // Синхронные setUp/tearDown XCTest зовёт на главном потоке: SessionStore выставляет
    // состояние сессии синхронно только там.
    override func setUp() {
        super.setUp()
        peer = FakeDevice(userId: "user-peer", deviceId: "dev-peer-1")
        evil = FakeDevice(userId: "user-evil", deviceId: "dev-evil-1")
        rig = SecretTestRig()
        rig.bootstrapLocally()
        rig.server.addSecretThread(thread, participants: [rig.me, peer.userId])
        rig.server.bundles = [peer.userId: [peer.deviceId], evil.userId: [evil.deviceId]]
    }

    override func tearDown() {
        subscriptions.removeAll()
        rig.tearDown()
        rig = nil
        super.tearDown()
    }

    // MARK: - H12: терпимый разбор инбокса и истории

    func testH12_headerDecodesLeniently() throws {
        let raw = #"{"kind":"msg","v":"x","ts":1.5,"nonce":7,"threadId":"t","attachment":{"objectKey":"a"}}"#
        let header = try JSONDecoder().decode(SecretHeader.self, from: Data(raw.utf8))
        XCTAssertEqual(header.kind, "msg")
        XCTAssertEqual(header.v, 1)
        XCTAssertNil(header.ts)
        XCTAssertNil(header.nonce)
        XCTAssertNil(header.attachment)
        XCTAssertEqual(header.threadId, "t")
        XCTAssertThrowsError(try JSONDecoder().decode(SecretHeader.self, from: Data(#"{"kind":5}"#.utf8)))
    }

    func testH12_inboxResponseDecodesPerElement() throws {
        let raw = """
        {"messages":[
          {"msgId":"11111111-1111-4111-8111-111111111111","ciphertext":"AA","headerJson":{"kind":5}},
          {"msgId":"22222222-2222-4222-8222-222222222222","ciphertext":"AA","headerJson":{"kind":"msg"}},
          {"msgId":"33333333-3333-4333-8333-333333333333","ciphertext":"AA"},
          42,
          {"msgId":"44444444-4444-4444-8444-444444444444","ciphertext":"AA","headerJson":{}}
        ]}
        """
        let resp = try JSONDecoder().decode(SecretInboxResponse.self, from: Data(raw.utf8))
        XCTAssertEqual(resp.messages.map(\.msgId), ["22222222-2222-4222-8222-222222222222"])
        XCTAssertEqual(resp.undecodableMsgIds, [
            "11111111-1111-4111-8111-111111111111",
            "33333333-3333-4333-8333-333333333333",
            "44444444-4444-4444-8444-444444444444",
        ])
    }

    func testH12_malformedEnvelopesDoNotJamInboxAndAreAcked() async throws {
        let key = SecretCrypto.randomKey()
        rig.keyStore.setThreadKey(thread, key: key)
        let good = rig.msgItem(threadId: thread, from: peer.userId, text: "привет", key: key)
        let badTypes = rig.msgItem(
            threadId: thread, from: peer.userId, text: "второе", key: key,
            extraHeader: ["ts": 1.5, "attachment": ["objectKey": "a"], "v": "1"]
        )
        let badKind: [String: Any] = [
            "msgId": UUID().uuidString.lowercased(), "ciphertext": "AA", "headerJson": ["kind": 5],
        ]
        let noHeader: [String: Any] = ["msgId": UUID().uuidString.lowercased(), "ciphertext": "AA"]
        let emptyHeader: [String: Any] = [
            "msgId": UUID().uuidString.lowercased(), "ciphertext": "AA", "headerJson": [String: Any](),
        ]
        rig.server.inbox = [badKind, good, noHeader, badTypes, emptyHeader]
        let received = Box<[String]>([])
        rig.repo.incoming.sink { received.value.append($0.text) }.store(in: &subscriptions)

        await rig.repo.syncInbox()

        let all = [badKind, good, noHeader, badTypes, emptyHeader].map { $0["msgId"] as! String }
        XCTAssertEqual(Set(rig.server.ackedIds), Set(all), "весь пакет подтверждён, включая кривые")
        XCTAssertEqual(received.value.sorted(), ["второе", "привет"])
        XCTAssertTrue(rig.server.inbox.isEmpty)
    }

    func testH12_historySkipsMalformedRows() async throws {
        let key = SecretCrypto.randomKey()
        rig.keyStore.setThreadKey(thread, key: key)
        let row1 = rig.msgItem(threadId: thread, from: peer.userId, text: "раз", key: key)
        let row2 = rig.msgItem(threadId: thread, from: rig.me, text: "два", key: key)
        let bad: [String: Any] = [
            "msgId": UUID().uuidString.lowercased(), "threadId": thread, "ciphertext": "AA", "headerJson": [String: Any](),
        ]
        rig.server.historyItems = [row1, bad, row2]
        guard case .success(let page) = await rig.repo.history(conversationId: thread) else {
            return XCTFail("страница истории не должна падать из-за одной кривой строки")
        }
        XCTAssertEqual(page.messages.map(\.text).sorted(), ["два", "раз"])
    }

    // MARK: - H01: ключ треда только от участника, с проверками Б1/Б2

    func testH01_threadKeyFromNonParticipantIsIgnoredAndAcked() async throws {
        let original = SecretCrypto.randomKey()
        rig.keyStore.setThreadKey(thread, key: original)
        let item = rig.keyPackageItem(
            from: evil, prekey: rig.makeMyPrekey(), packageKind: "thread_key",
            payload: rig.threadKeyPayload(threadId: thread, key: SecretCrypto.randomKey()),
            headerThreadId: thread
        )
        rig.server.inbox = [item]
        await rig.repo.syncInbox()
        XCTAssertEqual(rig.keyStore.threadKey(thread), original, "посторонний не подменил ключ")
        XCTAssertEqual(rig.server.ackedIds, [item["msgId"] as! String], "и не заклинил инбокс")
        XCTAssertTrue(rig.server.sentEnvelopes.isEmpty, "квитанции постороннему нет")
    }

    func testH01_threadKeyForThreadThatIsNotOursIsIgnored() async throws {
        // Участник треда-А шлёт ключ для треда-Б, в котором мы не состоим (или не секретного).
        rig.server.addSecretThread("cloud-1", participants: [rig.me, peer.userId], type: "CLOUD")
        for target in ["unknown-thread", "cloud-1"] {
            let item = rig.keyPackageItem(
                from: peer, prekey: rig.makeMyPrekey(), packageKind: "thread_key",
                payload: rig.threadKeyPayload(threadId: target, key: SecretCrypto.randomKey()),
                headerThreadId: target
            )
            rig.server.inbox = [item]
            await rig.repo.syncInbox()
            XCTAssertNil(rig.keyStore.threadKey(target))
            XCTAssertTrue(rig.server.ackedIds.contains(item["msgId"] as! String))
        }
    }

    func testH01_participantKeyChangeIsAutomaticAndKeepsHistoryReadable() async throws {
        let oldKey = SecretCrypto.randomKey()
        let newKey = SecretCrypto.randomKey()
        rig.keyStore.setThreadKey(thread, key: oldKey)
        let imported = Box<[String]>([])
        rig.repo.keyImported.sink { imported.value.append($0) }.store(in: &subscriptions)
        let rotations = Box<[SecretRepository.KeyRotation]>([])
        rig.repo.keyRotated.sink { rotations.value.append($0) }.store(in: &subscriptions)
        let item = rig.keyPackageItem(
            from: peer, prekey: rig.makeMyPrekey(), packageKind: "thread_key",
            payload: rig.threadKeyPayload(threadId: thread, key: newKey), headerThreadId: thread
        )
        rig.server.inbox = [item]
        await rig.repo.syncInbox()

        XCTAssertEqual(rig.keyStore.threadKey(thread), newKey, "смена ключа от участника — автоматически")
        XCTAssertEqual(rig.keyStore.previousThreadKeys(thread), [oldKey], "прежний ключ сохранён")
        XCTAssertEqual(imported.value, [thread])
        // Не молча: экран беседы получает событие (и непоказанную плашку на случай закрытого чата).
        XCTAssertEqual(rotations.value, [SecretRepository.KeyRotation(threadId: thread, senderUserId: peer.userId)])
        XCTAssertTrue(rig.repo.takeKeyRotationNotice(thread))
        XCTAssertFalse(rig.repo.takeKeyRotationNotice(thread), "плашка показывается один раз")
        // Квитанция ушла инициатору — веб-паритет.
        let receipt = rig.server.sentEnvelopes.first
        XCTAssertEqual(receipt?["toDeviceId"] as? String, peer.deviceId)
        XCTAssertEqual((receipt?["headerJson"] as? [String: Any])?["type"] as? String, "key_receipt")

        // История, запечатанная старым ключом, по-прежнему читается; новая — новым.
        rig.server.historyItems = [
            rig.msgItem(threadId: thread, from: peer.userId, text: "до смены", key: oldKey),
            rig.msgItem(threadId: thread, from: peer.userId, text: "после смены", key: newKey),
        ]
        guard case .success(let page) = await rig.repo.history(conversationId: thread) else { return XCTFail() }
        XCTAssertEqual(page.messages.map(\.text).sorted(), ["до смены", "после смены"])
    }

    func testH01_B2_payloadKindMustMatchHeader() async throws {
        let original = SecretCrypto.randomKey()
        rig.keyStore.setThreadKey(thread, key: original)
        let item = rig.keyPackageItem(
            from: peer, prekey: rig.makeMyPrekey(), packageKind: "thread_key",
            payload: rig.threadKeyPayload(threadId: thread, key: SecretCrypto.randomKey(), kind: "device_link_keys"),
            headerThreadId: thread
        )
        rig.server.inbox = [item]
        await rig.repo.syncInbox()
        XCTAssertEqual(rig.keyStore.threadKey(thread), original)
        XCTAssertEqual(rig.server.ackedIds, [item["msgId"] as! String])
    }

    func testH01_B2_payloadThreadMustMatchHeaderThread() async throws {
        rig.server.addSecretThread("thread-2", participants: [rig.me, peer.userId])
        let item = rig.keyPackageItem(
            from: peer, prekey: rig.makeMyPrekey(), packageKind: "thread_key",
            payload: rig.threadKeyPayload(threadId: "thread-2", key: SecretCrypto.randomKey()),
            headerThreadId: thread
        )
        rig.server.inbox = [item]
        await rig.repo.syncInbox()
        XCTAssertNil(rig.keyStore.threadKey("thread-2"))
        XCTAssertNil(rig.keyStore.threadKey(thread))
        XCTAssertEqual(rig.server.ackedIds, [item["msgId"] as! String])
    }

    func testH01_B1_legacyPackageWithoutHeaderThreadIdIsImportedFromPayload() async throws {
        // Б1: 1527 старых пакетов несут тред только внутри payload. Отказ «нет threadId в
        // заголовке» вводить нельзя — тред берётся из payload, членство проверяется по нему.
        let key = SecretCrypto.randomKey()
        let imported = Box<[String]>([])
        rig.repo.keyImported.sink { imported.value.append($0) }.store(in: &subscriptions)
        let item = rig.keyPackageItem(
            from: peer, prekey: rig.makeMyPrekey(), packageKind: "thread_key",
            payload: rig.threadKeyPayload(threadId: thread, key: key), headerThreadId: nil
        )
        rig.server.inbox = [item]
        await rig.repo.syncInbox()
        XCTAssertEqual(rig.keyStore.threadKey(thread), key)
        XCTAssertEqual(imported.value, [thread])
        let receiptHeader = rig.server.sentEnvelopes.first?["headerJson"] as? [String: Any]
        XCTAssertEqual(receiptHeader?["threadId"] as? String, thread, "квитанция несёт тред из payload")
    }

    func testH01_legacyPayloadWithoutKindIsAccepted() async throws {
        let key = SecretCrypto.randomKey()
        let item = rig.keyPackageItem(
            from: peer, prekey: rig.makeMyPrekey(), packageKind: "thread_key",
            payload: rig.threadKeyPayload(threadId: thread, key: key, kind: nil), headerThreadId: thread
        )
        rig.server.inbox = [item]
        await rig.repo.syncInbox()
        XCTAssertEqual(rig.keyStore.threadKey(thread), key)
    }

    func testH01_webEncodedPackageIsImported() async throws {
        // Совместимость: веб кодирует всё стандартным base64 (с +/ и паддингом).
        let key = SecretCrypto.randomKey()
        let item = rig.keyPackageItem(
            from: peer, prekey: rig.makeMyPrekey(), packageKind: "thread_key",
            payload: rig.threadKeyPayload(threadId: thread, key: key, style: .standard),
            headerThreadId: thread, style: .standard
        )
        rig.server.inbox = [item]
        await rig.repo.syncInbox()
        XCTAssertEqual(rig.keyStore.threadKey(thread), key)
    }

    func testH01_wrongKeyLengthIsRejected() async throws {
        let item = rig.keyPackageItem(
            from: peer, prekey: rig.makeMyPrekey(), packageKind: "thread_key",
            payload: rig.threadKeyPayload(threadId: thread, key: SecretCrypto.randomBytes(16)), headerThreadId: thread
        )
        rig.server.inbox = [item]
        await rig.repo.syncInbox()
        XCTAssertNil(rig.keyStore.threadKey(thread))
        XCTAssertEqual(rig.server.ackedIds, [item["msgId"] as! String])
    }

    func testH01_membershipUnknownKeepsPackageForRetry() async throws {
        rig.server.conversationsStatus = 503
        let item = rig.keyPackageItem(
            from: peer, prekey: rig.makeMyPrekey(), packageKind: "thread_key",
            payload: rig.threadKeyPayload(threadId: thread, key: SecretCrypto.randomKey()), headerThreadId: thread
        )
        rig.server.inbox = [item]
        await rig.repo.syncInbox()
        XCTAssertNil(rig.keyStore.threadKey(thread))
        XCTAssertTrue(rig.server.ackedIds.isEmpty, "проверить нечем — пакет ждёт следующего pull")

        rig.server.conversationsStatus = 200
        await rig.repo.syncInbox()
        XCTAssertNotNil(rig.keyStore.threadKey(thread), "сеть вернулась — ключ принят")
    }

    func testH01_membershipFailuresNeverPoisonAnHonestKey() async throws {
        // Раньше «не удалось проверить участника» шло в счётчик отравления: после 20 сбоев
        // GET /conversations честный ключ подтверждался без импорта и терялся.
        rig.server.conversationsStatus = 503
        let key = SecretCrypto.randomKey()
        let rotations = Box(0)
        rig.repo.keyRotated.sink { _ in rotations.value += 1 }.store(in: &subscriptions)
        rig.server.inbox = [rig.keyPackageItem(
            from: peer, prekey: rig.makeMyPrekey(), packageKind: "thread_key",
            payload: rig.threadKeyPayload(threadId: thread, key: key), headerThreadId: thread
        )]
        for _ in 0..<25 { await rig.repo.syncInbox() }
        XCTAssertTrue(rig.server.ackedIds.isEmpty, "сбой проверки — не отравление: конверт живёт до серверного срока")
        XCTAssertNil(rig.keyStore.threadKey(thread))
        rig.server.conversationsStatus = 200
        await rig.repo.syncInbox()
        XCTAssertEqual(rig.keyStore.threadKey(thread), key)
        XCTAssertEqual(rig.server.ackedIds.count, 1)
        XCTAssertEqual(rotations.value, 0, "первый ключ — не «смена ключа»")
    }

    func testH01_validateThreadKeyPayloadTable() {
        let key = SecretCrypto.randomKey()
        let b64 = SecretCrypto.b64UrlEncode(key)
        func header(_ thread: String?) -> SecretHeader {
            SecretHeader(kind: "key_package", packageKind: "thread_key", threadId: thread)
        }
        XCTAssertEqual(
            SecretRepository.validateThreadKeyPayload(["threadId": "a", "key": b64, "kind": "thread_key"], header: header("a")),
            .valid(threadId: "a", key: key)
        )
        XCTAssertEqual(
            SecretRepository.validateThreadKeyPayload(["threadId": "a", "key": b64], header: header(nil)),
            .valid(threadId: "a", key: key)
        )
        XCTAssertEqual(
            SecretRepository.validateThreadKeyPayload(["key": b64], header: header("a")),
            .valid(threadId: "a", key: key)
        )
        for bad: [String: Any] in [
            ["threadId": "b", "key": b64],
            ["threadId": "a", "key": b64, "kind": "device_link_keys"],
            ["threadId": 5, "key": b64],
            ["key": b64, "kind": 1],
            ["threadId": "a"],
        ] {
            if case .valid = SecretRepository.validateThreadKeyPayload(bad, header: header("a")) {
                XCTFail("должно быть отвергнуто: \(bad)")
            }
        }
        if case .valid = SecretRepository.validateThreadKeyPayload(["key": b64], header: header(nil)) {
            XCTFail("без треда негде хранить ключ")
        }
    }

    // MARK: - H03 / X8: ответ на key_request

    private func keyRequestRig() -> (key: Data, requesterPrekeySecret: Data) {
        let key = SecretCrypto.randomKey()
        rig.keyStore.setThreadKey(thread, key: key)
        let kp = SecretCrypto.generateKeyPair()
        rig.server.claimable[peer.deviceId] = ("peer-pk-1", kp.publicKey)
        rig.server.claimable[evil.deviceId] = ("evil-pk-1", kp.publicKey)
        rig.server.claimable["dev-peer-unknown"] = ("x-pk-1", kp.publicKey)
        return (key, kp.secretKey)
    }

    func testH03_keyRequestFromNonParticipantIsNotAnswered() async throws {
        _ = keyRequestRig()
        let item = rig.controlItem(
            type: "key_request", threadId: thread,
            senderUserId: evil.userId, senderDeviceId: evil.deviceId, requesterDeviceId: evil.deviceId
        )
        rig.server.inbox = [item]
        await rig.repo.syncInbox()
        XCTAssertTrue(rig.server.calls("POST", "e2ee/prekeys/claim").isEmpty)
        XCTAssertTrue(rig.server.sentEnvelopes.isEmpty, "ключ треда постороннему не уходит")
        XCTAssertEqual(rig.server.ackedIds, [item["msgId"] as! String])
    }

    func testH03_requesterMustBeSendersOwnLiveDevice() async throws {
        _ = keyRequestRig()
        // Участник называет адресатом чужое устройство (постороннего) — отказ.
        let item = rig.controlItem(
            type: "key_request", threadId: thread,
            senderUserId: peer.userId, senderDeviceId: peer.deviceId, requesterDeviceId: evil.deviceId
        )
        rig.server.inbox = [item]
        await rig.repo.syncInbox()
        XCTAssertTrue(rig.server.sentEnvelopes.isEmpty)
        XCTAssertEqual(rig.server.ackedIds, [item["msgId"] as! String])
    }

    func testX8_senderDeviceIdIsNotAFallbackRecipient() async throws {
        _ = keyRequestRig()
        let item = rig.controlItem(
            type: "key_request", threadId: thread,
            senderUserId: peer.userId, senderDeviceId: peer.deviceId, requesterDeviceId: nil
        )
        rig.server.inbox = [item]
        await rig.repo.syncInbox()
        XCTAssertTrue(rig.server.sentEnvelopes.isEmpty, "без requester/from в заголовке ключ не уходит никуда")
        XCTAssertEqual(try XCTUnwrap(SecretRepository.keyRequestTarget(
            SecretHeader(kind: "control", fromDeviceId: "dev-a"), myDeviceId: "me"
        )), "dev-a")
    }

    func testH03_keyRequestFromParticipantDeviceIsAnswered() async throws {
        let (key, requesterSecret) = keyRequestRig()
        let item = rig.controlItem(
            type: "key_request", threadId: thread,
            senderUserId: peer.userId, senderDeviceId: peer.deviceId, requesterDeviceId: peer.deviceId
        )
        rig.server.inbox = [item]
        await rig.repo.syncInbox()
        let sent = rig.server.sentEnvelopes
        XCTAssertEqual(sent.count, 1)
        XCTAssertEqual(sent.first?["toDeviceId"] as? String, peer.deviceId)
        let payload = SecretTestRig.openSentPackage(sent[0], prekeySecret: requesterSecret)
        XCTAssertEqual(payload?["threadId"] as? String, thread)
        XCTAssertEqual((payload?["key"] as? String).flatMap(SecretCrypto.b64UrlDecode), key)
        XCTAssertEqual(rig.server.ackedIds, [item["msgId"] as! String])
    }

    // MARK: - X4: связка ключей только от своего живого устройства

    private func myOtherDevice(revoked: Bool = false, registeredIdentity: Data? = nil) -> FakeDevice {
        let other = FakeDevice(userId: rig.me, deviceId: "dev-me-2")
        rig.server.myDevices.append(rig.deviceRecord(
            id: other.deviceId, identity: registeredIdentity ?? other.identity.publicKey, revoked: revoked
        ))
        return other
    }

    private func linkPackage(from sender: FakeDevice, senderUserId: String? = nil) -> (item: [String: Any], key: Data) {
        let key = SecretCrypto.randomKey()
        let item = rig.keyPackageItem(
            from: sender, senderUserId: senderUserId, prekey: rig.makeMyPrekey(), packageKind: "device_link_keys",
            payload: rig.deviceLinkPayload(["linked-thread": key]), headerThreadId: nil
        )
        return (item, key)
    }

    func testX4_deviceLinkKeysFromAnotherAccountAreDropped() async throws {
        // Посторонний пишет в initiatorDeviceId id НАШЕГО устройства (id видны всем).
        let mine = myOtherDevice()
        let forged = FakeDevice(userId: evil.userId, deviceId: mine.deviceId)
        let (item, _) = linkPackage(from: forged)
        rig.server.inbox = [item]
        await rig.repo.syncInbox()
        XCTAssertNil(rig.keyStore.threadKey("linked-thread"))
        XCTAssertEqual(rig.server.ackedIds, [item["msgId"] as! String])
    }

    func testX4_identityMustMatchRegisteredDeviceKey() async throws {
        // Даже от «своего» аккаунта: ключ в заголовке ≠ зарегистрированному ключу устройства.
        let mine = myOtherDevice(registeredIdentity: SecretCrypto.generateKeyPair().publicKey)
        let (item, _) = linkPackage(from: mine)
        rig.server.inbox = [item]
        await rig.repo.syncInbox()
        XCTAssertNil(rig.keyStore.threadKey("linked-thread"))
        XCTAssertEqual(rig.server.ackedIds, [item["msgId"] as! String])
    }

    func testX4_revokedDeviceIsNotTrusted() async throws {
        let mine = myOtherDevice(revoked: true)
        let (item, _) = linkPackage(from: mine)
        rig.server.inbox = [item]
        await rig.repo.syncInbox()
        XCTAssertNil(rig.keyStore.threadKey("linked-thread"))
    }

    func testX4_ownLiveDeviceLinkIsMergedWithoutOverwrite() async throws {
        let existing = SecretCrypto.randomKey()
        rig.keyStore.setThreadKey(thread, key: existing)
        let mine = myOtherDevice()
        let newKey = SecretCrypto.randomKey()
        let item = rig.keyPackageItem(
            from: mine, prekey: rig.makeMyPrekey(), packageKind: "device_link_keys",
            payload: rig.deviceLinkPayload(["linked-thread": newKey, thread: SecretCrypto.randomKey()]),
            headerThreadId: nil
        )
        rig.server.inbox = [item]
        await rig.repo.syncInbox()
        XCTAssertEqual(rig.keyStore.threadKey("linked-thread"), newKey)
        XCTAssertEqual(rig.keyStore.threadKey(thread), existing, "слияние не перетирает свои ключи")
        XCTAssertEqual(rig.server.ackedIds, [item["msgId"] as! String])
    }

    func testX4_webRegisteredBase64IdentityIsAccepted() async throws {
        let mine = FakeDevice(userId: rig.me, deviceId: "dev-me-web")
        rig.server.myDevices.append(rig.deviceRecord(id: mine.deviceId, identity: mine.identity.publicKey, style: .standard))
        let (item, key) = linkPackage(from: mine)
        rig.server.inbox = [item]
        await rig.repo.syncInbox()
        XCTAssertEqual(rig.keyStore.threadKey("linked-thread"), key)
    }

    func testX4_devicesListFailureDoesNotDropHonestLink() async throws {
        let mine = myOtherDevice()
        let (item, key) = linkPackage(from: mine)
        rig.server.inbox = [item]
        rig.server.devicesStatus = 503
        await rig.repo.syncInbox()
        XCTAssertTrue(rig.server.ackedIds.isEmpty, "раньше сбой сети здесь означал «чужое» и честная связка терялась")
        for _ in 0..<22 { await rig.repo.syncInbox() }
        XCTAssertTrue(rig.server.ackedIds.isEmpty, "и после 20+ сбоев не подтверждается (не отравление)")
        rig.server.devicesStatus = 200
        await rig.repo.syncInbox()
        XCTAssertEqual(rig.keyStore.threadKey("linked-thread"), key)
    }

    // MARK: - X3 (Б8): link_device_join

    func testX3_foreignLinkJoinIsAckedWithoutInvite() async throws {
        let items = (0..<50).map { _ in
            rig.linkJoinItem(senderUserId: evil.userId, requesterDeviceId: evil.deviceId, code: "12345678")
        }
        rig.server.inbox = items
        await rig.repo.syncInbox()
        XCTAssertEqual(Set(rig.server.ackedIds), Set(items.map { $0["msgId"] as! String }), "50 чужих не клинят инбокс")
        XCTAssertTrue(rig.server.sentEnvelopes.isEmpty)
    }

    func testX3_ownUnknownDeviceIsAcked_ownDeviceWithoutInviteIsKept() async throws {
        let mine = myOtherDevice()
        let unknown = rig.linkJoinItem(senderUserId: rig.me, requesterDeviceId: "dev-not-ours")
        let ownNoInvite = rig.linkJoinItem(senderUserId: rig.me, requesterDeviceId: mine.deviceId, code: "12345678")
        rig.server.inbox = [unknown, ownNoInvite]
        await rig.repo.syncInbox()
        XCTAssertEqual(rig.server.ackedIds, [unknown["msgId"] as! String])
        XCTAssertEqual(rig.server.inbox.count, 1, "своё без приглашения доживёт свой TTL")
    }

    func testX3_ownDeviceWithMatchingInviteGetsKeys() async throws {
        rig.keyStore.setThreadKey(thread, key: SecretCrypto.randomKey())
        let mine = myOtherDevice()
        let kp = SecretCrypto.generateKeyPair()
        rig.server.claimable[mine.deviceId] = ("me2-pk", kp.publicKey)
        let invite = rig.repo.createInvite()
        let wrong = rig.linkJoinItem(senderUserId: rig.me, requesterDeviceId: mine.deviceId, code: "00000000x")
        let right = rig.linkJoinItem(senderUserId: rig.me, requesterDeviceId: mine.deviceId, code: invite.code)
        rig.server.inbox = [wrong, right]
        await rig.repo.syncInbox()
        XCTAssertEqual(rig.server.ackedIds, [right["msgId"] as! String])
        let sent = rig.server.sentEnvelopes
        XCTAssertEqual(sent.count, 1)
        XCTAssertEqual((sent.first?["headerJson"] as? [String: Any])?["packageKind"] as? String, "device_link_keys")
        XCTAssertNil(rig.repo.currentInvite(), "приглашение одноразовое")
    }

    func testX3_decideLinkJoinTable() {
        let devices: [DeviceDto] = try! JSONDecoder().decode(
            DevicesListResponse.self,
            from: FakeServer.data(["devices": [
                rig.deviceRecord(id: "d2", identity: Data(count: 32)),
                rig.deviceRecord(id: "d3", identity: Data(count: 32), revoked: true),
            ]])
        ).devices
        let invite = DeviceLinkInvite(token: "Tok-_123", code: "12345678", expiresAtMs: Int64.max)
        func decide(_ sender: String?, _ requester: String, devices list: [DeviceDto]?, invite inv: DeviceLinkInvite?, code: String? = "12345678", token: String? = nil) -> SecretRepository.LinkJoinDecision {
            SecretRepository.decideLinkJoin(
                header: SecretHeader(kind: "link_device_join", requesterDeviceId: requester, token: token, code: code),
                senderUserId: sender, me: "me", myDeviceId: "d1", myDevices: list, invite: inv
            )
        }
        XCTAssertEqual(decide("other", "d2", devices: nil, invite: nil), .ack, "чужой аккаунт — ack без сети")
        XCTAssertEqual(decide("me", "d1", devices: devices, invite: invite), .ack, "сам себе")
        XCTAssertEqual(decide("me", "d9", devices: devices, invite: invite), .ack, "не наше устройство")
        XCTAssertEqual(decide("me", "d3", devices: devices, invite: invite), .ack, "отозванное")
        XCTAssertEqual(decide("me", "d2", devices: nil, invite: invite), .keep, "не смогли проверить")
        XCTAssertEqual(decide("me", "d2", devices: devices, invite: nil), .keep, "нет приглашения")
        XCTAssertEqual(decide("me", "d2", devices: devices, invite: invite, code: "87654321"), .keep)
        XCTAssertEqual(decide("me", "d2", devices: devices, invite: invite), .send(requester: "d2"))
        XCTAssertEqual(decide("me", "d2", devices: devices, invite: invite, code: nil, token: "Tok-_123"), .send(requester: "d2"))
        XCTAssertEqual(decide("me", "d2", devices: devices, invite: invite, code: nil, token: "TOK-_123"), .keep, "токен b64url — регистр значим")
    }

    // MARK: - H04: учёт one-time prekeys

    func testH04_prekeysNeededStormPublishesOnceAndOnlyWhenLow() async throws {
        rig.server.myDevices[0]["availablePrekeys"] = 3
        let storm = (0..<10).map { _ -> [String: Any] in
            ["msgId": UUID().uuidString.lowercased(), "threadId": NSNull(), "senderUserId": evil.userId,
             "ciphertext": "AA", "headerJson": ["kind": "prekeys_needed", "v": 1], "contentType": "ref"]
        }
        rig.server.inbox = storm
        await rig.repo.syncInbox()
        let publishes = rig.server.calls.filter { $0.method == "POST" && $0.path.hasSuffix("/prekeys") }
        XCTAssertEqual(publishes.count, 1, "10 prekeys_needed в пачке — одна публикация")
        XCTAssertEqual(Set(rig.server.ackedIds), Set(storm.map { $0["msgId"] as! String }))

        // Повтор в пределах минуты — троттл.
        rig.server.inbox = storm.map { var m = $0; m["msgId"] = UUID().uuidString.lowercased(); return m }
        await rig.repo.syncInbox()
        XCTAssertEqual(rig.server.calls.filter { $0.method == "POST" && $0.path.hasSuffix("/prekeys") }.count, 1)
    }

    func testH04_replenishSkipsWhenServerHasEnough() async throws {
        rig.server.myDevices[0]["availablePrekeys"] = 120
        let before = rig.keyStore.prekeySecretCount()
        let ok = await rig.repo.replenishPrekeys()
        XCTAssertTrue(ok)
        XCTAssertTrue(rig.server.calls.filter { $0.path.hasSuffix("/prekeys") }.isEmpty)
        XCTAssertEqual(rig.keyStore.prekeySecretCount(), before, "секреты не плодятся")
    }

    func testH04_secretsOfKeysRejectedByServerAreDropped() async throws {
        rig.server.myDevices[0]["availablePrekeys"] = 0
        rig.server.publishAcceptLimit = 7
        let before = rig.keyStore.prekeySecretCount()
        let ok = await rig.repo.replenishPrekeys()
        XCTAssertTrue(ok)
        XCTAssertEqual(rig.keyStore.prekeySecretCount(), before + 7, "хранятся секреты только принятых сервером")
    }

    func testH04_prekeySecretsArePrunedAfterUseAndAboveCap() throws {
        var secrets: [String: Data] = [:]
        for i in 0..<30 { secrets["old-\(i)"] = SecretCrypto.randomKey() }
        rig.keyStore.addPrekeySecrets(secrets, nowMs: 1_000)
        var fresh: [String: Data] = [:]
        for i in 0..<30 { fresh["new-\(i)"] = SecretCrypto.randomKey() }
        rig.keyStore.addPrekeySecrets(fresh, nowMs: 2_000)
        let base = rig.keyStore.prekeySecretCount()
        XCTAssertEqual(rig.keyStore.prunePrekeySecrets(nowMs: 3_000, cap: base - 10), 10)
        XCTAssertNil(rig.keyStore.prekeySecret("old-0"), "сверх потолка уходят самые старые")
        XCTAssertNotNil(rig.keyStore.prekeySecret("new-0"))

        rig.keyStore.markPrekeysUsed(["new-1"], nowMs: 3_000)
        XCTAssertEqual(rig.keyStore.prunePrekeySecrets(nowMs: 3_000 + 60_000), 0, "использованный живёт сутки")
        XCTAssertNotNil(rig.keyStore.prekeySecret("new-1"))
        XCTAssertEqual(rig.keyStore.prunePrekeySecrets(nowMs: 3_000 + SecretKeyStore.usedPrekeyGraceMs + 1), 1)
        XCTAssertNil(rig.keyStore.prekeySecret("new-1"))
    }

    func testH04_legacyUnmarkedSecretsAreNeverCutByCap() throws {
        // Секреты старых сборок: без отметок времени (и среди них — ещё не выданные сервером).
        var legacy: [String: Data] = [:]
        for i in 0..<300 { legacy["legacy-\(i)"] = SecretCrypto.randomKey() }
        rig.keyStore.addPrekeySecrets(legacy, nowMs: 1_000)
        rig.keyStore.dropPrekeyCreationMarksForTests()
        let before = rig.keyStore.prekeySecretCount()
        XCTAssertEqual(rig.keyStore.prunePrekeySecrets(nowMs: 2_000, cap: 100), 0, "порядок легаси неизвестен — потолком не режем")
        XCTAssertEqual(rig.keyStore.prekeySecretCount(), before)
        // Новые секреты (с отметкой) режутся потолком, легаси — нет.
        var fresh: [String: Data] = [:]
        for i in 0..<105 { fresh["fresh-\(i)"] = SecretCrypto.randomKey() }
        rig.keyStore.addPrekeySecrets(fresh, nowMs: 3_000)
        var newest: [String: Data] = [:]
        for i in 0..<5 { newest["newest-\(i)"] = SecretCrypto.randomKey() }
        rig.keyStore.addPrekeySecrets(newest, nowMs: 4_000)
        XCTAssertEqual(rig.keyStore.prunePrekeySecrets(nowMs: 5_000, cap: 100), 10)
        for i in 0..<300 { XCTAssertNotNil(rig.keyStore.prekeySecret("legacy-\(i)")) }
        for i in 0..<5 { XCTAssertNotNil(rig.keyStore.prekeySecret("newest-\(i)")) }
        // Легаси уходит только по «вскрыт + сутки».
        rig.keyStore.markPrekeysUsed(["legacy-7"], nowMs: 5_000)
        XCTAssertEqual(rig.keyStore.prunePrekeySecrets(nowMs: 5_000 + SecretKeyStore.usedPrekeyGraceMs + 1, cap: 100), 1)
        XCTAssertNil(rig.keyStore.prekeySecret("legacy-7"))
    }

    func testH04_usedPrekeyIsMarkedAfterImport() async throws {
        let prekey = rig.makeMyPrekey("used-pk")
        let item = rig.keyPackageItem(
            from: peer, prekey: prekey, packageKind: "thread_key",
            payload: rig.threadKeyPayload(threadId: thread, key: SecretCrypto.randomKey()), headerThreadId: thread
        )
        rig.server.inbox = [item]
        await rig.repo.syncInbox()
        XCTAssertNotNil(rig.keyStore.prekeySecret("used-pk"), "сразу не удаляется (повторная доставка)")
        rig.keyStore.prunePrekeySecrets(nowMs: SecretKeyStore.nowMs() + SecretKeyStore.usedPrekeyGraceMs + 1)
        XCTAssertNil(rig.keyStore.prekeySecret("used-pk"), "через сутки — удалён")
    }

    // MARK: - H13: выход и вход — новый id устройства

    func testH13_logoutWipesKeysAndRotatesDeviceId() {
        let before = rig.deviceIds.deviceId()
        rig.keyStore.setThreadKey(thread, key: SecretCrypto.randomKey())
        rig.repo.clearLocalData()
        XCTAssertNotEqual(rig.deviceIds.deviceId(), before)
        XCTAssertEqual(rig.keyStore.identityState(), .missing)
        XCTAssertNil(rig.keyStore.threadKey(thread))
    }

    func testH13_logoutRevokesTheOldDeviceIdOnServer() async throws {
        // «Выйти» отзывает прежний id (как веб и Android) — иначе копились бы живые зомби.
        let id = rig.deviceIds.deviceId()
        let ok = await rig.devices.revokeDevice(id, timeoutSeconds: 5)
        XCTAssertTrue(ok)
        XCTAssertEqual(rig.server.calls("DELETE", "devices/\(id)").count, 1)
        rig.server.deleteDeviceStatus = 404
        let failed = await rig.devices.revokeDevice(id, timeoutSeconds: 5)
        XCTAssertFalse(failed, "сбой отзыва — best-effort, выход не блокирует")
    }

    func testH13_bootstrapWithWipedKeysUnderRegisteredIdRotates() async throws {
        // Ключи стёрты старой версией (id прежний, на сервере живой) — новый id.
        let oldId = rig.deviceIds.deviceId()
        rig.keyStore.clear()
        rig.server.myDevices = [rig.deviceRecord(id: oldId, identity: SecretCrypto.randomKey())]
        let ok = await rig.repo.ensureDeviceBootstrap()
        XCTAssertTrue(ok)
        let registered = rig.server.calls("POST", "devices/register")
        XCTAssertEqual(registered.count, 1)
        let newId = (registered[0].json as? [String: Any])?["deviceId"] as? String
        XCTAssertNotEqual(newId, oldId)
        XCTAssertEqual(newId, rig.deviceIds.deviceId())
    }

    func testH13_bootstrapKeepsIdWhenIdentitySurvived() async throws {
        let id = rig.deviceIds.deviceId()
        rig.keyStore.clearBootstrapped()
        let ok = await rig.repo.ensureDeviceBootstrap()
        XCTAssertTrue(ok)
        XCTAssertEqual((rig.server.calls("POST", "devices/register").first?.json as? [String: Any])?["deviceId"] as? String, id)
    }

    // MARK: - X5: отзыв устройства

    func testX5_bootstrapOnRevokedIdWipesKeysAndLogsOutWithoutRegistering() async throws {
        let oldId = rig.deviceIds.deviceId()
        rig.keyStore.setThreadKey(thread, key: SecretCrypto.randomKey())
        rig.server.myDevices = [rig.deviceRecord(id: oldId, identity: rig.keyStore.identity()!.publicKey, revoked: true)]
        rig.keyStore.clearBootstrapped()
        let revoked = Box<[String]>([])
        rig.repo.deviceRevokedLocally.sink { revoked.value.append($0) }.store(in: &subscriptions)
        let ok = await rig.repo.ensureDeviceBootstrap()
        XCTAssertFalse(ok)
        XCTAssertTrue(rig.server.calls("POST", "devices/register").isEmpty,
                      "ни отозванный, ни НОВЫЙ id в этой сессии не регистрируются (украденный телефон не оживает)")
        XCTAssertNotEqual(rig.deviceIds.deviceId(), oldId)
        XCTAssertNil(rig.keyStore.threadKey(thread), "ключи отозванного устройства стёрты")
        XCTAssertEqual(revoked.value.count, 1, "RootView выходит из аккаунта")
        // Повторный бутстрап в той же сессии (инбокс, холодный старт) — по-прежнему ничего.
        let again = await rig.repo.ensureDeviceBootstrap()
        XCTAssertFalse(again)
        XCTAssertTrue(rig.server.calls("POST", "devices/register").isEmpty)
        // Следующий вход — чистое новое устройство.
        rig.relogin()
        rig.server.myDevices = []
        let afterLogin = await rig.repo.ensureDeviceBootstrap()
        XCTAssertTrue(afterLogin)
        let registeredIds = rig.server.calls("POST", "devices/register").compactMap { ($0.json as? [String: Any])?["deviceId"] as? String }
        XCTAssertEqual(registeredIds, [rig.deviceIds.deviceId()])
        XCTAssertFalse(registeredIds.contains(oldId))
    }

    func testX5_revocationNoticedAfterLogoutDoesNotLockNextLogin() async throws {
        rig.session.clear()
        rig.repo.noteDeviceRevoked() // сессии нет — отметка не ставится
        rig.relogin()
        XCTAssertFalse(rig.repo.registrationBlocked())
    }

    func testX5_inbox400OnRevokedDeviceRotatesInsteadOfResurrecting() async throws {
        let oldId = rig.deviceIds.deviceId()
        rig.server.pullStatus = 400
        rig.server.myDevices = [rig.deviceRecord(id: oldId, identity: rig.keyStore.identity()!.publicKey, revoked: true)]
        let revoked = Box(0)
        rig.repo.deviceRevokedLocally.sink { _ in revoked.value += 1 }.store(in: &subscriptions)
        await rig.repo.syncInbox()
        XCTAssertTrue(rig.server.calls("POST", "devices/register").isEmpty, "ни старый, ни новый id в этой сессии")
        XCTAssertNotEqual(rig.deviceIds.deviceId(), oldId)
        XCTAssertEqual(revoked.value, 1, "выход из аккаунта")
    }

    func testX5_B6_inbox400OnUnknownDeviceSelfHealsWithSameId() async throws {
        // Б6: «id не признан» по другой причине (восстановление БД) — самолечение тем же id.
        let id = rig.deviceIds.deviceId()
        let thread1Key = SecretCrypto.randomKey()
        rig.keyStore.setThreadKey(thread, key: thread1Key)
        rig.server.pullStatus = 400
        rig.server.myDevices = []
        await rig.repo.syncInbox()
        let registeredIds = rig.server.calls("POST", "devices/register").compactMap { ($0.json as? [String: Any])?["deviceId"] as? String }
        XCTAssertEqual(registeredIds, [id])
        XCTAssertEqual(rig.keyStore.threadKey(thread), thread1Key, "ключи не тронуты")
    }

    func testX5_registerRefusedAsRevokedRotatesAndWipes() async throws {
        // Будущий серверный запрет (волна 3, S5): register отозванного id → 409 «revoked».
        let oldId = rig.deviceIds.deviceId()
        rig.keyStore.setThreadKey(thread, key: SecretCrypto.randomKey())
        rig.keyStore.clearBootstrapped()
        rig.server.devicesStatus = 503 // список устройств недоступен — решает ответ register
        rig.server.registerResponses = [(409, ["message": "Device is revoked"])]
        let revoked = Box(0)
        rig.repo.deviceRevokedLocally.sink { _ in revoked.value += 1 }.store(in: &subscriptions)
        let ok = await rig.repo.ensureDeviceBootstrap()
        XCTAssertFalse(ok)
        let registeredIds = rig.server.calls("POST", "devices/register").compactMap { ($0.json as? [String: Any])?["deviceId"] as? String }
        XCTAssertEqual(registeredIds, [oldId], "новый id в этой сессии не регистрируется — выход")
        XCTAssertNotEqual(rig.deviceIds.deviceId(), oldId)
        XCTAssertNil(rig.keyStore.threadKey(thread))
        XCTAssertEqual(revoked.value, 1)
    }

    func testX5_registerConflictWithOtherAccountRotatesWithoutWipe() async throws {
        let key = SecretCrypto.randomKey()
        rig.keyStore.setThreadKey(thread, key: key)
        rig.keyStore.clearBootstrapped()
        rig.server.myDevices = []
        rig.server.registerResponses = [(409, ["message": "Device already registered to another user"])]
        let ok = await rig.repo.ensureDeviceBootstrap()
        XCTAssertTrue(ok)
        XCTAssertEqual(rig.server.calls("POST", "devices/register").count, 2)
        XCTAssertEqual(rig.keyStore.threadKey(thread), key)
    }

    func testX5_registerKeepsFailingNoLoop() async throws {
        rig.keyStore.clearBootstrapped()
        rig.server.myDevices = []
        rig.server.registerResponses = [
            (409, ["message": "Device already registered to another user"]),
            (409, ["message": "Device already registered to another user"]),
        ]
        let ok = await rig.repo.ensureDeviceBootstrap()
        XCTAssertFalse(ok)
        XCTAssertEqual(rig.server.calls("POST", "devices/register").count, 2, "не больше двух попыток")
    }

    func testX5_revocationVerdictTable() {
        typealias R = SecretRepository
        XCTAssertEqual(R.revocationVerdict(revokedDeviceId: "me-dev", viaConnectError: false, myDeviceId: "me-dev", status: nil), .logout)
        XCTAssertEqual(R.revocationVerdict(revokedDeviceId: "*", viaConnectError: false, myDeviceId: "me-dev", status: nil), .logout)
        XCTAssertEqual(R.revocationVerdict(revokedDeviceId: "other", viaConnectError: false, myDeviceId: "me-dev", status: nil), .ignore)
        XCTAssertEqual(R.revocationVerdict(revokedDeviceId: "me-dev", viaConnectError: true, myDeviceId: "me-dev", status: .revoked), .logout)
        XCTAssertEqual(R.revocationVerdict(revokedDeviceId: "me-dev", viaConnectError: true, myDeviceId: "me-dev", status: .missing), .rebootstrap)
        XCTAssertEqual(R.revocationVerdict(revokedDeviceId: "me-dev", viaConnectError: true, myDeviceId: "me-dev", status: .live), .ignore)
        XCTAssertEqual(R.revocationVerdict(revokedDeviceId: "me-dev", viaConnectError: true, myDeviceId: "me-dev", status: nil), .ignore)
        XCTAssertEqual(R.revocationVerdict(revokedDeviceId: "old-dev", viaConnectError: true, myDeviceId: "me-dev", status: .revoked), .ignore)
    }

    func testX5_socketRevocationChecksServerBeforeLogout() async throws {
        let id = rig.deviceIds.deviceId()
        rig.server.myDevices = [rig.deviceRecord(id: id, identity: rig.keyStore.identity()!.publicKey, revoked: true)]
        let verdict = await rig.repo.revocationVerdict(revokedDeviceId: id, viaConnectError: true)
        XCTAssertEqual(verdict, .logout)
        // Повторный connect_error сразу же — без нового похода за списком устройств.
        let devicesCalls = rig.server.calls("GET", "devices").count
        _ = await rig.repo.revocationVerdict(revokedDeviceId: id, viaConnectError: true)
        XCTAssertEqual(rig.server.calls("GET", "devices").count, devicesCalls)
    }

    // MARK: - Хранилище ключей треда

    func testKeyStoreReplaceKeepsBoundedPreviousKeys() {
        let keys = (0..<7).map { _ in SecretCrypto.randomKey() }
        XCTAssertEqual(rig.keyStore.replaceThreadKey("t", key: keys[0]), .added)
        XCTAssertEqual(rig.keyStore.replaceThreadKey("t", key: keys[0]), .unchanged)
        for key in keys.dropFirst() { XCTAssertEqual(rig.keyStore.replaceThreadKey("t", key: key), .replaced) }
        XCTAssertEqual(rig.keyStore.threadKey("t"), keys[6])
        XCTAssertEqual(rig.keyStore.previousThreadKeys("t"), Array(keys[2..<6].reversed()))
        XCTAssertEqual(rig.keyStore.threadKeysForDecrypt("t").first, keys[6])
        XCTAssertEqual(rig.keyStore.replaceThreadKey("t", key: SecretCrypto.randomBytes(31)), .rejected)
        rig.keyStore.removeThreadKey("t")
        XCTAssertTrue(rig.keyStore.threadKeysForDecrypt("t").isEmpty)
    }

    // MARK: - Совместимость: честный поток не задет

    func testCompat_honestFlowStillWorks() async throws {
        // Ключ от собеседника (как у веба/Android/натива), затем его сообщение — ack всего.
        let key = SecretCrypto.randomKey()
        let keyItem = rig.keyPackageItem(
            from: peer, prekey: rig.makeMyPrekey(), packageKind: "thread_key",
            payload: rig.threadKeyPayload(threadId: thread, key: key), headerThreadId: thread
        )
        let msg = rig.msgItem(threadId: thread, from: peer.userId, text: "секрет", key: key)
        let receipt = rig.controlItem(
            type: "key_receipt", threadId: thread, senderUserId: peer.userId,
            senderDeviceId: peer.deviceId, requesterDeviceId: nil, fromDeviceId: peer.deviceId
        )
        rig.server.inbox = [keyItem, msg, receipt]
        let received = Box<[String]>([])
        rig.repo.incoming.sink { received.value.append($0.text) }.store(in: &subscriptions)
        await rig.repo.syncInbox()
        XCTAssertEqual(rig.keyStore.threadKey(thread), key)
        XCTAssertEqual(received.value, ["секрет"])
        XCTAssertEqual(Set(rig.server.ackedIds), Set([keyItem, msg, receipt].map { $0["msgId"] as! String }))
        // Конверты, которые шлёт iOS, проходят серверную форму S2 (kind — строка, v/ts — целые).
        for envelope in rig.server.sentEnvelopes {
            let header = envelope["headerJson"] as? [String: Any]
            XCTAssertNotNil(header?["kind"] as? String)
        }
    }
}
