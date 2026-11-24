package com.purrcam.app.monitor

import android.Manifest
import android.content.ContentValues
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.BitmapFactory
import android.media.AudioManager
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Build
import android.os.Environment
import android.os.SystemClock
import android.provider.MediaStore
import android.util.Log
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.core.content.ContextCompat
import com.purrcam.app.camera.CameraWebRtcManager
import com.purrcam.app.camera.SimpleSdpObserver
import com.purrcam.app.data.AppPreferences
import com.purrcam.app.protocol.CameraState
import com.purrcam.app.protocol.CameraSummary
import com.purrcam.app.protocol.CommandMsg
import com.purrcam.app.protocol.IceCandidateDto
import com.purrcam.app.protocol.IceServerConfig
import com.purrcam.app.protocol.LensInfo
import com.purrcam.app.protocol.ParsedServerEndpoint
import com.purrcam.app.protocol.PingPongMsg
import com.purrcam.app.protocol.PurrJson
import com.purrcam.app.protocol.RegisterViewerMsg
import com.purrcam.app.protocol.RtcAnswerMsg
import com.purrcam.app.protocol.RtcIceMsg
import com.purrcam.app.protocol.ServerUrlHelper
import com.purrcam.app.protocol.SnapshotListResponseDto
import com.purrcam.app.protocol.SnapshotMeta
import com.purrcam.app.protocol.StreamModeMsg
import com.purrcam.app.protocol.Telemetry
import com.purrcam.app.protocol.WatchRequestMsg
import com.purrcam.app.protocol.WatchStopMsg
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
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.webrtc.AudioSource
import org.webrtc.AudioTrack
import org.webrtc.DataChannel
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpReceiver
import org.webrtc.RtpTransceiver
import org.webrtc.SessionDescription
import org.webrtc.VideoFrame
import org.webrtc.VideoSink
import org.webrtc.VideoTrack
import org.webrtc.audio.JavaAudioDeviceModule
import java.io.File
import java.io.FileOutputStream
import java.util.Base64
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

enum class StreamModePreference(val label: String) {
    AUTO("Auto"),
    WEBRTC("WebRTC"),
    WS_RELAY("HTTPS Relay")
}

data class MonitorUiState(
    val wsConnected: Boolean = false,
    val activeRoute: String = "Local", // "Local" | "Remote"
    val activeHttpBaseUrl: String = "http://127.0.0.1:8787",
    val cameraOnline: Boolean = false,
    val rtcConnected: Boolean = false,
    val streamPreference: StreamModePreference = StreamModePreference.AUTO,
    val activeStreamMode: String = "webrtc", // "webrtc" | "ws_relay"
    val relayFrame: ImageBitmap? = null,
    val relayConnected: Boolean = false,
    val statusText: String = "Connecting...",
    val viewerCount: Int = 0,
    val camera: CameraSummary? = null,
    val telemetry: Telemetry? = null,
    val talkbackActive: Boolean = false,
    val remoteAudioMuted: Boolean = false,
    val snapshots: List<SnapshotMeta> = emptyList(),
    val snapshotsLoading: Boolean = false,
    val lastSnapshot: SnapshotMeta? = null,
    val toastMessage: String? = null
)

class MonitorClient(private val context: Context) {
    private val appContext = context.applicationContext
    private val prefs = AppPreferences(appContext)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val rtcExecutor = Executors.newSingleThreadExecutor { r ->
        Thread(r, "PurrCam-MonitorRTC").apply { isDaemon = true }
    }
    private val audioManager = appContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private val connectivityManager = appContext.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager

    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(8, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .writeTimeout(15, TimeUnit.SECONDS)
        .pingInterval(15, TimeUnit.SECONDS)
        .build()

    // Fast 2.5s connect timeout when probing Local LAN with Remote failover configured
    private val localProbeClient = httpClient.newBuilder()
        .connectTimeout(2500, TimeUnit.MILLISECONDS)
        .build()

    // Standard HTTP client for REST calls (gallery, snapshots, beacon)
    private val restClient = OkHttpClient.Builder()
        .connectTimeout(6, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .build()

    private val _uiState = MutableStateFlow(MonitorUiState())
    val uiState: StateFlow<MonitorUiState> = _uiState.asStateFlow()

    val eglBase: EglBase = EglBase.create()

    private var localEndpoint: ParsedServerEndpoint = ServerUrlHelper.parse(ServerUrlHelper.DEFAULT_LOCAL_URL)
    private var remoteEndpoint: ParsedServerEndpoint? = null
    private var activeEndpoint: ParsedServerEndpoint = localEndpoint
    private var tryingRemote = false
    private var remoteFailCount = 0
    private var authToken: String = ""
    private var clientId: String = prefs.getOrCreateClientId()

    @Volatile
    private var webSocket: WebSocket? = null
    private val wsGeneration = AtomicInteger(0)
    private val lastWsActivityMs = AtomicLong(0L)
    private var networkCallback: ConnectivityManager.NetworkCallback? = null
    private val lastNetworkHandle = AtomicLong(-1L)

    private var reconnectJob: Job? = null
    private var pingJob: Job? = null
    private var watchTimeoutJob: Job? = null
    private var autoRelayFallbackJob: Job? = null
    private var iceDisconnectGraceJob: Job? = null
    private var frameStallWatchdogJob: Job? = null

    private val wsConnected = AtomicBoolean(false)
    private val stopped = AtomicBoolean(false)
    private var reconnectDelayMs = 1000L
    private val cmdSeq = AtomicInteger(1)

    private var factory: PeerConnectionFactory? = null
    private var audioDeviceModule: JavaAudioDeviceModule? = null
    private var peerConnection: PeerConnection? = null
    private var remoteVideoTrack: VideoTrack? = null
    private var remoteAudioTrack: AudioTrack? = null
    private var localAudioSource: AudioSource? = null
    private var localTalkbackTrack: AudioTrack? = null
    private var videoSink: VideoSink? = null

    private val lastWebRtcFrameMs = AtomicLong(0L)
    private val lastRelayFrameMs = AtomicLong(0L)
    private val relayDecodeInFlight = AtomicBoolean(false)

    // Wrapper sink that forwards frames to SurfaceViewRenderer while tracking frame arrival timestamps
    private val frameWatchSink = VideoSink { frame: VideoFrame ->
        lastWebRtcFrameMs.set(SystemClock.elapsedRealtime())
        videoSink?.onFrame(frame)
    }

    private var remoteDescSet = false
    private val pendingRemoteIce = mutableListOf<IceCandidate>()
    private val watchInFlight = AtomicBoolean(false)
    private val saveNextSnapshotToGallery = AtomicBoolean(false)

    @Volatile
    private var iceServers: List<PeerConnection.IceServer> = listOf(
        PeerConnection.IceServer.builder("stun:stun.l.google.com:19302").createIceServer(),
        PeerConnection.IceServer.builder("stun:stun1.l.google.com:19302").createIceServer(),
        PeerConnection.IceServer.builder("stun:stun.cloudflare.com:3478").createIceServer()
    )

    fun start(localUrl: String, remoteUrl: String = "", token: String = "") {
        stopped.set(false)
        configureEndpoints(localUrl, remoteUrl, token)
        registerNetworkCallback()
        rtcExecutor.execute { ensureRtcFactory() }
        connectWs()
        startFrameStallWatchdog()
    }

    fun reconnectWith(localUrl: String, remoteUrl: String, token: String) {
        prefs.localServerUrl = localUrl
        prefs.remoteServerUrl = remoteUrl
        prefs.authToken = token
        configureEndpoints(localUrl, remoteUrl, token)
        reconnectDelayMs = 1000L
        connectWs()
    }

    fun refreshRemoteFromBeacon() {
        if (authToken.isBlank()) {
            _uiState.update { it.copy(toastMessage = "Access token required for Beacon sync") }
            return
        }
        scope.launch {
            _uiState.update { it.copy(statusText = "Refreshing remote URL...") }
            val resolved = BeaconResolver.resolveLatest(authToken, restClient)
            if (resolved != null) {
                val parsed = ServerUrlHelper.parse(resolved.wsUrl)
                prefs.remoteServerUrl = parsed.wsUrl
                remoteEndpoint = parsed
                tryingRemote = true
                reconnectDelayMs = 1000L
                _uiState.update { it.copy(toastMessage = "Remote URL updated (${resolved.provider})") }
                connectWs()
            } else {
                _uiState.update { it.copy(toastMessage = "No active remote tunnel found in Beacon") }
            }
        }
    }

    fun setStreamPreference(pref: StreamModePreference) {
        _uiState.update { it.copy(streamPreference = pref) }
        if (!wsConnected.get() || !_uiState.value.cameraOnline) return
        when (pref) {
            StreamModePreference.WS_RELAY -> activateWsRelay(reason = "Switched to HTTPS Relay")
            StreamModePreference.WEBRTC -> switchToWebRtc()
            StreamModePreference.AUTO -> {
                if (_uiState.value.activeRoute == "Local") {
                    switchToWebRtc()
                } else {
                    switchToWebRtc()
                }
            }
        }
    }

    private fun switchToWebRtc() {
        autoRelayFallbackJob?.cancel()
        iceDisconnectGraceJob?.cancel()
        _uiState.update {
            it.copy(
                activeStreamMode = "webrtc",
                relayConnected = false,
                relayFrame = null,
                statusText = "Connecting video..."
            )
        }
        sendWsJson(PurrJson.encodeToString(StreamModeMsg(viewerId = clientId, mode = "webrtc")))
        sendWatchRequest()
    }

    private fun activateWsRelay(reason: String? = null) {
        if (!wsConnected.get() || !_uiState.value.cameraOnline) return
        autoRelayFallbackJob?.cancel()
        watchTimeoutJob?.cancel()
        iceDisconnectGraceJob?.cancel()
        watchInFlight.set(false)
        rtcExecutor.execute { closePeerConnectionLocked() }
        lastRelayFrameMs.set(SystemClock.elapsedRealtime())
        _uiState.update {
            it.copy(
                activeStreamMode = "ws_relay",
                rtcConnected = false,
                statusText = "Connecting HTTPS Relay..."
            )
        }
        sendWsJson(
            PurrJson.encodeToString(
                StreamModeMsg(
                    viewerId = clientId,
                    mode = "ws_relay",
                    fps = 8,
                    quality = 60
                )
            )
        )
        if (!reason.isNullOrBlank()) {
            Log.i(TAG, "Activated ws_relay: $reason")
        }
    }

    private fun configureEndpoints(rawLocal: String, rawRemote: String, explicitToken: String) {
        val parsedLocal = ServerUrlHelper.parse(rawLocal)
        val parsedRemote = rawRemote.trim().takeIf { it.isNotBlank() }?.let { ServerUrlHelper.parse(it) }

        if (parsedLocal.isSecure && parsedRemote == null) {
            localEndpoint = parsedLocal
            remoteEndpoint = null
            tryingRemote = true
            activeEndpoint = parsedLocal
        } else {
            localEndpoint = parsedLocal
            remoteEndpoint = parsedRemote?.takeIf { it.wsUrl != parsedLocal.wsUrl }
            tryingRemote = false
            activeEndpoint = localEndpoint
        }
        remoteFailCount = 0

        authToken = explicitToken.takeIf { it.isNotBlank() }
            ?: localEndpoint.tokenFromUrl
            ?: remoteEndpoint?.tokenFromUrl
            ?: prefs.authToken
    }

    private fun registerNetworkCallback() {
        if (networkCallback != null) return
        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                val handle = network.networkHandle
                val prev = lastNetworkHandle.getAndSet(handle)
                if (prev == -1L || prev == handle) return
                Log.i(TAG, "Monitor network changed ($prev -> $handle) — reconnecting immediately")
                reconnectDelayMs = 1000L
                remoteFailCount = 0
                if (remoteEndpoint != null) {
                    val caps = connectivityManager.getNetworkCapabilities(network)
                    val hasWifi = caps?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true
                    tryingRemote = !hasWifi
                }
                if (!stopped.get()) {
                    scope.launch {
                        delay(250L)
                        if (!stopped.get()) connectWs()
                    }
                }
            }

            override fun onLost(network: Network) {
                Log.w(TAG, "Monitor network lost (${network.networkHandle})")
            }
        }
        try {
            connectivityManager.registerDefaultNetworkCallback(cb)
            networkCallback = cb
        } catch (e: Exception) {
            Log.w(TAG, "Monitor NetworkCallback failed: ${e.message}")
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

    private fun startFrameStallWatchdog() {
        frameStallWatchdogJob?.cancel()
        frameStallWatchdogJob = scope.launch {
            while (isActive && !stopped.get()) {
                delay(3000L)
                val ui = _uiState.value
                if (!ui.wsConnected || !ui.cameraOnline) continue
                val now = SystemClock.elapsedRealtime()
                if (ui.activeStreamMode == "webrtc" && ui.rtcConnected) {
                    val last = lastWebRtcFrameMs.get()
                    if (last > 0L && now - last > FRAME_STALL_TIMEOUT_MS) {
                        Log.w(TAG, "WebRTC frame stall (>10s) — recovering stream")
                        if (ui.streamPreference == StreamModePreference.AUTO) {
                            activateWsRelay(reason = "WebRTC stalled >10s")
                        } else {
                            lastWebRtcFrameMs.set(now)
                            sendWatchRequest()
                        }
                    }
                } else if (ui.activeStreamMode == "ws_relay" && ui.relayConnected) {
                    val last = lastRelayFrameMs.get()
                    if (last > 0L && now - last > FRAME_STALL_TIMEOUT_MS) {
                        Log.w(TAG, "HTTPS Relay frame stall (>10s) — re-requesting relay stream")
                        lastRelayFrameMs.set(now)
                        sendWsJson(
                            PurrJson.encodeToString(
                                StreamModeMsg(viewerId = clientId, mode = "ws_relay", fps = 8, quality = 60)
                            )
                        )
                    }
                }
            }
        }
    }

    fun attachVideoSink(sink: VideoSink?) {
        rtcExecutor.execute {
            val track = remoteVideoTrack
            if (videoSink != null && track != null) {
                try {
                    track.removeSink(frameWatchSink)
                } catch (_: Exception) {
                }
            }
            videoSink = sink
            if (sink != null && track != null) {
                try {
                    track.addSink(frameWatchSink)
                } catch (_: Exception) {
                }
            }
        }
    }

    fun clearToast() {
        _uiState.update { it.copy(toastMessage = null) }
    }

    fun setTalkbackActive(active: Boolean) {
        val hasMic = ContextCompat.checkSelfPermission(
            appContext,
            Manifest.permission.RECORD_AUDIO
        ) == PackageManager.PERMISSION_GRANTED
        if (active && !hasMic) {
            _uiState.update { it.copy(toastMessage = "Microphone permission required for Talkback") }
            return
        }
        _uiState.update { it.copy(talkbackActive = active) }
        rtcExecutor.execute {
            if (localTalkbackTrack == null && hasMic && factory != null) {
                createLocalMicTrackLocked()
                localTalkbackTrack?.setEnabled(active)
                if (_uiState.value.activeStreamMode == "webrtc") {
                    sendWatchRequest()
                }
            } else {
                localTalkbackTrack?.setEnabled(active)
            }
        }
    }

    fun toggleRemoteMute() {
        val newMuted = !_uiState.value.remoteAudioMuted
        _uiState.update { it.copy(remoteAudioMuted = newMuted) }
        rtcExecutor.execute {
            remoteAudioTrack?.setEnabled(!newMuted)
        }
    }

    fun switchLens(lensId: String) {
        sendCommand("switch_lens", JsonObject(mapOf("lensId" to JsonPrimitive(lensId))))
    }

    fun setTorch(enabled: Boolean) {
        sendCommand("set_torch", JsonObject(mapOf("enabled" to JsonPrimitive(enabled))))
    }

    fun setBlackout(enabled: Boolean, rootDisplayOff: Boolean? = null) {
        val map = mutableMapOf<String, JsonPrimitive>("enabled" to JsonPrimitive(enabled))
        if (rootDisplayOff != null) {
            map["rootDisplayOff"] = JsonPrimitive(rootDisplayOff)
        }
        sendCommand("set_blackout", JsonObject(map))
    }

    fun setVideoConfig(resolution: String? = null, fps: Int? = null, bitrateKbps: Int? = null) {
        val map = mutableMapOf<String, JsonPrimitive>()
        if (resolution != null) map["resolution"] = JsonPrimitive(resolution)
        if (fps != null) map["fps"] = JsonPrimitive(fps)
        if (bitrateKbps != null) map["bitrateKbps"] = JsonPrimitive(bitrateKbps)
        sendCommand("set_video_config", JsonObject(map))
    }

    fun setExposure(ev: Float) {
        sendCommand("set_exposure", JsonObject(mapOf("ev" to JsonPrimitive(ev))))
    }

    fun setZoom(ratio: Float) {
        sendCommand("set_zoom", JsonObject(mapOf("ratio" to JsonPrimitive(ratio))))
    }

    fun setChargeLimit(enabled: Boolean, maxPct: Int? = null) {
        val map = mutableMapOf<String, JsonPrimitive>("enabled" to JsonPrimitive(enabled))
        if (maxPct != null) map["maxPct"] = JsonPrimitive(maxPct)
        sendCommand("set_charge_limit", JsonObject(map))
    }

    fun playSound(sound: String) {
        sendCommand("play_sound", JsonObject(mapOf("sound" to JsonPrimitive(sound))))
    }

    fun requestSnapshot(saveToGallery: Boolean = true) {
        if (saveToGallery) saveNextSnapshotToGallery.set(true)
        sendCommand("request_snapshot", JsonObject(emptyMap()))
    }

    fun rebootCamera() {
        sendCommand("reboot_camera", JsonObject(emptyMap()))
    }

    // Gallery REST API

    fun refreshSnapshots() {
        scope.launch {
            _uiState.update { it.copy(snapshotsLoading = true) }
            val items = withContext(Dispatchers.IO) {
                try {
                    val req = buildAuthedRequest("${activeEndpoint.httpBaseUrl}/api/snapshots").build()
                    restClient.newCall(req).execute().use { resp ->
                        if (!resp.isSuccessful) return@withContext null
                        val body = resp.body?.string().orEmpty()
                        PurrJson.decodeFromString<SnapshotListResponseDto>(body).items
                    }
                } catch (e: Exception) {
                    Log.w(TAG, "refreshSnapshots failed: ${e.message}")
                    null
                }
            }
            _uiState.update {
                it.copy(
                    snapshots = items ?: it.snapshots,
                    snapshotsLoading = false
                )
            }
        }
    }

    fun deleteSnapshot(id: String) {
        scope.launch {
            val ok = withContext(Dispatchers.IO) {
                try {
                    val req = buildAuthedRequest("${activeEndpoint.httpBaseUrl}/api/snapshots/$id")
                        .delete()
                        .build()
                    restClient.newCall(req).execute().use { it.isSuccessful }
                } catch (e: Exception) {
                    Log.w(TAG, "deleteSnapshot failed: ${e.message}")
                    false
                }
            }
            if (ok) {
                _uiState.update { cur ->
                    cur.copy(
                        snapshots = cur.snapshots.filterNot { it.id == id },
                        toastMessage = "Snapshot deleted"
                    )
                }
            } else {
                _uiState.update { it.copy(toastMessage = "Failed to delete snapshot") }
            }
        }
    }

    suspend fun fetchSnapshotBytes(meta: SnapshotMeta): ByteArray? = withContext(Dispatchers.IO) {
        try {
            val fullUrl = "${activeEndpoint.httpBaseUrl}${meta.url}"
            val req = buildAuthedRequest(fullUrl).build()
            restClient.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) return@withContext null
                resp.body?.bytes()
            }
        } catch (e: Exception) {
            Log.w(TAG, "fetchSnapshotBytes error: ${e.message}")
            null
        }
    }

    fun saveSnapshotToPhoneGallery(meta: SnapshotMeta) {
        scope.launch {
            downloadAndSaveSnapshotToGallery(meta)
        }
    }

    private fun buildAuthedRequest(url: String): Request.Builder {
        val builder = Request.Builder().url(url)
        if (authToken.isNotBlank()) {
            builder.header("Authorization", "Bearer $authToken")
        }
        return builder
    }

    private fun sendCommand(action: String, payload: JsonObject) {
        if (!wsConnected.get()) {
            _uiState.update { it.copy(toastMessage = "Not connected to server") }
            return
        }
        val cmdId = "and-${System.currentTimeMillis()}-${cmdSeq.getAndIncrement()}"
        sendWsJson(PurrJson.encodeToString(CommandMsg(commandId = cmdId, action = action, payload = payload)))
    }

    private fun ensureRtcFactory() {
        if (factory != null) return
        CameraWebRtcManager.ensureFactoryInitialized(appContext)
        val adm = JavaAudioDeviceModule.builder(appContext)
            .setUseHardwareAcousticEchoCanceler(true)
            .setUseHardwareNoiseSuppressor(true)
            .createAudioDeviceModule()
        audioDeviceModule = adm

        factory = PeerConnectionFactory.builder()
            .setAudioDeviceModule(adm)
            .setVideoEncoderFactory(DefaultVideoEncoderFactory(eglBase.eglBaseContext, true, true))
            .setVideoDecoderFactory(DefaultVideoDecoderFactory(eglBase.eglBaseContext))
            .createPeerConnectionFactory()

        val hasMic = ContextCompat.checkSelfPermission(
            appContext,
            Manifest.permission.RECORD_AUDIO
        ) == PackageManager.PERMISSION_GRANTED
        if (hasMic) {
            createLocalMicTrackLocked()
        }
    }

    private fun createLocalMicTrackLocked() {
        if (localTalkbackTrack != null || factory == null) return
        val constraints = MediaConstraints().apply {
            mandatory.add(MediaConstraints.KeyValuePair("googEchoCancellation", "true"))
            mandatory.add(MediaConstraints.KeyValuePair("googNoiseSuppression", "true"))
        }
        localAudioSource = factory!!.createAudioSource(constraints)
        localTalkbackTrack = factory!!.createAudioTrack("monitor-talkback", localAudioSource).apply {
            setEnabled(false)
        }
    }

    private fun connectWs() {
        if (stopped.get()) return
        val gen = wsGeneration.incrementAndGet()
        reconnectJob?.cancel()
        pingJob?.cancel()
        watchTimeoutJob?.cancel()
        autoRelayFallbackJob?.cancel()
        iceDisconnectGraceJob?.cancel()
        wsConnected.set(false)
        watchInFlight.set(false)

        val previous = webSocket
        webSocket = null
        try {
            previous?.close(1000, "reconnect")
        } catch (_: Exception) {
        }

        val currentEp = if (tryingRemote && remoteEndpoint != null) remoteEndpoint!! else localEndpoint
        activeEndpoint = currentEp
        val routeLabel = if (tryingRemote || currentEp.isSecure) "Remote" else "Local"
        val connectUrl = currentEp.wsUrlWithToken(authToken)

        val req = Request.Builder().url(connectUrl).build()
        val clientToUse = if (!tryingRemote && remoteEndpoint != null) localProbeClient else httpClient

        _uiState.update {
            it.copy(
                wsConnected = false,
                relayConnected = false,
                activeRoute = routeLabel,
                activeHttpBaseUrl = currentEp.httpBaseUrl,
                statusText = "Connecting ($routeLabel)..."
            )
        }

        webSocket = clientToUse.newWebSocket(req, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                if (gen != wsGeneration.get()) {
                    webSocket.close(1000, "stale")
                    return
                }
                wsConnected.set(true)
                lastWsActivityMs.set(SystemClock.elapsedRealtime())
                reconnectDelayMs = 1000L
                remoteFailCount = 0
                _uiState.update {
                    it.copy(
                        wsConnected = true,
                        activeRoute = routeLabel,
                        activeHttpBaseUrl = currentEp.httpBaseUrl,
                        statusText = "Connected ($routeLabel)"
                    )
                }
                val reg = RegisterViewerMsg(
                    clientId = clientId,
                    clientName = "${Build.MODEL} (Android)",
                    clientType = "android",
                    token = authToken
                )
                webSocket.send(PurrJson.encodeToString(reg))
                startPingLoop(gen)
                refreshSnapshots()
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                if (gen != wsGeneration.get()) return
                lastWsActivityMs.set(SystemClock.elapsedRealtime())
                scope.launch { handleMessage(text) }
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                if (gen != wsGeneration.get()) return
                onWsDisconnected(
                    reason = when (code) {
                        4001 -> "Unauthorized token"
                        4029 -> "Rate limited — cooling down"
                        else -> "Disconnected ($code)"
                    },
                    httpCode = null,
                    wasRemoteRoute = (routeLabel == "Remote"),
                    cooldownMs = if (code == 4029) 60_000L else null
                )
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                if (gen != wsGeneration.get()) return
                onWsDisconnected(
                    reason = t.message ?: "Network error",
                    httpCode = response?.code,
                    wasRemoteRoute = (routeLabel == "Remote"),
                    cooldownMs = null
                )
            }
        })
    }

    private fun onWsDisconnected(
        reason: String,
        httpCode: Int?,
        wasRemoteRoute: Boolean,
        cooldownMs: Long?
    ) {
        wsConnected.set(false)
        watchInFlight.set(false)
        pingJob?.cancel()
        watchTimeoutJob?.cancel()
        autoRelayFallbackJob?.cancel()
        iceDisconnectGraceJob?.cancel()
        rtcExecutor.execute { closePeerConnectionLocked() }

        if (stopped.get()) return

        if (cooldownMs != null) {
            _uiState.update {
                it.copy(
                    wsConnected = false,
                    rtcConnected = false,
                    relayConnected = false,
                    statusText = reason
                )
            }
            reconnectJob?.cancel()
            reconnectJob = scope.launch {
                delay(cooldownMs)
                if (isActive && !stopped.get()) connectWs()
            }
            return
        }

        // Fast failover Local -> Remote when away from home on 4G/5G
        if (!wasRemoteRoute && remoteEndpoint != null) {
            tryingRemote = true
            _uiState.update {
                it.copy(
                    wsConnected = false,
                    rtcConnected = false,
                    relayConnected = false,
                    activeRoute = "Remote",
                    statusText = "Trying Remote tunnel..."
                )
            }
            scope.launch {
                delay(150L)
                if (!stopped.get()) connectWs()
            }
            return
        }

        // Automatic Encrypted Beacon Discovery when Remote tunnel rotated / expired!
        if (wasRemoteRoute) {
            remoteFailCount++
            val isExpiredTunnelHttp = httpCode != null && (httpCode == 404 || httpCode == 502 || httpCode == 503 || httpCode in 520..530)
            if (authToken.isNotBlank() && (isExpiredTunnelHttp || remoteFailCount >= 2)) {
                remoteFailCount = 0
                _uiState.update {
                    it.copy(
                        wsConnected = false,
                        rtcConnected = false,
                        relayConnected = false,
                        statusText = "Refreshing remote URL..."
                    )
                }
                reconnectJob?.cancel()
                reconnectJob = scope.launch {
                    val fresh = BeaconResolver.resolveLatest(authToken, restClient)
                    if (fresh != null) {
                        val parsed = ServerUrlHelper.parse(fresh.wsUrl)
                        prefs.remoteServerUrl = parsed.wsUrl
                        if (localEndpoint.isSecure && remoteEndpoint == null) {
                            localEndpoint = parsed
                        } else {
                            remoteEndpoint = parsed
                        }
                        reconnectDelayMs = 1000L
                        if (!stopped.get()) {
                            connectWs()
                            return@launch
                        }
                    }
                    // If local is non-secure LAN, alternate back on retry
                    if (remoteEndpoint != null && !localEndpoint.isSecure) {
                        tryingRemote = false
                    }
                    val wait = reconnectDelayMs
                    reconnectDelayMs = (reconnectDelayMs * 2).coerceAtMost(8000L)
                    delay(wait)
                    if (isActive && !stopped.get()) connectWs()
                }
                return
            }
            if (remoteEndpoint != null && !localEndpoint.isSecure) {
                tryingRemote = false
            }
        }

        _uiState.update {
            it.copy(
                wsConnected = false,
                rtcConnected = false,
                relayConnected = false,
                statusText = "$reason · reconnecting..."
            )
        }
        reconnectJob?.cancel()
        reconnectJob = scope.launch {
            val wait = reconnectDelayMs
            reconnectDelayMs = (reconnectDelayMs * 2).coerceAtMost(8000L)
            delay(wait)
            if (isActive && !stopped.get()) connectWs()
        }
    }

    private fun startPingLoop(expectedGen: Int) {
        pingJob?.cancel()
        pingJob = scope.launch {
            while (isActive && wsConnected.get() && wsGeneration.get() == expectedGen) {
                delay(15_000L)
                if (!wsConnected.get() || wsGeneration.get() != expectedGen) break
                val silentMs = SystemClock.elapsedRealtime() - lastWsActivityMs.get()
                if (silentMs > WS_PONG_TIMEOUT_MS) {
                    Log.w(TAG, "Monitor WS pong/activity timeout (${silentMs}ms > 45s) — reconnecting")
                    try {
                        webSocket?.cancel()
                    } catch (_: Exception) {
                    }
                    onWsDisconnected(
                        reason = "Connection timed out",
                        httpCode = null,
                        wasRemoteRoute = (_uiState.value.activeRoute == "Remote"),
                        cooldownMs = null
                    )
                    break
                }
                sendWsJson(PurrJson.encodeToString(PingPongMsg("ping", System.currentTimeMillis())))
            }
        }
    }

    private suspend fun handleMessage(text: String) {
        val obj = try {
            PurrJson.parseToJsonElement(text).jsonObject
        } catch (_: Exception) {
            return
        }

        when (obj["type"]?.jsonPrimitive?.contentOrNull) {
            "registered" -> {
                obj["id"]?.jsonPrimitive?.contentOrNull?.let { clientId = it }
                val iceArr = obj["iceServers"]?.jsonArray
                if (iceArr != null) {
                    val servers = iceArr.mapNotNull {
                        try {
                            PurrJson.decodeFromJsonElement<IceServerConfig>(it).toWebRtcIceServer()
                        } catch (_: Exception) {
                            null
                        }
                    }
                    if (servers.isNotEmpty()) iceServers = servers
                }
            }

            "camera_status" -> {
                val online = obj["online"]?.jsonPrimitive?.booleanOrNull ?: false
                val viewerCount = obj["viewerCount"]?.jsonPrimitive?.intOrNull ?: 0
                val camSummary = obj["camera"]?.takeIf { it is JsonObject }?.let {
                    try {
                        PurrJson.decodeFromJsonElement<CameraSummary>(it)
                    } catch (_: Exception) {
                        null
                    }
                }
                val wasOnline = _uiState.value.cameraOnline
                _uiState.update {
                    it.copy(
                        cameraOnline = online,
                        viewerCount = viewerCount,
                        camera = camSummary,
                        telemetry = camSummary?.telemetry ?: it.telemetry,
                        statusText = if (online) "Camera online" else "Camera offline"
                    )
                }
                if (online) {
                    val pref = _uiState.value.streamPreference
                    if (pref == StreamModePreference.WS_RELAY) {
                        if (!_uiState.value.relayConnected || !wasOnline) {
                            activateWsRelay(reason = "User preference HTTPS Relay")
                        }
                    } else if (_uiState.value.activeStreamMode == "ws_relay" && wasOnline) {
                        // Already streaming via HTTPS Relay; keep it uninterrupted
                    } else if (!wasOnline || (peerConnection == null && !watchInFlight.get())) {
                        sendWatchRequest()
                    }
                } else {
                    watchInFlight.set(false)
                    watchTimeoutJob?.cancel()
                    autoRelayFallbackJob?.cancel()
                    iceDisconnectGraceJob?.cancel()
                    rtcExecutor.execute { closePeerConnectionLocked() }
                    _uiState.update {
                        it.copy(
                            rtcConnected = false,
                            relayConnected = false,
                            relayFrame = null
                        )
                    }
                }
            }

            "video_frame" -> {
                val dataB64 = obj["data"]?.jsonPrimitive?.contentOrNull ?: return
                lastRelayFrameMs.set(SystemClock.elapsedRealtime())
                if (!relayDecodeInFlight.compareAndSet(false, true)) return
                scope.launch(Dispatchers.Default) {
                    try {
                        val bytes = Base64.getDecoder().decode(dataB64)
                        val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
                        if (bmp != null) {
                            val img = bmp.asImageBitmap()
                            _uiState.update {
                                it.copy(
                                    activeStreamMode = "ws_relay",
                                    relayConnected = true,
                                    relayFrame = img,
                                    statusText = "Live · HTTPS Relay"
                                )
                            }
                        }
                    } catch (_: Exception) {
                    } finally {
                        relayDecodeInFlight.set(false)
                    }
                }
            }

            "telemetry" -> {
                val dataElem = obj["data"] ?: return
                val tel = try {
                    PurrJson.decodeFromJsonElement<Telemetry>(dataElem)
                } catch (_: Exception) {
                    return
                }
                _uiState.update { it.copy(telemetry = tel) }
            }

            "state_update" -> {
                val stateElem = obj["state"] ?: return
                val newState = try {
                    PurrJson.decodeFromJsonElement<CameraState>(stateElem)
                } catch (_: Exception) {
                    return
                }
                val newLenses = obj["lenses"]?.takeIf { it.toString() != "null" }?.let {
                    try {
                        PurrJson.decodeFromJsonElement<List<LensInfo>>(it)
                    } catch (_: Exception) {
                        null
                    }
                }
                _uiState.update { cur ->
                    val cam = cur.camera?.copy(
                        state = newState,
                        lenses = newLenses ?: cur.camera.lenses
                    )
                    cur.copy(camera = cam)
                }
            }

            "rtc_offer" -> {
                val sdp = obj["sdp"]?.jsonPrimitive?.contentOrNull ?: return
                handleRtcOffer(sdp)
            }

            "rtc_ice" -> {
                val candElem = obj["candidate"] ?: return
                val dto = try {
                    PurrJson.decodeFromJsonElement<IceCandidateDto>(candElem)
                } catch (_: Exception) {
                    return
                }
                rtcExecutor.execute {
                    val ice = IceCandidate(dto.sdpMid ?: "0", dto.sdpMLineIndex, dto.candidate)
                    if (remoteDescSet && peerConnection != null) {
                        peerConnection?.addIceCandidate(ice)
                    } else {
                        pendingRemoteIce.add(ice)
                    }
                }
            }

            "command_ack" -> {
                val ok = obj["ok"]?.jsonPrimitive?.booleanOrNull ?: true
                val err = obj["error"]?.jsonPrimitive?.contentOrNull
                if (!ok && !err.isNullOrBlank()) {
                    _uiState.update { it.copy(toastMessage = err) }
                }
            }

            "snapshot_saved" -> {
                val snapElem = obj["snapshot"] ?: return
                val meta = try {
                    PurrJson.decodeFromJsonElement<SnapshotMeta>(snapElem)
                } catch (_: Exception) {
                    return
                }
                _uiState.update { cur ->
                    val updated = listOf(meta) + cur.snapshots.filterNot { it.id == meta.id }
                    cur.copy(lastSnapshot = meta, snapshots = updated)
                }
                if (saveNextSnapshotToGallery.compareAndSet(true, false)) {
                    downloadAndSaveSnapshotToGallery(meta)
                }
            }

            "error" -> {
                val msg = obj["message"]?.jsonPrimitive?.contentOrNull ?: "Server error"
                _uiState.update { it.copy(toastMessage = msg) }
            }

            "ping" -> {
                val ts = obj["ts"]?.jsonPrimitive?.contentOrNull?.toLongOrNull() ?: System.currentTimeMillis()
                sendWsJson(PurrJson.encodeToString(PingPongMsg("pong", ts)))
            }
        }
    }

    private fun sendWatchRequest() {
        if (!wsConnected.get()) return
        watchInFlight.set(true)
        lastWebRtcFrameMs.set(0L)
        sendWsJson(PurrJson.encodeToString(WatchRequestMsg(viewerId = clientId)))

        // 8-second watchInFlight deadlock watchdog
        watchTimeoutJob?.cancel()
        watchTimeoutJob = scope.launch {
            delay(8_000L)
            if (watchInFlight.compareAndSet(true, false) && wsConnected.get() && _uiState.value.cameraOnline) {
                Log.w(TAG, "watch_request offer timeout (8s) — recovering")
                if (_uiState.value.streamPreference == StreamModePreference.AUTO) {
                    activateWsRelay(reason = "No WebRTC offer within 8s")
                } else {
                    sendWatchRequest()
                }
            }
        }

        // 6-second automatic HTTPS Relay fallback on Remote connections in Auto mode
        autoRelayFallbackJob?.cancel()
        if (_uiState.value.streamPreference == StreamModePreference.AUTO &&
            _uiState.value.activeRoute == "Remote"
        ) {
            autoRelayFallbackJob = scope.launch {
                delay(6_000L)
                val ui = _uiState.value
                val gotFrame = lastWebRtcFrameMs.get() > 0L
                if (wsConnected.get() && ui.cameraOnline && ui.activeStreamMode == "webrtc" &&
                    (!ui.rtcConnected || !gotFrame)
                ) {
                    activateWsRelay(reason = "Remote WebRTC did not deliver frames within 6s")
                }
            }
        }
    }

    private fun handleRtcOffer(sdp: String) {
        watchInFlight.set(false)
        watchTimeoutJob?.cancel()
        if (_uiState.value.activeStreamMode == "ws_relay") {
            return
        }
        rtcExecutor.execute {
            if (stopped.get()) return@execute
            ensureRtcFactory()
            closePeerConnectionLocked()

            val rtcConfig = PeerConnection.RTCConfiguration(iceServers).apply {
                sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
                continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY
            }

            var createdPc: PeerConnection? = null
            val pc = factory!!.createPeerConnection(rtcConfig, object : PeerConnection.Observer {
                override fun onSignalingChange(state: PeerConnection.SignalingState?) {}

                override fun onIceConnectionChange(state: PeerConnection.IceConnectionState?) {
                    rtcExecutor.execute {
                        if (peerConnection !== createdPc) return@execute
                        Log.d(TAG, "Monitor ICE state: $state")
                        val connected = state == PeerConnection.IceConnectionState.CONNECTED ||
                            state == PeerConnection.IceConnectionState.COMPLETED

                        if (connected) {
                            iceDisconnectGraceJob?.cancel()
                            lastWebRtcFrameMs.set(SystemClock.elapsedRealtime())
                        }

                        _uiState.update {
                            it.copy(
                                rtcConnected = connected,
                                statusText = when {
                                    connected -> "Live"
                                    state == PeerConnection.IceConnectionState.CHECKING -> "Connecting video..."
                                    state == PeerConnection.IceConnectionState.DISCONNECTED -> "Reconnecting video..."
                                    state == PeerConnection.IceConnectionState.FAILED -> "Video interrupted..."
                                    else -> it.statusText
                                }
                            )
                        }

                        if (state == PeerConnection.IceConnectionState.DISCONNECTED) {
                            iceDisconnectGraceJob?.cancel()
                            iceDisconnectGraceJob = scope.launch {
                                delay(5_000L)
                                if (wsConnected.get() && _uiState.value.cameraOnline &&
                                    !_uiState.value.rtcConnected && peerConnection === createdPc
                                ) {
                                    Log.w(TAG, "Monitor ICE DISCONNECTED >5s — triggering recovery")
                                    if (_uiState.value.streamPreference == StreamModePreference.AUTO) {
                                        activateWsRelay(reason = "ICE disconnected >5s")
                                    } else {
                                        sendWatchRequest()
                                    }
                                }
                            }
                        } else if (state == PeerConnection.IceConnectionState.FAILED && _uiState.value.cameraOnline) {
                            iceDisconnectGraceJob?.cancel()
                            scope.launch {
                                if (_uiState.value.streamPreference == StreamModePreference.AUTO) {
                                    activateWsRelay(reason = "ICE failed")
                                } else {
                                    delay(1500L)
                                    if (wsConnected.get() && _uiState.value.cameraOnline && peerConnection === createdPc) {
                                        sendWatchRequest()
                                    }
                                }
                            }
                        }
                    }
                }

                override fun onIceConnectionReceivingChange(receiving: Boolean) {}
                override fun onIceGatheringChange(state: PeerConnection.IceGatheringState?) {}

                override fun onIceCandidate(candidate: IceCandidate?) {
                    if (candidate == null) return
                    rtcExecutor.execute {
                        if (peerConnection !== createdPc) return@execute
                        sendWsJson(
                            PurrJson.encodeToString(
                                RtcIceMsg(
                                    viewerId = clientId,
                                    candidate = IceCandidateDto(
                                        candidate = candidate.sdp,
                                        sdpMid = candidate.sdpMid,
                                        sdpMLineIndex = candidate.sdpMLineIndex
                                    )
                                )
                            )
                        )
                    }
                }

                override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>?) {}
                override fun onAddStream(stream: MediaStream?) {}
                override fun onRemoveStream(stream: MediaStream?) {}
                override fun onDataChannel(channel: DataChannel?) {}
                override fun onRenegotiationNeeded() {}
                override fun onAddTrack(receiver: RtpReceiver?, streams: Array<out MediaStream>?) {}

                override fun onTrack(transceiver: RtpTransceiver?) {
                    val track = transceiver?.receiver?.track() ?: return
                    rtcExecutor.execute {
                        if (peerConnection !== createdPc) return@execute
                        when (track) {
                            is VideoTrack -> {
                                remoteVideoTrack = track
                                track.setEnabled(true)
                                if (videoSink != null) {
                                    try {
                                        track.addSink(frameWatchSink)
                                    } catch (_: Exception) {
                                    }
                                }
                            }
                            is AudioTrack -> {
                                remoteAudioTrack = track
                                track.setEnabled(!_uiState.value.remoteAudioMuted)
                                configureMonitorAudio()
                            }
                        }
                    }
                }
            }) ?: return@execute

            createdPc = pc
            peerConnection = pc
            remoteDescSet = false
            pendingRemoteIce.clear()

            localTalkbackTrack?.let { micTrack ->
                micTrack.setEnabled(_uiState.value.talkbackActive)
                pc.addTrack(micTrack, listOf("monitor-talkback-stream"))
            }

            val remoteOffer = SessionDescription(SessionDescription.Type.OFFER, sdp)
            pc.setRemoteDescription(object : SimpleSdpObserver("monitor-setRemote") {
                override fun onSetSuccess() {
                    rtcExecutor.execute {
                        if (peerConnection !== createdPc) return@execute
                        remoteDescSet = true
                        pendingRemoteIce.forEach { pc.addIceCandidate(it) }
                        pendingRemoteIce.clear()

                        pc.createAnswer(object : SimpleSdpObserver("monitor-createAnswer") {
                            override fun onCreateSuccess(desc: SessionDescription?) {
                                if (desc == null) return
                                pc.setLocalDescription(object : SimpleSdpObserver("monitor-setLocal") {
                                    override fun onSetSuccess() {
                                        sendWsJson(
                                            PurrJson.encodeToString(
                                                RtcAnswerMsg(viewerId = clientId, sdp = desc.description)
                                            )
                                        )
                                    }
                                }, desc)
                            }
                        }, MediaConstraints())
                    }
                }
            }, remoteOffer)
        }
    }

    @Suppress("DEPRECATION")
    private fun configureMonitorAudio() {
        try {
            audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
            audioManager.isSpeakerphoneOn = true
        } catch (_: Exception) {
        }
    }

    private suspend fun downloadAndSaveSnapshotToGallery(meta: SnapshotMeta) = withContext(Dispatchers.IO) {
        try {
            val bytes = fetchSnapshotBytes(meta) ?: return@withContext
            val saved = saveJpegToGallery(meta.filename, bytes)
            _uiState.update {
                it.copy(
                    toastMessage = if (saved) "Saved to Phone Gallery" else "Snapshot saved on server"
                )
            }
        } catch (e: Exception) {
            Log.w(TAG, "Failed to save snapshot to gallery: ${e.message}")
            _uiState.update { it.copy(toastMessage = "Snapshot saved on server") }
        }
    }

    private fun saveJpegToGallery(filename: String, jpegBytes: ByteArray): Boolean {
        return try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                val values = ContentValues().apply {
                    put(MediaStore.Images.Media.DISPLAY_NAME, filename)
                    put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg")
                    put(MediaStore.Images.Media.RELATIVE_PATH, "${Environment.DIRECTORY_PICTURES}/PurrCam")
                    put(MediaStore.Images.Media.IS_PENDING, 1)
                }
                val resolver = appContext.contentResolver
                val uri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values)
                    ?: return false
                resolver.openOutputStream(uri)?.use { it.write(jpegBytes) }
                values.clear()
                values.put(MediaStore.Images.Media.IS_PENDING, 0)
                resolver.update(uri, values, null, null)
                true
            } else {
                @Suppress("DEPRECATION")
                val dir = File(
                    Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES),
                    "PurrCam"
                )
                dir.mkdirs()
                FileOutputStream(File(dir, filename)).use { it.write(jpegBytes) }
                true
            }
        } catch (e: Exception) {
            Log.w(TAG, "saveJpegToGallery error: ${e.message}")
            false
        }
    }

    private fun sendWsJson(json: String) {
        try {
            webSocket?.send(json)
        } catch (_: Exception) {
        }
    }

    private fun closePeerConnectionLocked() {
        try {
            remoteVideoTrack?.removeSink(frameWatchSink)
        } catch (_: Exception) {
        }
        remoteVideoTrack = null
        remoteAudioTrack = null
        remoteDescSet = false
        pendingRemoteIce.clear()
        try {
            peerConnection?.close()
            peerConnection?.dispose()
        } catch (_: Exception) {
        }
        peerConnection = null
    }

    fun stop() {
        if (!stopped.compareAndSet(false, true)) return
        wsGeneration.incrementAndGet()
        if (wsConnected.get()) {
            if (_uiState.value.activeStreamMode == "ws_relay") {
                sendWsJson(PurrJson.encodeToString(StreamModeMsg(viewerId = clientId, mode = "webrtc")))
            }
            sendWsJson(PurrJson.encodeToString(WatchStopMsg(viewerId = clientId)))
        }
        reconnectJob?.cancel()
        pingJob?.cancel()
        watchTimeoutJob?.cancel()
        autoRelayFallbackJob?.cancel()
        iceDisconnectGraceJob?.cancel()
        frameStallWatchdogJob?.cancel()
        unregisterNetworkCallback()
        wsConnected.set(false)
        try {
            webSocket?.close(1000, "viewer_closed")
        } catch (_: Exception) {
        }
        webSocket = null

        rtcExecutor.execute {
            closePeerConnectionLocked()
            videoSink = null
            try {
                localTalkbackTrack?.dispose()
                localAudioSource?.dispose()
                factory?.dispose()
                audioDeviceModule?.release()
                eglBase.release()
            } catch (_: Exception) {
            }
            try {
                audioManager.mode = AudioManager.MODE_NORMAL
                @Suppress("DEPRECATION")
                audioManager.isSpeakerphoneOn = false
            } catch (_: Exception) {
            }
        }
        rtcExecutor.shutdown()
        scope.cancel()
    }

    companion object {
        private const val TAG = "PurrCamMonitor"
        private const val WS_PONG_TIMEOUT_MS = 45_000L
        private const val FRAME_STALL_TIMEOUT_MS = 10_000L
    }
}
