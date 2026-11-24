package com.purrcam.app.root

import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.io.File
import java.util.concurrent.TimeUnit

data class RootCapabilities(
    val hasRoot: Boolean = false,
    val backlightPath: String? = null,
    val chargeControlNode: ChargeControlNode? = null
)

data class ChargeControlNode(
    val path: String,
    val pauseValue: String,
    val resumeValue: String
)

class RootPowerController {
    private val mutex = Mutex()

    @Volatile
    var capabilities: RootCapabilities = RootCapabilities()
        private set

    @Volatile
    var isDisplayOff: Boolean = false
        private set

    @Volatile
    var isChargePaused: Boolean = false
        private set

    private var savedBrightness: Int? = null
    private var maxBrightness: Int = 2047
    private var probed = false

    suspend fun probe(): RootCapabilities = mutex.withLock {
        if (probed) return capabilities
        val result = withContext(Dispatchers.IO) {
            val idOut = runSu("id")
            val hasRoot = idOut != null && idOut.contains("uid=0")
            if (!hasRoot) {
                Log.i(TAG, "Root not available (su check returned: $idOut)")
                return@withContext RootCapabilities(hasRoot = false)
            }

            val backlightPath = findBacklightNode()
            val chargeNode = findChargeControlNode()

            Log.i(
                TAG,
                "Root available! backlight=$backlightPath, chargeNode=${chargeNode?.path}"
            )
            RootCapabilities(
                hasRoot = true,
                backlightPath = backlightPath,
                chargeControlNode = chargeNode
            )
        }
        capabilities = result
        probed = true
        result
    }

    private fun findBacklightNode(): String? {
        val probeCmd = """
            for p in /sys/class/backlight/*/brightness /sys/class/leds/lcd-backlight/brightness; do
              if [ -w "${'$'}p" ] || [ -f "${'$'}p" ]; then
                dir="${'$'}(dirname "${'$'}p")"
                max="${'$'}(cat "${'$'}dir/max_brightness" 2>/dev/null || echo 2047)"
                echo "${'$'}p|${'$'}max"
                break
              fi
            done
        """.trimIndent()
        val output = runSu(probeCmd)?.trim().orEmpty()
        if (output.isBlank()) return null
        val parts = output.split("|")
        val path = parts[0].trim()
        if (!isSafeBacklightPath(path)) {
            Log.w(TAG, "Rejected unexpected backlight sysfs path: $path")
            return null
        }
        val max = parts.getOrNull(1)?.trim()?.toIntOrNull()
        if (max != null && max in 1..65535) {
            maxBrightness = max
        }
        return path
    }

    private fun findChargeControlNode(): ChargeControlNode? {
        for (node in ALLOWED_CHARGE_NODES) {
            val check = runSu("test -f '${node.path}' && echo OK")
            if (check?.trim() == "OK") {
                return node
            }
        }
        return null
    }

    suspend fun setRootDisplayOff(off: Boolean): Boolean = mutex.withLock {
        val path = capabilities.backlightPath?.takeIf { isSafeBacklightPath(it) } ?: return false
        if (!capabilities.hasRoot) return false

        return withContext(Dispatchers.IO) {
            if (off) {
                if (!isDisplayOff) {
                    val current = runSu("cat '$path'")?.trim()?.toIntOrNull()
                    if (current != null && current in 1..maxBrightness) {
                        savedBrightness = current
                    }
                }
                val written = runSu("echo 0 > '$path' && echo OK")?.trim() == "OK"
                if (written) {
                    isDisplayOff = true
                    Log.i(TAG, "Root display backlight set to 0 ($path, saved=$savedBrightness)")
                }
                written
            } else {
                restoreDisplayLocked()
                true
            }
        }
    }

    suspend fun restoreDisplay() = mutex.withLock {
        withContext(Dispatchers.IO) {
            restoreDisplayLocked()
        }
    }

    fun restoreDisplayBlocking() {
        val path = capabilities.backlightPath?.takeIf { isSafeBacklightPath(it) } ?: return
        if (!capabilities.hasRoot || !isDisplayOff) return
        val target = (savedBrightness ?: (maxBrightness / 4)).coerceIn(20, maxBrightness)
        runSu("echo $target > '$path'")
        isDisplayOff = false
        Log.i(TAG, "Restored backlight synchronously to $target ($path)")
    }

    private fun restoreDisplayLocked() {
        val path = capabilities.backlightPath?.takeIf { isSafeBacklightPath(it) } ?: return
        if (!capabilities.hasRoot) return
        if (!isDisplayOff) return
        val target = (savedBrightness ?: (maxBrightness / 4)).coerceIn(20, maxBrightness)
        runSu("echo $target > '$path'")
        isDisplayOff = false
        Log.i(TAG, "Root display backlight restored to $target ($path)")
    }

    suspend fun applyChargeGuard(enabled: Boolean, maxPct: Int, currentBatteryPct: Int): Boolean = mutex.withLock {
        val node = capabilities.chargeControlNode ?: return false
        if (!capabilities.hasRoot) return false

        return withContext(Dispatchers.IO) {
            if (!enabled) {
                if (isChargePaused) {
                    val ok = writeChargeNode(node, pause = false)
                    if (ok) isChargePaused = false
                }
                return@withContext false
            }

            val resumePct = (maxPct - 10).coerceAtLeast(20)
            if (!isChargePaused && currentBatteryPct >= maxPct) {
                if (writeChargeNode(node, pause = true)) {
                    isChargePaused = true
                    Log.i(TAG, "Battery guard PAUSED charging at $currentBatteryPct% (max=$maxPct%)")
                }
            } else if (isChargePaused && currentBatteryPct <= resumePct) {
                if (writeChargeNode(node, pause = false)) {
                    isChargePaused = false
                    Log.i(TAG, "Battery guard RESUMED charging at $currentBatteryPct% (resume<=$resumePct%)")
                }
            }
            isChargePaused
        }
    }

    suspend fun restoreNormalCharging() = mutex.withLock {
        val node = capabilities.chargeControlNode ?: return
        if (!capabilities.hasRoot || !isChargePaused) return
        withContext(Dispatchers.IO) {
            if (writeChargeNode(node, pause = false)) {
                isChargePaused = false
                Log.i(TAG, "Restored normal charging on ${node.path}")
            }
        }
    }

    /**
     * When KernelSU/Magisk root is granted, automatically exempts PurrCam from Android Doze
     * using a strictly hardcoded command (zero dynamic or user-controlled arguments).
     */
    suspend fun whitelistDozeIfRooted(): Boolean = mutex.withLock {
        if (!capabilities.hasRoot) return false
        return withContext(Dispatchers.IO) {
            val out = runSu("dumpsys deviceidle whitelist +com.purrcam.app")
            val ok = out != null
            if (ok) {
                Log.i(TAG, "Root Doze whitelist applied for com.purrcam.app")
            }
            ok
        }
    }

    fun restoreNormalChargingBlocking() {
        val node = capabilities.chargeControlNode ?: return
        if (!capabilities.hasRoot || !isChargePaused) return
        if (writeChargeNode(node, pause = false)) {
            isChargePaused = false
        }
    }

    private fun writeChargeNode(node: ChargeControlNode, pause: Boolean): Boolean {
        if (!isAllowedChargeNode(node.path)) return false
        val value = if (pause) node.pauseValue else node.resumeValue
        if (value != "0" && value != "1") return false
        return runSu("echo $value > '${node.path}' && echo OK")?.trim() == "OK"
    }

    suspend fun readCpuTempC(): Float? = withContext(Dispatchers.IO) {
        // First try direct non-root read (fast on devices with permissive thermal sysfs)
        readThermalDirect()?.let { return@withContext it }
        if (!capabilities.hasRoot) return@withContext null

        val cmd = """
            for z in /sys/class/thermal/thermal_zone*; do
              t="${'$'}(cat "${'$'}z/type" 2>/dev/null)"
              case "${'$'}t" in
                *cpu*|*CPU*|*soc*|*SoC*|*tsens*|*ap*|*msm*|*cluster*)
                  v="${'$'}(cat "${'$'}z/temp" 2>/dev/null)"
                  if [ -n "${'$'}v" ]; then
                    echo "${'$'}t|${'$'}v"
                  fi
                  ;;
              esac
            done
        """.trimIndent()
        val out = runSu(cmd) ?: return@withContext null
        parseThermalLines(out.lines())
    }

    private fun readThermalDirect(): Float? {
        return try {
            val dir = File("/sys/class/thermal")
            val zones = dir.listFiles { f -> f.name.startsWith("thermal_zone") } ?: return null
            val lines = mutableListOf<String>()
            for (zone in zones) {
                try {
                    val typeFile = File(zone, "type")
                    val tempFile = File(zone, "temp")
                    if (!typeFile.canRead() || !tempFile.canRead()) continue
                    val type = typeFile.readText().trim()
                    val lower = type.lowercase()
                    if (lower.contains("cpu") || lower.contains("soc") || lower.contains("tsens") || lower.contains("cluster")) {
                        val temp = tempFile.readText().trim()
                        if (temp.isNotEmpty()) {
                            lines.add("$type|$temp")
                        }
                    }
                } catch (_: Exception) {
                    // Skip unreadable/EINVAL/EACCES thermal zones without aborting remaining zones
                    continue
                }
            }
            parseThermalLines(lines)
        } catch (_: Exception) {
            null
        }
    }

    private fun parseThermalLines(lines: List<String>): Float? {
        val temps = mutableListOf<Float>()
        for (line in lines) {
            val parts = line.split("|")
            if (parts.size < 2) continue
            val raw = parts[1].trim().toFloatOrNull() ?: continue
            val celsius = when {
                raw > 1000f -> raw / 1000f
                raw > 150f -> raw / 10f
                else -> raw
            }
            if (celsius in 10f..115f) {
                temps.add(celsius)
            }
        }
        if (temps.isEmpty()) return null
        // Return highest reasonable CPU core/cluster temp (most safety-relevant for thermal monitoring)
        val maxTemp = temps.max()
        return (Math.round(maxTemp * 10f) / 10f)
    }

    private fun runSu(command: String): String? {
        return try {
            val process = ProcessBuilder("su", "-c", command)
                .redirectErrorStream(true)
                .start()
            val finished = process.waitFor(2500, TimeUnit.MILLISECONDS)
            if (!finished) {
                process.destroyForcibly()
                return null
            }
            val output = process.inputStream.bufferedReader().use { it.readText() }
            if (process.exitValue() == 0) output else null
        } catch (e: Exception) {
            Log.d(TAG, "su failed for cmd: ${e.message}")
            null
        }
    }

    companion object {
        private const val TAG = "PurrCamRoot"

        private val BACKLIGHT_PATH_REGEX = Regex(
            "^/sys/class/(backlight|leds)/[A-Za-z0-9._-]+/brightness$"
        )

        private val ALLOWED_CHARGE_NODES = listOf(
            ChargeControlNode("/sys/class/power_supply/battery/input_suspend", pauseValue = "1", resumeValue = "0"),
            ChargeControlNode("/sys/class/power_supply/battery/battery_input_suspend", pauseValue = "1", resumeValue = "0"),
            ChargeControlNode("/sys/class/power_supply/battery/battery_charging_enabled", pauseValue = "0", resumeValue = "1"),
            ChargeControlNode("/sys/class/power_supply/battery/charging_enabled", pauseValue = "0", resumeValue = "1"),
            ChargeControlNode("/sys/class/qcom-battery/input_suspend", pauseValue = "1", resumeValue = "0")
        )

        private val ALLOWED_CHARGE_PATHS = ALLOWED_CHARGE_NODES.map { it.path }.toSet()

        internal fun isSafeBacklightPath(path: String): Boolean {
            if (path.contains("..")) return false
            return BACKLIGHT_PATH_REGEX.matches(path)
        }

        internal fun isAllowedChargeNode(path: String): Boolean {
            return path in ALLOWED_CHARGE_PATHS
        }
    }
}
