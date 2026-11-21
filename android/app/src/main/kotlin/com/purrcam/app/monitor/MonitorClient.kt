package com.purrcam.app.monitor

import android.Manifest
import android.content.ContentValues
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioManager
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Log
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
import org.webrtc.VideoSink
import org.webrtc.VideoTrack
import org.webrtc.audio.JavaAudioDeviceModule
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

data class MonitorUiState(
    val wsConnected: Boolean = false,
    val activeRoute: String = "Local", // "Local" | "Remote"
    val activeHttpBaseUrl: String = "http://127.0.0.1:8787",
    val cameraOnline: Boolean = false,
    val rtcConnected: Boolean = false,
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

    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(8, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .writeTimeout(15, TimeUnit.SECONDS)
        .pingInterval(20, TimeUnit.SECONDS)
        .build()

    // Fast 2.5s connect timeout when probing Local LAN with Remote failover configured
    private val localProbeClient = httpClient.newBuilder()
        .connectTimeout(2500, TimeUnit.MILLISECONDS)
        .build()

    // Standard HTTP client for REST calls (gallery, snapshots)
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
    private var authToken: String = ""
    private var clientId: String = prefs.getOrCreateClientId()

    @Volatile
    private var webSocket: WebSocket? = null
    private val wsGeneration = AtomicInteger(0)
    private var reconnectJob: Job? = null
    private var pingJob: Job? = null
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
        rtcExecutor.execute { ensureRtcFactory() }
        connectWs()
    }

    fun reconnectWith(localUrl: String, remoteUrl: String, token: String) {
        prefs.localServerUrl = localUrl
        prefs.remoteServerUrl = remoteUrl
        prefs.authToken = token
        configureEndpoints(localUrl, remoteUrl, token)
        reconnectDelayMs = 1000L
        connectWs()
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

        authToken = explicitToken.takeIf { it.isNotBlank() }
            ?: localEndpoint.tokenFromUrl
            ?: remoteEndpoint?.tokenFromUrl
            ?: prefs.authToken
    }

    fun attachVideoSink(sink: VideoSink?) {
        rtcExecutor.execute {
            videoSink?.let { old ->
                try {
                    remoteVideoTrack?.removeSink(old)
                } catch (_: Exception) {
                }
            }
            videoSink = sink
            if (sink != null && remoteVideoTrack != null) {
                try {
                    remoteVideoTrack?.addSink(sink)
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
                sendWatchRequest()
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
        wsConnected.set(false)
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
                reconnectDelayMs = 1000L
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
                startPingLoop()
                refreshSnapshots()
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                if (gen != wsGeneration.get()) return
                scope.launch { handleMessage(text) }
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                if (gen != wsGeneration.get()) return
                onWsDisconnected(
                    reason = if (code == 4001) "Unauthorized token" else "Disconnected ($code)",
                    immediateFailover = false
                )
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                if (gen != wsGeneration.get()) return
                val canFastFailover = !tryingRemote && remoteEndpoint != null && !wsConnected.get()
                onWsDisconnected(
                    reason = t.message ?: "Network error",
                    immediateFailover = canFastFailover
                )
            }
        })
    }

    private fun onWsDisconnected(reason: String, immediateFailover: Boolean) {
        wsConnected.set(false)
        watchInFlight.set(false)
        pingJob?.cancel()
        rtcExecutor.execute { closePeerConnectionLocked() }

        if (immediateFailover && remoteEndpoint != null && !stopped.get()) {
            tryingRemote = true
            _uiState.update {
                it.copy(
                    wsConnected = false,
                    rtcConnected = false,
                    activeRoute = "Remote",
                    statusText = "Trying Remote tunnel..."
                )
            }
            scope.launch {
                delay(150)
                if (!stopped.get()) connectWs()
            }
            return
        }

        if (remoteEndpoint != null) {
            tryingRemote = !tryingRemote
        }

        _uiState.update {
            it.copy(
                wsConnected = false,
                rtcConnected = false,
                statusText = "$reason · reconnecting..."
            )
        }
        if (!stopped.get()) {
            reconnectJob?.cancel()
            reconnectJob = scope.launch {
                val wait = reconnectDelayMs
                reconnectDelayMs = (reconnectDelayMs * 2).coerceAtMost(8000L)
                delay(wait)
                if (isActive && !stopped.get()) connectWs()
            }
        }
    }

    private fun startPingLoop() {
        pingJob?.cancel()
        pingJob = scope.launch {
            while (isActive && wsConnected.get()) {
                delay(15_000L)
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
                if (online && (!wasOnline || (peerConnection == null && !watchInFlight.get()))) {
                    sendWatchRequest()
                } else if (!online) {
                    watchInFlight.set(false)
                    rtcExecutor.execute { closePeerConnectionLocked() }
                    _uiState.update { it.copy(rtcConnected = false) }
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
        sendWsJson(PurrJson.encodeToString(WatchRequestMsg(viewerId = clientId)))
    }

    private fun handleRtcOffer(sdp: String) {
        watchInFlight.set(false)
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
                        _uiState.update {
                            it.copy(
                                rtcConnected = connected,
                                statusText = when {
                                    connected -> "Live"
                                    state == PeerConnection.IceConnectionState.CHECKING -> "Connecting video..."
                                    state == PeerConnection.IceConnectionState.FAILED -> "Reconnecting video..."
                                    else -> it.statusText
                                }
                            )
                        }
                        if (state == PeerConnection.IceConnectionState.FAILED && _uiState.value.cameraOnline) {
                            scope.launch {
                                delay(1500)
                                if (wsConnected.get() && _uiState.value.cameraOnline && peerConnection === createdPc) {
                                    sendWatchRequest()
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
                                videoSink?.let { sink ->
                                    try {
                                        track.addSink(sink)
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
        videoSink?.let { sink ->
            try {
                remoteVideoTrack?.removeSink(sink)
            } catch (_: Exception) {
            }
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
            sendWsJson(PurrJson.encodeToString(WatchStopMsg(viewerId = clientId)))
        }
        reconnectJob?.cancel()
        pingJob?.cancel()
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
    }
}
