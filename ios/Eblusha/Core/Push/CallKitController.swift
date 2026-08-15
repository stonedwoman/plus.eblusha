import Foundation
import Combine
import CallKit
import AVFoundation
import UIKit

/// Системная интеграция звонков (CallKit). Аналога на Android нет — там роль
/// «системного звонка» играли IncomingCallService + полноэкранный интент; на iOS
/// без CXProvider VoIP-пуш ЗАПРЕЩЁН (система убивает приложение за пуш без
/// немедленного reportNewIncomingCall), а без CXStartCallAction система не знает
/// о разговоре и глушит аудиосессию в фоне.
///
/// Связь с CallManager — только через его публичные методы и наблюдение @Published
/// фазы: общие файлы (CallManager.swift, CallOverlay.swift) не трогаем.
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
    /// Завершение инициировано системной кнопкой (CXEndCallAction уже отработал) —
    /// наблюдатель фазы не должен рапортовать remoteEnded поверх.
    private var endingViaAction = false
    private var lastPhase: CallPhase = .idle

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
    /// связку CallOverlay↔CallKit без правок общих файлов: исходящий звонок из UI
    /// репортуется системе сам, любое завершение (hangUp, call:ended, decline)
    /// закрывает системный звонок.
    func activate() {
        AppContainer.shared.callManager.$phase
            .receive(on: DispatchQueue.main)
            .sink { [weak self] phase in self?.onPhaseChange(phase) }
            .store(in: &cancellables)
    }

    // MARK: - Входящий VoIP-пуш

    /// ОБЯЗАТЕЛЬНЫЙ немедленный репорт входящего. `completion` — completion самого
    /// пуша PushKit: дёргаем его только после ответа reportNewIncomingCall, иначе
    /// система сочтёт пуш необработанным.
    func reportIncomingCall(
        conversationId: String,
        callerName: String,
        video: Bool,
        completion: @escaping () -> Void
    ) {
        DispatchQueue.main.async {
            // Дубль пуша по уже показанному звонку (apns-collapse-id почти исключает,
            // но реконнекты Apple случаются): не плодим второй UUID, просто обновляем.
            if let uuid = self.callUUID, self.callConversationId == conversationId {
                self.provider.reportCall(with: uuid, updated: Self.makeUpdate(callerName: callerName, video: video))
                completion()
                return
            }
            // Уже есть системный звонок ДРУГОЙ беседы: его состояние трогать нельзя —
            // затерев callUUID, мы потеряли бы управление живым звонком и он навсегда
            // остался бы «активным» в системе. Новому честно отвечаем «занято».
            if self.callUUID != nil {
                self.reportPhantomAndEnd(completion: completion)
                return
            }
            let uuid = UUID()
            self.provider.reportNewIncomingCall(with: uuid, update: Self.makeUpdate(callerName: callerName, video: video)) { error in
                if let error {
                    // Например, «Не беспокоить» с запретом звонков — звонок не показан,
                    // сокет доставит call:incoming в приложение обычным путём.
                    NSLog("CallKitController: reportNewIncomingCall failed: %@", String(describing: error))
                } else {
                    // Поля выставляем ТОЛЬКО после успеха: иначе неудачный репорт оставил
                    // бы контроллер думать, что системный звонок существует.
                    self.callUUID = uuid
                    self.callConversationId = conversationId
                    self.incomingVideo = video
                    self.endingViaAction = false
                }
                completion()
            }
        }
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

    /// kind=call-cancel: закрыть системный звонок. Пришёл ли отбой VoIP-пушем или
    /// тихим background-пушем на alert-токен — вход один.
    func reportRemoteEnded(conversationId: String?) {
        DispatchQueue.main.async {
            guard let uuid = self.callUUID,
                  conversationId == nil || conversationId == self.callConversationId else { return }
            // «Отбой» относится к НЕПРИНЯТОМУ звонку: сервер шлёт call-cancel, когда
            // звонящий передумал. Если разговор уже идёт, этот же пуш (доставленный с
            // опозданием или продублированный) не должен класть трубку живому звонку.
            guard !Self.isCallAnswered(conversationId: self.callConversationId) else { return }
            self.provider.reportCall(with: uuid, endedAt: nil, reason: .remoteEnded)
            self.clear()
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
    /// нечего (приложение разбудили radi отбоя) — рапортуем фантомный звонок и тут же
    /// завершаем (стандартная практика для cancel-пушей, баннер система не показывает).
    func handleCancelPush(conversationId: String?, completion: @escaping () -> Void) {
        DispatchQueue.main.async {
            if let uuid = self.callUUID,
               conversationId == nil || conversationId == self.callConversationId,
               // Разговор уже идёт — отбой опоздал и относится к прошлой фазе (см. reportRemoteEnded).
               !Self.isCallAnswered(conversationId: self.callConversationId) {
                self.provider.reportCall(with: uuid, endedAt: nil, reason: .remoteEnded)
                self.clear()
                completion()
                return
            }
            self.reportPhantomAndEnd(completion: completion)
        }
    }

    /// Неизвестный VoIP-payload — отчитаться перед системой всё равно обязаны.
    func reportPhantomAndEnd(completion: @escaping () -> Void) {
        let uuid = UUID()
        let update = Self.makeUpdate(callerName: "Еблуша", video: false)
        provider.reportNewIncomingCall(with: uuid, update: update) { [weak self] _ in
            self?.provider.reportCall(with: uuid, endedAt: nil, reason: .remoteEnded)
            completion()
        }
    }

    // MARK: - Наблюдение фаз CallManager

    private func onPhaseChange(_ phase: CallPhase) {
        defer { lastPhase = phase }
        switch phase {
        case .outgoing:
            // Пользователь начал звонок из UI (CallOverlay/ChatView → startOutgoing) —
            // докладываем системе CXStartCallAction, чтобы аудио жило в фоне и в
            // журнале звонков был след.
            reportOutgoingStarted()
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
            } else {
                provider.reportCall(with: uuid, endedAt: nil, reason: .remoteEnded)
            }
            clear()
        case .incoming, .connecting:
            // Входящий сокетом (приложение на экране) системе не рапортуем: свой
            // полноэкранный IncomingCallView + CallRinger уже звонят, а второй
            // рингтон CallKit поверх — какофония. Пуш-путь идёт через
            // reportIncomingCall и сюда не попадает.
            break
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
        let title = manager.title.isEmpty ? "Еблуша" : manager.title
        let action = CXStartCallAction(call: uuid, handle: CXHandle(type: .generic, value: title))
        action.isVideo = manager.isVideoCall
        callController.request(CXTransaction(action: action)) { [weak self] error in
            if let error {
                // Система отказала (лимит звонков и т.п.) — звонок продолжает жить
                // в CallManager, просто без системного статуса.
                NSLog("CallKitController: CXStartCallAction failed: %@", String(describing: error))
                DispatchQueue.main.async { self?.clear() }
            }
        }
    }

    private func clear() {
        callUUID = nil
        callConversationId = nil
        incomingVideo = false
    }
}

// MARK: - CXProviderDelegate

extension CallKitController: CXProviderDelegate {

    func providerDidReset(_ provider: CXProvider) {
        // Система сбросила провайдера (крайне редко) — завершаем всё, чтобы состояния
        // не разъехались.
        DispatchQueue.main.async {
            self.clear()
            let manager = AppContainer.shared.callManager
            if manager.phase == .incoming {
                manager.declineIncoming()
            } else if manager.phase != .idle {
                manager.hangUp()
            }
        }
    }

    func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
        let container = AppContainer.shared
        // Состояние уже посеяно onPushIncoming (VoIPPushHandler), но accept уходит
        // ЭМИТОМ в сокет: приложение могло быть только что разбужено пушем, и без
        // подключения call:accept потерялся бы — звонящий вечно слушал бы гудки.
        // Ждём подключения до 10 секунд (fulfill нельзя откладывать дольше — CallKit
        // сочтёт action проваленным и завершит звонок).
        container.realtimeClient.connect()
        let video = incomingVideo
        Task { @MainActor in
            for _ in 0..<40 where !container.realtimeClient.connected {
                try? await Task.sleep(nanoseconds: 250_000_000)
            }
            // Пока ждали, отбой мог уже прийти (call:ended) — тогда фаза не .incoming,
            // acceptIncoming молча выйдет, а системный звонок закроет наблюдатель фазы.
            //
            // Камеру НЕ включаем даже у видеозвонка: у системной кнопки ответа один
            // смысл на всё, а в эталоне «принять с видео» — отдельная кнопка. Человек,
            // ответивший с локскрина, не давал согласия показывать себя; камера
            // включается своей кнопкой уже внутри экрана звонка. hasVideo в CXCallUpdate
            // при этом остаётся — система честно рисует входящий видеозвонок.
            _ = video
            container.callManager.acceptIncoming(withVideo: false)
            action.fulfill()
        }
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
            let manager = AppContainer.shared.callManager
            self.endingViaAction = true
            if manager.phase == .incoming {
                manager.declineIncoming() // красная кнопка на входящем = отклонить
            } else if manager.phase != .idle {
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
        // Аудиосессией владеет CallManager (configureAudioSession в startOutgoing/
        // acceptIncoming) — здесь только след для отладки маршрутов.
        NSLog("CallKitController: audio session activated")
    }

    func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
        NSLog("CallKitController: audio session deactivated")
    }
}
