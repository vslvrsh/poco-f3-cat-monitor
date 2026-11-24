package com.purrcam.app.camera

import android.content.Context
import android.media.AudioManager
import android.util.Log
import com.purrcam.app.protocol.IceCandidateDto
import com.purrcam.app.protocol.IceServerConfig
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
import org.webrtc.RtpSender
import org.webrtc.RtpTransceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.SurfaceTextureHelper
import org.webrtc.VideoSink
import org.webrtc.VideoSource
import org.webrtc.VideoTrack
import org.webrtc.audio.JavaAudioDeviceModule
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

class CameraWebRtcManager(
    private val context: Context,
    private val initialLens: LensDescriptor,
    private val hasMicPermission: Boolean,
    private val onOfferReady: (viewerId: String, sdp: String) -> Unit,
    private val onLocalIce: (viewerId: String, candidate: IceCandidateDto) -> Unit,
    private val onViewerCountChanged: (Int) -> Unit,
    private val onCameraError: (String) -> Unit
) {
    private val appContext = context.applicationContext
    private val executor = Executors.newSingleThreadScheduledExecutor { r ->
        Thread(r, "PurrCam-WebRTC").apply { isDaemon = true }
    }
    private val audioManager = appContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager

    val eglBase: EglBase = EglBase.create()

    private var factory: PeerConnectionFactory? = null
    private var audioDeviceModule: JavaAudioDeviceModule? = null
    private var surfaceTextureHelper: SurfaceTextureHelper? = null
    private var videoSource: VideoSource? = null
    private var videoTrack: VideoTrack? = null
    private var audioSource: AudioSource? = null
    private var audioTrack: AudioTrack? = null

    var capturer: CustomCamera2Capturer? = null
        private set

    private val disposed = AtomicBoolean(false)

    @Volatile
    private var iceServers: List<PeerConnection.IceServer> = listOf(
        PeerConnection.IceServer.builder("stun:stun.l.google.com:19302").createIceServer(),
        PeerConnection.IceServer.builder("stun:stun1.l.google.com:19302").createIceServer(),
        PeerConnection.IceServer.builder("stun:stun.cloudflare.com:3478").createIceServer()
    )

    @Volatile
    private var targetBitrateKbps: Int = 1800

    @Volatile
    private var micEnabled: Boolean = true

    @Volatile
    private var speakerEnabled: Boolean = true

    private var previewSink: VideoSink? = null
    private var relaySink: VideoSink? = null

    private data class ViewerPeer(
        val viewerId: String,
        val pc: PeerConnection,
        val videoSender: RtpSender?,
        var remoteDescSet: Boolean = false,
        val pendingRemoteIce: MutableList<IceCandidate> = mutableListOf(),
        val remoteAudioTracks: MutableList<AudioTrack> = mutableListOf(),
        var disconnectGraceFuture: ScheduledFuture<*>? = null
    )

    private val peers = ConcurrentHashMap<String, ViewerPeer>()

    fun start(width: Int, height: Int, fps: Int, bitrateKbps: Int) {
        targetBitrateKbps = bitrateKbps
        executor.execute {
            if (disposed.get()) return@execute
            try {
                initWebRtcOnce()
                val cap = CustomCamera2Capturer(appContext, initialLens, onCameraError)
                capturer = cap

                val helper = SurfaceTextureHelper.create("PurrCam-CaptureTex", eglBase.eglBaseContext)
                surfaceTextureHelper = helper

                val vSource = factory!!.createVideoSource(false)
                videoSource = vSource
                cap.initialize(helper, appContext, vSource.capturerObserver)
                cap.startCapture(width, height, fps)

                val vTrack = factory!!.createVideoTrack("purrcam-video", vSource).apply {
                    setEnabled(true)
                }
                videoTrack = vTrack
                previewSink?.let { sink ->
                    try {
                        vTrack.addSink(sink)
                    } catch (_: Exception) {
                    }
                }
                relaySink?.let { sink ->
                    try {
                        vTrack.addSink(sink)
                    } catch (_: Exception) {
                    }
                }

                if (hasMicPermission) {
                    val audioConstraints = MediaConstraints().apply {
                        mandatory.add(MediaConstraints.KeyValuePair("googEchoCancellation", "true"))
                        mandatory.add(MediaConstraints.KeyValuePair("googNoiseSuppression", "true"))
                        mandatory.add(MediaConstraints.KeyValuePair("googAutoGainControl", "true"))
                    }
                    val aSource = factory!!.createAudioSource(audioConstraints)
                    audioSource = aSource
                    audioTrack = factory!!.createAudioTrack("purrcam-audio", aSource).apply {
                        setEnabled(micEnabled)
                    }
                }

                configureAudioRouting(speakerEnabled)
                Log.i(TAG, "CameraWebRtcManager started (${width}x${height}@${fps}fps, mic=$hasMicPermission)")
            } catch (e: Exception) {
                Log.e(TAG, "Failed to initialize CameraWebRtcManager", e)
                onCameraError("WebRTC init error: ${e.message}")
            }
        }
    }

    private fun initWebRtcOnce() {
        ensureFactoryInitialized(appContext)
        val adm = JavaAudioDeviceModule.builder(appContext)
            .setUseHardwareAcousticEchoCanceler(true)
            .setUseHardwareNoiseSuppressor(true)
            .createAudioDeviceModule()
        audioDeviceModule = adm

        val encoderFactory = DefaultVideoEncoderFactory(eglBase.eglBaseContext, true, true)
        val decoderFactory = DefaultVideoDecoderFactory(eglBase.eglBaseContext)

        factory = PeerConnectionFactory.builder()
            .setAudioDeviceModule(adm)
            .setVideoEncoderFactory(encoderFactory)
            .setVideoDecoderFactory(decoderFactory)
            .createPeerConnectionFactory()
    }

    fun updateIceServers(configs: List<IceServerConfig>) {
        val converted = configs.mapNotNull { it.toWebRtcIceServer() }
        if (converted.isNotEmpty()) {
            iceServers = converted
        }
    }

    fun attachPreviewSink(sink: VideoSink?) {
        executor.execute {
            val track = videoTrack
            previewSink?.let { old ->
                try {
                    track?.removeSink(old)
                } catch (_: Exception) {
                }
            }
            previewSink = sink
            if (sink != null && track != null) {
                try {
                    track.addSink(sink)
                } catch (_: Exception) {
                }
            }
        }
    }

    fun attachRelaySink(sink: VideoSink?) {
        executor.execute {
            val track = videoTrack
            relaySink?.let { old ->
                try {
                    track?.removeSink(old)
                } catch (_: Exception) {
                }
            }
            relaySink = sink
            if (sink != null && track != null) {
                try {
                    track.addSink(sink)
                } catch (_: Exception) {
                }
            }
        }
    }

    fun handleWatchRequest(viewerId: String) {
        executor.execute {
            if (disposed.get() || factory == null) return@execute
            closePeerLocked(viewerId)

            val rtcConfig = PeerConnection.RTCConfiguration(iceServers).apply {
                sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
                continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY
                iceTransportsType = PeerConnection.IceTransportsType.ALL
            }

            val peerRef = AtomicReference<ViewerPeer?>(null)
            val pc = factory!!.createPeerConnection(rtcConfig, object : PeerConnection.Observer {
                override fun onSignalingChange(state: PeerConnection.SignalingState?) {}

                override fun onIceConnectionChange(state: PeerConnection.IceConnectionState?) {
                    Log.d(TAG, "Viewer $viewerId ICE state: $state")
                    executor.execute {
                        val target = peerRef.get() ?: return@execute
                        if (peers[viewerId] !== target) return@execute
                        when (state) {
                            PeerConnection.IceConnectionState.CONNECTED,
                            PeerConnection.IceConnectionState.COMPLETED -> {
                                target.disconnectGraceFuture?.cancel(false)
                                target.disconnectGraceFuture = null
                            }
                            PeerConnection.IceConnectionState.DISCONNECTED -> {
                                target.disconnectGraceFuture?.cancel(false)
                                target.disconnectGraceFuture = executor.schedule({
                                    if (peers[viewerId] === target && !disposed.get()) {
                                        Log.w(TAG, "Viewer $viewerId ICE DISCONNECTED >5s — closing stale peer")
                                        closePeerLocked(viewerId, expectedPeer = target)
                                    }
                                }, 5, TimeUnit.SECONDS)
                            }
                            PeerConnection.IceConnectionState.FAILED,
                            PeerConnection.IceConnectionState.CLOSED -> {
                                closePeerLocked(viewerId, expectedPeer = target)
                            }
                            else -> {}
                        }
                    }
                }

                override fun onIceConnectionReceivingChange(receiving: Boolean) {}
                override fun onIceGatheringChange(state: PeerConnection.IceGatheringState?) {}

                override fun onIceCandidate(candidate: IceCandidate?) {
                    if (candidate == null) return
                    val target = peerRef.get()
                    if (target != null && peers[viewerId] !== target) return
                    onLocalIce(
                        viewerId,
                        IceCandidateDto(
                            candidate = candidate.sdp,
                            sdpMid = candidate.sdpMid,
                            sdpMLineIndex = candidate.sdpMLineIndex
                        )
                    )
                }

                override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>?) {}
                override fun onAddStream(stream: MediaStream?) {}
                override fun onRemoveStream(stream: MediaStream?) {}
                override fun onDataChannel(channel: DataChannel?) {}
                override fun onRenegotiationNeeded() {}

                override fun onAddTrack(receiver: RtpReceiver?, streams: Array<out MediaStream>?) {
                    val track = receiver?.track()
                    if (track is AudioTrack) {
                        executor.execute {
                            val peer = peerRef.get()
                            if (peer == null || peers[viewerId] !== peer) return@execute
                            track.setEnabled(speakerEnabled)
                            if (!peer.remoteAudioTracks.contains(track)) {
                                peer.remoteAudioTracks.add(track)
                            }
                            configureAudioRouting(speakerEnabled)
                            Log.i(TAG, "Talkback audio track attached from viewer $viewerId (speaker=$speakerEnabled)")
                        }
                    }
                }

                override fun onTrack(transceiver: RtpTransceiver?) {
                    val track = transceiver?.receiver?.track()
                    if (track is AudioTrack) {
                        executor.execute {
                            val peer = peerRef.get()
                            if (peer == null || peers[viewerId] !== peer) return@execute
                            track.setEnabled(speakerEnabled)
                            if (!peer.remoteAudioTracks.contains(track)) {
                                peer.remoteAudioTracks.add(track)
                            }
                            configureAudioRouting(speakerEnabled)
                        }
                    }
                }
            }) ?: return@execute

            val streamIds = listOf("purrcam-stream")
            val vSender = videoTrack?.let { pc.addTrack(it, streamIds) }
            audioTrack?.let { pc.addTrack(it, streamIds) }

            if (vSender != null) {
                applySenderBitrate(vSender, targetBitrateKbps)
            }

            val holder = ViewerPeer(viewerId = viewerId, pc = pc, videoSender = vSender)
            peerRef.set(holder)
            peers[viewerId] = holder
            onViewerCountChanged(peers.size)

            val offerConstraints = MediaConstraints().apply {
                mandatory.add(MediaConstraints.KeyValuePair("OfferToReceiveAudio", "true"))
                mandatory.add(MediaConstraints.KeyValuePair("OfferToReceiveVideo", "false"))
            }

            pc.createOffer(object : SimpleSdpObserver("createOffer-$viewerId") {
                override fun onCreateSuccess(desc: SessionDescription?) {
                    if (desc == null || peers[viewerId] !== holder) return
                    pc.setLocalDescription(object : SimpleSdpObserver("setLocal-$viewerId") {
                        override fun onSetSuccess() {
                            if (peers[viewerId] === holder) {
                                onOfferReady(viewerId, desc.description)
                            }
                        }
                    }, desc)
                }
            }, offerConstraints)
        }
    }

    fun handleAnswer(viewerId: String, sdp: String) {
        executor.execute {
            val peer = peers[viewerId] ?: return@execute
            val remoteDesc = SessionDescription(SessionDescription.Type.ANSWER, sdp)
            peer.pc.setRemoteDescription(object : SimpleSdpObserver("setRemote-$viewerId") {
                override fun onSetSuccess() {
                    executor.execute {
                        peer.remoteDescSet = true
                        peer.pendingRemoteIce.forEach { ice ->
                            peer.pc.addIceCandidate(ice)
                        }
                        peer.pendingRemoteIce.clear()
                    }
                }
            }, remoteDesc)
        }
    }

    fun handleRemoteIce(viewerId: String, dto: IceCandidateDto) {
        executor.execute {
            val peer = peers[viewerId] ?: return@execute
            val ice = IceCandidate(dto.sdpMid ?: "0", dto.sdpMLineIndex, dto.candidate)
            if (peer.remoteDescSet) {
                peer.pc.addIceCandidate(ice)
            } else {
                peer.pendingRemoteIce.add(ice)
            }
        }
    }

    fun handleViewerRemoved(viewerId: String) {
        executor.execute {
            closePeerLocked(viewerId)
        }
    }

    fun setVideoBitrate(bitrateKbps: Int) {
        targetBitrateKbps = bitrateKbps.coerceIn(250, 8000)
        executor.execute {
            peers.values.forEach { peer ->
                peer.videoSender?.let { applySenderBitrate(it, targetBitrateKbps) }
            }
        }
    }

    fun setMicEnabled(enabled: Boolean) {
        micEnabled = enabled
        executor.execute {
            audioTrack?.setEnabled(enabled)
        }
    }

    fun setSpeakerEnabled(enabled: Boolean) {
        speakerEnabled = enabled
        executor.execute {
            peers.values.forEach { peer ->
                peer.remoteAudioTracks.forEach { it.setEnabled(enabled) }
            }
            configureAudioRouting(enabled)
        }
    }

    fun switchLens(lens: LensDescriptor) {
        capturer?.switchLens(lens)
    }

    fun setTorch(enabled: Boolean): Boolean = capturer?.setTorch(enabled) ?: false

    fun setExposure(ev: Float) {
        capturer?.setExposure(ev)
    }

    fun setZoom(ratio: Float) {
        capturer?.setZoom(ratio)
    }

    fun updateVideoConfig(width: Int, height: Int, fps: Int, bitrateKbps: Int) {
        capturer?.updateVideoConfig(width, height, fps)
        setVideoBitrate(bitrateKbps)
    }

    suspend fun captureSnapshotJpeg(): ByteArray? = capturer?.captureSnapshotJpeg()

    fun getMeasuredFps(): Int = capturer?.measuredFps ?: 0

    fun rebootPipeline() {
        executor.execute {
            capturer?.restartCapture()
            val viewerIds = peers.keys.toList()
            viewerIds.forEach { vid ->
                handleWatchRequest(vid)
            }
        }
    }

    private fun applySenderBitrate(sender: RtpSender, kbps: Int) {
        try {
            val params = sender.parameters
            params.encodings.forEach { enc ->
                enc.maxBitrateBps = kbps * 1000
                enc.minBitrateBps = (kbps * 250).coerceAtLeast(150_000)
            }
            sender.parameters = params
        } catch (e: Exception) {
            Log.w(TAG, "Failed to apply bitrate $kbps kbps: ${e.message}")
        }
    }

    @Suppress("DEPRECATION")
    private fun configureAudioRouting(speakerOn: Boolean) {
        try {
            audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
            audioManager.isSpeakerphoneOn = speakerOn
            audioDeviceModule?.setSpeakerMute(!speakerOn)
        } catch (e: Exception) {
            Log.w(TAG, "Audio routing update failed: ${e.message}")
        }
    }

    private fun closePeerLocked(viewerId: String, expectedPeer: ViewerPeer? = null) {
        val current = peers[viewerId] ?: return
        if (expectedPeer != null && current !== expectedPeer) return
        val removed = peers.remove(viewerId) ?: return
        removed.disconnectGraceFuture?.cancel(false)
        removed.disconnectGraceFuture = null
        try {
            removed.pc.close()
            removed.pc.dispose()
        } catch (_: Exception) {
        }
        onViewerCountChanged(peers.size)
    }

    fun dispose() {
        if (!disposed.compareAndSet(false, true)) return
        executor.execute {
            val allIds = peers.keys.toList()
            allIds.forEach { closePeerLocked(it) }

            previewSink?.let { sink ->
                try {
                    videoTrack?.removeSink(sink)
                } catch (_: Exception) {
                }
            }
            previewSink = null

            relaySink?.let { sink ->
                try {
                    videoTrack?.removeSink(sink)
                } catch (_: Exception) {
                }
            }
            relaySink = null

            try {
                capturer?.dispose()
            } catch (_: Exception) {
            }
            capturer = null

            try {
                videoTrack?.dispose()
                videoSource?.dispose()
                audioTrack?.dispose()
                audioSource?.dispose()
                surfaceTextureHelper?.dispose()
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
        executor.shutdown()
    }

    companion object {
        private const val TAG = "PurrCamWebRTC"
        private val webrtcInitialized = AtomicBoolean(false)

        fun ensureFactoryInitialized(context: Context) {
            if (webrtcInitialized.compareAndSet(false, true)) {
                PeerConnectionFactory.initialize(
                    PeerConnectionFactory.InitializationOptions.builder(context.applicationContext)
                        .setEnableInternalTracer(false)
                        .createInitializationOptions()
                )
            }
        }
    }
}

open class SimpleSdpObserver(private val label: String) : SdpObserver {
    override fun onCreateSuccess(desc: SessionDescription?) {}
    override fun onSetSuccess() {}
    override fun onCreateFailure(error: String?) {
        Log.e("PurrCamSDP", "$label createFailure: $error")
    }
    override fun onSetFailure(error: String?) {
        Log.e("PurrCamSDP", "$label setFailure: $error")
    }
}
