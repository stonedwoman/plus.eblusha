package org.eblusha.plus.ui.theme

import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext

private val LightColors = lightColorScheme(
    primary = AccentOrange,
    onPrimary = Color.White,
    secondary = AccentBlue,
    onSecondary = Color.Black,
    tertiary = AccentPink,
    background = Color(0xFFF6F7FB),
    surface = Color.White,
    surfaceVariant = Color(0xFFE5E8F1),
    onSurface = Color(0xFF111827),
    onSurfaceVariant = Color(0xFF4B5563),
    outline = Color(0xFFD1D5DB)
)

private val DarkColors = darkColorScheme(
    primary = AccentOrange,
    onPrimary = Color.White,
    secondary = AccentBlue,
    onSecondary = Color.Black,
    tertiary = AccentPink,
    background = Midnight,
    surface = MidnightCard,
    surfaceVariant = MidnightVariant,
    onSurface = Color.White,
    onSurfaceVariant = TextSecondary,
    outline = TextSecondary.copy(alpha = 0.6f)
)

@Composable
fun EblushaPlusTheme(
    darkTheme: Boolean = true,
    dynamicColor: Boolean = false,
    content: @Composable () -> Unit
) {
    val colorScheme = when {
        dynamicColor && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S -> {
            val context = LocalContext.current
            if (darkTheme) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
        }
        darkTheme -> DarkColors
        else -> LightColors
    }

    CompositionLocalProvider(LocalSpacing provides Spacing()) {
        MaterialTheme(
            colorScheme = colorScheme,
            typography = Typography,
            content = content
        )
    }
}
