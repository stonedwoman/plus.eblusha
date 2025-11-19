package org.eblusha.plus.feature.chatdetail

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import org.eblusha.plus.core.di.AppContainer
import org.eblusha.plus.data.api.messages.MessageDto
import org.eblusha.plus.data.api.messages.MessagesApi
import org.eblusha.plus.data.api.messages.SendMessageRequest
import org.eblusha.plus.feature.session.SessionUser

sealed interface ChatUiState {
    data object Loading : ChatUiState
    data class Loaded(val messages: List<ChatMessage>) : ChatUiState
    data class Error(val message: String) : ChatUiState
}

data class ChatMessage(
    val id: String,
    val content: String?,
    val senderName: String?,
    val senderAvatar: String?,
    val isMine: Boolean,
    val createdAt: String?,
    val type: String,
)

class ChatViewModel(
    private val conversationId: String,
    private val messagesApi: MessagesApi,
    private val currentUser: SessionUser,
) : ViewModel() {

    private val _state = MutableStateFlow<ChatUiState>(ChatUiState.Loading)
    val state: StateFlow<ChatUiState> = _state

    private val formatter = DateTimeFormatter.ofLocalizedDateTime(FormatStyle.SHORT)

    init {
        refresh()
    }

    fun refresh() {
        viewModelScope.launch {
            _state.value = ChatUiState.Loading
            _state.value = try {
                val response = messagesApi.getMessages(conversationId)
                ChatUiState.Loaded(response.messages.map { it.toChatMessage() })
            } catch (e: Throwable) {
                ChatUiState.Error(e.message ?: "Не удалось загрузить сообщения")
            }
        }
    }

    fun sendMessage(content: String) {
        if (content.isBlank()) return
        viewModelScope.launch {
            try {
                val body = SendMessageRequest(conversationId = conversationId, content = content.trim())
                val sent = messagesApi.sendMessage(body).message
                val current = (_state.value as? ChatUiState.Loaded)?.messages.orEmpty()
                _state.value = ChatUiState.Loaded(listOf(sent.toChatMessage()) + current)
            } catch (e: Throwable) {
                _state.value = ChatUiState.Error(e.message ?: "Не удалось отправить сообщение")
            }
        }
    }

    private fun MessageDto.toChatMessage(): ChatMessage {
        val date = createdAt?.let {
            runCatching { ZonedDateTime.parse(it).format(formatter) }.getOrNull()
        }
        val senderName = sender?.displayName ?: sender?.username
        return ChatMessage(
            id = id,
            content = content,
            senderName = senderName,
            senderAvatar = sender?.avatarUrl,
            isMine = senderId == currentUser.id,
            createdAt = date,
            type = type
        )
    }
}

class ChatViewModelFactory(
    private val container: AppContainer,
    private val conversationId: String,
    private val currentUser: SessionUser,
) : ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T {
        if (modelClass.isAssignableFrom(ChatViewModel::class.java)) {
            return ChatViewModel(
                conversationId = conversationId,
                messagesApi = container.messagesApi,
                currentUser = currentUser
            ) as T
        }
        throw IllegalArgumentException("Unknown ViewModel ${modelClass.simpleName}")
    }
}

