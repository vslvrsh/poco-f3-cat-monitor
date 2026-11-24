import { PurrCamServer } from "./app.js";
import { SERVER_VERSION } from "./http.js";

async function main(): Promise<void> {
  const server = new PurrCamServer();
  const info = await server.start();

  const tokenActive = server.configStore.getEffectiveToken().length > 0;
  const turnActive = server.configStore.isTurnConfigured();
  const remoteAuto =
    server.config.autoStartRemote ||
    server.configStore.getConfig().autoStartTunnel;

  console.log("");
  console.log("  ================================================");
  console.log(`   PurrCam PC Hub Server (v${SERVER_VERSION})`);
  console.log("  ================================================");
  console.log(`   Local UI  : http://localhost:${info.port}`);
  if (info.lanIps.length > 0) {
    for (const ip of info.lanIps) {
      console.log(`   LAN UI    : http://${ip}:${info.port}`);
    }
  }
  if (info.tailscaleIp) {
    console.log(`   Tailscale : http://${info.tailscaleIp}:${info.port}`);
  }
  console.log(`   WS URL    : ${info.wsUrl}`);
  console.log(
    `   USB ADB   : ws://127.0.0.1:${info.port}/ws  (adb reverse tcp:${info.port} tcp:${info.port})`
  );
  console.log(
    `   Auth      : ${server.configStore.hasStrictGlobalToken() ? "STRICT (PURRCAM_TOKEN)" : tokenActive ? "REMOTE TOKEN ACTIVE" : "local open (token auto-generated on remote start)"}`
  );
  console.log(`   TURN      : ${turnActive ? "configured" : "STUN only"}`);
  console.log(
    `   Remote    : ${remoteAuto ? "starting Auto Remote Tunnel (No VPN)..." : "stopped (start via Connect tab or POST /api/remote/start)"}`
  );
  console.log(`   Data Dir  : ${server.config.dataDir}`);
  console.log(`   Web Dist  : ${server.config.webDistDir}`);
  console.log("  ================================================");
  console.log("");

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[purrcam] Received ${signal}, shutting down cleanly...`);
    try {
      await server.stop();
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[purrcam] Fatal startup error:", err);
  process.exit(1);
});
