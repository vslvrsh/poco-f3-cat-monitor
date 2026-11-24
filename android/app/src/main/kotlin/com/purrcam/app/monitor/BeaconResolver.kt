package com.purrcam.app.monitor

import android.util.Log
import com.purrcam.app.protocol.PurrJson
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.Request
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import java.util.concurrent.TimeUnit
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

@Serializable
data class BeaconPayload(
    val v: Int = 1,
    val url: String,
    val wsUrl: String,
    val provider: String = "auto",
    val ts: Long
)

@Serializable
data class BeaconEnvelope(
    val v: Int = 1,
    val iv: String,
    val ct: String
)

/**
 * Protocol v1.2 §8 — Zero-Account End-to-End Encrypted Auto-Discovery Beacon (`ntfy.sh` + `ntfy.envs.net`).
 * Crypto spec is byte-for-byte identical across Node `crypto`, Browser `WebCrypto`, and JVM/Android `Cipher`:
 * - `topicId = "purrcam-" + sha256Hex("purrcam:beacon:topic:v1:" + token).take(32)`
 * - `aesKey  = sha256Bytes("purrcam:beacon:aes256:v1:" + token)` (32 bytes = AES-256-GCM)
 * - `combined = ciphertext || 16-byte GCM tag`, standard Base64, 12-byte IV, no AAD.
 */
object BeaconResolver {
    private const val TAG = "PurrCamBeacon"
    private const val TOPIC_PREFIX = "purrcam:beacon:topic:v1:"
    private const val KEY_PREFIX = "purrcam:beacon:aes256:v1:"

    val DEFAULT_ENDPOINTS: List<String> = listOf(
        "https://ntfy.sh",
        "https://ntfy.envs.net"
    )

    fun deriveTopicId(token: String): String {
        val digest = sha256Bytes(TOPIC_PREFIX + token)
        val hex = digest.joinToString("") { "%02x".format(it) }
        return "purrcam-" + hex.substring(0, 32)
    }

    fun deriveAesKey(token: String): ByteArray {
        return sha256Bytes(KEY_PREFIX + token)
    }

    fun encryptEnvelope(
        token: String,
        payload: BeaconPayload,
        iv: ByteArray = ByteArray(12).also { SecureRandom().nextBytes(it) }
    ): String {
        require(iv.size == 12) { "AES-GCM IV must be 12 bytes" }
        val key = deriveAesKey(token)
        val plaintext = PurrJson.encodeToString(payload).toByteArray(Charsets.UTF_8)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
        val ctWithTag = cipher.doFinal(plaintext)
        val env = BeaconEnvelope(
            v = 1,
            iv = Base64.getEncoder().encodeToString(iv),
            ct = Base64.getEncoder().encodeToString(ctWithTag)
        )
        return PurrJson.encodeToString(env)
    }

    fun decryptEnvelope(token: String, envelopeJson: String): BeaconPayload? {
        if (token.isBlank() || envelopeJson.isBlank()) return null
        return try {
            val env = PurrJson.decodeFromString<BeaconEnvelope>(envelopeJson.trim())
            if (env.v != 1) return null
            val iv = Base64.getDecoder().decode(env.iv.trim())
            val ctWithTag = Base64.getDecoder().decode(env.ct.trim())
            if (iv.size != 12 || ctWithTag.size < 17) return null

            val key = deriveAesKey(token)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
            val plainBytes = cipher.doFinal(ctWithTag)
            val payload = PurrJson.decodeFromString<BeaconPayload>(String(plainBytes, Charsets.UTF_8))

            if (payload.v != 1) return null
            if (!payload.url.startsWith("https://", ignoreCase = true)) return null
            if (!payload.wsUrl.startsWith("wss://", ignoreCase = true)) return null
            if (payload.ts <= 0L) return null
            payload
        } catch (_: Exception) {
            null
        }
    }

    fun parseNtfyNdjson(token: String, ndjsonBody: String): List<BeaconPayload> {
        val results = mutableListOf<BeaconPayload>()
        for (rawLine in ndjsonBody.lineSequence()) {
            val line = rawLine.trim()
            if (line.isEmpty()) continue
            try {
                val obj = PurrJson.parseToJsonElement(line).jsonObject
                val event = obj["event"]?.jsonPrimitive?.contentOrNull
                if (event != "message") continue
                val message = obj["message"]?.jsonPrimitive?.contentOrNull ?: continue
                decryptEnvelope(token, message)?.let { results.add(it) }
            } catch (_: Exception) {
                continue
            }
        }
        return results
    }

    suspend fun resolveLatest(
        token: String,
        baseClient: OkHttpClient,
        endpoints: List<String> = DEFAULT_ENDPOINTS
    ): BeaconPayload? = withContext(Dispatchers.IO) {
        if (token.isBlank()) return@withContext null
        val topicId = deriveTopicId(token)
        val pollClient = baseClient.newBuilder()
            .connectTimeout(5, TimeUnit.SECONDS)
            .readTimeout(6, TimeUnit.SECONDS)
            .build()

        var best: BeaconPayload? = null
        for (base in endpoints) {
            val url = "${base.trimEnd('/')}/$topicId/json?poll=1&since=all"
            try {
                val req = Request.Builder()
                    .url(url)
                    .header("Accept", "application/x-ndjson, application/json, text/plain")
                    .build()
                pollClient.newCall(req).execute().use { resp ->
                    if (!resp.isSuccessful) return@use
                    val body = resp.body?.string().orEmpty()
                    val decoded = parseNtfyNdjson(token, body)
                    for (item in decoded) {
                        if (best == null || item.ts > best!!.ts) {
                            best = item
                        }
                    }
                }
            } catch (e: Exception) {
                Log.d(TAG, "Beacon poll failed for $base: ${e.message}")
            }
        }
        if (best != null) {
            Log.i(TAG, "Beacon resolved live remote URL: ${best!!.wsUrl} (provider=${best!!.provider}, ts=${best!!.ts})")
        }
        best
    }

    private fun sha256Bytes(input: String): ByteArray {
        val md = MessageDigest.getInstance("SHA-256")
        return md.digest(input.toByteArray(Charsets.UTF_8))
    }
}
