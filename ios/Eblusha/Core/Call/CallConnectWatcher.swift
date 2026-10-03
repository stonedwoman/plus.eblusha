import Foundation
import CoreFoundation
import LiveKit

/// Наблюдатель хода подключения — порт веб-`ConnectProgressWatcher` (CallOverlay.tsx).
///
/// Живёт внутри комнаты и сообщает наружу то, что видно только оттуда: опубликован ли наш
/// микрофон, стал ли собеседник слышен (в шифрованных звонках — и объявил ли шифрование),
/// каким путём легло соединение — через какой ретранслятор и с какой задержкой — и
/// дорисовал ли собеседник свою картину.
///
/// Разговор начинается не когда мы подключились, а когда СОБЕСЕДНИК стал полноценным
/// участником: пришёл в комнату, его звук подписан, и (в шифрованных звонках) у него
/// загорелся замочек. Но и вечно ждать звука нельзя: кто вошёл без микрофона, звука не
/// даст — об этом он говорит в рукопожатии (audio:false), а кто рукопожатия не знает
/// (старый клиент) — того ждём короткую паузу.
///
/// Рукопожатие по data-каналу, совместимое с вебом бит в бит: «рисую» при подключении и
/// при появлении собеседника, «готов» — когда наша картина дорисована. На чужое «рисую»
/// отвечаем своим состоянием один раз, чтобы вошедший позже узнал о нас. Так разговор
/// открывается у обоих разом.
///
/// Подключается к комнате ОТДЕЛЬНЫМ делегатом (у LiveKit их может быть несколько), поэтому
/// звонком не управляет и в CallManager не вмешивается. Всё состояние — на главном потоке.
final class CallConnectWatcher: NSObject {

    /// Тема data-канала, по которой клиенты сообщают друг другу о готовности своей картины.
    static let topic = "eb.connect"
    /// Собеседник прислал «рисую», но «готов» так и не пришло: дольше этого не ждём.
    private static let syncMaxWaitMs: Double = 8000
    /// От собеседника нет ни слова (старый клиент): столько ждём после его готовности и нашего «рисую».
    private static let syncLegacyGraceMs: Double = 1500
    /// Собеседник в комнате, но ни дорожки, ни вестей (вошёл без микрофона?): столько ждём.
    private static let noAudioGraceMs: Double = 5000
    /// Звук собеседника идёт, а замочек всё не загорается — дальше это ошибка шифрования, а не ожидание.
    private static let e2eeConfirmMs: Double = 15000

    /// Изменилось что-то из того, что видно наружу. Зовётся на главном потоке.
    var onChange: (() -> Void)?

    private(set) var progress: ConnectProgress = .empty
    /// Криптор НАШЕЙ дорожки отчитался, что кадры шифруются (E2EEState.ok). Это и есть
    /// «шифрование включено на нашем соединении»: у iOS-SDK нет отдельного события
    /// «включено для участника», как у веба, но есть честный отчёт шифратора.
    private(set) var localEncryptionOk = false
    /// Криптор чужой дорожки отчитался, что кадры расшифровываются. Нужен как
    /// подтверждение только тогда, когда своей дорожки нет вовсе (микрофон не дали).
    private(set) var remoteDecryptionOk = false

    private weak var room: Room?
    private var encrypted = false
    private var sync = false
    private var localSettled = false
    private var localAudio = true

    /// Что видно в комнате.
    private struct Peers: Equatable {
        var count = 0
        /// У кого-то объявлена аудиодорожка (подписка на подходе).
        var published = false
        /// У кого-то есть подписанная аудиодорожка (пусть ещё без подтверждения шифрования).
        var audible = false
        /// Кто-то слышен по-настоящему: звук идёт и (в шифрованных звонках) замочек горит.
        var heard = false
        var name: String?
        var joinedAt: Double?
        var audibleAt: Double?
    }
    private var peers = Peers()
    private var route: ConnectRoute = .empty
    private var micPublished = false

    private enum SyncState: String { case none, connecting, settled }
    /// Что собеседник сообщил о себе: состояние картины, когда пришло ПЕРВОЕ «рисую», будет ли звук.
    private struct PeerSync: Equatable {
        var state: SyncState = .none
        var since: Double = 0
        var audio: Bool?
    }
    private var peerSync = PeerSync()
    /// Кому мы уже ответили на «рисую» — чтобы эхо не ходило по кругу.
    private var answered = Set<String>()
    /// Когда собеседник стал готов — от этого момента ждём «молчуна».
    private var readyAt: Double?
    /// Когда наше «рисую» реально ушло: раньше этого молчание собеседника ничего не значит.
    private var announcedAt: Double?
    /// Пересчёт по истечении ближайшего срока ожидания.
    private var deadlineWork: DispatchWorkItem?
    /// Дорожка, чью статистику читаем ради пути к серверу.
    private var statsTrack: Track?

    // MARK: - Жизненный цикл

    /// Подключиться к комнате. `encrypted` — комната собрана с шифрованием;
    /// `sync` — ждать ли собеседника через рукопожатие (только разговоры один на один).
    func attach(room: Room, encrypted: Bool, sync: Bool) {
        detach()
        self.room = room
        self.encrypted = encrypted
        self.sync = sync
        room.add(delegate: self)
        check()
        updateLocal()
        announce()
        recompute()
    }

    /// Отключиться: экран ушёл или звонок кончился. Сведения о старой комнате к новой не относятся.
    func detach() {
        room?.remove(delegate: self)
        statsTrack?.remove(delegate: self)
        statsTrack = nil
        room = nil
        deadlineWork?.cancel()
        deadlineWork = nil
        peers = Peers()
        route = .empty
        micPublished = false
        peerSync = PeerSync()
        answered.removeAll()
        readyAt = nil
        announcedAt = nil
        localEncryptionOk = false
        remoteDecryptionOk = false
        localSettled = false
        localAudio = true
        progress = .empty
    }

    /// Группа выясняется из кеша бесед параллельно с подключением и может прийти уже после
    /// него. Узнали, что это разговор один на один, — сообщаем о себе, раз «рисую» ещё не ушло.
    func setSync(_ value: Bool) {
        guard value != sync else { return }
        sync = value
        if value { announce() }
        recompute()
    }

    /// Наша картина: дорисована ли (пора сообщить «готов») и будем ли передавать звук.
    func setLocal(settled: Bool, audio: Bool) {
        let becameSettled = settled && !localSettled
        localSettled = settled
        localAudio = audio
        if becameSettled { sendSync(.settled) }
    }

    // MARK: - Комната

    private func check() {
        guard let room else { return }
        let list = Array(room.remoteParticipants.values)
        var published = false
        var audible = false
        var heard = false
        for p in list {
            let audio = p.audioTracks
            if !audio.isEmpty { published = true }
            guard audio.contains(where: { $0.isSubscribed && $0.track != nil }) else { continue }
            audible = true
            // В шифрованных звонках ждём подтверждения шифрования у собеседника — это тот
            // самый замочек на его плитке. Веб берёт participant.isEncrypted: все его
            // публикации объявлены шифрованными.
            if encrypted && !Self.isEncrypted(p) { continue }
            heard = true
        }
        let now = connectMonotonicNowMs()
        var next = peers
        next.count = list.count
        next.published = published
        next.audible = audible
        next.heard = heard
        next.name = list.first.flatMap(Self.displayName)
        next.joinedAt = list.isEmpty ? nil : (peers.joinedAt ?? now)
        next.audibleAt = audible ? (peers.audibleAt ?? now) : nil
        guard next != peers else { return }
        peers = next
        recompute()
    }

    /// Собеседник ушёл: его рукопожатие к новому входу не относится.
    private func onLeft() {
        check()
        guard let room, room.remoteParticipants.isEmpty else { return }
        answered.removeAll()
        readyAt = nil
        peerSync = PeerSync()
        recompute()
    }

    /// Веб: participant.isEncrypted — публикации есть и все объявлены шифрованными.
    private static func isEncrypted(_ p: Participant) -> Bool {
        let publications = p.trackPublications.values
        return !publications.isEmpty && publications.allSatisfy { $0.encryptionType != .none }
    }

    /// Веб: `first?.name || first?.identity?.split('#')[0]`.
    private static func displayName(_ p: Participant) -> String? {
        if let name = p.name, !name.isEmpty { return name }
        guard let identity = p.identity?.stringValue,
              let userPart = identity.components(separatedBy: "#").first,
              !userPart.isEmpty else { return nil }
        return userPart
    }

    /// Опубликован ли наш микрофон (веб: isMicrophoneEnabled && microphoneTrack.trackSid) и
    /// где брать статистику пути.
    private func updateLocal() {
        guard let room else { return }
        let mic = room.localParticipant.trackPublications.values.first { $0.source == .microphone }
        let published = mic.map { !$0.sid.stringValue.isEmpty && !$0.isMuted } ?? false
        if let track = mic?.track, statsTrack !== track {
            statsTrack?.remove(delegate: self)
            statsTrack = track
            track.add(delegate: self)
            // Статистику дорожки SDK по умолчанию не собирает (reportStatistics = false),
            // и путь к серверу было бы узнать неоткуда. Раз в секунду — как опрос на вебе.
            Task { await track.set(reportStatistics: true) }
        }
        guard published != micPublished else { return }
        micPublished = published
        recompute()
    }

    // MARK: - Рукопожатие

    private func announce() {
        sendSync(localSettled ? .settled : .connecting)
    }

    private func sendSync(_ state: SyncState, to identity: Participant.Identity? = nil) {
        guard let room, sync, state != .none else { return }
        // «Рисую» имеет смысл только из подключённой комнаты. «Готов» отправляем и в
        // переподключении, иначе собеседник ждал бы нас по таймауту, а наблюдатель к тому
        // времени уже снят.
        let connection = room.connectionState
        if connection == .disconnected { return }
        if state == .connecting && connection != .connected { return }
        // Тот же текст, что у веба: JSON.stringify({ v: 1, state, audio }).
        let payload = "{\"v\":1,\"state\":\"\(state.rawValue)\",\"audio\":\(localAudio ? "true" : "false")}"
        let options = DataPublishOptions(
            destinationIdentities: identity.map { [$0] } ?? [],
            topic: Self.topic,
            reliable: true
        )
        Task { [weak self] in
            do {
                try await room.localParticipant.publish(data: Data(payload.utf8), options: options)
                DispatchQueue.main.async {
                    guard let self, self.room === room else { return }
                    if state == .connecting && self.announcedAt == nil {
                        self.announcedAt = connectMonotonicNowMs()
                        self.recompute()
                    }
                }
            } catch {
                // Канал данных недоступен — собеседник дождётся нас по таймауту.
            }
        }
    }

    private func onData(_ data: Data, participant: RemoteParticipant?, topic: String) {
        guard let room else { return }
        // LiveKit на приёме заполняет topic ненадёжно (см. eb.ping в CallManager): пустую
        // тему принимаем, если внутри действительно наше сообщение.
        if !topic.isEmpty && topic != Self.topic { return }
        guard let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let raw = object["state"] as? String,
              let state = SyncState(rawValue: raw), state != .none else { return }
        // Участника SDK иногда не резолвит; в разговоре один на один он единственный.
        let sender = participant
            ?? (room.remoteParticipants.count == 1 ? room.remoteParticipants.values.first : nil)
        guard let sender else { return }
        // Веб: typeof msg.audio === 'boolean' — именно логическое, не число.
        var audio: Bool?
        if let value = object["audio"], CFGetTypeID(value as CFTypeRef) == CFBooleanGetTypeID() {
            audio = (value as? Bool)
        }
        // Повторное «рисую» не сдвигает срок ожидания: помним первое, иначе таймаут не наступит.
        if state == .connecting && peerSync.state != .none {
            if peerSync.audio != audio { peerSync.audio = audio }
        } else {
            peerSync = PeerSync(state: state, since: connectMonotonicNowMs(), audio: audio)
        }
        // На «рисую» отвечаем своим состоянием один раз на собеседника: так о нас узнаёт
        // вошедший позже, а эхо по кругу не ходит.
        if state == .connecting {
            let id = sender.identity?.stringValue ?? ""
            if !answered.contains(id) {
                answered.insert(id)
                sendSync(localSettled ? .settled : .connecting, to: sender.identity)
            }
        }
        recompute()
    }

    // MARK: - Готовность собеседника и сроки ожидания

    private func recompute() {
        let now = connectMonotonicNowMs()
        let presence: ConnectPeerPresence
        if peers.count == 0 {
            presence = .absent
        } else if peers.heard {
            presence = .ready
        } else if peers.audible {
            // Звук есть, замочка нет — ждём подтверждения (с пределом: дальше это ошибка E2EE).
            presence = .joining
        } else if peers.published {
            // Дорожка объявлена — подписка на подходе, ждём звука без срока.
            presence = .joining
        } else if peerSync.state != .none && peerSync.audio == false {
            // Сам сказал, что без микрофона: ждать нечего.
            presence = .ready
        } else if peerSync.state == .settled {
            // Дорисовал картину, а дорожки так и нет — значит, звука не будет.
            presence = .ready
        } else if peerSync.state == .connecting {
            presence = now - peerSync.since >= Self.syncMaxWaitMs ? .ready : .joining
        } else if let joinedAt = peers.joinedAt, now - joinedAt >= Self.noAudioGraceMs {
            presence = .ready
        } else {
            presence = .joining
        }

        if presence == .ready {
            if readyAt == nil { readyAt = now }
        } else {
            readyAt = nil
        }
        let legacyFrom: Double? = {
            guard let readyAt, let announcedAt else { return nil }
            return max(readyAt, announcedAt)
        }()
        let peerSettled: Bool
        if !sync {
            peerSettled = true
        } else if peerSync.state == .settled {
            peerSettled = true
        } else if peerSync.state == .connecting {
            peerSettled = now - peerSync.since >= Self.syncMaxWaitMs
        } else {
            peerSettled = presence == .ready && legacyFrom.map { now - $0 >= Self.syncLegacyGraceMs } == true
        }
        let peerEncryptionTimeout = encrypted && peers.audible && !peers.heard
            && peers.audibleAt.map { now - $0 >= Self.e2eeConfirmMs } == true

        var deadlines: [Double] = []
        if presence == .joining && !peers.audible && !peers.published {
            if peerSync.state == .connecting {
                deadlines.append(peerSync.since + Self.syncMaxWaitMs)
            } else if peerSync.state == .none, let joinedAt = peers.joinedAt {
                deadlines.append(joinedAt + Self.noAudioGraceMs)
            }
        }
        if encrypted && peers.audible && !peers.heard, let audibleAt = peers.audibleAt, !peerEncryptionTimeout {
            deadlines.append(audibleAt + Self.e2eeConfirmMs)
        }
        if sync && !peerSettled {
            if peerSync.state == .connecting {
                deadlines.append(peerSync.since + Self.syncMaxWaitMs)
            } else if presence == .ready, let legacyFrom {
                deadlines.append(legacyFrom + Self.syncLegacyGraceMs)
            }
        }
        scheduleDeadline(deadlines.min())

        let next = ConnectProgress(
            micPublished: micPublished,
            peerPresence: presence,
            peerCount: peers.count,
            peerName: peers.name,
            peerSettled: peerSettled,
            peerEncryptionTimeout: peerEncryptionTimeout,
            route: route
        )
        guard next != progress else { return }
        progress = next
        onChange?()
    }

    private func scheduleDeadline(_ deadline: Double?) {
        deadlineWork?.cancel()
        deadlineWork = nil
        guard let deadline else { return }
        let work = DispatchWorkItem { [weak self] in self?.recompute() }
        deadlineWork = work
        // +20 мс, как на вебе: пересчёт точно попадает ПОСЛЕ срока, а не за миг до него.
        let delay = max(0, deadline - connectMonotonicNowMs()) + 20
        DispatchQueue.main.asyncAfter(deadline: .now() + delay / 1000, execute: work)
    }

    // MARK: - Путь к серверу

    /// Каким путём легло соединение. Берём ВЫБРАННУЮ пару кандидатов (transport.
    /// selectedCandidatePairId; иначе — nominated среди успешных), а не любую: WebRTC держит
    /// и запасные. Путь идёт через ретранслятор, если хоть один кандидат пары — relay; имя
    /// ретранслятора — из адреса нашего кандидата.
    private static func route(from statistics: TrackStatistics) -> ConnectRoute {
        var pair: IceCandidatePairStatistics?
        if let selectedId = statistics.transportStats?.selectedCandidatePairId {
            pair = statistics.iceCandidatePair.first { $0.id == selectedId }
        }
        if pair == nil {
            for candidate in statistics.iceCandidatePair where candidate.state == .succeeded {
                if pair == nil || (candidate.nominated == true && pair?.nominated != true) {
                    pair = candidate
                }
            }
        }
        guard let pair else { return .empty }
        let rtt: Int? = (pair.currentRoundTripTime ?? 0) > 0
            ? connectJsRound(pair.currentRoundTripTime! * 1000)
            : nil
        // Статистика дорожки хранит по одному кандидату каждого вида. Верим им, только если
        // это кандидаты именно выбранной пары: иначе можно приписать соединению чужой путь.
        let local = statistics.localIceCandidate.flatMap { $0.id == pair.localCandidateId ? $0 : nil }
        let remote = statistics.remoteIceCandidate.flatMap { $0.id == pair.remoteCandidateId ? $0 : nil }
        let relayed: Bool?
        if local?.candidateType == .relay || remote?.candidateType == .relay {
            relayed = true
        } else if local != nil && remote != nil {
            relayed = false
        } else {
            // Кандидаты пары неизвестны — ни «через ретранслятор», ни «напрямую» не придумываем.
            relayed = nil
        }
        var relayName: String?
        var relayHost: String?
        if relayed == true, let url = local?.url {
            // Веб: url.replace(/^turns?:/, '').split('?')[0].split(':')[0].
            var host = url
            if host.hasPrefix("turns:") {
                host.removeFirst("turns:".count)
            } else if host.hasPrefix("turn:") {
                host.removeFirst("turn:".count)
            }
            host = host.components(separatedBy: "?").first ?? ""
            host = host.components(separatedBy: ":").first ?? ""
            if !host.isEmpty {
                relayHost = host
                relayName = host.contains("cloudflare")
                    ? "Cloudflare"
                    : (host.contains("eblusha") ? "Наш ретранслятор" : host)
            }
        }
        return ConnectRoute(relayed: relayed, rttMs: rtt, relayName: relayName, relayHost: relayHost)
    }
}

// MARK: - RoomDelegate

extension CallConnectWatcher: RoomDelegate {

    private func onMain(_ room: Room, _ body: @escaping () -> Void) {
        DispatchQueue.main.async { [weak self] in
            guard let self, self.room === room else { return }
            body()
        }
    }

    func room(_ room: Room, didUpdateConnectionState connectionState: ConnectionState, from oldConnectionState: ConnectionState) {
        onMain(room) {
            self.check()
            // «Рисую» — при каждом подключении, в том числе после переподключения.
            if connectionState == .connected { self.announce() }
        }
    }

    func room(_ room: Room, participantDidConnect participant: RemoteParticipant) {
        onMain(room) {
            self.check()
            self.announce()
        }
    }

    func room(_ room: Room, participantDidDisconnect participant: RemoteParticipant) {
        onMain(room) { self.onLeft() }
    }

    func room(_ room: Room, participant: RemoteParticipant, didPublishTrack publication: RemoteTrackPublication) {
        onMain(room) { self.check() }
    }

    func room(_ room: Room, participant: RemoteParticipant, didUnpublishTrack publication: RemoteTrackPublication) {
        onMain(room) { self.check() }
    }

    func room(_ room: Room, participant: RemoteParticipant, didSubscribeTrack publication: RemoteTrackPublication) {
        onMain(room) { self.check() }
    }

    func room(_ room: Room, participant: RemoteParticipant, didUnsubscribeTrack publication: RemoteTrackPublication) {
        onMain(room) { self.check() }
    }

    func room(_ room: Room, participant: LocalParticipant, didPublishTrack publication: LocalTrackPublication) {
        onMain(room) { self.updateLocal() }
    }

    func room(_ room: Room, participant: LocalParticipant, didUnpublishTrack publication: LocalTrackPublication) {
        onMain(room) { self.updateLocal() }
    }

    func room(_ room: Room, participant: Participant, trackPublication: TrackPublication, didUpdateIsMuted isMuted: Bool) {
        onMain(room) {
            self.updateLocal()
            self.check()
        }
    }

    /// Отчёт шифратора о дорожке. ok/key_ratcheted — кадры реально шифруются (наша
    /// дорожка) или расшифровываются (чужая). Ошибки не считаем концом: первые кадры до
    /// применения ключа бывают «missing_key», это не повод объявлять звонок сломанным —
    /// этап просто остаётся активным, пока подтверждения нет.
    func room(_ room: Room, trackPublication: TrackPublication, didUpdateE2EEState state: E2EEState) {
        onMain(room) {
            guard state == .ok || state == .key_ratcheted else { return }
            if trackPublication is LocalTrackPublication {
                guard !self.localEncryptionOk else { return }
                self.localEncryptionOk = true
            } else {
                guard !self.remoteDecryptionOk else { return }
                self.remoteDecryptionOk = true
            }
            self.onChange?()
        }
    }

    func room(
        _ room: Room, participant: RemoteParticipant?, didReceiveData data: Data,
        forTopic topic: String, encryptionType: EncryptionType
    ) {
        onMain(room) { self.onData(data, participant: participant, topic: topic) }
    }
}

// MARK: - TrackDelegate (путь и задержка из статистики нашей дорожки)

extension CallConnectWatcher: TrackDelegate {

    func track(_ track: Track, didUpdateStatistics statistics: TrackStatistics, simulcastStatistics: [String: TrackStatistics]) {
        let next = Self.route(from: statistics)
        DispatchQueue.main.async { [weak self] in
            guard let self, self.statsTrack === track, next != self.route else { return }
            self.route = next
            self.recompute()
        }
    }
}
