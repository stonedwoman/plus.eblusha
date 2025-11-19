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
    primary = Plum2,
    onPrimary = Color.White,
    secondary = Accent,
    tertiary = Sky,
    background = Color.White,
    surface = Color.White,
    surfaceVariant = Color(0xFFF1EFF8),
    onSurface = Plum0
)

private val DarkColors = darkColorScheme(
    primary = Lilac,
    onPrimary = Plum0,
    secondary = Accent,
    tertiary = Sky,
    background = Plum0,
    surface = Plum1,
    surfaceVariant = Color(0xFF2E2A40),
    onSurface = Color.White
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
