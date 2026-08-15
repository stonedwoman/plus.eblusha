import Combine
import Foundation

// Порт ВСЕЙ секретной (V2) ветки `feature/chat/ChatViewModel.kt`: initSecret / loadSecret /
// sendSecret с оптимистичным эхо и очередью до ключа / flushSecretQueue /
// sendSecretAttachments / accept-decline инвайта / link-флоу привязки устройства /
// инбокс-полл 3.5 с + реконсиляция историей каждые ~21 с.
//
// Extension живёт в ОТДЕЛЬНОМ файле, поэтому private-члены ChatViewModel ему не видны, а
// хранимые поля добавить нельзя: secretRepo/secretMode/secretPeers/secretQueue и
// секретные поля UiState вносятся в сам класс, часть private снимается — см.
// integration_notes (точечные правки ChatViewModel.swift).

extension ChatViewModel {

    // MARK: - Инициализация секретного режима (порт initSecret)

    /// Вызывается из bootstrap() вместо облачной ветки, когда meta.isSecretV2.
    func initSecret() async {
        secretMode = true
        secretPeers = await repo.conversationPeerUserIds(conversationId)
        ui.peerUserId = secretPeers.count == 1 ? secretPeers.first : nil
        let meta = await repo.conversationMeta(conversationId)
        let amCreator = meta?.createdById != nil && meta?.createdById == repo.currentUserId()
        let header = await repo.conversationHeader(conversationId)
        ui.isSecret = true
        ui.headerAvatarUrl = header.avatarUrl
        ui.headerSubtitle = "🔒 секретный чат"
        await secretRepo.ensureDeviceBootstrap()
        // Забрать уже ждущий key package ДО первого рендера истории.
        await secretRepo.syncInbox()
        let ready = secretRepo.hasThreadKey(conversationId)
        ui.secretReady = ready

        let pending = meta?.isSecretPending == true
        if pending && amCreator {
            // Наше же непринятое приглашение: чат виден, но заблокирован «ждём
            // подтверждения», пока собеседник не примет на ОДНОМ устройстве. Ключ уже у нас.
            ui.secretWaiting = true
        } else if ready {
            // Ключ на месте — экран работает сразу.
        } else if pending && !amCreator {
            // Собеседник (мы) ещё не принял это приглашение — принять/отклонить,
            // ключи до accept'а не клянчим.
            ui.secretInvite = true
        } else if !pending && !amCreator {
            // ACTIVE-тред, но ЭТО (бесключевое) устройство — не принявшее: восстановление
            // через key_request / «подтвердите на другом устройстве».
            await secretRepo.requestThreadKey(threadId: conversationId, userIds: secretPeers)
        }
        // Создатель переоткрыл чат после accept'а, случившегося пока он был оффлайн —
        // ключуем принявшее устройство сейчас.
        if amCreator, ready, let acceptedDevice = meta?.secretPeerDeviceId,
           meta?.secretStatus?.caseInsensitiveCompare("ACTIVE") == .orderedSame {
            await secretRepo.onPeerAccepted(threadId: conversationId, peerDeviceId: acceptedDevice)
        }
        await loadSecret()
        subscribeSecretStreams()
        startSecretLoops()
    }

    /// Подписки на паблишеры SecretRepository (порт collect-блоков initSecret).
    private func subscribeSecretStreams() {
        // Сообщения тредов из инбокса (realtime-путь).
        secretRepo.incoming
            .receive(on: DispatchQueue.main)
            .sink { [weak self] m in
                guard let self, m.threadId == self.conversationId else { return }
                self.appendSecret(m)
            }
            .store(in: &cancellables)

        // Ключ треда импортирован → сброс очереди + передешифровка 🔒-заглушек истории.
        secretRepo.keyImported
            .receive(on: DispatchQueue.main)
            .sink { [weak self] threadId in
                guard let self, threadId == self.conversationId else { return }
                self.ui.secretReady = true
                self.ui.secretInvite = false
                self.flushSecretQueue()
                Task { await self.loadSecret() }
            }
            .store(in: &cancellables)

        // Привязка устройства: связка ключей приехала с доверенного устройства.
        secretRepo.deviceLinked
            .receive(on: DispatchQueue.main)
            .sink { [weak self] added in
                guard let self else { return }
                let ready = self.secretRepo.hasThreadKey(self.conversationId)
                self.ui.linkedKeys = added
                self.ui.linkBusy = false
                self.ui.linkScanning = false
                self.ui.linkRequestedOn = nil
                self.ui.secretReady = ready || self.ui.secretReady
                if ready {
                    self.flushSecretQueue()
                    Task { await self.loadSecret() }
                }
            }
            .store(in: &cancellables)

        // Мы отдали ключи новому устройству → карточка приглашения превращается в
        // подтверждение ««X» подключён».
        secretRepo.deviceLinkedOut
            .receive(on: DispatchQueue.main)
            .sink { [weak self] info in
                self?.ui.linkedOut = info
            }
            .store(in: &cancellables)
    }

    /// Фоновые циклы секретного экрана. Все — с weak self и сном ВНЕ сильного захвата:
    /// закрытие экрана (deinit VM) обрывает их без ручной отмены, как viewModelScope.
    private func startSecretLoops() {
        // Есть ли ДРУГИЕ устройства (веб: hasOtherTrustedDevice) и есть ли у нас хоть
        // какие-то ключи секреток. Сеть может лежать — повторяем, пока не ответит: иначе
        // единственный путь получить ключи (карточка привязки) просто не показался бы.
        Task { [weak self] in
            if let self { self.ui.hasAnySecretKeys = self.secretRepo.hasAnyThreadKey() }
            for attempt in 0..<5 {
                guard let self else { return }
                if await self.secretRepo.hasOtherDevices() {
                    self.ui.hasOtherDevices = true
                    return
                }
                try? await Task.sleep(for: .seconds(Double(3 * (attempt + 1))))
            }
        }
        // Тик таймера приглашения. Крутится ТОЛЬКО пока карточка открыта (иначе секундная
        // перерисовка всего чата впустую), и по истечении НЕ убирает карточку — она сама
        // покажет «Код истёк» с кнопкой «Обновить», как в вебе.
        Task { [weak self] in
            while true {
                let delayMs: Int
                do {
                    guard let vm = self else { return }
                    if let invite = vm.ui.linkInvite {
                        let left = max(invite.expiresAtMs - Int64(Date().timeIntervalSince1970 * 1000), 0)
                        if left != vm.ui.linkInviteLeftMs { vm.ui.linkInviteLeftMs = left }
                        delayMs = left > 0 ? 500 : 2000
                    } else {
                        delayMs = 500
                    }
                }
                try? await Task.sleep(for: .milliseconds(delayMs))
            }
        }
        // Инбокс-полл открытого чата (веб-помпа: 3.5 с) — ремень для потерянных
        // secret:notify. Инбокс пер-девайсный: сообщение, чей фанаут посчитан ДО появления
        // этого устройства (кэш списка получателей у отправителя), сюда не попадёт никогда.
        // История — надёжная страховка: сверяемся с ней каждые ~21 с, чтобы открытый чат
        // не разъезжался молча.
        Task { [weak self] in
            var tick = 0
            while true {
                try? await Task.sleep(for: .seconds(3.5))
                guard let self else { return }
                await self.secretRepo.syncInbox()
                tick += 1
                if tick % 6 == 0 { await self.loadSecret() }
            }
        }
    }

    // MARK: - Realtime-события секретного режима

    /// Вызывается ПЕРВОЙ строкой handle(): true — событие съедено секретной веткой.
    /// Порт трёх ранних веток collect'а событий + правила «в секретном режиме обычные
    /// message-события не применяются» (только typing проходит дальше).
    func handleSecretEvent(_ event: RealtimeEvent) -> Bool {
        guard secretMode else { return false }
        switch event {
        case .typing:
            return false // индикаторы набора работают и в секретках — обычный обработчик

        case .conversationsChanged(let cid, let kind):
            guard cid == conversationId, kind == "deleted" else { return true }
            // Приглашение отклонено/отменено (этим или другим устройством) → уходим из
            // мёртвого чата; собеседник закрыл секретку → уничтожаем локальные следы.
            ui.secretInvite = false
            ui.secretDeclined = true
            Task { await secretRepo.purgeThreadLocal(conversationId) }
            return true

        case .secretChatAccepted(let cid, let peerDeviceId):
            guard cid == conversationId else { return true }
            // Собеседник принял НАШЕ приглашение → разблокировать композер создателя вживую.
            ui.secretWaiting = false
            Task {
                // В Kotlin ключ принявшему устройству доставляет ГЛОБАЛЬНЫЙ обработчик
                // RootNavHost; его iOS-порта пока нет — ключуем прямо отсюда, иначе
                // принявшая сторона ждала бы ключа до переоткрытия чата создателем.
                await secretRepo.onPeerAccepted(threadId: conversationId, peerDeviceId: peerDeviceId)
                _ = await repo.listConversations() // обновить кэш строки списка до ACTIVE
            }
            return true

        case .secretNotify:
            // Глобального синка (порт RootNavHost) на iOS нет — разбираем инбокс сами.
            Task { await secretRepo.syncInbox() }
            return true

        default:
            // Секретные сообщения никогда не ездят обычными message-событиями.
            return true
        }
    }

    // MARK: - История

    /// Страница 1 секретной истории. Свежие копии — первыми в дедупе, чтобы передешифровка
    /// (ключ приехал) заменила 🔒-заглушки; мета пагинации замораживается после листания назад.
    func loadSecret() async {
        ui.loading = ui.messages.isEmpty
        ui.error = nil
        switch await secretRepo.history(conversationId: conversationId, limit: Self.pageSize) {
        case .success(let page):
            let fresh = page.messages.map { secretToMessage($0) }
            ui.loading = false
            ui.messages = dedupSortedSecret(fresh + ui.messages)
            if !pagedBack {
                ui.hasMore = page.hasMore
                ui.nextCursor = page.nextCursor
            }
        case .failure(let message, _):
            ui.loading = false
            ui.error = message
        }
    }

    /// Секретная ветка fetchOlderPage(): вызывается его первой строкой при secretMode.
    /// Флаги пагинации ведёт сама (claimOlder уже поставил loadingOlderFlag).
    func fetchOlderPageSecret() async -> Bool {
        ui.loadingOlder = true
        defer {
            ui.loadingOlder = false
            loadingOlderFlag = false
        }
        switch await secretRepo.history(
            conversationId: conversationId, cursor: ui.nextCursor, limit: Self.pageSize
        ) {
        case .success(let page):
            pagedBack = true
            let older = page.messages.map { secretToMessage($0) }
            ui.messages = dedupSortedSecret(older + ui.messages)
            ui.hasMore = page.hasMore
            ui.nextCursor = page.nextCursor
            return true
        case .failure:
            // Отмена ≠ сбой сети (порт ensureActive): прерванный поиск цитаты не должен
            // включать 4-секундный карантин и ломать обычную подгрузку истории.
            if !Task.isCancelled {
                lastOlderFailMs = Date().timeIntervalSince1970
            }
            return false
        }
    }

    /// DecryptedSecretMessage → доменное Message (порт DecryptedSecretMessage.toMessage()).
    private func secretToMessage(_ m: DecryptedSecretMessage) -> Message {
        let atts = m.attachments.map { a in
            MessageAttachment(
                url: a.url ?? "",
                type: a.attType ?? "FILE",
                mime: a.mime,
                name: a.name,
                size: a.size,
                width: a.width,
                height: a.height,
                secretNonce: a.nonce,
                secretThreadId: m.threadId
            )
        }
        let audio = m.attachments.first { $0.attType == "AUDIO" }
        let distinctTypes = Array(Set(atts.map(\.type)))
        return Message(
            id: m.id,
            conversationId: m.threadId,
            senderId: m.senderId,
            // Секретные треды 1:1 — имена отправителей никогда не рендерятся.
            senderName: m.isMine ? "Вы" : "",
            type: atts.isEmpty ? "TEXT" : (distinctTypes.count == 1 ? distinctTypes[0] : "FILE"),
            content: m.text.trimmed().isEmpty ? nil : m.text,
            createdAt: m.createdAtMs,
            isMine: m.isMine,
            isSystem: false,
            attachments: atts,
            audioDurationSec: audio?.duration.map { Int($0) },
            waveform: audio?.waveform?.map { Int($0) }
        )
    }

    /// Расшифровка секретного вложения в кэш-файл (для рендера пузыря/просмотрщика);
    /// non-secret вложениям не нужна. nil — нет ключа / сеть / битый шифртекст.
    func decryptSecretAttachment(_ att: MessageAttachment) async -> URL? {
        guard let nonce = att.secretNonce else { return nil }
        return await secretRepo.decryptAttachmentToFile(
            threadId: att.secretThreadId ?? conversationId,
            url: att.url,
            nonceB64: nonce,
            expectedSize: att.size
        )
    }

    private func appendSecret(_ m: DecryptedSecretMessage) {
        guard !ui.messages.contains(where: { $0.id == m.id }) else { return }
        ui.messages = dedupSortedSecret(ui.messages + [secretToMessage(m)])
        ui.typingName = nil
    }

    /// Дедуп по id (первая копия побеждает) + сортировка по времени — общий мерж ленты.
    private func dedupSortedSecret(_ list: [Message]) -> [Message] {
        var seen = Set<String>()
        return list.filter { seen.insert($0.id).inserted }.sorted { $0.createdAt < $1.createdAt }
    }

    // MARK: - Отправка

    /// Вызывается из send() при secretMode (текст уже trimmed).
    func sendSecret(_ text: String) {
        Task {
            if !secretRepo.hasThreadKey(conversationId) {
                // Копим до прихода key package создателя (веб-паритет): не-создатель НИКОГДА
                // не генерирует ключ треда — перетёр бы настоящий на устройствах собеседника.
                secretQueue.append(text)
                ui.secretQueued = secretQueue.count
                await secretRepo.syncInbox() // оппортунистически: ключ мог уже ждать
                // Закрываем гонку «проверили → поставили в очередь»: ключ мог сесть между.
                if secretRepo.hasThreadKey(conversationId) {
                    ui.secretReady = true
                    flushSecretQueue()
                }
                return
            }
            // Оптимистичное эхо: msgId клиентский, пузырь рисуется ДО сетевого раундтрипа,
            // а каждая поздняя копия (эхо инбокса, релоад истории) дедупится тем же id.
            // Композер не блокируем — у секретных отправок нет гейта ui.sending.
            let msgId = UUID().uuidString.lowercased()
            let optimistic = Message(
                id: msgId,
                conversationId: conversationId,
                senderId: repo.currentUserId() ?? "",
                senderName: "Вы",
                type: "TEXT",
                content: text,
                createdAt: Int64(Date().timeIntervalSince1970 * 1000),
                isMine: true,
                isSystem: false
            )
            ui.error = nil
            ui.replyingTo = []
            ui.messages = dedupSortedSecret(ui.messages + [optimistic])
            var r = await secretRepo.sendText(
                conversationId: conversationId, peerUserIds: secretPeers, text: text, msgId: msgId
            )
            if case .failure = r {
                // Один ретрай под ТЕМ ЖЕ msgId: если первый заход дошёл до сервера (ответ
                // потерялся), id делает повтор идемпотентным no-op, а не дубликатом.
                try? await Task.sleep(for: .milliseconds(600))
                r = await secretRepo.sendText(
                    conversationId: conversationId, peerUserIds: secretPeers, text: text, msgId: msgId
                )
            }
            switch r {
            case .success:
                break // пузырь уже на экране под тем же id
            case .failure(let message, _):
                // Откат фантомного пузыря — неудавшаяся отправка не должна выглядеть
                // доставленной. Текст возвращаем в композер (гарантия облачной отправки).
                ui.messages = ui.messages.filter { $0.id != msgId }
                ui.error = message
                ui.restoredDraft = text
            }
        }
    }

    /// Сброс очереди, скопившейся до прихода ключа. Сбой возвращает остаток в очередь
    /// по порядку, а не роняет его молча.
    func flushSecretQueue() {
        guard !secretQueue.isEmpty else { return }
        let pending = secretQueue
        secretQueue.removeAll()
        ui.secretQueued = 0
        Task {
            for (i, text) in pending.enumerated() {
                switch await secretRepo.sendText(
                    conversationId: conversationId, peerUserIds: secretPeers, text: text
                ) {
                case .success(let m):
                    ui.messages = dedupSortedSecret(ui.messages + [secretToMessage(m)])
                case .failure(let message, _):
                    secretQueue.insert(contentsOf: pending[i...], at: 0)
                    ui.secretQueued = secretQueue.count
                    ui.error = message
                    return
                }
            }
        }
    }

    /// E2EE-отправка вложений: вызывается из sendAttachments() при secretMode (лимиты и
    /// uploadCancelled=false уже применены вызывающим). В отличие от текста, вложения НЕ
    /// ставятся в очередь до прихода ключа — без ключа шифровать нечем, поэтому честная
    /// ошибка (веб-паттерн: аплоад заблокирован без ключа).
    func sendSecretAttachments(_ files: [OutgoingFile], caption: String?, onSuccess: (() -> Void)?) {
        Task {
            if !secretRepo.hasThreadKey(conversationId) {
                await secretRepo.syncInbox() // ключ мог уже ждать в инбоксе
                if !secretRepo.hasThreadKey(conversationId) {
                    ui.error = "Ключ шифрования ещё не получен — попробуйте чуть позже"
                    return
                }
            }
            ui.sending = true
            ui.error = nil
            ui.uploadProgress = 0
            let r = await secretRepo.sendAttachments(
                conversationId: conversationId,
                peerUserIds: secretPeers,
                files: files,
                caption: caption,
                onProgress: { [weak self] done, total in
                    guard total > 0 else { return }
                    let pct = min(max(Float(done) / Float(total), 0), 1)
                    // Колбэк с фонового потока; стейт дросселируем до целых процентов —
                    // иначе рекомпозиции на каждый чанк.
                    Task { @MainActor [weak self] in
                        guard let self else { return }
                        if Int(pct * 100) != Int((self.ui.uploadProgress ?? 0) * 100) {
                            self.ui.uploadProgress = pct
                        }
                    }
                },
                isCancelled: { [weak self] in self?.uploadCancelled ?? true }
            )
            switch r {
            case .success(let m):
                onSuccess?()
                ui.sending = false
                ui.uploadProgress = nil
                ui.messages = dedupSortedSecret(ui.messages + [secretToMessage(m)])
            case .failure(let message, _):
                ui.sending = false
                ui.uploadProgress = nil
                if !uploadCancelled {
                    // Отмена — не ошибка; в обоих случаях подпись возвращаем: она была
                    // частью сообщения.
                    ui.error = message
                }
                ui.restoredDraft = caption
            }
        }
    }

    /// Голосовое в секретке: вызывается из sendVoice() при secretMode.
    func sendSecretVoice(_ data: Data, durationSec: Int, waveform: [Int]) {
        Task {
            if !secretRepo.hasThreadKey(conversationId) {
                ui.error = "Ключ шифрования ещё не получен — попробуйте чуть позже"
                return
            }
            ui.sending = true
            ui.error = nil
            let file = OutgoingFile(bytes: data, name: "voice-message.m4a", mime: "audio/mp4")
            switch await secretRepo.sendAttachments(
                conversationId: conversationId,
                peerUserIds: secretPeers,
                files: [file],
                caption: nil,
                durationSec: durationSec,
                waveform: waveform
            ) {
            case .success(let m):
                ui.sending = false
                ui.messages = dedupSortedSecret(ui.messages + [secretToMessage(m)])
            case .failure(let message, _):
                ui.sending = false
                ui.error = message
            }
        }
    }

    // MARK: - Приглашение в секретный чат

    /// Принять приглашение на ЭТОМ устройстве → создатель ключует ровно его.
    func acceptSecretInvite() {
        guard !ui.secretInviteBusy else { return }
        Task {
            ui.secretInviteBusy = true
            ui.error = nil
            switch await secretRepo.acceptInvite(threadId: conversationId) {
            case .success:
                // Теперь ждём key package создателя; secretReady перещёлкнет импорт.
                ui.secretInviteBusy = false
                ui.secretInvite = false
                // Обновить кэш строки беседы до ACTIVE: иначе переоткрытие чата до прихода
                // ключа перечитает залежавшийся PENDING и снова покажет карточку инвайта
                // (чьё «Отклонить» ОТМЕНИЛО бы уже принятый тред).
                _ = await repo.listConversations()
                if secretPeers.isEmpty {
                    secretPeers = await repo.conversationPeerUserIds(conversationId)
                }
                await secretRepo.syncInbox()
                // Ремень: если создатель был оффлайн в момент accept'а, этот key_request
                // ляжет в его инбокс, и его ключевое устройство ответит (оключует нас),
                // когда снова выйдет в сеть.
                await secretRepo.requestThreadKey(threadId: conversationId, userIds: secretPeers)
            case .failure(let message, _):
                ui.secretInviteBusy = false
                ui.error = message
            }
        }
    }

    /// Отклонить приглашение → CANCELLED везде; экран уходит назад (secretDeclined).
    func declineSecretInvite() {
        guard !ui.secretInviteBusy else { return }
        Task {
            ui.secretInviteBusy = true
            switch await secretRepo.declineInvite(threadId: conversationId) {
            case .success:
                ui.secretInviteBusy = false
                ui.secretInvite = false
                ui.secretDeclined = true
            case .failure(let message, _):
                // Неудавшийся decline НЕ должен закрывать экран, пока тред на сервере PENDING.
                ui.secretInviteBusy = false
                ui.error = message
            }
        }
    }

    // MARK: - Привязка устройства (веб-паритет DeviceLinkInline)

    /// Мы — новое устройство: открыть сканер QR доверенного устройства.
    func openLinkScanner() {
        ui.linkScanning = true
        ui.linkError = nil
    }

    func closeLinkScanner() {
        ui.linkScanning = false
    }

    func onLinkCodeChange(_ value: String) {
        ui.linkCode = String(value.filter(\.isNumber).prefix(SecretRepository.inviteCodeLen))
        ui.linkError = nil
    }

    /// QR распознан: принимаем только код привязки Еблуши, остальное — понятная ошибка.
    func onLinkScanned(_ raw: String) {
        let value = raw.trimmed()
        guard value.contains(SecretRepository.addDeviceQrPrefix) else {
            ui.linkScanning = false
            ui.linkError = "Это не код привязки Еблуши"
            return
        }
        requestDeviceLink(value)
    }

    func submitLinkCode() {
        let code = ui.linkCode.trimmed()
        guard code.count == SecretRepository.inviteCodeLen else {
            ui.linkError = "Нужно \(SecretRepository.inviteCodeLen) цифр"
            return
        }
        requestDeviceLink(code)
    }

    /// Просим связку ключей у остальных своих устройств, предъявляя token/код приглашения.
    private func requestDeviceLink(_ tokenOrCode: String) {
        guard !ui.linkBusy else { return }
        Task {
            ui.linkBusy = true
            ui.linkError = nil
            ui.linkScanning = false
            switch await secretRepo.requestDeviceLink(tokenOrCode: tokenOrCode) {
            case .success(let count):
                ui.linkBusy = false
                ui.linkRequestedOn = count
                ui.linkCode = ""
            case .failure(let message, _):
                ui.linkBusy = false
                ui.linkError = message
            }
        }
    }

    /// Мы — доверенное устройство: показать приглашение (QR + 8 цифр) новому устройству.
    /// Переиспользует живое приглашение (веб: getDeviceLinkInvite() ?? create) — код не «прыгает».
    func createLinkInvite() {
        let invite = secretRepo.currentInvite() ?? secretRepo.createInvite()
        ui.linkInvite = invite
        ui.linkInviteLeftMs = max(invite.expiresAtMs - Int64(Date().timeIntervalSince1970 * 1000), 0)
        ui.linkedKeys = nil
        ui.linkedOut = nil
    }

    /// Закрытие карточки НЕ гасит приглашение (веб-паритет): код живёт свой TTL, чтобы его
    /// можно было продиктовать, закрыв диалог. Гасится только при успешной отдаче ключей
    /// или по кнопке «Обновить код».
    func dismissLinkInvite() {
        ui.linkInvite = nil
        ui.linkInviteLeftMs = 0
        ui.linkedOut = nil
    }

    /// Явное «Обновить код»: старое приглашение уничтожается, показывается новое.
    func refreshLinkInvite() {
        secretRepo.clearInvite()
        let invite = secretRepo.createInvite()
        ui.linkInvite = invite
        ui.linkInviteLeftMs = max(invite.expiresAtMs - Int64(Date().timeIntervalSince1970 * 1000), 0)
    }

    func dismissLinkResult() {
        ui.linkedKeys = nil
        ui.linkError = nil
    }
}
