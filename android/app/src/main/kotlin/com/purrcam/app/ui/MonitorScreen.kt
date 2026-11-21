package com.purrcam.app.ui

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.LruCache
import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.wrapContentSize
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.VolumeOff
import androidx.compose.material.icons.automirrored.rounded.VolumeUp
import androidx.compose.material.icons.rounded.AspectRatio
import androidx.compose.material.icons.rounded.BatteryChargingFull
import androidx.compose.material.icons.rounded.CameraAlt
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.CropFree
import androidx.compose.material.icons.rounded.DarkMode
import androidx.compose.material.icons.rounded.Delete
import androidx.compose.material.icons.rounded.Download
import androidx.compose.material.icons.rounded.FlashlightOff
import androidx.compose.material.icons.rounded.FlashlightOn
import androidx.compose.material.icons.rounded.Fullscreen
import androidx.compose.material.icons.rounded.FullscreenExit
import androidx.compose.material.icons.rounded.Link
import androidx.compose.material.icons.rounded.Memory
import androidx.compose.material.icons.rounded.Mic
import androidx.compose.material.icons.rounded.MicOff
import androidx.compose.material.icons.rounded.MusicNote
import androidx.compose.material.icons.rounded.NotificationsActive
import androidx.compose.material.icons.rounded.Pets
import androidx.compose.material.icons.rounded.PhotoLibrary
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.Settings
import androidx.compose.material.icons.rounded.Shield
import androidx.compose.material.icons.rounded.Smartphone
import androidx.compose.material.icons.rounded.SwapHoriz
import androidx.compose.material.icons.rounded.Thermostat
import androidx.compose.material.icons.rounded.Tune
import androidx.compose.material.icons.rounded.Videocam
import androidx.compose.material.icons.rounded.Wifi
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.FilledTonalIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Slider
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.purrcam.app.monitor.MonitorClient
import com.purrcam.app.monitor.MonitorUiState
import com.purrcam.app.protocol.SnapshotMeta
import com.purrcam.app.ui.components.ConnectServerBottomSheet
import com.purrcam.app.ui.components.ExpressiveLensDock
import com.purrcam.app.ui.components.ExpressiveSegmentedPills
import com.purrcam.app.ui.components.HealthMetricCard
import com.purrcam.app.ui.components.formatDurationShort
import com.purrcam.app.ui.theme.PurrStatusColors
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import org.webrtc.RendererCommon
import org.webrtc.SurfaceViewRenderer
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.math.roundToInt

private enum class MonitorTab(val label: String) {
    LIVE("Live"),
    DEVICE("Device"),
    GALLERY("Gallery"),
    SETTINGS("Settings")
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MonitorScreen(
    localServerUrl: String,
    remoteServerUrl: String,
    authToken: String,
    onSaveConnection: (localUrl: String, remoteUrl: String, token: String) -> Unit,
    onExit: () -> Unit,
    onRequestMicPermission: () -> Unit,
    onFullscreenChanged: (Boolean) -> Unit
) {
    val context = LocalContext.current
    val client = remember { MonitorClient(context) }
    val ui by client.uiState.collectAsState()

    var activeTab by remember { mutableStateOf(MonitorTab.LIVE) }
    var fullscreen by remember { mutableStateOf(false) }
    var fitMode by remember { mutableStateOf(true) } // true = SCALE_ASPECT_FIT, false = SCALE_ASPECT_FILL
    var showControlsSheet by remember { mutableStateOf(false) }
    var showConnectSheet by remember { mutableStateOf(false) }

    val bitmapCache = remember {
        object : LruCache<String, Bitmap>(24) {}
    }

    DisposableEffect(Unit) {
        client.start(localServerUrl, remoteServerUrl, authToken)
        onDispose {
            onFullscreenChanged(false)
            client.stop()
        }
    }

    LaunchedEffect(fullscreen) {
        onFullscreenChanged(fullscreen)
    }

    LaunchedEffect(activeTab) {
        if (activeTab == MonitorTab.GALLERY) {
            client.refreshSnapshots()
        }
    }

    LaunchedEffect(ui.toastMessage) {
        if (ui.toastMessage != null) {
            delay(2800L)
            client.clearToast()
        }
    }

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        bottomBar = {
            if (!fullscreen) {
                NavigationBar(
                    containerColor = MaterialTheme.colorScheme.surfaceContainerLow,
                    tonalElevation = 0.dp
                ) {
                    NavigationBarItem(
                        selected = activeTab == MonitorTab.LIVE,
                        onClick = { activeTab = MonitorTab.LIVE },
                        icon = { Icon(Icons.Rounded.Videocam, contentDescription = "Live") },
                        label = { Text("Live") }
                    )
                    NavigationBarItem(
                        selected = activeTab == MonitorTab.DEVICE,
                        onClick = { activeTab = MonitorTab.DEVICE },
                        icon = { Icon(Icons.Rounded.Smartphone, contentDescription = "Device") },
                        label = { Text("Device") }
                    )
                    NavigationBarItem(
                        selected = activeTab == MonitorTab.GALLERY,
                        onClick = { activeTab = MonitorTab.GALLERY },
                        icon = { Icon(Icons.Rounded.PhotoLibrary, contentDescription = "Gallery") },
                        label = { Text("Gallery") }
                    )
                    NavigationBarItem(
                        selected = activeTab == MonitorTab.SETTINGS,
                        onClick = { activeTab = MonitorTab.SETTINGS },
                        icon = { Icon(Icons.Rounded.Settings, contentDescription = "Settings") },
                        label = { Text("Settings") }
                    )
                }
            }
        }
    ) { innerPadding ->
        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(bottom = if (fullscreen) 0.dp else innerPadding.calculateBottomPadding())
        ) {
            when (activeTab) {
                MonitorTab.LIVE -> MonitorLiveTab(
                    client = client,
                    ui = ui,
                    fitMode = fitMode,
                    fullscreen = fullscreen,
                    onToggleFit = { fitMode = !fitMode },
                    onToggleFullscreen = { fullscreen = !fullscreen },
                    onToggleTalkback = {
                        if (!ui.talkbackActive) onRequestMicPermission()
                        client.setTalkbackActive(!ui.talkbackActive)
                    },
                    onOpenControls = { showControlsSheet = true }
                )

                MonitorTab.DEVICE -> MonitorDeviceTab(client = client, ui = ui)

                MonitorTab.GALLERY -> MonitorGalleryTab(
                    client = client,
                    ui = ui,
                    bitmapCache = bitmapCache
                )

                MonitorTab.SETTINGS -> MonitorSettingsTab(
                    ui = ui,
                    localServerUrl = localServerUrl,
                    remoteServerUrl = remoteServerUrl,
                    authToken = authToken,
                    onOpenConnectSheet = { showConnectSheet = true },
                    onSwitchMode = onExit
                )
            }

            // Expressive Floating Toast
            ui.toastMessage?.let { msg ->
                Surface(
                    color = MaterialTheme.colorScheme.inverseSurface,
                    shape = RoundedCornerShape(999.dp),
                    shadowElevation = 6.dp,
                    modifier = Modifier
                        .align(Alignment.TopCenter)
                        .statusBarsPadding()
                        .padding(top = 64.dp, start = 24.dp, end = 24.dp)
                ) {
                    Text(
                        text = msg,
                        style = MaterialTheme.typography.labelLarge,
                        color = MaterialTheme.colorScheme.inverseOnSurface,
                        modifier = Modifier.padding(horizontal = 18.dp, vertical = 10.dp)
                    )
                }
            }
        }
    }

    // Clean Controls ModalBottomSheet (Torch, EV Exposure, Zoom, Cat Sounds)
    if (showControlsSheet) {
        val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
        val cam = ui.camera
        val camState = cam?.state
        ModalBottomSheet(
            onDismissRequest = { showControlsSheet = false },
            sheetState = sheetState,
            containerColor = MaterialTheme.colorScheme.surfaceContainer,
            shape = RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp)
        ) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 24.dp)
                    .padding(bottom = 28.dp),
                verticalArrangement = Arrangement.spacedBy(18.dp)
            ) {
                Text(
                    text = "Camera Controls",
                    style = MaterialTheme.typography.headlineSmall,
                    color = MaterialTheme.colorScheme.onSurface
                )

                // Cat Sounds Row
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(
                        text = "Call Your Cat",
                        style = MaterialTheme.typography.labelLarge,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(10.dp)
                    ) {
                        CatCueButton(
                            modifier = Modifier.weight(1f),
                            icon = Icons.Rounded.Pets,
                            label = "Psps",
                            onClick = { client.playSound("psps") }
                        )
                        CatCueButton(
                            modifier = Modifier.weight(1f),
                            icon = Icons.Rounded.NotificationsActive,
                            label = "Chime",
                            onClick = { client.playSound("chime") }
                        )
                        CatCueButton(
                            modifier = Modifier.weight(1f),
                            icon = Icons.Rounded.MusicNote,
                            label = "Whistle",
                            onClick = { client.playSound("whistle") }
                        )
                    }
                }

                // Torch toggle row
                Surface(
                    color = MaterialTheme.colorScheme.surfaceContainerLow,
                    shape = RoundedCornerShape(20.dp),
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 16.dp, vertical = 12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.SpaceBetween
                    ) {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(12.dp)
                        ) {
                            Icon(
                                imageVector = if (camState?.torch == true) Icons.Rounded.FlashlightOn else Icons.Rounded.FlashlightOff,
                                contentDescription = null,
                                tint = MaterialTheme.colorScheme.primary
                            )
                            Text("Flashlight Torch", style = MaterialTheme.typography.titleMedium)
                        }
                        Switch(
                            checked = camState?.torch == true,
                            onCheckedChange = { client.setTorch(it) }
                        )
                    }
                }

                // Exposure EV slider
                if (camState != null) {
                    var evVal by remember(camState.ev) { mutableFloatStateOf(camState.ev) }
                    Column {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween
                        ) {
                            Text(
                                "Night Exposure (EV)",
                                style = MaterialTheme.typography.labelLarge,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                            Text(
                                String.format(Locale.US, "%+.1f EV", evVal),
                                style = MaterialTheme.typography.labelLarge,
                                color = MaterialTheme.colorScheme.primary
                            )
                        }
                        Slider(
                            value = evVal,
                            onValueChange = { evVal = (it * 2f).roundToInt() / 2f },
                            onValueChangeFinished = { client.setExposure(evVal) },
                            valueRange = -2f..2f
                        )
                    }

                    // Camera2 Zoom slider
                    val activeLens = cam.lenses.firstOrNull { it.id == camState.activeLensId }
                    val maxZ = (activeLens?.maxZoom ?: 4f).coerceIn(1.5f, 8f)
                    var zoomVal by remember(camState.zoomRatio) {
                        mutableFloatStateOf(camState.zoomRatio.coerceIn(1f, maxZ))
                    }
                    Column {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween
                        ) {
                            Text(
                                "Camera Zoom",
                                style = MaterialTheme.typography.labelLarge,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                            Text(
                                String.format(Locale.US, "%.1f×", zoomVal),
                                style = MaterialTheme.typography.labelLarge,
                                color = MaterialTheme.colorScheme.primary
                            )
                        }
                        Slider(
                            value = zoomVal,
                            onValueChange = { zoomVal = (it * 10f).roundToInt() / 10f },
                            onValueChangeFinished = { client.setZoom(zoomVal) },
                            valueRange = 1f..maxZ
                        )
                    }
                }
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
                client.reconnectWith(local, remote, tok)
            }
        )
    }
}

@Composable
private fun MonitorLiveTab(
    client: MonitorClient,
    ui: MonitorUiState,
    fitMode: Boolean,
    fullscreen: Boolean,
    onToggleFit: () -> Unit,
    onToggleFullscreen: () -> Unit,
    onToggleTalkback: () -> Unit,
    onOpenControls: () -> Unit
) {
    var viewScale by remember { mutableFloatStateOf(1f) }
    var viewOffset by remember { mutableStateOf(Offset.Zero) }
    val cam = ui.camera
    val camState = cam?.state
    val tel = ui.telemetry

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color.Black)
            .pointerInput(Unit) {
                detectTransformGestures { _, pan, zoom, _ ->
                    val nextScale = (viewScale * zoom).coerceIn(1f, 4f)
                    viewScale = nextScale
                    viewOffset = if (nextScale <= 1.01f) {
                        Offset.Zero
                    } else {
                        Offset(
                            (viewOffset.x + pan.x).coerceIn(-600f, 600f),
                            (viewOffset.y + pan.y).coerceIn(-600f, 600f)
                        )
                    }
                }
            }
            .pointerInput(Unit) {
                detectTapGestures(
                    onDoubleTap = {
                        viewScale = 1f
                        viewOffset = Offset.Zero
                    }
                )
            }
    ) {
        // Properly-oriented WebRTC SurfaceViewRenderer (Fit = zero crop, Fill = edge-to-edge)
        MonitorVideoView(
            client = client,
            fitMode = fitMode,
            modifier = Modifier
                .fillMaxSize()
                .graphicsLayer(
                    scaleX = viewScale,
                    scaleY = viewScale,
                    translationX = viewOffset.x,
                    translationY = viewOffset.y
                )
        )

        // Waiting / Offline state
        if (!ui.cameraOnline || !ui.rtcConnected) {
            Surface(
                color = MaterialTheme.colorScheme.surfaceContainerHigh.copy(alpha = 0.88f),
                shape = RoundedCornerShape(24.dp),
                modifier = Modifier.align(Alignment.Center)
            ) {
                Column(
                    modifier = Modifier.padding(horizontal = 24.dp, vertical = 18.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    Icon(
                        Icons.Rounded.Pets,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.primary,
                        modifier = Modifier.size(32.dp)
                    )
                    Text(
                        text = when {
                            !ui.wsConnected -> ui.statusText
                            !ui.cameraOnline -> "Waiting for camera..."
                            else -> "Connecting WebRTC video..."
                        },
                        style = MaterialTheme.typography.titleMedium,
                        color = MaterialTheme.colorScheme.onSurface
                    )
                }
            }
        }

        // Subtle scrims
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(110.dp)
                .align(Alignment.TopCenter)
                .background(Brush.verticalGradient(listOf(Color.Black.copy(alpha = 0.55f), Color.Transparent)))
        )
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(200.dp)
                .align(Alignment.BottomCenter)
                .background(Brush.verticalGradient(listOf(Color.Transparent, Color.Black.copy(alpha = 0.72f))))
        )

        // Compact Top Live Pill + Fit/Fill & Fullscreen buttons
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .align(Alignment.TopCenter)
                .statusBarsPadding()
                .padding(horizontal = 14.dp, vertical = 10.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Surface(
                color = MaterialTheme.colorScheme.surfaceContainerHigh.copy(alpha = 0.80f),
                shape = RoundedCornerShape(999.dp)
            ) {
                Row(
                    modifier = Modifier.padding(horizontal = 12.dp, vertical = 7.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    Box(
                        modifier = Modifier
                            .size(8.dp)
                            .clip(CircleShape)
                            .background(
                                when {
                                    ui.rtcConnected -> PurrStatusColors.Live
                                    ui.cameraOnline -> PurrStatusColors.Warning
                                    else -> PurrStatusColors.Danger
                                }
                            )
                    )
                    val summaryText = buildString {
                        append(if (ui.rtcConnected) "LIVE" else if (ui.cameraOnline) "LINKING" else "OFFLINE")
                        if (tel != null) {
                            append(" · ${tel.batteryPct}%")
                            append(" · ${String.format(Locale.US, "%.0f°C", tel.batteryTempC)}")
                        }
                    }
                    Text(
                        text = summaryText,
                        style = MaterialTheme.typography.labelLarge.copy(fontFeatureSettings = "tnum"),
                        color = MaterialTheme.colorScheme.onSurface
                    )
                    Surface(
                        color = MaterialTheme.colorScheme.secondaryContainer.copy(alpha = 0.9f),
                        shape = RoundedCornerShape(999.dp)
                    ) {
                        Text(
                            text = ui.activeRoute,
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSecondaryContainer,
                            modifier = Modifier.padding(horizontal = 7.dp, vertical = 2.dp)
                        )
                    }
                }
            }

            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Surface(
                    color = MaterialTheme.colorScheme.surfaceContainerHigh.copy(alpha = 0.80f),
                    shape = CircleShape
                ) {
                    IconButton(onClick = onToggleFit, modifier = Modifier.size(38.dp)) {
                        Icon(
                            imageVector = if (fitMode) Icons.Rounded.CropFree else Icons.Rounded.AspectRatio,
                            contentDescription = if (fitMode) "Fill screen" else "Fit video",
                            tint = MaterialTheme.colorScheme.onSurface,
                            modifier = Modifier.size(19.dp)
                        )
                    }
                }
                Surface(
                    color = MaterialTheme.colorScheme.surfaceContainerHigh.copy(alpha = 0.80f),
                    shape = CircleShape
                ) {
                    IconButton(onClick = onToggleFullscreen, modifier = Modifier.size(38.dp)) {
                        Icon(
                            imageVector = if (fullscreen) Icons.Rounded.FullscreenExit else Icons.Rounded.Fullscreen,
                            contentDescription = "Fullscreen",
                            tint = MaterialTheme.colorScheme.onSurface,
                            modifier = Modifier.size(19.dp)
                        )
                    }
                }
            }
        }

        // Bottom Floating Lens Dock + Expressive Toolbar
        Column(
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .padding(horizontal = 16.dp, vertical = 18.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            val lenses = cam?.lenses.orEmpty()
            if (lenses.isNotEmpty() && camState != null) {
                ExpressiveLensDock(
                    lenses = lenses,
                    activeLensId = camState.activeLensId,
                    onSelectLens = { client.switchLens(it) }
                )
            }

            Surface(
                color = MaterialTheme.colorScheme.surfaceContainerHigh.copy(alpha = 0.90f),
                shape = RoundedCornerShape(999.dp),
                tonalElevation = 6.dp
            ) {
                Row(
                    modifier = Modifier.padding(horizontal = 8.dp, vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    // Talkback primary pill
                    val talkBg by animateColorAsState(
                        targetValue = if (ui.talkbackActive) PurrStatusColors.Live
                        else MaterialTheme.colorScheme.primaryContainer,
                        label = "talkBg"
                    )
                    val talkFg by animateColorAsState(
                        targetValue = if (ui.talkbackActive) Color(0xFF04140E)
                        else MaterialTheme.colorScheme.onPrimaryContainer,
                        label = "talkFg"
                    )
                    Button(
                        onClick = onToggleTalkback,
                        colors = ButtonDefaults.buttonColors(containerColor = talkBg, contentColor = talkFg),
                        shape = RoundedCornerShape(999.dp),
                        modifier = Modifier.height(46.dp)
                    ) {
                        Icon(
                            imageVector = if (ui.talkbackActive) Icons.Rounded.Mic else Icons.Rounded.MicOff,
                            contentDescription = "Talk",
                            modifier = Modifier.size(18.dp)
                        )
                        Spacer(Modifier.width(6.dp))
                        Text(if (ui.talkbackActive) "Live Mic" else "Talk")
                    }

                    // Snapshot button
                    FilledTonalIconButton(
                        onClick = { client.requestSnapshot(saveToGallery = true) },
                        colors = IconButtonDefaults.filledTonalIconButtonColors(
                            containerColor = MaterialTheme.colorScheme.surfaceContainerHighest
                        ),
                        modifier = Modifier.size(46.dp)
                    ) {
                        Icon(Icons.Rounded.CameraAlt, contentDescription = "Snapshot")
                    }

                    // Mute audio button
                    FilledTonalIconButton(
                        onClick = { client.toggleRemoteMute() },
                        colors = IconButtonDefaults.filledTonalIconButtonColors(
                            containerColor = if (ui.remoteAudioMuted) MaterialTheme.colorScheme.errorContainer
                            else MaterialTheme.colorScheme.surfaceContainerHighest,
                            contentColor = if (ui.remoteAudioMuted) MaterialTheme.colorScheme.onErrorContainer
                            else MaterialTheme.colorScheme.onSurface
                        ),
                        modifier = Modifier.size(46.dp)
                    ) {
                        Icon(
                            imageVector = if (ui.remoteAudioMuted) Icons.AutoMirrored.Rounded.VolumeOff
                            else Icons.AutoMirrored.Rounded.VolumeUp,
                            contentDescription = "Mute"
                        )
                    }

                    // Controls sheet button (Torch, EV, Zoom, Cat Sounds)
                    FilledTonalIconButton(
                        onClick = onOpenControls,
                        colors = IconButtonDefaults.filledTonalIconButtonColors(
                            containerColor = MaterialTheme.colorScheme.surfaceContainerHighest
                        ),
                        modifier = Modifier.size(46.dp)
                    ) {
                        Icon(Icons.Rounded.Tune, contentDescription = "Controls")
                    }
                }
            }
        }
    }
}

@Composable
private fun MonitorDeviceTab(client: MonitorClient, ui: MonitorUiState) {
    val cam = ui.camera
    val state = cam?.state
    val tel = ui.telemetry

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
                text = cam?.deviceName ?: "Camera Device",
                style = MaterialTheme.typography.headlineMedium,
                color = MaterialTheme.colorScheme.onBackground
            )
            Text(
                text = if (ui.cameraOnline) "Online · ${ui.activeRoute} route" else "Camera offline",
                style = MaterialTheme.typography.bodyMedium,
                color = if (ui.cameraOnline) PurrStatusColors.Live else MaterialTheme.colorScheme.onSurfaceVariant
            )
        }

        // Battery & Thermal Overview
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            HealthMetricCard(
                title = "Battery",
                value = if (tel != null) "${tel.batteryPct}%" else "—",
                subtitle = when {
                    tel == null -> "No data"
                    tel.chargePaused -> "Paused (Guard)"
                    tel.charging -> "+${tel.currentMa} mA (${tel.chargeSource})"
                    else -> "${tel.currentMa} mA"
                },
                icon = Icons.Rounded.BatteryChargingFull,
                accentColor = if ((tel?.batteryPct ?: 100) <= 15) PurrStatusColors.Danger else PurrStatusColors.Live,
                modifier = Modifier.weight(1f)
            )
            HealthMetricCard(
                title = "Thermals",
                value = if (tel != null) String.format(Locale.US, "%.1f°C", tel.batteryTempC) else "—",
                subtitle = if (tel?.cpuTempC != null) String.format(Locale.US, "CPU %.1f°C", tel.cpuTempC) else "Battery",
                icon = Icons.Rounded.Thermostat,
                accentColor = if ((tel?.batteryTempC ?: 0f) >= 43f) PurrStatusColors.Danger else MaterialTheme.colorScheme.primary,
                modifier = Modifier.weight(1f)
            )
        }

        // Remote AMOLED Blackout & Display Card
        if (state != null) {
            Surface(
                color = MaterialTheme.colorScheme.surfaceContainerLow,
                shape = RoundedCornerShape(28.dp),
                modifier = Modifier.fillMaxWidth()
            ) {
                Column(
                    modifier = Modifier.padding(20.dp),
                    verticalArrangement = Arrangement.spacedBy(14.dp)
                ) {
                    Text("Display & Stealth", style = MaterialTheme.typography.titleMedium)

                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.SpaceBetween
                    ) {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(10.dp),
                            modifier = Modifier.weight(1f)
                        ) {
                            Icon(Icons.Rounded.DarkMode, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
                            Column {
                                Text("AMOLED Blackout", style = MaterialTheme.typography.titleMedium)
                                Text(
                                    "Turn phone screen pitch black (#000000)",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant
                                )
                            }
                        }
                        Switch(
                            checked = state.blackout,
                            onCheckedChange = { enabled ->
                                client.setBlackout(enabled, rootDisplayOff = enabled && state.rootDisplayOff)
                            }
                        )
                    }

                    if (cam.capabilities.rootDisplayOff) {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.SpaceBetween
                        ) {
                            Column(modifier = Modifier.weight(1f)) {
                                Text("Root 0-nit Backlight Off", style = MaterialTheme.typography.titleMedium)
                                Text(
                                    "Hardware backlight off while blackout is active",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant
                                )
                            }
                            Switch(
                                checked = state.rootDisplayOff,
                                onCheckedChange = { rootOff ->
                                    client.setBlackout(enabled = rootOff || state.blackout, rootDisplayOff = rootOff)
                                }
                            )
                        }
                    }
                }
            }

            // Root 80% Charge Guard Card
            Surface(
                color = MaterialTheme.colorScheme.surfaceContainerLow,
                shape = RoundedCornerShape(28.dp),
                modifier = Modifier.fillMaxWidth()
            ) {
                Column(
                    modifier = Modifier.padding(20.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp)
                ) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.SpaceBetween
                    ) {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(10.dp),
                            modifier = Modifier.weight(1f)
                        ) {
                            Icon(Icons.Rounded.Shield, contentDescription = null, tint = MaterialTheme.colorScheme.secondary)
                            Column {
                                Text("Root Battery Guard", style = MaterialTheme.typography.titleMedium)
                                Text(
                                    if (cam.capabilities.chargeLimit) "Cap charging at ${state.chargeLimitMaxPct}%"
                                    else "Root required on camera device",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant
                                )
                            }
                        }
                        Switch(
                            checked = state.chargeLimitEnabled,
                            enabled = cam.capabilities.chargeLimit,
                            onCheckedChange = { client.setChargeLimit(it, state.chargeLimitMaxPct) }
                        )
                    }

                    if (cam.capabilities.chargeLimit) {
                        var limitSlider by remember(state.chargeLimitMaxPct) {
                            mutableFloatStateOf(state.chargeLimitMaxPct.toFloat())
                        }
                        Slider(
                            value = limitSlider,
                            onValueChange = { limitSlider = (it / 5f).roundToInt() * 5f },
                            onValueChangeFinished = {
                                client.setChargeLimit(state.chargeLimitEnabled, limitSlider.roundToInt())
                            },
                            valueRange = 60f..90f,
                            steps = 5
                        )
                    }
                }
            }

            // Stream Quality & Pipeline Restart
            Surface(
                color = MaterialTheme.colorScheme.surfaceContainerLow,
                shape = RoundedCornerShape(28.dp),
                modifier = Modifier.fillMaxWidth()
            ) {
                Column(
                    modifier = Modifier.padding(20.dp),
                    verticalArrangement = Arrangement.spacedBy(14.dp)
                ) {
                    Text("Stream Quality", style = MaterialTheme.typography.titleMedium)
                    ExpressiveSegmentedPills(
                        options = listOf("480p", "720p", "1080p"),
                        selected = state.resolution,
                        onSelect = { client.setVideoConfig(resolution = it) }
                    )
                    ExpressiveSegmentedPills(
                        options = listOf("15 fps", "24 fps", "30 fps"),
                        selected = "${state.fps} fps",
                        onSelect = { choice ->
                            val fps = choice.substringBefore(" ").toIntOrNull() ?: 24
                            client.setVideoConfig(fps = fps)
                        }
                    )
                    FilledTonalButton(
                        onClick = { client.rebootCamera() },
                        shape = RoundedCornerShape(999.dp),
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Icon(Icons.Rounded.Refresh, contentDescription = null, modifier = Modifier.size(18.dp))
                        Spacer(Modifier.width(8.dp))
                        Text("Restart Camera Pipeline")
                    }
                }
            }
        }

        // Wi-Fi & Uptime
        if (tel != null) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(12.dp)
            ) {
                HealthMetricCard(
                    title = "Wi-Fi",
                    value = tel.wifiRssi?.let { "$it dBm" } ?: "LAN",
                    subtitle = "${tel.fps ?: 0} fps · ${tel.bitrateKbps ?: 0} kbps",
                    icon = Icons.Rounded.Wifi,
                    accentColor = MaterialTheme.colorScheme.tertiary,
                    modifier = Modifier.weight(1f)
                )
                HealthMetricCard(
                    title = "Uptime",
                    value = formatDurationShort(tel.uptimeSec),
                    subtitle = "${tel.freeRamMb} MB RAM free",
                    icon = Icons.Rounded.Memory,
                    accentColor = MaterialTheme.colorScheme.secondary,
                    modifier = Modifier.weight(1f)
                )
            }
        }
    }
}

@Composable
private fun MonitorGalleryTab(
    client: MonitorClient,
    ui: MonitorUiState,
    bitmapCache: LruCache<String, Bitmap>
) {
    var selectedSnapshot by remember { mutableStateOf<SnapshotMeta?>(null) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .statusBarsPadding()
            .padding(horizontal = 20.dp, vertical = 18.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp)
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Column {
                Text(
                    text = "Gallery",
                    style = MaterialTheme.typography.headlineMedium,
                    color = MaterialTheme.colorScheme.onBackground
                )
                Text(
                    text = "${ui.snapshots.size} snapshots on server",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilledTonalIconButton(onClick = { client.refreshSnapshots() }) {
                    Icon(Icons.Rounded.Refresh, contentDescription = "Refresh")
                }
                FilledTonalButton(
                    onClick = { client.requestSnapshot(saveToGallery = false) },
                    shape = RoundedCornerShape(999.dp)
                ) {
                    Icon(Icons.Rounded.CameraAlt, contentDescription = null, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(6.dp))
                    Text("Snap")
                }
            }
        }

        if (ui.snapshotsLoading && ui.snapshots.isEmpty()) {
            Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                CircularProgressIndicator()
            }
        } else if (ui.snapshots.isEmpty()) {
            Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Column(
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(10.dp)
                ) {
                    Icon(
                        Icons.Rounded.PhotoLibrary,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.size(44.dp)
                    )
                    Text("No snapshots yet", style = MaterialTheme.typography.titleMedium)
                    Text(
                        "Tap Snap above or capture from the Live tab",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
        } else {
            LazyVerticalGrid(
                columns = GridCells.Fixed(2),
                contentPadding = PaddingValues(bottom = 16.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
                modifier = Modifier.fillMaxSize()
            ) {
                items(ui.snapshots, key = { it.id }) { snap ->
                    SnapshotGridItem(
                        meta = snap,
                        client = client,
                        cache = bitmapCache,
                        onClick = { selectedSnapshot = snap }
                    )
                }
            }
        }
    }

    selectedSnapshot?.let { snap ->
        SnapshotLightboxDialog(
            meta = snap,
            client = client,
            cache = bitmapCache,
            onDismiss = { selectedSnapshot = null },
            onSave = { client.saveSnapshotToPhoneGallery(snap) },
            onDelete = {
                client.deleteSnapshot(snap.id)
                selectedSnapshot = null
            }
        )
    }
}

@Composable
private fun SnapshotGridItem(
    meta: SnapshotMeta,
    client: MonitorClient,
    cache: LruCache<String, Bitmap>,
    onClick: () -> Unit
) {
    var bitmap by remember(meta.id) { mutableStateOf(cache.get(meta.id)) }
    val dateFormat = remember { SimpleDateFormat("MMM d, HH:mm", Locale.US) }

    LaunchedEffect(meta.id) {
        if (bitmap == null) {
            val bytes = client.fetchSnapshotBytes(meta)
            if (bytes != null) {
                val decoded = withContext(Dispatchers.Default) {
                    BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
                }
                if (decoded != null) {
                    cache.put(meta.id, decoded)
                    bitmap = decoded
                }
            }
        }
    }

    Surface(
        color = MaterialTheme.colorScheme.surfaceContainerLow,
        shape = RoundedCornerShape(22.dp),
        modifier = Modifier
            .fillMaxWidth()
            .aspectRatio(0.9f)
            .clip(RoundedCornerShape(22.dp))
            .clickable(onClick = onClick)
    ) {
        Box(modifier = Modifier.fillMaxSize()) {
            val bmp = bitmap
            if (bmp != null) {
                Image(
                    bitmap = bmp.asImageBitmap(),
                    contentDescription = meta.lensLabel ?: "Snapshot",
                    contentScale = ContentScale.Crop,
                    modifier = Modifier.fillMaxSize()
                )
            } else {
                Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(modifier = Modifier.size(22.dp), strokeWidth = 2.dp)
                }
            }

            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(64.dp)
                    .align(Alignment.BottomCenter)
                    .background(Brush.verticalGradient(listOf(Color.Transparent, Color.Black.copy(alpha = 0.78f))))
            )

            Column(
                modifier = Modifier
                    .align(Alignment.BottomStart)
                    .padding(10.dp)
            ) {
                meta.lensLabel?.takeIf { it.isNotBlank() }?.let { lbl ->
                    Text(
                        text = lbl,
                        style = MaterialTheme.typography.labelMedium,
                        color = Color.White
                    )
                }
                Text(
                    text = dateFormat.format(Date(meta.createdAt)),
                    style = MaterialTheme.typography.labelSmall,
                    color = Color.White.copy(alpha = 0.78f)
                )
            }
        }
    }
}

@Composable
private fun SnapshotLightboxDialog(
    meta: SnapshotMeta,
    client: MonitorClient,
    cache: LruCache<String, Bitmap>,
    onDismiss: () -> Unit,
    onSave: () -> Unit,
    onDelete: () -> Unit
) {
    var bitmap by remember(meta.id) { mutableStateOf(cache.get(meta.id)) }
    LaunchedEffect(meta.id) {
        if (bitmap == null) {
            val bytes = client.fetchSnapshotBytes(meta)
            if (bytes != null) {
                bitmap = withContext(Dispatchers.Default) {
                    BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
                }
            }
        }
    }

    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false)
    ) {
        Surface(
            color = Color.Black.copy(alpha = 0.96f),
            modifier = Modifier.fillMaxSize()
        ) {
            Box(modifier = Modifier.fillMaxSize()) {
                val bmp = bitmap
                if (bmp != null) {
                    Image(
                        bitmap = bmp.asImageBitmap(),
                        contentDescription = meta.lensLabel ?: "Snapshot",
                        contentScale = ContentScale.Fit,
                        modifier = Modifier
                            .fillMaxSize()
                            .padding(vertical = 72.dp)
                    )
                } else {
                    CircularProgressIndicator(modifier = Modifier.align(Alignment.Center))
                }

                // Top bar
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .statusBarsPadding()
                        .padding(horizontal = 16.dp, vertical = 12.dp)
                        .align(Alignment.TopCenter),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text(
                        text = meta.lensLabel ?: "Snapshot",
                        style = MaterialTheme.typography.titleMedium,
                        color = Color.White
                    )
                    IconButton(onClick = onDismiss) {
                        Icon(Icons.Rounded.Close, contentDescription = "Close", tint = Color.White)
                    }
                }

                // Bottom actions
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .align(Alignment.BottomCenter)
                        .padding(horizontal = 24.dp, vertical = 28.dp),
                    horizontalArrangement = Arrangement.spacedBy(12.dp)
                ) {
                    Button(
                        onClick = onSave,
                        shape = RoundedCornerShape(999.dp),
                        modifier = Modifier
                            .weight(1f)
                            .height(48.dp)
                    ) {
                        Icon(Icons.Rounded.Download, contentDescription = null, modifier = Modifier.size(18.dp))
                        Spacer(Modifier.width(8.dp))
                        Text("Save to Gallery")
                    }
                    FilledTonalButton(
                        onClick = onDelete,
                        colors = ButtonDefaults.filledTonalButtonColors(
                            containerColor = MaterialTheme.colorScheme.errorContainer,
                            contentColor = MaterialTheme.colorScheme.onErrorContainer
                        ),
                        shape = RoundedCornerShape(999.dp),
                        modifier = Modifier.height(48.dp)
                    ) {
                        Icon(Icons.Rounded.Delete, contentDescription = "Delete", modifier = Modifier.size(18.dp))
                    }
                }
            }
        }
    }
}

@Composable
private fun MonitorSettingsTab(
    ui: MonitorUiState,
    localServerUrl: String,
    remoteServerUrl: String,
    authToken: String,
    onOpenConnectSheet: () -> Unit,
    onSwitchMode: () -> Unit
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .statusBarsPadding()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 20.dp, vertical = 18.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        Text(
            text = "Monitor Settings",
            style = MaterialTheme.typography.headlineMedium,
            color = MaterialTheme.colorScheme.onBackground
        )

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
                    Text("Connection & Failover", style = MaterialTheme.typography.titleMedium)
                    Surface(
                        color = if (ui.wsConnected) PurrStatusColors.Live.copy(alpha = 0.18f)
                        else MaterialTheme.colorScheme.surfaceContainerHighest,
                        shape = RoundedCornerShape(999.dp)
                    ) {
                        Text(
                            text = if (ui.wsConnected) "${ui.activeRoute} Active" else "Disconnected",
                            style = MaterialTheme.typography.labelMedium,
                            color = if (ui.wsConnected) PurrStatusColors.Live else MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(horizontal = 10.dp, vertical = 4.dp)
                        )
                    }
                }
                Text(
                    text = "Local Wi-Fi: $localServerUrl",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                Text(
                    text = "Remote 4G/5G: ${remoteServerUrl.ifBlank { "Not configured" }}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                Text(
                    text = "Access Token: ${if (authToken.isNotBlank()) "Configured" else "None"}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                Text(
                    text = "PurrCam tries Local Wi-Fi first (2.5s timeout) and seamlessly falls back to your Remote HTTPS/WSS tunnel on 4G/5G.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                Button(
                    onClick = onOpenConnectSheet,
                    shape = RoundedCornerShape(999.dp),
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Icon(Icons.Rounded.Link, contentDescription = null, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(8.dp))
                    Text("Import Pairing Link / Edit Server")
                }
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
                Text("Device Role", style = MaterialTheme.typography.titleMedium)
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
private fun MonitorVideoView(
    client: MonitorClient,
    fitMode: Boolean,
    modifier: Modifier = Modifier
) {
    val rendererRef = remember { mutableStateOf<SurfaceViewRenderer?>(null) }

    DisposableEffect(client) {
        onDispose {
            client.attachVideoSink(null)
            rendererRef.value?.release()
            rendererRef.value = null
        }
    }

    // True Fit (wrapContentSize inside centered Box -> VideoLayoutMeasure computes exact un-squished aspect fit!)
    // vs Fill (fillMaxSize -> EglRenderer center-crops edge-to-edge with zero squish!)
    Box(modifier = modifier, contentAlignment = Alignment.Center) {
        AndroidView(
            modifier = if (fitMode) Modifier.wrapContentSize() else Modifier.fillMaxSize(),
            factory = { ctx ->
                SurfaceViewRenderer(ctx).apply {
                    init(client.eglBase.eglBaseContext, null)
                    setScalingType(
                        if (fitMode) RendererCommon.ScalingType.SCALE_ASPECT_FIT
                        else RendererCommon.ScalingType.SCALE_ASPECT_FILL
                    )
                    setEnableHardwareScaler(true)
                    rendererRef.value = this
                    client.attachVideoSink(this)
                }
            },
            update = { view ->
                view.setScalingType(
                    if (fitMode) RendererCommon.ScalingType.SCALE_ASPECT_FIT
                    else RendererCommon.ScalingType.SCALE_ASPECT_FILL
                )
            }
        )
    }
}

@Composable
private fun CatCueButton(
    modifier: Modifier = Modifier,
    icon: ImageVector,
    label: String,
    onClick: () -> Unit
) {
    FilledTonalButton(
        onClick = onClick,
        shape = RoundedCornerShape(18.dp),
        modifier = modifier.height(48.dp)
    ) {
        Icon(icon, contentDescription = null, modifier = Modifier.size(16.dp))
        Spacer(Modifier.width(6.dp))
        Text(label, style = MaterialTheme.typography.labelLarge)
    }
}
