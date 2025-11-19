package org.eblusha.plus.feature.call

import android.content.Context
import android.Manifest
import android.content.pm.PackageManager
import androidx.core.content.ContextCompat
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.delay
import org.eblusha.plus.core.di.AppContainer
import org.eblusha.plus.data.livekit.LiveKitRepository
import org.eblusha.plus.feature.session.SessionUser
import io.livekit.android.LiveKit
import io.livekit.android.room.Room
import io.livekit.android.room.track.Track
import io.livekit.android.room.track.VideoTrack
import io.livekit.android.room.participant.Participant
import io.livekit.android.room.participant.RemoteParticipant
import io.livekit.android.room.participant.LocalParticipant
import io.livekit.android.util.LoggingLevel
import io.livekit.android.events.RoomEvent
import io.livekit.android.events.collect
import org.json.JSONObject
import java.util.Locale

sealed interface CallUiState {
    data object Idle : CallUiState
    data object Connecting : CallUiState
    data class Connected(
        val conversationId: String,
        val isVideoEnabled: Boolean,
        val isAudioEnabled: Boolean,
        val participants: List<CallParticipantUi> = emptyList(),
    ) : CallUiState
    data class Error(val message: String) : CallUiState
}

data class CallParticipantUi(
    val id: String,
    val displayName: String,
    val initials: String,
    val avatarUrl: String?,
    val videoTrack: VideoTrack?,
    val isLocal: Boolean,
    val isMuted: Boolean,
    val isSpeaking: Boolean,
    val hasVideo: Boolean,
)

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
    private var hadRemoteParticipants = false
    private var seenMultipleRemoteParticipants = false
    private var pendingHangJob: Job? = null

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
                        "avatarUrl" to (currentUser.avatarUrl ?: ""),
                    )
                )
                android.util.Log.d("CallViewModel", "Token received, URL: ${tokenResponse.url}")

                hadRemoteParticipants = false
                seenMultipleRemoteParticipants = false

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
                
                // Initial state - will be updated as tracks load
                android.util.Log.d("CallViewModel", "Updating state to Connected")
                _uiState.value = CallUiState.Connected(
                    conversationId = conversationId,
                    isVideoEnabled = isVideoCall,
                    isAudioEnabled = true,
                    participants = buildParticipantsState(),
                )

                enableLocalTracks()
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
                        refreshParticipants()
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
                        refreshParticipants()
                    }
                    is RoomEvent.ParticipantDisconnected -> {
                        android.util.Log.d("CallViewModel", "RoomEvent.ParticipantDisconnected: ${event.participant.identity}")
                        refreshParticipants()
                    }
                    is RoomEvent.TrackSubscribed -> {
                        android.util.Log.d("CallViewModel", "RoomEvent.TrackSubscribed: ${event.track.sid}")
                        refreshParticipants()
                    }
                    is RoomEvent.TrackUnsubscribed -> {
                        android.util.Log.d("CallViewModel", "RoomEvent.TrackUnsubscribed: ${event.track.sid}")
                        refreshParticipants()
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
                val track = participant.getTrackPublication(Track.Source.CAMERA)?.track as? VideoTrack
                android.util.Log.d("CallViewModel", "Local video track: ${track != null}")
                refreshParticipants()
            } catch (e: Exception) {
                android.util.Log.e("CallViewModel", "Error getting local video track", e)
            }
        }
    }

    private fun refreshParticipants() {
        val currentState = _uiState.value
        if (currentState is CallUiState.Connected) {
            val participants = buildParticipantsState()
            handleAutoHangup(participants)
            _uiState.value = currentState.copy(participants = participants)
        }
    }

    private fun buildParticipantsState(): List<CallParticipantUi> {
        val currentRoom = room ?: return emptyList()
        val participants = mutableListOf<CallParticipantUi>()
        currentRoom.localParticipant?.let { participants += it.toCallParticipantUi(isLocal = true) }
        currentRoom.remoteParticipants.values
            .sortedBy { it.joinedAt ?: Long.MAX_VALUE }
            .forEach { remote ->
                participants += remote.toCallParticipantUi(isLocal = false)
            }
        return participants
    }

    private fun handleAutoHangup(participants: List<CallParticipantUi>) {
        val remoteCount = participants.count { !it.isLocal }
        if (remoteCount > 1) {
            seenMultipleRemoteParticipants = true
        }
        if (remoteCount > 0) {
            pendingHangJob?.cancel()
            pendingHangJob = null
            hadRemoteParticipants = true
            return
        }
        if (!hadRemoteParticipants || seenMultipleRemoteParticipants) return
        if (pendingHangJob?.isActive == true) return
        pendingHangJob = viewModelScope.launch {
            delay(5_000)
            val stillNoRemote = room?.remoteParticipants?.isEmpty() ?: true
            if (stillNoRemote && hadRemoteParticipants && !seenMultipleRemoteParticipants) {
                android.util.Log.d("CallViewModel", "Auto hanging up after remote left")
                performHangUp()
            }
        }
    }

    private fun LocalParticipant.toCallParticipantUi(isLocal: Boolean): CallParticipantUi =
        toCallParticipantUiInternal(isLocal)

    private fun RemoteParticipant.toCallParticipantUi(isLocal: Boolean): CallParticipantUi =
        toCallParticipantUiInternal(isLocal)

    private fun Participant.toCallParticipantUiInternal(isLocal: Boolean): CallParticipantUi {
        val metadata = parseParticipantMetadata(this.metadata)
        val resolvedName = metadata.displayName
            ?: if (isLocal) {
                currentUser.displayName ?: currentUser.username
            } else {
                name ?: identity?.value
            }
            ?: if (isLocal) "Я" else "Участник"
        val avatar = metadata.avatarUrl
            ?: if (isLocal) currentUser.avatarUrl else null
        val track = findPrimaryVideoTrack()
        val identifier = sid.value.ifBlank { identity?.value ?: resolvedName }
        return CallParticipantUi(
            id = identifier,
            displayName = resolvedName,
            initials = computeInitials(resolvedName),
            avatarUrl = avatar,
            videoTrack = track,
            isLocal = isLocal,
            isMuted = !isMicrophoneEnabled,
            isSpeaking = isSpeaking,
            hasVideo = track != null,
        )
    }

    private fun Participant.findPrimaryVideoTrack(): VideoTrack? {
        val cameraTrack = getTrackPublication(Track.Source.CAMERA)?.track as? VideoTrack
        if (cameraTrack != null) return cameraTrack
        val fallback = trackPublications.values.firstOrNull { it.kind == Track.Kind.VIDEO }
        return fallback?.track as? VideoTrack
    }

    private fun computeInitials(name: String): String {
        val parts = name.trim().split("\\s+".toRegex()).filter { it.isNotEmpty() }
        if (parts.isEmpty()) return "?"
        val initials = parts.take(2).map { it.first().toString().uppercase(Locale.getDefault()) }
        return initials.joinToString("")
    }

    private data class ParticipantMetadata(
        val displayName: String? = null,
        val avatarUrl: String? = null,
        val userId: String? = null,
    )

    private fun parseParticipantMetadata(raw: String?): ParticipantMetadata {
        if (raw.isNullOrBlank()) return ParticipantMetadata()
        return try {
            val json = JSONObject(raw)
            ParticipantMetadata(
                displayName = json.optString("displayName").takeIf { it.isNotBlank() },
                avatarUrl = json.optString("avatarUrl").takeIf { it.isNotBlank() },
                userId = json.optString("userId").takeIf { it.isNotBlank() },
            )
        } catch (e: Exception) {
            android.util.Log.w("CallViewModel", "Failed to parse participant metadata: $raw", e)
            ParticipantMetadata()
        }
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
                    refreshParticipants()
                }

                // Update UI state based on actual enabled status
                val currentState = _uiState.value
                if (currentState is CallUiState.Connected) {
                    _uiState.value = currentState.copy(
                        isVideoEnabled = isVideoCall && hasCameraPermission,
                        isAudioEnabled = hasAudioPermission,
                    )
                }
                refreshParticipants()

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
                        }
                        _uiState.value = currentState.copy(isVideoEnabled = newState)
                        if (newState) {
                            updateLocalVideoTrack(participant)
                        } else {
                            refreshParticipants()
                        }
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
                        refreshParticipants()
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
            performHangUp()
        }
    }

    private fun cleanup() {
        pendingHangJob?.cancel()
        pendingHangJob = null
        room?.disconnect()
        room = null
    }

    private suspend fun performHangUp() {
        cleanup()
        _uiState.value = CallUiState.Idle
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

