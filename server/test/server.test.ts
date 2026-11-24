import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import WebSocket from "ws";
import { PurrCamServer } from "../dist/app.js";
import {
  decryptBeaconPayload,
  deriveBeaconTopicId,
  encryptBeaconPayload,
} from "../dist/beacon.js";
import {
  getLanIps,
  getTailscaleIp,
  isLocalHostHeader,
  isLocalIpAddress,
  parseIceServers,
} from "../dist/network.js";
import {
  AuthRateLimiter,
  constantTimeTokenEqual,
  generateStrongToken,
  isValidJpegBuffer,
} from "../dist/security.js";
import { parseBackendTunnelUrl } from "../dist/tunnel.js";

class WsTestClient {
  readonly ws: WebSocket;
  private queue: Record<string, unknown>[] = [];
  private waiters: Array<{
    predicate: (msg: Record<string, unknown>) => boolean;
    resolve: (msg: Record<string, unknown>) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];
  closeEvent: Promise<{ code: number; reason: string }>;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    this.closeEvent = new Promise((resolve) => {
      ws.once("close", (code, reasonBuf) => {
        resolve({ code, reason: reasonBuf.toString("utf8") });
      });
    });

    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
      const idx = this.waiters.findIndex((w) => w.predicate(msg));
      if (idx !== -1) {
        const [waiter] = this.waiters.splice(idx, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(msg);
      } else {
        this.queue.push(msg);
      }
    });
  }

  static connect(url: string): Promise<WsTestClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.once("open", () => resolve(new WsTestClient(ws)));
      ws.once("error", reject);
    });
  }

  send(payload: unknown): void {
    this.ws.send(JSON.stringify(payload));
  }

  nextMessage(
    predicate: (msg: Record<string, unknown>) => boolean = () => true,
    timeoutMs = 3000
  ): Promise<Record<string, unknown>> {
    const idx = this.queue.findIndex(predicate);
    if (idx !== -1) {
      const [msg] = this.queue.splice(idx, 1);
      return Promise.resolve(msg);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const wIdx = this.waiters.findIndex((w) => w.timer === timer);
        if (wIdx !== -1) this.waiters.splice(wIdx, 1);
        reject(new Error(`Timed out waiting for WS message (${timeoutMs}ms)`));
      }, timeoutMs);
      this.waiters.push({ predicate, resolve, reject, timer });
    });
  }

  waitForType(type: string, timeoutMs = 3000): Promise<Record<string, unknown>> {
    return this.nextMessage((m) => m.type === type, timeoutMs);
  }

  drainQueue(): Record<string, unknown>[] {
    const copy = [...this.queue];
    this.queue = [];
    return copy;
  }

  async close(): Promise<void> {
    if (
      this.ws.readyState === WebSocket.CLOSED ||
      this.ws.readyState === WebSocket.CLOSING
    ) {
      await this.closeEvent;
      return;
    }
    this.ws.close();
    await this.closeEvent;
  }
}

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("Network & Security helpers", () => {
  it("prioritizes physical LAN interfaces over VPN TUN/TAP adapters", () => {
    const mockIfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = {
      "vpn-tap0": [
        {
          address: "10.99.0.2",
          netmask: "255.255.255.0",
          family: "IPv4",
          mac: "00:00:00:00:00:01",
          internal: false,
          cidr: "10.99.0.2/24",
        },
      ],
      "vpn-tun0": [
        {
          address: "172.20.0.1",
          netmask: "255.255.255.252",
          family: "IPv4",
          mac: "00:00:00:00:00:02",
          internal: false,
          cidr: "172.20.0.1/30",
        },
      ],
      Ethernet: [
        {
          address: "192.168.1.100",
          netmask: "255.255.255.0",
          family: "IPv4",
          mac: "aa:bb:cc:dd:ee:ff",
          internal: false,
          cidr: "192.168.1.100/24",
        },
      ],
      Loopback: [
        {
          address: "127.0.0.1",
          netmask: "255.0.0.0",
          family: "IPv4",
          mac: "00:00:00:00:00:00",
          internal: true,
          cidr: "127.0.0.1/8",
        },
      ],
    };

    const ips = getLanIps(mockIfaces);
    assert.deepEqual(ips, ["192.168.1.100"]);
    assert.equal(getTailscaleIp(mockIfaces), null);
  });

  it("detects Tailscale 100.64.0.0/10 IP separately while keeping LAN IP first", () => {
    const mockIfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = {
      Ethernet: [
        {
          address: "192.168.1.100",
          netmask: "255.255.255.0",
          family: "IPv4",
          mac: "aa:bb:cc:dd:ee:ff",
          internal: false,
          cidr: "192.168.1.100/24",
        },
      ],
      Tailscale: [
        {
          address: "100.92.14.8",
          netmask: "255.192.0.0",
          family: "IPv4",
          mac: "00:00:00:00:00:09",
          internal: false,
          cidr: "100.92.14.8/10",
        },
      ],
    };

    assert.deepEqual(getLanIps(mockIfaces), ["192.168.1.100"]);
    assert.equal(getTailscaleIp(mockIfaces), "100.92.14.8");
    assert.equal(isLocalIpAddress("127.0.0.1"), true);
    assert.equal(isLocalIpAddress("::ffff:192.168.1.100"), true);
    // Strict local-only check excludes CGNAT & public IPs
    assert.equal(isLocalIpAddress("100.92.14.8"), false);
    assert.equal(isLocalIpAddress("203.0.113.5"), false);
  });

  it("compares tokens in constant time, generates 192-bit tokens, and validates JPEG magic bytes", () => {
    const tok = generateStrongToken();
    assert.match(tok, /^[A-Za-z0-9_-]{32}$/);
    assert.equal(constantTimeTokenEqual(tok, tok), true);
    assert.equal(constantTimeTokenEqual(tok, tok + "x"), false);
    assert.equal(constantTimeTokenEqual("short", tok), false);
    assert.equal(constantTimeTokenEqual("", ""), false);
    assert.equal(constantTimeTokenEqual(undefined, tok), false);

    assert.equal(isValidJpegBuffer(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), true);
    assert.equal(isValidJpegBuffer(Buffer.from("<html>xss</html>")), false);
    assert.equal(isValidJpegBuffer(Buffer.from([0x89, 0x50, 0x4e, 0x47])), false);

    const limiter = new AuthRateLimiter({ maxFailures: 3, windowMs: 60_000 });
    assert.equal(limiter.isRateLimited("203.0.113.9"), false);
    assert.equal(limiter.recordFailure("203.0.113.9"), false);
    assert.equal(limiter.recordFailure("203.0.113.9"), false);
    assert.equal(limiter.recordFailure("203.0.113.9"), true);
    assert.equal(limiter.isRateLimited("203.0.113.9"), true);
    assert.equal(limiter.isRateLimited("203.0.113.10"), false);
    limiter.reset("203.0.113.9");
    assert.equal(limiter.isRateLimited("203.0.113.9"), false);
  });

  it("matches Protocol v1.2 §8.3 encrypted beacon AES-256-GCM test vector and parses tunnel URLs", () => {
    const token = "purrcam-test-vector-token-v1";
    const topicId = deriveBeaconTopicId(token);
    assert.equal(topicId, "purrcam-a793ba5e2ec528be44b8c7169f47de2d");

    const iv = Buffer.from("AQIDBAUGBwgJCgsM", "base64");
    const plaintext = {
      v: 1 as const,
      url: "https://demo.app.lhr.life",
      wsUrl: "wss://demo.app.lhr.life/ws",
      provider: "localhost.run",
      ts: 1795500000000,
    };
    const env = encryptBeaconPayload(token, plaintext, iv);
    assert.deepEqual(env, {
      v: 1,
      iv: "AQIDBAUGBwgJCgsM",
      ct: "makxxxrVCdpbHF1dzommR5+Bzaej6iOtNkMXQzrV0M8Rgtkosyq7lOK1ENcS18T4qFASC4aWlqgXvNNv/cyS7kehKARzrygL4Fdu/b0HxJ7nj1zD7fNvMU7rPhbiZOX6RgDBFhtvuWTJgYOkeCnxTs0Rr/OVmB2OnsMgzWlESBdP2lBL/l5/Onl7sEk=",
    });

    assert.deepEqual(decryptBeaconPayload(token, JSON.stringify(env)), plaintext);
    // Wrong token or tampered ciphertext rejected
    assert.equal(decryptBeaconPayload("wrong-token", env), null);
    assert.equal(
      decryptBeaconPayload(token, { ...env, ct: "A" + env.ct.slice(1) }),
      null
    );

    // Tunnel output URL parsers (must ignore banner links like https://admin.localhost.run)
    assert.equal(
      parseBackendTunnelUrl(
        "localhost.run",
        "Manage your account at https://admin.localhost.run"
      ),
      null
    );
    assert.equal(
      parseBackendTunnelUrl(
        "localhost.run",
        '{"event":"tcpip-forward","address":"demo123.app.lhr.life","status":"success"}'
      ),
      "https://demo123.app.lhr.life"
    );
    assert.equal(
      parseBackendTunnelUrl(
        "pinggy",
        "\u001b[32mhttps://abc123.a.free.pinggy.link\u001b[0m"
      ),
      "https://abc123.a.free.pinggy.link"
    );
    assert.equal(
      parseBackendTunnelUrl(
        "cloudflare",
        "2026-01-01 INF | https://demo-tunnel.trycloudflare.com |"
      ),
      "https://demo-tunnel.trycloudflare.com"
    );

    // Host header locality checks
    assert.equal(isLocalHostHeader("localhost:8787"), true);
    assert.equal(isLocalHostHeader("127.0.0.1:8787"), true);
    assert.equal(isLocalHostHeader("192.168.1.100:8787"), true);
    assert.equal(isLocalHostHeader("[::1]:8787"), true);
    assert.equal(isLocalHostHeader("demo123.app.lhr.life"), false);
    assert.equal(isLocalHostHeader("abc.free.pinggy.net"), false);
  });

  it("parses ICE_SERVERS from default, JSON, and comma-separated URLs", () => {
    assert.deepEqual(parseIceServers(undefined), [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
      { urls: "stun:stun.cloudflare.com:3478" },
    ]);
    assert.deepEqual(
      parseIceServers("stun:a.example:3478, turn:b.example:3478"),
      [{ urls: "stun:a.example:3478" }, { urls: "turn:b.example:3478" }]
    );
    assert.deepEqual(
      parseIceServers(
        '[{"urls":"turn:turn.example:3478","username":"u","credential":"p"}]'
      ),
      [{ urls: "turn:turn.example:3478", username: "u", credential: "p" }]
    );
  });
});

describe("PurrCam Server end-to-end", () => {
  it("handles camera/viewer registration, WebRTC SDP/ICE isolation, and commands/acks", async () => {
    const tmpDir = await makeTempDir("purrcam-test-signaling-");
    const server = new PurrCamServer({
      port: 0,
      host: "127.0.0.1",
      dataDir: path.join(tmpDir, "data"),
      webDistDir: path.join(tmpDir, "no-web-dist"),
    });

    try {
      const info = await server.start();
      const wsUrl = `ws://127.0.0.1:${info.port}/ws`;
      const baseUrl = `http://127.0.0.1:${info.port}`;

      // 1. Check /api/info before any peers connect
      const infoRes = await fetch(`${baseUrl}/api/info`);
      assert.equal(infoRes.status, 200);
      const infoBody = (await infoRes.json()) as Record<string, unknown>;
      assert.equal(infoBody.name, "PurrCam");
      assert.equal(infoBody.version, "1.1.0");
      assert.equal(infoBody.port, info.port);
      assert.equal(infoBody.cameraOnline, false);
      assert.equal(infoBody.viewerCount, 0);
      assert.equal(infoBody.tokenRequired, false);
      assert.equal(infoBody.turnConfigured, false);
      assert.ok(Array.isArray(infoBody.lanIps));
      assert.deepEqual(infoBody.remote, {
        enabled: false,
        status: "stopped",
        provider: "none",
        activeProvider: "none",
        url: null,
        wsUrl: null,
        error: null,
        beacon: {
          enabled: false,
          lastPublishedAt: null,
          endpoints: [],
        },
      });

      // 2. Fallback status HTML when web/dist isn't built
      const fallbackRes = await fetch(`${baseUrl}/`);
      assert.equal(fallbackRes.status, 200);
      assert.match(fallbackRes.headers.get("content-type") ?? "", /text\/html/);
      const fallbackHtml = await fallbackRes.text();
      assert.match(fallbackHtml, /PurrCam/);

      // 3. Viewer 1 registers while camera is offline
      const viewer1 = await WsTestClient.connect(wsUrl);
      viewer1.send({
        type: "register",
        role: "viewer",
        clientId: "web-viewer-1",
        clientName: "PC Monitor",
        clientType: "web",
      });
      const v1Reg = await viewer1.waitForType("registered");
      assert.equal(v1Reg.id, "web-viewer-1");
      assert.ok(Array.isArray(v1Reg.iceServers));

      const v1StatusOffline = await viewer1.waitForType("camera_status");
      assert.equal(v1StatusOffline.online, false);
      assert.equal(v1StatusOffline.camera, null);
      assert.equal(v1StatusOffline.viewerCount, 1);

      // Command while camera offline returns immediate command_ack(ok: false)
      viewer1.send({
        type: "command",
        commandId: "cmd-offline-1",
        action: "set_torch",
        payload: { enabled: true },
      });
      const offlineAck = await viewer1.waitForType("command_ack");
      assert.equal(offlineAck.commandId, "cmd-offline-1");
      assert.equal(offlineAck.ok, false);
      assert.equal(offlineAck.error, "Camera offline");

      // 4. Camera (Poco F3) connects
      const camera = await WsTestClient.connect(wsUrl);
      camera.send({
        type: "register",
        role: "camera",
        deviceId: "poco-f3-demo",
        deviceName: "Poco F3",
        lenses: [
          {
            id: "ultrawide",
            cameraId: "2",
            physicalCameraId: null,
            label: "0.6× Wide",
            type: "ultrawide",
            facing: "back",
            focalLengthMm: 1.65,
            zoomFactor: 0.6,
            hasFlash: true,
            maxZoom: 4.0,
          },
          {
            id: "wide",
            cameraId: "0",
            physicalCameraId: null,
            label: "1× Main",
            type: "wide",
            facing: "back",
            focalLengthMm: 4.71,
            zoomFactor: 1.0,
            hasFlash: true,
            maxZoom: 10.0,
          },
        ],
        capabilities: {
          torch: true,
          audioIn: true,
          audioOut: true,
          root: true,
          chargeLimit: true,
        },
        state: {
          activeLensId: "wide",
          torch: false,
          blackout: false,
          rootDisplayOff: false,
          resolution: "720p",
          fps: 24,
          bitrateKbps: 1800,
          ev: 0,
          zoomRatio: 1.0,
          micEnabled: true,
          speakerEnabled: true,
          chargeLimitEnabled: false,
          chargeLimitMaxPct: 80,
          streaming: true,
        },
      });

      const camReg = await camera.waitForType("registered");
      assert.equal(camReg.id, "poco-f3-demo");

      // Camera receives viewer_joined for already-connected viewer1
      const camJoined1 = await camera.waitForType("viewer_joined");
      assert.equal(camJoined1.viewerId, "web-viewer-1");
      assert.equal(camJoined1.clientType, "web");

      // Viewer 1 receives camera_status(online: true)
      const v1StatusOnline = await viewer1.waitForType("camera_status");
      assert.equal(v1StatusOnline.online, true);
      assert.equal(
        (v1StatusOnline.camera as Record<string, unknown>).deviceName,
        "Poco F3"
      );

      // 5. Viewer 2 (Android) registers
      const viewer2 = await WsTestClient.connect(wsUrl);
      viewer2.send({
        type: "register",
        role: "viewer",
        clientId: "android-viewer-2",
        clientName: "Main Phone",
        clientType: "android",
      });
      await viewer2.waitForType("registered");
      const v2Status = await viewer2.waitForType("camera_status");
      assert.equal(v2Status.online, true);
      assert.equal(v2Status.viewerCount, 2);

      const camJoined2 = await camera.waitForType("viewer_joined");
      assert.equal(camJoined2.viewerId, "android-viewer-2");
      assert.equal(camJoined2.clientType, "android");

      // 6. WebRTC SDP/ICE routing isolated to exact viewerId
      viewer1.send({ type: "watch_request", viewerId: "spoofed-id" });
      const watchReq = await camera.waitForType("watch_request");
      // Server stamps true viewerId
      assert.equal(watchReq.viewerId, "web-viewer-1");

      camera.send({
        type: "rtc_offer",
        viewerId: "web-viewer-1",
        sdp: "v=0\r\no=camera-offer",
      });
      const v1Offer = await viewer1.waitForType("rtc_offer");
      assert.equal(v1Offer.sdp, "v=0\r\no=camera-offer");
      assert.equal(v1Offer.viewerId, "web-viewer-1");

      viewer1.send({
        type: "rtc_answer",
        viewerId: "web-viewer-1",
        sdp: "v=0\r\no=viewer1-answer",
      });
      const camAnswer = await camera.waitForType("rtc_answer");
      assert.equal(camAnswer.viewerId, "web-viewer-1");
      assert.equal(camAnswer.sdp, "v=0\r\no=viewer1-answer");

      // Bidirectional ICE
      camera.send({
        type: "rtc_ice",
        viewerId: "web-viewer-1",
        candidate: { candidate: "cand-cam", sdpMid: "0", sdpMLineIndex: 0 },
      });
      const v1Ice = await viewer1.waitForType("rtc_ice");
      assert.deepEqual(v1Ice.candidate, {
        candidate: "cand-cam",
        sdpMid: "0",
        sdpMLineIndex: 0,
      });

      viewer1.send({
        type: "rtc_ice",
        candidate: { candidate: "cand-v1", sdpMid: "0", sdpMLineIndex: 0 },
      });
      const camIce = await camera.waitForType("rtc_ice");
      assert.equal(camIce.viewerId, "web-viewer-1");
      assert.deepEqual(camIce.candidate, {
        candidate: "cand-v1",
        sdpMid: "0",
        sdpMLineIndex: 0,
      });

      // Verify viewer2 never received viewer1's offer or ICE
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(viewer2.drainQueue().length, 0);

      // 7. Command -> camera -> command_ack -> originating viewer + state_update to ALL viewers
      viewer1.send({
        type: "command",
        commandId: "cmd-lens-1",
        action: "switch_lens",
        payload: { lensId: "ultrawide" },
      });
      const camCmd = await camera.waitForType("command");
      assert.equal(camCmd.commandId, "cmd-lens-1");
      assert.equal(camCmd.action, "switch_lens");
      assert.deepEqual(camCmd.payload, { lensId: "ultrawide" });

      camera.send({
        type: "command_ack",
        commandId: "cmd-lens-1",
        ok: true,
        state: { activeLensId: "ultrawide", torch: false },
      });

      const v1Ack = await viewer1.waitForType("command_ack");
      assert.equal(v1Ack.commandId, "cmd-lens-1");
      assert.equal(v1Ack.ok, true);
      assert.equal(v1Ack.error, null);

      const v1State = await viewer1.waitForType("state_update");
      assert.equal(
        (v1State.state as Record<string, unknown>).activeLensId,
        "ultrawide"
      );
      const v2State = await viewer2.waitForType("state_update");
      assert.equal(
        (v2State.state as Record<string, unknown>).activeLensId,
        "ultrawide"
      );

      // 8. Standalone state_update with lenses updates camera_status cache
      viewer1.drainQueue();
      camera.send({
        type: "state_update",
        state: { blackout: true, rootDisplayOff: true },
        lenses: [
          {
            id: "ultrawide",
            cameraId: "2",
            physicalCameraId: null,
            label: "0.6× Ширик",
            type: "ultrawide",
            facing: "back",
            focalLengthMm: 1.65,
            zoomFactor: 0.6,
            hasFlash: true,
            maxZoom: 4.0,
          },
        ],
      });
      const stUpd = await viewer1.waitForType("state_update");
      assert.equal((stUpd.state as Record<string, unknown>).blackout, true);
      assert.equal((stUpd.lenses as unknown[]).length, 1);
      const stStatus = await viewer1.waitForType("camera_status");
      assert.equal(stStatus.online, true);
      assert.equal(
        ((stStatus.camera as Record<string, unknown>).lenses as unknown[]).length,
        1
      );

      // 9. Camera replacement cleanly closes old socket (4000) without offline flicker
      viewer1.drainQueue();
      const camera2 = await WsTestClient.connect(wsUrl);
      camera2.send({
        type: "register",
        role: "camera",
        deviceId: "poco-f3-demo",
        deviceName: "Poco F3 Reconnected",
      });
      await camera2.waitForType("registered");
      const oldCamClose = await camera.closeEvent;
      assert.equal(oldCamClose.code, 4000);
      const replacedStatus = await viewer1.waitForType("camera_status");
      assert.equal(replacedStatus.online, true);
      assert.equal(
        (replacedStatus.camera as Record<string, unknown>).deviceName,
        "Poco F3 Reconnected"
      );

      // 10. Watch stop + viewer disconnect -> viewer_left
      viewer1.send({ type: "watch_stop" });
      const stopMsg = await camera2.waitForType("watch_stop");
      assert.equal(stopMsg.viewerId, "web-viewer-1");

      await viewer2.close();
      const leftMsg = await camera2.waitForType("viewer_left");
      assert.equal(leftMsg.viewerId, "android-viewer-2");

      // 11. Camera disconnect -> viewer gets camera_status(online: false)
      viewer1.drainQueue();
      await camera2.close();
      const offlineAfterClose = await viewer1.waitForType("camera_status");
      assert.equal(offlineAfterClose.online, false);
      assert.equal(offlineAfterClose.camera, null);

      await viewer1.close();
    } finally {
      await server.stop();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("stores telemetry in ring buffer, broadcasts live, and persists across restarts", async () => {
    const tmpDir = await makeTempDir("purrcam-test-telemetry-");
    const dataDir = path.join(tmpDir, "data");

    const server1 = new PurrCamServer({
      port: 0,
      host: "127.0.0.1",
      dataDir,
      maxTelemetrySamples: 3,
    });

    try {
      const info = await server1.start();
      const wsUrl = `ws://127.0.0.1:${info.port}/ws`;
      const baseUrl = `http://127.0.0.1:${info.port}`;

      const camera = await WsTestClient.connect(wsUrl);
      const viewer = await WsTestClient.connect(wsUrl);

      camera.send({
        type: "register",
        role: "camera",
        deviceId: "poco-f3",
        deviceName: "Poco F3",
      });
      await camera.waitForType("registered");

      viewer.send({
        type: "register",
        role: "viewer",
        clientId: "v-tele",
        clientName: "PC",
        clientType: "web",
      });
      await viewer.waitForType("registered");
      await viewer.waitForType("camera_status");

      // Send 4 samples into ring buffer of size 3
      for (let i = 1; i <= 4; i++) {
        camera.send({
          type: "telemetry",
          data: {
            ts: 1000 * i,
            batteryPct: 70 + i,
            batteryTempC: 30 + i * 0.5,
            cpuTempC: 38 + i,
            charging: true,
            chargeSource: "usb",
            chargePaused: false,
            voltageMv: 4100,
            currentMa: 500,
            wifiRssi: -52,
            uptimeSec: 10 * i,
            freeRamMb: 3800,
            freeStorageMb: 64000,
            activeLensId: "ultrawide",
          },
        });
        const live = await viewer.waitForType("telemetry");
        assert.equal((live.data as Record<string, unknown>).batteryPct, 70 + i);
      }

      // Check history limit=2 returns samples 3 and 4 in chronological order
      const histRes = await fetch(`${baseUrl}/api/telemetry/history?limit=2`);
      assert.equal(histRes.status, 200);
      const histBody = (await histRes.json()) as {
        items: Array<{ batteryPct: number; ts: number }>;
      };
      assert.equal(histBody.items.length, 2);
      assert.equal(histBody.items[0].batteryPct, 73);
      assert.equal(histBody.items[1].batteryPct, 74);

      await camera.close();
      await viewer.close();
    } finally {
      await server1.stop();
    }

    // Restart server on same dataDir -> ring buffer persisted (samples 2, 3, 4)
    const server2 = new PurrCamServer({
      port: 0,
      host: "127.0.0.1",
      dataDir,
      maxTelemetrySamples: 3,
    });
    try {
      const info2 = await server2.start();
      const res = await fetch(
        `http://127.0.0.1:${info2.port}/api/telemetry/history?limit=10`
      );
      const body = (await res.json()) as {
        items: Array<{ batteryPct: number }>;
      };
      assert.deepEqual(
        body.items.map((x) => x.batteryPct),
        [72, 73, 74]
      );
    } finally {
      await server2.stop();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("uploads snapshots (raw JPEG & JSON base64), broadcasts, blocks path traversal, and deletes", async () => {
    const tmpDir = await makeTempDir("purrcam-test-snaps-");
    const server = new PurrCamServer({
      port: 0,
      host: "127.0.0.1",
      dataDir: path.join(tmpDir, "data"),
    });

    try {
      const info = await server.start();
      const baseUrl = `http://127.0.0.1:${info.port}`;
      const wsUrl = `ws://127.0.0.1:${info.port}/ws`;

      const viewer = await WsTestClient.connect(wsUrl);
      viewer.send({
        type: "register",
        role: "viewer",
        clientId: "snap-viewer",
        clientName: "PC",
        clientType: "web",
      });
      await viewer.waitForType("registered");
      await viewer.waitForType("camera_status");

      // 1. Raw image/jpeg upload with UTF-8 URL-encoded X-Lens-Label
      const jpegBytes1 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);
      const upload1 = await fetch(`${baseUrl}/api/snapshots`, {
        method: "POST",
        headers: {
          "Content-Type": "image/jpeg",
          "X-Lens-Label": encodeURIComponent("0.6× Ширик"),
        },
        body: jpegBytes1,
      });
      assert.equal(upload1.status, 201);
      const meta1 = (await upload1.json()) as {
        id: string;
        filename: string;
        url: string;
        sizeBytes: number;
        lensLabel: string | null;
      };
      assert.equal(meta1.sizeBytes, jpegBytes1.length);
      assert.equal(meta1.lensLabel, "0.6× Ширик");
      assert.equal(meta1.url, `/snapshots/${meta1.filename}`);

      const wsSnap1 = await viewer.waitForType("snapshot_saved");
      assert.equal((wsSnap1.snapshot as { id: string }).id, meta1.id);

      // Small delay so createdAt ordering is strictly deterministic
      await new Promise((r) => setTimeout(r, 15));

      // 2. JSON base64 upload with data URI prefix
      const jpegBytes2 = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x01, 0x02, 0x03, 0xff, 0xd9]);
      const upload2 = await fetch(`${baseUrl}/api/snapshots`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          imageBase64: `data:image/jpeg;base64,${jpegBytes2.toString("base64")}`,
          lensLabel: "1× Осн.",
        }),
      });
      assert.equal(upload2.status, 201);
      const meta2 = (await upload2.json()) as {
        id: string;
        filename: string;
        url: string;
        lensLabel: string | null;
      };
      assert.equal(meta2.lensLabel, "1× Осн.");

      const wsSnap2 = await viewer.waitForType("snapshot_saved");
      assert.equal((wsSnap2.snapshot as { id: string }).id, meta2.id);

      // 3. List snapshots -> newest first
      const listRes = await fetch(`${baseUrl}/api/snapshots`);
      assert.equal(listRes.status, 200);
      const listBody = (await listRes.json()) as { items: Array<{ id: string }> };
      assert.deepEqual(
        listBody.items.map((i) => i.id),
        [meta2.id, meta1.id]
      );

      // 4. Fetch snapshot bytes + verify sandbox CSP & nosniff security headers
      const imgRes = await fetch(`${baseUrl}${meta1.url}`);
      assert.equal(imgRes.status, 200);
      assert.equal(imgRes.headers.get("content-type"), "image/jpeg");
      assert.equal(
        imgRes.headers.get("content-security-policy"),
        "default-src 'none'; sandbox"
      );
      assert.equal(imgRes.headers.get("x-content-type-options"), "nosniff");
      assert.equal(imgRes.headers.get("referrer-policy"), "no-referrer");
      assert.equal(imgRes.headers.get("x-frame-options"), "DENY");
      const fetchedBytes = Buffer.from(await imgRes.arrayBuffer());
      assert.deepEqual(fetchedBytes, jpegBytes1);

      // 4b. Non-JPEG payloads (raw & JSON base64) are rejected with 400
      const fakeRaw = await fetch(`${baseUrl}/api/snapshots`, {
        method: "POST",
        headers: { "Content-Type": "image/jpeg" },
        body: Buffer.from("<script>alert(1)</script>"),
      });
      assert.equal(fakeRaw.status, 400);
      const fakeJson = await fetch(`${baseUrl}/api/snapshots`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          imageBase64: Buffer.from("not-a-jpeg-image").toString("base64"),
        }),
      });
      assert.equal(fakeJson.status, 400);

      // 5. Path traversal protection
      const trav1 = await fetch(`${baseUrl}/snapshots/..%2Fsnapshots.json`);
      assert.equal(trav1.status, 400);
      const trav2 = await fetch(`${baseUrl}/snapshots/..%5Ctelemetry.json`);
      assert.equal(trav2.status, 400);
      const trav3 = await fetch(`${baseUrl}/snapshots/not-an-image.txt`);
      assert.equal(trav3.status, 400);

      // 6. Delete snapshot
      const delRes = await fetch(`${baseUrl}/api/snapshots/${meta1.id}`, {
        method: "DELETE",
      });
      assert.equal(delRes.status, 200);
      const delBody = (await delRes.json()) as { deleted: boolean; id: string };
      assert.deepEqual(delBody, { deleted: true, id: meta1.id });

      // File and metadata gone
      const afterDelImg = await fetch(`${baseUrl}${meta1.url}`);
      assert.equal(afterDelImg.status, 404);
      const delAgain = await fetch(`${baseUrl}/api/snapshots/${meta1.id}`, {
        method: "DELETE",
      });
      assert.equal(delAgain.status, 404);

      await viewer.close();
    } finally {
      await server.stop();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("enforces PURRCAM_TOKEN auth, serves SPA dist files, and supports ping/pong + dead peer pruning", async () => {
    const tmpDir = await makeTempDir("purrcam-test-auth-");
    const webDist = path.join(tmpDir, "web-dist");
    await fs.mkdir(path.join(webDist, "assets"), { recursive: true });
    await fs.writeFile(
      path.join(webDist, "index.html"),
      "<!doctype html><div id='root'>PurrCam Web</div>",
      "utf8"
    );
    await fs.writeFile(
      path.join(webDist, "assets", "app.js"),
      "console.log('purrcam');",
      "utf8"
    );

    const server = new PurrCamServer({
      port: 0,
      host: "127.0.0.1",
      token: "meow-secret",
      dataDir: path.join(tmpDir, "data"),
      webDistDir: webDist,
      heartbeatIntervalMs: 60,
      heartbeatMaxMissed: 3,
      enableBeacon: false,
    });

    try {
      const info = await server.start();
      const baseUrl = `http://127.0.0.1:${info.port}`;
      const wsUrl = `ws://127.0.0.1:${info.port}/ws`;

      // Static SPA & assets
      const idxRes = await fetch(`${baseUrl}/`);
      assert.equal(idxRes.status, 200);
      assert.match(await idxRes.text(), /PurrCam Web/);

      const spaRoute = await fetch(`${baseUrl}/snapshots-view/123`);
      assert.equal(spaRoute.status, 200);
      assert.match(await spaRoute.text(), /PurrCam Web/);

      const assetRes = await fetch(`${baseUrl}/assets/app.js`);
      assert.equal(assetRes.status, 200);
      assert.match(assetRes.headers.get("content-type") ?? "", /javascript/);

      // /api/info is public & reports tokenRequired: true
      const infoRes = await fetch(`${baseUrl}/api/info`);
      assert.equal(infoRes.status, 200);
      assert.equal(((await infoRes.json()) as { tokenRequired: boolean }).tokenRequired, true);

      // Protected REST fails without token, succeeds with Bearer or X-PurrCam-Token or ?token=
      assert.equal((await fetch(`${baseUrl}/api/snapshots`)).status, 401);
      assert.equal(
        (
          await fetch(`${baseUrl}/api/snapshots`, {
            headers: { Authorization: "Bearer meow-secret" },
          })
        ).status,
        200
      );
      assert.equal(
        (
          await fetch(`${baseUrl}/api/snapshots`, {
            headers: { "X-PurrCam-Token": "meow-secret" },
          })
        ).status,
        200
      );
      assert.equal(
        (await fetch(`${baseUrl}/api/snapshots?token=meow-secret`)).status,
        200
      );

      // WS auth failure -> error UNAUTHORIZED + close 4001
      const badClient = await WsTestClient.connect(wsUrl);
      badClient.send({
        type: "register",
        role: "viewer",
        clientId: "intruder",
        token: "wrong",
      });
      const errMsg = await badClient.waitForType("error");
      assert.equal(errMsg.code, "UNAUTHORIZED");
      const closeInfo = await badClient.closeEvent;
      assert.equal(closeInfo.code, 4001);

      // WS valid token via URL query must not be overridden by empty register.token ("")
      const urlTokenViewer = await WsTestClient.connect(
        `${wsUrl}?token=meow-secret`
      );
      urlTokenViewer.send({
        type: "register",
        role: "viewer",
        clientId: "url-token-viewer",
        token: "",
      });
      const urlReg = await urlTokenViewer.waitForType("registered");
      assert.equal(urlReg.id, "url-token-viewer");
      await urlTokenViewer.waitForType("camera_status");
      await urlTokenViewer.close();

      // WS valid token + app-level ping/pong
      const viewer = await WsTestClient.connect(wsUrl);
      viewer.send({
        type: "register",
        role: "viewer",
        clientId: "authed-viewer",
        token: "meow-secret",
      });
      await viewer.waitForType("registered");
      await viewer.waitForType("camera_status");

      viewer.send({ type: "ping", ts: 123456 });
      const pong = await viewer.waitForType("pong");
      assert.equal(pong.ts, 123456);

      // Heartbeat 3-tick grace & dead-peer pruning:
      // Unresponsive camera survives 2 missed ticks and is pruned cleanly on the 3rd+ tick
      const deadCamWs = new WebSocket(`${wsUrl}?token=meow-secret`, {
        autoPong: false,
      });
      await new Promise<void>((resolve, reject) => {
        deadCamWs.once("open", () => resolve());
        deadCamWs.once("error", reject);
      });
      let deadClosedFlag = false;
      const deadCamClosed = new Promise<void>((resolve) => {
        deadCamWs.once("close", () => {
          deadClosedFlag = true;
          resolve();
        });
      });
      deadCamWs.send(
        JSON.stringify({
          type: "register",
          role: "camera",
          deviceId: "ghost-cam",
          deviceName: "Ghost Cam",
        })
      );
      const onlineMsg = await viewer.waitForType("camera_status");
      assert.equal(onlineMsg.online, true);

      // Should still be alive after ~1.5 ticks (survives brief jitter!)
      await new Promise((r) => setTimeout(r, 95));
      assert.equal(deadClosedFlag, false);

      // Eventually pruned cleanly after 3 missed ticks
      await deadCamClosed;
      const prunedOffline = await viewer.waitForType("camera_status");
      assert.equal(prunedOffline.online, false);

      await viewer.close();
    } finally {
      await server.stop();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("persists remote config + TURN credentials, broadcasts remote_status, and enforces external auth", async () => {
    const tmpDir = await makeTempDir("purrcam-test-remote-");
    const dataDir = path.join(tmpDir, "data");

    const server1 = new PurrCamServer({
      port: 0,
      host: "127.0.0.1",
      dataDir,
      webDistDir: path.join(tmpDir, "no-web"),
      enableBeacon: false,
    });

    let generatedToken = "";

    try {
      const info = await server1.start();
      const baseUrl = `http://127.0.0.1:${info.port}`;
      const wsUrl = `ws://127.0.0.1:${info.port}/ws`;

      // Connect local viewer to verify remote_status WS broadcasts
      const viewer = await WsTestClient.connect(wsUrl);
      viewer.send({
        type: "register",
        role: "viewer",
        clientId: "local-admin-viewer",
        clientName: "PC Monitor",
        clientType: "web",
      });
      await viewer.waitForType("registered");
      await viewer.waitForType("camera_status");

      // 1. Start custom remote URL -> auto-generates 32-char (192-bit) URL-safe token & broadcasts remote_status
      const startRes = await fetch(`${baseUrl}/api/remote/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "custom",
          customUrl: "https://cam.example.com/",
        }),
      });
      assert.equal(startRes.status, 200);
      // Admin endpoints must NOT send wildcard CORS Access-Control-Allow-Origin: *
      assert.equal(startRes.headers.get("access-control-allow-origin"), null);
      assert.equal(startRes.headers.get("access-control-allow-credentials"), null);
      assert.equal(startRes.headers.get("referrer-policy"), "no-referrer");
      assert.equal(startRes.headers.get("x-frame-options"), "DENY");
      assert.equal(startRes.headers.get("x-content-type-options"), "nosniff");

      const startBody = (await startRes.json()) as {
        remote: {
          enabled: boolean;
          status: string;
          provider: string;
          url: string | null;
          wsUrl: string | null;
          error: string | null;
        };
        token: string;
        pairingLink: string;
      };
      assert.equal(startBody.remote.enabled, true);
      assert.equal(startBody.remote.status, "running");
      assert.equal(startBody.remote.provider, "custom");
      assert.equal(startBody.remote.url, "https://cam.example.com");
      assert.equal(startBody.remote.wsUrl, "wss://cam.example.com/ws");
      assert.match(startBody.token, /^[A-Za-z0-9_-]{32}$/);
      generatedToken = startBody.token;

      assert.ok(startBody.pairingLink.startsWith("purrcam://connect?"));
      const parsedPair = new URL(startBody.pairingLink);
      assert.equal(
        parsedPair.searchParams.get("remote"),
        "wss://cam.example.com/ws"
      );
      assert.equal(parsedPair.searchParams.get("token"), generatedToken);

      const wsRemoteRunning = await viewer.waitForType("remote_status");
      assert.equal(
        (wsRemoteRunning.remote as Record<string, unknown>).status,
        "running"
      );

      // 2. Update TURN iceServers via PUT /api/remote/config
      const turnIceServers = [
        { urls: "stun:stun.l.google.com:19302" },
        {
          urls: "turn:relay.example.com:3478?transport=tcp",
          username: "cat-user",
          credential: "super-secret-turn-pass",
        },
      ];
      const putRes = await fetch(`${baseUrl}/api/remote/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          iceServers: turnIceServers,
          autoStartTunnel: false,
        }),
      });
      assert.equal(putRes.status, 200);
      assert.equal(putRes.headers.get("access-control-allow-origin"), null);
      const putBody = (await putRes.json()) as {
        iceServers: typeof turnIceServers;
        token: string;
        pairingLink: string;
      };
      assert.deepEqual(putBody.iceServers, turnIceServers);
      assert.equal(putBody.token, generatedToken);

      // 3. Public /api/info exposes turnConfigured & remote, NEVER leaks token or TURN credential
      const publicInfoRes = await fetch(`${baseUrl}/api/info`, {
        headers: { "cf-connecting-ip": "203.0.113.42" },
      });
      assert.equal(publicInfoRes.status, 200);
      assert.equal(publicInfoRes.headers.get("referrer-policy"), "no-referrer");
      const publicInfoText = await publicInfoRes.text();
      assert.ok(!publicInfoText.includes(generatedToken));
      assert.ok(!publicInfoText.includes("super-secret-turn-pass"));
      const publicInfo = JSON.parse(publicInfoText) as Record<string, unknown>;
      assert.equal(publicInfo.turnConfigured, true);
      assert.equal(publicInfo.tokenRequired, true);
      assert.equal(
        (publicInfo.remote as Record<string, unknown>).url,
        "https://cam.example.com"
      );

      // 4. External viewer data requests WITHOUT token are rejected (401)
      const extHeaders = { "cf-connecting-ip": "203.0.113.42" };
      assert.equal(
        (await fetch(`${baseUrl}/api/snapshots`, { headers: extHeaders }))
          .status,
        401
      );
      assert.equal(
        (
          await fetch(`${baseUrl}/api/telemetry/history`, {
            headers: extHeaders,
          })
        ).status,
        401
      );

      // 4b. External admin requests ALWAYS return 403 Forbidden — EVEN WITH valid viewer token!
      const extAuthedHeaders = {
        ...extHeaders,
        Authorization: `Bearer ${generatedToken}`,
      };
      assert.equal(
        (await fetch(`${baseUrl}/api/remote/config`, { headers: extAuthedHeaders }))
          .status,
        403
      );
      assert.equal(
        (
          await fetch(`${baseUrl}/api/remote/config`, {
            method: "PUT",
            headers: {
              "cf-ray": "12345-DFW",
              Authorization: `Bearer ${generatedToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ autoStartTunnel: true }),
          })
        ).status,
        403
      );
      assert.equal(
        (
          await fetch(`${baseUrl}/api/remote/start`, {
            method: "POST",
            headers: {
              forwarded: "for=203.0.113.42",
              Authorization: `Bearer ${generatedToken}`,
            },
          })
        ).status,
        403
      );
      assert.equal(
        (
          await fetch(`${baseUrl}/api/remote/stop`, {
            method: "POST",
            headers: {
              "x-real-ip": "203.0.113.42",
              Authorization: `Bearer ${generatedToken}`,
            },
          })
        ).status,
        403
      );
      assert.equal(
        (
          await fetch(`${baseUrl}/api/system/logs`, {
            headers: {
              "x-forwarded-for": "198.51.100.7",
              Authorization: `Bearer ${generatedToken}`,
            },
          })
        ).status,
        403
      );
      assert.equal(
        (
          await fetch(`${baseUrl}/api/system/adb-reverse`, {
            method: "POST",
            headers: extAuthedHeaders,
          })
        ).status,
        403
      );

      // 4c. Non-Cloudflare proxy headers (x-forwarded-host, via) & non-local Host header (e.g. localhost.run / Pinggy)
      //     MUST ALSO be blocked with 403 on admin endpoints even with valid Bearer token!
      assert.equal(
        (
          await fetch(`${baseUrl}/api/remote/config`, {
            headers: {
              "x-forwarded-host": "demo123.app.lhr.life",
              Authorization: `Bearer ${generatedToken}`,
            },
          })
        ).status,
        403
      );
      assert.equal(
        (
          await fetch(`${baseUrl}/api/system/adb-reverse`, {
            method: "POST",
            headers: {
              via: "1.1 pinggy",
              Authorization: `Bearer ${generatedToken}`,
            },
          })
        ).status,
        403
      );
      // Direct raw HTTP request with non-local Host header and NO proxy headers
      const rawHostStatus = await new Promise<number>((resolve, reject) => {
        const req = http.request(
          {
            hostname: "127.0.0.1",
            port: info.port,
            path: "/api/remote/config",
            method: "GET",
            headers: {
              Host: "demo123.app.lhr.life",
              Authorization: `Bearer ${generatedToken}`,
            },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          }
        );
        req.on("error", reject);
        req.end();
      });
      assert.equal(rawHostStatus, 403);

      // External viewer data requests WITH valid token succeed (200)
      assert.equal(
        (
          await fetch(`${baseUrl}/api/snapshots`, {
            headers: extAuthedHeaders,
          })
        ).status,
        200
      );

      // Local loopback still works seamlessly without passing the auto-generated remote token
      assert.equal((await fetch(`${baseUrl}/api/snapshots`)).status, 200);
      assert.equal((await fetch(`${baseUrl}/api/remote/config`)).status, 200);

      const logsRes = await fetch(`${baseUrl}/api/system/logs?limit=20`);
      assert.equal(logsRes.status, 200);
      assert.equal(logsRes.headers.get("access-control-allow-origin"), null);
      const logsBody = (await logsRes.json()) as { lines: string[] };
      assert.ok(Array.isArray(logsBody.lines));
      assert.ok(logsBody.lines.length >= 1);

      const adbRes = await fetch(`${baseUrl}/api/system/adb-reverse`, {
        method: "POST",
      });
      assert.equal(adbRes.status, 200);
      const adbBody = (await adbRes.json()) as { ok: boolean; output: string };
      assert.equal(typeof adbBody.ok, "boolean");
      assert.equal(typeof adbBody.output, "string");

      // 5. External WS without token closes 4001; with valid token receives TURN iceServers
      const extBadWs = await new Promise<WebSocket>((resolve, reject) => {
        const ws = new WebSocket(wsUrl, {
          headers: { "cf-connecting-ip": "203.0.113.42" },
        });
        ws.once("open", () => resolve(ws));
        ws.once("error", reject);
      });
      const extBadErr = new Promise<Record<string, unknown>>((resolve) => {
        extBadWs.once("message", (raw) =>
          resolve(JSON.parse(raw.toString("utf8")) as Record<string, unknown>)
        );
      });
      const extBadClose = new Promise<number>((resolve) => {
        extBadWs.once("close", (code) => resolve(code));
      });
      extBadWs.send(
        JSON.stringify({
          type: "register",
          role: "viewer",
          clientId: "ext-unauth",
        })
      );
      assert.equal((await extBadErr).code, "UNAUTHORIZED");
      assert.equal(await extBadClose, 4001);

      const extGoodWs = await new Promise<WebSocket>((resolve, reject) => {
        const ws = new WebSocket(`${wsUrl}?token=${generatedToken}`, {
          headers: { "x-forwarded-for": "203.0.113.42" },
        });
        ws.once("open", () => resolve(ws));
        ws.once("error", reject);
      });
      const extGoodReg = new Promise<Record<string, unknown>>((resolve) => {
        extGoodWs.once("message", (raw) =>
          resolve(JSON.parse(raw.toString("utf8")) as Record<string, unknown>)
        );
      });
      extGoodWs.send(
        JSON.stringify({
          type: "register",
          role: "viewer",
          clientId: "ext-4g-phone",
          clientType: "android",
          token: "",
        })
      );
      const regMsg = await extGoodReg;
      assert.equal(regMsg.type, "registered");
      assert.equal(regMsg.id, "ext-4g-phone");
      assert.deepEqual(regMsg.iceServers, turnIceServers);
      extGoodWs.close();

      // 6. Stop remote -> broadcasts remote_status(stopped)
      const stopRes = await fetch(`${baseUrl}/api/remote/stop`, {
        method: "POST",
      });
      assert.equal(stopRes.status, 200);
      const stopBody = (await stopRes.json()) as {
        remote: { enabled: boolean; status: string; provider: string };
      };
      assert.equal(stopBody.remote.enabled, false);
      assert.equal(stopBody.remote.status, "stopped");
      assert.equal(stopBody.remote.provider, "none");

      const wsRemoteStopped = await viewer.waitForType("remote_status");
      assert.equal(
        (wsRemoteStopped.remote as Record<string, unknown>).status,
        "stopped"
      );

      await viewer.close();
    } finally {
      await server1.stop();
    }

    // 7. Restart on same dataDir -> config.json persists token, customRemoteUrl, and TURN iceServers
    const server2 = new PurrCamServer({
      port: 0,
      host: "127.0.0.1",
      dataDir,
    });
    try {
      const info2 = await server2.start();
      const cfgRes = await fetch(
        `http://127.0.0.1:${info2.port}/api/remote/config`
      );
      assert.equal(cfgRes.status, 200);
      const cfgBody = (await cfgRes.json()) as {
        token: string;
        customRemoteUrl: string | null;
        iceServers: Array<{
          urls: string;
          username?: string;
          credential?: string;
        }>;
      };
      assert.equal(cfgBody.token, generatedToken);
      assert.equal(cfgBody.customRemoteUrl, "https://cam.example.com");
      assert.equal(cfgBody.iceServers.length, 2);
      assert.equal(cfgBody.iceServers[1].username, "cat-user");
      assert.equal(cfgBody.iceServers[1].credential, "super-secret-turn-pass");
    } finally {
      await server2.stop();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("rate-limits repeated failed auth attempts on HTTP (429) and WebSocket (4029)", async () => {
    const tmpDir = await makeTempDir("purrcam-test-ratelimit-");
    const server = new PurrCamServer({
      port: 0,
      host: "127.0.0.1",
      token: "real-secret-token",
      dataDir: path.join(tmpDir, "data"),
      authRateLimitMaxFailures: 3,
      authRateLimitWindowMs: 60_000,
    });

    try {
      const info = await server.start();
      const baseUrl = `http://127.0.0.1:${info.port}`;
      const wsUrl = `ws://127.0.0.1:${info.port}/ws`;
      const attackerHeaders = { "cf-connecting-ip": "198.51.100.55" };

      // 2 failed attempts -> 401; 3rd failed attempt -> 429 Too Many Requests
      assert.equal(
        (await fetch(`${baseUrl}/api/snapshots`, { headers: attackerHeaders }))
          .status,
        401
      );
      assert.equal(
        (await fetch(`${baseUrl}/api/snapshots`, { headers: attackerHeaders }))
          .status,
        401
      );
      const third = await fetch(`${baseUrl}/api/snapshots`, {
        headers: attackerHeaders,
      });
      assert.equal(third.status, 429);
      assert.ok(Number(third.headers.get("retry-after")) >= 1);

      // Subsequent WebSocket from same rate-limited IP closes with 4029 RATE_LIMITED
      const limitedWs = await new Promise<WebSocket>((resolve, reject) => {
        const ws = new WebSocket(wsUrl, { headers: attackerHeaders });
        ws.once("open", () => resolve(ws));
        ws.once("error", reject);
      });
      const errMsgPromise = new Promise<Record<string, unknown>>((resolve) => {
        limitedWs.once("message", (raw) =>
          resolve(JSON.parse(raw.toString("utf8")) as Record<string, unknown>)
        );
      });
      const closeCodePromise = new Promise<number>((resolve) => {
        limitedWs.once("close", (code) => resolve(code));
      });
      limitedWs.send(
        JSON.stringify({
          type: "register",
          role: "viewer",
          clientId: "blocked-ip",
          token: "real-secret-token",
        })
      );
      assert.equal((await errMsgPromise).code, "RATE_LIMITED");
      assert.equal(await closeCodePromise, 4029);

      // Different IP is unaffected and succeeds with valid token
      const cleanRes = await fetch(`${baseUrl}/api/snapshots`, {
        headers: {
          "cf-connecting-ip": "198.51.100.99",
          Authorization: "Bearer real-secret-token",
        },
      });
      assert.equal(cleanRes.status, 200);
    } finally {
      await server.stop();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("routes ws_relay stream_mode and video_frame exclusively to relay viewers and resets on disconnect", async () => {
    const tmpDir = await makeTempDir("purrcam-test-wsrelay-");
    const server = new PurrCamServer({
      port: 0,
      host: "127.0.0.1",
      dataDir: path.join(tmpDir, "data"),
      enableBeacon: false,
    });

    try {
      const info = await server.start();
      const wsUrl = `ws://127.0.0.1:${info.port}/ws`;

      const camera = await WsTestClient.connect(wsUrl);
      camera.send({
        type: "register",
        role: "camera",
        deviceId: "relay-cam",
        deviceName: "Relay Cam",
      });
      await camera.waitForType("registered");

      const rtcViewer = await WsTestClient.connect(wsUrl);
      rtcViewer.send({
        type: "register",
        role: "viewer",
        clientId: "viewer-webrtc",
        clientName: "WebRTC Client",
        clientType: "web",
      });
      await rtcViewer.waitForType("registered");
      await rtcViewer.waitForType("camera_status");
      await camera.waitForType("viewer_joined");

      const relayViewer = await WsTestClient.connect(wsUrl);
      relayViewer.send({
        type: "register",
        role: "viewer",
        clientId: "viewer-relay",
        clientName: "4G Relay Client",
        clientType: "android",
      });
      await relayViewer.waitForType("registered");
      await relayViewer.waitForType("camera_status");
      await camera.waitForType("viewer_joined");

      // Switch viewer-relay into ws_relay mode
      relayViewer.send({
        type: "stream_mode",
        mode: "ws_relay",
        fps: 10,
        quality: 70,
      });
      const camModeOn = await camera.waitForType("stream_mode");
      assert.equal(camModeOn.viewerId, "viewer-relay");
      assert.equal(camModeOn.mode, "ws_relay");
      assert.equal(camModeOn.fps, 10);
      assert.equal(camModeOn.quality, 70);

      // Camera publishes video_frame -> ONLY relayViewer receives it
      camera.send({
        type: "video_frame",
        ts: 1795500001000,
        width: 720,
        height: 1280,
        lensLabel: "0.6× Wide",
        mime: "image/jpeg",
        data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64"),
      });
      const frame = await relayViewer.waitForType("video_frame");
      assert.equal(frame.width, 720);
      assert.equal(frame.height, 1280);
      assert.equal(frame.lensLabel, "0.6× Wide");
      assert.equal(frame.mime, "image/jpeg");

      // rtcViewer must NOT receive relayed frames
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(rtcViewer.drainQueue().length, 0);

      // When relayViewer disconnects, camera receives stream_mode("webrtc") + viewer_left
      await relayViewer.close();
      const camModeOff = await camera.waitForType("stream_mode");
      assert.equal(camModeOff.viewerId, "viewer-relay");
      assert.equal(camModeOff.mode, "webrtc");
      const camLeft = await camera.waitForType("viewer_left");
      assert.equal(camLeft.viewerId, "viewer-relay");

      await rtcViewer.close();
      await camera.close();
    } finally {
      await server.stop();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
