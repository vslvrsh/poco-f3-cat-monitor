package com.purrcam.app

import com.purrcam.app.camera.RelayFrameEncoder
import com.purrcam.app.monitor.BeaconPayload
import com.purrcam.app.monitor.BeaconResolver
import com.purrcam.app.protocol.CameraCapabilities
import com.purrcam.app.protocol.CameraState
import com.purrcam.app.protocol.CommandAckMsg
import com.purrcam.app.protocol.IceServerConfig
import com.purrcam.app.protocol.LensInfo
import com.purrcam.app.protocol.PairingLinkParser
import com.purrcam.app.protocol.PurrJson
import com.purrcam.app.protocol.RegisterCameraMsg
import com.purrcam.app.protocol.ServerUrlHelper
import com.purrcam.app.protocol.StreamModeMsg
import com.purrcam.app.protocol.Telemetry
import com.purrcam.app.protocol.TelemetryMsg
import com.purrcam.app.protocol.VideoFrameMsg
import com.purrcam.app.root.RootPowerController
import kotlinx.serialization.encodeToString
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Base64

class ProtocolTest {
    @Test
    fun registerCameraSerializationMatchesProtocol() {
        val lens = LensInfo(
            id = "ultrawide",
            cameraId = "2",
            physicalCameraId = null,
            label = "0.6× Wide",
            type = "ultrawide",
            facing = "back",
            focalLengthMm = 1.65f,
            zoomFactor = 0.6f,
            hasFlash = true,
            maxZoom = 10.0f
        )
        assertEquals("0.6×", lens.shortPillLabel())

        val msg = RegisterCameraMsg(
            deviceId = "poco-f3-example",
            deviceName = "Poco F3",
            lenses = listOf(lens),
            capabilities = CameraCapabilities(
                torch = true,
                audioIn = true,
                audioOut = true,
                root = true,
                chargeLimit = true,
                rootDisplayOff = true
            ),
            state = CameraState(activeLensId = "ultrawide", streaming = true)
        )
        val encoded = PurrJson.encodeToString(msg)
        assertTrue(encoded.contains("\"type\":\"register\""))
        assertTrue(encoded.contains("\"role\":\"camera\""))
        assertTrue(encoded.contains("\"label\":\"0.6× Wide\""))
        assertTrue(encoded.contains("\"physicalCameraId\":null"))
        assertTrue(encoded.contains("\"rootDisplayOff\":true"))
    }

    @Test
    fun telemetryAndCommandAckRoundTrip() {
        val tel = Telemetry(
            ts = 1795239303000L,
            batteryPct = 78,
            charging = true,
            chargeSource = "usb",
            chargePaused = false,
            batteryTempC = 33.5f,
            cpuTempC = 39.2f,
            voltageMv = 4145,
            currentMa = 620,
            wifiRssi = -51,
            uptimeSec = 1420,
            freeRamMb = 3840,
            freeStorageMb = 64200,
            activeLensId = "ultrawide",
            fps = 24,
            bitrateKbps = 1800
        )
        val json = PurrJson.encodeToString(TelemetryMsg(data = tel))
        val decoded = PurrJson.decodeFromString<TelemetryMsg>(json)
        assertEquals("telemetry", decoded.type)
        assertEquals(78, decoded.data.batteryPct)
        assertEquals("ultrawide", decoded.data.activeLensId)

        val ack = CommandAckMsg(commandId = "cmd-1", ok = true, error = null, state = CameraState())
        val ackJson = PurrJson.encodeToString(ack)
        assertTrue(ackJson.contains("\"commandId\":\"cmd-1\""))
        assertTrue(ackJson.contains("\"ok\":true"))
    }

    @Test
    fun lensLabelHeaderUsesRfc3986PercentEncoding() {
        val label = "0.6× Wide"
        val encoded = java.net.URLEncoder.encode(label, "UTF-8").replace("+", "%20")
        assertFalse(encoded.contains("+"))
        assertTrue(encoded.contains("%20"))
    }

    @Test
    fun httpsRemoteTunnelUrlDoesNotAppendPort8787() {
        val ep = ServerUrlHelper.parse("https://example-tunnel.trycloudflare.com")
        assertEquals("wss://example-tunnel.trycloudflare.com/ws", ep.wsUrl)
        assertEquals("https://example-tunnel.trycloudflare.com", ep.httpBaseUrl)
        assertTrue(ep.isSecure)
        assertNull(ep.tokenFromUrl)
        assertEquals("wss://example-tunnel.trycloudflare.com/ws?token=sec%20ret", ep.wsUrlWithToken("sec ret"))

        val wssWithToken = ServerUrlHelper.parse("wss://example-tunnel.trycloudflare.com/ws?token=abc123")
        assertEquals("wss://example-tunnel.trycloudflare.com/ws", wssWithToken.wsUrl)
        assertEquals("https://example-tunnel.trycloudflare.com", wssWithToken.httpBaseUrl)
        assertEquals("abc123", wssWithToken.tokenFromUrl)
    }

    @Test
    fun localLanUrlPreservesOrDefaultsPort8787() {
        val ep1 = ServerUrlHelper.parse("192.168.1.100")
        assertEquals("ws://192.168.1.100:8787/ws", ep1.wsUrl)
        assertEquals("http://192.168.1.100:8787", ep1.httpBaseUrl)
        assertFalse(ep1.isSecure)

        val ep2 = ServerUrlHelper.parse("http://192.168.1.100:8787")
        assertEquals("ws://192.168.1.100:8787/ws", ep2.wsUrl)
        assertEquals("http://192.168.1.100:8787", ep2.httpBaseUrl)

        val ep3 = ServerUrlHelper.parse("https://cam.example.com:8443")
        assertEquals("wss://cam.example.com:8443/ws", ep3.wsUrl)
        assertEquals("https://cam.example.com:8443", ep3.httpBaseUrl)
    }

    @Test
    fun pairingLinkParserExtractsLocalRemoteAndMasksToken() {
        val link = "purrcam://connect?local=ws%3A%2F%2F192.168.1.100%3A8787%2Fws&remote=https%3A%2F%2Fexample.trycloudflare.com&token=mySecretToken99"
        val parsed = PairingLinkParser.parse(link)
        assertNotNull(parsed)
        assertEquals("ws://192.168.1.100:8787/ws", parsed!!.localUrl)
        assertEquals("wss://example.trycloudflare.com/ws", parsed.remoteUrl)
        assertEquals("mySecretToken99", parsed.token)
        assertEquals("mySe••••en99", PairingLinkParser.maskToken(parsed.token))
        assertEquals("None", PairingLinkParser.maskToken(""))
    }

    @Test
    fun iceServerConfigSupportsStringAndArrayUrlsWithTurnCredentials() {
        val singleJson = """{"urls":"turn:turn.example.com:3478","username":"u1","credential":"p1"}"""
        val single = PurrJson.decodeFromString<IceServerConfig>(singleJson)
        assertEquals(listOf("turn:turn.example.com:3478"), single.toUrlList())
        assertEquals("u1", single.username)
        assertEquals("p1", single.credential)

        val multiJson = """{"urls":["turn:a.example.com:3478","turns:a.example.com:5349"],"username":"u2","credential":"p2"}"""
        val multi = PurrJson.decodeFromString<IceServerConfig>(multiJson)
        assertEquals(listOf("turn:a.example.com:3478", "turns:a.example.com:5349"), multi.toUrlList())
        assertEquals("u2", multi.username)
        assertEquals("p2", multi.credential)
    }

    @Test
    fun rootSysfsWhitelistRejectsShellInjectionAndTraversal() {
        assertTrue(RootPowerController.isSafeBacklightPath("/sys/class/backlight/panel0-backlight/brightness"))
        assertTrue(RootPowerController.isSafeBacklightPath("/sys/class/leds/lcd-backlight/brightness"))
        assertFalse(RootPowerController.isSafeBacklightPath("/sys/class/backlight/foo';id;'/brightness"))
        assertFalse(RootPowerController.isSafeBacklightPath("/sys/class/backlight/../power_supply/brightness"))
        assertFalse(RootPowerController.isSafeBacklightPath("/etc/passwd"))

        assertTrue(RootPowerController.isAllowedChargeNode("/sys/class/power_supply/battery/input_suspend"))
        assertFalse(RootPowerController.isAllowedChargeNode("/sys/class/power_supply/battery/input_suspend;id"))
        assertFalse(RootPowerController.isAllowedChargeNode("/data/local/tmp/evil"))
    }

    @Test
    fun encryptedBeaconMatchesProtocolV12InteropTestVector() {
        val token = "purrcam-test-vector-token-v1"
        val expectedTopic = "purrcam-a793ba5e2ec528be44b8c7169f47de2d"
        assertEquals(expectedTopic, BeaconResolver.deriveTopicId(token))

        val specEnvelope = """{"v":1,"iv":"AQIDBAUGBwgJCgsM","ct":"makxxxrVCdpbHF1dzommR5+Bzaej6iOtNkMXQzrV0M8Rgtkosyq7lOK1ENcS18T4qFASC4aWlqgXvNNv/cyS7kehKARzrygL4Fdu/b0HxJ7nj1zD7fNvMU7rPhbiZOX6RgDBFhtvuWTJgYOkeCnxTs0Rr/OVmB2OnsMgzWlESBdP2lBL/l5/Onl7sEk="}"""
        val decrypted = BeaconResolver.decryptEnvelope(token, specEnvelope)
        assertNotNull(decrypted)
        assertEquals("https://demo.app.lhr.life", decrypted!!.url)
        assertEquals("wss://demo.app.lhr.life/ws", decrypted.wsUrl)
        assertEquals("localhost.run", decrypted.provider)
        assertEquals(1795500000000L, decrypted.ts)

        // Wrong token must fail AES-GCM authentication
        assertNull(BeaconResolver.decryptEnvelope("wrong-token", specEnvelope))

        // Re-encrypting with exact same IV produces byte-for-byte identical envelope
        val iv = Base64.getDecoder().decode("AQIDBAUGBwgJCgsM")
        val reEncrypted = BeaconResolver.encryptEnvelope(token, decrypted, iv)
        assertEquals(specEnvelope, reEncrypted)

        // NDJSON polling picks highest timestamp across multiple entries
        val newer = BeaconPayload(
            v = 1,
            url = "https://newer.app.lhr.life",
            wsUrl = "wss://newer.app.lhr.life/ws",
            provider = "pinggy",
            ts = 1795500099000L
        )
        val newerEnv = BeaconResolver.encryptEnvelope(token, newer)
        val ndjson = buildString {
            appendLine("""{"id":"1","event":"open"}""")
            appendLine("""{"id":"2","event":"message","message":${PurrJson.encodeToString(specEnvelope)}}""")
            appendLine("""{"id":"3","event":"message","message":${PurrJson.encodeToString(newerEnv)}}""")
        }
        val parsedList = BeaconResolver.parseNtfyNdjson(token, ndjson)
        assertEquals(2, parsedList.size)
        assertEquals("wss://newer.app.lhr.life/ws", parsedList.maxBy { it.ts }.wsUrl)
    }

    @Test
    fun relayFrameEncoderDimensionsAndRotationsAreUpright() {
        // 1280x720 rotated 90 deg -> portrait 540x960 (max short edge 540)
        assertEquals(540 to 960, RelayFrameEncoder.computeOutputDimensions(1280, 720, 90))
        assertEquals(540 to 960, RelayFrameEncoder.computeOutputDimensions(1280, 720, 270))
        assertEquals(960 to 540, RelayFrameEncoder.computeOutputDimensions(1280, 720, 0))
        assertEquals(960 to 540, RelayFrameEncoder.computeOutputDimensions(1280, 720, 180))

        // Verify 90 deg clockwise corner mapping: dst(0,0) <- src(0, srcH-1)
        val p90TopLeft = RelayFrameEncoder.mapDestToSource(0, 0, 540, 960, 1280, 720, 90)
        assertEquals(0, (p90TopLeft ushr 16) and 0xFFFF)
        assertTrue((p90TopLeft and 0xFFFF) >= 718)

        // Verify 270 deg (front camera) corner mapping: dst(0,0) <- src(srcW-1, 0)
        val p270TopLeft = RelayFrameEncoder.mapDestToSource(0, 0, 540, 960, 1280, 720, 270)
        assertTrue(((p270TopLeft ushr 16) and 0xFFFF) >= 1278)
        assertEquals(0, p270TopLeft and 0xFFFF)

        // Verify Protocol v1.2 ws_relay frame serialization
        val sm = PurrJson.encodeToString(StreamModeMsg(viewerId = "v1", mode = "ws_relay", fps = 8, quality = 60))
        assertTrue(sm.contains("\"type\":\"stream_mode\""))
        assertTrue(sm.contains("\"mode\":\"ws_relay\""))

        val vf = PurrJson.encodeToString(
            VideoFrameMsg(ts = 123L, width = 540, height = 960, lensLabel = "0.6× Wide", data = "AAAA")
        )
        assertTrue(vf.contains("\"type\":\"video_frame\""))
        assertTrue(vf.contains("\"mime\":\"image/jpeg\""))
    }
}
