package org.eblusha.plus.ui.call

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
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
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import org.eblusha.plus.core.di.AppContainer
import org.eblusha.plus.feature.call.CallParticipantUi
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
    isGroup: Boolean = false,
    onHangUp: () -> Unit,
) {
    android.util.Log.d("CallRoute", "CallRoute called: conversationId=$conversationId, isVideoCall=$isVideoCall, isGroup=$isGroup")
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
            isGroup = isGroup,
        )
    )
    android.util.Log.d("CallRoute", "ViewModel created")
    val state by viewModel.uiState.collectAsStateWithLifecycle()
    android.util.Log.d("CallRoute", "State collected: $state")

    // joinCallRoom/leaveCallRoom now handled in ViewModel (onConnected/cleanup)
    // This matches web version where it's called in onConnected callback

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
                CallConnectedOverlay(
                    state = state,
                    onHangUp = onHangUp,
                    onToggleVideo = onToggleVideo,
                    onToggleAudio = onToggleAudio,
                )
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

@Composable
private fun CallConnectedOverlay(
    state: CallUiState.Connected,
    onHangUp: () -> Unit,
    onToggleVideo: () -> Unit,
    onToggleAudio: () -> Unit,
) {
    val spacing = LocalSpacing.current
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(
                Brush.verticalGradient(
                    colors = listOf(Color(0xFF05070B), Color(0xFF0F1927))
                )
            )
            .padding(16.dp)
    ) {
        Surface(
            modifier = Modifier
                .align(Alignment.Center)
                .fillMaxWidth()
                .heightIn(min = 360.dp, max = 760.dp),
            shape = RoundedCornerShape(32.dp),
            color = Color(0xFF0F141F),
            tonalElevation = 6.dp,
            shadowElevation = 12.dp
        ) {
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(24.dp),
                verticalArrangement = Arrangement.spacedBy(spacing.lg)
            ) {
                CallHeader(state.participants)
                CallParticipantsGrid(
                    participants = state.participants,
                    modifier = Modifier
                        .weight(1f)
                        .fillMaxWidth()
                )
                CallControlsBar(
                    isAudioEnabled = state.isAudioEnabled,
                    isVideoEnabled = state.isVideoEnabled,
                    onToggleAudio = onToggleAudio,
                    onToggleVideo = onToggleVideo,
                    onHangUp = onHangUp
                )
            }
        }
    }
}

@Composable
private fun CallHeader(participants: List<CallParticipantUi>) {
    val remoteNames = participants
        .filterNot { it.isLocal }
        .joinToString(", ") { it.displayName }
    Column(
        verticalArrangement = Arrangement.spacedBy(4.dp)
    ) {
        Text(
            text = "Видеозвонок",
            color = Color.White,
            style = MaterialTheme.typography.titleLarge,
            fontWeight = FontWeight.SemiBold
        )
        Text(
            text = if (remoteNames.isBlank()) "Ожидаем подключение собеседника" else remoteNames,
            color = Color.White.copy(alpha = 0.75f),
            style = MaterialTheme.typography.bodyMedium,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis
        )
        Surface(
            color = Color.White.copy(alpha = 0.12f),
            contentColor = Color.White,
            shape = RoundedCornerShape(50),
            modifier = Modifier.padding(top = 4.dp)
        ) {
            Text(
                text = "${participants.size} участника",
                modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp),
                style = MaterialTheme.typography.labelMedium
            )
        }
    }
}

@Composable
private fun CallParticipantsGrid(
    participants: List<CallParticipantUi>,
    modifier: Modifier = Modifier,
) {
    val spacing = LocalSpacing.current
    if (participants.isEmpty()) {
        Box(
            modifier = modifier.fillMaxSize(),
            contentAlignment = Alignment.Center
        ) {
            Text(
                text = "Ждём подключение других участников…",
                color = Color.White.copy(alpha = 0.8f),
                style = MaterialTheme.typography.bodyLarge,
                textAlign = TextAlign.Center
            )
        }
    } else {
        LazyVerticalGrid(
            columns = GridCells.Adaptive(minSize = 220.dp),
            modifier = modifier,
            verticalArrangement = Arrangement.spacedBy(spacing.md),
            horizontalArrangement = Arrangement.spacedBy(spacing.md),
        ) {
            items(participants, key = { it.id }) { participant ->
                CallParticipantTile(participant)
            }
        }
    }
}

@Composable
private fun CallParticipantTile(participant: CallParticipantUi) {
    val borderColor = if (participant.isSpeaking) Color(0xFF5EEAD4) else Color.Transparent
    val hasVideo = participant.videoTrack != null
    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .aspectRatio(16f / 9f),
        shape = RoundedCornerShape(24.dp),
        color = Color(0xFF050A12),
        border = if (borderColor == Color.Transparent) null else BorderStroke(2.dp, borderColor)
    ) {
        Box {
            if (hasVideo) {
                LiveKitVideoView(
                    track = participant.videoTrack,
                    modifier = Modifier.fillMaxSize(),
                    mirror = participant.isLocal
                )
            } else {
                ParticipantPlaceholder(participant)
            }
            ParticipantInfoOverlay(
                participant = participant,
                modifier = Modifier.align(Alignment.BottomStart)
            )
            ParticipantMuteIndicator(
                participant = participant,
                modifier = Modifier
                    .align(Alignment.TopEnd)
                    .padding(12.dp)
            )
        }
    }
}

@Composable
private fun ParticipantPlaceholder(participant: CallParticipantUi) {
    Column(
        modifier = Modifier.fillMaxSize(),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Avatar(
            name = participant.displayName,
            imageUrl = participant.avatarUrl,
            size = 72.dp
        )
        Spacer(modifier = Modifier.height(12.dp))
        Text(
            text = participant.displayName,
            color = Color.White,
            style = MaterialTheme.typography.bodyMedium,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis
        )
    }
}

@Composable
private fun ParticipantInfoOverlay(
    participant: CallParticipantUi,
    modifier: Modifier = Modifier,
) {
    val label = if (participant.isLocal) "${participant.displayName} (Вы)" else participant.displayName
    val hasVideo = participant.videoTrack != null
    Box(
        modifier = modifier
            .fillMaxWidth()
            .background(
                Brush.verticalGradient(
                    colors = listOf(Color.Transparent, Color(0xCC04070C))
                )
            )
            .padding(horizontal = 16.dp, vertical = 12.dp)
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                text = label,
                color = Color.White,
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )
            Text(
                text = when {
                    hasVideo && participant.isSpeaking -> "Говорит"
                    hasVideo -> "В эфире"
                    else -> "Видео выключено"
                },
                color = Color.White.copy(alpha = 0.8f),
                style = MaterialTheme.typography.bodySmall
            )
        }
    }
}

@Composable
private fun ParticipantMuteIndicator(
    participant: CallParticipantUi,
    modifier: Modifier = Modifier,
) {
    val (icon, bgColor, tint) = if (participant.isMuted) {
        Triple(Icons.Default.MicOff, Color(0xFF3B1F21), Color(0xFFFF6B6B))
    } else {
        Triple(Icons.Default.Mic, Color(0xFF1B3526), Color(0xFF4ADE80))
    }
    Box(
        modifier = modifier
            .size(38.dp)
            .clip(CircleShape)
            .background(bgColor),
        contentAlignment = Alignment.Center
    ) {
        Icon(imageVector = icon, contentDescription = null, tint = tint)
    }
}

@Composable
private fun CallControlsBar(
    isAudioEnabled: Boolean,
    isVideoEnabled: Boolean,
    onToggleAudio: () -> Unit,
    onToggleVideo: () -> Unit,
    onHangUp: () -> Unit,
) {
    val spacing = LocalSpacing.current
    Surface(
        shape = RoundedCornerShape(32.dp),
        color = Color(0xFF151C27),
        tonalElevation = 4.dp,
        modifier = Modifier.fillMaxWidth()
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 24.dp, vertical = 16.dp),
            horizontalArrangement = Arrangement.spacedBy(spacing.lg, Alignment.CenterHorizontally),
            verticalAlignment = Alignment.CenterVertically
        ) {
            CallControlButton(
                onClick = onToggleAudio,
                icon = if (isAudioEnabled) Icons.Default.Mic else Icons.Default.MicOff,
                label = if (isAudioEnabled) "Микрофон включён" else "Микрофон выключен",
                containerColor = if (isAudioEnabled) Color(0xFF1F513B) else Color(0xFF3B1F21),
                contentColor = if (isAudioEnabled) Color.White else Color(0xFFFF8585)
            )
            CallControlButton(
                onClick = onToggleVideo,
                icon = if (isVideoEnabled) Icons.Default.Videocam else Icons.Default.VideocamOff,
                label = if (isVideoEnabled) "Камера включена" else "Камера выключена",
                containerColor = if (isVideoEnabled) Color(0xFF1C3453) else Color(0xFF41212F),
                contentColor = if (isVideoEnabled) Color.White else Color(0xFFFF8FAB)
            )
            CallControlButton(
                onClick = onHangUp,
                icon = Icons.Default.CallEnd,
                label = "Завершить",
                containerColor = Color(0xFFE11D48),
                contentColor = Color.White
            )
        }
    }
}

@Composable
private fun CallControlButton(
    onClick: () -> Unit,
    icon: ImageVector,
    label: String,
    containerColor: Color,
    contentColor: Color,
) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Button(
            onClick = onClick,
            shape = CircleShape,
            modifier = Modifier.size(68.dp),
            colors = ButtonDefaults.buttonColors(containerColor = containerColor),
            contentPadding = PaddingValues(0.dp)
        ) {
            Icon(
                imageVector = icon,
                contentDescription = label,
                tint = contentColor,
                modifier = Modifier.size(32.dp)
            )
        }
        Spacer(modifier = Modifier.height(8.dp))
        Text(
            text = label,
            color = Color.White.copy(alpha = 0.9f),
            style = MaterialTheme.typography.labelMedium,
            textAlign = TextAlign.Center,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis
        )
    }
}

