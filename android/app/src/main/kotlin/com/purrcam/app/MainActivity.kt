package com.purrcam.app

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.content.ContextCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import com.purrcam.app.camera.CameraStreamService
import com.purrcam.app.data.AppPreferences
import com.purrcam.app.protocol.PairingLinkParser
import com.purrcam.app.protocol.ParsedPairingLink
import com.purrcam.app.protocol.ServerUrlHelper
import com.purrcam.app.ui.CameraScreen
import com.purrcam.app.ui.HomeScreen
import com.purrcam.app.ui.MonitorScreen
import com.purrcam.app.ui.components.PairingConfirmationDialog
import com.purrcam.app.ui.theme.PurrCamTheme

private enum class AppScreen {
    HOME, CAMERA, MONITOR
}

class MainActivity : ComponentActivity() {

    private lateinit var prefs: AppPreferences

    private var currentScreen by mutableStateOf(AppScreen.HOME)
    private var localServerUrl by mutableStateOf(ServerUrlHelper.DEFAULT_LOCAL_URL)
    private var remoteServerUrl by mutableStateOf("")
    private var authToken by mutableStateOf("")
    private var autoStartEnabled by mutableStateOf(false)
    private var pairingBanner by mutableStateOf<String?>(null)
    private var pendingPairingLink by mutableStateOf<ParsedPairingLink?>(null)
    private var pendingCameraStartBlackout by mutableStateOf(false)

    private val cameraPermissionsLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { results ->
        val cameraGranted = results[Manifest.permission.CAMERA] == true ||
            ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED
        if (cameraGranted) {
            startCameraModeInternal(pendingCameraStartBlackout)
        }
    }

    private val micPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { _ ->
        // MonitorClient re-checks RECORD_AUDIO automatically on Talkback tap
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT)
        )

        prefs = AppPreferences(this)
        localServerUrl = prefs.localServerUrl
        remoteServerUrl = prefs.remoteServerUrl
        authToken = prefs.authToken
        autoStartEnabled = prefs.autoStart

        if (CameraStreamService.uiState.value.running) {
            currentScreen = AppScreen.CAMERA
        }

        handleLaunchIntent(intent)

        setContent {
            PurrCamTheme {
                when (currentScreen) {
                    AppScreen.HOME -> {
                        HomeScreen(
                            localServerUrl = localServerUrl,
                            remoteServerUrl = remoteServerUrl,
                            authToken = authToken,
                            initialAutoStart = autoStartEnabled,
                            savedMode = prefs.selectedMode,
                            pairingBanner = pairingBanner,
                            onSaveConnection = { local, remote, tok ->
                                saveConnectionConfig(local, remote, tok)
                            },
                            onLaunchCamera = { auto ->
                                autoStartEnabled = auto
                                prefs.autoStart = auto
                                prefs.selectedMode = "camera"
                                requestAndLaunchCamera(startBlackout = false)
                            },
                            onLaunchMonitor = { auto ->
                                autoStartEnabled = auto
                                prefs.autoStart = auto
                                prefs.selectedMode = "monitor"
                                currentScreen = AppScreen.MONITOR
                            }
                        )
                    }

                    AppScreen.CAMERA -> {
                        CameraScreen(
                            localServerUrl = localServerUrl,
                            remoteServerUrl = remoteServerUrl,
                            authToken = authToken,
                            autoStart = autoStartEnabled,
                            onSaveConnection = { local, remote, tok ->
                                saveConnectionConfig(local, remote, tok)
                            },
                            onAutoStartChanged = { auto ->
                                autoStartEnabled = auto
                                prefs.autoStart = auto
                            },
                            onRestartCameraService = {
                                requestAndLaunchCamera(startBlackout = false)
                            },
                            onStopCameraService = {
                                CameraStreamService.stop(this)
                                setImmersiveBlackout(false)
                            },
                            onSwitchMode = {
                                CameraStreamService.stop(this)
                                setImmersiveBlackout(false)
                                currentScreen = AppScreen.HOME
                            },
                            onBlackoutChanged = { blackout ->
                                setImmersiveBlackout(blackout)
                            }
                        )
                    }

                    AppScreen.MONITOR -> {
                        MonitorScreen(
                            localServerUrl = localServerUrl,
                            remoteServerUrl = remoteServerUrl,
                            authToken = authToken,
                            onSaveConnection = { local, remote, tok ->
                                saveConnectionConfig(local, remote, tok)
                            },
                            onExit = {
                                setImmersiveFullscreen(false)
                                currentScreen = AppScreen.HOME
                            },
                            onRequestMicPermission = {
                                if (ContextCompat.checkSelfPermission(
                                        this,
                                        Manifest.permission.RECORD_AUDIO
                                    ) != PackageManager.PERMISSION_GRANTED
                                ) {
                                    micPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
                                }
                            },
                            onFullscreenChanged = { fs ->
                                setImmersiveFullscreen(fs)
                            }
                        )
                    }
                }

                pendingPairingLink?.let { pending ->
                    PairingConfirmationDialog(
                        link = pending,
                        onConfirm = {
                            val nextLocal = pending.localUrl ?: localServerUrl
                            val nextRemote = pending.remoteUrl ?: remoteServerUrl
                            val nextToken = pending.token ?: authToken
                            saveConnectionConfig(nextLocal, nextRemote, nextToken)
                            pairingBanner = buildString {
                                append("Pairing link applied")
                                if (!pending.remoteUrl.isNullOrBlank()) append(" (Remote ready)")
                            }
                            if (CameraStreamService.uiState.value.running) {
                                CameraStreamService.getInstance()
                                    ?.updateConnectionEndpoints(nextLocal, nextRemote, nextToken)
                            }
                            pendingPairingLink = null
                        },
                        onDismiss = {
                            pendingPairingLink = null
                        }
                    )
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleLaunchIntent(intent)
    }

    private fun saveConnectionConfig(local: String, remote: String, token: String) {
        val cleanLocal = local.trim().ifEmpty { ServerUrlHelper.DEFAULT_LOCAL_URL }
        val cleanRemote = remote.trim()
        val cleanToken = token.trim()
        localServerUrl = cleanLocal
        remoteServerUrl = cleanRemote
        authToken = cleanToken
        prefs.localServerUrl = cleanLocal
        prefs.remoteServerUrl = cleanRemote
        prefs.authToken = cleanToken
    }

    /**
     * Supports BOTH:
     * 1. Deep links (ACTION_VIEW): `purrcam://connect?local=ws://192.168.1.100:8787/ws&remote=https://example.trycloudflare.com&token=xyz`
     *    Always requires explicit user confirmation via [PairingConfirmationDialog] before modifying saved config.
     * 2. Explicit developer ADB launch extras (non-ACTION_VIEW):
     *    `adb shell am start -n com.purrcam.app/.MainActivity --es mode camera --es server ws://127.0.0.1:8787/ws --ez autostart true`
     */
    private fun handleLaunchIntent(launchIntent: Intent?) {
        // 1. Handle purrcam://connect deep links strictly with user confirmation (never silent overwrite or auto-start)
        val dataUri = launchIntent?.dataString
        if (launchIntent?.action == Intent.ACTION_VIEW ||
            (!dataUri.isNullOrBlank() && dataUri.startsWith("purrcam://", ignoreCase = true))
        ) {
            if (!dataUri.isNullOrBlank() && dataUri.startsWith("purrcam://", ignoreCase = true)) {
                val parsed = PairingLinkParser.parse(dataUri)
                if (parsed != null) {
                    pendingPairingLink = parsed
                }
            }
            return
        }

        // 2. Handle ADB automation extras
        val extras = launchIntent?.extras
        val extraServer = extras?.getString("server")?.takeIf { it.isNotBlank() }
        val extraRemote = extras?.getString("remote")?.takeIf { it.isNotBlank() }
        val extraToken = extras?.getString("token")
        val extraMode = extras?.getString("mode")?.lowercase()?.trim()
        val extraAutostart = extras?.getBoolean("autostart", false) ?: false
        val extraBlackout = extras?.getBoolean("blackout", false) ?: false

        if (extraServer != null) {
            if (ServerUrlHelper.isRemoteUrl(extraServer) && extraRemote == null) {
                remoteServerUrl = extraServer
                prefs.remoteServerUrl = extraServer
            } else {
                localServerUrl = extraServer
                prefs.localServerUrl = extraServer
            }
        }
        if (extraRemote != null) {
            remoteServerUrl = extraRemote
            prefs.remoteServerUrl = extraRemote
        }
        if (extraToken != null) {
            authToken = extraToken
            prefs.authToken = extraToken
        }

        if (extraMode == "camera") {
            prefs.selectedMode = "camera"
            if (extraAutostart) {
                autoStartEnabled = true
                prefs.autoStart = true
            }
            requestAndLaunchCamera(startBlackout = extraBlackout)
            return
        } else if (extraMode == "monitor") {
            prefs.selectedMode = "monitor"
            if (extraAutostart) {
                autoStartEnabled = true
                prefs.autoStart = true
            }
            currentScreen = AppScreen.MONITOR
            return
        }

        // Saved auto-start when opening app normally
        if (currentScreen == AppScreen.HOME && prefs.autoStart && dataUri.isNullOrBlank()) {
            when (prefs.selectedMode) {
                "camera" -> requestAndLaunchCamera(startBlackout = false)
                "monitor" -> currentScreen = AppScreen.MONITOR
            }
        }
    }

    private fun requestAndLaunchCamera(startBlackout: Boolean) {
        pendingCameraStartBlackout = startBlackout
        val needed = mutableListOf<String>()
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            needed.add(Manifest.permission.CAMERA)
        }
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            needed.add(Manifest.permission.RECORD_AUDIO)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            needed.add(Manifest.permission.POST_NOTIFICATIONS)
        }

        if (needed.isEmpty()) {
            startCameraModeInternal(startBlackout)
        } else {
            cameraPermissionsLauncher.launch(needed.toTypedArray())
        }
    }

    private fun startCameraModeInternal(startBlackout: Boolean) {
        CameraStreamService.start(
            context = this,
            serverUrl = localServerUrl,
            remoteUrl = remoteServerUrl,
            token = authToken,
            startBlackout = startBlackout
        )
        currentScreen = AppScreen.CAMERA
    }

    private fun setImmersiveBlackout(enabled: Boolean) {
        val controller = WindowInsetsControllerCompat(window, window.decorView)
        val lp = window.attributes
        if (enabled) {
            window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            lp.screenBrightness = 0.001f
            window.attributes = lp
            controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            controller.hide(WindowInsetsCompat.Type.systemBars())
        } else {
            lp.screenBrightness = WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE
            window.attributes = lp
            controller.show(WindowInsetsCompat.Type.systemBars())
            if (currentScreen != AppScreen.CAMERA) {
                window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            }
        }
    }

    private fun setImmersiveFullscreen(enabled: Boolean) {
        val controller = WindowInsetsControllerCompat(window, window.decorView)
        if (enabled) {
            window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            controller.hide(WindowInsetsCompat.Type.systemBars())
        } else {
            window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            controller.show(WindowInsetsCompat.Type.systemBars())
        }
    }

    override fun onDestroy() {
        val lp = window.attributes
        lp.screenBrightness = WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE
        window.attributes = lp
        super.onDestroy()
    }
}
