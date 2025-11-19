package org.eblusha.plus.ui.call

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.CallEnd
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.MicOff
import androidx.compose.material.icons.filled.Videocam
import androidx.compose.material.icons.filled.VideocamOff
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import org.eblusha.plus.core.di.AppContainer
import org.eblusha.plus.feature.call.CallUiState
import org.eblusha.plus.feature.call.CallViewModel
import org.eblusha.plus.feature.call.CallViewModelFactory
import org.eblusha.plus.feature.session.SessionUser
import org.eblusha.plus.ui.components.Avatar
import org.eblusha.plus.ui.theme.LocalSpacing
import org.eblusha.plus.ui.call.LiveKitVideoView
import androidx.compose.foundation.shape.RoundedCornerShape

@Composable
fun CallRoute(
    container: AppContainer,
    conversationId: String,
    currentUser: SessionUser,
    isVideoCall: Boolean,
    onHangUp: () -> Unit,
) {
    android.util.Log.d("CallRoute", "CallRoute called: conversationId=$conversationId, isVideoCall=$isVideoCall")
    val context = LocalContext.current
    val appContext = context.applicationContext // Use application context for LiveKit
    android.util.Log.d("CallRoute", "Context obtained: ${appContext != null}")
    val viewModel: CallViewModel = viewModel(
        factory = CallViewModelFactory(
            context = appContext,
            container = container,
            conversationId = conversationId,
            currentUser = currentUser,
            isVideoCall = isVideoCall,
        )
    )
    android.util.Log.d("CallRoute", "ViewModel created")
    val state by viewModel.uiState.collectAsStateWithLifecycle()
    android.util.Log.d("CallRoute", "State collected: $state")

    CallScreen(
        state = state,
        onHangUp = {
            viewModel.hangUp()
            onHangUp()
        },
        onToggleVideo = viewModel::toggleVideo,
        onToggleAudio = viewModel::toggleAudio,
    )
}

@Composable
private fun CallScreen(
    state: CallUiState,
    onHangUp: () -> Unit,
    onToggleVideo: () -> Unit,
    onToggleAudio: () -> Unit,
) {
    val spacing = LocalSpacing.current
    Surface(
        modifier = Modifier.fillMaxSize(),
        color = Color.Black
    ) {
        when (state) {
            CallUiState.Idle -> {
                Box(
                    modifier = Modifier.fillMaxSize(),
                    contentAlignment = Alignment.Center
                ) {
                    Text("Звонок завершён", color = Color.White)
                }
            }
            CallUiState.Connecting -> {
                Box(
                    modifier = Modifier.fillMaxSize(),
                    contentAlignment = Alignment.Center
                ) {
                    Column(
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(spacing.md)
                    ) {
                        CircularProgressIndicator(color = Color.White)
                        Text(
                            text = "Подключение...",
                            color = Color.White,
                            style = MaterialTheme.typography.titleMedium
                        )
                    }
                }
            }
            is CallUiState.Connected -> {
                Column(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(spacing.lg),
                    verticalArrangement = Arrangement.SpaceBetween
                ) {
                    // Video area
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .weight(1f)
                            .background(Color.Black),
                        contentAlignment = Alignment.Center
                    ) {
                        // Remote video (main view)
                        if (state.remoteVideoTracks.isNotEmpty()) {
                            // Show first remote video track
                            LiveKitVideoView(
                                track = state.remoteVideoTracks.first(),
                                modifier = Modifier.fillMaxSize()
                            )
                        } else {
                            // Show placeholder when no remote video
                            Text(
                                text = if (state.isVideoEnabled) "Ожидание видео..." else "Видео выключено",
                                color = Color.White,
                                textAlign = TextAlign.Center
                            )
                        }
                        
                        // Local video (picture-in-picture in corner)
                        if (state.localVideoTrack != null && state.isVideoEnabled) {
                            Box(
                                modifier = Modifier
                                    .align(Alignment.TopEnd)
                                    .padding(spacing.md)
                                    .size(width = 120.dp, height = 160.dp)
                                    .background(Color(0xFF1A1A1A), androidx.compose.foundation.shape.RoundedCornerShape(12.dp))
                            ) {
                                LiveKitVideoView(
                                    track = state.localVideoTrack,
                                    modifier = Modifier.fillMaxSize()
                                )
                            }
                        }
                    }

                    // Controls
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceEvenly,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        // Audio toggle
                        Button(
                            onClick = onToggleAudio,
                            shape = CircleShape,
                            modifier = Modifier.size(64.dp),
                            colors = ButtonDefaults.buttonColors(
                                containerColor = if (state.isAudioEnabled) {
                                    MaterialTheme.colorScheme.primary
                                } else {
                                    MaterialTheme.colorScheme.error
                                }
                            )
                        ) {
                            Icon(
                                imageVector = if (state.isAudioEnabled) Icons.Default.Mic else Icons.Default.MicOff,
                                contentDescription = if (state.isAudioEnabled) "Выключить микрофон" else "Включить микрофон",
                                modifier = Modifier.size(32.dp)
                            )
                        }

                        // Video toggle
                        Button(
                            onClick = onToggleVideo,
                            shape = CircleShape,
                            modifier = Modifier.size(64.dp),
                            colors = ButtonDefaults.buttonColors(
                                containerColor = if (state.isVideoEnabled) {
                                    MaterialTheme.colorScheme.primary
                                } else {
                                    MaterialTheme.colorScheme.error
                                }
                            )
                        ) {
                            Icon(
                                imageVector = if (state.isVideoEnabled) Icons.Default.Videocam else Icons.Default.VideocamOff,
                                contentDescription = if (state.isVideoEnabled) "Выключить видео" else "Включить видео",
                                modifier = Modifier.size(32.dp)
                            )
                        }

                        // Hang up
                        Button(
                            onClick = onHangUp,
                            shape = CircleShape,
                            modifier = Modifier.size(64.dp),
                            colors = ButtonDefaults.buttonColors(
                                containerColor = MaterialTheme.colorScheme.error
                            )
                        ) {
                            Icon(
                                imageVector = Icons.Default.CallEnd,
                                contentDescription = "Завершить звонок",
                                modifier = Modifier.size(32.dp)
                            )
                        }
                    }
                }
            }
            is CallUiState.Error -> {
                Box(
                    modifier = Modifier.fillMaxSize(),
                    contentAlignment = Alignment.Center
                ) {
                    Column(
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(spacing.md)
                    ) {
                        Text(
                            text = "Ошибка",
                            color = MaterialTheme.colorScheme.error,
                            style = MaterialTheme.typography.titleLarge
                        )
                        Text(
                            text = state.message,
                            color = Color.White,
                            textAlign = TextAlign.Center
                        )
                        Button(onClick = onHangUp) {
                            Text("Закрыть")
                        }
                    }
                }
            }
        }
    }
}

