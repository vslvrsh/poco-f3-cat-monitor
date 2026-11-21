package com.purrcam.app.camera

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlin.math.PI
import kotlin.math.exp
import kotlin.math.sin
import kotlin.random.Random

object CatSoundPlayer {
    private const val TAG = "PurrCamAudio"
    private const val SAMPLE_RATE = 44100

    suspend fun play(sound: String) = withContext(Dispatchers.Default) {
        val pcm = when (sound.lowercase()) {
            "psps" -> generatePsps()
            "chime" -> generateChime()
            "whistle" -> generateWhistle()
            else -> generatePsps()
        }
        playPcm(pcm)
    }

    private fun generatePsps(): ShortArray {
        // 3 rhythmic high-pass sibilant "ps-ps-ps" bursts that cats react strongly to
        val totalSamples = (SAMPLE_RATE * 1.15).toInt()
        val out = ShortArray(totalSamples)
        val rng = Random(System.currentTimeMillis())
        val burstStarts = listOf(0.02, 0.36, 0.70)
        val burstDur = 0.19

        var prev = 0.0
        var prev2 = 0.0
        for (i in 0 until totalSamples) {
            val t = i.toDouble() / SAMPLE_RATE
            val white = rng.nextDouble(-1.0, 1.0)
            // Simple 2nd-order high-pass emphasis (sibilant ~5-9 kHz texture)
            val hp = white - 1.3 * prev + 0.45 * prev2
            prev2 = prev
            prev = white

            var env = 0.0
            for (start in burstStarts) {
                val local = t - start
                if (local in 0.0..burstDur) {
                    val attack = (local / 0.025).coerceIn(0.0, 1.0)
                    val decay = ((burstDur - local) / 0.055).coerceIn(0.0, 1.0)
                    // Slight sharp consonant burst at onset ("p" + "sss")
                    val consonant = if (local < 0.02) 1.25 else 0.9
                    env = maxOf(env, attack * decay * consonant)
                }
            }
            val sample = (hp * env * 0.45 * Short.MAX_VALUE).toInt().coerceIn(Short.MIN_VALUE.toInt(), Short.MAX_VALUE.toInt())
            out[i] = sample.toShort()
        }
        return out
    }

    private fun generateChime(): ShortArray {
        // Warm two-note bell chime (C6 1046.5 Hz -> G6 1568 Hz)
        val totalSamples = (SAMPLE_RATE * 1.1).toInt()
        val out = ShortArray(totalSamples)
        for (i in 0 until totalSamples) {
            val t = i.toDouble() / SAMPLE_RATE
            var sig = 0.0
            // Note 1: 0.0..0.6s
            if (t >= 0.0) {
                val env1 = (t / 0.008).coerceAtMost(1.0) * exp(-t * 5.2)
                sig += (sin(2.0 * PI * 1046.5 * t) + 0.35 * sin(2.0 * PI * 2093.0 * t)) * env1
            }
            // Note 2: 0.22..1.1s
            if (t >= 0.22) {
                val dt = t - 0.22
                val env2 = (dt / 0.008).coerceAtMost(1.0) * exp(-dt * 4.5)
                sig += (sin(2.0 * PI * 1567.98 * dt) + 0.3 * sin(2.0 * PI * 3135.96 * dt)) * env2
            }
            out[i] = (sig * 0.42 * Short.MAX_VALUE).toInt().coerceIn(Short.MIN_VALUE.toInt(), Short.MAX_VALUE.toInt()).toShort()
        }
        return out
    }

    private fun generateWhistle(): ShortArray {
        // Gentle bird-like chirp whistle (1800 Hz -> 2950 Hz -> 2250 Hz, twice)
        val totalSamples = (SAMPLE_RATE * 0.95).toInt()
        val out = ShortArray(totalSamples)
        var phase = 0.0
        for (i in 0 until totalSamples) {
            val t = i.toDouble() / SAMPLE_RATE
            val (active, u) = when {
                t in 0.02..0.38 -> true to ((t - 0.02) / 0.36)
                t in 0.48..0.88 -> true to ((t - 0.48) / 0.40)
                else -> false to 0.0
            }
            if (!active) {
                out[i] = 0
                continue
            }
            val freq = 1850.0 + 1100.0 * sin(PI * u)
            phase += 2.0 * PI * freq / SAMPLE_RATE
            val env = sin(PI * u)
            val sig = (sin(phase) + 0.15 * sin(2.0 * phase)) * env
            out[i] = (sig * 0.55 * Short.MAX_VALUE).toInt().coerceIn(Short.MIN_VALUE.toInt(), Short.MAX_VALUE.toInt()).toShort()
        }
        return out
    }

    private fun playPcm(pcm: ShortArray) {
        val minBuf = AudioTrack.getMinBufferSize(
            SAMPLE_RATE,
            AudioFormat.CHANNEL_OUT_MONO,
            AudioFormat.ENCODING_PCM_16BIT
        )
        val byteLen = pcm.size * 2
        val track = AudioTrack.Builder()
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build()
            )
            .setAudioFormat(
                AudioFormat.Builder()
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .setSampleRate(SAMPLE_RATE)
                    .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                    .build()
            )
            .setBufferSizeInBytes(maxOf(minBuf, byteLen))
            .setTransferMode(AudioTrack.MODE_STATIC)
            .build()

        try {
            track.write(pcm, 0, pcm.size)
            track.play()
            val durationMs = ((pcm.size.toLong() * 1000L) / SAMPLE_RATE) + 120L
            Thread.sleep(durationMs)
        } catch (e: Exception) {
            Log.w(TAG, "CatSoundPlayer playback error: ${e.message}")
        } finally {
            try {
                track.stop()
            } catch (_: Exception) {
            }
            track.release()
        }
    }
}
