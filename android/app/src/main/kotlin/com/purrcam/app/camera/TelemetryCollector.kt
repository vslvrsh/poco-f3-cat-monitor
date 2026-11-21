package com.purrcam.app.camera

import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.wifi.WifiInfo
import android.net.wifi.WifiManager
import android.os.BatteryManager
import android.os.Build
import android.os.Environment
import android.os.StatFs
import android.os.SystemClock
import com.purrcam.app.protocol.Telemetry
import com.purrcam.app.root.RootPowerController
import kotlin.math.abs
import kotlin.math.roundToInt

class TelemetryCollector(
    private val context: Context,
    private val rootController: RootPowerController
) {
    private val appContext = context.applicationContext
    private val batteryManager = appContext.getSystemService(Context.BATTERY_SERVICE) as BatteryManager
    private val activityManager = appContext.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
    private val connectivityManager = appContext.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
    private val wifiManager = appContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
    private val startElapsedRealtimeMs = SystemClock.elapsedRealtime()

    suspend fun collect(
        activeLensId: String,
        measuredFps: Int?,
        bitrateKbps: Int?
    ): Telemetry {
        val batteryIntent = appContext.registerReceiver(
            null,
            IntentFilter(Intent.ACTION_BATTERY_CHANGED)
        )

        val level = batteryIntent?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
        val scale = batteryIntent?.getIntExtra(BatteryManager.EXTRA_SCALE, 100) ?: 100
        val batteryPct = if (level >= 0 && scale > 0) {
            ((level * 100f) / scale).roundToInt().coerceIn(0, 100)
        } else {
            batteryManager.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY).coerceIn(0, 100)
        }

        val status = batteryIntent?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
        val charging = status == BatteryManager.BATTERY_STATUS_CHARGING ||
            status == BatteryManager.BATTERY_STATUS_FULL

        val plugged = batteryIntent?.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) ?: 0
        val chargeSource = when {
            (plugged and BatteryManager.BATTERY_PLUGGED_AC) != 0 -> "ac"
            (plugged and BatteryManager.BATTERY_PLUGGED_USB) != 0 -> "usb"
            (plugged and BatteryManager.BATTERY_PLUGGED_WIRELESS) != 0 -> "wireless"
            else -> "none"
        }

        val rawTempDeciC = batteryIntent?.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, 0) ?: 0
        val batteryTempC = rawTempDeciC / 10f

        val voltageMv = batteryIntent?.getIntExtra(BatteryManager.EXTRA_VOLTAGE, 0) ?: 0
        val rawCurrent = batteryManager.getIntProperty(BatteryManager.BATTERY_PROPERTY_CURRENT_NOW)
        val currentMa = normalizeCurrentMa(rawCurrent, charging)

        val cpuTempC = rootController.readCpuTempC()
        val wifiRssi = readWifiRssi()

        val memInfo = ActivityManager.MemoryInfo()
        activityManager.getMemoryInfo(memInfo)
        val freeRamMb = memInfo.availMem / (1024L * 1024L)

        val freeStorageMb = try {
            val stat = StatFs(Environment.getDataDirectory().path)
            stat.availableBytes / (1024L * 1024L)
        } catch (_: Exception) {
            0L
        }

        val uptimeSec = ((SystemClock.elapsedRealtime() - startElapsedRealtimeMs) / 1000L).coerceAtLeast(0L)

        return Telemetry(
            ts = System.currentTimeMillis(),
            batteryPct = batteryPct,
            charging = charging,
            chargeSource = chargeSource,
            chargePaused = rootController.isChargePaused,
            batteryTempC = batteryTempC,
            cpuTempC = cpuTempC,
            voltageMv = voltageMv,
            currentMa = currentMa,
            wifiRssi = wifiRssi,
            uptimeSec = uptimeSec,
            freeRamMb = freeRamMb,
            freeStorageMb = freeStorageMb,
            activeLensId = activeLensId,
            fps = measuredFps,
            bitrateKbps = bitrateKbps
        )
    }

    private fun normalizeCurrentMa(raw: Int, charging: Boolean): Int {
        if (raw == Int.MIN_VALUE || raw == 0) return 0
        // Qualcomm/Xiaomi typically reports microamps (e.g. -650000 or +850000); some devices report mA
        val absVal = abs(raw)
        val magnitudeMa = if (absVal > 10_000) absVal / 1000 else absVal
        // Protocol contract: positive = charging, negative = discharging
        return if (charging) magnitudeMa else -magnitudeMa
    }

    @Suppress("DEPRECATION")
    private fun readWifiRssi(): Int? {
        try {
            val activeNetwork = connectivityManager.activeNetwork
            val caps = activeNetwork?.let { connectivityManager.getNetworkCapabilities(it) }
            if (caps != null && caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    val transportInfo = caps.transportInfo
                    if (transportInfo is WifiInfo && transportInfo.rssi in -120..-1) {
                        return transportInfo.rssi
                    }
                    val ss = caps.signalStrength
                    if (ss != NetworkCapabilities.SIGNAL_STRENGTH_UNSPECIFIED && ss in -120..-1) {
                        return ss
                    }
                }
                val info = wifiManager?.connectionInfo
                if (info != null && info.rssi in -120..-1) {
                    return info.rssi
                }
            }
        } catch (_: Exception) {
            // Ignore Wi-Fi info permission issues
        }
        return null
    }
}
