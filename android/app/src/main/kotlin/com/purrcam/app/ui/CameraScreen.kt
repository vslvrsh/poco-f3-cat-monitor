package com.purrcam.app.ui

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.PowerManager
import android.provider.Settings
import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.waitForUpOrCancellation
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.BatteryChargingFull
import androidx.compose.material.icons.rounded.DarkMode
import androidx.compose.material.icons.rounded.FlashlightOff
import androidx.compose.material.icons.rounded.FlashlightOn
import androidx.compose.material.icons.rounded.Link
import androidx.compose.material.icons.rounded.Memory
import androidx.compose.material.icons.rounded.Mic
import androidx.compose.material.icons.rounded.MonitorHeart
import androidx.compose.material.icons.rounded.PlayArrow
import androidx.compose.material.icons.rounded.PowerSettingsNew
import androidx.compose.material.icons.rounded.Settings
import androidx.compose.material.icons.rounded.Shield
import androidx.compose.material.icons.rounded.Stop
import androidx.compose.material.icons.rounded.SwapHoriz
import androidx.compose.material.icons.rounded.Thermostat
import androidx.compose.material.icons.rounded.Videocam
import androidx.compose.material.icons.rounded.Wifi
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.FilledTonalIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Slider
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import com.purrcam.app.camera.CameraServiceUiState
import com.purrcam.app.camera.CameraStreamService
import com.purrcam.app.ui.components.ConnectServerBottomSheet
import com.purrcam.app.ui.components.ExpressiveLensDock
import com.purrcam.app.ui.components.ExpressiveSegmentedPills
import com.purrcam.app.ui.components.HealthMetricCard
import com.purrcam.app.ui.components.formatDurationShort
import com.purrcam.app.ui.theme.PurrStatusColors
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.webrtc.RendererCommon
import org.webrtc.SurfaceViewRenderer
import java.util.Locale
import kotlin.math.roundToInt

private enum class CameraTab(val label: String) {
    LIVE("Live"),
    HEALTH("Health"),
    SETTINGS("Settings")
}

@Composable
fun CameraScreen(
    localServerUrl: String,
    remoteServerUrl: String,
    authToken: String,
    autoStart: Boolean,
    onSaveConnection: (localUrl: String, remoteUrl: String, token: String) -> Unit,
    onAutoStartChanged: (Boolean) -> Unit,
    onRestartCameraService: () -> Unit,
    onStopCameraService: () -> Unit,
    onSwitchMode: () -> Unit,
    onBlackoutChanged: (Boolean) -> Unit
) {
    val ui by CameraStreamService.uiState.collectAsState()
    var activeTab by remember { mutableStateOf(CameraTab.LIVE) }
    var showConnectSheet by remember { mutableStateOf(false) }

    LaunchedEffect(ui.cameraState.blackout) {
        onBlackoutChanged(ui.cameraState.blackout)
    }

    DisposableEffect(Unit) {
        onDispose {
            onBlackoutChanged(false)
        }
    }

    if (ui.cameraState.blackout) {
        AmoledBlackoutOverlay(
            batteryPct = ui.telemetry?.batteryPct,
            batteryTempC = ui.telemetry?.batteryTempC,
            viewerCount = ui.viewerCount,
            wsConnected = ui.wsConnected,
            rootDisplayOff = ui.cameraState.rootDisplayOff,
            onUnlock = {
                CameraStreamService.getInstance()?.localSetBlackout(enabled = false, rootDisplayOff = false)
            }
        )
        return
    }

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        bottomBar = {
            NavigationBar(
                containerColor = MaterialTheme.colorScheme.surfaceContainerLow,
                tonalElevation = 0.dp
            ) {
                NavigationBarItem(
                    selected = activeTab == CameraTab.LIVE,
                    onClick = { activeTab = CameraTab.LIVE },
                    icon = { Icon(Icons.Rounded.Videocam, contentDescription = "Live") },
                    label = { Text("Live") }
                )
                NavigationBarItem(
                    selected = activeTab == CameraTab.HEALTH,
                    onClick = { activeTab = CameraTab.HEALTH },
                    icon = { Icon(Icons.Rounded.MonitorHeart, contentDescription = "Health") },
                    label = { Text("Health") }
                )
                NavigationBarItem(
                    selected = activeTab == CameraTab.SETTINGS,
                    onClick = { activeTab = CameraTab.SETTINGS },
                    icon = { Icon(Icons.Rounded.Settings, contentDescription = "Settings") },
                    label = { Text("Settings") }
                )
            }
        }
    ) { innerPadding ->
        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(bottom = innerPadding.calculateBottomPadding())
        ) {
            when (activeTab) {
                CameraTab.LIVE -> CameraLiveTab(
                    ui = ui,
                    onToggleRun = {
                        if (ui.running) onStopCameraService() else onRestartCameraService()
                    }
                )

                CameraTab.HEALTH -> CameraHealthTab(ui = ui)

                CameraTab.SETTINGS -> CameraSettingsTab(
                    ui = ui,
                    localServerUrl = localServerUrl,
                    remoteServerUrl = remoteServerUrl,
                    authToken = authToken,
                    autoStart = autoStart,
                    onOpenConnectSheet = { showConnectSheet = true },
                    onAutoStartChanged = onAutoStartChanged,
                    onSwitchMode = onSwitchMode
                )
            }
        }
    }

    if (showConnectSheet) {
        ConnectServerBottomSheet(
            initialLocalUrl = localServerUrl,
            initialRemoteUrl = remoteServerUrl,
            initialToken = authToken,
            onDismiss = { showConnectSheet = false },
            onSave = { local, remote, tok ->
                onSaveConnection(local, remote, tok)
                CameraStreamService.getInstance()?.updateConnectionEndpoints(local, remote, tok)
            }
        )
    }
}

@Composable
private fun CameraLiveTab(
    ui: CameraServiceUiState,
    onToggleRun: () -> Unit
) {
    val activeLens = ui.lenses.firstOrNull { it.id == ui.cameraState.activeLensId }
    val isFront = activeLens?.facing == "front"

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color.Black)
    ) {
        // Full-bleed upright WYSIWYG WebRTC viewfinder (identical to what viewers receive!)
        if (ui.running) {
            LocalCameraPreviewView(
                modifier = Modifier.fillMaxSize(),
                videoReady = ui.videoReady,
                isFront = isFront
            )
        } else {
            Column(
                modifier = Modifier.align(Alignment.Center),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(10.dp)
            ) {
                Icon(
                    imageVector = Icons.Rounded.Videocam,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.size(44.dp)
                )
                Text(
                    text = "Stream paused",
                    style = MaterialTheme.typography.titleLarge,
                    color = MaterialTheme.colorScheme.onSurface
                )
                Text(
                    text = "Tap Start below to resume streaming",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }

        // Subtle top & bottom gradient scrims for clean floating controls readability
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(120.dp)
                .align(Alignment.TopCenter)
                .background(
                    Brush.verticalGradient(
                        colors = listOf(Color.Black.copy(alpha = 0.52f), Color.Transparent)
                    )
                )
        )
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(210.dp)
                .align(Alignment.BottomCenter)
                .background(
                    Brush.verticalGradient(
                        colors = listOf(Color.Transparent, Color.Black.copy(alpha = 0.72f))
                    )
                )
        )

        // Single Subtle Top Status Pill
        Surface(
            color = MaterialTheme.colorScheme.surfaceContainerHigh.copy(alpha = 0.78f),
            shape = RoundedCornerShape(999.dp),
            modifier = Modifier
                .align(Alignment.TopCenter)
                .statusBarsPadding()
                .padding(top = 12.dp)
        ) {
            Row(
                modifier = Modifier.padding(horizontal = 14.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                val dotColor = when {
                    !ui.running -> MaterialTheme.colorScheme.outline
                    ui.wsConnected -> PurrStatusColors.Live
                    else -> PurrStatusColors.Warning
                }
                Box(
                    modifier = Modifier
                        .size(8.dp)
                        .clip(CircleShape)
                        .background(dotColor)
                )
                val fps = ui.telemetry?.fps ?: ui.cameraState.fps
                val viewersText = if (ui.viewerCount == 1) "1 viewer" else "${ui.viewerCount} viewers"
                val pillText = when {
                    !ui.running -> "STOPPED"
                    ui.wsConnected -> "LIVE · $fps fps · $viewersText"
                    else -> ui.statusText
                }
                Text(
                    text = pillText,
                    style = MaterialTheme.typography.labelLarge.copy(fontFeatureSettings = "tnum"),
                    color = MaterialTheme.colorScheme.onSurface
                )
                if (ui.wsConnected) {
                    Surface(
                        color = MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.9f),
                        shape = RoundedCornerShape(999.dp)
                    ) {
                        Text(
                            text = ui.activeRoute,
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onPrimaryContainer,
                            modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp)
                        )
                    }
                }
            }
        }

        // Floating Error Pill (only when an actual error occurs)
        ui.lastError?.let { err ->
            Surface(
                color = MaterialTheme.colorScheme.errorContainer.copy(alpha = 0.92f),
                shape = RoundedCornerShape(16.dp),
                modifier = Modifier
                    .align(Alignment.TopCenter)
                    .statusBarsPadding()
                    .padding(top = 60.dp, start = 20.dp, end = 20.dp)
            ) {
                Text(
                    text = err,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onErrorContainer,
                    modifier = Modifier.padding(horizontal = 14.dp, vertical = 8.dp)
                )
            }
        }

        // Bottom Floating Lens Pill Group + Expressive Action Dock
        Column(
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .padding(horizontal = 16.dp, vertical = 18.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            if (ui.running && ui.lenses.isNotEmpty()) {
                ExpressiveLensDock(
                    lenses = ui.lenses,
                    activeLensId = ui.cameraState.activeLensId,
                    onSelectLens = { id ->
                        CameraStreamService.getInstance()?.localSwitchLens(id)
                    }
                )
            }

            // Floating Expressive Action Toolbar
            Surface(
                color = MaterialTheme.colorScheme.surfaceContainerHigh.copy(alpha = 0.9f),
                shape = RoundedCornerShape(999.dp),
                tonalElevation = 6.dp
            ) {
                Row(
                    modifier = Modifier.padding(horizontal = 8.dp, vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    // Blackout button
                    FilledTonalIconButton(
                        onClick = {
                            CameraStreamService.getInstance()?.localSetBlackout(
                                enabled = true,
                                rootDisplayOff = ui.capabilities.rootDisplayOff
                            )
                        },
                        enabled = ui.running,
                        colors = IconButtonDefaults.filledTonalIconButtonColors(
                            containerColor = MaterialTheme.colorScheme.surfaceContainerHighest,
                            contentColor = MaterialTheme.colorScheme.onSurface
                        ),
                        modifier = Modifier.size(48.dp)
                    ) {
                        Icon(Icons.Rounded.DarkMode, contentDescription = "AMOLED Blackout")
                    }

                    // Torch toggle
                    val torchBg by animateColorAsState(
                        targetValue = if (ui.cameraState.torch) MaterialTheme.colorScheme.primaryContainer
                        else MaterialTheme.colorScheme.surfaceContainerHighest,
                        label = "torchBg"
                    )
                    val torchFg by animateColorAsState(
                        targetValue = if (ui.cameraState.torch) MaterialTheme.colorScheme.onPrimaryContainer
                        else MaterialTheme.colorScheme.onSurface,
                        label = "torchFg"
                    )
                    FilledTonalIconButton(
                        onClick = {
                            CameraStreamService.getInstance()?.localSetTorch(!ui.cameraState.torch)
                        },
                        enabled = ui.running && (activeLens?.hasFlash != false),
                        colors = IconButtonDefaults.filledTonalIconButtonColors(
                            containerColor = torchBg,
                            contentColor = torchFg
                        ),
                        modifier = Modifier.size(48.dp)
                    ) {
                        Icon(
                            imageVector = if (ui.cameraState.torch) Icons.Rounded.FlashlightOn else Icons.Rounded.FlashlightOff,
                            contentDescription = "Torch"
                        )
                    }

                    // Primary Start / Stop Pill
                    Button(
                        onClick = onToggleRun,
                        shape = RoundedCornerShape(999.dp),
                        colors = if (ui.running) {
                            ButtonDefaults.buttonColors(
                                containerColor = MaterialTheme.colorScheme.errorContainer,
                                contentColor = MaterialTheme.colorScheme.onErrorContainer
                            )
                        } else {
                            ButtonDefaults.buttonColors(
                                containerColor = MaterialTheme.colorScheme.primary,
                                contentColor = MaterialTheme.colorScheme.onPrimary
                            )
                        },
                        modifier = Modifier.height(48.dp)
                    ) {
                        Icon(
                            imageVector = if (ui.running) Icons.Rounded.Stop else Icons.Rounded.PlayArrow,
                            contentDescription = null,
                            modifier = Modifier.size(20.dp)
                        )
                        Spacer(Modifier.width(6.dp))
                        Text(
                            text = if (ui.running) "Stop" else "Start",
                            style = MaterialTheme.typography.labelLarge
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun CameraHealthTab(ui: CameraServiceUiState) {
    val tel = ui.telemetry
    val state = ui.cameraState

    Column(
        modifier = Modifier
            .fillMaxSize()
            .statusBarsPadding()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 20.dp, vertical = 18.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(
                text = "Device Health",
                style = MaterialTheme.typography.headlineMedium,
                color = MaterialTheme.colorScheme.onBackground
            )
            Text(
                text = "${ui.deviceName} · ${if (ui.capabilities.root) "Root granted" else "Standard mode"}",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }

        // Battery Hero Card
        val batColor = when {
            tel == null -> MaterialTheme.colorScheme.primary
            tel.batteryPct <= 15 -> PurrStatusColors.Danger
            tel.chargePaused -> PurrStatusColors.Warning
            tel.charging -> PurrStatusColors.Live
            else -> MaterialTheme.colorScheme.primary
        }
        val batSub = when {
            tel == null -> "Waiting for telemetry..."
            tel.chargePaused -> "Charging paused by Battery Guard · ${tel.voltageMv} mV"
            tel.charging -> "Charging via ${tel.chargeSource.uppercase()} · +${tel.currentMa} mA · ${tel.voltageMv} mV"
            else -> "Discharging · ${tel.currentMa} mA · ${tel.voltageMv} mV"
        }
        HealthMetricCard(
            title = "Battery",
            value = if (tel != null) "${tel.batteryPct}%" else "—",
            subtitle = batSub,
            icon = Icons.Rounded.BatteryChargingFull,
            accentColor = batColor,
            modifier = Modifier.fillMaxWidth()
        )

        // Thermal Cards Side-by-Side
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            val batTempColor = when {
                tel == null -> MaterialTheme.colorScheme.primary
                tel.batteryTempC >= 43f -> PurrStatusColors.Danger
                tel.batteryTempC >= 38f -> PurrStatusColors.Warning
                else -> PurrStatusColors.Live
            }
            HealthMetricCard(
                title = "Battery Temp",
                value = if (tel != null) String.format(Locale.US, "%.1f°C", tel.batteryTempC) else "—",
                subtitle = if ((tel?.batteryTempC ?: 0f) >= 43f) "High temperature" else "Normal",
                icon = Icons.Rounded.Thermostat,
                accentColor = batTempColor,
                modifier = Modifier.weight(1f)
            )
            val cpuTemp = tel?.cpuTempC
            val cpuTempColor = when {
                cpuTemp == null -> MaterialTheme.colorScheme.secondary
                cpuTemp >= 65f -> PurrStatusColors.Danger
                cpuTemp >= 52f -> PurrStatusColors.Warning
                else -> MaterialTheme.colorScheme.secondary
            }
            HealthMetricCard(
                title = "CPU Temp",
                value = if (cpuTemp != null) String.format(Locale.US, "%.1f°C", cpuTemp) else "—",
                subtitle = "SoC thermal",
                icon = Icons.Rounded.Memory,
                accentColor = cpuTempColor,
                modifier = Modifier.weight(1f)
            )
        }

        // Root 80% Battery Guard Card
        Surface(
            color = MaterialTheme.colorScheme.surfaceContainerLow,
            shape = RoundedCornerShape(28.dp),
            modifier = Modifier.fillMaxWidth()
        ) {
            Column(
                modifier = Modifier.padding(20.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp)
            ) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween
                ) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                        modifier = Modifier.weight(1f)
                    ) {
                        Box(
                            modifier = Modifier
                                .size(40.dp)
                                .clip(CircleShape)
                                .background(MaterialTheme.colorScheme.secondaryContainer),
                            contentAlignment = Alignment.Center
                        ) {
                            Icon(
                                Icons.Rounded.Shield,
                                contentDescription = null,
                                tint = MaterialTheme.colorScheme.onSecondaryContainer,
                                modifier = Modifier.size(20.dp)
                            )
                        }
                        Column {
                            Text(
                                text = "24/7 Battery Guard",
                                style = MaterialTheme.typography.titleMedium,
                                color = MaterialTheme.colorScheme.onSurface
                            )
                            Text(
                                text = if (ui.capabilities.chargeLimit) {
                                    "Pause at ${state.chargeLimitMaxPct}%, resume at ${state.chargeLimitMaxPct - 10}%"
                                } else {
                                    "Grant root in KernelSU Manager to enable"
                                },
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                    }
                    Switch(
                        checked = state.chargeLimitEnabled,
                        enabled = ui.capabilities.chargeLimit,
                        onCheckedChange = { enabled ->
                            CameraStreamService.getInstance()?.localSetChargeLimit(enabled, state.chargeLimitMaxPct)
                        }
                    )
                }

                if (ui.capabilities.chargeLimit) {
                    var sliderPct by remember(state.chargeLimitMaxPct) {
                        mutableFloatStateOf(state.chargeLimitMaxPct.toFloat())
                    }
                    Column {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween
                        ) {
                            Text(
                                text = "Charge limit",
                                style = MaterialTheme.typography.labelMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                            Text(
                                text = "${sliderPct.roundToInt()}%",
                                style = MaterialTheme.typography.labelLarge,
                                color = MaterialTheme.colorScheme.primary
                            )
                        }
                        Slider(
                            value = sliderPct,
                            onValueChange = { sliderPct = (it / 5f).roundToInt() * 5f },
                            onValueChangeFinished = {
                                CameraStreamService.getInstance()?.localSetChargeLimit(
                                    state.chargeLimitEnabled,
                                    sliderPct.roundToInt()
                                )
                            },
                            valueRange = 60f..90f,
                            steps = 5
                        )
                    }
                }
            }
        }

        // AMOLED Blackout & Root 0-nit Display Card
        Surface(
            color = MaterialTheme.colorScheme.surfaceContainerLow,
            shape = RoundedCornerShape(28.dp),
            modifier = Modifier.fillMaxWidth()
        ) {
            Column(
                modifier = Modifier.padding(20.dp),
                verticalArrangement = Arrangement.spacedBy(14.dp)
            ) {
                Text(
                    text = "Display & Burn-in Protection",
                    style = MaterialTheme.typography.titleMedium,
                    color = MaterialTheme.colorScheme.onSurface
                )
                Text(
                    text = "Pure #000000 AMOLED blackout turns off OLED pixels and prevents accidental cat touches (hold 1.5s or triple-tap to wake).",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(10.dp)
                ) {
                    FilledTonalButton(
                        onClick = {
                            CameraStreamService.getInstance()?.localSetBlackout(enabled = true, rootDisplayOff = false)
                        },
                        enabled = ui.running,
                        shape = RoundedCornerShape(999.dp),
                        modifier = Modifier.weight(1f)
                    ) {
                        Icon(Icons.Rounded.DarkMode, contentDescription = null, modifier = Modifier.size(18.dp))
                        Spacer(Modifier.width(6.dp))
                        Text("AMOLED 0%")
                    }
                    if (ui.capabilities.rootDisplayOff) {
                        Button(
                            onClick = {
                                CameraStreamService.getInstance()?.localSetBlackout(enabled = true, rootDisplayOff = true)
                            },
                            enabled = ui.running,
                            shape = RoundedCornerShape(999.dp),
                            modifier = Modifier.weight(1f)
                        ) {
                            Icon(Icons.Rounded.PowerSettingsNew, contentDescription = null, modifier = Modifier.size(18.dp))
                            Spacer(Modifier.width(6.dp))
                            Text("0-nit Root")
                        }
                    }
                }
            }
        }

        // Always-On Background / Battery Optimization Exemption Card
        AlwaysOnBatteryOptimizationCard()

        // Network & System Summary Row
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            HealthMetricCard(
                title = "Network",
                value = if (tel?.wifiRssi != null) "${tel.wifiRssi} dBm" else ui.activeRoute,
                subtitle = if (ui.wsConnected) "Connected · ${ui.activeRoute}" else ui.statusText,
                icon = Icons.Rounded.Wifi,
                accentColor = MaterialTheme.colorScheme.tertiary,
                modifier = Modifier.weight(1f)
            )
            HealthMetricCard(
                title = "Uptime",
                value = formatDurationShort(tel?.uptimeSec ?: 0L),
                subtitle = if (tel != null) "${tel.freeRamMb} MB RAM free" else "—",
                icon = Icons.Rounded.MonitorHeart,
                accentColor = MaterialTheme.colorScheme.secondary,
                modifier = Modifier.weight(1f)
            )
        }
    }
}

@SuppressLint("BatteryLife")
@Composable
private fun AlwaysOnBatteryOptimizationCard() {
    val context = LocalContext.current
    val pm = remember(context) { context.getSystemService(Context.POWER_SERVICE) as PowerManager }
    var isIgnoring by remember {
        mutableStateOf(pm.isIgnoringBatteryOptimizations(context.packageName))
    }

    LaunchedEffect(Unit) {
        while (true) {
            isIgnoring = pm.isIgnoringBatteryOptimizations(context.packageName)
            delay(3000L)
        }
    }

    Surface(
        color = MaterialTheme.colorScheme.surfaceContainerLow,
        shape = RoundedCornerShape(28.dp),
        modifier = Modifier.fillMaxWidth()
    ) {
        Column(
            modifier = Modifier.padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween
            ) {
                Text(
                    text = "Always-On Background",
                    style = MaterialTheme.typography.titleMedium,
                    color = MaterialTheme.colorScheme.onSurface
                )
                Surface(
                    color = if (isIgnoring) PurrStatusColors.Live.copy(alpha = 0.18f)
                    else PurrStatusColors.Warning.copy(alpha = 0.18f),
                    shape = RoundedCornerShape(999.dp)
                ) {
                    Text(
                        text = if (isIgnoring) "Unrestricted" else "Optimized",
                        style = MaterialTheme.typography.labelMedium,
                        color = if (isIgnoring) PurrStatusColors.Live else PurrStatusColors.Warning,
                        modifier = Modifier.padding(horizontal = 10.dp, vertical = 4.dp)
                    )
                }
            }
            Text(
                text = if (isIgnoring) {
                    "Android Doze exemption is active — camera streaming stays alive 24/7."
                } else {
                    "Exempt PurrCam from Android Doze / battery restrictions so the stream never sleeps overnight."
                },
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            if (!isIgnoring) {
                FilledTonalButton(
                    onClick = {
                        try {
                            val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                                data = Uri.parse("package:${context.packageName}")
                                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                            }
                            context.startActivity(intent)
                        } catch (_: Exception) {
                            try {
                                context.startActivity(
                                    Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS).apply {
                                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                                    }
                                )
                            } catch (_: Exception) {
                            }
                        }
                    },
                    shape = RoundedCornerShape(999.dp),
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Icon(Icons.Rounded.BatteryChargingFull, contentDescription = null, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(8.dp))
                    Text("Disable Battery Optimization")
                }
            }
        }
    }
}

@Composable
private fun CameraSettingsTab(
    ui: CameraServiceUiState,
    localServerUrl: String,
    remoteServerUrl: String,
    authToken: String,
    autoStart: Boolean,
    onOpenConnectSheet: () -> Unit,
    onAutoStartChanged: (Boolean) -> Unit,
    onSwitchMode: () -> Unit
) {
    val state = ui.cameraState

    Column(
        modifier = Modifier
            .fillMaxSize()
            .statusBarsPadding()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 20.dp, vertical = 18.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        Text(
            text = "Camera Settings",
            style = MaterialTheme.typography.headlineMedium,
            color = MaterialTheme.colorScheme.onBackground
        )

        // Server & Remote Access Card
        Surface(
            color = MaterialTheme.colorScheme.surfaceContainerLow,
            shape = RoundedCornerShape(28.dp),
            modifier = Modifier.fillMaxWidth()
        ) {
            Column(
                modifier = Modifier.padding(20.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp)
            ) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text(
                        text = "Server & Remote Access",
                        style = MaterialTheme.typography.titleMedium,
                        color = MaterialTheme.colorScheme.onSurface
                    )
                    Surface(
                        color = if (ui.wsConnected) PurrStatusColors.Live.copy(alpha = 0.18f)
                        else MaterialTheme.colorScheme.surfaceContainerHighest,
                        shape = RoundedCornerShape(999.dp)
                    ) {
                        Text(
                            text = if (ui.wsConnected) ui.activeRoute else "Offline",
                            style = MaterialTheme.typography.labelMedium,
                            color = if (ui.wsConnected) PurrStatusColors.Live else MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(horizontal = 10.dp, vertical = 4.dp)
                        )
                    }
                }
                Text(
                    text = "Local: $localServerUrl",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                Text(
                    text = "Remote: ${remoteServerUrl.ifBlank { "Not configured" }}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                Text(
                    text = "Token: ${if (authToken.isNotBlank()) "Configured" else "None"}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                FilledTonalButton(
                    onClick = onOpenConnectSheet,
                    shape = RoundedCornerShape(999.dp),
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Icon(Icons.Rounded.Link, contentDescription = null, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(8.dp))
                    Text("Edit Server / Paste Pairing Link")
                }
            }
        }

        // Video Profile Card
        Surface(
            color = MaterialTheme.colorScheme.surfaceContainerLow,
            shape = RoundedCornerShape(28.dp),
            modifier = Modifier.fillMaxWidth()
        ) {
            Column(
                modifier = Modifier.padding(20.dp),
                verticalArrangement = Arrangement.spacedBy(14.dp)
            ) {
                Text(
                    text = "Video Profile",
                    style = MaterialTheme.typography.titleMedium,
                    color = MaterialTheme.colorScheme.onSurface
                )
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(
                        text = "Resolution",
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    ExpressiveSegmentedPills(
                        options = listOf("480p", "720p", "1080p"),
                        selected = state.resolution,
                        onSelect = { res ->
                            CameraStreamService.getInstance()?.localUpdateVideoConfig(res, state.fps, state.bitrateKbps)
                        }
                    )
                }
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(
                        text = "Frame Rate",
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    ExpressiveSegmentedPills(
                        options = listOf("15 fps", "24 fps", "30 fps"),
                        selected = "${state.fps} fps",
                        onSelect = { choice ->
                            val fps = choice.substringBefore(" ").toIntOrNull() ?: 24
                            CameraStreamService.getInstance()?.localUpdateVideoConfig(state.resolution, fps, state.bitrateKbps)
                        }
                    )
                }
                var bitrateSlider by remember(state.bitrateKbps) {
                    mutableFloatStateOf(state.bitrateKbps.toFloat().coerceIn(800f, 4000f))
                }
                Column {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween
                    ) {
                        Text(
                            text = "Target Bitrate",
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                        Text(
                            text = "${bitrateSlider.roundToInt()} kbps",
                            style = MaterialTheme.typography.labelLarge,
                            color = MaterialTheme.colorScheme.primary
                        )
                    }
                    Slider(
                        value = bitrateSlider,
                        onValueChange = { bitrateSlider = (it / 200f).roundToInt() * 200f },
                        onValueChangeFinished = {
                            CameraStreamService.getInstance()?.localUpdateVideoConfig(
                                state.resolution,
                                state.fps,
                                bitrateSlider.roundToInt()
                            )
                        },
                        valueRange = 800f..4000f
                    )
                }
            }
        }

        // Audio, Auto-start & Mode Switch Card
        Surface(
            color = MaterialTheme.colorScheme.surfaceContainerLow,
            shape = RoundedCornerShape(28.dp),
            modifier = Modifier.fillMaxWidth()
        ) {
            Column(
                modifier = Modifier.padding(20.dp),
                verticalArrangement = Arrangement.spacedBy(14.dp)
            ) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween
                ) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(10.dp)
                    ) {
                        Icon(Icons.Rounded.Mic, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
                        Column {
                            Text("Camera Microphone", style = MaterialTheme.typography.titleMedium)
                            Text(
                                "Stream room audio to viewers",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                    }
                    Switch(
                        checked = state.micEnabled,
                        onCheckedChange = { CameraStreamService.getInstance()?.localSetMic(it) }
                    )
                }

                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween
                ) {
                    Column(modifier = Modifier.weight(1f)) {
                        Text("Auto-start Camera Mode", style = MaterialTheme.typography.titleMedium)
                        Text(
                            "Start streaming immediately when app opens",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                    Switch(
                        checked = autoStart,
                        onCheckedChange = onAutoStartChanged
                    )
                }

                FilledTonalButton(
                    onClick = onSwitchMode,
                    shape = RoundedCornerShape(999.dp),
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Icon(Icons.Rounded.SwapHoriz, contentDescription = null, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(8.dp))
                    Text("Switch Mode / Back to Home")
                }
            }
        }
    }
}

@Composable
private fun LocalCameraPreviewView(
    modifier: Modifier = Modifier,
    videoReady: Boolean,
    isFront: Boolean
) {
    val service = CameraStreamService.getInstance()
    val eglContext = remember(service, videoReady) {
        if (videoReady) service?.getEglBaseContext() else null
    }

    if (eglContext == null) {
        Box(modifier = modifier.background(Color.Black), contentAlignment = Alignment.Center) {
            Text(
                text = "Starting camera...",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
        return
    }

    val rendererRef = remember { mutableStateOf<SurfaceViewRenderer?>(null) }

    DisposableEffect(service, eglContext) {
        onDispose {
            service?.attachLocalPreview(null)
            rendererRef.value?.release()
            rendererRef.value = null
        }
    }

    AndroidView(
        modifier = modifier,
        factory = { ctx ->
            SurfaceViewRenderer(ctx).apply {
                init(eglContext, null)
                setScalingType(RendererCommon.ScalingType.SCALE_ASPECT_FILL)
                setEnableHardwareScaler(true)
                setMirror(isFront)
                rendererRef.value = this
                service?.attachLocalPreview(this)
            }
        },
        update = { view ->
            view.setMirror(isFront)
        }
    )
}

@Composable
private fun AmoledBlackoutOverlay(
    batteryPct: Int?,
    batteryTempC: Float?,
    viewerCount: Int,
    wsConnected: Boolean,
    rootDisplayOff: Boolean,
    onUnlock: () -> Unit
) {
    val scope = rememberCoroutineScope()
    var holdProgress by remember { mutableFloatStateOf(0f) }
    var tapCount by remember { mutableIntStateOf(0) }
    var lastTapTimeMs by remember { mutableLongStateOf(0L) }

    var driftIndex by remember { mutableIntStateOf(0) }
    LaunchedEffect(Unit) {
        while (true) {
            delay(60_000L)
            driftIndex = (driftIndex + 1) % 6
        }
    }
    val driftOffsets = listOf(
        IntOffset(0, -120),
        IntOffset(45, -40),
        IntOffset(-40, 50),
        IntOffset(30, 120),
        IntOffset(-45, -70),
        IntOffset(0, 0)
    )
    val accent = MaterialTheme.colorScheme.primary

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(PurrStatusColors.PureBlack)
            .pointerInput(Unit) {
                awaitEachGesture {
                    awaitFirstDown(requireUnconsumed = false)
                    val holdJob: Job = scope.launch {
                        val totalMs = 1500L
                        val stepMs = 30L
                        var elapsed = 0L
                        while (elapsed < totalMs) {
                            delay(stepMs)
                            elapsed += stepMs
                            holdProgress = (elapsed.toFloat() / totalMs).coerceIn(0f, 1f)
                        }
                        holdProgress = 0f
                        onUnlock()
                    }

                    val up = waitForUpOrCancellation()
                    if (holdJob.isActive) {
                        holdJob.cancel()
                        holdProgress = 0f
                        if (up != null) {
                            val now = System.currentTimeMillis()
                            if (now - lastTapTimeMs <= 600L) {
                                tapCount++
                            } else {
                                tapCount = 1
                            }
                            lastTapTimeMs = now
                            if (tapCount >= 3) {
                                tapCount = 0
                                onUnlock()
                            }
                        }
                    }
                }
            },
        contentAlignment = Alignment.Center
    ) {
        if (holdProgress > 0.04f) {
            Box(contentAlignment = Alignment.Center) {
                Canvas(modifier = Modifier.size(96.dp)) {
                    drawArc(
                        color = accent.copy(alpha = 0.25f),
                        startAngle = 0f,
                        sweepAngle = 360f,
                        useCenter = false,
                        style = Stroke(width = 6.dp.toPx())
                    )
                    drawArc(
                        color = accent,
                        startAngle = -90f,
                        sweepAngle = 360f * holdProgress,
                        useCenter = false,
                        style = Stroke(width = 6.dp.toPx(), cap = StrokeCap.Round)
                    )
                }
                Text(
                    text = "Wake",
                    color = accent,
                    fontSize = 14.sp,
                    fontWeight = FontWeight.SemiBold
                )
            }
        } else if (!rootDisplayOff) {
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                modifier = Modifier.offset { driftOffsets[driftIndex] }
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    Box(
                        modifier = Modifier
                            .size(6.dp)
                            .clip(CircleShape)
                            .background(
                                (if (wsConnected) PurrStatusColors.Live else PurrStatusColors.Warning)
                                    .copy(alpha = 0.25f)
                            )
                    )
                    val bat = batteryPct?.let { "$it%" } ?: "—"
                    val tmp = batteryTempC?.let { String.format(Locale.US, "%.1f°C", it) } ?: ""
                    val vLabel = if (viewerCount == 1) "1 viewer" else "$viewerCount viewers"
                    Text(
                        text = "PurrCam · $bat $tmp · $vLabel",
                        color = Color.White.copy(alpha = 0.14f),
                        fontSize = 11.sp,
                        fontFamily = FontFamily.Monospace
                    )
                }
                Spacer(Modifier.height(6.dp))
                Text(
                    text = "Hold 1.5s or triple-tap to wake",
                    color = Color.White.copy(alpha = 0.10f),
                    fontSize = 10.sp
                )
            }
        }
    }
}
