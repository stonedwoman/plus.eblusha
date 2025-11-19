package org.eblusha.plus.feature.call

import android.content.Context
import android.Manifest
import android.content.pm.PackageManager
import androidx.core.content.ContextCompat
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.delay
import org.eblusha.plus.core.di.AppContainer
import org.eblusha.plus.data.livekit.LiveKitRepository
import org.eblusha.plus.feature.session.SessionUser
import io.livekit.android.LiveKit
import io.livekit.android.room.Room
import io.livekit.android.room.track.RemoteVideoTrack
import io.livekit.android.room.track.LocalVideoTrack
import io.livekit.android.room.track.LocalTrackPublication
import io.livekit.android.room.track.RemoteTrackPublication
import io.livekit.android.room.track.Track
import io.livekit.android.room.participant.RemoteParticipant
import io.livekit.android.room.participant.LocalParticipant
import io.livekit.android.util.LoggingLevel
import io.livekit.android.events.RoomEvent
import io.livekit.android.events.collect

sealed interface CallUiState {
    data object Idle : CallUiState
    data object Connecting : CallUiState
    data class Connected(
        val conversationId: String,
        val isVideoEnabled: Boolean,
        val isAudioEnabled: Boolean,
        val remoteVideoTracks: List<RemoteVideoTrack> = emptyList(),
        val localVideoTrack: LocalVideoTrack? = null,
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
    private var localVideoTrack: LocalVideoTrack? = null

    init {
        android.util.Log.d("CallViewModel", "Initializing CallViewModel for conversation: $conversationId, video: $isVideoCall")
        // Initialize LiveKit
        LiveKit.loggingLevel = LoggingLevel.DEBUG
        // Don't connect immediately - wait for ViewModel to be fully initialized
        viewModelScope.launch {
            try {
                kotlinx.coroutines.delay(100) // Small delay to ensure ViewModel is ready
                android.util.Log.d("CallViewModel", "Starting connection...")
                connect()
            } catch (e: Exception) {
                android.util.Log.e("CallViewModel", "Error in init", e)
                _uiState.value = CallUiState.Error("Ошибка инициализации: ${e.message}")
            }
        }
    }

    private fun connect() {
        viewModelScope.launch {
            android.util.Log.d("CallViewModel", "connect() called")
            _uiState.value = CallUiState.Connecting
            try {
                android.util.Log.d("CallViewModel", "Fetching token...")
                val tokenResponse = liveKitRepository.fetchToken(
                    conversationId = conversationId,
                    participantName = currentUser.displayName ?: currentUser.username,
                    metadata = mapOf(
                        "app" to "eblusha",
                        "userId" to currentUser.id,
                        "displayName" to (currentUser.displayName ?: currentUser.username),
                    )
                )
                android.util.Log.d("CallViewModel", "Token received, URL: ${tokenResponse.url}")

                // Create Room instance
                android.util.Log.d("CallViewModel", "Creating Room instance...")
                room = LiveKit.create(context)
                android.util.Log.d("CallViewModel", "Room created: ${room != null}")
                
                setupRoomObservers()
                
                // Connect to room - wait for connection to complete
                android.util.Log.d("CallViewModel", "Connecting to room...")
                room?.connect(
                    url = tokenResponse.url,
                    token = tokenResponse.token
                )
                android.util.Log.d("CallViewModel", "Connect call completed")
                
                enableLocalTracks()
                
                // Initial state - will be updated in Connected event handler
                android.util.Log.d("CallViewModel", "Updating state to Connected")
                _uiState.value = CallUiState.Connected(
                    conversationId = conversationId,
                    isVideoEnabled = isVideoCall,
                    isAudioEnabled = true,
                    remoteVideoTracks = remoteTracks.toList(),
                    localVideoTrack = null,
                )
            } catch (error: Throwable) {
                android.util.Log.e("CallViewModel", "Error in connect()", error)
                _uiState.value = CallUiState.Error(error.message ?: "Не удалось подключиться к звонку")
                cleanup()
            }
        }
    }
    
    private fun setupRoomObservers() {
        val r = room ?: return
        
        // Observe room events using Flow
        viewModelScope.launch {
            r.events.collect { event: RoomEvent ->
                android.util.Log.d("CallViewModel", "RoomEvent: $event")
                when (event) {
                    is RoomEvent.Connected -> {
                        android.util.Log.d("CallViewModel", "RoomEvent.Connected")
                        enableLocalTracks()
                    }
                    is RoomEvent.Disconnected -> {
                        val reason = event.reason?.toString() ?: "Соединение разорвано"
                        android.util.Log.d("CallViewModel", "RoomEvent.Disconnected: $reason")
                        _uiState.value = CallUiState.Error(reason)
                        cleanup()
                    }
                    is RoomEvent.Reconnecting -> {
                        android.util.Log.d("CallViewModel", "RoomEvent.Reconnecting")
                        // Keep current state but could show reconnecting indicator
                    }
                    is RoomEvent.ParticipantConnected -> {
                        android.util.Log.d("CallViewModel", "RoomEvent.ParticipantConnected: ${event.participant.identity}")
                        collectParticipantTracks(event.participant)
                    }
                    is RoomEvent.ParticipantDisconnected -> {
                        android.util.Log.d("CallViewModel", "RoomEvent.ParticipantDisconnected: ${event.participant.identity}")
                        // Remove tracks from disconnected participant - tracks are automatically removed
                        // Just update the UI
                        updateRemoteTracks()
                    }
                    is RoomEvent.TrackSubscribed -> {
                        android.util.Log.d("CallViewModel", "RoomEvent.TrackSubscribed: ${event.track.sid}")
                        val track = event.track
                        if (track is RemoteVideoTrack) {
                            remoteTracks.add(track)
                            updateRemoteTracks()
                        } else {
                            // Not a video track, ignore
                        }
                    }
                    is RoomEvent.TrackUnsubscribed -> {
                        android.util.Log.d("CallViewModel", "RoomEvent.TrackUnsubscribed: ${event.track.sid}")
                        val track = event.track
                        if (track is RemoteVideoTrack) {
                            remoteTracks.remove(track)
                            updateRemoteTracks()
                        } else {
                            // Not a video track, ignore
                        }
                    }
                    else -> {
                        android.util.Log.d("CallViewModel", "Unhandled RoomEvent: $event")
                    }
                }
            }
        }
    }
    
    private fun updateLocalVideoTrack(participant: LocalParticipant) {
        viewModelScope.launch {
            try {
                // Get camera track from local participant
                // videoTrackPublications is a Map<String, VideoTrackPublication>
                val publications = participant.videoTrackPublications
                val cameraPublication = publications
                    .filterIsInstance<LocalTrackPublication>()
                    .firstOrNull { publication ->
                        publication.source == Track.Source.CAMERA
                    }
                localVideoTrack = cameraPublication?.track as? LocalVideoTrack
                android.util.Log.d("CallViewModel", "Local video track: ${localVideoTrack != null}")
                
                val currentState = _uiState.value
                if (currentState is CallUiState.Connected) {
                    _uiState.value = currentState.copy(localVideoTrack = localVideoTrack)
                } else {
                    // If not connected yet, just store the track
                }
            } catch (e: Exception) {
                android.util.Log.e("CallViewModel", "Error getting local video track", e)
            }
        }
    }


    private fun updateRemoteTracks() {
        val currentState = _uiState.value
        if (currentState is CallUiState.Connected) {
            _uiState.value = currentState.copy(remoteVideoTracks = remoteTracks.toList())
        }
    }
    
    private fun collectParticipantTracks(participant: RemoteParticipant) {
        android.util.Log.d("CallViewModel", "Collecting tracks for participant: ${participant.identity}")
        // videoTrackPublications is a Map<String, VideoTrackPublication>
        val publications = participant.videoTrackPublications
        publications
            .filterIsInstance<RemoteTrackPublication>()
            .forEach { publication ->
                val track = publication.track
                if (track is RemoteVideoTrack && !remoteTracks.contains(track)) {
                    remoteTracks.add(track)
                    android.util.Log.d("CallViewModel", "Added remote video track: ${track.sid}")
                }
            }
        updateRemoteTracks()
    }

    private suspend fun enableLocalTracks() {
        val r = room ?: return
        // Delay to ensure localParticipant is fully initialized
        delay(1000)

        val participant = r.localParticipant
        if (participant != null) {
            val hasAudioPermission = ContextCompat.checkSelfPermission(
                context,
                Manifest.permission.RECORD_AUDIO
            ) == PackageManager.PERMISSION_GRANTED

            val hasCameraPermission = ContextCompat.checkSelfPermission(
                context,
                Manifest.permission.CAMERA
            ) == PackageManager.PERMISSION_GRANTED

            android.util.Log.d("CallViewModel", "Permissions: audio=$hasAudioPermission, camera=$hasCameraPermission")

            try {
                // Always try to enable microphone first
                if (hasAudioPermission) {
                    android.util.Log.d("CallViewModel", "Enabling microphone")
                    participant.setMicrophoneEnabled(true)
                    delay(200) // Small delay after enabling audio
                } else {
                    android.util.Log.w("CallViewModel", "Audio permission not granted, skipping microphone")
                    _uiState.value = CallUiState.Error("Необходимо разрешение на запись аудио для звонка")
                }

                // Then enable camera if it's a video call and we have permission
                if (isVideoCall && hasCameraPermission) {
                    android.util.Log.d("CallViewModel", "Enabling camera")
                    participant.setCameraEnabled(true)
                    // Get local video track after enabling camera
                    delay(500) // Wait for camera to initialize
                    updateLocalVideoTrack(participant)
                } else if (isVideoCall) {
                    android.util.Log.w("CallViewModel", "Camera permission not granted, skipping camera")
                }

                // Update UI state based on actual enabled status
                val currentState = _uiState.value
                if (currentState is CallUiState.Connected) {
                    _uiState.value = currentState.copy(
                        isVideoEnabled = isVideoCall && hasCameraPermission,
                        isAudioEnabled = hasAudioPermission,
                        localVideoTrack = localVideoTrack
                    )
                }

            } catch (e: Exception) {
                android.util.Log.e("CallViewModel", "Error enabling camera/microphone", e)
                _uiState.value = CallUiState.Error("Не удалось включить камеру/микрофон: ${e.message}")
            }
        } else {
            android.util.Log.w("CallViewModel", "localParticipant is null")
        }
    }

    fun toggleVideo() {
        val currentState = _uiState.value
        if (currentState is CallUiState.Connected) {
            viewModelScope.launch {
                val newState = !currentState.isVideoEnabled
                val participant = room?.localParticipant
                if (participant != null) {
                    try {
                        participant.setCameraEnabled(newState)
                        if (newState) {
                            // Wait a bit for camera to initialize, then get track
                            kotlinx.coroutines.delay(500)
                            updateLocalVideoTrack(participant)
                        } else {
                            localVideoTrack = null
                        }
                        _uiState.value = currentState.copy(
                            isVideoEnabled = newState,
                            localVideoTrack = localVideoTrack
                        )
                    } catch (e: Exception) {
                        android.util.Log.e("CallViewModel", "Error toggling video", e)
                        _uiState.value = CallUiState.Error("Не удалось переключить видео: ${e.message}")
                    }
                }
            }
        }
    }

    fun toggleAudio() {
        val currentState = _uiState.value
        if (currentState is CallUiState.Connected) {
            viewModelScope.launch {
                val newState = !currentState.isAudioEnabled
                val participant = room?.localParticipant
                if (participant != null) {
                    try {
                        participant.setMicrophoneEnabled(newState)
                        _uiState.value = currentState.copy(isAudioEnabled = newState)
                    } catch (e: Exception) {
                        android.util.Log.e("CallViewModel", "Error toggling audio", e)
                        _uiState.value = CallUiState.Error("Не удалось переключить микрофон: ${e.message}")
                    }
                }
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

