package org.eblusha.plus.feature.chats

import android.os.Parcelable
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.parcelize.Parcelize
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import org.eblusha.plus.core.di.AppContainer
import org.eblusha.plus.data.api.conversations.ConversationEdge
import org.eblusha.plus.data.api.conversations.ConversationParticipant
import org.eblusha.plus.data.api.conversations.ConversationsApi
import org.eblusha.plus.data.api.conversations.MessageSnippet
import org.eblusha.plus.data.api.conversations.ParticipantUser
import org.eblusha.plus.data.realtime.RealtimeEvent
import org.eblusha.plus.data.realtime.RealtimeService
import org.eblusha.plus.feature.session.SessionUser

sealed interface ChatsUiState {
    data object Loading : ChatsUiState
    data class Success(val items: List<ConversationPreview>) : ChatsUiState
    data class Error(val message: String) : ChatsUiState
}

@Parcelize
data class ConversationPreview(
    val id: String,
    val title: String,
    val subtitle: String,
    val presenceText: String?,
    val isOnline: Boolean,
    val unreadCount: Int,
    val isGroup: Boolean,
    val isSecret: Boolean = false,
    val secretStatus: String? = null,
    val lastMessageTime: String?,
    val avatarUrl: String?,
) : Parcelable

class ChatsViewModel(
    private val conversationsApi: ConversationsApi,
    private val realtimeService: RealtimeService,
) : ViewModel() {

    private val _uiState = MutableStateFlow<ChatsUiState>(ChatsUiState.Loading)
    val uiState: StateFlow<ChatsUiState> = _uiState

    private var currentUser: SessionUser? = null
    private var refreshJob: Job? = null

    fun onUserAvailable(user: SessionUser) {
        if (currentUser?.id == user.id) return
        currentUser = user
        refresh()
        observeRealtime()
    }

    fun refresh() {
        val user = currentUser ?: run {
            _uiState.value = ChatsUiState.Error("Пользователь не определён")
            return
        }
        refreshJob?.cancel()
        refreshJob = viewModelScope.launch {
            _uiState.value = ChatsUiState.Loading
            _uiState.value = try {
                val response = conversationsApi.getConversations()
                val items = response.conversations.map { it.toPreview(user) }
                ChatsUiState.Success(items)
            } catch (error: Throwable) {
                ChatsUiState.Error(error.message ?: "Не удалось загрузить беседы")
            }
        }
    }

    private fun ConversationEdge.toPreview(user: SessionUser): ConversationPreview {
        val title = conversation.title
            ?: findFirstPeerName(user.id)
            ?: "Беседа ${conversation.id.takeLast(4)}"
        val lastMessage = conversation.messages.firstOrNull()
        val subtitle = formatSubtitle(lastMessage)
        val unread = unreadCount
        val presence = resolvePresence(conversation.participants, user.id)
        return ConversationPreview(
            id = conversation.id,
            title = title,
            subtitle = subtitle,
            presenceText = presence?.second,
            isOnline = presence?.first == true,
            unreadCount = unread,
            isGroup = conversation.isGroup,
            isSecret = conversation.isSecret,
            secretStatus = conversation.secretStatus,
            lastMessageTime = formatTime(conversation.lastMessageAt ?: lastMessage?.createdAt),
            avatarUrl = conversation.avatarUrl ?: resolveAvatar(conversation.participants, user.id)
        )
    }

    private fun formatSubtitle(message: MessageSnippet?): String {
        if (message == null) return "Сообщений пока нет"
        val sender = message.sender?.displayName ?: message.sender?.username
        val nickname = sender?.let { "$it: " } ?: ""
        return when (message.type.uppercase()) {
            "TEXT" -> "$nickname${message.content ?: "(пусто)"}"
            "IMAGE" -> "$nickname[фото]"
            "VIDEO" -> "$nickname[видео]"
            "AUDIO" -> "$nickname[аудио]"
            "FILE" -> "$nickname[файл]"
            "SYSTEM" -> message.content ?: "Системное сообщение"
            else -> "$nickname${message.content ?: "(${message.type.lowercase()})"}"
        }
    }

    private fun ConversationEdge.findFirstPeerName(currentUserId: String): String? {
        val peer = conversation.participants.firstOrNull { it.user?.id != currentUserId }
        val user = peer?.user
        return user?.displayName ?: user?.username
    }

    private fun observeRealtime() {
        viewModelScope.launch {
        realtimeService.events.collect { event ->
            when (event) {
                is RealtimeEvent.PresenceUpdate -> updatePresence(event.userId, event.status)
                else -> Unit
            }
        }
        }
    }

    private fun updatePresence(userId: String, status: String) {
        val current = _uiState.value
        if (current !is ChatsUiState.Success) return
        val updated = current.items.map { preview ->
            if (preview.isGroup) {
                preview
            } else {
                val online = status.equals("ONLINE", ignoreCase = true)
                preview.copy(
                    isOnline = online,
                    presenceText = if (online) "онлайн" else preview.presenceText
                )
            }
        }
        _uiState.value = ChatsUiState.Success(updated)
    }

    private fun resolveAvatar(participants: List<ConversationParticipant>, currentUserId: String): String? {
        val peer = participants.firstOrNull { it.user?.id != currentUserId }
        return peer?.user?.avatarUrl
    }

    private fun resolvePresence(participants: List<ConversationParticipant>, currentUserId: String): Pair<Boolean, String?>? {
        val peer = participants.firstOrNull { it.user?.id != currentUserId }?.user ?: return null
        val status = peer.status
        val lastSeen = peer.lastSeenAt
        val isOnline = status.equals("ONLINE", ignoreCase = true)
        val text = if (isOnline) {
            "онлайн"
        } else {
            lastSeen?.let { "был(а) онлайн ${formatRelativeTime(it)}" }
        }
        return isOnline to text
    }

    private fun formatRelativeTime(timestamp: String): String {
        return runCatching {
            val instant = OffsetDateTime.parse(timestamp).atZoneSameInstant(ZoneId.systemDefault())
            val now = ZonedDateTime.now()
            val today = now.toLocalDate()
            val date = instant.toLocalDate()
            val timeFormatter = DateTimeFormatter.ofPattern("HH:mm")
            when {
                date.isEqual(today) -> "сегодня в ${instant.toLocalTime().format(timeFormatter)}"
                date.plusDays(1) == today -> "вчера в ${instant.toLocalTime().format(timeFormatter)}"
                else -> instant.format(DateTimeFormatter.ofPattern("dd.MM.yyyy HH:mm"))
            }
        }.getOrDefault(timestamp)
    }

    private fun formatTime(timestamp: String?): String? {
        if (timestamp.isNullOrBlank()) return null
        return try {
            val instant = OffsetDateTime.parse(timestamp).atZoneSameInstant(ZoneId.systemDefault())
            val now = ZonedDateTime.now()
            val formatter = when {
                instant.toLocalDate().isEqual(now.toLocalDate()) -> DateTimeFormatter.ofPattern("HH:mm")
                instant.year == now.year -> DateTimeFormatter.ofPattern("d MMM")
                else -> DateTimeFormatter.ofPattern("d MMM yyyy")
            }
            instant.format(formatter)
        } catch (error: Throwable) {
            null
        }
    }
}

class ChatsViewModelFactory(
    private val container: AppContainer,
) : ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T {
        if (modelClass.isAssignableFrom(ChatsViewModel::class.java)) {
            return ChatsViewModel(
                conversationsApi = container.conversationsApi,
                realtimeService = container.realtimeService,
            ) as T
        }
        throw IllegalArgumentException("Unknown ViewModel class")
    }
}

