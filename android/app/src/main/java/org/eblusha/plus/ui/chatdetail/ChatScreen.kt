package org.eblusha.plus.ui.chatdetail

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
import androidx.compose.material.icons.filled.Send
import androidx.compose.material.icons.filled.Videocam
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import org.eblusha.plus.core.di.AppContainer
import org.eblusha.plus.feature.chatdetail.ChatMessage
import org.eblusha.plus.feature.chatdetail.ChatUiState
import org.eblusha.plus.feature.chatdetail.ChatViewModel
import org.eblusha.plus.feature.chatdetail.ChatViewModelFactory
import org.eblusha.plus.feature.chats.ConversationPreview
import org.eblusha.plus.feature.session.SessionUser
import org.eblusha.plus.ui.components.Avatar
import org.eblusha.plus.ui.theme.LocalSpacing

@Composable
fun ChatRoute(
    container: AppContainer,
    conversationId: String,
    currentUser: SessionUser,
    conversation: ConversationPreview?,
    onBack: () -> Unit,
) {
    val viewModel: ChatViewModel = viewModel(
        factory = ChatViewModelFactory(container, conversationId, currentUser)
    )
    val state by viewModel.state.collectAsStateWithLifecycle()

    ChatScreen(
        state = state,
        conversation = conversation,
        onBack = onBack,
        onRetry = viewModel::refresh,
        onSend = viewModel::sendMessage,
    )
}

@Composable
private fun ChatScreen(
    state: ChatUiState,
    conversation: ConversationPreview?,
    onBack: () -> Unit,
    onRetry: () -> Unit,
    onSend: (String) -> Unit,
) {
    val spacing = LocalSpacing.current
    Surface(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background)
    ) {
        Column(modifier = Modifier.fillMaxSize().padding(spacing.lg)) {
            ChatHeader(conversation = conversation, onBack = onBack)
            Spacer(modifier = Modifier.height(spacing.md))
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
                    Surface(
                        modifier = Modifier
                            .weight(1f)
                            .fillMaxWidth(),
                        shape = RoundedCornerShape(24.dp),
                        color = MaterialTheme.colorScheme.surfaceVariant,
                        tonalElevation = 2.dp,
                        shadowElevation = 6.dp
                    ) {
                        MessageList(
                            messages = state.messages,
                            modifier = Modifier
                                .fillMaxSize()
                                .padding(spacing.md)
                        )
                    }
                    Spacer(modifier = Modifier.height(spacing.md))
                    Composer(onSend)
                }
            }
        }
    }
}

@Composable
private fun ChatHeader(conversation: ConversationPreview?, onBack: () -> Unit) {
    val spacing = LocalSpacing.current
    Column {
        Row(verticalAlignment = Alignment.CenterVertically) {
            IconButton(
                onClick = onBack,
                modifier = Modifier
                    .size(44.dp)
                    .clip(CircleShape)
                    .background(MaterialTheme.colorScheme.surfaceVariant)
            ) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Назад")
            }
            Spacer(modifier = Modifier.width(spacing.md))
            Avatar(
                name = conversation?.title ?: "Чат",
                imageUrl = conversation?.avatarUrl,
                size = 56.dp
            )
            Spacer(modifier = Modifier.width(spacing.md))
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = conversation?.title ?: "Чат",
                    style = MaterialTheme.typography.titleLarge,
                    fontWeight = FontWeight.SemiBold
                )
                Text(
                    text = conversation?.presenceText ?: "сообщения синхронизируются с вебом",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }
        Spacer(modifier = Modifier.height(spacing.md))
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(spacing.sm),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Surface(
                shape = RoundedCornerShape(24.dp),
                color = MaterialTheme.colorScheme.surfaceVariant
            ) {
                Text(
                    text = "Секретный чат",
                    modifier = Modifier.padding(horizontal = spacing.md, vertical = spacing.sm),
                    style = MaterialTheme.typography.bodySmall
                )
            }
            Spacer(modifier = Modifier.weight(1f))
            TextButton(onClick = {}, shape = RoundedCornerShape(20.dp)) {
                Icon(Icons.Default.Call, contentDescription = null)
                Spacer(modifier = Modifier.width(4.dp))
                Text("Звонок")
            }
            Button(
                onClick = {},
                shape = RoundedCornerShape(20.dp),
                colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.secondary)
            ) {
                Icon(Icons.Default.Videocam, contentDescription = null)
                Spacer(modifier = Modifier.width(4.dp))
                Text("Видео")
            }
        }
    }
}

@Composable
private fun MessageList(messages: List<ChatMessage>, modifier: Modifier = Modifier) {
    val spacing = LocalSpacing.current
    LazyColumn(
        modifier = modifier.fillMaxWidth(),
        reverseLayout = true,
        verticalArrangement = Arrangement.spacedBy(spacing.sm),
        contentPadding = PaddingValues(vertical = spacing.sm)
    ) {
        items(messages, key = { it.id }) { message ->
            MessageBubble(message)
        }
    }
}

@Composable
private fun MessageBubble(message: ChatMessage) {
    val spacing = LocalSpacing.current
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = if (message.isMine) Arrangement.End else Arrangement.Start,
        verticalAlignment = Alignment.Top
    ) {
        if (!message.isMine) {
            Avatar(name = message.senderName ?: "?", imageUrl = message.senderAvatar, size = 32.dp)
            Spacer(modifier = Modifier.width(spacing.sm))
        }
        val bubbleShape = if (message.isMine) {
            RoundedCornerShape(topStart = 20.dp, topEnd = 4.dp, bottomEnd = 20.dp, bottomStart = 20.dp)
        } else {
            RoundedCornerShape(topStart = 4.dp, topEnd = 20.dp, bottomEnd = 20.dp, bottomStart = 20.dp)
        }
        Column(
            modifier = Modifier
                .background(
                    if (message.isMine) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surfaceVariant,
                    bubbleShape
                )
                .padding(spacing.md)
                .widthIn(max = 280.dp)
        ) {
            message.senderName?.let {
                if (!message.isMine) {
                    Text(it, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Bold)
                    Spacer(modifier = Modifier.height(2.dp))
                }
            }
            Text(
                message.content ?: "[${message.type.lowercase()}]",
                color = if (message.isMine) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurface
            )
            message.createdAt?.let {
                Spacer(modifier = Modifier.height(4.dp))
                Text(
                    it,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.outline,
                    modifier = Modifier.align(Alignment.End)
                )
            }
        }
    }
}

@Composable
private fun Composer(onSend: (String) -> Unit) {
    var text by remember { mutableStateOf("") }
    val spacing = LocalSpacing.current
    val sendEnabled = text.isNotBlank()
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.surface, RoundedCornerShape(32.dp))
            .padding(horizontal = spacing.md, vertical = spacing.sm),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(spacing.sm)
    ) {
        IconButton(
            onClick = { /* TODO attachments */ },
            modifier = Modifier
                .size(40.dp)
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
                focusedBorderColor = MaterialTheme.colorScheme.primary.copy(alpha = 0.5f),
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

