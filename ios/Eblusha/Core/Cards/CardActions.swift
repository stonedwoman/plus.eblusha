import Foundation

// Один маршрут действий для всех типов карточек (SPEC-share §2.3):
//   GET  /api/cards/:messageId                        → 200 { message, card, serverNow }
//   POST /api/cards/:messageId/act { action, input? } → 200 { message, card, serverNow }
// Ошибки — { code, message?, card? }: 404 CARD_NOT_FOUND, 400 CARD_BAD_INPUT, 403 CARD_FORBIDDEN,
// 409 CARD_CLOSED / CARD_ACTION_EXPIRED (+ card — молча перерисовать), 404 CARD_TYPE_DISABLED, 429.

/// Ответ маршрута карточек (и тело ошибки — те же поля).
struct CardResponseDto: Decodable {
    var message: MessageDto?
    var card: JSONValue?
    var serverNow: JSONValue?
    var code: String?

    private enum CodingKeys: String, CodingKey { case message, card, serverNow, code }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        // Кривое сообщение не должно ронять действие: карточка придёт и отдельным полем.
        message = try? c.decodeIfPresent(MessageDto.self, forKey: .message)
        card = try? c.decodeIfPresent(JSONValue.self, forKey: .card)
        serverNow = try? c.decodeIfPresent(JSONValue.self, forKey: .serverNow)
        code = try? c.decodeIfPresent(String.self, forKey: .code)
    }
}

struct CardActRequest: Encodable {
    let action: String
    var input: JSONValue?
}

/// Итог действия карточки для вью-модели.
enum CardActOutcome {
    /// Сервер принял: новое сообщение (или только карточка) и его часы.
    case done(message: Message?, card: BotCard?, serverNow: Date?)
    /// 409: состояние уже другое — молча перерисовать по присланному.
    case conflict(message: Message?, card: BotCard?, serverNow: Date?)
    /// Остальное: статус, код сервера (nil — сеть).
    case failed(status: Int?, code: String?)
}

extension ChatRepository {

    func cardAct(messageId: String, action: String, input: JSONValue?) async -> CardActOutcome {
        do {
            let data = try await apiClient.postRaw(
                "cards/\(messageId)/act", body: CardActRequest(action: action, input: input)
            )
            let dto = try JSONDecoder().decode(CardResponseDto.self, from: data)
            return .done(message: dto.message.map(mapMessage), card: BotCard.parse(dto.card),
                         serverNow: dto.serverNow?.dateValue)
        } catch let http as HTTPError {
            let dto = try? JSONDecoder().decode(CardResponseDto.self, from: http.body)
            if http.code == 409 {
                return .conflict(message: dto?.message.map(mapMessage), card: BotCard.parse(dto?.card),
                                 serverNow: dto?.serverNow?.dateValue)
            }
            return .failed(status: http.code, code: dto?.code)
        } catch {
            return .failed(status: nil, code: nil)
        }
    }

    /// Свежее состояние карточки (после реконнекта или для проверки до действия).
    func cardGet(messageId: String) async -> (message: Message?, card: BotCard?, serverNow: Date?)? {
        guard let dto: CardResponseDto = try? await apiClient.get("cards/\(messageId)") else { return nil }
        return (dto.message.map(mapMessage), BotCard.parse(dto.card), dto.serverNow?.dateValue)
    }
}

/// Что сказать человеку, если действие не прошло (SPEC-share §2.3, §13; SPEC.md §10.5).
/// nil — молчать (404: карточки уже нет для этого зрителя).
enum CardActionErrors {
    static func toast(type: String, action: String, status: Int?, code: String?) -> String? {
        switch code {
        case "CARD_NOT_FOUND": return nil
        case "CARD_FORBIDDEN": return type == "share" ? "Решает тот, кто спросил" : "Это может сделать только тот, кто попросил"
        case "CARD_TYPE_DISABLED": return "Сейчас недоступно"
        case "CARD_BAD_INPUT": return "Не получилось"
        default: break
        }
        if status == 429 { return "Слишком часто" }
        if status == 404 { return nil }
        switch (type, action) {
        case ("promise", "arrived"): return "Не удалось отметить"
        case ("promise", "cancel"): return "Не удалось отменить"
        case ("promise", "reopen"): return "Не удалось вернуть"
        case ("share", "share"): return "Не получилось поделиться"
        default: return "Не получилось"
        }
    }
}
