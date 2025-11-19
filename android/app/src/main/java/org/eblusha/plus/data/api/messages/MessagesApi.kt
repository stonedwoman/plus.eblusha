package org.eblusha.plus.data.api.messages

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.POST
import retrofit2.http.Path

interface MessagesApi {
    @GET("conversations/{conversationId}/messages")
    suspend fun getMessages(@Path("conversationId") conversationId: String): MessagesResponse

    @POST("conversations/send")
    suspend fun sendMessage(@Body body: SendMessageRequest): MessageEnvelope
}

@Serializable
data class MessagesResponse(
    val messages: List<MessageDto> = emptyList(),
)

@Serializable
data class MessageEnvelope(
    val message: MessageDto,
)

@Serializable
data class MessageDto(
    val id: String,
    val conversationId: String? = null,
    val type: String,
    val content: String? = null,
    val sender: Sender? = null,
    val senderId: String? = null,
    val createdAt: String? = null,
    val metadata: Map<String, JsonElement>? = null
)

@Serializable
data class Sender(
    val id: String,
    val username: String,
    val displayName: String? = null,
    val avatarUrl: String? = null,
)

@Serializable
data class SendMessageRequest(
    val conversationId: String,
    @SerialName("type") val type: String,
    @SerialName("content") val content: String? = null,
    @SerialName("metadata") val metadata: Map<String, kotlinx.serialization.json.JsonElement>? = null,
    @SerialName("replyToId") val replyToId: String? = null,
    @SerialName("attachments") val attachments: List<MessageAttachment>? = null,
)

@Serializable
data class MessageAttachment(
    val url: String,
    val type: String,
    val size: Long? = null,
    val metadata: Map<String, kotlinx.serialization.json.JsonElement>? = null,
)

