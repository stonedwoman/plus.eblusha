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
import androidx.compose.material.icons.filled.ExpandMore
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
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
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
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.compose.ui.zIndex
import org.eblusha.plus.ActiveCallSession
import org.eblusha.plus.CallOverlayHandle
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
fun CallOverlayHost(
    container: AppContainer,
    currentUser: SessionUser,
    session: ActiveCallSession,
    isVisible: Boolean,
    onRequestMinimize: () -> Unit,
    onHandleReady: (CallOverlayHandle?) -> Unit,
    onClose: () -> Unit,
) {
    val context = LocalContext.current
    val appContext = context.applicationContext
    android.util.Log.d("CallOverlay", "Session=${session.conversationId}, video=${session.isVideo}, group=${session.isGroup}")
    val viewModel: CallViewModel = viewModel(
        key = "call-${session.conversationId}",
        factory = CallViewModelFactory(
            context = appContext,
            container = container,
            conversationId = session.conversationId,
            currentUser = currentUser,
            isVideoCall = session.isVideo,
            isGroup = session.isGroup,
        )
    )
    val state by viewModel.uiState.collectAsStateWithLifecycle()
    var hasLeftIdle by remember(session.conversationId) { mutableStateOf(false) }

    DisposableEffect(viewModel) {
        val handle = CallOverlayHandle {
            viewModel.hangUp()
        }
        onHandleReady(handle)
        onDispose {
            onHandleReady(null)
        }
    }

    LaunchedEffect(state) {
        if (state !is CallUiState.Idle) {
            hasLeftIdle = true
        }
        if (hasLeftIdle && state is CallUiState.Idle) {
            onClose()
        }
    }

    if (isVisible) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .zIndex(1f)
        ) {
            CallScreen(
                state = state,
                onHangUp = {
                    viewModel.hangUp()
                },
                onToggleVideo = viewModel::toggleVideo,
                onToggleAudio = viewModel::toggleAudio,
                onMinimize = onRequestMinimize,
            )
        }
    }
}

@Composable
private fun CallScreen(
    state: CallUiState,
    onHangUp: () -> Unit,
    onToggleVideo: () -> Unit,
    onToggleAudio: () -> Unit,
    onMinimize: () -> Unit,
) {
    val spacing = LocalSpacing.current
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(
                Brush.verticalGradient(
                    colors = listOf(
                        Color(0xCC0A0C10),
                        Color(0xF00A0C10)
                    )
                )
            )
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
                    onMinimize = onMinimize,
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
    onMinimize: () -> Unit,
) {
    val spacing = LocalSpacing.current
    val remoteParticipants = state.participants.filterNot { it.isLocal }
    val localParticipant = state.participants.firstOrNull { it.isLocal }
    val configuration = LocalConfiguration.current
    val isCompact = configuration.screenWidthDp < 720

    Surface(
        modifier = Modifier
            .fillMaxSize()
            .padding(if (isCompact) 0.dp else 16.dp),
        color = Color.Transparent
    ) {
        Surface(
            modifier = Modifier
                .fillMaxSize()
                .padding(if (isCompact) 0.dp else 16.dp),
            shape = if (isCompact) RoundedCornerShape(0.dp) else RoundedCornerShape(32.dp),
            color = Color(0xFF0F141F),
            tonalElevation = 6.dp,
            shadowElevation = if (isCompact) 0.dp else 12.dp
        ) {
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(24.dp),
                verticalArrangement = Arrangement.spacedBy(spacing.lg)
            ) {
                CallHeader(state.participants)
                Box(
                    modifier = Modifier
                        .weight(1f)
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(32.dp))
                        .background(Color(0xFF050A12))
                ) {
                    if (remoteParticipants.isEmpty()) {
                        Box(
                            modifier = Modifier.fillMaxSize(),
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
                        CallParticipantsGrid(
                            participants = remoteParticipants,
                            modifier = Modifier
                                .fillMaxSize()
                                .padding(16.dp)
                        )
                    }
                    localParticipant?.let {
                        LocalParticipantPreview(
                            participant = it,
                            modifier = Modifier
                                .align(Alignment.TopEnd)
                                .padding(16.dp)
                        )
                    }
                }
                CallControlsBar(
                    isAudioEnabled = state.isAudioEnabled,
                    isVideoEnabled = state.isVideoEnabled,
                    onToggleAudio = onToggleAudio,
                    onToggleVideo = onToggleVideo,
                    onHangUp = onHangUp,
                    onMinimize = onMinimize,
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
private fun LocalParticipantPreview(
    participant: CallParticipantUi,
    modifier: Modifier = Modifier,
) {
    Surface(
        modifier = modifier
            .width(140.dp)
            .height(210.dp),
        shape = RoundedCornerShape(24.dp),
        color = Color(0xFF0A101A),
        shadowElevation = 8.dp,
        border = BorderStroke(1.dp, Color.White.copy(alpha = 0.2f))
    ) {
        if (participant.videoTrack != null) {
            LiveKitVideoView(
                track = participant.videoTrack,
                modifier = Modifier.fillMaxSize(),
                mirror = true
            )
        } else {
            ParticipantPlaceholder(participant)
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
    onMinimize: () -> Unit,
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
                onClick = onMinimize,
                icon = Icons.Default.ExpandMore,
                label = "Свернуть",
                containerColor = Color(0xFF1C1F2A),
                contentColor = Color.White
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

