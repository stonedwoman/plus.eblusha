package org.eblusha.plus.ui.chats

import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Divider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.graphics.vector.ImageVector
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
    onConversationClick: (ConversationPreview) -> Unit = {},
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
        onConversationClick = onConversationClick
    )
}

@Composable
fun ChatsScreen(
    state: ChatsUiState,
    user: SessionUser,
    onRefresh: () -> Unit,
    onLogout: () -> Unit,
    onConversationClick: (ConversationPreview) -> Unit,
) {
    val spacing = LocalSpacing.current
    Surface(
        modifier = Modifier
            .fillMaxSize()
            .background(
                Brush.verticalGradient(
                    colors = listOf(
                        MaterialTheme.colorScheme.background,
                        MaterialTheme.colorScheme.background.copy(alpha = 0.9f)
                    )
                )
            ),
        color = Color.Transparent
    ) {
        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = spacing.lg, vertical = spacing.lg),
            verticalArrangement = Arrangement.spacedBy(spacing.md)
        ) {
            item { BrandHeader(onLogout = onLogout) }
            item { SearchStub() }
            item { SectionDivider("Беседы") }
            when (state) {
                ChatsUiState.Loading -> item {
                    Text(
                        text = "Загружаем чаты…",
                        style = MaterialTheme.typography.bodyLarge,
                        modifier = Modifier.padding(top = spacing.md)
                    )
                }
                is ChatsUiState.Error -> item {
                    ErrorState(message = state.message, onRetry = onRefresh)
                }
                is ChatsUiState.Success -> {
                    if (state.items.isEmpty()) {
                        item {
                            Text(
                                text = "Чатов пока нет — начните новый диалог с десктопа.",
                                style = MaterialTheme.typography.bodyLarge,
                                modifier = Modifier.padding(top = spacing.xl)
                            )
                        }
                    } else {
                        items(state.items, key = { it.id }) { conversation ->
                            ConversationItem(conversation, onConversationClick)
                        }
                    }
                }
            }
            item { QuickActionsRow() }
            item { ProfileCard(user = user) }
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
private fun ConversationItem(
    item: ConversationPreview,
    onClick: (ConversationPreview) -> Unit
) {
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .clickable { onClick(item) },
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        shape = RoundedCornerShape(20.dp),
        elevation = CardDefaults.cardElevation(defaultElevation = 4.dp)
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box {
                    Avatar(
                        name = item.title,
                        imageUrl = item.avatarUrl,
                        size = 52.dp
                    )
                    if (item.isOnline) {
                        Box(
                            modifier = Modifier
                                .align(Alignment.BottomEnd)
                                .size(12.dp)
                                .clip(CircleShape)
                                .background(MaterialTheme.colorScheme.secondary)
                                .border(
                                    width = 2.dp,
                                    color = MaterialTheme.colorScheme.surface,
                                    shape = CircleShape
                                )
                        )
                    }
                }
                Spacer(modifier = Modifier.width(12.dp))
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = item.title,
                        style = MaterialTheme.typography.titleMedium,
                        color = MaterialTheme.colorScheme.onSurface
                    )
                    item.presenceText?.let {
                        Text(
                            text = it,
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                    Spacer(modifier = Modifier.height(4.dp))
                    Text(
                        text = item.subtitle,
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
                Spacer(modifier = Modifier.width(12.dp))
                Column(horizontalAlignment = Alignment.End) {
                    item.lastMessageTime?.let {
                        Text(
                            text = it,
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.outline
                        )
                    }
                    Spacer(modifier = Modifier.height(4.dp))
                    UnreadBadge(count = item.unreadCount)
                }
            }
        }
    }
}

@Composable
private fun BrandHeader(onLogout: () -> Unit) {
    Column(modifier = Modifier.fillMaxWidth()) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
            Column {
                val title = buildAnnotatedString {
                    withStyle(SpanStyle(color = MaterialTheme.colorScheme.primary)) { append("Е") }
                    withStyle(SpanStyle(color = MaterialTheme.colorScheme.onBackground)) { append("Блуша") }
                }
                Text(
                    text = title,
                    style = MaterialTheme.typography.displaySmall.copy(fontWeight = FontWeight.Bold)
                )
                Text(
                    text = "Здесь мы общаемся",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
            TextButton(onClick = onLogout) {
                Text("Выйти")
            }
        }
    }
}

@Composable
private fun SearchStub() {
    val spacing = LocalSpacing.current
    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(24.dp),
        color = MaterialTheme.colorScheme.surfaceVariant
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = spacing.lg, vertical = spacing.sm),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Icon(Icons.Default.Search, contentDescription = null, tint = MaterialTheme.colorScheme.outline)
            Spacer(modifier = Modifier.width(spacing.sm))
            Text(
                text = "Поиск или начало нового чата",
                color = MaterialTheme.colorScheme.outline
            )
        }
    }
}

@Composable
private fun SectionDivider(title: String) {
    val spacing = LocalSpacing.current
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = spacing.sm),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(
            text = title,
            style = MaterialTheme.typography.labelLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        Spacer(modifier = Modifier.width(spacing.sm))
        Divider(modifier = Modifier.weight(1f), color = MaterialTheme.colorScheme.surfaceVariant)
    }
}

@Composable
private fun QuickActionsRow() {
    val spacing = LocalSpacing.current
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(spacing.md)
    ) {
        ActionCard(
            modifier = Modifier.weight(1f),
            title = "Беседа",
            subtitle = "Групповой чат",
            icon = Icons.Default.Add,
            tint = MaterialTheme.colorScheme.secondary
        )
        ActionCard(
            modifier = Modifier.weight(1f),
            title = "Контакты",
            subtitle = "Список контактов",
            icon = Icons.Default.Person,
            tint = MaterialTheme.colorScheme.primary
        )
    }
}

@Composable
private fun ActionCard(
    modifier: Modifier = Modifier,
    title: String,
    subtitle: String,
    icon: ImageVector,
    tint: Color
) {
    Card(
        modifier = modifier,
        shape = RoundedCornerShape(24.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            horizontalAlignment = Alignment.Start,
            verticalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            Box(
                modifier = Modifier
                    .size(40.dp)
                    .clip(CircleShape)
                    .background(tint.copy(alpha = 0.15f)),
                contentAlignment = Alignment.Center
            ) {
                Icon(icon, contentDescription = null, tint = tint)
            }
            Text(text = title, style = MaterialTheme.typography.titleMedium)
            Text(text = subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun ProfileCard(user: SessionUser) {
    val statusLabel = when (user.status?.lowercase()) {
        "online" -> "Онлайн"
        "away" -> "Отошёл"
        else -> user.status ?: "Не в сети"
    }
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(24.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
    ) {
        Row(
            modifier = Modifier.padding(16.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            Avatar(
                name = user.displayName ?: user.username,
                imageUrl = user.avatarUrl,
                size = 56.dp
            )
            Column(modifier = Modifier.weight(1f)) {
                Text(text = user.displayName ?: user.username, style = MaterialTheme.typography.titleMedium)
                user.status?.let {
                    Text(text = it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                user.eblid?.let {
                    Text(text = "EBLID: $it", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    modifier = Modifier
                        .size(10.dp)
                        .clip(CircleShape)
                        .background(
                            if (user.status.equals("online", true)) MaterialTheme.colorScheme.secondary else MaterialTheme.colorScheme.outline
                        )
                )
                Spacer(modifier = Modifier.width(6.dp))
                Text(text = statusLabel, color = MaterialTheme.colorScheme.onSurface, style = MaterialTheme.typography.labelMedium)
            }
        }
    }
}

