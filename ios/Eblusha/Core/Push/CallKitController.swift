import Foundation
import Combine
import CallKit
import AVFoundation
import UIKit
import LiveKit

/// Системная интеграция звонков (CallKit). Аналога на Android нет — там роль
/// «системного звонка» играли IncomingCallService + полноэкранный интент; на iOS
/// без CXProvider VoIP-пуш ЗАПРЕЩЁН (система убивает приложение за пуш без
/// немедленного reportNewIncomingCall), а без CXStartCallAction система не знает
/// о разговоре и глушит аудиосессию в фоне.
///
/// Связь с CallManager — через его публичные методы и наблюдение @Published фазы.
/// ЛЮБОЙ входящий (и по пушу, и по сокету) докладывается системе: раньше сокетный
/// входящий системе не показывали, и VoIP-пуш, догнавший сокет через секунду,
/// порождал фантомный звонок «Еблуша» с «пропущенным» в Недавних, а на только что
/// заблокированном телефоне экрана звонка не было вовсе.
///
/// Состояние (callUUID и т.д.) выставляется СИНХРОННО, до похода в CallKit: ответ
/// reportNewIncomingCall приходит XPC-ом позже, и за это время наблюдатель фазы или
/// повторный пуш успевали доложить тот же звонок вторым UUID — в системе зависал
/// «звонящий» вызов, который никто не закрывал.
///
/// Аудиосессией при системном звонке владеет CallKit: приложение до fulfill только
/// задаёт категорию, активирует сессию система (didActivate), и только тогда мы
/// отдаём аудио движку LiveKit. Иначе у сессии три хозяина (CallKit, LiveKit,
/// CallManager) и классический исход «ответил с локскрина — тишина».
final class CallKitController: NSObject {

    static let shared = CallKitController()

    private let provider: CXProvider
    private let callController = CXCallController()
    private var cancellables = Set<AnyCancellable>()

    // Один системный звонок за раз (maximumCallGroups = 1): UUID ↔ беседа.
    private var callUUID: UUID?
    private var callConversationId: String?
    /// Флаг видео входящего из пуша — CXAnswerCallAction своего флага не несёт.
    private var incomingVideo = false
    /// reportNewIncomingCall отправлен, ответа системы ещё нет. Пока он в полёте,
    /// CXAnswerCallAction запрашивать нельзя — доложим ответ из completion.
    private var reportInFlight = false
    /// Завершение инициировано системной кнопкой (CXEndCallAction уже отработал) —
    /// наблюдатель фазы не должен рапортовать remoteEnded поверх.
    private var endingViaAction = false
    /// Наш собственный CXEndCallAction (локальный отбой в приложении) в полёте: звонок
    /// уже забыт (callUUID пуст, новый звонок может стартовать), а perform для этого
    /// UUID должен лишь подтвердить действие, не трогая CallManager.
    private var endingUUID: UUID?
    /// Ответ системе уже доложен (perform(CXAnswerCallAction) либо наш собственный
    /// запрос CXAnswerCallAction после «Принять» в приложении) — не дублировать.
    private var answerReported = false
    private var lastPhase: CallPhase = .idle
    /// Локальный таймаут дозвона. Сервер снимает звонок через 60 с, но если сокет к
    /// тому моменту так и не поднялся, call:ended не придёт — и CallKit звонил бы вечно,
    /// а поздний «Принять» вёл в пустую комнату.
    private var ringTimeout: DispatchWorkItem?
    private static let ringTimeoutSeconds: TimeInterval = 60

    /// Есть ли системный звонок. CallManager по этому признаку НЕ трогает активность
    /// аудиосессии — ею владеет CallKit.
    var hasSystemCall: Bool { callUUID != nil }

    private override init() {
        let config = CXProviderConfiguration()
        config.supportsVideo = true
        config.maximumCallGroups = 1
        config.maximumCallsPerCallGroup = 1
        config.supportedHandleTypes = [.generic]
        // ringtoneSound не задаём: nil → системный рингтон (паритет с Android-сервисом,
        // игравшим DEFAULT_RINGTONE_URI). Иконка — шаблон для кнопки возврата в звонок.
        config.iconTemplateImageData = UIImage(named: "AppIcon")?.pngData()
        provider = CXProvider(configuration: config)
        super.init()
        provider.setDelegate(self, queue: nil)
    }

    /// Зовётся из PushAppDelegate на старте. Подписка на фазы CallManager закрывает
    /// связку CallOverlay↔CallKit: исходящий звонок из UI репортуется системе сам,
    /// сокетный входящий — тоже, любое завершение закрывает системный звонок.
    func activate() {
        // Сессию активирует CallKit, а не LiveKit (см. шапку). Движок держим выключенным
        // до didActivate; без системного звонка его включает сам CallManager.
        AudioManager.shared.audioSession.isAutomaticConfigurationEnabled = false
        try? AudioManager.shared.setEngineAvailability(.none)
        AppContainer.shared.callManager.$phase
            .receive(on: DispatchQueue.main)
            .sink { [weak self] phase in self?.onPhaseChange(phase) }
            .store(in: &cancellables)
    }

    /// PushKit требует reportNewIncomingCall В ТОМ ЖЕ проходе run loop, что и делегат
    /// пуша. Делегат работает на main (PKPushRegistry(queue: .main)), поэтому — строго
    /// синхронно: DispatchQueue.main.async откладывал репорт на следующий оборот, и
    /// система была вправе убить приложение за «непоказанный» VoIP-пуш.
    private func onMain(_ body: () -> Void) {
        if Thread.isMainThread {
            body()
        } else {
            DispatchQueue.main.sync(execute: body)
        }
    }

    // MARK: - Входящий VoIP-пуш

    /// ОБЯЗАТЕЛЬНЫЙ немедленный репорт входящего. `completion` — completion самого
    /// пуша PushKit: дёргаем его только после ответа reportNewIncomingCall, иначе
    /// система сочтёт пуш необработанным. Состояние CallManager к этому моменту уже
    /// посеяно (VoIPPushHandler зовёт onPushIncoming первым, синхронно).
    func reportIncomingCall(
        conversationId: String,
        callerName: String,
        video: Bool,
        completion: @escaping () -> Void
    ) {
        onMain {
            // Тот же звонок уже показан (или репорт в полёте): дубль пуша (реконнекты
            // Apple) или сокетный входящий, доложенный из onPhaseChange. Правило PushKit
            // «каждый пуш = репорт» всё равно действует — докладываем ТЕМ ЖЕ UUID:
            // система ответит callUUIDAlreadyExists, второй записи не появится.
            if let uuid = callUUID, callConversationId == conversationId {
                provider.reportNewIncomingCall(with: uuid, update: Self.makeUpdate(callerName: callerName, video: video)) { _ in
                    completion()
                }
                return
            }
            // Уже есть системный звонок ДРУГОЙ беседы: его состояние трогать нельзя —
            // затерев callUUID, мы потеряли бы управление живым звонком и он навсегда
            // остался бы «активным» в системе. Новому честно отвечаем «занято».
            if callUUID != nil {
                reportPhantomAndEnd(completion: completion)
                return
            }
            reportNew(conversationId: conversationId, callerName: callerName, video: video) { _ in
                completion()
            }
        }
    }

    /// Общий репорт нового системного звонка (пуш и сокет). Состояние выставляется
    /// ДО вызова CallKit (см. шапку). `done(true)` — система показала звонок;
    /// false — отказала (например, «Не беспокоить» с запретом звонков).
    private func reportNew(
        conversationId: String,
        callerName: String,
        video: Bool,
        done: @escaping (Bool) -> Void
    ) {
        let uuid = UUID()
        callUUID = uuid
        callConversationId = conversationId
        incomingVideo = video
        endingViaAction = false
        answerReported = false
        reportInFlight = true
        provider.reportNewIncomingCall(with: uuid, update: Self.makeUpdate(callerName: callerName, video: video)) { error in
            guard self.callUUID == uuid else {
                // Пока летел ответ, звонок уже забыт (отбой/таймаут) — ничего не трогаем.
                done(error == nil)
                return
            }
            self.reportInFlight = false
            if let error {
                // Звонок не показан — приложение продолжает звонить своим IncomingCallView.
                NSLog("CallKitController: reportNewIncomingCall failed: %@", String(describing: error))
                self.clear()
                done(false)
                return
            }
            // Сверяемся с CallManager: за время XPC-ответа звонок мог кончиться или быть
            // принят кнопкой в приложении.
            let manager = AppContainer.shared.callManager
            if manager.phase == .idle || manager.conversationId != conversationId {
                self.endSystemCall(reason: .remoteEnded)
            } else if manager.phase.isActive {
                self.requestAnswer(uuid)
            } else {
                self.scheduleRingTimeout(uuid)
            }
            done(true)
        }
    }

    /// «Принять» нажали в приложении при живом системном звонке: система об ответе не
    /// знает и продолжала бы «звонить», а красная кнопка клала бы живой разговор.
    /// CXAnswerCallAction — единственный легальный способ перевести звонок в connected
    /// и получить didActivate.
    private func requestAnswer(_ uuid: UUID) {
        guard !answerReported else { return }
        answerReported = true
        ringTimeout?.cancel()
        callController.request(CXTransaction(action: CXAnswerCallAction(call: uuid))) { [weak self] error in
            guard let error else { return }
            NSLog("CallKitController: CXAnswerCallAction failed: %@", String(describing: error))
            DispatchQueue.main.async {
                guard let self, self.callUUID == uuid else { return }
                // Система ответ не приняла — didActivate не придёт. Закрываем системный
                // звонок и поднимаем аудио сами, иначе разговор без звука.
                self.endSystemCall(reason: .failed)
                AppContainer.shared.callManager.activateAudioWithoutSystemCall()
            }
        }
    }

    private func scheduleRingTimeout(_ uuid: UUID) {
        ringTimeout?.cancel()
        let item = DispatchWorkItem { [weak self] in
            guard let self, self.callUUID == uuid else { return }
            // Разговор идёт — таймер просто опоздал отмениться.
            guard !Self.isCallAnswered(conversationId: self.callConversationId) else { return }
            // Сервер к этому моменту звонок уже снял (свой 60-секундный таймаут) — сигнала
            // ему не шлём, гасим системный экран и своё состояние. Гасим ВСЕГДА, даже если
            // CallManager уже не .incoming: осиротевший системный звонок блокировал бы все
            // следующие входящие («занято»).
            self.endSystemCall(reason: .unanswered)
            AppContainer.shared.callManager.dismissIncoming()
        }
        ringTimeout = item
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.ringTimeoutSeconds, execute: item)
    }

    private static func makeUpdate(callerName: String, video: Bool) -> CXCallUpdate {
        let update = CXCallUpdate()
        update.remoteHandle = CXHandle(type: .generic, value: callerName)
        update.localizedCallerName = callerName
        update.hasVideo = video
        update.supportsHolding = false
        update.supportsGrouping = false
        update.supportsUngrouping = false
        update.supportsDTMF = false
        return update
    }

    /// kind=call-cancel тихим background-пушем на alert-токен (устройство без VoIP-токена):
    /// закрыть системный звонок и экран входящего в приложении.
    func reportRemoteEnded(conversationId: String?) {
        onMain {
            let manager = AppContainer.shared.callManager
            if callUUID != nil,
               conversationId == nil || conversationId == callConversationId,
               // «Отбой» относится к НЕПРИНЯТОМУ звонку: сервер шлёт call-cancel, когда
               // звонящий передумал. Если разговор уже идёт, этот же пуш (доставленный с
               // опозданием или продублированный) не должен класть трубку живому звонку.
               !Self.isCallAnswered(conversationId: callConversationId) {
                endSystemCall(reason: .remoteEnded)
            }
            // Сокет мог упасть — честного call:ended не будет, экран висел бы бессрочно.
            // Без сигнала серверу: звонок он уже снял сам.
            if manager.phase == .incoming, conversationId == nil || manager.conversationId == conversationId {
                manager.dismissIncoming()
            }
        }
    }

    /// Идёт ли уже разговор по этой беседе (звонок принят) — см. reportRemoteEnded.
    private static func isCallAnswered(conversationId: String?) -> Bool {
        let manager = AppContainer.shared.callManager
        guard manager.phase == .connecting || manager.phase == .inCall else { return false }
        return conversationId == nil || manager.conversationId == conversationId
    }

    /// call-cancel ПРИШЁЛ VoIP-ПУШЕМ: правило «каждый VoIP-пуш обязан породить репорт»
    /// действует и здесь. Если системный звонок жив — честно гасим его; если гасить
    /// нечего (приложение разбудили ради отбоя) — рапортуем фантомный звонок и тут же
    /// завершаем (стандартная практика для cancel-пушей, баннер система не показывает).
    func handleCancelPush(conversationId: String?, completion: @escaping () -> Void) {
        onMain {
            if callUUID != nil,
               conversationId == nil || conversationId == callConversationId,
               // Разговор уже идёт — отбой опоздал и относится к прошлой фазе (см. reportRemoteEnded).
               !Self.isCallAnswered(conversationId: callConversationId) {
                endSystemCall(reason: .remoteEnded)
                completion()
                return
            }
            reportPhantomAndEnd(completion: completion)
        }
    }

    /// Неизвестный или уже неактуальный VoIP-payload — отчитаться перед системой всё
    /// равно обязаны. Причина `.answeredElsewhere`, а не `.remoteEnded`: последняя для
    /// неотвеченного входящего — это «пропущенный» в Недавних, а фантом пропущенным
    /// не является.
    func reportPhantomAndEnd(completion: @escaping () -> Void) {
        let uuid = UUID()
        let update = Self.makeUpdate(callerName: "Еблуша", video: false)
        provider.reportNewIncomingCall(with: uuid, update: update) { [weak self] _ in
            self?.provider.reportCall(with: uuid, endedAt: nil, reason: .answeredElsewhere)
            completion()
        }
    }

    /// Единая точка завершения системного звонка по НАШЕЙ инициативе (не через
    /// CXEndCallAction): доложить причину и забыть звонок. Последующий переход фазы в
    /// .idle ничего не задублирует — callUUID уже пуст.
    private func endSystemCall(reason: CXCallEndedReason) {
        guard let uuid = callUUID else { return }
        provider.reportCall(with: uuid, endedAt: nil, reason: reason)
        clear()
    }

    // MARK: - Наблюдение фаз CallManager

    private func onPhaseChange(_ phase: CallPhase) {
        defer { lastPhase = phase }
        let manager = AppContainer.shared.callManager
        switch phase {
        case .outgoing:
            // Пользователь начал звонок из UI (CallOverlay/ChatView → startOutgoing) —
            // докладываем системе CXStartCallAction, чтобы аудио жило в фоне и в
            // журнале звонков был след.
            reportOutgoingStarted()
        case .incoming:
            // Входящий по сокету (приложение живо). Докладываем системе: рингтоном звонит
            // CallKit, свой рингер глушим (два рингтона — какофония). Пуш по тому же звонку
            // придёт в reportIncomingCall и уйдёт в ветку «тот же UUID» — без фантома.
            // Пуш-путь сюда не доходит: там callUUID выставлен до смены фазы.
            guard callUUID == nil, let cid = manager.conversationId else { break }
            manager.suppressRinger()
            let name = manager.title.isEmpty ? "Входящий звонок" : manager.title
            reportNew(conversationId: cid, callerName: name, video: manager.isVideoCall) { shown in
                // Система отказала — звоним сами, как раньше.
                if !shown { manager.resumeRinger() }
            }
        case .connecting:
            // Принято кнопкой в приложении (в т.ч. «С видео» — она есть только там).
            // Пока репорт в полёте, ответ доложит completion в reportNew.
            if lastPhase == .incoming, let uuid = callUUID, !reportInFlight {
                requestAnswer(uuid)
            }
        case .inCall:
            // Исходящий соединился — системе важно знать момент connect для таймера.
            if lastPhase == .outgoing, let uuid = callUUID {
                provider.reportOutgoingCall(with: uuid, connectedAt: Date())
            }
        case .idle:
            guard let uuid = callUUID else { break }
            if endingViaAction {
                // Система сама завершила (CXEndCallAction fulfilled) — не дублируем.
                endingViaAction = false
                clear()
                break
            }
            switch manager.lastEndCause {
            case .localHangUp:
                // Отклонил/положил трубку сам в приложении: через CXEndCallAction, чтобы
                // система записала «отклонён», а не «пропущенный». Звонок забываем сразу —
                // новый может стартовать раньше, чем придёт perform (см. endingUUID).
                endingUUID = uuid
                clear()
                callController.request(CXTransaction(action: CXEndCallAction(call: uuid))) { [weak self] error in
                    guard let self, error != nil else { return }
                    DispatchQueue.main.async {
                        guard self.endingUUID == uuid else { return }
                        self.endingUUID = nil
                        self.provider.reportCall(with: uuid, endedAt: nil, reason: .declinedElsewhere)
                    }
                }
            case .answeredElsewhere:
                endSystemCall(reason: .answeredElsewhere)
            case .declinedElsewhere:
                endSystemCall(reason: .declinedElsewhere)
            case .unanswered:
                endSystemCall(reason: .unanswered)
            case .remote:
                endSystemCall(reason: .remoteEnded)
            }
        }
    }

    private func reportOutgoingStarted() {
        guard callUUID == nil else { return } // уже репортован (например, ретрай фазы)
        let manager = AppContainer.shared.callManager
        guard let cid = manager.conversationId else { return }
        let uuid = UUID()
        callUUID = uuid
        callConversationId = cid
        endingViaAction = false
        answerReported = false
        let title = manager.title.isEmpty ? "Еблуша" : manager.title
        let action = CXStartCallAction(call: uuid, handle: CXHandle(type: .generic, value: title))
        action.isVideo = manager.isVideoCall
        callController.request(CXTransaction(action: action)) { [weak self] error in
            if let error {
                // Система отказала (лимит звонков и т.п.) — звонок продолжает жить
                // в CallManager, просто без системного статуса; аудиосессию тогда
                // поднимаем сами, didActivate не придёт.
                NSLog("CallKitController: CXStartCallAction failed: %@", String(describing: error))
                DispatchQueue.main.async {
                    guard let self, self.callUUID == uuid else { return }
                    self.clear()
                    manager.activateAudioWithoutSystemCall()
                }
            }
        }
    }

    private func clear() {
        ringTimeout?.cancel()
        ringTimeout = nil
        callUUID = nil
        callConversationId = nil
        incomingVideo = false
        answerReported = false
        reportInFlight = false
    }
}

// MARK: - CXProviderDelegate

extension CallKitController: CXProviderDelegate {

    func providerDidReset(_ provider: CXProvider) {
        // Система сбросила провайдера (крайне редко) — завершаем всё, чтобы состояния
        // не разъехались.
        DispatchQueue.main.async {
            self.clear()
            self.endingUUID = nil
            let manager = AppContainer.shared.callManager
            if manager.phase == .incoming {
                // Без сигнала серверу: сокета может не быть, а отложенный decline
                // потом отклонил бы уже другой звонок (см. VoIPPushHandler, call-cancel).
                manager.dismissIncoming()
            } else if manager.phase != .idle {
                manager.hangUp()
            }
        }
    }

    func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
        let container = AppContainer.shared
        let manager = container.callManager
        guard action.callUUID == callUUID else {
            // Чужой/забытый UUID — такого звонка у нас больше нет.
            action.fail()
            return
        }
        ringTimeout?.cancel()
        guard manager.phase == .incoming, manager.conversationId == callConversationId else {
            if manager.phase.isActive {
                // Уже принято кнопкой приложения (это наш же CXAnswerCallAction) — просто
                // подтверждаем системе.
                answerReported = true
                action.fulfill()
            } else {
                // Отбой опередил ответ — принимать нечего, и системный звонок закрываем,
                // иначе он повис бы «активным».
                action.fail()
                clear()
            }
            return
        }
        answerReported = true
        // call:accept уходит эмитом в сокет; приложение могло быть только что разбужено
        // пушем, и сокета ещё нет. Ждать подключения здесь нельзя (CallKit сочтёт action
        // проваленным) и не нужно: RealtimeClient буферизует сигналинг звонков и отправит
        // accept сразу при подключении.
        container.realtimeClient.connect()
        // Камеру НЕ включаем даже у видеозвонка: у системной кнопки ответа один
        // смысл на всё, а в эталоне «принять с видео» — отдельная кнопка. Человек,
        // ответивший с локскрина, не давал согласия показывать себя; камера
        // включается своей кнопкой уже внутри экрана звонка. hasVideo в CXCallUpdate
        // при этом остаётся — система честно рисует входящий видеозвонок.
        manager.acceptIncoming(withVideo: false)
        action.fulfill()
    }

    func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
        // Сам звонок уже стартовал CallManager.startOutgoing из UI — транзакция
        // здесь только легализует его перед системой. Не реализовать этот метод
        // нельзя: нефулфильнутый CXStartCallAction система считает проваленным
        // и сносит звонок.
        provider.reportOutgoingCall(with: action.callUUID, startedConnectingAt: Date())
        action.fulfill()
    }

    func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        DispatchQueue.main.async {
            // Наш собственный запрос после локального отбоя: звонок уже забыт, CallManager
            // не трогаем (там мог начаться следующий звонок).
            if action.callUUID == self.endingUUID {
                self.endingUUID = nil
                action.fulfill()
                return
            }
            guard action.callUUID == self.callUUID else {
                action.fulfill() // неизвестный UUID — подтверждаем, чтобы система его забыла
                return
            }
            let manager = AppContainer.shared.callManager
            if manager.phase == .incoming, manager.conversationId == self.callConversationId {
                self.endingViaAction = true
                manager.declineIncoming() // красная кнопка на входящем = отклонить
            } else if manager.phase != .idle, manager.conversationId == self.callConversationId {
                self.endingViaAction = true
                manager.hangUp()
            }
            self.clear()
            action.fulfill()
        }
    }

    func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
        DispatchQueue.main.async {
            let manager = AppContainer.shared.callManager
            // У CallManager только toggleMic — дёргаем, лишь когда системное желание
            // расходится с фактом.
            if action.isMuted == manager.micOn {
                manager.toggleMic()
            }
            action.fulfill()
        }
    }

    func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
        // Контракт CallKit: сессию активировала система — только теперь отдаём звук
        // движку LiveKit (до этого он выключен, см. activate()). Маршрут динамика
        // перепроверяем: активация может сбросить override.
        try? AudioManager.shared.setEngineAvailability(.default)
        DispatchQueue.main.async {
            AppContainer.shared.callManager.systemAudioActivated()
        }
    }

    func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
        try? AudioManager.shared.setEngineAvailability(.none)
    }
}
