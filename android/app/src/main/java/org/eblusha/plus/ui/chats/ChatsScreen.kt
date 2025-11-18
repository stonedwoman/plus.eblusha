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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Divider
import androidx.compose.material3.MaterialTheme
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
    Surface(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background),
    ) {
        Column(modifier = Modifier.fillMaxSize().padding(16.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Column {
                    Text(text = user.displayName ?: user.username, style = MaterialTheme.typography.headlineSmall)
                    user.eblid?.let { Text(text = "EBLID: $it", style = MaterialTheme.typography.bodySmall) }
                }
                TextButton(onClick = onLogout) {
                    Text("Выйти")
                }
            }

            Spacer(modifier = Modifier.height(12.dp))
            Button(onClick = onRefresh, modifier = Modifier.fillMaxWidth()) {
                Text("Обновить беседы")
            }
            Spacer(modifier = Modifier.height(12.dp))
            Divider()
            Spacer(modifier = Modifier.height(12.dp))

            when (state) {
                ChatsUiState.Loading -> Text(
                    text = "Загружаем чаты…",
                    style = MaterialTheme.typography.bodyLarge,
                    modifier = Modifier.padding(top = 24.dp)
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
    if (conversations.isEmpty()) {
        Text(
            text = "Чатов пока нет — начните новый диалог с десктопа.",
            style = MaterialTheme.typography.bodyLarge,
            modifier = Modifier.padding(top = 24.dp)
        )
        return
    }
    LazyColumn(modifier = Modifier.fillMaxSize()) {
        items(conversations) { conversation ->
            ConversationItem(conversation)
            Spacer(modifier = Modifier.height(8.dp))
        }
    }
}

@Composable
private fun ConversationItem(item: ConversationPreview) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors()
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = item.title,
                    style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier.weight(1f)
                )
                if (item.unreadCount > 0) {
                    Text(
                        text = item.unreadCount.toString(),
                        color = MaterialTheme.colorScheme.primary,
                        style = MaterialTheme.typography.labelMedium,
                        modifier = Modifier
                            .background(
                                MaterialTheme.colorScheme.primary.copy(alpha = 0.1f),
                                shape = MaterialTheme.shapes.small
                            )
                            .padding(horizontal = 8.dp, vertical = 2.dp)
                    )
                }
            }
            Spacer(modifier = Modifier.height(4.dp))
            Text(
                text = item.subtitle,
                style = MaterialTheme.typography.bodyMedium,
                maxLines = 2
            )
        }
    }
}

