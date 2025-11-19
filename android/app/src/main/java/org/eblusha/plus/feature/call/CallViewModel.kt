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
import io.livekit.android.room.track.RemoteVideoTrack
import io.livekit.android.room.participant.RemoteParticipant
import io.livekit.android.util.LoggingLevel
import io.livekit.android.events.RoomEvent
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.flow.collect

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

                // Create Room instance
                room = LiveKit.create(context)
                
                // Subscribe to room events before connecting
                setupRoomObservers()
                
                // Connect to room
                room?.connect(
                    url = tokenResponse.url,
                    token = tokenResponse.token
                )
                
                // Enable camera and microphone
                room?.localParticipant?.setCameraEnabled(isVideoCall)
                room?.localParticipant?.setMicrophoneEnabled(true)
                
                // Update state to connected
                _uiState.value = CallUiState.Connected(
                    conversationId = conversationId,
                    isVideoEnabled = isVideoCall,
                    isAudioEnabled = true,
                    remoteVideoTracks = remoteTracks.toList(),
                )
            } catch (error: Throwable) {
                _uiState.value = CallUiState.Error(error.message ?: "Не удалось подключиться к звонку")
                cleanup()
            }
        }
    }
    
    private fun setupRoomObservers() {
        val r = room ?: return
        
        // Observe room events
        viewModelScope.launch {
            r.events.collect { event ->
                when (event) {
                    is RoomEvent.TrackSubscribed -> {
                        val track = event.track
                        if (track is RemoteVideoTrack) {
                            remoteTracks.add(track)
                            updateRemoteTracks()
                        }
                    }
                    is RoomEvent.TrackUnsubscribed -> {
                        val track = event.track
                        if (track is RemoteVideoTrack) {
                            remoteTracks.remove(track)
                            updateRemoteTracks()
                        }
                    }
                    is RoomEvent.ParticipantConnected -> {
                        // When a participant connects, collect their video tracks
                        collectParticipantTracks(event.participant)
                    }
                    is RoomEvent.ParticipantDisconnected -> {
                        // Remove tracks from disconnected participant
                        event.participant.videoTrackPublications.values.forEach { publication ->
                            publication.track?.let { track ->
                                if (track is RemoteVideoTrack) {
                                    remoteTracks.remove(track)
                                }
                            }
                        }
                        updateRemoteTracks()
                    }
                    is RoomEvent.Disconnected -> {
                        _uiState.value = CallUiState.Error("Соединение разорвано")
                        cleanup()
                    }
                    is RoomEvent.Reconnecting -> {
                        // Could show reconnecting indicator, but keep current state
                    }
                    is RoomEvent.Connected -> {
                        // Connection successful - state already updated in connect()
                        // Collect tracks from existing participants
                        r.remoteParticipants.values.forEach { participant ->
                            collectParticipantTracks(participant)
                        }
                    }
                    else -> {
                        // Other events not handled
                    }
                }
            }
        }
    }
    
    private fun collectParticipantTracks(participant: RemoteParticipant) {
        participant.videoTrackPublications.values.forEach { publication ->
            publication.track?.let { track ->
                if (track is RemoteVideoTrack && !remoteTracks.contains(track)) {
                    remoteTracks.add(track)
                }
            }
        }
        updateRemoteTracks()
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
            viewModelScope.launch {
                val newState = !currentState.isVideoEnabled
                room?.localParticipant?.setCameraEnabled(newState)
                _uiState.value = currentState.copy(isVideoEnabled = newState)
            }
        }
    }

    fun toggleAudio() {
        val currentState = _uiState.value
        if (currentState is CallUiState.Connected) {
            viewModelScope.launch {
                val newState = !currentState.isAudioEnabled
                room?.localParticipant?.setMicrophoneEnabled(newState)
                _uiState.value = currentState.copy(isAudioEnabled = newState)
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

