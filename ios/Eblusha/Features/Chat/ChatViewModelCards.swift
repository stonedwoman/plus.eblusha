import Foundation

// Карточки бота во вью-модели беседы (SPEC-share §2.7): замена на месте по событию, действия с
// оптимистичным видом и откатом, выбор спросившего на карточке «поделиться перепиской».
// Хранимые поля (cardConfirmed, cardTransportOverride, ui.cardBusy/shareSelections) объявлены
// в ChatViewModel.swift — extension их держать не умеет.

extension ChatViewModel {

    // MARK: - События

    /// `message:update` по карточке: заменить сообщение на месте (по `rev`), ленту не
    /// перечитывать. false — это не карточка (или данных нет): пусть решает обычный путь.
    func applyMessageUpdate(messageId: String, info: MessageUpdateInfo) -> Bool {
        let mapped = info.message.map(repo.mapMessage)
        let card = BotCard.parse(info.card)
        guard info.reason == "card" || card != nil || mapped?.card != nil else { return false }
        CardClock.shared.noteServerNow(info.serverNow)
        guard let current = ui.messages.first(where: { $0.id == messageId }) else {
            // Карточки нет в загруженном окне — делать нечего (SPEC-share §2.4).
            return true
        }
        var next: Message
        if var mapped {
            if mapped.card == nil, let card { mapped.card = card }
            next = mapped
        } else if let card {
            next = current.withCard(card)
        } else {
            return false
        }
        // Удалённая карточка остаётся удалённой, пока сервер не скажет иное перечитыванием.
        if current.deleted, !next.deleted { next = current }
        replaceCardMessage(next)
        return true
    }

    /// Заменить сообщение-карточку, если пришедшее новее (правило `rev`). Новое состояние
    /// сервера отменяет оптимистичный вид: откатывать после него уже нечего.
    @discardableResult
    func replaceCardMessage(_ incoming: Message) -> Bool {
        guard let index = ui.messages.firstIndex(where: { $0.id == incoming.id }) else { return false }
        let baseline = cardConfirmed[incoming.id] ?? ui.messages[index]
        guard BotCardRevision.shouldReplace(current: baseline, incoming: incoming) else { return false }
        cardConfirmed[incoming.id] = nil
        ui.messages[index] = incoming
        return true
    }

    // MARK: - Действия

    /// Действие карточки (`POST /api/cards/:id/act`). Таймер — оптимистично (SPEC.md §10.5):
    /// карточка сразу в целевом виде, кнопка крутится; ответ сервера заменяет данные по `rev`,
    /// 409 — молча перерисовать, остальное — откат и короткий текст.
    func actOnCard(messageId: String, action: String, input: JSONValue? = nil) {
        guard !secretMode, ui.cardBusy[messageId] == nil,
              let index = ui.messages.firstIndex(where: { $0.id == messageId }),
              let card = ui.messages[index].renderableCard
        else { return }
        let confirmed = ui.messages[index]
        ui.cardBusy[messageId] = action
        if case .promise(let data) = card.payload,
           let optimistic = PromiseRules.optimistic(
               card: card, data: data, action: action, viewer: viewerPerson(), now: CardClock.shared.now()
           ) {
            cardConfirmed[messageId] = confirmed
            ui.messages[index] = confirmed.withCard(optimistic)
        }
        let type = card.type
        Task { @MainActor [weak self] in
            guard let self else { return }
            let outcome: CardActOutcome
            if let transport = self.cardTransportOverride {
                outcome = await transport(messageId, action, input)
            } else {
                outcome = await self.repo.cardAct(messageId: messageId, action: action, input: input)
            }
            self.finishCardAction(messageId: messageId, type: type, action: action, outcome: outcome)
        }
    }

    private func finishCardAction(messageId: String, type: String, action: String, outcome: CardActOutcome) {
        ui.cardBusy[messageId] = nil
        // Оптимистичный вид ещё на экране — сначала вернуть подтверждённое, потом применить
        // ответ сервера по `rev` (если пока летел запрос, пришло событие новее — его не трогаем).
        if let confirmed = cardConfirmed.removeValue(forKey: messageId),
           let index = ui.messages.firstIndex(where: { $0.id == messageId }) {
            ui.messages[index] = confirmed
        }
        switch outcome {
        case .done(let message, let card, let serverNow), .conflict(let message, let card, let serverNow):
            CardClock.shared.noteServerNow(serverNow)
            if let message {
                var next = message
                if next.card == nil, let card { next.card = card }
                replaceCardMessage(next)
            } else if let card, let current = ui.messages.first(where: { $0.id == messageId }) {
                replaceCardMessage(current.withCard(card))
            }
            if case .done = outcome, action == "share" || action == "decline" {
                ui.shareSelections[messageId] = nil
            }
        case .failed(let status, let code):
            if let text = CardActionErrors.toast(type: type, action: action, status: status, code: code) {
                ui.error = text
            }
        }
    }

    /// Я как участник карточки — для оптимистичного «отметил Рома» / «отменил Рома».
    private func viewerPerson() -> CardPerson? {
        guard let id = currentUserId, !id.isEmpty else { return nil }
        let user = repo.sessionUser.flatMap { $0.id == id ? $0 : nil }
        let fromFeed = ui.messages.first { $0.senderId == id && !$0.senderName.isEmpty && $0.senderName != "—" }?.senderName
        let name = user?.displayName.flatMap { $0.isEmpty ? nil : $0 } ?? user?.username ?? fromFeed ?? "Вы"
        return CardPerson(id: id, displayName: name, avatarUrl: user?.avatarUrl)
    }

    // MARK: - «Поделиться перепиской»: выбор спросившего

    /// Текущий выбор на карточке (с поправкой на то, что сейчас допустимо).
    func shareSelection(for message: Message) -> ShareSelection? {
        guard case .share(let data)? = message.renderableCard?.payload else { return nil }
        return ShareRules.effectiveSelection(data, stored: ui.shareSelections[message.id])
    }

    func selectSharePeriod(messageId: String, period: String) {
        guard let message = ui.messages.first(where: { $0.id == messageId }),
              case .share(let data)? = message.renderableCard?.payload,
              let option = data.option(period), ShareRules.selectable(option)
        else { return }
        let current = shareSelection(for: message)
        // Галка «фото» переживает смену периода, если в новом периоде фото есть.
        ui.shareSelections[messageId] = ShareSelection(
            period: period, photos: (current?.photos ?? false) && option.photos > 0
        )
    }

    func toggleSharePhotos(messageId: String) {
        guard let message = ui.messages.first(where: { $0.id == messageId }),
              case .share(let data)? = message.renderableCard?.payload,
              let current = shareSelection(for: message),
              let option = data.option(current.period), option.photos > 0
        else { return }
        ui.shareSelections[messageId] = ShareSelection(period: current.period, photos: !current.photos)
    }

    /// «Поделиться» — выбранный период и галка уходят в `input`.
    func shareChat(messageId: String) {
        guard let message = ui.messages.first(where: { $0.id == messageId }),
              let selection = shareSelection(for: message)
        else { return }
        actOnCard(messageId: messageId, action: "share", input: .object([
            "period": .string(selection.period),
            "photos": .bool(selection.photos),
        ]))
    }
}
