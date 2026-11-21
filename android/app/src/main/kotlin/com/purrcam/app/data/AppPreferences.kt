package com.purrcam.app.data

import android.content.Context
import android.os.Build
import com.purrcam.app.protocol.ServerUrlHelper
import java.util.UUID

class AppPreferences(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences("purrcam_prefs", Context.MODE_PRIVATE)

    var localServerUrl: String
        get() = prefs.getString(KEY_SERVER_URL, ServerUrlHelper.DEFAULT_LOCAL_URL)
            ?.takeIf { it.isNotBlank() } ?: ServerUrlHelper.DEFAULT_LOCAL_URL
        set(value) = prefs.edit().putString(KEY_SERVER_URL, value.trim()).apply()

    var remoteServerUrl: String
        get() = prefs.getString(KEY_REMOTE_URL, "")?.trim() ?: ""
        set(value) = prefs.edit().putString(KEY_REMOTE_URL, value.trim()).apply()

    /** Backwards-compatible alias for localServerUrl */
    var serverUrl: String
        get() = localServerUrl
        set(value) {
            localServerUrl = value
        }

    var authToken: String
        get() = prefs.getString(KEY_AUTH_TOKEN, "")?.trim() ?: ""
        set(value) = prefs.edit().putString(KEY_AUTH_TOKEN, value.trim()).apply()

    var selectedMode: String
        get() = prefs.getString(KEY_MODE, "") ?: ""
        set(value) = prefs.edit().putString(KEY_MODE, value).apply()

    var autoStart: Boolean
        get() = prefs.getBoolean(KEY_AUTO_START, false)
        set(value) = prefs.edit().putBoolean(KEY_AUTO_START, value).apply()

    var deviceName: String
        get() = prefs.getString(KEY_DEVICE_NAME, defaultDeviceName())
            ?.takeIf { it.isNotBlank() } ?: defaultDeviceName()
        set(value) = prefs.edit().putString(KEY_DEVICE_NAME, value.trim()).apply()

    var chargeLimitEnabled: Boolean
        get() = prefs.getBoolean(KEY_CHARGE_LIMIT_ENABLED, false)
        set(value) = prefs.edit().putBoolean(KEY_CHARGE_LIMIT_ENABLED, value).apply()

    var chargeLimitMaxPct: Int
        get() = prefs.getInt(KEY_CHARGE_LIMIT_MAX_PCT, 80).coerceIn(50, 95)
        set(value) = prefs.edit().putInt(KEY_CHARGE_LIMIT_MAX_PCT, value.coerceIn(50, 95)).apply()

    var preferredLensId: String
        get() = prefs.getString(KEY_PREFERRED_LENS, "") ?: ""
        set(value) = prefs.edit().putString(KEY_PREFERRED_LENS, value).apply()

    var videoResolution: String
        get() = prefs.getString(KEY_VIDEO_RES, "720p") ?: "720p"
        set(value) = prefs.edit().putString(KEY_VIDEO_RES, value).apply()

    var videoFps: Int
        get() = prefs.getInt(KEY_VIDEO_FPS, 24).coerceIn(10, 30)
        set(value) = prefs.edit().putInt(KEY_VIDEO_FPS, value.coerceIn(10, 30)).apply()

    var videoBitrateKbps: Int
        get() = prefs.getInt(KEY_VIDEO_BITRATE, 1800).coerceIn(400, 6000)
        set(value) = prefs.edit().putInt(KEY_VIDEO_BITRATE, value.coerceIn(400, 6000)).apply()

    fun getOrCreateDeviceId(): String {
        val existing = prefs.getString(KEY_DEVICE_ID, null)
        if (!existing.isNullOrBlank()) return existing
        val slug = Build.MODEL.lowercase()
            .replace(Regex("[^a-z0-9]+"), "-")
            .trim('-')
            .ifEmpty { "android" }
        val suffix = UUID.randomUUID().toString().replace("-", "").take(6)
        val generated = "$slug-$suffix"
        prefs.edit().putString(KEY_DEVICE_ID, generated).apply()
        return generated
    }

    fun getOrCreateClientId(): String {
        val existing = prefs.getString(KEY_CLIENT_ID, null)
        if (!existing.isNullOrBlank()) return existing
        val suffix = UUID.randomUUID().toString().replace("-", "").take(8)
        val generated = "android-$suffix"
        prefs.edit().putString(KEY_CLIENT_ID, generated).apply()
        return generated
    }

    private fun defaultDeviceName(): String {
        val model = Build.MODEL.orEmpty().trim()
        val device = Build.DEVICE.orEmpty().trim()
        return when {
            device.equals("alioth", ignoreCase = true) -> "Poco F3"
            model.isNotEmpty() -> model
            else -> "PurrCam Android"
        }
    }

    companion object {
        private const val KEY_SERVER_URL = "server_url"
        private const val KEY_REMOTE_URL = "remote_server_url"
        private const val KEY_AUTH_TOKEN = "auth_token"
        private const val KEY_MODE = "selected_mode"
        private const val KEY_AUTO_START = "auto_start"
        private const val KEY_DEVICE_NAME = "device_name"
        private const val KEY_DEVICE_ID = "device_id"
        private const val KEY_CLIENT_ID = "client_id"
        private const val KEY_CHARGE_LIMIT_ENABLED = "charge_limit_enabled"
        private const val KEY_CHARGE_LIMIT_MAX_PCT = "charge_limit_max_pct"
        private const val KEY_PREFERRED_LENS = "preferred_lens"
        private const val KEY_VIDEO_RES = "video_resolution"
        private const val KEY_VIDEO_FPS = "video_fps"
        private const val KEY_VIDEO_BITRATE = "video_bitrate_kbps"
    }
}
