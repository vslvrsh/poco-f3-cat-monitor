package com.purrcam.app.camera

import android.content.Context
import android.graphics.SurfaceTexture
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.os.Build
import android.util.Log
import android.util.Size
import com.purrcam.app.protocol.LensInfo
import kotlin.math.abs
import kotlin.math.hypot
import kotlin.math.roundToInt

data class LensDescriptor(
    val info: LensInfo,
    val baseZoomRatio: Float = 1.0f,
    val fallbackCameraId: String? = null,
    val fallbackPhysicalCameraId: String? = null,
    val sensorOrientation: Int = 90
)

object LensEnumerator {
    private const val TAG = "PurrCamLens"

    private data class RawCandidate(
        val cameraId: String,
        val physicalCameraId: String?,
        val facingInt: Int,
        val focalLengthMm: Float,
        val eq35mm: Float,
        val sensorDiagMm: Float,
        val maxZoom: Float,
        val minZoom: Float,
        val hasFlash: Boolean,
        val isLogicalMultiCam: Boolean,
        val physicalChildCount: Int,
        val minFocusDistance: Float,
        val maxWidth: Int,
        val maxHeight: Int,
        val sensorOrientation: Int,
        val isFromCameraIdList: Boolean
    )

    fun enumerate(context: Context): List<LensDescriptor> {
        val manager = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
        val topLevelIds = try {
            manager.cameraIdList.toList()
        } catch (e: Exception) {
            Log.e(TAG, "Failed to query cameraIdList", e)
            return emptyList()
        }

        Log.i(TAG, "CameraManager.cameraIdList = $topLevelIds")

        val rawCandidates = mutableListOf<RawCandidate>()
        val inspectedTopIds = mutableSetOf<String>()

        // 1. Inspect every top-level camera ID and its physical sub-cameras (API 28+)
        for (camId in topLevelIds) {
            inspectedTopIds.add(camId)
            inspectCamera(manager, camId, isFromList = true, out = rawCandidates)
        }

        // 2. Probe common Xiaomi/Qualcomm auxiliary rear IDs not always exposed in cameraIdList
        val xiaomiProbeIds = listOf("2", "3", "4", "5", "6", "7", "20", "21", "22", "23")
        for (probeId in xiaomiProbeIds) {
            if (probeId in inspectedTopIds) continue
            inspectCamera(manager, probeId, isFromList = false, out = rawCandidates)
        }

        if (rawCandidates.isEmpty()) {
            Log.w(TAG, "No usable Camera2 cameras found!")
            return emptyList()
        }

        // Split by facing
        val backRaw = rawCandidates.filter { it.facingInt == CameraCharacteristics.LENS_FACING_BACK }
        val frontRaw = rawCandidates.filter { it.facingInt == CameraCharacteristics.LENS_FACING_FRONT }

        // Find primary rear "wide" (1x) camera:
        // Usually cameraId "0" with physicalCameraId == null (or first top-level back camera with reasonable focal length)
        val mainRear = backRaw.firstOrNull { it.cameraId == "0" && it.physicalCameraId == null }
            ?: backRaw.firstOrNull { it.physicalCameraId == null && it.isFromCameraIdList }
            ?: backRaw.firstOrNull()

        val mainEq35 = mainRear?.eq35mm?.takeIf { it > 5f } ?: 26f
        val mainFocal = mainRear?.focalLengthMm?.takeIf { it > 0.5f } ?: 4.74f

        Log.i(TAG, "Main rear reference: camId=${mainRear?.cameraId}, focal=${mainFocal}mm, eq35=${mainEq35}mm, minZoom=${mainRear?.minZoom}")

        // Group & deduplicate rear candidates by optical signature (physical ID or similar eq35mm + focal)
        val dedupedBack = deduplicateRearCandidates(backRaw, mainRear)

        val descriptors = mutableListOf<LensDescriptor>()
        val usedIds = mutableSetOf<String>()

        fun allocateUniqueId(base: String, camId: String, physId: String?): String {
            if (usedIds.add(base)) return base
            val alt = if (physId != null) "${base}_${camId}_$physId" else "${base}_$camId"
            if (usedIds.add(alt)) return alt
            var idx = 2
            while (!usedIds.add("${base}_$idx")) idx++
            return "${base}_$idx"
        }

        var hasUltrawide = false

        for ((primary, fallback) in dedupedBack) {
            val isMain = mainRear != null &&
                primary.cameraId == mainRear.cameraId &&
                primary.physicalCameraId == mainRear.physicalCameraId

            val ratioEq = (primary.eq35mm / mainEq35).coerceIn(0.3f, 10f)

            val (lensType, nominalZoom, label) = when {
                isMain -> Triple("wide", 1.0f, "1× Main")
                ratioEq < 0.80f -> {
                    hasUltrawide = true
                    val rounded = ((ratioEq * 10f).roundToInt() / 10f).coerceIn(0.4f, 0.8f)
                    Triple("ultrawide", rounded, "${formatZoom(rounded)}× Wide")
                }
                primary.maxWidth <= 2650 && primary.minFocusDistance >= 8f -> {
                    // Dedicated macro / telemacro sensor (e.g. Poco F3 5MP S5K5E9 ~2592x1944 with close focus)
                    val rounded = ((ratioEq * 10f).roundToInt() / 10f).coerceIn(1.5f, 3.0f)
                    Triple("macro", rounded, "Macro")
                }
                ratioEq >= 1.45f -> {
                    // Distinguish telemacro (<= 6MP) vs telephoto
                    if (primary.maxWidth * primary.maxHeight <= 6_000_000) {
                        val rounded = ((ratioEq * 10f).roundToInt() / 10f).coerceIn(1.5f, 3.0f)
                        Triple("macro", rounded, "Macro")
                    } else {
                        val rounded = ((ratioEq * 10f).roundToInt() / 10f).coerceIn(1.5f, 10.0f)
                        Triple("tele", rounded, "${formatZoom(rounded)}× Tele")
                    }
                }
                else -> {
                    // Secondary rear sensor with similar focal length — likely macro if lower res, else extra wide
                    if (primary.maxWidth * primary.maxHeight <= 6_500_000) {
                        Triple("macro", 2.0f, "Macro")
                    } else {
                        val rounded = ((ratioEq * 10f).roundToInt() / 10f).coerceIn(0.5f, 5.0f)
                        Triple("wide", rounded, "${formatZoom(rounded)}× Cam ${primary.physicalCameraId ?: primary.cameraId}")
                    }
                }
            }

            val id = allocateUniqueId(lensType, primary.cameraId, primary.physicalCameraId)
            val info = LensInfo(
                id = id,
                cameraId = primary.cameraId,
                physicalCameraId = primary.physicalCameraId,
                label = label,
                type = lensType,
                facing = "back",
                focalLengthMm = round2(primary.focalLengthMm),
                zoomFactor = nominalZoom,
                hasFlash = primary.hasFlash || (mainRear?.hasFlash == true && primary.cameraId == mainRear.cameraId),
                maxZoom = round1(primary.maxZoom.coerceAtLeast(1.0f))
            )

            descriptors.add(
                LensDescriptor(
                    info = info,
                    baseZoomRatio = 1.0f,
                    fallbackCameraId = fallback?.cameraId,
                    fallbackPhysicalCameraId = fallback?.physicalCameraId,
                    sensorOrientation = primary.sensorOrientation
                )
            )
        }

        // 3. Logical zoom-out fallback for ultrawide!
        // If no separate ultrawide camera/physical sensor was exposed, check if main logical camera supports zoomRatio < 0.85
        if (!hasUltrawide && mainRear != null && mainRear.minZoom <= 0.80f) {
            val rounded = ((mainRear.minZoom * 10f).roundToInt() / 10f).coerceIn(0.5f, 0.8f)
            val uwInfo = LensInfo(
                id = allocateUniqueId("ultrawide", mainRear.cameraId, null),
                cameraId = mainRear.cameraId,
                physicalCameraId = null,
                label = "${formatZoom(rounded)}× Wide",
                type = "ultrawide",
                facing = "back",
                focalLengthMm = round2(mainRear.focalLengthMm * mainRear.minZoom),
                zoomFactor = rounded,
                hasFlash = mainRear.hasFlash,
                maxZoom = round1(mainRear.maxZoom.coerceAtLeast(1.0f))
            )
            descriptors.add(
                LensDescriptor(
                    info = uwInfo,
                    baseZoomRatio = mainRear.minZoom,
                    sensorOrientation = mainRear.sensorOrientation
                )
            )
            Log.i(TAG, "Added logical zoom-out ultrawide on camId=${mainRear.cameraId} at zoomRatio=${mainRear.minZoom}")
        }

        // 4. Add primary front camera
        val primaryFront = frontRaw.firstOrNull { it.cameraId == "1" && it.physicalCameraId == null }
            ?: frontRaw.firstOrNull { it.physicalCameraId == null && it.isFromCameraIdList }
            ?: frontRaw.firstOrNull()

        if (primaryFront != null) {
            val frontInfo = LensInfo(
                id = allocateUniqueId("front", primaryFront.cameraId, primaryFront.physicalCameraId),
                cameraId = primaryFront.cameraId,
                physicalCameraId = primaryFront.physicalCameraId,
                label = "Front",
                type = "front",
                facing = "front",
                focalLengthMm = round2(primaryFront.focalLengthMm),
                zoomFactor = 1.0f,
                hasFlash = primaryFront.hasFlash,
                maxZoom = round1(primaryFront.maxZoom.coerceAtLeast(1.0f))
            )
            descriptors.add(
                LensDescriptor(
                    info = frontInfo,
                    baseZoomRatio = 1.0f,
                    sensorOrientation = primaryFront.sensorOrientation
                )
            )
        }

        // Sort cleanly: ultrawide -> wide -> tele -> macro -> front
        val orderMap = mapOf(
            "ultrawide" to 0,
            "wide" to 1,
            "tele" to 2,
            "macro" to 3,
            "front" to 4
        )
        val sorted = descriptors.sortedWith(
            compareBy<LensDescriptor> { orderMap[it.info.type] ?: 9 }
                .thenBy { it.info.zoomFactor }
        )

        Log.i(TAG, "Final enumerated lenses (${sorted.size}):")
        sorted.forEach { d ->
            Log.i(
                TAG,
                "  -> id=${d.info.id} label='${d.info.label}' type=${d.info.type} camId=${d.info.cameraId} physId=${d.info.physicalCameraId} baseZoom=${d.baseZoomRatio} fallback=(${d.fallbackCameraId}:${d.fallbackPhysicalCameraId}) focal=${d.info.focalLengthMm}mm maxZoom=${d.info.maxZoom} flash=${d.info.hasFlash}"
            )
        }
        return sorted
    }

    private fun inspectCamera(
        manager: CameraManager,
        camId: String,
        isFromList: Boolean,
        out: MutableList<RawCandidate>
    ) {
        val chars = try {
            manager.getCameraCharacteristics(camId)
        } catch (e: Exception) {
            Log.w(TAG, "Cannot read characteristics for cameraId=$camId: ${e.message}")
            return
        }

        val topCandidate = buildCandidate(camId, null, chars, isFromList)
        if (topCandidate != null) {
            Log.d(
                TAG,
                "Top camId=$camId facing=${topCandidate.facingInt} focal=${topCandidate.focalLengthMm}mm eq35=${topCandidate.eq35mm}mm res=${topCandidate.maxWidth}x${topCandidate.maxHeight} logical=${topCandidate.isLogicalMultiCam} physCount=${topCandidate.physicalChildCount} minZoom=${topCandidate.minZoom}"
            )
            out.add(topCandidate)
        }

        // Enumerate physical sub-cameras (API 28+)
        val physIds = try {
            chars.physicalCameraIds
        } catch (_: Exception) {
            emptySet()
        }

        for (physId in physIds) {
            try {
                val physChars = manager.getCameraCharacteristics(physId)
                val physCandidate = buildCandidate(
                    cameraId = camId,
                    physicalCameraId = physId,
                    chars = physChars,
                    isFromList = isFromList
                )
                if (physCandidate != null) {
                    Log.d(
                        TAG,
                        "  Physical sub-cam parent=$camId physId=$physId facing=${physCandidate.facingInt} focal=${physCandidate.focalLengthMm}mm eq35=${physCandidate.eq35mm}mm res=${physCandidate.maxWidth}x${physCandidate.maxHeight}"
                    )
                    out.add(physCandidate)
                }
            } catch (e: Exception) {
                Log.w(TAG, "Cannot read physical camera $physId under $camId: ${e.message}")
            }
        }
    }

    private fun buildCandidate(
        cameraId: String,
        physicalCameraId: String?,
        chars: CameraCharacteristics,
        isFromList: Boolean
    ): RawCandidate? {
        val facing = chars.get(CameraCharacteristics.LENS_FACING) ?: return null
        if (facing != CameraCharacteristics.LENS_FACING_BACK &&
            facing != CameraCharacteristics.LENS_FACING_FRONT
        ) {
            return null
        }

        val map = chars.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP) ?: return null
        val outputSizes = map.getOutputSizes(SurfaceTexture::class.java)?.toList().orEmpty()
        val usableSizes = outputSizes.filter { it.width >= 640 && it.height >= 480 }
        if (usableSizes.isEmpty()) return null

        val maxSize: Size = usableSizes.maxByOrNull { it.width.toLong() * it.height.toLong() }
            ?: return null

        val focals = chars.get(CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS)
        val focalMm = focals?.firstOrNull()?.takeIf { it > 0.1f } ?: 4.0f

        val physSize = chars.get(CameraCharacteristics.SENSOR_INFO_PHYSICAL_SIZE)
        val sensorWidthMm = if (physSize != null && physSize.width > 0.5f) {
            maxOf(physSize.width, physSize.height)
        } else {
            if (focalMm < 2.5f) 3.67f else 6.40f
        }
        val sensorDiagMm = if (physSize != null && physSize.width > 0.5f && physSize.height > 0.5f) {
            hypot(physSize.width.toDouble(), physSize.height.toDouble()).toFloat()
        } else {
            sensorWidthMm * 1.25f
        }
        // Standard 35mm horizontal equivalent: 36mm * f / sensorWidthMm
        val eq35mm = (36.0f * focalMm / sensorWidthMm).coerceIn(8f, 300f)

        val capabilities = chars.get(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES) ?: IntArray(0)
        val isLogical = capabilities.contains(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES_LOGICAL_MULTI_CAMERA)
        val physChildCount = try {
            chars.physicalCameraIds.size
        } catch (_: Exception) {
            0
        }

        val (minZoom, maxZoom) = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val range = chars.get(CameraCharacteristics.CONTROL_ZOOM_RATIO_RANGE)
            if (range != null) {
                range.lower to range.upper
            } else {
                1.0f to (chars.get(CameraCharacteristics.SCALER_AVAILABLE_MAX_DIGITAL_ZOOM) ?: 1.0f)
            }
        } else {
            1.0f to (chars.get(CameraCharacteristics.SCALER_AVAILABLE_MAX_DIGITAL_ZOOM) ?: 1.0f)
        }

        val hasFlash = chars.get(CameraCharacteristics.FLASH_INFO_AVAILABLE) == true
        val minFocus = chars.get(CameraCharacteristics.LENS_INFO_MINIMUM_FOCUS_DISTANCE) ?: 0f
        val sensorOrientation = chars.get(CameraCharacteristics.SENSOR_ORIENTATION) ?: 90

        return RawCandidate(
            cameraId = cameraId,
            physicalCameraId = physicalCameraId,
            facingInt = facing,
            focalLengthMm = focalMm,
            eq35mm = eq35mm,
            sensorDiagMm = sensorDiagMm,
            maxZoom = maxZoom.coerceAtLeast(1.0f),
            minZoom = minZoom.coerceAtMost(1.0f),
            hasFlash = hasFlash,
            isLogicalMultiCam = isLogical,
            physicalChildCount = physChildCount,
            minFocusDistance = minFocus,
            maxWidth = maxSize.width,
            maxHeight = maxSize.height,
            sensorOrientation = sensorOrientation,
            isFromCameraIdList = isFromList
        )
    }

    private fun deduplicateRearCandidates(
        backRaw: List<RawCandidate>,
        mainRear: RawCandidate?
    ): List<Pair<RawCandidate, RawCandidate?>> {
        if (backRaw.isEmpty()) return emptyList()

        // Skip extra virtual logical wrappers (e.g. Xiaomi SAT/bokeh IDs 60/61/62) that are NOT mainRear
        // unless they expose a genuinely unique focal length not represented by any physical camera.
        val filtered = backRaw.filter { cand ->
            val isMain = mainRear != null &&
                cand.cameraId == mainRear.cameraId &&
                cand.physicalCameraId == mainRear.physicalCameraId
            if (isMain) return@filter true
            // Keep physical sub-cameras and standalone non-logical sensors; skip extra multi-cam virtual wrappers
            if (cand.physicalCameraId == null && cand.isLogicalMultiCam && cand.physicalChildCount > 1) {
                return@filter false
            }
            true
        }

        // Cluster candidates representing the same physical lens
        val clusters = mutableListOf<MutableList<RawCandidate>>()
        for (cand in filtered) {
            val match = clusters.firstOrNull { cluster ->
                val rep = cluster.first()
                samePhysicalLens(rep, cand)
            }
            if (match != null) {
                match.add(cand)
            } else {
                clusters.add(mutableListOf(cand))
            }
        }

        return clusters.map { cluster ->
            // If this cluster contains mainRear, always pick mainRear as primary
            val mainInCluster = if (mainRear != null) {
                cluster.firstOrNull { it.cameraId == mainRear.cameraId && it.physicalCameraId == mainRear.physicalCameraId }
            } else null

            if (mainInCluster != null) {
                val alt = cluster.firstOrNull { it != mainInCluster }
                mainInCluster to alt
            } else {
                // Prefer top-level ID from cameraIdList if available, OR physical sub-camera under logical "0",
                // keeping the other as automatic fallback!
                val sorted = cluster.sortedWith(
                    compareByDescending<RawCandidate> { it.physicalCameraId == null && it.isFromCameraIdList }
                        .thenByDescending { it.physicalCameraId != null && it.cameraId == (mainRear?.cameraId ?: "0") }
                        .thenByDescending { it.isFromCameraIdList }
                        .thenBy { it.cameraId.toIntOrNull() ?: 999 }
                )
                val primary = sorted.first()
                val fallback = sorted.drop(1).firstOrNull {
                    it.cameraId != primary.cameraId || it.physicalCameraId != primary.physicalCameraId
                }
                primary to fallback
            }
        }
    }

    private fun samePhysicalLens(a: RawCandidate, b: RawCandidate): Boolean {
        val aPhys = a.physicalCameraId ?: a.cameraId
        val bPhys = b.physicalCameraId ?: b.cameraId
        if (aPhys == bPhys) return true

        val eqDiff = abs(a.eq35mm - b.eq35mm) / maxOf(a.eq35mm, b.eq35mm, 1f)
        val focalDiff = abs(a.focalLengthMm - b.focalLengthMm) / maxOf(a.focalLengthMm, b.focalLengthMm, 0.1f)
        // Virtual clones (like Poco F3 IDs 6/7 cloning 0/1) share identical facing + rounded 35mm-eq + focal length
        return eqDiff < 0.08f && focalDiff < 0.08f
    }

    private fun formatZoom(z: Float): String {
        val rounded = (z * 10f).roundToInt() / 10f
        return if (rounded == rounded.toInt().toFloat()) {
            rounded.toInt().toString()
        } else {
            String.format(java.util.Locale.US, "%.1f", rounded)
        }
    }

    private fun round1(v: Float): Float = (v * 10f).roundToInt() / 10f
    private fun round2(v: Float): Float = (v * 100f).roundToInt() / 100f
}
