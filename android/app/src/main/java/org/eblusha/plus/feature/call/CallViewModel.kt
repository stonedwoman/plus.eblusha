package org.eblusha.plus.feature.call

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import org.eblusha.plus.core.di.AppContainer
import org.eblusha.plus.data.livekit.LiveKitRepository
import org.eblusha.plus.feature.session.SessionUser

sealed interface CallUiState {
    data object Idle : CallUiState
    data object Connecting : CallUiState
    data class Connected(
        val conversationId: String,
        val isVideoEnabled: Boolean,
        val isAudioEnabled: Boolean,
    ) : CallUiState
    data class Error(val message: String) : CallUiState
}

class CallViewModel(
    private val liveKitRepository: LiveKitRepository,
    private val conversationId: String,
    private val currentUser: SessionUser,
    private val isVideoCall: Boolean,
) : ViewModel() {

    private val _uiState = MutableStateFlow<CallUiState>(CallUiState.Idle)
    val uiState: StateFlow<CallUiState> = _uiState

    // TODO: Initialize LiveKit Room when SDK is properly integrated
    // private var room: livekit.Room? = null

    init {
        connect()
    }

    private fun connect() {
        viewModelScope.launch {
            _uiState.value = CallUiState.Connecting
            try {
                val roomName = "conv-$conversationId"
                val tokenResponse = liveKitRepository.fetchToken(
                    room = roomName,
                    participantName = currentUser.displayName ?: currentUser.username,
                    participantMetadata = mapOf(
                        "app" to "eblusha",
                        "userId" to currentUser.id,
                        "displayName" to (currentUser.displayName ?: currentUser.username),
                    )
                )

                // TODO: Initialize LiveKit Room and connect
                // For now, just mark as connected
                _uiState.value = CallUiState.Connected(
                    conversationId = conversationId,
                    isVideoEnabled = isVideoCall,
                    isAudioEnabled = true,
                )
            } catch (error: Throwable) {
                _uiState.value = CallUiState.Error(error.message ?: "Не удалось подключиться к звонку")
            }
        }
    }

    fun toggleVideo() {
        val currentState = _uiState.value
        if (currentState is CallUiState.Connected) {
            // TODO: Toggle video track
            _uiState.value = currentState.copy(isVideoEnabled = !currentState.isVideoEnabled)
        }
    }

    fun toggleAudio() {
        val currentState = _uiState.value
        if (currentState is CallUiState.Connected) {
            // TODO: Toggle audio track
            _uiState.value = currentState.copy(isAudioEnabled = !currentState.isAudioEnabled)
        }
    }

    fun hangUp() {
        viewModelScope.launch {
            // TODO: Disconnect from LiveKit room
            // room?.disconnect()
            // room = null
            _uiState.value = CallUiState.Idle
        }
    }

    override fun onCleared() {
        super.onCleared()
        // TODO: Clean up LiveKit room
        // room?.disconnect()
        // room = null
    }
}

class CallViewModelFactory(
    private val container: AppContainer,
    private val conversationId: String,
    private val currentUser: SessionUser,
    private val isVideoCall: Boolean,
) : ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T {
        if (modelClass.isAssignableFrom(CallViewModel::class.java)) {
            return CallViewModel(
                liveKitRepository = container.liveKitRepository,
                conversationId = conversationId,
                currentUser = currentUser,
                isVideoCall = isVideoCall,
            ) as T
        }
        throw IllegalArgumentException("Unknown ViewModel class")
    }
}

