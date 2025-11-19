package org.eblusha.plus.feature.call

import android.content.Context
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import org.eblusha.plus.core.di.AppContainer
import org.eblusha.plus.data.livekit.LiveKitRepository
import org.eblusha.plus.feature.session.SessionUser
import io.livekit.android.LiveKit
import io.livekit.android.room.Room
import io.livekit.android.room.track.LocalAudioTrack
import io.livekit.android.room.track.LocalVideoTrack
import io.livekit.android.room.track.RemoteVideoTrack
import io.livekit.android.util.LoggingLevel

sealed interface CallUiState {
    data object Idle : CallUiState
    data object Connecting : CallUiState
    data class Connected(
        val conversationId: String,
        val isVideoEnabled: Boolean,
        val isAudioEnabled: Boolean,
        val remoteVideoTracks: List<RemoteVideoTrack> = emptyList(),
    ) : CallUiState
    data class Error(val message: String) : CallUiState
}

class CallViewModel(
    private val context: Context,
    private val liveKitRepository: LiveKitRepository,
    private val conversationId: String,
    private val currentUser: SessionUser,
    private val isVideoCall: Boolean,
) : ViewModel() {

    private val _uiState = MutableStateFlow<CallUiState>(CallUiState.Idle)
    val uiState: StateFlow<CallUiState> = _uiState

    private var room: Room? = null
    private var localAudioTrack: LocalAudioTrack? = null
    private var localVideoTrack: LocalVideoTrack? = null
    private val remoteTracks = mutableListOf<RemoteVideoTrack>()

    init {
        // Initialize LiveKit
        LiveKit.loggingLevel = LoggingLevel.DEBUG
        connect()
    }

    private fun connect() {
        viewModelScope.launch {
            _uiState.value = CallUiState.Connecting
            try {
                val tokenResponse = liveKitRepository.fetchToken(
                    conversationId = conversationId,
                    participantName = currentUser.displayName ?: currentUser.username,
                    metadata = mapOf(
                        "app" to "eblusha",
                        "userId" to currentUser.id,
                        "displayName" to (currentUser.displayName ?: currentUser.username),
                    )
                )

                // Create and connect to room
                room = Room(context)
                
                // Set up event listeners
                setupRoomListeners()
                
                // Connect to room
                room?.connect(tokenResponse.url, tokenResponse.token)?.onSuccess {
                    viewModelScope.launch {
                        // Publish tracks after connection
                        publishTracks()
                        _uiState.value = CallUiState.Connected(
                            conversationId = conversationId,
                            isVideoEnabled = isVideoCall,
                            isAudioEnabled = true,
                            remoteVideoTracks = remoteTracks.toList(),
                        )
                    }
                }?.onFailure { error ->
                    _uiState.value = CallUiState.Error(error.message ?: "Не удалось подключиться к комнате")
                }
            } catch (error: Throwable) {
                _uiState.value = CallUiState.Error(error.message ?: "Не удалось подключиться к звонку")
            }
        }
    }

    private fun setupRoomListeners() {
        room?.let { r ->
            r.onParticipantConnected = { participant ->
                viewModelScope.launch {
                    // Handle new participant
                }
            }
            
            r.onParticipantDisconnected = { participant ->
                viewModelScope.launch {
                    // Remove tracks from disconnected participant
                    remoteTracks.removeAll { track ->
                        participant.videoTrackPublications.any { it.track == track }
                    }
                    updateRemoteTracks()
                }
            }
            
            r.onTrackSubscribed = { track, publication, participant ->
                viewModelScope.launch {
                    if (track is RemoteVideoTrack) {
                        remoteTracks.add(track)
                        updateRemoteTracks()
                    }
                }
            }
            
            r.onTrackUnsubscribed = { track, publication, participant ->
                viewModelScope.launch {
                    if (track is RemoteVideoTrack) {
                        remoteTracks.remove(track)
                        updateRemoteTracks()
                    }
                }
            }
        }
    }

    private suspend fun publishTracks() {
        val r = room ?: return
        
        // Publish audio track
        localAudioTrack = LocalAudioTrack.createAudioTrack(context, true)
        localAudioTrack?.let { r.localParticipant?.publishAudioTrack(it) }
        
        // Publish video track if it's a video call
        if (isVideoCall) {
            localVideoTrack = LocalVideoTrack.createCameraTrack(context, true)
            localVideoTrack?.let { r.localParticipant?.publishVideoTrack(it) }
        }
    }

    private fun updateRemoteTracks() {
        val currentState = _uiState.value
        if (currentState is CallUiState.Connected) {
            _uiState.value = currentState.copy(remoteVideoTracks = remoteTracks.toList())
        }
    }

    fun toggleVideo() {
        val currentState = _uiState.value
        if (currentState is CallUiState.Connected) {
            val newState = !currentState.isVideoEnabled
            if (newState) {
                // Enable video
                viewModelScope.launch {
                    if (localVideoTrack == null) {
                        localVideoTrack = LocalVideoTrack.createCameraTrack(context, true)
                        localVideoTrack?.let { room?.localParticipant?.publishVideoTrack(it) }
                    } else {
                        localVideoTrack?.setEnabled(true)
                    }
                    _uiState.value = currentState.copy(isVideoEnabled = true)
                }
            } else {
                // Disable video
                localVideoTrack?.setEnabled(false)
                _uiState.value = currentState.copy(isVideoEnabled = false)
            }
        }
    }

    fun toggleAudio() {
        val currentState = _uiState.value
        if (currentState is CallUiState.Connected) {
            val newState = !currentState.isAudioEnabled
            room?.localParticipant?.setMicrophoneEnabled(newState)
            _uiState.value = currentState.copy(isAudioEnabled = newState)
        }
    }

    fun hangUp() {
        viewModelScope.launch {
            cleanup()
            _uiState.value = CallUiState.Idle
        }
    }

    private fun cleanup() {
        localAudioTrack?.stop()
        localVideoTrack?.stop()
        localAudioTrack = null
        localVideoTrack = null
        room?.disconnect()
        room = null
        remoteTracks.clear()
    }

    override fun onCleared() {
        super.onCleared()
        cleanup()
    }
}

class CallViewModelFactory(
    private val context: Context,
    private val container: AppContainer,
    private val conversationId: String,
    private val currentUser: SessionUser,
    private val isVideoCall: Boolean,
) : ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T {
        if (modelClass.isAssignableFrom(CallViewModel::class.java)) {
            return CallViewModel(
                context = context,
                liveKitRepository = container.liveKitRepository,
                conversationId = conversationId,
                currentUser = currentUser,
                isVideoCall = isVideoCall,
            ) as T
        }
        throw IllegalArgumentException("Unknown ViewModel class")
    }
}

