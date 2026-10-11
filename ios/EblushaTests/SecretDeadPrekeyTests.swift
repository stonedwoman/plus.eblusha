import Combine
import XCTest
@testable import Eblusha

/// Лечение мёртвых OPK (SecretRepository.purgeStalePrekeys и разбор пакетов на них): правила,
/// которых не видно в сценарии владельца (SecretLinkNeededTests) — живое не жжём, Keychain-сбой
/// не путаем с потерей, гонку с отправителем переживаем, отражателем key_request не становимся.
final class SecretDeadPrekeyTests: XCTestCase {
    private var rig: SecretTestRig!
    private var subscriptions: Set<AnyCancellable> = []
    private let thread = "thread-dp"
    private var peer: FakeDevice!
    private var evil: FakeDevice!
    private var mine2: FakeDevice!

    override func setUp() {
        super.setUp()
        peer = FakeDevice(userId: "user-peer", deviceId: "dev-peer-1")
        evil = FakeDevice(userId: "user-evil", deviceId: "dev-evil-1")
        rig = SecretTestRig()
        rig.bootstrapLocally()
        mine2 = FakeDevice(userId: rig.me, deviceId: "dev-me-2")
        rig.server.myDevices.append(rig.deviceRecord(id: mine2.deviceId, identity: mine2.identity.publicKey))
        rig.server.addSecretThread(thread, participants: [rig.me, peer.userId])
        rig.server.bundles = [peer.userId: [peer.deviceId], evil.userId: [evil.deviceId]]
    }

    override func tearDown() {
        subscriptions.removeAll()
        rig.tearDown()
        rig = nil
        super.tearDown()
    }

    private var myId: String { rig.deviceIds.deviceId() }

    private var myBundleReads: Int {
        rig.server.calls("GET", "e2ee/prekeys/bundles").filter { $0.query["userId"] == rig.me }.count
    }

    private func deadPackage(from sender: FakeDevice, kind: String = "thread_key", threadId: String? = nil) throws -> [String: Any] {
        let prekey = try XCTUnwrap(rig.server.takeServerPrekey(myId))
        let target = threadId ?? thread
        let payload = kind == "thread_key"
            ? rig.threadKeyPayload(threadId: target, key: SecretCrypto.randomKey())
            : rig.deviceLinkPayload([target: SecretCrypto.randomKey()])
        return rig.keyPackageItem(
            from: sender, prekey: prekey, packageKind: kind, payload: payload,
            headerThreadId: kind == "thread_key" ? target : nil
        )
    }

    func testPrekeySecretState() {
        let live = rig.makeMyPrekey()
        XCTAssertEqual(rig.keyStore.prekeySecretState(live.keyId), .present)
        XCTAssertEqual(rig.keyStore.prekeySecretState("never-published"), .missing)
    }

    func testLiveHeadIsLeftAloneAndTheCheckIsCached() async {
        let seeded = rig.seedMyServerPrekeys(dead: 0, live: 3)
        let first = await rig.repo.purgeStalePrekeys()
        XCTAssertEqual(first, SecretRepository.StalePrekeyPurge(burned: 0, healthy: true))
        XCTAssertEqual(rig.server.serverPrekeyIds(myId), seeded.live)
        XCTAssertTrue(rig.server.calls("POST", "e2ee/prekeys/claim").isEmpty, "живое не жжём")
        XCTAssertEqual(myBundleReads, 1)

        // Повторная проверка без повода — из кэша, без сети.
        _ = await rig.repo.purgeStalePrekeys()
        XCTAssertEqual(myBundleReads, 1)
    }

    func testForcedCheckBypassesCacheAndBurnsANewlyDeadHead() async {
        rig.seedMyServerPrekeys(dead: 0, live: 2)
        _ = await rig.repo.purgeStalePrekeys()
        // Голова умерла после удачной проверки (например, Keychain потерял секреты).
        let dead = rig.makeDeadPrekey()
        rig.server.serverPrekeys[myId]?.insert(dead, at: 0)
        let cached = await rig.repo.purgeStalePrekeys()
        XCTAssertEqual(cached.burned, 0)
        let forced = await rig.repo.purgeStalePrekeys(force: true)
        XCTAssertEqual(forced.burned, 1)
        XCTAssertFalse(rig.server.serverPrekeyIds(myId).contains(dead.keyId))
    }

    func testBurningTheWholeQueueReplenishes() async {
        rig.seedMyServerPrekeys(dead: 2, live: 0)
        rig.server.myDevices[0]["availablePrekeys"] = 0
        let result = await rig.repo.purgeStalePrekeys(force: true)
        XCTAssertEqual(result, SecretRepository.StalePrekeyPurge(burned: 2, healthy: true))
        XCTAssertEqual(rig.server.calls("POST", "devices/\(myId)/prekeys").count, 1, "пустую очередь пополнили")
    }

    func testRaceWithSenderCostsAtMostOneLiveKeyAndDropsItsSecret() async {
        let seeded = rig.seedMyServerPrekeys(dead: 1, live: 3)
        let server = rig.server
        let myId = self.myId
        let raced = Box(false)
        // Между «подсмотрели голову» и «забрали её» мёртвую голову успел забрать отправитель:
        // наш claim получает уже живой OPK.
        server.extraRoute = { [weak server] method, path, _ in
            guard let server, method == "POST", path == "e2ee/prekeys/claim", !raced.value else { return nil }
            raced.value = true
            _ = server.takeServerPrekey(myId)
            guard let live = server.takeServerPrekey(myId) else { return nil }
            return (200, FakeServer.data([
                "deviceId": myId, "identityKey": "x",
                "prekey": ["keyId": live.keyId, "publicKey": SecretCrypto.b64UrlEncode(live.publicKey)],
            ]))
        }
        let result = await rig.repo.purgeStalePrekeys(force: true)
        XCTAssertEqual(result, SecretRepository.StalePrekeyPurge(burned: 0, healthy: true))
        XCTAssertEqual(rig.server.serverPrekeyIds(myId), Array(seeded.live.dropFirst()))
        XCTAssertEqual(rig.keyStore.prekeySecretState(seeded.live[0]), .missing, "секрет съеденного живого OPK убран")
        XCTAssertEqual(rig.keyStore.prekeySecretState(seeded.live[1]), .present)
    }

    func testNothingIsBurnedBeforeBootstrapOrWithoutOurBundle() async {
        // Наше устройство в bundles не видно (отозвано/не зарегистрировано) — чинить нечего.
        rig.seedMyServerPrekeys(dead: 2, live: 1)
        rig.server.bundles[rig.me] = [mine2.deviceId]
        let hidden = await rig.repo.purgeStalePrekeys(force: true)
        XCTAssertEqual(hidden, SecretRepository.StalePrekeyPurge())
        XCTAssertTrue(rig.server.calls("POST", "e2ee/prekeys/claim").isEmpty)

        rig.keyStore.clearBootstrapped()
        rig.server.bundles[rig.me] = [myId]
        let before = rig.server.calls.count
        _ = await rig.repo.purgeStalePrekeys(force: true)
        XCTAssertEqual(rig.server.calls.count, before, "до бутстрапа ни одного запроса")
    }

    func testDeadPackageFromOutsiderOrForeignDeviceIsAckedWithoutResendRequest() async throws {
        rig.seedMyServerPrekeys(dead: 3, live: 2, others: [mine2.deviceId])
        // Посторонний (не участник треда) и участник, назвавший чужое устройство.
        let fromOutsider = try deadPackage(from: evil)
        let forged = FakeDevice(userId: peer.userId, deviceId: "dev-not-peers")
        let fromForgedDevice = try deadPackage(from: forged)
        rig.server.inbox = [fromOutsider, fromForgedDevice]
        await rig.repo.syncInbox()
        XCTAssertEqual(Set(rig.server.ackedIds), Set([fromOutsider, fromForgedDevice].map { $0["msgId"] as! String }))
        XCTAssertTrue(rig.server.sentKeyRequests.isEmpty, "отражателем key_request не становимся")
        XCTAssertEqual(rig.server.claims(of: myId, by: myId), 1, "мёртвый остаток всё равно сожжён")
    }

    func testResendRequestIsOncePerThreadPerCooldown() async throws {
        rig.seedMyServerPrekeys(dead: 3, live: 2, others: [mine2.deviceId])
        let a = try deadPackage(from: mine2)
        let b = try deadPackage(from: mine2)
        rig.server.inbox = [a, b]
        await rig.repo.syncInbox()
        XCTAssertEqual(rig.server.sentKeyRequests.map(\.to), [mine2.deviceId], "два пакета — одна просьба")

        // Ещё один мёртвый (голову снова испортили) в пределах 30 с — новой просьбы нет.
        rig.server.serverPrekeys[myId]?.insert(rig.makeDeadPrekey(), at: 0)
        rig.server.inbox = [try deadPackage(from: mine2)]
        await rig.repo.syncInbox()
        XCTAssertEqual(rig.server.sentKeyRequests.count, 1)
    }

    func testDeadDeviceLinkPackageIsAckedAndSignalsLinkFailure() async throws {
        rig.seedMyServerPrekeys(dead: 2, live: 2, others: [mine2.deviceId])
        let failed = Box(0)
        rig.repo.deviceLinkFailed.sink { failed.value += 1 }.store(in: &subscriptions)
        let linked = Box(0)
        rig.repo.deviceLinked.sink { _ in linked.value += 1 }.store(in: &subscriptions)
        let item = try deadPackage(from: mine2, kind: "device_link_keys", threadId: "linked-thread")
        rig.server.inbox = [item]
        await rig.repo.syncInbox()
        XCTAssertEqual(rig.server.ackedIds, [item["msgId"] as! String])
        XCTAssertNil(rig.keyStore.threadKey("linked-thread"))
        XCTAssertEqual(failed.value, 1, "экран привязки узнаёт, что ждать нечего")
        XCTAssertEqual(linked.value, 0)
        XCTAssertEqual(rig.server.claims(of: myId, by: myId), 1)
        XCTAssertTrue(rig.server.sentKeyRequests.isEmpty, "связку не переслать — просить некого")
    }

    func testAcceptAndDeviceLinkBurnDeadPrekeysFirst() async throws {
        let seeded = rig.seedMyServerPrekeys(dead: 2, live: 2, others: [mine2.deviceId])
        rig.server.extraRoute = { method, path, _ in
            if method == "POST", path == "threads/secret/\("thread-dp")/accept" {
                return (200, FakeServer.data(["ok": true, "conversationId": "thread-dp"]))
            }
            return nil
        }
        _ = await rig.repo.acceptInvite(threadId: thread)
        XCTAssertEqual(rig.server.serverPrekeyIds(myId), seeded.live, "создатель запечатает ключ на живой OPK")

        // Привязка (свежий запуск того же устройства — без кэша проверки): мёртвая голова
        // сжигается ДО link_device_join.
        rig.server.serverPrekeys[myId]?.insert(rig.makeDeadPrekey(), at: 0)
        let fresh = SecretRepository(
            api: rig.api, devices: rig.devices, keyStore: rig.keyStore, deviceIdProvider: rig.deviceIds, session: rig.session
        )
        _ = await fresh.requestDeviceLink(tokenOrCode: "12345678")
        let calls = rig.server.calls.map { "\($0.method) \($0.path)" }
        let lastClaim = try XCTUnwrap(calls.lastIndex(of: "POST e2ee/prekeys/claim"))
        let joinSent = try XCTUnwrap(calls.lastIndex(of: "POST secret/send"))
        XCTAssertLessThan(lastClaim, joinSent)
        XCTAssertEqual(rig.server.serverPrekeyIds(myId).first, seeded.live[0])
    }

    /// Секреты OPK не легли в Keychain — такие OPK не публикуются вовсе: иначе они мёртвые с
    /// рождения, а лечение жгло бы их и перепубликовывало новые мёртвые по кругу.
    func testPrekeysWhoseSecretsWereNotSavedAreNeverPublished() async {
        rig.seedMyServerPrekeys(dead: 2, live: 0)
        rig.server.myDevices[0]["availablePrekeys"] = 0
        rig.breakKeychainMap("prekey_created")

        let published = await rig.repo.replenishPrekeys()
        XCTAssertFalse(published)
        XCTAssertTrue(rig.server.calls("POST", "devices/\(myId)/prekeys").isEmpty, "мёртвые OPK не публикуем")

        // Мёртвые сжигаются, но взамен новые мёртвые не публикуются.
        let result = await rig.repo.purgeStalePrekeys(force: true)
        XCTAssertEqual(result.burned, 2)
        XCTAssertTrue(rig.server.calls("POST", "devices/\(myId)/prekeys").isEmpty)

        // Регистрация в том же состоянии: устройство регистрируется (push, инбокс), но без OPK.
        rig.keyStore.clearBootstrapped()
        let registered = await rig.repo.ensureDeviceBootstrap()
        XCTAssertTrue(registered)
        let body = rig.server.calls("POST", "devices/register").last?.json as? [String: Any]
        XCTAssertEqual((body?["prekeys"] as? [Any])?.count, 0)
    }

    /// Выход/отзыв меняют id: удачная проверка головы прежнего id о новом ничего не говорит.
    func testHeadCheckCacheBelongsToTheDeviceId() async {
        rig.seedMyServerPrekeys(dead: 0, live: 2)
        _ = await rig.repo.purgeStalePrekeys()
        XCTAssertEqual(myBundleReads, 1)

        _ = rig.deviceIds.rotate()
        let seeded = rig.seedMyServerPrekeys(dead: 1, live: 1)
        let result = await rig.repo.purgeStalePrekeys()
        // Голова нового id просмотрена дважды (мёртвая → сожгли → живая), а не взята из кэша.
        XCTAssertEqual(myBundleReads, 3, "новый id проверяется, а не берётся из кэша прежнего")
        XCTAssertEqual(result.burned, 1)
        XCTAssertEqual(rig.server.serverPrekeyIds(myId), seeded.live)
    }

    /// Проверка по поводу (пакет на мёртвый OPK) сорвалась на сети — прежняя удачная отметка
    /// не должна прятать мёртвую голову от следующей обычной проверки.
    func testFailedForcedCheckDoesNotLeaveAStaleOk() async {
        rig.seedMyServerPrekeys(dead: 0, live: 2)
        _ = await rig.repo.purgeStalePrekeys()
        rig.server.bundlesStatus = 500
        let failed = await rig.repo.purgeStalePrekeys(force: true)
        XCTAssertFalse(failed.healthy)
        rig.server.bundlesStatus = 200
        let before = myBundleReads
        _ = await rig.repo.purgeStalePrekeys()
        XCTAssertEqual(myBundleReads, before + 1, "после сорванной проверки кэшу не верим")
    }
}
