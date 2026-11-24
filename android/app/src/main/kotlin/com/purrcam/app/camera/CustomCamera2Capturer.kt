package com.purrcam.app.camera

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.ImageFormat
import android.graphics.Matrix
import android.graphics.Rect
import android.graphics.SurfaceTexture
import android.graphics.YuvImage
import android.hardware.camera2.CameraAccessException
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CaptureRequest
import android.hardware.camera2.params.OutputConfiguration
import android.hardware.camera2.params.SessionConfiguration
import android.media.ImageReader
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import android.util.Log
import android.util.Range
import android.util.Size
import android.view.Surface
import android.view.WindowManager
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.withTimeoutOrNull
import org.webrtc.CapturerObserver
import org.webrtc.SurfaceTextureHelper
import org.webrtc.TextureBufferImpl
import org.webrtc.VideoCapturer
import org.webrtc.VideoFrame
import java.io.ByteArrayOutputStream
import java.util.concurrent.Executor
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlin.math.abs
import kotlin.math.roundToInt

class CustomCamera2Capturer(
    private val context: Context,
    initialLens: LensDescriptor,
    private val onCameraError: (String) -> Unit = {}
) : VideoCapturer {

    private val cameraManager = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
    private val lock = Any()

    private var surfaceTextureHelper: SurfaceTextureHelper? = null
    private var capturerObserver: CapturerObserver? = null

    private var cameraThread: HandlerThread? = null
    private var cameraHandler: Handler? = null

    private var cameraDevice: CameraDevice? = null
    private var captureSession: CameraCaptureSession? = null
    private var previewSurface: Surface? = null
    private var jpegImageReader: ImageReader? = null

    @Volatile
    var currentLens: LensDescriptor = initialLens
        private set

    @Volatile
    private var currentCharacteristics: CameraCharacteristics? = null
    private var usingFallbackTarget = false
    private var targetWidth = 1280
    private var targetHeight = 720
    private var targetFps = 24
    private var captureWidth = 1280
    private var captureHeight = 720

    @Volatile
    private var torchEnabled = false

    @Volatile
    private var exposureEv = 0f

    @Volatile
    private var userZoomRatio = 1.0f

    private val isRunning = AtomicBoolean(false)
    private val isDisposed = AtomicBoolean(false)
    private val openGeneration = AtomicInteger(0)

    // Measured FPS & stall watchdog tracking
    private var fpsWindowStartNs = 0L
    private var fpsFrameCounter = 0

    @Volatile
    private var lastFrameElapsedMs = 0L

    @Volatile
    var measuredFps: Int = 0
        private set

    private val stallWatchdogRunnable = object : Runnable {
        override fun run() {
            if (!isRunning.get() || isDisposed.get()) return
            val now = SystemClock.elapsedRealtime()
            val last = lastFrameElapsedMs
            if (last > 0L && now - last > STALL_TIMEOUT_MS) {
                Log.w(TAG, "Camera2 stall watchdog triggered (${now - last}ms without frames) — reopening camera")
                lastFrameElapsedMs = now
                restartCapture()
            }
            cameraHandler?.postDelayed(this, STALL_CHECK_INTERVAL_MS)
        }
    }

    // Snapshot requests
    private val pendingJpegSnapshot = AtomicReference<CompletableDeferred<ByteArray?>?>(null)
    private val pendingFrameSnapshot = AtomicReference<CompletableDeferred<ByteArray?>?>(null)

    override fun initialize(
        surfaceTextureHelper: SurfaceTextureHelper,
        applicationContext: Context,
        capturerObserver: CapturerObserver
    ) {
        this.surfaceTextureHelper = surfaceTextureHelper
        this.capturerObserver = capturerObserver

        val thread = HandlerThread("PurrCam-Camera2").apply { start() }
        cameraThread = thread
        cameraHandler = Handler(thread.looper)

        surfaceTextureHelper.startListening { frame ->
            onSurfaceFrame(frame)
        }
    }

    override fun startCapture(width: Int, height: Int, framerate: Int) {
        synchronized(lock) {
            if (isDisposed.get()) return
            targetWidth = width.coerceAtLeast(320)
            targetHeight = height.coerceAtLeast(240)
            targetFps = framerate.coerceIn(5, 60)
            isRunning.set(true)
        }
        capturerObserver?.onCapturerStarted(true)
        lastFrameElapsedMs = SystemClock.elapsedRealtime()
        cameraHandler?.removeCallbacks(stallWatchdogRunnable)
        cameraHandler?.postDelayed(stallWatchdogRunnable, STALL_CHECK_INTERVAL_MS)
        cameraHandler?.post {
            usingFallbackTarget = false
            openActiveLensLocked(openGeneration.incrementAndGet())
        }
    }

    override fun stopCapture() {
        isRunning.set(false)
        cameraHandler?.removeCallbacks(stallWatchdogRunnable)
        val gen = openGeneration.incrementAndGet()
        val done = CompletableDeferred<Unit>()
        val handler = cameraHandler
        if (handler != null) {
            handler.post {
                closeCameraResources()
                done.complete(Unit)
            }
            try {
                val deadline = System.currentTimeMillis() + 1200L
                while (!done.isCompleted && System.currentTimeMillis() < deadline) {
                    Thread.sleep(15)
                }
            } catch (_: InterruptedException) {
            }
        } else {
            closeCameraResources()
        }
        capturerObserver?.onCapturerStopped()
        Log.i(TAG, "stopCapture complete (gen=$gen)")
    }

    override fun changeCaptureFormat(width: Int, height: Int, framerate: Int) {
        updateVideoConfig(width, height, framerate)
    }

    override fun dispose() {
        if (!isDisposed.compareAndSet(false, true)) return
        stopCapture()
        try {
            surfaceTextureHelper?.stopListening()
        } catch (_: Exception) {
        }
        cameraThread?.quitSafely()
        cameraThread = null
        cameraHandler = null
    }

    override fun isScreencast(): Boolean = false

    fun switchLens(newLens: LensDescriptor) {
        synchronized(lock) {
            currentLens = newLens
            userZoomRatio = 1.0f
            if (!newLens.info.hasFlash) {
                torchEnabled = false
            }
        }
        if (!isRunning.get()) return
        val gen = openGeneration.incrementAndGet()
        cameraHandler?.post {
            usingFallbackTarget = false
            closeCameraResources()
            openActiveLensLocked(gen)
        }
    }

    fun restartCapture() {
        if (!isRunning.get()) return
        val gen = openGeneration.incrementAndGet()
        cameraHandler?.post {
            usingFallbackTarget = false
            closeCameraResources()
            openActiveLensLocked(gen)
        }
    }

    fun updateVideoConfig(width: Int, height: Int, fps: Int) {
        val needsSessionRebuild: Boolean
        synchronized(lock) {
            val sizeChanged = (width != targetWidth || height != targetHeight)
            targetWidth = width.coerceAtLeast(320)
            targetHeight = height.coerceAtLeast(240)
            targetFps = fps.coerceIn(5, 60)
            needsSessionRebuild = sizeChanged
        }
        if (!isRunning.get()) return
        cameraHandler?.post {
            if (needsSessionRebuild) {
                val gen = openGeneration.incrementAndGet()
                closeCameraResources()
                openActiveLensLocked(gen)
            } else {
                updateRepeatingRequest()
            }
        }
    }

    fun setTorch(enabled: Boolean): Boolean {
        val supported = currentLens.info.hasFlash
        torchEnabled = enabled && supported
        if (isRunning.get()) {
            cameraHandler?.post { updateRepeatingRequest() }
        }
        return supported
    }

    fun setExposure(ev: Float) {
        exposureEv = ev.coerceIn(-3.0f, 3.0f)
        if (isRunning.get()) {
            cameraHandler?.post { updateRepeatingRequest() }
        }
    }

    fun setZoom(ratio: Float) {
        val maxZ = currentLens.info.maxZoom.coerceAtLeast(1.0f)
        userZoomRatio = ratio.coerceIn(1.0f, maxZ)
        if (isRunning.get()) {
            cameraHandler?.post { updateRepeatingRequest() }
        }
    }

    suspend fun captureSnapshotJpeg(): ByteArray? {
        if (!isRunning.get()) return null

        val reader = jpegImageReader
        val session = captureSession
        val device = cameraDevice
        if (reader != null && session != null && device != null) {
            val deferred = CompletableDeferred<ByteArray?>()
            pendingJpegSnapshot.getAndSet(deferred)?.complete(null)
            cameraHandler?.post {
                triggerStillCapture(device, session, reader, deferred)
            }
            val jpeg = withTimeoutOrNull(2500L) { deferred.await() }
            pendingJpegSnapshot.compareAndSet(deferred, null)
            if (jpeg != null && jpeg.isNotEmpty()) {
                return jpeg
            }
        }

        val frameDeferred = CompletableDeferred<ByteArray?>()
        pendingFrameSnapshot.getAndSet(frameDeferred)?.complete(null)
        val fallbackJpeg = withTimeoutOrNull(2000L) { frameDeferred.await() }
        pendingFrameSnapshot.compareAndSet(frameDeferred, null)
        return fallbackJpeg
    }

    private fun triggerStillCapture(
        device: CameraDevice,
        session: CameraCaptureSession,
        reader: ImageReader,
        deferred: CompletableDeferred<ByteArray?>
    ) {
        try {
            val builder = device.createCaptureRequest(CameraDevice.TEMPLATE_STILL_CAPTURE)
            builder.addTarget(reader.surface)
            applyCommonRequestParams(builder)
            builder.set(CaptureRequest.JPEG_QUALITY, 90.toByte())
            builder.set(CaptureRequest.JPEG_ORIENTATION, computeJpegOrientation())
            session.capture(builder.build(), null, cameraHandler)
        } catch (e: Exception) {
            Log.w(TAG, "Still JPEG capture failed, falling back to frame capture: ${e.message}")
            deferred.complete(null)
        }
    }

    /**
     * Matches official WebRTC `org.webrtc.Camera2Session` transform matrix normalization:
     * Camera2 HAL bakes `+sensorOrientation` into SurfaceTexture's transform matrix while keeping
     * landscape buffer dimensions (e.g. 1280x720). Undoing `-sensorOrientation` (and mirroring
     * front camera) restores square-pixel sensor coordinates, and `VideoFrame.rotation` carries the
     * exact upright display orientation for SurfaceViewRenderer and WebRTC remote peers.
     */
    private fun onSurfaceFrame(frame: VideoFrame) {
        val sensorOrientation = currentCharacteristics?.get(CameraCharacteristics.SENSOR_ORIENTATION)
            ?: currentLens.sensorOrientation
        val isFront = currentLens.info.facing == "front"
        val frameOrientation = computeFrameOrientation(sensorOrientation, isFront)

        val rawBuffer = frame.buffer
        val outBuffer: VideoFrame.Buffer = if (rawBuffer is TextureBufferImpl) {
            createNormalizedTextureBuffer(
                buffer = rawBuffer,
                mirror = isFront,
                rotation = -sensorOrientation
            )
        } else {
            rawBuffer.retain()
            rawBuffer
        }

        val outFrame = VideoFrame(outBuffer, frameOrientation, frame.timestampNs)
        try {
            lastFrameElapsedMs = SystemClock.elapsedRealtime()
            // Track measured FPS
            val nowNs = System.nanoTime()
            if (fpsWindowStartNs == 0L) {
                fpsWindowStartNs = nowNs
                fpsFrameCounter = 0
            }
            fpsFrameCounter++
            val elapsedNs = nowNs - fpsWindowStartNs
            if (elapsedNs >= 1_000_000_000L) {
                measuredFps = ((fpsFrameCounter * 1_000_000_000.0) / elapsedNs).roundToInt()
                fpsWindowStartNs = nowNs
                fpsFrameCounter = 0
            }

            // Fulfill frame-based snapshot fallback if requested
            val snapDeferred = pendingFrameSnapshot.getAndSet(null)
            if (snapDeferred != null) {
                try {
                    val jpegBytes = encodeVideoFrameToJpeg(outFrame)
                    snapDeferred.complete(jpegBytes)
                } catch (e: Exception) {
                    Log.w(TAG, "Frame snapshot encoding failed: ${e.message}")
                    snapDeferred.complete(null)
                }
            }

            capturerObserver?.onFrameCaptured(outFrame)
        } finally {
            outFrame.release()
        }
    }

    private fun createNormalizedTextureBuffer(
        buffer: TextureBufferImpl,
        mirror: Boolean,
        rotation: Int
    ): VideoFrame.TextureBuffer {
        val transformMatrix = Matrix().apply {
            preTranslate(0.5f, 0.5f)
            if (mirror) {
                preScale(-1f, 1f)
            }
            preRotate(rotation.toFloat())
            preTranslate(-0.5f, -0.5f)
        }
        return buffer.applyTransformMatrix(transformMatrix, buffer.width, buffer.height)
    }

    private fun encodeVideoFrameToJpeg(frame: VideoFrame): ByteArray? {
        val i420 = frame.buffer.toI420() ?: return null
        return try {
            val w = i420.width
            val h = i420.height
            val nv21 = ByteArray(w * h * 3 / 2)
            val yPlane = i420.dataY
            val uPlane = i420.dataU
            val vPlane = i420.dataV
            val yStride = i420.strideY
            val uStride = i420.strideU
            val vStride = i420.strideV

            var pos = 0
            for (row in 0 until h) {
                yPlane.position(row * yStride)
                yPlane.get(nv21, pos, w)
                pos += w
            }
            val chromaH = h / 2
            val chromaW = w / 2
            for (row in 0 until chromaH) {
                for (col in 0 until chromaW) {
                    nv21[pos++] = vPlane.get(row * vStride + col)
                    nv21[pos++] = uPlane.get(row * uStride + col)
                }
            }

            val baos = ByteArrayOutputStream()
            val yuv = YuvImage(nv21, ImageFormat.NV21, w, h, null)
            yuv.compressToJpeg(Rect(0, 0, w, h), 88, baos)
            baos.toByteArray()
        } finally {
            i420.release()
        }
    }

    @SuppressLint("MissingPermission")
    private fun openActiveLensLocked(gen: Int) {
        if (!isRunning.get() || isDisposed.get() || gen != openGeneration.get()) return

        val lens = currentLens
        val activeCamId = if (usingFallbackTarget && lens.fallbackCameraId != null) {
            lens.fallbackCameraId
        } else {
            lens.info.cameraId
        }
        val activePhysId = if (usingFallbackTarget && lens.fallbackCameraId != null) {
            lens.fallbackPhysicalCameraId
        } else {
            lens.info.physicalCameraId
        }

        Log.i(
            TAG,
            "Opening lens '${lens.info.label}' (id=${lens.info.id}) via camId=$activeCamId physId=$activePhysId baseZoom=${lens.baseZoomRatio} fallback=$usingFallbackTarget"
        )

        val chars = try {
            val charId = activePhysId ?: activeCamId
            cameraManager.getCameraCharacteristics(charId)
        } catch (e: Exception) {
            try {
                cameraManager.getCameraCharacteristics(activeCamId)
            } catch (e2: Exception) {
                handleOpenFailure(gen, "Unable to read camera $activeCamId characteristics: ${e2.message}")
                return
            }
        }
        currentCharacteristics = chars

        val bestSize = chooseBestSize(chars, targetWidth, targetHeight)
        captureWidth = bestSize.width
        captureHeight = bestSize.height

        try {
            cameraManager.openCamera(
                activeCamId,
                object : CameraDevice.StateCallback() {
                    override fun onOpened(device: CameraDevice) {
                        if (!isRunning.get() || gen != openGeneration.get()) {
                            device.close()
                            return
                        }
                        cameraDevice = device
                        createCaptureSession(device, activePhysId, gen, withJpegReader = true)
                    }

                    override fun onDisconnected(device: CameraDevice) {
                        Log.w(TAG, "Camera $activeCamId disconnected")
                        device.close()
                        if (cameraDevice == device) cameraDevice = null
                    }

                    override fun onError(device: CameraDevice, error: Int) {
                        Log.e(TAG, "Camera $activeCamId onError=$error")
                        device.close()
                        if (cameraDevice == device) cameraDevice = null
                        handleOpenFailure(gen, "Camera2 error $error on camera $activeCamId")
                    }
                },
                cameraHandler
            )
        } catch (e: CameraAccessException) {
            handleOpenFailure(gen, "CameraAccessException on camera $activeCamId: ${e.message}")
        } catch (e: SecurityException) {
            onCameraError("Missing CAMERA permission: ${e.message}")
        } catch (e: Exception) {
            handleOpenFailure(gen, "Failed to open camera $activeCamId: ${e.message}")
        }
    }

    private fun handleOpenFailure(gen: Int, reason: String) {
        if (gen != openGeneration.get() || !isRunning.get()) return
        val lens = currentLens
        if (!usingFallbackTarget && lens.fallbackCameraId != null) {
            Log.w(TAG, "$reason — retrying with fallback (${lens.fallbackCameraId}:${lens.fallbackPhysicalCameraId})")
            usingFallbackTarget = true
            closeCameraResources()
            openActiveLensLocked(gen)
            return
        }
        Log.e(TAG, "Lens open failed permanently: $reason")
        onCameraError(reason)
    }

    private fun createCaptureSession(
        device: CameraDevice,
        physicalCameraId: String?,
        gen: Int,
        withJpegReader: Boolean
    ) {
        val helper = surfaceTextureHelper ?: return
        val handler = cameraHandler ?: return

        try {
            helper.setTextureSize(captureWidth, captureHeight)
            previewSurface?.release()
            val pSurface = Surface(helper.surfaceTexture)
            previewSurface = pSurface

            val outputs = mutableListOf<OutputConfiguration>()
            val previewConfig = OutputConfiguration(pSurface).apply {
                if (!physicalCameraId.isNullOrBlank()) {
                    setPhysicalCameraId(physicalCameraId)
                }
            }
            outputs.add(previewConfig)

            jpegImageReader?.close()
            jpegImageReader = null

            if (withJpegReader) {
                val jpegSize = chooseJpegSize(currentCharacteristics)
                val reader = ImageReader.newInstance(jpegSize.width, jpegSize.height, ImageFormat.JPEG, 2)
                reader.setOnImageAvailableListener({ r ->
                    val image = try {
                        r.acquireLatestImage()
                    } catch (_: Exception) {
                        null
                    } ?: return@setOnImageAvailableListener
                    try {
                        val buffer = image.planes[0].buffer
                        val bytes = ByteArray(buffer.remaining())
                        buffer.get(bytes)
                        pendingJpegSnapshot.getAndSet(null)?.complete(bytes)
                    } finally {
                        image.close()
                    }
                }, handler)
                jpegImageReader = reader
                val jpegConfig = OutputConfiguration(reader.surface).apply {
                    if (!physicalCameraId.isNullOrBlank()) {
                        setPhysicalCameraId(physicalCameraId)
                    }
                }
                outputs.add(jpegConfig)
            }

            val executor = Executor { command -> handler.post(command) }
            val sessionConfig = SessionConfiguration(
                SessionConfiguration.SESSION_REGULAR,
                outputs,
                executor,
                object : CameraCaptureSession.StateCallback() {
                    override fun onConfigured(session: CameraCaptureSession) {
                        if (!isRunning.get() || gen != openGeneration.get()) {
                            session.close()
                            return
                        }
                        captureSession = session
                        val sensorOrient = currentCharacteristics?.get(CameraCharacteristics.SENSOR_ORIENTATION)
                            ?: currentLens.sensorOrientation
                        Log.i(
                            TAG,
                            "Session configured for '${currentLens.info.label}' (${captureWidth}x${captureHeight}@${targetFps}fps, sensorOrient=$sensorOrient, phys=$physicalCameraId, jpeg=$withJpegReader)"
                        )
                        updateRepeatingRequest()
                    }

                    override fun onConfigureFailed(session: CameraCaptureSession) {
                        Log.w(TAG, "Session configure failed (withJpegReader=$withJpegReader, phys=$physicalCameraId)")
                        if (withJpegReader) {
                            createCaptureSession(device, physicalCameraId, gen, withJpegReader = false)
                        } else {
                            handleOpenFailure(gen, "CaptureSession configure failed for ${currentLens.info.label}")
                        }
                    }
                }
            )
            device.createCaptureSession(sessionConfig)
        } catch (e: Exception) {
            Log.e(TAG, "createCaptureSession failed: ${e.message}", e)
            if (withJpegReader) {
                createCaptureSession(device, physicalCameraId, gen, withJpegReader = false)
            } else {
                handleOpenFailure(gen, "createCaptureSession exception: ${e.message}")
            }
        }
    }

    private fun updateRepeatingRequest() {
        val device = cameraDevice ?: return
        val session = captureSession ?: return
        val surface = previewSurface ?: return
        if (!surface.isValid) return

        try {
            val builder = device.createCaptureRequest(CameraDevice.TEMPLATE_RECORD)
            builder.addTarget(surface)
            applyCommonRequestParams(builder)
            session.setRepeatingRequest(builder.build(), null, cameraHandler)
        } catch (e: Exception) {
            Log.e(TAG, "setRepeatingRequest failed: ${e.message}")
        }
    }

    private fun applyCommonRequestParams(builder: CaptureRequest.Builder) {
        val chars = currentCharacteristics

        val afModes = chars?.get(CameraCharacteristics.CONTROL_AF_AVAILABLE_MODES) ?: IntArray(0)
        when {
            afModes.contains(CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_VIDEO) ->
                builder.set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_VIDEO)
            afModes.contains(CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE) ->
                builder.set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE)
            afModes.contains(CaptureRequest.CONTROL_AF_MODE_AUTO) ->
                builder.set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_AUTO)
        }

        builder.set(CaptureRequest.CONTROL_MODE, CaptureRequest.CONTROL_MODE_AUTO)
        builder.set(CaptureRequest.CONTROL_AE_MODE, CaptureRequest.CONTROL_AE_MODE_ON)

        val fpsRange = selectFpsRange(chars, targetFps)
        if (fpsRange != null) {
            builder.set(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, fpsRange)
        }

        val flashMode = if (torchEnabled && currentLens.info.hasFlash) {
            CaptureRequest.FLASH_MODE_TORCH
        } else {
            CaptureRequest.FLASH_MODE_OFF
        }
        builder.set(CaptureRequest.FLASH_MODE, flashMode)

        val aeRange = chars?.get(CameraCharacteristics.CONTROL_AE_COMPENSATION_RANGE)
        val aeStep = chars?.get(CameraCharacteristics.CONTROL_AE_COMPENSATION_STEP)
        if (aeRange != null && aeStep != null && aeStep.toFloat() > 0f) {
            val steps = (exposureEv / aeStep.toFloat()).roundToInt()
                .coerceIn(aeRange.lower, aeRange.upper)
            builder.set(CaptureRequest.CONTROL_AE_EXPOSURE_COMPENSATION, steps)
        }

        val effectiveZoom = (currentLens.baseZoomRatio * userZoomRatio).coerceAtLeast(0.4f)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val zoomRange = chars?.get(CameraCharacteristics.CONTROL_ZOOM_RATIO_RANGE)
            if (zoomRange != null) {
                val clamped = effectiveZoom.coerceIn(zoomRange.lower, zoomRange.upper)
                builder.set(CaptureRequest.CONTROL_ZOOM_RATIO, clamped)
            } else {
                applyCropRegionZoom(builder, chars, effectiveZoom)
            }
        } else {
            applyCropRegionZoom(builder, chars, effectiveZoom)
        }
    }

    private fun applyCropRegionZoom(
        builder: CaptureRequest.Builder,
        chars: CameraCharacteristics?,
        zoom: Float
    ) {
        val activeArray = chars?.get(CameraCharacteristics.SENSOR_INFO_ACTIVE_ARRAY_SIZE) ?: return
        val maxDigital = (chars.get(CameraCharacteristics.SCALER_AVAILABLE_MAX_DIGITAL_ZOOM) ?: 1.0f)
            .coerceAtLeast(1.0f)
        val clamped = zoom.coerceIn(1.0f, maxDigital)
        if (clamped <= 1.01f) {
            builder.set(CaptureRequest.SCALER_CROP_REGION, activeArray)
            return
        }
        val cropW = (activeArray.width() / clamped).roundToInt().coerceAtLeast(1)
        val cropH = (activeArray.height() / clamped).roundToInt().coerceAtLeast(1)
        val dx = (activeArray.width() - cropW) / 2
        val dy = (activeArray.height() - cropH) / 2
        builder.set(
            CaptureRequest.SCALER_CROP_REGION,
            Rect(dx, dy, dx + cropW, dy + cropH)
        )
    }

    private fun chooseBestSize(chars: CameraCharacteristics, reqW: Int, reqH: Int): Size {
        val map = chars.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)
        val sizes = map?.getOutputSizes(SurfaceTexture::class.java)?.toList().orEmpty()
        if (sizes.isEmpty()) return Size(reqW, reqH)

        // Exact 16:9 landscape sizes matching requested tier (e.g. 1280x720, 1920x1080)
        val exact = sizes.firstOrNull { it.width == reqW && it.height == reqH }
        if (exact != null) return exact

        val targetPixels = reqW.toLong() * reqH.toLong()
        val targetAspect = reqW.toFloat() / reqH.toFloat()

        return sizes
            .filter { it.width <= 1920 && it.height <= 1440 && it.width >= 640 && it.height >= 480 }
            .ifEmpty { sizes }
            .minByOrNull { s ->
                val pixelsDiff = abs(s.width.toLong() * s.height.toLong() - targetPixels).toDouble() / targetPixels
                val aspectDiff = abs((s.width.toFloat() / s.height.toFloat()) - targetAspect) * 3.0
                pixelsDiff + aspectDiff
            } ?: Size(1280, 720)
    }

    private fun chooseJpegSize(chars: CameraCharacteristics?): Size {
        val map = chars?.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)
        val sizes = map?.getOutputSizes(ImageFormat.JPEG)?.toList().orEmpty()
        if (sizes.isEmpty()) return Size(captureWidth, captureHeight)
        val preferred = sizes.filter { it.width in 1280..2560 && it.height in 720..1920 }
        return preferred.maxByOrNull { it.width.toLong() * it.height.toLong() }
            ?: sizes.minByOrNull { abs(it.width - 1920) + abs(it.height - 1080) }
            ?: Size(1280, 720)
    }

    private fun selectFpsRange(chars: CameraCharacteristics?, desiredFps: Int): Range<Int>? {
        val ranges = chars?.get(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES)?.toList().orEmpty()
        if (ranges.isEmpty()) return null
        val scale = if (ranges.any { it.upper > 1000 }) 1000 else 1
        val target = desiredFps * scale
        return ranges.minByOrNull { r ->
            val upperPenalty = abs(r.upper - target) * 2
            val lowerPenalty = if (r.lower <= target) abs(r.lower - target / 2) else (r.lower - target) * 4
            upperPenalty + lowerPenalty
        }
    }

    @Suppress("DEPRECATION")
    private fun getDeviceRotationDegrees(): Int {
        val wm = context.getSystemService(Context.WINDOW_SERVICE) as? WindowManager ?: return 0
        val rotation = try {
            wm.defaultDisplay?.rotation ?: Surface.ROTATION_0
        } catch (_: Exception) {
            Surface.ROTATION_0
        }
        return when (rotation) {
            Surface.ROTATION_90 -> 90
            Surface.ROTATION_180 -> 180
            Surface.ROTATION_270 -> 270
            else -> 0
        }
    }

    /** Matches org.webrtc.Camera2Session.getFrameOrientation() */
    private fun computeFrameOrientation(sensorOrientation: Int, isFront: Boolean): Int {
        var deviceDeg = getDeviceRotationDegrees()
        if (!isFront) {
            deviceDeg = (360 - deviceDeg) % 360
        }
        return (sensorOrientation + deviceDeg) % 360
    }

    private fun computeJpegOrientation(): Int {
        val sensorOrientation = currentCharacteristics?.get(CameraCharacteristics.SENSOR_ORIENTATION)
            ?: currentLens.sensorOrientation
        val deviceDeg = getDeviceRotationDegrees()
        return if (currentLens.info.facing == "front") {
            (sensorOrientation - deviceDeg + 360) % 360
        } else {
            (sensorOrientation + deviceDeg) % 360
        }
    }

    private fun closeCameraResources() {
        try {
            captureSession?.stopRepeating()
        } catch (_: Exception) {
        }
        try {
            captureSession?.close()
        } catch (_: Exception) {
        }
        captureSession = null

        try {
            cameraDevice?.close()
        } catch (_: Exception) {
        }
        cameraDevice = null

        try {
            jpegImageReader?.close()
        } catch (_: Exception) {
        }
        jpegImageReader = null

        try {
            previewSurface?.release()
        } catch (_: Exception) {
        }
        previewSurface = null
    }

    companion object {
        private const val TAG = "PurrCamCapturer"
        private const val STALL_TIMEOUT_MS = 12_000L
        private const val STALL_CHECK_INTERVAL_MS = 4_000L
    }
}
