package com.purrcam.app.camera

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.purrcam.app.MainActivity
import com.purrcam.app.R
import com.purrcam.app.data.AppPreferences
import com.purrcam.app.monitor.BeaconResolver
import com.purrcam.app.protocol.CameraCapabilities
import com.purrcam.app.protocol.CameraState
import com.purrcam.app.protocol.CommandAckMsg
import com.purrcam.app.protocol.IceCandidateDto
import com.purrcam.app.protocol.IceServerConfig
import com.purrcam.app.protocol.LensInfo
import com.purrcam.app.protocol.ParsedServerEndpoint
import com.purrcam.app.protocol.PingPongMsg
import com.purrcam.app.protocol.PurrJson
import com.purrcam.app.protocol.RegisterCameraMsg
import com.purrcam.app.protocol.RtcIceMsg
import com.purrcam.app.protocol.RtcOfferMsg
import com.purrcam.app.protocol.ServerUrlHelper
import com.purrcam.app.protocol.StateUpdateMsg
import com.purrcam.app.protocol.Telemetry
import com.purrcam.app.protocol.TelemetryMsg
import com.purrcam.app.protocol.VideoFrameMsg
import com.purrcam.app.root.RootPowerController
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.floatOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.webrtc.EglBase
import org.webrtc.VideoSink
import java.net.URLEncoder
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

data class CameraServiceUiState(
    val running: Boolean = false,
    val videoReady: Boolean = false,
    val wsConnected: Boolean = false,
    val activeRoute: String = "Local", // "Local" | "Remote"
    val statusText: String = "Stopped",
    val serverWsUrl: String = ServerUrlHelper.DEFAULT_LOCAL_URL,
    val deviceName: String = "Poco F3",
    val lenses: List<LensInfo> = emptyList(),
    val capabilities: CameraCapabilities = CameraCapabilities(),
    val cameraState: CameraState = CameraState(),
    val telemetry: Telemetry? = null,
    val viewerCount: Int = 0,
    val relayActive: Boolean = false,
    val lastError: String? = null
)

class CameraStreamService : Service() {

    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private lateinit var prefs: AppPreferences
    private val rootController = RootPowerController()
    private lateinit var telemetryCollector: TelemetryCollector
    private lateinit var connectivityManager: ConnectivityManager

    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(8, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .writeTimeout(15, TimeUnit.SECONDS)
        .pingInterval(15, TimeUnit.SECONDS)
        .build()

    // Fast 2.5s connect client for Local LAN probe when Remote failover is also configured
    private val localProbeClient = httpClient.newBuilder()
        .connectTimeout(2500, TimeUnit.MILLISECONDS)
        .build()

    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null
    private var networkCallback: ConnectivityManager.NetworkCallback? = null
    private val lastNetworkHandle = AtomicLong(-1L)

    private var webRtcManager: CameraWebRtcManager? = null
    private var relayEncoder: RelayFrameEncoder? = null
    private val relayViewers = ConcurrentHashMap.newKeySet<String>()
    private var webrtcViewerCount = 0
    private var lensDescriptors: List<LensDescriptor> = emptyList()

    private var localEndpoint: ParsedServerEndpoint = ServerUrlHelper.parse(ServerUrlHelper.DEFAULT_LOCAL_URL)
    private var remoteEndpoint: ParsedServerEndpoint? = null
    private var activeEndpoint: ParsedServerEndpoint = localEndpoint
    private var tryingRemote = false
    private var localFailCount = 0
    private var remoteFailCount = 0
    private var authToken: String = ""

    @Volatile
    private var webSocket: WebSocket? = null
    private val wsGeneration = AtomicInteger(0)
    private val lastWsActivityMs = AtomicLong(0L)
    private var wsReconnectJob: Job? = null
    private var telemetryJob: Job? = null
    private var pingJob: Job? = null
    private val wsConnected = AtomicBoolean(false)
    private var reconnectDelayMs = 1000L

    private var currentState = CameraState()
    private var currentCapabilities = CameraCapabilities()

    override fun onCreate() {
        super.onCreate()
        activeInstance.set(this)
        prefs = AppPreferences(this)
        telemetryCollector = TelemetryCollector(this, rootController)
        connectivityManager = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSelf()
            return START_NOT_STICKY
        }

        val rawLocal = intent?.getStringExtra(EXTRA_SERVER_URL)?.takeIf { it.isNotBlank() }
            ?: prefs.localServerUrl
        val rawRemote = intent?.getStringExtra(EXTRA_REMOTE_URL)
            ?: prefs.remoteServerUrl
        val explicitToken = intent?.getStringExtra(EXTRA_TOKEN)
        val startBlackout = intent?.getBooleanExtra(EXTRA_START_BLACKOUT, false) ?: false

        val prevTarget = activeEndpoint.wsUrl
        configureEndpoints(rawLocal, rawRemote, explicitToken)

        startAsForeground("Starting PurrCam camera...")

        if (!uiStateFlow.value.running) {
            initializePipeline(startBlackout)
        } else if (prevTarget != activeEndpoint.wsUrl || uiStateFlow.value.serverWsUrl != activeEndpoint.wsUrl) {
            uiStateFlow.update {
                it.copy(
                    serverWsUrl = activeEndpoint.wsUrl,
                    activeRoute = if (tryingRemote) "Remote" else "Local"
                )
            }
            reconnectWsNow()
        }
        return START_STICKY
    }

    private fun configureEndpoints(rawLocal: String, rawRemote: String, explicitToken: String?) {
        val parsedPrimary = ServerUrlHelper.parse(rawLocal)
        val parsedRemote = rawRemote.trim().takeIf { it.isNotBlank() }?.let { ServerUrlHelper.parse(it) }

        if (parsedPrimary.isSecure && parsedRemote == null) {
            localEndpoint = parsedPrimary
            remoteEndpoint = null
            tryingRemote = true
            activeEndpoint = parsedPrimary
        } else {
            localEndpoint = parsedPrimary
            remoteEndpoint = parsedRemote?.takeIf { it.wsUrl != parsedPrimary.wsUrl }
            tryingRemote = false
            activeEndpoint = localEndpoint
        }
        localFailCount = 0
        remoteFailCount = 0

        authToken = explicitToken?.takeIf { it.isNotBlank() }
            ?: localEndpoint.tokenFromUrl
            ?: remoteEndpoint?.tokenFromUrl
            ?: prefs.authToken
    }

    fun updateConnectionEndpoints(localUrl: String, remoteUrl: String, token: String) {
        prefs.localServerUrl = localUrl
        prefs.remoteServerUrl = remoteUrl
        prefs.authToken = token
        configureEndpoints(localUrl, remoteUrl, token)
        reconnectWsNow()
    }

    private fun initializePipeline(startBlackout: Boolean) {
        acquireLocks()
        registerNetworkCallback()
        uiStateFlow.update {
            it.copy(
                running = true,
                wsConnected = false,
                activeRoute = if (tryingRemote) "Remote" else "Local",
                serverWsUrl = activeEndpoint.wsUrl,
                deviceName = prefs.deviceName,
                statusText = "Initializing cameras...",
                lastError = null
            )
        }

        serviceScope.launch {
            val rootCaps = rootController.probe()
            if (rootCaps.hasRoot) {
                rootController.whitelistDozeIfRooted()
            }

            val descriptors = LensEnumerator.enumerate(this@CameraStreamService)
            lensDescriptors = descriptors

            if (descriptors.isEmpty()) {
                val err = "No usable Camera2 cameras detected"
                uiStateFlow.update { it.copy(statusText = err, lastError = err) }
                return@launch
            }

            val savedLensId = prefs.preferredLensId
            val initialLens = descriptors.firstOrNull { it.info.id == savedLensId }
                ?: descriptors.firstOrNull { it.info.type == "wide" }
                ?: descriptors.first()

            val hasMic = ContextCompat.checkSelfPermission(
                this@CameraStreamService,
                Manifest.permission.RECORD_AUDIO
            ) == PackageManager.PERMISSION_GRANTED

            currentCapabilities = CameraCapabilities(
                torch = descriptors.any { it.info.hasFlash },
                audioIn = hasMic,
                audioOut = true,
                root = rootCaps.hasRoot,
                chargeLimit = rootCaps.hasRoot && rootCaps.chargeControlNode != null,
                rootDisplayOff = rootCaps.hasRoot && rootCaps.backlightPath != null
            )

            currentState = CameraState(
                activeLensId = initialLens.info.id,
                torch = false,
                blackout = startBlackout,
                rootDisplayOff = false,
                resolution = prefs.videoResolution,
                fps = prefs.videoFps,
                bitrateKbps = prefs.videoBitrateKbps,
                ev = 0f,
                zoomRatio = 1.0f,
                micEnabled = hasMic,
                speakerEnabled = true,
                chargeLimitEnabled = prefs.chargeLimitEnabled && currentCapabilities.chargeLimit,
                chargeLimitMaxPct = prefs.chargeLimitMaxPct,
                streaming = true
            )

            val (w, h) = resolutionToSize(currentState.resolution)
            val manager = CameraWebRtcManager(
                context = this@CameraStreamService,
                initialLens = initialLens,
                hasMicPermission = hasMic,
                onOfferReady = { viewerId, sdp ->
                    sendWsJson(PurrJson.encodeToString(RtcOfferMsg(viewerId = viewerId, sdp = sdp)))
                },
                onLocalIce = { viewerId, candidate ->
                    sendWsJson(PurrJson.encodeToString(RtcIceMsg(viewerId = viewerId, candidate = candidate)))
                },
                onViewerCountChanged = { count ->
                    webrtcViewerCount = count
                    updateEffectiveViewerCount()
                },
                onCameraError = { err ->
                    Log.e(TAG, "Camera error: $err")
                    uiStateFlow.update { it.copy(lastError = err) }
                }
            )
            webRtcManager = manager
            manager.start(w, h, currentState.fps, currentState.bitrateKbps)

            relayEncoder = RelayFrameEncoder(
                canSendFrame = {
                    wsConnected.get() &&
                        relayViewers.isNotEmpty() &&
                        (webSocket?.queueSize() ?: Long.MAX_VALUE) <= RELAY_BACKPRESSURE_LIMIT_BYTES
                },
                onFrameEncoded = { width, height, base64Jpeg ->
                    if (!wsConnected.get() || relayViewers.isEmpty()) return@RelayFrameEncoder
                    val lensLabel = lensDescriptors.firstOrNull { it.info.id == currentState.activeLensId }?.info?.label
                    val msg = VideoFrameMsg(
                        ts = System.currentTimeMillis(),
                        width = width,
                        height = height,
                        lensLabel = lensLabel,
                        mime = "image/jpeg",
                        data = base64Jpeg
                    )
                    sendWsJson(PurrJson.encodeToString(msg))
                }
            )

            uiStateFlow.update {
                it.copy(
                    videoReady = true,
                    lenses = descriptors.map { d -> d.info },
                    capabilities = currentCapabilities,
                    cameraState = currentState,
                    statusText = "Connecting..."
                )
            }
            updateNotification()

            connectWebSocket()
            startTelemetryLoop()
        }
    }

    private fun updateEffectiveViewerCount() {
        val total = maxOf(webrtcViewerCount, relayViewers.size)
        uiStateFlow.update {
            it.copy(
                viewerCount = total,
                relayActive = relayViewers.isNotEmpty()
            )
        }
        updateNotification()
    }

    private fun syncRelayAttachment() {
        val encoder = relayEncoder ?: return
        if (relayViewers.isNotEmpty()) {
            webRtcManager?.attachRelaySink(encoder)
        } else {
            webRtcManager?.attachRelaySink(null)
        }
        updateEffectiveViewerCount()
    }

    private fun registerNetworkCallback() {
        if (networkCallback != null) return
        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                val handle = network.networkHandle
                val prev = lastNetworkHandle.getAndSet(handle)
                if (prev == -1L || prev == handle) return
                Log.i(TAG, "Network changed ($prev -> $handle) — triggering instant WS reconnect")
                reconnectDelayMs = 1000L
                localFailCount = 0
                if (remoteEndpoint != null) {
                    val caps = connectivityManager.getNetworkCapabilities(network)
                    val hasWifi = caps?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true
                    tryingRemote = !hasWifi
                }
                if (uiStateFlow.value.running) {
                    serviceScope.launch {
                        delay(300L)
                        if (uiStateFlow.value.running) connectWebSocket()
                    }
                }
            }

            override fun onLost(network: Network) {
                Log.w(TAG, "Network lost (${network.networkHandle})")
            }
        }
        try {
            connectivityManager.registerDefaultNetworkCallback(cb)
            networkCallback = cb
        } catch (e: Exception) {
            Log.w(TAG, "Failed to register NetworkCallback: ${e.message}")
        }
    }

    private fun unregisterNetworkCallback() {
        val cb = networkCallback ?: return
        networkCallback = null
        try {
            connectivityManager.unregisterNetworkCallback(cb)
        } catch (_: Exception) {
        }
    }

    private fun startTelemetryLoop() {
        telemetryJob?.cancel()
        telemetryJob = serviceScope.launch {
            while (isActive) {
                try {
                    val sample = telemetryCollector.collect(
                        activeLensId = currentState.activeLensId,
                        measuredFps = webRtcManager?.getMeasuredFps()?.takeIf { it > 0 } ?: currentState.fps,
                        bitrateKbps = currentState.bitrateKbps
                    )
                    if (currentCapabilities.chargeLimit) {
                        val paused = rootController.applyChargeGuard(
                            enabled = currentState.chargeLimitEnabled,
                            maxPct = currentState.chargeLimitMaxPct,
                            currentBatteryPct = sample.batteryPct
                        )
                        val updatedSample = sample.copy(chargePaused = paused)
                        uiStateFlow.update { it.copy(telemetry = updatedSample) }
                        if (wsConnected.get()) {
                            sendWsJson(PurrJson.encodeToString(TelemetryMsg(data = updatedSample)))
                        }
                    } else {
                        uiStateFlow.update { it.copy(telemetry = sample) }
                        if (wsConnected.get()) {
                            sendWsJson(PurrJson.encodeToString(TelemetryMsg(data = sample)))
                        }
                    }
                    updateNotification()
                } catch (e: Exception) {
                    Log.w(TAG, "Telemetry loop error: ${e.message}")
                }
                delay(3000L)
            }
        }
    }

    private fun connectWebSocket() {
        val gen = wsGeneration.incrementAndGet()
        wsReconnectJob?.cancel()
        pingJob?.cancel()
        wsConnected.set(false)
        relayViewers.clear()
        syncRelayAttachment()

        val previous = webSocket
        webSocket = null
        try {
            previous?.close(1000, "reconnecting")
        } catch (_: Exception) {
        }

        val currentEp = if (tryingRemote && remoteEndpoint != null) remoteEndpoint!! else localEndpoint
        activeEndpoint = currentEp
        val routeLabel = if (tryingRemote || currentEp.isSecure) "Remote" else "Local"
        val connectUrl = currentEp.wsUrlWithToken(authToken)

        val request = Request.Builder()
            .url(connectUrl)
            .build()

        val clientToUse = if (!tryingRemote && remoteEndpoint != null) localProbeClient else httpClient

        uiStateFlow.update {
            it.copy(
                serverWsUrl = currentEp.wsUrl,
                activeRoute = routeLabel,
                wsConnected = false,
                statusText = "Connecting ($routeLabel)..."
            )
        }

        webSocket = clientToUse.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                if (gen != wsGeneration.get()) {
                    webSocket.close(1000, "stale")
                    return
                }
                Log.i(TAG, "WS connected ($routeLabel) to ${currentEp.wsUrl}")
                wsConnected.set(true)
                lastWsActivityMs.set(SystemClock.elapsedRealtime())
                reconnectDelayMs = 1000L
                localFailCount = 0
                remoteFailCount = 0
                uiStateFlow.update {
                    it.copy(
                        wsConnected = true,
                        activeRoute = routeLabel,
                        serverWsUrl = currentEp.wsUrl,
                        statusText = "Live",
                        lastError = null
                    )
                }
                sendRegistration(webSocket)
                startPingLoop(gen)
                updateNotification()
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                if (gen != wsGeneration.get()) return
                lastWsActivityMs.set(SystemClock.elapsedRealtime())
                serviceScope.launch {
                    handleIncomingWsMessage(text)
                }
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                if (gen != wsGeneration.get()) return
                Log.w(TAG, "WS closed ($code): $reason")
                onSocketLost(
                    reason = if (code == 4001) "Unauthorized token" else "Disconnected ($code)",
                    httpCode = null,
                    wasRemoteRoute = (routeLabel == "Remote")
                )
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                if (gen != wsGeneration.get()) return
                val code = response?.code
                Log.w(TAG, "WS failure ($routeLabel, http=$code): ${t.message}")
                onSocketLost(
                    reason = t.message ?: "Network error",
                    httpCode = code,
                    wasRemoteRoute = (routeLabel == "Remote")
                )
            }
        })
    }

    private fun onSocketLost(reason: String, httpCode: Int?, wasRemoteRoute: Boolean) {
        wsConnected.set(false)
        pingJob?.cancel()
        relayViewers.clear()
        syncRelayAttachment()

        if (!wasRemoteRoute) {
            localFailCount++
            // Camera LAN Stickiness: retry Local LAN twice before falling over to Remote!
            if (remoteEndpoint != null && localFailCount >= 2) {
                localFailCount = 0
                tryingRemote = true
                uiStateFlow.update {
                    it.copy(
                        wsConnected = false,
                        activeRoute = "Remote",
                        statusText = "Switching to Remote..."
                    )
                }
                serviceScope.launch {
                    delay(200L)
                    if (uiStateFlow.value.running) connectWebSocket()
                }
                return
            }
        } else {
            remoteFailCount++
            val isExpiredTunnelHttp = httpCode != null && (httpCode == 404 || httpCode == 502 || httpCode == 503 || httpCode in 520..530)
            if (authToken.isNotBlank() && (isExpiredTunnelHttp || remoteFailCount >= 2)) {
                remoteFailCount = 0
                serviceScope.launch {
                    uiStateFlow.update { it.copy(statusText = "Refreshing remote URL...") }
                    val fresh = BeaconResolver.resolveLatest(authToken, httpClient)
                    if (fresh != null) {
                        val parsed = ServerUrlHelper.parse(fresh.wsUrl)
                        prefs.remoteServerUrl = parsed.wsUrl
                        if (localEndpoint.isSecure && remoteEndpoint == null) {
                            localEndpoint = parsed
                        } else {
                            remoteEndpoint = parsed
                        }
                        reconnectDelayMs = 1000L
                        if (uiStateFlow.value.running) {
                            connectWebSocket()
                            return@launch
                        }
                    }
                    // Fall back to Local if available, else schedule standard backoff reconnect
                    if (remoteEndpoint != null && !localEndpoint.isSecure) {
                        tryingRemote = false
                    }
                    scheduleReconnect()
                }
                return
            }
            // Alternate back to Local after failed Remote attempt if Local is non-secure LAN
            if (remoteEndpoint != null && !localEndpoint.isSecure) {
                tryingRemote = false
            }
        }

        uiStateFlow.update {
            it.copy(
                wsConnected = false,
                statusText = "$reason · reconnecting..."
            )
        }
        updateNotification()
        scheduleReconnect()
    }

    private fun scheduleReconnect() {
        wsReconnectJob?.cancel()
        wsReconnectJob = serviceScope.launch {
            val wait = reconnectDelayMs
            reconnectDelayMs = (reconnectDelayMs * 2).coerceAtMost(10_000L)
            delay(wait)
            if (isActive && uiStateFlow.value.running) {
                connectWebSocket()
            }
        }
    }

    private fun reconnectWsNow() {
        reconnectDelayMs = 1000L
        connectWebSocket()
    }

    private fun startPingLoop(expectedGen: Int) {
        pingJob?.cancel()
        pingJob = serviceScope.launch {
            while (isActive && wsConnected.get() && wsGeneration.get() == expectedGen) {
                delay(15_000L)
                if (!wsConnected.get() || wsGeneration.get() != expectedGen) break

                val silentMs = SystemClock.elapsedRealtime() - lastWsActivityMs.get()
                if (silentMs > WS_PONG_TIMEOUT_MS) {
                    Log.w(TAG, "WS pong/activity timeout (${silentMs}ms > 45s) — forcing reconnect")
                    try {
                        webSocket?.cancel()
                    } catch (_: Exception) {
                    }
                    onSocketLost(
                        reason = "Connection timed out",
                        httpCode = null,
                        wasRemoteRoute = (uiStateFlow.value.activeRoute == "Remote")
                    )
                    break
                }
                sendWsJson(PurrJson.encodeToString(PingPongMsg(type = "ping", ts = System.currentTimeMillis())))
            }
        }
    }

    private fun sendRegistration(ws: WebSocket) {
        val reg = RegisterCameraMsg(
            deviceId = prefs.getOrCreateDeviceId(),
            deviceName = prefs.deviceName,
            lenses = lensDescriptors.map { it.info },
            capabilities = currentCapabilities,
            state = currentState,
            token = authToken
        )
        ws.send(PurrJson.encodeToString(reg))
    }

    private suspend fun handleIncomingWsMessage(text: String) {
        val obj = try {
            PurrJson.parseToJsonElement(text).jsonObject
        } catch (e: Exception) {
            Log.w(TAG, "Invalid WS JSON: ${e.message}")
            return
        }

        when (val type = obj["type"]?.jsonPrimitive?.contentOrNull) {
            "registered" -> {
                val iceArray = obj["iceServers"]?.jsonArray
                if (iceArray != null) {
                    val parsed = iceArray.mapNotNull { elem ->
                        try {
                            PurrJson.decodeFromJsonElement<IceServerConfig>(elem)
                        } catch (_: Exception) {
                            null
                        }
                    }
                    webRtcManager?.updateIceServers(parsed)
                }
                publishStateUpdate(includeLenses = true)
            }

            "watch_request" -> {
                val viewerId = obj["viewerId"]?.jsonPrimitive?.contentOrNull ?: return
                Log.i(TAG, "watch_request from $viewerId")
                webRtcManager?.handleWatchRequest(viewerId)
            }

            "watch_stop", "viewer_left" -> {
                val viewerId = obj["viewerId"]?.jsonPrimitive?.contentOrNull ?: return
                Log.i(TAG, "$type for $viewerId")
                webRtcManager?.handleViewerRemoved(viewerId)
                if (relayViewers.remove(viewerId)) {
                    syncRelayAttachment()
                }
            }

            "stream_mode" -> {
                val viewerId = obj["viewerId"]?.jsonPrimitive?.contentOrNull
                val mode = obj["mode"]?.jsonPrimitive?.contentOrNull?.lowercase() ?: return
                val fps = obj["fps"]?.jsonPrimitive?.intOrNull
                val quality = obj["quality"]?.jsonPrimitive?.intOrNull
                Log.i(TAG, "stream_mode viewer=$viewerId mode=$mode fps=$fps quality=$quality")
                if (mode == "ws_relay") {
                    relayEncoder?.updateParams(fps, quality)
                    relayViewers.add(viewerId ?: "__relay__")
                    syncRelayAttachment()
                } else {
                    if (viewerId != null) {
                        relayViewers.remove(viewerId)
                    } else {
                        relayViewers.clear()
                    }
                    syncRelayAttachment()
                }
            }

            "rtc_answer" -> {
                val viewerId = obj["viewerId"]?.jsonPrimitive?.contentOrNull ?: return
                val sdp = obj["sdp"]?.jsonPrimitive?.contentOrNull ?: return
                webRtcManager?.handleAnswer(viewerId, sdp)
            }

            "rtc_ice" -> {
                val viewerId = obj["viewerId"]?.jsonPrimitive?.contentOrNull ?: return
                val candElem = obj["candidate"] ?: return
                val cand = try {
                    PurrJson.decodeFromJsonElement<IceCandidateDto>(candElem)
                } catch (_: Exception) {
                    return
                }
                webRtcManager?.handleRemoteIce(viewerId, cand)
            }

            "command" -> {
                val commandId = obj["commandId"]?.jsonPrimitive?.contentOrNull ?: "cmd-unknown"
                val action = obj["action"]?.jsonPrimitive?.contentOrNull ?: return
                val payload = obj["payload"] as? JsonObject ?: JsonObject(emptyMap())
                handleRemoteCommand(commandId, action, payload)
            }

            "ping" -> {
                val ts = obj["ts"]?.jsonPrimitive?.contentOrNull?.toLongOrNull() ?: System.currentTimeMillis()
                sendWsJson(PurrJson.encodeToString(PingPongMsg(type = "pong", ts = ts)))
            }

            "pong" -> {
                // Already recorded via lastWsActivityMs
            }

            "error" -> {
                val msg = obj["message"]?.jsonPrimitive?.contentOrNull ?: "Server error"
                Log.e(TAG, "Server error: $msg")
                uiStateFlow.update { it.copy(lastError = msg) }
            }

            else -> {
                Log.v(TAG, "Ignoring message type=$type")
            }
        }
    }

    private suspend fun handleRemoteCommand(commandId: String, action: String, payload: JsonObject) {
        Log.i(TAG, "Command [$commandId] action=$action payload=$payload")
        var ok = true
        var error: String? = null

        try {
            when (action) {
                "switch_lens" -> {
                    val lensId = payload["lensId"]?.jsonPrimitive?.contentOrNull
                    val target = lensDescriptors.firstOrNull { it.info.id == lensId }
                    if (target == null) {
                        ok = false
                        error = "Lens '$lensId' not found"
                    } else {
                        applyLensSwitch(target)
                    }
                }

                "set_torch" -> {
                    val enabled = payload["enabled"]?.jsonPrimitive?.booleanOrNull ?: false
                    applyTorch(enabled)
                }

                "set_blackout" -> {
                    val enabled = payload["enabled"]?.jsonPrimitive?.booleanOrNull ?: false
                    val rootOff = payload["rootDisplayOff"]?.jsonPrimitive?.booleanOrNull
                        ?: currentState.rootDisplayOff
                    applyBlackout(enabled, rootOff)
                }

                "set_video_config" -> {
                    val res = payload["resolution"]?.jsonPrimitive?.contentOrNull ?: currentState.resolution
                    val fps = payload["fps"]?.jsonPrimitive?.intOrNull ?: currentState.fps
                    val bitrate = payload["bitrateKbps"]?.jsonPrimitive?.intOrNull ?: currentState.bitrateKbps
                    applyVideoConfig(res, fps, bitrate)
                }

                "set_exposure" -> {
                    val ev = payload["ev"]?.jsonPrimitive?.floatOrNull ?: 0f
                    applyExposure(ev)
                }

                "set_zoom" -> {
                    val ratio = payload["ratio"]?.jsonPrimitive?.floatOrNull ?: 1.0f
                    applyZoom(ratio)
                }

                "set_audio" -> {
                    val mic = payload["micEnabled"]?.jsonPrimitive?.booleanOrNull
                    val spk = payload["speakerEnabled"]?.jsonPrimitive?.booleanOrNull
                    applyAudio(mic, spk)
                }

                "set_charge_limit" -> {
                    val enabled = payload["enabled"]?.jsonPrimitive?.booleanOrNull ?: false
                    val maxPct = payload["maxPct"]?.jsonPrimitive?.intOrNull ?: currentState.chargeLimitMaxPct
                    if (!currentCapabilities.chargeLimit && enabled) {
                        ok = false
                        error = "Charge limit requires root access"
                    } else {
                        applyChargeLimit(enabled, maxPct)
                    }
                }

                "request_snapshot" -> {
                    val uploaded = captureAndUploadSnapshot()
                    if (!uploaded) {
                        ok = false
                        error = "Failed to capture or upload snapshot"
                    }
                }

                "play_sound" -> {
                    val sound = payload["sound"]?.jsonPrimitive?.contentOrNull ?: "psps"
                    serviceScope.launch { CatSoundPlayer.play(sound) }
                }

                "reboot_camera" -> {
                    webRtcManager?.rebootPipeline()
                }

                else -> {
                    ok = false
                    error = "Unknown command: $action"
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Command $action failed", e)
            ok = false
            error = e.message ?: "Error executing $action"
        }

        sendWsJson(
            PurrJson.encodeToString(
                CommandAckMsg(
                    commandId = commandId,
                    ok = ok,
                    error = error,
                    state = currentState
                )
            )
        )
        publishStateUpdate(includeLenses = false)
    }

    // Local UI actions

    fun localSwitchLens(lensId: String) {
        val target = lensDescriptors.firstOrNull { it.info.id == lensId } ?: return
        serviceScope.launch {
            applyLensSwitch(target)
            publishStateUpdate(includeLenses = false)
        }
    }

    fun localSetTorch(enabled: Boolean) {
        serviceScope.launch {
            applyTorch(enabled)
            publishStateUpdate(includeLenses = false)
        }
    }

    fun localSetBlackout(enabled: Boolean, rootDisplayOff: Boolean = currentState.rootDisplayOff) {
        serviceScope.launch {
            applyBlackout(enabled, rootDisplayOff)
            publishStateUpdate(includeLenses = false)
        }
    }

    fun localSetMic(enabled: Boolean) {
        serviceScope.launch {
            applyAudio(mic = enabled, speaker = null)
            publishStateUpdate(includeLenses = false)
        }
    }

    fun localSetChargeLimit(enabled: Boolean, maxPct: Int = currentState.chargeLimitMaxPct) {
        serviceScope.launch {
            applyChargeLimit(enabled, maxPct)
            publishStateUpdate(includeLenses = false)
        }
    }

    fun localUpdateVideoConfig(resolution: String, fps: Int, bitrateKbps: Int) {
        serviceScope.launch {
            applyVideoConfig(resolution, fps, bitrateKbps)
            publishStateUpdate(includeLenses = false)
        }
    }

    fun attachLocalPreview(sink: VideoSink?) {
        webRtcManager?.attachPreviewSink(sink)
    }

    fun getEglBaseContext(): EglBase.Context? = webRtcManager?.eglBase?.eglBaseContext

    private fun applyLensSwitch(target: LensDescriptor) {
        prefs.preferredLensId = target.info.id
        webRtcManager?.switchLens(target)
        val torchStillOn = currentState.torch && target.info.hasFlash
        currentState = currentState.copy(
            activeLensId = target.info.id,
            torch = torchStillOn,
            zoomRatio = 1.0f
        )
        uiStateFlow.update { it.copy(cameraState = currentState, lastError = null) }
    }

    private fun applyTorch(enabled: Boolean) {
        val supported = webRtcManager?.setTorch(enabled) ?: false
        currentState = currentState.copy(torch = enabled && supported)
        uiStateFlow.update { it.copy(cameraState = currentState) }
    }

    private suspend fun applyBlackout(enabled: Boolean, rootOffRequested: Boolean) {
        val effectiveRootOff = enabled && rootOffRequested && currentCapabilities.rootDisplayOff
        if (effectiveRootOff) {
            rootController.setRootDisplayOff(true)
        } else if (rootController.isDisplayOff) {
            rootController.restoreDisplay()
        }
        currentState = currentState.copy(
            blackout = enabled,
            rootDisplayOff = effectiveRootOff
        )
        uiStateFlow.update { it.copy(cameraState = currentState) }
    }

    private fun applyVideoConfig(resolution: String, fps: Int, bitrateKbps: Int) {
        val validRes = if (resolution in setOf("480p", "720p", "1080p")) resolution else "720p"
        val clampedFps = fps.coerceIn(10, 30)
        val clampedBitrate = bitrateKbps.coerceIn(400, 6000)
        prefs.videoResolution = validRes
        prefs.videoFps = clampedFps
        prefs.videoBitrateKbps = clampedBitrate
        val (w, h) = resolutionToSize(validRes)
        webRtcManager?.updateVideoConfig(w, h, clampedFps, clampedBitrate)
        currentState = currentState.copy(
            resolution = validRes,
            fps = clampedFps,
            bitrateKbps = clampedBitrate
        )
        uiStateFlow.update { it.copy(cameraState = currentState) }
    }

    private fun applyExposure(ev: Float) {
        val clamped = ev.coerceIn(-2.5f, 2.5f)
        webRtcManager?.setExposure(clamped)
        currentState = currentState.copy(ev = clamped)
        uiStateFlow.update { it.copy(cameraState = currentState) }
    }

    private fun applyZoom(ratio: Float) {
        val activeLens = lensDescriptors.firstOrNull { it.info.id == currentState.activeLensId }
        val maxZ = activeLens?.info?.maxZoom ?: 4.0f
        val clamped = ratio.coerceIn(1.0f, maxZ)
        webRtcManager?.setZoom(clamped)
        currentState = currentState.copy(zoomRatio = clamped)
        uiStateFlow.update { it.copy(cameraState = currentState) }
    }

    private fun applyAudio(mic: Boolean?, speaker: Boolean?) {
        val newMic = mic ?: currentState.micEnabled
        val newSpk = speaker ?: currentState.speakerEnabled
        if (mic != null) webRtcManager?.setMicEnabled(newMic)
        if (speaker != null) webRtcManager?.setSpeakerEnabled(newSpk)
        currentState = currentState.copy(micEnabled = newMic, speakerEnabled = newSpk)
        uiStateFlow.update { it.copy(cameraState = currentState) }
    }

    private suspend fun applyChargeLimit(enabled: Boolean, maxPct: Int) {
        val clampedMax = maxPct.coerceIn(50, 95)
        prefs.chargeLimitEnabled = enabled
        prefs.chargeLimitMaxPct = clampedMax
        currentState = currentState.copy(
            chargeLimitEnabled = enabled && currentCapabilities.chargeLimit,
            chargeLimitMaxPct = clampedMax
        )
        if (!enabled) {
            rootController.restoreNormalCharging()
        } else {
            val pct = uiStateFlow.value.telemetry?.batteryPct ?: 0
            if (pct > 0) {
                rootController.applyChargeGuard(true, clampedMax, pct)
            }
        }
        uiStateFlow.update { it.copy(cameraState = currentState) }
    }

    private suspend fun captureAndUploadSnapshot(): Boolean {
        val jpegBytes = webRtcManager?.captureSnapshotJpeg() ?: return false
        val lensLabel = lensDescriptors.firstOrNull { it.info.id == currentState.activeLensId }?.info?.label ?: ""
        return withContext(Dispatchers.IO) {
            try {
                val url = "${activeEndpoint.httpBaseUrl}/api/snapshots"
                val encodedLabel = URLEncoder.encode(lensLabel, "UTF-8").replace("+", "%20")
                val reqBuilder = Request.Builder()
                    .url(url)
                    .post(jpegBytes.toRequestBody("image/jpeg".toMediaType()))
                    .header("X-Lens-Label", encodedLabel)
                if (authToken.isNotBlank()) {
                    reqBuilder.header("Authorization", "Bearer $authToken")
                }
                httpClient.newCall(reqBuilder.build()).execute().use { resp ->
                    Log.i(TAG, "Snapshot upload HTTP ${resp.code} (${jpegBytes.size} bytes)")
                    resp.isSuccessful
                }
            } catch (e: Exception) {
                Log.e(TAG, "Snapshot upload failed: ${e.message}", e)
                false
            }
        }
    }

    private fun publishStateUpdate(includeLenses: Boolean) {
        if (!wsConnected.get()) return
        val msg = StateUpdateMsg(
            state = currentState,
            lenses = if (includeLenses) lensDescriptors.map { it.info } else null
        )
        sendWsJson(PurrJson.encodeToString(msg))
    }

    private fun sendWsJson(json: String) {
        try {
            webSocket?.send(json)
        } catch (e: Exception) {
            Log.w(TAG, "sendWsJson failed: ${e.message}")
        }
    }

    private fun resolutionToSize(res: String): Pair<Int, Int> = when (res) {
        "480p" -> 854 to 480
        "1080p" -> 1920 to 1080
        else -> 1280 to 720
    }

    private fun acquireLocks() {
        try {
            val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "PurrCam::StreamWakeLock").apply {
                setReferenceCounted(false)
                acquire()
            }
        } catch (e: Exception) {
            Log.w(TAG, "WakeLock acquire failed: ${e.message}")
        }

        try {
            val wm = applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
            @Suppress("DEPRECATION")
            val lockMode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                WifiManager.WIFI_MODE_FULL_LOW_LATENCY
            } else {
                WifiManager.WIFI_MODE_FULL_HIGH_PERF
            }
            wifiLock = wm?.createWifiLock(lockMode, "PurrCam::WifiLock")?.apply {
                setReferenceCounted(false)
                acquire()
            }
        } catch (e: Exception) {
            Log.w(TAG, "WifiLock acquire failed: ${e.message}")
        }
    }

    private fun releaseLocks() {
        try {
            if (wakeLock?.isHeld == true) wakeLock?.release()
        } catch (_: Exception) {
        }
        wakeLock = null
        try {
            if (wifiLock?.isHeld == true) wifiLock?.release()
        } catch (_: Exception) {
        }
        wifiLock = null
    }

    private fun createNotificationChannel() {
        val channel = NotificationChannel(
            CHANNEL_ID,
            "PurrCam Camera Stream",
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = "Background camera streaming and device telemetry"
            setShowBadge(false)
        }
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(channel)
    }

    private fun startAsForeground(contentText: String) {
        val notification = buildNotification(contentText)
        // Android 15-17 strictly caps FOREGROUND_SERVICE_TYPE_DATA_SYNC at 6 hours/day;
        // use ONLY camera | microphone so 24/7 monitoring is never terminated by the OS.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            var serviceType = ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
            val hasMic = ContextCompat.checkSelfPermission(
                this,
                Manifest.permission.RECORD_AUDIO
            ) == PackageManager.PERMISSION_GRANTED
            if (hasMic) {
                serviceType = serviceType or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
            }
            startForeground(NOTIFICATION_ID, notification, serviceType)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun updateNotification() {
        val ui = uiStateFlow.value
        val tel = ui.telemetry
        val batText = if (tel != null) "${tel.batteryPct}% · ${tel.batteryTempC}°C" else "..."
        val viewersLabel = if (ui.viewerCount == 1) "1 viewer" else "${ui.viewerCount} viewers"
        val connText = if (ui.wsConnected) "Live ($viewersLabel)" else "Connecting..."
        val nm = getSystemService(NotificationManager::class.java)
        nm.notify(NOTIFICATION_ID, buildNotification("$connText · $batText"))
    }

    private fun buildNotification(text: String): Notification {
        val openIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val openPending = PendingIntent.getActivity(
            this,
            1,
            openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val stopIntent = Intent(this, CameraStreamService::class.java).apply {
            action = ACTION_STOP
        }
        val stopPending = PendingIntent.getService(
            this,
            2,
            stopIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_purrcam)
            .setContentTitle("PurrCam · Camera Active")
            .setContentText(text)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(openPending)
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Stop", stopPending)
            .build()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        Log.i(TAG, "CameraStreamService destroying — restoring display & charging")
        wsGeneration.incrementAndGet()
        wsReconnectJob?.cancel()
        telemetryJob?.cancel()
        pingJob?.cancel()
        wsConnected.set(false)
        unregisterNetworkCallback()

        relayViewers.clear()
        webRtcManager?.attachRelaySink(null)
        relayEncoder?.close()
        relayEncoder = null

        try {
            webSocket?.close(1000, "service_stopped")
        } catch (_: Exception) {
        }
        webSocket = null

        rootController.restoreDisplayBlocking()
        rootController.restoreNormalChargingBlocking()

        webRtcManager?.dispose()
        webRtcManager = null

        releaseLocks()
        serviceScope.cancel()

        uiStateFlow.update {
            it.copy(
                running = false,
                videoReady = false,
                wsConnected = false,
                viewerCount = 0,
                relayActive = false,
                statusText = "Stopped",
                cameraState = it.cameraState.copy(blackout = false, rootDisplayOff = false, streaming = false)
            )
        }
        activeInstance.compareAndSet(this, null)
        super.onDestroy()
    }

    companion object {
        private const val TAG = "PurrCamService"
        private const val CHANNEL_ID = "purrcam_camera_channel"
        private const val NOTIFICATION_ID = 8787
        private const val WS_PONG_TIMEOUT_MS = 45_000L
        private const val RELAY_BACKPRESSURE_LIMIT_BYTES = 256L * 1024L

        const val ACTION_START = "com.purrcam.app.action.START_CAMERA"
        const val ACTION_STOP = "com.purrcam.app.action.STOP_CAMERA"
        const val EXTRA_SERVER_URL = "extra_server_url"
        const val EXTRA_REMOTE_URL = "extra_remote_url"
        const val EXTRA_TOKEN = "extra_token"
        const val EXTRA_START_BLACKOUT = "extra_start_blackout"

        private val uiStateFlow = MutableStateFlow(CameraServiceUiState())
        val uiState: StateFlow<CameraServiceUiState> = uiStateFlow.asStateFlow()

        private val activeInstance = AtomicReference<CameraStreamService?>(null)

        fun getInstance(): CameraStreamService? = activeInstance.get()

        fun start(
            context: Context,
            serverUrl: String,
            remoteUrl: String = "",
            token: String = "",
            startBlackout: Boolean = false
        ) {
            val intent = Intent(context, CameraStreamService::class.java).apply {
                action = ACTION_START
                putExtra(EXTRA_SERVER_URL, serverUrl)
                putExtra(EXTRA_REMOTE_URL, remoteUrl)
                putExtra(EXTRA_TOKEN, token)
                putExtra(EXTRA_START_BLACKOUT, startBlackout)
            }
            ContextCompat.startForegroundService(context, intent)
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, CameraStreamService::class.java))
        }
    }
}
