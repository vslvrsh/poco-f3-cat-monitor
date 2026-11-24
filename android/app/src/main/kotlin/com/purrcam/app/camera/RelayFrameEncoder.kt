package com.purrcam.app.camera

import android.graphics.Bitmap
import android.os.SystemClock
import android.util.Log
import org.webrtc.VideoFrame
import org.webrtc.VideoSink
import java.io.ByteArrayOutputStream
import java.util.Base64
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Protocol v1.2 §9 — Lightweight WebSocket/HTTPS Video Relay Frame Encoder.
 * Attached to the local WebRTC VideoTrack ONLY when at least one viewer requests `ws_relay`.
 * Performs direct I420 -> downscaled + rotated ARGB -> single-pass JPEG compression so frames
 * are always 100% upright, un-squished, lightweight (~20-40 KB), and GC-friendly.
 */
class RelayFrameEncoder(
    private val canSendFrame: () -> Boolean,
    private val onFrameEncoded: (width: Int, height: Int, base64Jpeg: String) -> Unit
) : VideoSink {

    private val executor = Executors.newSingleThreadExecutor { r ->
        Thread(r, "PurrCam-RelayEnc").apply { isDaemon = true }
    }
    private val closed = AtomicBoolean(false)
    private val encodingInFlight = AtomicBoolean(false)
    private val lastEncodedAtMs = AtomicLong(0L)
    private val targetFps = AtomicInteger(8)
    private val jpegQuality = AtomicInteger(60)

    // Reused pixel buffer & output stream on single encoder thread (avoids per-frame allocation)
    private var argbBuffer: IntArray = IntArray(0)
    private val jpegOut = ByteArrayOutputStream(32 * 1024)

    fun updateParams(fps: Int?, quality: Int?) {
        fps?.let { targetFps.set(it.coerceIn(1, 15)) }
        quality?.let { jpegQuality.set(it.coerceIn(30, 85)) }
    }

    override fun onFrame(frame: VideoFrame) {
        if (closed.get()) return
        val minIntervalMs = (1000L / targetFps.get().coerceIn(1, 15))
        val now = SystemClock.elapsedRealtime()
        if (now - lastEncodedAtMs.get() < minIntervalMs) return
        if (!canSendFrame()) return
        if (!encodingInFlight.compareAndSet(false, true)) return

        lastEncodedAtMs.set(now)
        val rotation = ((frame.rotation % 360) + 360) % 360
        val buffer = frame.buffer
        buffer.retain()

        executor.execute {
            try {
                if (closed.get() || !canSendFrame()) return@execute
                val i420 = buffer.toI420() ?: return@execute
                try {
                    encodeI420ToJpeg(i420, rotation)
                } finally {
                    i420.release()
                }
            } catch (e: Exception) {
                Log.w(TAG, "Relay frame encode error: ${e.message}")
            } finally {
                buffer.release()
                encodingInFlight.set(false)
            }
        }
    }

    private fun encodeI420ToJpeg(i420: VideoFrame.I420Buffer, rotation: Int) {
        val srcW = i420.width
        val srcH = i420.height
        if (srcW <= 0 || srcH <= 0) return

        val (dstW, dstH) = computeOutputDimensions(srcW, srcH, rotation, MAX_SHORT_EDGE_PX)
        val pixelCount = dstW * dstH
        if (argbBuffer.size < pixelCount) {
            argbBuffer = IntArray(pixelCount)
        }

        val yBuf = i420.dataY
        val uBuf = i420.dataU
        val vBuf = i420.dataV
        val yStride = i420.strideY
        val uStride = i420.strideU
        val vStride = i420.strideV

        var dstIdx = 0
        for (dy in 0 until dstH) {
            for (dx in 0 until dstW) {
                val packed = mapDestToSource(dx, dy, dstW, dstH, srcW, srcH, rotation)
                val sx = (packed ushr 16) and 0xFFFF
                val sy = packed and 0xFFFF

                val yVal = (yBuf.get(sy * yStride + sx).toInt() and 0xFF) - 16
                val uvIdx = (sy shr 1) * uStride + (sx shr 1)
                val vvIdx = (sy shr 1) * vStride + (sx shr 1)
                val uVal = (uBuf.get(uvIdx).toInt() and 0xFF) - 128
                val vVal = (vBuf.get(vvIdx).toInt() and 0xFF) - 128

                val y1192 = if (yVal < 0) 0 else 1192 * yVal
                var r = (y1192 + 1634 * vVal) shr 10
                var g = (y1192 - 833 * vVal - 400 * uVal) shr 10
                var b = (y1192 + 2066 * uVal) shr 10

                if (r < 0) r = 0 else if (r > 255) r = 255
                if (g < 0) g = 0 else if (g > 255) g = 255
                if (b < 0) b = 0 else if (b > 255) b = 255

                argbBuffer[dstIdx++] = (0xFF shl 24) or (r shl 16) or (g shl 8) or b
            }
        }

        val bitmap = Bitmap.createBitmap(dstW, dstH, Bitmap.Config.ARGB_8888)
        try {
            bitmap.setPixels(argbBuffer, 0, dstW, 0, 0, dstW, dstH)
            jpegOut.reset()
            val ok = bitmap.compress(Bitmap.CompressFormat.JPEG, jpegQuality.get(), jpegOut)
            if (ok && jpegOut.size() > 0 && canSendFrame()) {
                val base64 = Base64.getEncoder().encodeToString(jpegOut.toByteArray())
                onFrameEncoded(dstW, dstH, base64)
            }
        } finally {
            bitmap.recycle()
        }
    }

    fun close() {
        if (!closed.compareAndSet(false, true)) return
        executor.shutdown()
    }

    companion object {
        private const val TAG = "PurrCamRelay"
        const val MAX_SHORT_EDGE_PX = 540

        internal fun computeOutputDimensions(
            srcW: Int,
            srcH: Int,
            rotation: Int,
            maxShortEdge: Int = MAX_SHORT_EDGE_PX
        ): Pair<Int, Int> {
            val shortEdge = min(srcW, srcH).coerceAtLeast(1)
            val scale = if (shortEdge > maxShortEdge) maxShortEdge.toFloat() / shortEdge else 1.0f
            val scaledW = ((srcW * scale).roundToInt() and 0xFFFE).coerceAtLeast(2)
            val scaledH = ((srcH * scale).roundToInt() and 0xFFFE).coerceAtLeast(2)
            return if (rotation == 90 || rotation == 270) {
                scaledH to scaledW
            } else {
                scaledW to scaledH
            }
        }

        /**
         * Maps upright destination pixel `(dx, dy)` back to unrotated source pixel `(sx, sy)`
         * for clockwise frame rotations `0`, `90`, `180`, `270`. Returns `(sx shl 16) or sy`.
         */
        internal fun mapDestToSource(
            dx: Int,
            dy: Int,
            dstW: Int,
            dstH: Int,
            srcW: Int,
            srcH: Int,
            rotation: Int
        ): Int {
            val sx: Int
            val sy: Int
            when (rotation) {
                90 -> {
                    sx = ((dy * srcW) / dstH).coerceIn(0, srcW - 1)
                    sy = (((dstW - 1 - dx) * srcH) / dstW).coerceIn(0, srcH - 1)
                }
                180 -> {
                    sx = (((dstW - 1 - dx) * srcW) / dstW).coerceIn(0, srcW - 1)
                    sy = (((dstH - 1 - dy) * srcH) / dstH).coerceIn(0, srcH - 1)
                }
                270 -> {
                    sx = (((dstH - 1 - dy) * srcW) / dstH).coerceIn(0, srcW - 1)
                    sy = ((dx * srcH) / dstW).coerceIn(0, srcH - 1)
                }
                else -> {
                    sx = ((dx * srcW) / dstW).coerceIn(0, srcW - 1)
                    sy = ((dy * srcH) / dstH).coerceIn(0, srcH - 1)
                }
            }
            return (sx shl 16) or sy
        }
    }
}
