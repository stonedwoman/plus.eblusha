package org.eblusha.plus.feature.chatdetail

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.launch
import org.eblusha.plus.core.di.AppContainer
import org.eblusha.plus.data.api.messages.MessageDto
import org.eblusha.plus.data.api.messages.MessagesApi
import org.eblusha.plus.data.api.messages.SendMessageRequest
import org.eblusha.plus.data.realtime.RealtimeEvent
import org.eblusha.plus.data.realtime.RealtimeService
import org.eblusha.plus.feature.session.SessionUser
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.flow.onEach
import retrofit2.HttpException

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
    private val realtimeService: RealtimeService,
) : ViewModel() {

    private val _state = MutableStateFlow<ChatUiState>(ChatUiState.Loading)
    val state: StateFlow<ChatUiState> = _state

    private val _sendError = MutableSharedFlow<String>()
    val sendError = _sendError.asSharedFlow()

    private val formatter = DateTimeFormatter.ofLocalizedDateTime(FormatStyle.SHORT)

    init {
        refresh()
        observeRealtimeMessages()
        // Join conversation room to receive real-time updates
        realtimeService.joinConversation(conversationId)
    }
    
    private fun observeRealtimeMessages() {
        viewModelScope.launch {
            realtimeService.events
                .onEach { event ->
                    if (event is RealtimeEvent.MessageNew && event.conversationId == conversationId) {
                        android.util.Log.d("ChatViewModel", "New message received: ${event.messageId}")
                        // Load new message and add to list without full refresh
                        addNewMessage(event.messageId)
                    }
                }
                .launchIn(viewModelScope)
        }
    }
    
    private fun addNewMessage(messageId: String) {
        viewModelScope.launch {
            val currentState = _state.value
            if (currentState !is ChatUiState.Loaded) {
                // If not loaded yet, just refresh
                refresh()
                return@launch
            }
            
            // Check if message already exists
            val existingMessage = currentState.messages.find { it.id == messageId }
            if (existingMessage != null) {
                android.util.Log.d("ChatViewModel", "Message $messageId already in list")
                return@launch
            }
            
            // Load all messages to get the new one (API doesn't have get by ID endpoint)
            // But we'll do it in background without showing loading state
            try {
                val response = messagesApi.getMessages(conversationId)
                val newMessages = response.messages.map { it.toChatMessage() }
                _state.value = ChatUiState.Loaded(newMessages)
            } catch (e: Throwable) {
                android.util.Log.e("ChatViewModel", "Error loading new message", e)
                // On error, just refresh
                refresh()
            }
        }
    }
    
    override fun onCleared() {
        super.onCleared()
        // Leave conversation room when ViewModel is cleared
        realtimeService.leaveConversation(conversationId)
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
                val body = SendMessageRequest(
                    conversationId = conversationId,
                    type = "TEXT",
                    content = content.trim(),
                    metadata = null, // Explicitly set to null for non-secret chats
                    replyToId = null,
                    attachments = null
                )
                android.util.Log.d("ChatViewModel", "Sending message: conversationId=$conversationId, type=TEXT, content=${content.take(50)}...")
                val sent = messagesApi.sendMessage(body).message
                val current = (_state.value as? ChatUiState.Loaded)?.messages.orEmpty()
                _state.value = ChatUiState.Loaded(listOf(sent.toChatMessage()) + current)
            } catch (e: Throwable) {
                android.util.Log.e("ChatViewModel", "Error sending message", e)
                val errorMessage = when {
                    e is HttpException && e.code() == 409 -> {
                        val responseBody = try {
                            e.response()?.errorBody()?.string()
                        } catch (ex: Exception) {
                            null
                        }
                        android.util.Log.e("ChatViewModel", "HTTP 409 error body: $responseBody")
                        
                        // Check if this is specifically a secret chat error
                        // For now, since secret chat functionality is not implemented on Android,
                        // we'll show a generic error message for all 409 errors
                        // TODO: Once secret chat is implemented, check conversation.isSecret and show specific message
                        "Не удалось отправить сообщение. Возможно, требуется активация секретного чата."
                    }
                    e is HttpException -> {
                        "Не удалось отправить сообщение (ошибка ${e.code()})"
                    }
                    else -> {
                        e.message ?: "Не удалось отправить сообщение"
                    }
                }
                _sendError.emit(errorMessage)
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
                currentUser = currentUser,
                realtimeService = container.realtimeService
            ) as T
        }
        throw IllegalArgumentException("Unknown ViewModel ${modelClass.simpleName}")
    }
}

