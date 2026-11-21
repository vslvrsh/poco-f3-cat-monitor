package com.purrcam.app.ui.theme

import android.os.Build
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.MaterialExpressiveTheme
import androidx.compose.material3.MotionScheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

object PurrStatusColors {
    val Live = Color(0xFF34D399)
    val Warning = Color(0xFFFBBF24)
    val Danger = Color(0xFFF87171)
    val PureBlack = Color(0xFF000000)
}

private val PurrExpressiveDarkFallback = darkColorScheme(
    primary = Color(0xFFF6C177),
    onPrimary = Color(0xFF2B1C06),
    primaryContainer = Color(0xFF563D14),
    onPrimaryContainer = Color(0xFFFFE1B8),
    secondary = Color(0xFF8AD6B4),
    onSecondary = Color(0xFF0A2A1D),
    secondaryContainer = Color(0xFF1D4736),
    onSecondaryContainer = Color(0xFFC2F2DC),
    tertiary = Color(0xFFA8C7FA),
    onTertiary = Color(0xFF0D274E),
    tertiaryContainer = Color(0xFF213E6D),
    onTertiaryContainer = Color(0xFFD7E5FF),
    background = Color(0xFF0E1116),
    onBackground = Color(0xFFE6E9F0),
    surface = Color(0xFF0E1116),
    onSurface = Color(0xFFE6E9F0),
    surfaceVariant = Color(0xFF232834),
    onSurfaceVariant = Color(0xFFA8B0C2),
    surfaceContainerLowest = Color(0xFF090B0F),
    surfaceContainerLow = Color(0xFF141820),
    surfaceContainer = Color(0xFF1A1F29),
    surfaceContainerHigh = Color(0xFF222835),
    surfaceContainerHighest = Color(0xFF2B3242),
    outline = Color(0xFF475066),
    outlineVariant = Color(0xFF2A3140),
    error = Color(0xFFFFB4AB),
    onError = Color(0xFF690005),
    errorContainer = Color(0xFF93000A),
    onErrorContainer = Color(0xFFFFDAD6)
)

private val PurrExpressiveTypography = Typography(
    displaySmall = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.Bold,
        fontSize = 34.sp,
        lineHeight = 40.sp,
        letterSpacing = (-0.8).sp
    ),
    headlineMedium = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.Bold,
        fontSize = 26.sp,
        lineHeight = 32.sp,
        letterSpacing = (-0.4).sp
    ),
    headlineSmall = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.Bold,
        fontSize = 22.sp,
        lineHeight = 28.sp,
        letterSpacing = (-0.2).sp
    ),
    titleLarge = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.SemiBold,
        fontSize = 19.sp,
        lineHeight = 25.sp
    ),
    titleMedium = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.SemiBold,
        fontSize = 15.sp,
        lineHeight = 22.sp
    ),
    bodyLarge = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.Normal,
        fontSize = 15.sp,
        lineHeight = 22.sp
    ),
    bodyMedium = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.Normal,
        fontSize = 14.sp,
        lineHeight = 20.sp
    ),
    bodySmall = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.Normal,
        fontSize = 12.sp,
        lineHeight = 16.sp
    ),
    labelLarge = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.SemiBold,
        fontSize = 14.sp,
        lineHeight = 18.sp
    ),
    labelMedium = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.SemiBold,
        fontSize = 12.sp,
        lineHeight = 16.sp,
        fontFeatureSettings = "tnum"
    ),
    labelSmall = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.Medium,
        fontSize = 11.sp,
        lineHeight = 14.sp,
        fontFeatureSettings = "tnum"
    )
)

private val PurrExpressiveShapes = Shapes(
    extraSmall = RoundedCornerShape(8.dp),
    small = RoundedCornerShape(12.dp),
    medium = RoundedCornerShape(18.dp),
    large = RoundedCornerShape(24.dp),
    extraLarge = RoundedCornerShape(28.dp)
)

@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun PurrCamTheme(
    useDynamicColor: Boolean = true,
    content: @Composable () -> Unit
) {
    val context = LocalContext.current
    val colorScheme = if (useDynamicColor && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        dynamicDarkColorScheme(context)
    } else {
        PurrExpressiveDarkFallback
    }

    MaterialExpressiveTheme(
        colorScheme = colorScheme,
        motionScheme = MotionScheme.expressive(),
        shapes = PurrExpressiveShapes,
        typography = PurrExpressiveTypography,
        content = content
    )
}
