package dev.akari.pulse.bridge.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import androidx.compose.ui.unit.dp

val AkariBackground = Color(0xFFE8ECF3)
val AkariSurface = Color(0xFFEFF2F8)
val AkariPrimary = Color(0xFF4F6CE8)
val AkariInk = Color(0xFF0E1525)
val AkariMutedInk = Color(0xFF394560)
val YoruBackground = Color(0xFF0B1020)
val YoruSurface = Color(0xFF131A2E)
val YoruPrimary = Color(0xFF7A95FA)
val YoruInk = Color(0xFFE6EAF6)
val YoruMutedInk = Color(0xFFA8B2CC)
val AkariError = Color(0xFFD45D5D)

private val AkariColors = lightColorScheme(
    primary = AkariPrimary,
    onPrimary = Color.White,
    primaryContainer = Color(0xFFDDE4FF),
    onPrimaryContainer = AkariInk,
    background = AkariBackground,
    onBackground = AkariInk,
    surface = AkariSurface,
    onSurface = AkariInk,
    surfaceVariant = Color(0xFFE2E7F1),
    onSurfaceVariant = AkariMutedInk,
    outline = Color(0xFF78849F),
    error = AkariError,
    onError = Color.White,
)

private val YoruColors = darkColorScheme(
    primary = YoruPrimary,
    onPrimary = YoruBackground,
    primaryContainer = Color(0xFF25335F),
    onPrimaryContainer = YoruInk,
    background = YoruBackground,
    onBackground = YoruInk,
    surface = YoruSurface,
    onSurface = YoruInk,
    surfaceVariant = Color(0xFF1B2440),
    onSurfaceVariant = YoruMutedInk,
    outline = Color(0xFF687594),
    error = AkariError,
    onError = Color.White,
)

private val AkariTypography = Typography(
    headlineMedium = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.SemiBold,
        fontSize = 28.sp,
        lineHeight = 34.sp,
    ),
    titleMedium = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.SemiBold,
        fontSize = 17.sp,
        lineHeight = 23.sp,
    ),
    bodyMedium = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.Normal,
        fontSize = 14.sp,
        lineHeight = 20.sp,
    ),
    labelLarge = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.Medium,
        fontSize = 14.sp,
        lineHeight = 20.sp,
    ),
)

private val AkariShapes = Shapes(
    small = RoundedCornerShape(12.dp),
    medium = RoundedCornerShape(16.dp),
    large = RoundedCornerShape(22.dp),
)

@Composable
fun AkariPulseTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    MaterialTheme(
        colorScheme = if (darkTheme) YoruColors else AkariColors,
        typography = AkariTypography,
        shapes = AkariShapes,
        content = content,
    )
}
