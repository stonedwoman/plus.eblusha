import Foundation
import UIKit

// Порт путей аплоада из `data/repository/ChatRepository.kt` (sendAttachment /
// sendAttachments / uploadFileAdaptive / sendVoiceMessage) и `data/remote/UploadApi.kt`.
//
// Загрузка файлов авторизованным клиентом. Маленькие файлы (≤10 МБ) уходят одним
// multipart-полем `file`; большие — чанковым путём (init → PUT части → complete),
// зеркалящим веб-контракт `/upload/init`. Оба пути возвращают прокси-URL
// `/api/files/{key}`.
//
// Приватные поля ChatRepository (api, session) из другого файла недоступны — extension
// берёт те же синглтоны через AppContainer.shared (это ровно те объекты, что внутри).

/// Файл из пикера, готовый к загрузке (альбом шлёт несколько ОДНИМ сообщением).
/// Порт `OutgoingFile` из data/repository/ChatRepository.kt.
struct OutgoingFile: Identifiable, Equatable {
    /// Стабильный id для ForEach чипов (в Kotlin роль играет индекс LazyRow).
    let id = UUID()
    let bytes: Data
    let name: String
    let mime: String
}

/// Пользователь нажал «отмена» у прогресса загрузки — не сбой, просто прерывание.
struct UploadCancelledException: Error, LocalizedError {
    var errorDescription: String? { "upload cancelled" }
}

/// Порог простого multipart-аплоада (веб CHUNK_UPLOAD_THRESHOLD): выше — чанками.
let simpleUploadMaxBytes = 10 * 1024 * 1024

/// Тело POST /upload/init (порт ChunkInitRequest из data/remote/UploadApi.kt).
struct ChunkInitRequest: Encodable {
    let filename: String
    let contentType: String
    let size: Int64
}

/// Ответ POST /upload/init (порт ChunkInitResponse из data/remote/UploadApi.kt).
struct ChunkInitResponse: Decodable {
    let uploadId: String
    let chunkSize: Int64
}

/// Аналог kotlin `require`/`check`: нарушение контракта — обычная ошибка, а не краш
/// (safeApiCall превратит её в текст баннера, как в оригинале).
private struct UploadContractError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

// MARK: - Аплоад вложений и голосовых

extension ChatRepository {

    /// Загружает [bytes] как multipart `file` и шлёт сообщение с ссылкой на него. Тип
    /// сообщения (IMAGE/VIDEO/AUDIO/FILE) и метаданные вложения зеркалят веб-контракт
    /// отправки, поэтому файл рисуется одинаково на всех клиентах (через прокси
    /// `/api/files/{key}`).
    func sendAttachment(
        _ conversationId: String,
        bytes: Data,
        fileName: String,
        mime: String,
        caption: String? = nil
    ) async -> ApiResult<Message> {
        await sendAttachments(
            conversationId,
            files: [OutgoingFile(bytes: bytes, name: fileName, mime: mime)],
            caption: caption
        )
    }

    /// Загружает каждый файл и шлёт все ОДНИМ сообщением (фотоальбомы; веб-паритет).
    /// Загрузки идут СТРОГО последовательно (параллель споткнулась бы об серверный
    /// rate-limit аплоада и перемешала бы альбом), и если ЛЮБАЯ загрузка падает —
    /// отправка отбрасывается целиком, частичного альбома не бывает. Тип сообщения —
    /// по веб-правилу «все одного типа»: все IMAGE → IMAGE (аналогично VIDEO/AUDIO),
    /// смесь → FILE.
    func sendAttachments(
        _ conversationId: String,
        files: [OutgoingFile],
        caption: String? = nil,
        /// done/total байт по ВСЕМ файлам сообщения (для прогресса в композере).
        onProgress: ((Int64, Int64) -> Void)? = nil,
        /// true → аборт между частями (кнопка «отмена» у прогресса).
        isCancelled: (() -> Bool)? = nil
    ) async -> ApiResult<Message> {
        await safeApiCall {
            guard !files.isEmpty else { throw UploadContractError(message: "no files to send") }
            let totalBytes = files.reduce(Int64(0)) { $0 + Int64($1.bytes.count) }
            var doneBytes: Int64 = 0
            var attachments: [AttachmentReq] = []
            for f in files {
                let uploaded = try await self.uploadFileAdaptive(f) { sent in
                    onProgress?(doneBytes + sent, totalBytes)
                    if isCancelled?() == true { throw UploadCancelledException() }
                }
                doneBytes += Int64(f.bytes.count)
                onProgress?(doneBytes, totalBytes)
                let attType = attachmentTypeFor(f.mime)
                let dims = attType == "IMAGE" ? imageDimensions(f.bytes) : nil
                attachments.append(AttachmentReq(
                    url: uploaded.url, // относительный "/api/files/{key}" — сквозным, как веб
                    type: attType,
                    size: Int64(f.bytes.count),
                    metadata: AttachmentMetadataReq(
                        originalName: f.name,
                        mime: f.mime,
                        objectKey: uploaded.path,
                        width: dims?.width,
                        height: dims?.height
                    )
                ))
            }
            var seenTypes = Set<String>()
            let types = attachments.map(\.type).filter { seenTypes.insert($0).inserted }
            let msgType = types.count == 1 ? types[0] : "FILE"
            let trimmedCaption = caption?.trimmed()
            let response: SendMessageResponse = try await AppContainer.shared.api.post(
                "conversations/send",
                body: SendMessageRequest(
                    conversationId: conversationId,
                    type: msgType,
                    content: (trimmedCaption?.isEmpty == false) ? caption : nil,
                    attachments: attachments
                )
            )
            return self.mapMessage(response.message)
        }
    }

    /// Загружает записанный голосовой клип ([bytes], AAC/MPEG-4) и шлёт его голосовым
    /// сообщением: `type=AUDIO` + верхнеуровневые `metadata.duration` (секунды) и
    /// `metadata.waveform` (бары). Совместимо по проводу с вебом, который рисует любое
    /// AUDIO-вложение волновым плеером.
    func sendVoiceMessage(
        _ conversationId: String,
        bytes: Data,
        durationSec: Int,
        waveform: [Int]
    ) async -> ApiResult<Message> {
        await safeApiCall {
            let uploaded: UploadResponse = try await AppContainer.shared.api.uploadMultipart(
                "upload", fileName: "voice-message.m4a", mime: "audio/mp4", data: bytes
            )
            let attachment = AttachmentReq(
                url: uploaded.url,
                type: "AUDIO",
                size: Int64(bytes.count),
                metadata: AttachmentMetadataReq(
                    originalName: "voice-message.m4a", mime: "audio/mp4", objectKey: uploaded.path
                )
            )
            let metadata = JSONValue.object([
                "duration": .number(Double(durationSec)),
                "waveform": .array(waveform.map { .number(Double($0)) }),
            ])
            let response: SendMessageResponse = try await AppContainer.shared.api.post(
                "conversations/send",
                body: SendMessageRequest(
                    conversationId: conversationId,
                    type: "AUDIO",
                    attachments: [attachment],
                    metadata: metadata
                )
            )
            return self.mapMessage(response.message)
        }
    }

    /// Загрузка файла с автоматическим выбором пути: ≤10 МБ — простой multipart, больше —
    /// чанками через /upload/init → PUT части → /complete (веб-контракт; часть ровно
    /// chunkSize, последняя — остаток). [onSent] зовётся ПОСЛЕ каждой части (для прогресса
    /// и проверки отмены — бросает UploadCancelledException, сессия аборится DELETE'ом).
    private func uploadFileAdaptive(
        _ f: OutgoingFile,
        onSent: (Int64) throws -> Void
    ) async throws -> UploadResponse {
        let api = AppContainer.shared.api
        // КАРТИНКИ держим на multipart до 25 МБ: серверные превью (thumb) генерятся только на
        // этом пути (чанк-complete не передаёт filePath — ревью), а без thumb каждый просмотр
        // пузыря качал бы полный размер. Multer-лимит сервера — 1 ГБ, запас есть.
        let simpleMax = f.mime.hasPrefix("image/") ? 25 * 1024 * 1024 : simpleUploadMaxBytes
        if f.bytes.count <= simpleMax {
            let uploaded: UploadResponse = try await api.uploadMultipart(
                "upload", fileName: f.name, mime: f.mime, data: f.bytes
            )
            try onSent(Int64(f.bytes.count))
            return uploaded
        }
        let initResp: ChunkInitResponse = try await api.post(
            "upload/init",
            body: ChunkInitRequest(
                filename: f.name,
                contentType: f.mime.trimmed().isEmpty ? "application/octet-stream" : f.mime,
                size: Int64(f.bytes.count)
            )
        )
        let chunkSize = max(Int(initResp.chunkSize), 1)
        let totalParts = (f.bytes.count + chunkSize - 1) / chunkSize
        do {
            var offset = 0
            var partNumber = 0
            while offset < f.bytes.count {
                let end = min(offset + chunkSize, f.bytes.count)
                try await api.putRawBytes(
                    "upload/\(initResp.uploadId)/part/\(partNumber)",
                    body: f.bytes.subdata(in: offset..<end)
                )
                try onSent(Int64(end))
                offset = end
                partNumber += 1
            }
            guard partNumber == totalParts else {
                throw UploadContractError(message: "part count mismatch")
            }
            try onSent(Int64(f.bytes.count)) // финальная проверка отмены ПЕРЕД complete (ревью)
            let completed: UploadResponse = try await api.postEmpty(
                "upload/\(initResp.uploadId)/complete"
            )
            return completed
        } catch {
            // Отмена или сбой — прибираем серверную сессию, чтобы не копить части на диске.
            // Аналог NonCancellable: аборт уходит НЕструктурированной задачей — без этого
            // аборт из уже отменённого Task'а (уход с экрана) не отправлялся бы вовсе, и
            // части висели бы на сервере до GC (ревью).
            await Task {
                try? await api.deleteIgnoringResponse("upload/\(initResp.uploadId)")
            }.value
            throw error
        }
    }

    private func attachmentTypeFor(_ mime: String) -> String {
        if mime.hasPrefix("image/") { return "IMAGE" }
        if mime.hasPrefix("video/") { return "VIDEO" }
        if mime.hasPrefix("audio/") { return "AUDIO" }
        return "FILE"
    }

    /// Размеры картинки для metadata.width/height (аналог BitmapFactory-bounds — UIImage).
    private func imageDimensions(_ bytes: Data) -> (width: Int, height: Int)? {
        guard let image = UIImage(data: bytes) else { return nil }
        let width = Int(image.size.width * image.scale)
        let height = Int(image.size.height * image.scale)
        guard width > 0, height > 0 else { return nil }
        return (width, height)
    }
}

// MARK: - Низкоуровневые запросы аплоада (недостающие режимы APIClient)

/// Отдельная сессия для аплоадов: телам в десятки мегабайт 30-секундный лимит
/// базового клиента слишком тесен (таймаут здесь — пауза без передачи данных).
private let uploadURLSession: URLSession = {
    let config = URLSessionConfiguration.default
    config.timeoutIntervalForRequest = 120
    return URLSession(configuration: config)
}()

/// Базовый APIClient умеет только JSON-тела. Multipart и сырые PUT-байты собираются
/// здесь; приватные поля клиента из другого файла недоступны, поэтому запрос строится
/// из тех же кирпичей заново: AppConfig.apiBaseURL + токен и deviceId из AppContainer.
extension APIClient {

    /// POST multipart-поля `file` (порт UploadApi.upload): filename + mime из пикера.
    func uploadMultipart<Out: Decodable>(
        _ path: String,
        fileName: String,
        mime: String,
        data: Data,
        field: String = "file"
    ) async throws -> Out {
        let boundary = "eblusha-\(UUID().uuidString)"
        // Имя файла чистим по минимуму (кавычки/переводы строк ломали бы заголовок части);
        // сервер берёт его в originalname → metadata.originalName задаёт видимое имя.
        let safeName = fileName
            .replacingOccurrences(of: "\"", with: "_")
            .replacingOccurrences(of: "\r", with: " ")
            .replacingOccurrences(of: "\n", with: " ")
        let contentType = mime.trimmed().isEmpty ? "application/octet-stream" : mime
        var body = Data()
        body.append(Data("--\(boundary)\r\n".utf8))
        body.append(Data(
            "Content-Disposition: form-data; name=\"\(field)\"; filename=\"\(safeName)\"\r\n".utf8
        ))
        body.append(Data("Content-Type: \(contentType)\r\n\r\n".utf8))
        body.append(data)
        body.append(Data("\r\n--\(boundary)--\r\n".utf8))
        let responseData = try await performUpload {
            var request = uploadRequest(path: path, method: "POST")
            request.setValue(
                "multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type"
            )
            request.httpBody = body
            return request
        }
        return try JSONDecoder().decode(Out.self, from: responseData)
    }

    /// Сырые байты части чанка (порт UploadApi.chunkPart): ровно chunkSize, последняя —
    /// остаток (сервер сверяет размер).
    func putRawBytes(_ path: String, body: Data) async throws {
        _ = try await performUpload {
            var request = uploadRequest(path: path, method: "PUT")
            request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
            request.httpBody = body
            return request
        }
    }

    /// POST без тела с декодируемым ответом (порт UploadApi.chunkComplete).
    func postEmpty<Out: Decodable>(_ path: String) async throws -> Out {
        let data = try await performUpload { uploadRequest(path: path, method: "POST") }
        return try JSONDecoder().decode(Out.self, from: data)
    }

    /// DELETE, чей ответ не важен (порт UploadApi.chunkAbort).
    func deleteIgnoringResponse(_ path: String) async throws {
        _ = try await performUpload { uploadRequest(path: path, method: "DELETE") }
    }

    private func uploadRequest(path: String, method: String) -> URLRequest {
        var request = URLRequest(url: AppConfig.apiBaseURL.appendingPathComponent(path))
        request.httpMethod = method
        request.setValue(
            AppContainer.shared.deviceIdProvider.deviceId(), forHTTPHeaderField: "x-device-id"
        )
        if let token = AppContainer.shared.sessionStore.currentAccessToken() {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        return request
    }

    /// Выполняет запрос; на 401 — одна тихая ротация токена и один повтор (порт
    /// TokenAuthenticator для путей мимо базового клиента). [build] зовётся заново
    /// на повторе, чтобы подцепить свежий Bearer.
    private func performUpload(_ build: () -> URLRequest) async throws -> Data {
        let (data, response) = try await uploadURLSession.data(for: build())
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        if code == 401, AppContainer.shared.sessionStore.currentRefreshToken() != nil {
            await AppContainer.shared.authRepository.tryBootstrap()
            let (retryData, retryResponse) = try await uploadURLSession.data(for: build())
            let retryCode = (retryResponse as? HTTPURLResponse)?.statusCode ?? 0
            guard (200..<300).contains(retryCode) else {
                throw HTTPError(code: retryCode, body: retryData)
            }
            return retryData
        }
        guard (200..<300).contains(code) else {
            throw HTTPError(code: code, body: data)
        }
        return data
    }
}
