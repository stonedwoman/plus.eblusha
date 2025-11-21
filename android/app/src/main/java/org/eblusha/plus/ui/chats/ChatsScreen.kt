package org.eblusha.plus.ui.chats

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Person
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
import androidx.compose.ui.draw.shadow
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
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = 16.dp)
        ) {
            // Centered header
            BrandHeaderCentered()
            
            // Conversations list
            Box(
                modifier = Modifier
                    .weight(1f)
                    .fillMaxWidth()
            ) {
                when (state) {
                    ChatsUiState.Loading -> {
                        Box(
                            modifier = Modifier.fillMaxSize(),
                            contentAlignment = Alignment.Center
                        ) {
                            Text(
                                text = "Загружаем чаты…",
                                style = MaterialTheme.typography.bodyLarge
                            )
                        }
                    }
                    is ChatsUiState.Error -> {
                        Box(
                            modifier = Modifier.fillMaxSize(),
                            contentAlignment = Alignment.Center
                        ) {
                            ErrorState(message = state.message, onRetry = onRefresh)
                        }
                    }
                    is ChatsUiState.Success -> {
                        LazyColumn(
                            modifier = Modifier.fillMaxSize(),
                            verticalArrangement = Arrangement.spacedBy(8.dp),
                            contentPadding = PaddingValues(vertical = 10.dp)
                        ) {
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
                }
            }
            
            // Footer with actions and profile
            ConvFooter(user = user, onLogout = onLogout)
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
    val shape = RoundedCornerShape(12.dp)
    val spacing = LocalSpacing.current
    val borderColor = if (item.unreadCount > 0) {
        MaterialTheme.colorScheme.primary
    } else {
        MaterialTheme.colorScheme.outlineVariant
    }
    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .clickable { onClick(item) },
        shape = shape,
        color = MaterialTheme.colorScheme.surfaceVariant,
        border = BorderStroke(1.5.dp, borderColor),
        tonalElevation = if (item.unreadCount > 0) 4.dp else 2.dp
    ) {
        Row(
            modifier = Modifier.padding(10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            Avatar(
                name = item.title,
                imageUrl = item.avatarUrl,
                size = 40.dp,
                presence = if (item.isOnline) "ONLINE" else null
            )
            Column(modifier = Modifier.weight(1f)) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp)
                ) {
                    Text(
                        text = item.title,
                        style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.SemiBold),
                        color = MaterialTheme.colorScheme.onSurface
                    )
                    if (item.isGroup.not() && (item.presenceText ?: "").contains("секрет", ignoreCase = true)) {
                        SecretBadge()
                    }
                }
                item.presenceText?.let {
                    Text(
                        text = it,
                        style = MaterialTheme.typography.bodySmall,
                        color = if (item.unreadCount > 0) {
                            MaterialTheme.colorScheme.primary
                        } else {
                            MaterialTheme.colorScheme.onSurfaceVariant
                        }
                    )
                }
            }
        }
    }
}

@Composable
private fun BrandHeaderCentered() {
    val spacing = LocalSpacing.current
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = spacing.lg),
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        val title = buildAnnotatedString {
            append("Е")
            withStyle(SpanStyle(color = MaterialTheme.colorScheme.primary)) { append("Б") }
            append("луша")
        }
        Text(
            text = title,
            style = MaterialTheme.typography.displaySmall.copy(fontWeight = FontWeight.Bold),
            color = MaterialTheme.colorScheme.onBackground
        )
        Text(
            text = "Здесь мы общаемся",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(top = 4.dp)
        )
    }
}


@Composable
private fun ConvFooter(
    user: SessionUser,
    onLogout: () -> Unit
) {
    val spacing = LocalSpacing.current
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = spacing.md),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        // Divider
        Divider(
            color = MaterialTheme.colorScheme.outlineVariant,
            modifier = Modifier.padding(vertical = 8.dp)
        )
        
        // Actions row
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            ActionCard(
                modifier = Modifier.weight(1f),
                title = "Беседа",
                subtitle = "Групповой чат",
                icon = Icons.Default.Add,
                iconBackgroundColor = Color(0xFF10B981)
            )
            ActionCard(
                modifier = Modifier.weight(1f),
                title = "Контакты",
                subtitle = "Добавить друзей",
                icon = Icons.Default.Person,
                iconBackgroundColor = Color(0xFF6366F1)
            )
        }
        
        // Profile card
        ProfileCardFooter(user = user)
    }
}

@Composable
private fun ActionCard(
    modifier: Modifier = Modifier,
    title: String,
    subtitle: String,
    icon: ImageVector,
    iconBackgroundColor: Color
) {
    val shape = RoundedCornerShape(12.dp)
    Surface(
        modifier = modifier.clickable { /* TODO: Handle click */ },
        shape = shape,
        color = MaterialTheme.colorScheme.surfaceVariant,
        border = BorderStroke(1.5.dp, MaterialTheme.colorScheme.outlineVariant),
        tonalElevation = 2.dp
    ) {
        Row(
            modifier = Modifier.padding(10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            Box(
                modifier = Modifier
                    .size(40.dp)
                    .clip(CircleShape)
                    .background(iconBackgroundColor),
                contentAlignment = Alignment.Center
            ) {
                Icon(icon, contentDescription = null, tint = Color.White, modifier = Modifier.size(22.dp))
            }
            Column {
                Text(
                    text = title,
                    style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.SemiBold),
                    color = MaterialTheme.colorScheme.onSurface
                )
                Text(
                    text = subtitle,
                    style = MaterialTheme.typography.bodySmall,
                    color = Color(0xFF6B7280)
                )
            }
        }
    }
}

@Composable
private fun ProfileCardFooter(user: SessionUser) {
    val shape = RoundedCornerShape(12.dp)
    val statusValue = when (user.status?.uppercase()) {
        "ONLINE" -> "ONLINE"
        "AWAY" -> "AWAY"
        else -> "OFFLINE"
    }
    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .clickable { /* TODO: Handle click */ },
        shape = shape,
        color = MaterialTheme.colorScheme.surfaceVariant,
        border = BorderStroke(1.5.dp, MaterialTheme.colorScheme.outlineVariant),
        tonalElevation = 2.dp
    ) {
        Row(
            modifier = Modifier.padding(10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            Avatar(
                name = user.displayName ?: user.username,
                imageUrl = user.avatarUrl,
                size = 40.dp,
                presence = statusValue
            )
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = user.displayName ?: user.username,
                    style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.Bold),
                    color = MaterialTheme.colorScheme.onSurface
                )
                Text(
                    text = "EBLID: ${user.eblid ?: "— — — —"}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }
    }
}

@Composable
private fun SecretBadge() {
    Box(
        modifier = Modifier
            .size(18.dp)
            .clip(CircleShape)
            .background(Color(0x1A22C55E)),
        contentAlignment = Alignment.Center
    ) {
        Icon(
            imageVector = Icons.Default.Lock,
            contentDescription = null,
            tint = Color(0xFF22C55E),
            modifier = Modifier.size(12.dp)
        )
    }
}

