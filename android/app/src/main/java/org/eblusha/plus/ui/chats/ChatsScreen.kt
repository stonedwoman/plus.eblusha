package org.eblusha.plus.ui.chats

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Divider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import org.eblusha.plus.core.di.AppContainer
import org.eblusha.plus.feature.chats.ChatsUiState
import org.eblusha.plus.feature.chats.ChatsViewModel
import org.eblusha.plus.feature.chats.ChatsViewModelFactory
import org.eblusha.plus.feature.chats.ConversationPreview
import org.eblusha.plus.feature.session.SessionUser
import org.eblusha.plus.ui.components.Avatar
import org.eblusha.plus.ui.components.UnreadBadge
import org.eblusha.plus.ui.theme.LocalSpacing

@Composable
fun ChatsRoute(
    container: AppContainer,
    currentUser: SessionUser,
    onLogout: () -> Unit,
) {
    val viewModel: ChatsViewModel = viewModel(factory = ChatsViewModelFactory(container))
    val uiState by viewModel.uiState.collectAsStateWithLifecycle()

    androidx.compose.runtime.LaunchedEffect(currentUser.id) {
        viewModel.onUserAvailable(currentUser)
    }

    ChatsScreen(
        state = uiState,
        user = currentUser,
        onRefresh = viewModel::refresh,
        onLogout = onLogout,
    )
}

@Composable
fun ChatsScreen(
    state: ChatsUiState,
    user: SessionUser,
    onRefresh: () -> Unit,
    onLogout: () -> Unit,
) {
    val spacing = LocalSpacing.current
    Surface(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background),
    ) {
        Column(modifier = Modifier.fillMaxSize().padding(spacing.lg)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Avatar(
                    name = user.displayName ?: user.username,
                    imageUrl = user.avatarUrl,
                    size = 56.dp
                )
                Spacer(modifier = Modifier.width(spacing.md))
                Column(modifier = Modifier.weight(1f)) {
                    Text(text = user.displayName ?: user.username, style = MaterialTheme.typography.titleLarge)
                    user.eblid?.let { Text(text = "EBLID: $it", style = MaterialTheme.typography.labelMedium) }
                }
                TextButton(onClick = onLogout) {
                    Text("Выйти")
                }
            }

            Spacer(modifier = Modifier.height(spacing.md))
            OutlinedTextField(
                value = "",
                onValueChange = {},
                modifier = Modifier.fillMaxWidth(),
                placeholder = { Text("Поиск или начало нового чата") },
                leadingIcon = { androidx.compose.material3.Icon(Icons.Default.Search, contentDescription = null) },
                singleLine = true,
                enabled = false
            )

            Spacer(modifier = Modifier.height(spacing.md))
            Button(onClick = onRefresh, modifier = Modifier.fillMaxWidth()) {
                Text("Обновить беседы")
            }
            Spacer(modifier = Modifier.height(spacing.md))
            Divider()
            Spacer(modifier = Modifier.height(spacing.md))

            when (state) {
                ChatsUiState.Loading -> Text(
                    text = "Загружаем чаты…",
                    style = MaterialTheme.typography.bodyLarge,
                    modifier = Modifier.padding(top = spacing.xl)
                )
                is ChatsUiState.Error -> ErrorState(message = state.message, onRetry = onRefresh)
                is ChatsUiState.Success -> ConversationsList(conversations = state.items)
            }
        }
    }
}

@Composable
private fun ErrorState(message: String, onRetry: () -> Unit) {
    Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.fillMaxWidth()) {
        Text(text = "Ошибка", color = MaterialTheme.colorScheme.error, fontWeight = FontWeight.Bold)
        Text(text = message, modifier = Modifier.padding(top = 8.dp), textAlign = TextAlign.Center)
        TextButton(onClick = onRetry, modifier = Modifier.padding(top = 8.dp)) {
            Text("Повторить")
        }
    }
}

@Composable
private fun ConversationsList(conversations: List<ConversationPreview>) {
    val spacing = LocalSpacing.current
    if (conversations.isEmpty()) {
        Text(
            text = "Чатов пока нет — начните новый диалог с десктопа.",
            style = MaterialTheme.typography.bodyLarge,
            modifier = Modifier.padding(top = spacing.xl)
        )
        return
    }
    LazyColumn(modifier = Modifier.fillMaxSize()) {
        items(conversations) { conversation ->
            ConversationItem(conversation)
            Spacer(modifier = Modifier.height(spacing.md))
        }
    }
}

@Composable
private fun ConversationItem(item: ConversationPreview) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors()
    ) {
        Row(
            modifier = Modifier.padding(16.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Avatar(
                name = item.title,
                imageUrl = item.avatarUrl,
                size = 48.dp
            )
            Spacer(modifier = Modifier.width(12.dp))
            Column(modifier = Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        text = item.title,
                        style = MaterialTheme.typography.titleMedium,
                        modifier = Modifier.weight(1f)
                    )
                    item.lastMessageTime?.let {
                        Text(text = it, style = MaterialTheme.typography.labelSmall)
                    }
                }
                Spacer(modifier = Modifier.height(4.dp))
                Text(
                    text = item.subtitle,
                    style = MaterialTheme.typography.bodyMedium,
                    maxLines = 2
                )
            }
            Spacer(modifier = Modifier.width(12.dp))
            UnreadBadge(count = item.unreadCount)
        }
    }
}

