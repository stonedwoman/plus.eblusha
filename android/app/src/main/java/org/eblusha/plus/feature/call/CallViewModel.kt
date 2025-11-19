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
import io.livekit.android.room.track.Track
import io.livekit.android.room.participant.RemoteParticipant

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
                room = LiveKit.create(context)
                
                // Set up event listeners
                setupRoomListeners()
                
                // Connect to room
                room?.connect(tokenResponse.url, tokenResponse.token) { result ->
                    viewModelScope.launch {
                        if (result.isSuccess) {
                            // Publish tracks after connection
                            publishTracks()
                            _uiState.value = CallUiState.Connected(
                                conversationId = conversationId,
                                isVideoEnabled = isVideoCall,
                                isAudioEnabled = true,
                                remoteVideoTracks = remoteTracks.toList(),
                            )
                        } else {
                            _uiState.value = CallUiState.Error(result.exceptionOrNull()?.message ?: "Не удалось подключиться к комнате")
                        }
                    }
                }
            } catch (error: Throwable) {
                _uiState.value = CallUiState.Error(error.message ?: "Не удалось подключиться к звонку")
            }
        }
    }

    private fun setupRoomListeners() {
        room?.addListener(object : Room.Listener {
            override fun onParticipantConnected(room: Room, participant: RemoteParticipant) {
                viewModelScope.launch {
                    // Handle new participant
                }
            }
            
            override fun onParticipantDisconnected(room: Room, participant: RemoteParticipant) {
                viewModelScope.launch {
                    // Remove tracks from disconnected participant
                    participant.videoTrackPublications.forEach { publication ->
                        publication.track?.let { track ->
                            if (track is RemoteVideoTrack) {
                                remoteTracks.remove(track)
                            }
                        }
                    }
                    updateRemoteTracks()
                }
            }
            
            override fun onTrackSubscribed(
                room: Room,
                track: Track,
                publication: io.livekit.android.room.participant.TrackPublication,
                participant: RemoteParticipant
            ) {
                viewModelScope.launch {
                    if (track is RemoteVideoTrack) {
                        remoteTracks.add(track)
                        updateRemoteTracks()
                    }
                }
            }
            
            override fun onTrackUnsubscribed(
                room: Room,
                track: Track,
                publication: io.livekit.android.room.participant.TrackPublication,
                participant: RemoteParticipant
            ) {
                viewModelScope.launch {
                    if (track is RemoteVideoTrack) {
                        remoteTracks.remove(track)
                        updateRemoteTracks()
                    }
                }
            }
        })
    }

    private suspend fun publishTracks() {
        val r = room ?: return
        val localParticipant = r.localParticipant ?: return
        
        // TODO: Publish tracks - need to check correct API
        // For now, just mark as connected without tracks
        // This will be implemented once we verify Room connection works
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
            // TODO: Implement video toggle once track creation is fixed
            _uiState.value = currentState.copy(isVideoEnabled = !currentState.isVideoEnabled)
        }
    }

    fun toggleAudio() {
        val currentState = _uiState.value
        if (currentState is CallUiState.Connected) {
            // TODO: Implement audio toggle once track creation is fixed
            viewModelScope.launch {
                // room?.localParticipant?.setMicrophoneEnabled(!currentState.isAudioEnabled)
                _uiState.value = currentState.copy(isAudioEnabled = !currentState.isAudioEnabled)
            }
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

