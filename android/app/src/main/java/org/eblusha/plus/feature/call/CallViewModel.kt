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
import org.eblusha.plus.core.di.AppContainer
import org.eblusha.plus.data.livekit.LiveKitRepository
import org.eblusha.plus.feature.session.SessionUser
import io.livekit.android.LiveKit
import io.livekit.android.room.Room
import io.livekit.android.room.track.RemoteVideoTrack
import io.livekit.android.room.participant.RemoteParticipant
import io.livekit.android.util.LoggingLevel
import io.livekit.android.events.RoomEvent

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
                
                // Subscribe to room events before connecting
                setupRoomObservers()
                
                // Connect to room - wait for connection to complete
                android.util.Log.d("CallViewModel", "Connecting to room...")
                room?.connect(
                    url = tokenResponse.url,
                    token = tokenResponse.token
                )
                android.util.Log.d("CallViewModel", "Connect call completed")
                
                // Wait a bit for room to be fully connected before accessing localParticipant
                // The actual enabling will happen in the Connected event handler
                // For now, just update state
                android.util.Log.d("CallViewModel", "Updating state to Connected")
                _uiState.value = CallUiState.Connected(
                    conversationId = conversationId,
                    isVideoEnabled = isVideoCall,
                    isAudioEnabled = true,
                    remoteVideoTracks = remoteTracks.toList(),
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
            try {
                // Use a delay to wait for room to be ready, then enable tracks
                kotlinx.coroutines.delay(500) // Small delay to ensure room is connected
                
                // Check permissions before enabling tracks
                val hasAudioPermission = ContextCompat.checkSelfPermission(
                    context,
                    Manifest.permission.RECORD_AUDIO
                ) == PackageManager.PERMISSION_GRANTED
                
                val hasCameraPermission = ContextCompat.checkSelfPermission(
                    context,
                    Manifest.permission.CAMERA
                ) == PackageManager.PERMISSION_GRANTED
                
                android.util.Log.d("CallViewModel", "Permissions: audio=$hasAudioPermission, camera=$hasCameraPermission")
                
                // Now safely enable camera and microphone
                val participant = r.localParticipant
                if (participant != null) {
                    try {
                        // Only enable if we have permissions
                        if (isVideoCall && hasCameraPermission) {
                            android.util.Log.d("CallViewModel", "Enabling camera")
                            participant.setCameraEnabled(true)
                        } else if (isVideoCall) {
                            android.util.Log.w("CallViewModel", "Camera permission not granted, skipping camera")
                        }
                        
                        if (hasAudioPermission) {
                            android.util.Log.d("CallViewModel", "Enabling microphone")
                            participant.setMicrophoneEnabled(true)
                        } else {
                            android.util.Log.w("CallViewModel", "Audio permission not granted, skipping microphone")
                            _uiState.value = CallUiState.Error("Необходимо разрешение на запись аудио для звонка")
                        }
                    } catch (e: Exception) {
                        android.util.Log.e("CallViewModel", "Error enabling camera/microphone", e)
                        _uiState.value = CallUiState.Error("Не удалось включить камеру/микрофон: ${e.message}")
                    }
                } else {
                    android.util.Log.w("CallViewModel", "localParticipant is null after connection")
                }
            } catch (e: Exception) {
                // Handle error - log it but don't crash
                android.util.Log.e("CallViewModel", "Error setting up room observers", e)
            }
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
            viewModelScope.launch {
                val newState = !currentState.isVideoEnabled
                val participant = room?.localParticipant
                if (participant != null) {
                    try {
                        participant.setCameraEnabled(newState)
                        _uiState.value = currentState.copy(isVideoEnabled = newState)
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

