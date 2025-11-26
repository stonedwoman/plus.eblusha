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
import androidx.compose.material.icons.filled.Videocam
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import org.eblusha.plus.ui.components.Avatar
import org.eblusha.plus.ui.theme.LocalSpacing

@Composable
fun IncomingCallScreen(
    call: org.eblusha.plus.data.realtime.RealtimeEvent.CallIncoming,
    avatarUrl: String?,
    onAcceptAudio: () -> Unit,
    onAcceptVideo: () -> Unit,
    onDecline: () -> Unit,
    onDismiss: () -> Unit,
) {
    val spacing = LocalSpacing.current
    Surface(
        modifier = Modifier.fillMaxSize(),
        color = Color.Black
    ) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(spacing.xl),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.SpaceBetween
        ) {
            Spacer(modifier = Modifier.weight(1f))
            
            // Caller info
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(spacing.md)
            ) {
                Avatar(
                    name = call.fromName,
                    imageUrl = avatarUrl,
                    size = 160.dp
                )
                Text(
                    text = call.fromName,
                    style = MaterialTheme.typography.headlineMedium,
                    color = Color.White,
                    textAlign = TextAlign.Center
                )
                Text(
                    text = if (call.video) "Входящий видеозвонок" else "Входящий звонок",
                    style = MaterialTheme.typography.bodyLarge,
                    color = Color.White.copy(alpha = 0.7f),
                    textAlign = TextAlign.Center
                )
            }
            
            Spacer(modifier = Modifier.weight(1f))
            
            // Action buttons
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = spacing.lg),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                IncomingCallActionButton(
                    icon = Icons.Default.CallEnd,
                    label = "Отбой",
                    containerColor = MaterialTheme.colorScheme.error,
                    iconTint = Color.White,
                    size = 68.dp,
                    onClick = onDecline
                )
                IncomingCallActionButton(
                    icon = Icons.Default.Call,
                    label = "Принять",
                    containerColor = Color(0xFF0F9D58),
                    iconTint = Color.White,
                    size = 80.dp,
                    onClick = onAcceptAudio
                )
                IncomingCallActionButton(
                    icon = Icons.Default.Videocam,
                    label = "С видео",
                    containerColor = Color(0xFF1A73E8),
                    iconTint = Color.White,
                    size = 80.dp,
                    onClick = onAcceptVideo
                )
            }
            
            Spacer(modifier = Modifier.height(spacing.xl))
        }
    }
}

@Composable
private fun IncomingCallActionButton(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    label: String,
    containerColor: Color,
    iconTint: Color,
    size: androidx.compose.ui.unit.Dp,
    onClick: () -> Unit,
) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Button(
            onClick = onClick,
            shape = CircleShape,
            modifier = Modifier.size(size),
            colors = ButtonDefaults.buttonColors(containerColor = containerColor),
            contentPadding = PaddingValues(0.dp)
        ) {
            Icon(
                imageVector = icon,
                contentDescription = label,
                modifier = Modifier.size(size * 0.45f),
                tint = iconTint
            )
        }
        Spacer(modifier = Modifier.height(8.dp))
        Text(
            text = label,
            style = MaterialTheme.typography.labelLarge,
            color = Color.White,
            textAlign = TextAlign.Center
        )
    }
}

