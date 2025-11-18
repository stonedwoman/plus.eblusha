package org.eblusha.plus.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import kotlin.math.absoluteValue
import androidx.compose.ui.platform.LocalContext
import coil.compose.AsyncImage
import coil.request.ImageRequest

@Composable
fun Avatar(
    name: String,
    imageUrl: String?,
    modifier: Modifier = Modifier,
    size: Dp = 48.dp,
    backgroundColor: Color? = null,
) {
    val context = LocalContext.current
    val initials = remember(name) {
        name.trim().takeIf { it.isNotEmpty() }?.split("\\s+".toRegex())
            ?.take(2)?.joinToString("") { part -> part.first().uppercase() } ?: "?"
    }
    val tint = remember(name) { avatarColors[(name.hashCode().absoluteValue) % avatarColors.size] }

    Surface(
        modifier = modifier
            .size(size)
            .clip(CircleShape),
        color = Color.Transparent
    ) {
        if (!imageUrl.isNullOrBlank()) {
            AsyncImage(
                model = ImageRequest.Builder(context)
                    .data(imageUrl)
                    .crossfade(true)
                    .build(),
                contentDescription = name,
                modifier = Modifier
                    .background(backgroundColor ?: MaterialTheme.colorScheme.surfaceVariant, CircleShape)
                    .clip(CircleShape)
            )
        } else {
            Box(
                modifier = Modifier
                    .background(backgroundColor ?: tint, CircleShape),
                contentAlignment = Alignment.Center
            ) {
                Text(
                    text = initials,
                    style = MaterialTheme.typography.bodyLarge.copy(
                        fontWeight = FontWeight.SemiBold,
                        textAlign = TextAlign.Center,
                        color = MaterialTheme.colorScheme.onPrimaryContainer
                    )
                )
            }
        }
    }
}

private val avatarColors = listOf(
    Color(0xFF6EC6FF),
    Color(0xFFFFA726),
    Color(0xFFFF6E6E),
    Color(0xFF9CCC65),
    Color(0xFFE1BEE7),
    Color(0xFFFFD54F)
)

