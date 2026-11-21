package com.purrcam.app.protocol

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import org.webrtc.PeerConnection
import java.net.URI
import java.net.URLDecoder
import java.net.URLEncoder

val PurrJson: Json = Json {
    ignoreUnknownKeys = true
    encodeDefaults = true
    explicitNulls = true
    isLenient = true
}

@Serializable
data class LensInfo(
    val id: String,
    val cameraId: String,
    val physicalCameraId: String? = null,
    val label: String,
    val type: String, // "ultrawide" | "wide" | "tele" | "macro" | "front" | "other"
    val facing: String, // "back" | "front"
    val focalLengthMm: Float,
    val zoomFactor: Float,
    val hasFlash: Boolean,
    val maxZoom: Float
) {
    /** Concise pill label for floating viewfinder / player dock (e.g. "0.6×", "1×", "Macro", "Front") */
    fun shortPillLabel(): String = when (type) {
        "ultrawide" -> "${formatZoomShort(zoomFactor)}×"
        "wide" -> if (zoomFactor in 0.95f..1.05f) "1×" else "${formatZoomShort(zoomFactor)}×"
        "tele" -> "${formatZoomShort(zoomFactor)}×"
        "macro" -> "Macro"
        "front" -> "Front"
        else -> label
    }

    private fun formatZoomShort(z: Float): String {
        val rounded = Math.round(z * 10f) / 10f
        return if (rounded == rounded.toInt().toFloat()) rounded.toInt().toString()
        else String.format(java.util.Locale.US, "%.1f", rounded)
    }
}

@Serializable
data class CameraCapabilities(
    val torch: Boolean = false,
    val audioIn: Boolean = true,
    val audioOut: Boolean = true,
    val root: Boolean = false,
    val chargeLimit: Boolean = false,
    val rootDisplayOff: Boolean = false
)

@Serializable
data class CameraState(
    val activeLensId: String = "wide",
    val torch: Boolean = false,
    val blackout: Boolean = false,
    val rootDisplayOff: Boolean = false,
    val resolution: String = "720p", // "480p" | "720p" | "1080p"
    val fps: Int = 24,
    val bitrateKbps: Int = 1800,
    val ev: Float = 0f,
    val zoomRatio: Float = 1.0f,
    val micEnabled: Boolean = true,
    val speakerEnabled: Boolean = true,
    val chargeLimitEnabled: Boolean = false,
    val chargeLimitMaxPct: Int = 80,
    val streaming: Boolean = false
)

@Serializable
data class Telemetry(
    val ts: Long,
    val batteryPct: Int,
    val charging: Boolean,
    val chargeSource: String, // "ac" | "usb" | "wireless" | "none"
    val chargePaused: Boolean,
    val batteryTempC: Float,
    val cpuTempC: Float? = null,
    val voltageMv: Int,
    val currentMa: Int,
    val wifiRssi: Int? = null,
    val uptimeSec: Long,
    val freeRamMb: Long,
    val freeStorageMb: Long,
    val activeLensId: String,
    val fps: Int? = null,
    val bitrateKbps: Int? = null
)

@Serializable
data class CameraSummary(
    val deviceId: String,
    val deviceName: String,
    val lenses: List<LensInfo> = emptyList(),
    val capabilities: CameraCapabilities = CameraCapabilities(),
    val state: CameraState = CameraState(),
    val telemetry: Telemetry? = null
)

@Serializable
data class IceServerConfig(
    val urls: JsonElement,
    val username: String? = null,
    val credential: String? = null
) {
    fun toUrlList(): List<String> = when (val elem = urls) {
        is JsonPrimitive -> listOfNotNull(elem.contentOrNull?.takeIf { it.isNotBlank() })
        is JsonArray -> elem.mapNotNull { (it as? JsonPrimitive)?.contentOrNull?.takeIf { s -> s.isNotBlank() } }
        else -> emptyList()
    }

    fun toWebRtcIceServer(): PeerConnection.IceServer? {
        val urlList = toUrlList()
        if (urlList.isEmpty()) return null
        val builder = PeerConnection.IceServer.builder(urlList)
        if (!username.isNullOrBlank()) builder.setUsername(username)
        if (!credential.isNullOrBlank()) builder.setPassword(credential)
        return builder.createIceServer()
    }
}

@Serializable
data class SnapshotMeta(
    val id: String,
    val filename: String,
    val url: String,
    val createdAt: Long,
    val sizeBytes: Long,
    val lensLabel: String? = null
)

@Serializable
data class SnapshotListResponseDto(
    val items: List<SnapshotMeta> = emptyList()
)

@Serializable
data class IceCandidateDto(
    val candidate: String,
    val sdpMid: String? = null,
    val sdpMLineIndex: Int = 0
)

@Serializable
data class RemoteStatusDto(
    val enabled: Boolean = false,
    val status: String = "stopped", // "stopped" | "starting" | "running" | "error"
    val provider: String = "none", // "cloudflare" | "tailscale" | "custom" | "none"
    val url: String? = null,
    val wsUrl: String? = null,
    val error: String? = null
)

@Serializable
data class ServerInfoDto(
    val name: String = "PurrCam",
    val version: String = "1.1.0",
    val lanIps: List<String> = emptyList(),
    val tailscaleIp: String? = null,
    val port: Int = 8787,
    val wsUrl: String = "",
    val cameraOnline: Boolean = false,
    val viewerCount: Int = 0,
    val tokenRequired: Boolean = false,
    val turnConfigured: Boolean = false,
    val remote: RemoteStatusDto? = null
)

// Outgoing WebSocket frames

@Serializable
data class RegisterCameraMsg(
    val type: String = "register",
    val role: String = "camera",
    val deviceId: String,
    val deviceName: String,
    val lenses: List<LensInfo>,
    val capabilities: CameraCapabilities,
    val state: CameraState,
    val token: String = ""
)

@Serializable
data class RegisterViewerMsg(
    val type: String = "register",
    val role: String = "viewer",
    val clientId: String,
    val clientName: String,
    val clientType: String = "android",
    val token: String = ""
)

@Serializable
data class TelemetryMsg(
    val type: String = "telemetry",
    val data: Telemetry
)

@Serializable
data class StateUpdateMsg(
    val type: String = "state_update",
    val state: CameraState,
    val lenses: List<LensInfo>? = null
)

@Serializable
data class CommandAckMsg(
    val type: String = "command_ack",
    val commandId: String,
    val ok: Boolean,
    val error: String? = null,
    val state: CameraState? = null
)

@Serializable
data class CommandMsg(
    val type: String = "command",
    val commandId: String,
    val action: String,
    val payload: JsonObject = JsonObject(emptyMap())
)

@Serializable
data class WatchRequestMsg(
    val type: String = "watch_request",
    val viewerId: String
)

@Serializable
data class WatchStopMsg(
    val type: String = "watch_stop",
    val viewerId: String
)

@Serializable
data class RtcOfferMsg(
    val type: String = "rtc_offer",
    val viewerId: String,
    val sdp: String
)

@Serializable
data class RtcAnswerMsg(
    val type: String = "rtc_answer",
    val viewerId: String,
    val sdp: String
)

@Serializable
data class RtcIceMsg(
    val type: String = "rtc_ice",
    val viewerId: String,
    val candidate: IceCandidateDto
)

@Serializable
data class PingPongMsg(
    val type: String,
    val ts: Long
)

data class ParsedServerEndpoint(
    val wsUrl: String,
    val httpBaseUrl: String,
    val tokenFromUrl: String?,
    val isSecure: Boolean
) {
    fun wsUrlWithToken(token: String?): String {
        val tok = token?.takeIf { it.isNotBlank() } ?: tokenFromUrl?.takeIf { it.isNotBlank() }
        if (tok.isNullOrBlank()) return wsUrl
        val encoded = URLEncoder.encode(tok, "UTF-8").replace("+", "%20")
        val sep = if (wsUrl.contains("?")) "&" else "?"
        return "$wsUrl${sep}token=$encoded"
    }
}

data class ParsedPairingLink(
    val localUrl: String? = null,
    val remoteUrl: String? = null,
    val token: String? = null
)

object ServerUrlHelper {
    const val DEFAULT_LOCAL_URL = "ws://127.0.0.1:8787/ws"
    const val DEFAULT_LAN_URL = "ws://192.168.1.100:8787/ws"

    /**
     * Normalizes user-entered LAN/USB/HTTPS/WSS URLs into clean WebSocket + HTTP base endpoints.
     * - `https://example.trycloudflare.com` -> `wss://example.trycloudflare.com/ws` & `https://example.trycloudflare.com` (NEVER appends `:8787`!)
     * - `wss://example.trycloudflare.com/ws?token=abc` -> preserves scheme/host/no-port + extracts token
     * - `http://192.168.1.100:8787` -> `ws://192.168.1.100:8787/ws` & `http://192.168.1.100:8787`
     * - `192.168.1.100` (bare IP without scheme/port) -> `ws://192.168.1.100:8787/ws`
     * - `example.trycloudflare.com` (bare public hostname) -> `wss://example.trycloudflare.com/ws`
     */
    fun parse(rawInput: String): ParsedServerEndpoint {
        val trimmed = rawInput.trim().ifEmpty { DEFAULT_LOCAL_URL }
        val hasExplicitScheme = trimmed.startsWith("ws://", ignoreCase = true) ||
            trimmed.startsWith("wss://", ignoreCase = true) ||
            trimmed.startsWith("http://", ignoreCase = true) ||
            trimmed.startsWith("https://", ignoreCase = true)

        val inferredScheme = when {
            hasExplicitScheme -> trimmed
            trimmed.contains("trycloudflare.com", ignoreCase = true) -> "https://$trimmed"
            else -> "ws://$trimmed"
        }

        val uri = try {
            URI(inferredScheme)
        } catch (_: Exception) {
            URI(DEFAULT_LOCAL_URL)
        }

        val schemeLower = uri.scheme?.lowercase() ?: "ws"
        val isSecure = schemeLower == "wss" || schemeLower == "https"
        val host = uri.host?.takeIf { it.isNotBlank() } ?: "127.0.0.1"
        val explicitPort = uri.port

        // Never inject :8787 onto https:// or wss:// URLs (standard 443).
        // Only default :8787 for bare non-secure host/IP inputs without an explicit port.
        val portSuffix = when {
            explicitPort > 0 -> ":$explicitPort"
            isSecure -> ""
            !hasExplicitScheme -> ":8787"
            isLocalOrIpHost(host) -> ":8787"
            else -> ""
        }

        val rawPath = uri.rawPath?.takeIf { it.isNotBlank() && it != "/" } ?: "/ws"
        val wsPath = when {
            rawPath.endsWith("/ws") -> rawPath
            rawPath == "/" -> "/ws"
            else -> "${rawPath.trimEnd('/')}/ws"
        }

        val tokenFromUrl = parseQueryParams(uri.rawQuery)["token"]?.takeIf { it.isNotBlank() }

        val wsScheme = if (isSecure) "wss" else "ws"
        val httpScheme = if (isSecure) "https" else "http"

        val wsUrl = "$wsScheme://$host$portSuffix$wsPath"
        val httpBaseUrl = "$httpScheme://$host$portSuffix"
        return ParsedServerEndpoint(
            wsUrl = wsUrl,
            httpBaseUrl = httpBaseUrl,
            tokenFromUrl = tokenFromUrl,
            isSecure = isSecure
        )
    }

    fun isRemoteUrl(raw: String): Boolean {
        val t = raw.trim().lowercase()
        return t.startsWith("https://") || t.startsWith("wss://") || t.contains("trycloudflare.com")
    }

    private fun isLocalOrIpHost(host: String): Boolean {
        if (host.equals("localhost", ignoreCase = true)) return true
        return host.matches(Regex("^\\d{1,3}(\\.\\d{1,3}){3}$"))
    }

    internal fun parseQueryParams(rawQuery: String?): Map<String, String> {
        if (rawQuery.isNullOrBlank()) return emptyMap()
        val result = linkedMapOf<String, String>()
        for (pair in rawQuery.split("&")) {
            if (pair.isBlank()) continue
            val idx = pair.indexOf('=')
            val key = if (idx >= 0) pair.substring(0, idx) else pair
            val value = if (idx >= 0) pair.substring(idx + 1) else ""
            val decodedKey = decodeQueryComponent(key)
            val decodedValue = decodeQueryComponent(value)
            if (decodedKey.isNotEmpty()) {
                result[decodedKey] = decodedValue
            }
        }
        return result
    }

    private fun decodeQueryComponent(value: String): String {
        return try {
            URLDecoder.decode(value, "UTF-8")
        } catch (_: Exception) {
            value
        }
    }
}

object PairingLinkParser {
    /**
     * Parses:
     * - `purrcam://connect?local=ws://192.168.1.100:8787/ws&remote=https://example.trycloudflare.com&token=xyz`
     * - Direct HTTPS/WSS remote URL (optionally with `?token=xyz`)
     * - Direct HTTP/WS local LAN URL (optionally with `?token=xyz`)
     */
    fun maskToken(token: String?): String {
        val t = token?.trim().orEmpty()
        if (t.isEmpty()) return "None"
        return if (t.length <= 8) {
            "•••• (${t.length} chars)"
        } else {
            "${t.take(4)}••••${t.takeLast(4)}"
        }
    }
    fun parse(rawInput: String): ParsedPairingLink? {
        val trimmed = rawInput.trim()
        if (trimmed.isEmpty()) return null

        if (trimmed.startsWith("purrcam://", ignoreCase = true)) {
            val uri = try {
                URI(trimmed)
            } catch (_: Exception) {
                return null
            }
            val params = ServerUrlHelper.parseQueryParams(uri.rawQuery)
            val local = params["local"]?.trim()?.takeIf { it.isNotBlank() }
                ?.let { ServerUrlHelper.parse(it).wsUrl }
            val remote = params["remote"]?.trim()?.takeIf { it.isNotBlank() }
                ?.let { ServerUrlHelper.parse(it).wsUrl }
            val token = params["token"]?.trim()?.takeIf { it.isNotBlank() }
            if (local == null && remote == null && token == null) return null
            return ParsedPairingLink(localUrl = local, remoteUrl = remote, token = token)
        }

        val ep = ServerUrlHelper.parse(trimmed)
        return if (ep.isSecure) {
            ParsedPairingLink(localUrl = null, remoteUrl = ep.wsUrl, token = ep.tokenFromUrl)
        } else {
            ParsedPairingLink(localUrl = ep.wsUrl, remoteUrl = null, token = ep.tokenFromUrl)
        }
    }
}
