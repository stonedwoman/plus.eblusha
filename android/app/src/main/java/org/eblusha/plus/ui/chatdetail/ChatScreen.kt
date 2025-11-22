package org.eblusha.plus.ui.chatdetail

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.AttachFile
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.CallEnd
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.Send
import androidx.compose.material.icons.filled.Videocam
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Snackbar
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import kotlinx.coroutines.flow.collectLatest
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import org.eblusha.plus.ActiveCallSession
import org.eblusha.plus.core.di.AppContainer
import org.eblusha.plus.feature.chatdetail.ChatMessage
import org.eblusha.plus.feature.chatdetail.ChatUiState
import org.eblusha.plus.feature.chatdetail.ChatViewModel
import org.eblusha.plus.feature.chatdetail.ChatViewModelFactory
import org.eblusha.plus.feature.chats.ConversationPreview
import org.eblusha.plus.feature.session.SessionUser
import org.eblusha.plus.ui.components.Avatar
import org.eblusha.plus.ui.theme.LocalSpacing
import org.eblusha.plus.ui.theme.Spacing

@Composable
fun ChatRoute(
    container: AppContainer,
    conversationId: String,
    currentUser: SessionUser,
    conversation: ConversationPreview?,
    activeCall: ActiveCallSession?,
    isCallMinimized: Boolean,
    onMinimizeChange: (Boolean) -> Unit,
    onHangUp: () -> Unit,
    onBack: () -> Unit,
    onCallClick: (Boolean) -> Unit,
) {
    android.util.Log.d("ChatRoute", "Rendering ChatRoute for conversationId=$conversationId")
    val viewModel: ChatViewModel = viewModel(
        factory = ChatViewModelFactory(container, conversationId, currentUser)
    )
    val state by viewModel.state.collectAsStateWithLifecycle()
    val snackbarHostState = remember { SnackbarHostState() }
    
    androidx.compose.runtime.LaunchedEffect(state) {
        android.util.Log.d("ChatRoute", "ChatUiState changed: ${state::class.simpleName}")
    }
    
    LaunchedEffect(Unit) {
        viewModel.sendError.collectLatest { errorMessage ->
            snackbarHostState.showSnackbar(errorMessage)
        }
    }
    
    // Log conversation secret status
    androidx.compose.runtime.LaunchedEffect(conversation) {
        if (conversation != null) {
            android.util.Log.d("ChatRoute", "Conversation secret status: isSecret=${conversation.isSecret}, secretStatus=${conversation.secretStatus}")
        }
    }

    ChatScreen(
        state = state,
        conversation = conversation,
        activeCall = activeCall,
        isCallMinimized = isCallMinimized,
        onMinimizeChange = onMinimizeChange,
        onHangUp = onHangUp,
        onBack = onBack,
        onRetry = viewModel::refresh,
        onSend = { content -> viewModel.sendMessage(content, isSecret = conversation?.isSecret == true) },
        onCallClick = onCallClick,
        snackbarHostState = snackbarHostState,
    )
}

@Composable
private fun ChatScreen(
    state: ChatUiState,
    conversation: ConversationPreview?,
    activeCall: ActiveCallSession?,
    isCallMinimized: Boolean,
    onMinimizeChange: (Boolean) -> Unit,
    onHangUp: () -> Unit,
    onBack: () -> Unit,
    onRetry: () -> Unit,
    onSend: (String) -> Unit,
    onCallClick: (Boolean) -> Unit,
    snackbarHostState: SnackbarHostState,
) {
    val spacing = LocalSpacing.current
    android.util.Log.d("ChatScreen", "Rendering ChatScreen, state=${state::class.simpleName}")
    Surface(
        modifier = Modifier.fillMaxSize(),
        color = MaterialTheme.colorScheme.background
    ) {
        Box(modifier = Modifier.fillMaxSize()) {
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(horizontal = 4.dp, vertical = 2.dp)
            ) {
                    ChatHeader(
                        conversation = conversation,
                        activeCall = activeCall,
                        isCallMinimized = isCallMinimized,
                        onBack = onBack,
                        onCallClick = onCallClick,
                        onMinimizeChange = onMinimizeChange,
                        onHangUp = onHangUp,
                    )
                    Spacer(modifier = Modifier.height(4.dp))
                    when (state) {
                        ChatUiState.Loading -> Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                            Text("Загружаем переписку…")
                        }
                        is ChatUiState.Error -> Column(
                            modifier = Modifier.fillMaxSize(),
                            verticalArrangement = Arrangement.Center,
                            horizontalAlignment = Alignment.CenterHorizontally
                        ) {
                            Text(text = state.message, color = MaterialTheme.colorScheme.error)
                            Spacer(Modifier.height(spacing.md))
                            Button(onClick = onRetry) { Text("Повторить") }
                        }
                        is ChatUiState.Loaded -> {
                            MessageList(
                                messages = state.messages,
                                modifier = Modifier
                                    .weight(1f)
                                    .fillMaxWidth()
                            )
                            Spacer(modifier = Modifier.height(4.dp))
                            Composer(onSend)
                        }
                    }
            }
            SnackbarHost(
                hostState = snackbarHostState,
                modifier = Modifier.align(Alignment.BottomCenter)
            )
        }
    }
}

@Composable
private fun ChatHeader(
    conversation: ConversationPreview?,
    activeCall: ActiveCallSession?,
    isCallMinimized: Boolean,
    onBack: () -> Unit,
    onCallClick: (Boolean) -> Unit,
    onMinimizeChange: (Boolean) -> Unit,
    onHangUp: () -> Unit,
) {
    val spacing = LocalSpacing.current
    val shape = RoundedCornerShape(26.dp)
    val statusText = conversation?.presenceText ?: "Сообщения синхронизируются с вебом"
    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = shape,
        color = MaterialTheme.colorScheme.surface,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
        tonalElevation = 2.dp
    ) {
        Column(modifier = Modifier.padding(horizontal = 8.dp, vertical = 6.dp)) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                IconButton(
                    onClick = onBack,
                    modifier = Modifier
                        .size(46.dp)
                        .clip(CircleShape)
                        .background(MaterialTheme.colorScheme.surfaceVariant)
                ) {
                    Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Назад")
                }
                Avatar(
                    name = conversation?.title ?: "Чат",
                    imageUrl = conversation?.avatarUrl,
                    size = 60.dp
                )
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = conversation?.title ?: "Чат",
                        style = MaterialTheme.typography.titleLarge,
                        fontWeight = FontWeight.SemiBold
                    )
                    Text(
                        text = statusText,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
            Spacer(modifier = Modifier.height(4.dp))
            CallActionRow(
                isCurrentCall = activeCall?.conversationId == conversation?.id,
                activeCall = activeCall,
                isCallMinimized = isCallMinimized,
                onCallClick = onCallClick,
                onMinimizeChange = onMinimizeChange,
                onHangUp = onHangUp,
                spacing = spacing,
                isSecret = false // TODO: Add isSecret field to ConversationPreview
            )
        }
    }
}

@Composable
private fun CallActionRow(
    isCurrentCall: Boolean,
    activeCall: ActiveCallSession?,
    isCallMinimized: Boolean,
    onCallClick: (Boolean) -> Unit,
    onMinimizeChange: (Boolean) -> Unit,
    onHangUp: () -> Unit,
    spacing: Spacing,
    isSecret: Boolean = false,
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(spacing.sm)
    ) {
        if (isSecret) {
            Surface(
                shape = RoundedCornerShape(999.dp),
                color = MaterialTheme.colorScheme.surfaceVariant,
                tonalElevation = 1.dp
            ) {
                Text(
                    text = "Секретный чат",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = spacing.lg, vertical = spacing.sm)
                )
            }
            Spacer(modifier = Modifier.weight(1f))
        } else {
            Spacer(modifier = Modifier.weight(1f))
        }
        if (!isCurrentCall || activeCall == null) {
            OutlinedButton(
                onClick = { onCallClick(false) },
                shape = RoundedCornerShape(22.dp),
                border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
                colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.onSurface)
            ) {
                Icon(Icons.Default.Call, contentDescription = null)
                Spacer(modifier = Modifier.width(6.dp))
                Text("Позвонить")
            }
            Button(
                onClick = { onCallClick(true) },
                shape = RoundedCornerShape(22.dp),
                colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.primary)
            ) {
                Icon(Icons.Default.Videocam, contentDescription = null)
                Spacer(modifier = Modifier.width(6.dp))
                Text("Звонок с видео")
            }
        } else {
            if (isCallMinimized) {
                OutlinedButton(
                    onClick = { onMinimizeChange(false) },
                    shape = RoundedCornerShape(22.dp),
                    border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
                    colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.onSurface)
                ) {
                    Icon(Icons.Default.ExpandLess, contentDescription = null)
                    Spacer(modifier = Modifier.width(6.dp))
                    Text("Развернуть")
                }
            }
            Button(
                onClick = onHangUp,
                shape = RoundedCornerShape(22.dp),
                colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error)
            ) {
                Icon(Icons.Default.CallEnd, contentDescription = null)
                Spacer(modifier = Modifier.width(6.dp))
                Text("Сбросить")
            }
        }
    }
}

@Composable
private fun MessageList(messages: List<ChatMessage>, modifier: Modifier = Modifier) {
    LazyColumn(
        modifier = modifier.fillMaxWidth(),
        reverseLayout = true,
        verticalArrangement = Arrangement.spacedBy(2.dp),
        contentPadding = PaddingValues(vertical = 2.dp)
    ) {
        items(messages, key = { it.id }) { message ->
            MessageBubble(message)
        }
    }
}

@Composable
private fun MessageBubble(message: ChatMessage) {
    val isSystemMessage = message.type.uppercase() != "TEXT"
    
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 0.dp)
    ) {
        if (isSystemMessage) {
            // System messages (call logs, etc.) - simple text, no avatar, no sender name
            Column {
                Text(
                    text = message.content ?: "[${message.type.lowercase()}]",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurface
                )
                message.createdAt?.let {
                    Text(
                        it,
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(top = 2.dp)
                    )
                }
            }
        } else {
            // Regular text messages
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = if (message.isMine) Arrangement.End else Arrangement.Start,
                verticalAlignment = Alignment.Top
            ) {
                if (!message.isMine) {
                    Avatar(name = message.senderName ?: "?", imageUrl = message.senderAvatar, size = 28.dp)
                    Spacer(modifier = Modifier.width(6.dp))
                }
                Column(
                    modifier = Modifier.widthIn(max = 280.dp)
                ) {
                    message.senderName?.let {
                        if (!message.isMine) {
                            Text(
                                it,
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.padding(bottom = 2.dp)
                            )
                        }
                    }
                    Row(
                        verticalAlignment = Alignment.Bottom,
                        horizontalArrangement = Arrangement.spacedBy(6.dp)
                    ) {
                        Text(
                            text = message.content ?: "",
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurface
                        )
                        message.createdAt?.let {
                            Text(
                                it,
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun Composer(onSend: (String) -> Unit) {
    var text by remember { mutableStateOf("") }
    val spacing = LocalSpacing.current
    val sendEnabled = text.isNotBlank()
    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(40.dp),
        color = MaterialTheme.colorScheme.surface,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
        tonalElevation = 2.dp
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 4.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp)
        ) {
            IconButton(
                onClick = { /* TODO attachments */ },
                modifier = Modifier
                    .size(44.dp)
                    .clip(CircleShape)
                    .background(MaterialTheme.colorScheme.surfaceVariant)
            ) {
                Icon(Icons.Default.AttachFile, contentDescription = "Вложить")
            }
            OutlinedTextField(
                value = text,
                onValueChange = { text = it },
                modifier = Modifier.weight(1f),
                placeholder = { Text("Напишите сообщение...") },
                colors = OutlinedTextFieldDefaults.colors(
                    focusedContainerColor = Color.Transparent,
                    unfocusedContainerColor = Color.Transparent,
                    disabledContainerColor = Color.Transparent,
                    focusedBorderColor = MaterialTheme.colorScheme.primary.copy(alpha = 0.6f),
                    unfocusedBorderColor = MaterialTheme.colorScheme.surfaceVariant,
                    focusedTextColor = MaterialTheme.colorScheme.onSurface,
                    unfocusedTextColor = MaterialTheme.colorScheme.onSurface
                )
            )
            IconButton(
                onClick = {
                    onSend(text)
                    text = ""
                },
                enabled = sendEnabled,
                modifier = Modifier
                    .size(48.dp)
                    .clip(CircleShape)
                    .background(
                        if (sendEnabled) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surfaceVariant
                    )
            ) {
                Icon(
                    Icons.Default.Send,
                    contentDescription = "Отправить",
                    tint = if (sendEnabled) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }
    }
}

