package org.eblusha.plus.data.api.conversations

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import retrofit2.http.GET

interface ConversationsApi {
    @GET("conversations")
    suspend fun getConversations(): ConversationsResponse
}

@Serializable
data class ConversationsResponse(
    val conversations: List<ConversationEdge> = emptyList(),
)

@Serializable
data class ConversationEdge(
    val conversation: Conversation,
    @SerialName("unreadCount") val unreadCount: Int = 0,
)

@Serializable
data class Conversation(
    val id: String,
    val title: String? = null,
    val isGroup: Boolean = false,
    val lastMessageAt: String? = null,
    val messages: List<MessageSnippet> = emptyList(),
    val participants: List<ConversationParticipant> = emptyList(),
)

@Serializable
data class ConversationParticipant(
    val user: ParticipantUser? = null,
)

@Serializable
data class ParticipantUser(
    val id: String,
    val username: String,
    val displayName: String? = null,
    val avatarUrl: String? = null,
)

@Serializable
data class MessageSnippet(
    val id: String,
    val type: String,
    val content: String? = null,
    val createdAt: String? = null,
    val sender: ParticipantUser? = null,
)

