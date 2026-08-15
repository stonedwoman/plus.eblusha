import Foundation

/// Порт `core/result/ApiResult.kt`: UI-слой не видит сырых исключений.
enum ApiResult<T> {
    case success(T)
    case failure(message: String, code: Int? = nil)
}

/// Ошибка HTTP-уровня, брошенная APIClient: код + тело (для вытаскивания message).
struct HTTPError: Error {
    let code: Int
    let body: Data
}

/// Порт `safeApiCall`: любые ошибки сети/сервера превращаются в человеческий текст.
func safeApiCall<T>(_ block: () async throws -> T) async -> ApiResult<T> {
    do {
        return .success(try await block())
    } catch let error as HTTPError {
        return .failure(message: parseHTTPError(error), code: error.code)
    } catch let error as URLError {
        _ = error
        return .failure(message: "Нет соединения с сервером")
    } catch {
        return .failure(message: error.localizedDescription)
    }
}

private func parseHTTPError(_ error: HTTPError) -> String {
    if let object = try? JSONSerialization.jsonObject(with: error.body) as? [String: Any],
       let message = object["message"] as? String, !message.isEmpty {
        return message
    }
    return defaultHTTPMessage(error.code)
}

private func defaultHTTPMessage(_ code: Int) -> String {
    switch code {
    case 400: return "Неверные данные"
    case 401: return "Неверный логин или пароль"
    case 403: return "Доступ запрещён"
    case 404: return "Не найдено"
    case 409: return "Уже существует"
    case 429: return "Слишком много попыток, попробуйте позже"
    case 500...599: return "Ошибка сервера"
    default: return "Ошибка запроса (\(code))"
    }
}
