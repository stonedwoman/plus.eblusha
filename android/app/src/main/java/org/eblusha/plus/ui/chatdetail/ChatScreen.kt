package org.eblusha.plus.ui.chatdetail

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import org.eblusha.plus.core.di.AppContainer
import org.eblusha.plus.feature.chatdetail.ChatMessage
import org.eblusha.plus.feature.chatdetail.ChatUiState
import org.eblusha.plus.feature.chatdetail.ChatViewModel
import org.eblusha.plus.feature.chatdetail.ChatViewModelFactory
import org.eblusha.plus.feature.session.SessionUser
import org.eblusha.plus.ui.components.Avatar
import org.eblusha.plus.ui.theme.LocalSpacing

@Composable
fun ChatRoute(
    container: AppContainer,
    conversationId: String,
    currentUser: SessionUser,
    onBack: () -> Unit,
) {
    val viewModel: ChatViewModel = viewModel(
        factory = ChatViewModelFactory(container, conversationId, currentUser)
    )
    val state by viewModel.state.collectAsStateWithLifecycle()

    ChatScreen(
        state = state,
        onBack = onBack,
        onRetry = viewModel::refresh,
        onSend = viewModel::sendMessage,
    )
}

@Composable
private fun ChatScreen(
    state: ChatUiState,
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
            TopBar(onBack = onBack)
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
                    MessageList(messages = state.messages)
                    Composer(onSend)
                }
            }
        }
    }
}

@Composable
private fun TopBar(onBack: () -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Icon(
            imageVector = Icons.Default.ArrowBack,
            contentDescription = "Назад",
            modifier = Modifier
                .padding(end = 12.dp)
                .width(32.dp)
                .height(32.dp)
                .background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(10.dp))
                .padding(4.dp)
                .clickable { onBack() }
        )
        Column {
            Text("Чат", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
            Text("Сообщения синхронизируются с вебом", style = MaterialTheme.typography.bodySmall)
        }
    }
}

@Composable
private fun MessageList(messages: List<ChatMessage>) {
    LazyColumn(
        modifier = Modifier
            .weight(1f)
            .fillMaxWidth(),
        reverseLayout = true
    ) {
        items(messages, key = { it.id }) { message ->
            MessageBubble(message)
            Spacer(modifier = Modifier.height(8.dp))
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
        Column(
            modifier = Modifier
                .background(
                    if (message.isMine) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surfaceVariant,
                    RoundedCornerShape(20.dp)
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
                Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.outline)
            }
        }
        if (message.isMine) {
            Spacer(modifier = Modifier.width(spacing.sm))
            Avatar(name = "Я", imageUrl = null, size = 32.dp)
        }
    }
}

@Composable
private fun Composer(onSend: (String) -> Unit) {
    var text by remember { mutableStateOf("") }
    val spacing = LocalSpacing.current
    Column {
        OutlinedTextField(
            value = text,
            onValueChange = { text = it },
            modifier = Modifier.fillMaxWidth(),
            placeholder = { Text("Сообщение...") }
        )
        Spacer(modifier = Modifier.height(spacing.sm))
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.End
        ) {
            Button(
                onClick = {
                    onSend(text)
                    text = ""
                },
                enabled = text.isNotBlank(),
                colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.primary)
            ) {
                Text("Отпр.")
            }
        }
    }
}

