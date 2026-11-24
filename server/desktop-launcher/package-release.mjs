import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SERVER_DIR = path.resolve(__dirname, "..");
const PROJECT_ROOT = path.resolve(SERVER_DIR, "..");
const WEB_DIST_DIR = path.join(PROJECT_ROOT, "web", "dist");
const RELEASE_DIR = path.join(PROJECT_ROOT, "release-artifacts");
const OUTPUT_ZIP = path.join(RELEASE_DIR, "PurrCam-Windows-v1.1.0.zip");

function getHostLeakTokens() {
  const tokens = new Set();
  try {
    const user = os.userInfo().username;
    if (user && user.length >= 3) tokens.add(user.toLowerCase());
  } catch {
    // ignore
  }
  const homeBase = path.basename(os.homedir());
  if (homeBase && homeBase.length >= 3) tokens.add(homeBase.toLowerCase());
  const firstWord = homeBase.split(/[\s'"`]+/)[0];
  if (firstWord && firstWord.length >= 4) tokens.add(firstWord.toLowerCase());
  tokens.add(SERVER_DIR.toLowerCase());

  const ifaces = os.networkInterfaces();
  for (const addrs of Object.values(ifaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      const isV4 = addr.family === "IPv4" || addr.family === 4;
      if (isV4 && !addr.internal && !addr.address.startsWith("169.254.")) {
        tokens.add(addr.address);
      }
    }
  }
  return [...tokens];
}

async function copyDirFiltered(src, dest, filterFn = () => true) {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (!filterFn(entry.name, entry.isDirectory())) continue;
    if (entry.isDirectory()) {
      await copyDirFiltered(srcPath, destPath, filterFn);
    } else if (entry.isFile()) {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

async function scanDirectoryForLeaks(dir, tokens = getHostLeakTokens()) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await scanDirectoryForLeaks(full, tokens);
    } else if (entry.isFile()) {
      const raw = await fs.readFile(full);
      const latin1 = raw.toString("latin1").toLowerCase();
      const utf16 = raw.toString("utf16le").toLowerCase();
      for (const token of tokens) {
        if (latin1.includes(token) || utf16.includes(token)) {
          throw new Error(
            `Privacy scan FAILED on staged release file ${full} (matched host token)`
          );
        }
      }
    }
  }
}

const WINDOWS_README_TXT = `PurrCam for Windows — Quick Start (v1.1.0)
==========================================

Requirements:
  - Windows 10 / 11 (64-bit) with built-in OpenSSH (ssh.exe)
  - Node.js 20+ (LTS): https://nodejs.org
  - Microsoft Edge or Google Chrome (for the standalone desktop window)

Quick Start:
  1. Extract this entire ZIP archive to a folder (for example C:\\PurrCam).
     Keep PurrCam.exe in the same folder as the "server" and "web" folders.
  2. Double-click PurrCam.exe.
     - Starts the local signaling & telemetry hub on port 8787 (no console window).
     - Keeps your PC awake while PurrCam is running (toggleable in Control Center).
     - Opens the Material 3 Expressive Live Monitor desktop app automatically.
  3. Install PurrCam-Android-v1.1.0.apk on your spare Android phone (Camera Mode)
     and your main Android phone (Monitor Mode).
  4. On Camera Mode, enter your PC's Local URL shown in PurrCam Control Center
     (for example http://192.168.1.100:8787) or connect via USB using
     "Connect Poco F3 via USB (ADB Reverse)".

Always-On, VPN-Free, Zero-Account Remote Access (4G / 5G):
  1. Open the Connect tab in the desktop app (or PurrCam Control Center) and
     click "Start Remote Tunnel".
  2. PurrCam automatically starts a zero-signup VPN-free HTTPS/WSS tunnel
     (Auto failover: localhost.run -> Pinggy :443 -> Cloudflare HTTP/2) with
     an active 30s health watchdog, generates a 192-bit access token, and
     publishes an end-to-end AES-256-GCM encrypted Auto-Sync Beacon.
  3. Scan the QR code or tap "Copy Phone Pairing Link (purrcam://)" once.
     Even if the free tunnel URL rotates later, your phone automatically
     discovers the new URL via the encrypted beacon and switches to HTTPS
     Video Relay seamlessly whenever 4G/5G CGNAT blocks WebRTC UDP!

Security Notes:
  - All external / tunneled connections require the 192-bit access token.
  - Admin endpoints (remote tunnel config, ADB reverse, PC server logs) are
    strictly restricted to local LAN/loopback only (HTTP 403 over any tunnel).
  - Server data (config, snapshots, telemetry history) is stored locally in
    server\\data\\.

More documentation & source code:
  https://github.com/vslvrsh/poco-f3-cat-monitor
`;

async function main() {
  // 1. Verify pre-built server/dist and web/dist exist
  await fs.stat(path.join(SERVER_DIR, "dist", "index.js"));
  await fs.stat(path.join(WEB_DIST_DIR, "index.html"));
  await fs.stat(path.join(SERVER_DIR, "node_modules", "ws", "package.json"));

  const stageRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "purrcam-win-release-")
  );
  const stageExe = path.join(stageRoot, "PurrCam.exe");
  const stageServer = path.join(stageRoot, "server");
  const stageWebDist = path.join(stageRoot, "web", "dist");

  try {
    // 2. Compile portable zero-PII PurrCam.exe directly into staging folder
    console.log("[package:win] Compiling portable zero-PII PurrCam.exe...");
    await execFileAsync(process.execPath, [
      path.join(__dirname, "build-exe.mjs"),
      "--portable",
      `--out=${stageExe}`,
    ]);

    // 3. Copy server/dist (.js files only — skip .map and .d.ts)
    await copyDirFiltered(
      path.join(SERVER_DIR, "dist"),
      path.join(stageServer, "dist"),
      (name, isDir) => isDir || name.endsWith(".js")
    );

    // 4. Copy server/package.json and runtime prod dep (ws) ONLY
    await fs.copyFile(
      path.join(SERVER_DIR, "package.json"),
      path.join(stageServer, "package.json")
    );
    await copyDirFiltered(
      path.join(SERVER_DIR, "node_modules", "ws"),
      path.join(stageServer, "node_modules", "ws")
    );

    // 5. Copy Windows helper CMD launchers
    for (const script of [
      "start-server.cmd",
      "start-remote.cmd",
      "adb-reverse.cmd",
    ]) {
      await fs.copyFile(
        path.join(SERVER_DIR, script),
        path.join(stageServer, script)
      );
    }

    // 6. Copy pre-built M3 Expressive web/dist
    await copyDirFiltered(WEB_DIST_DIR, stageWebDist);

    // 7. Write concise Windows README.txt
    await fs.writeFile(
      path.join(stageRoot, "README.txt"),
      WINDOWS_README_TXT,
      "utf8"
    );

    // 8. Full zero-PII binary & text audit across every staged file
    console.log("[package:win] Running zero-PII privacy audit across staged bundle...");
    await scanDirectoryForLeaks(stageRoot);
    console.log("[package:win] Zero-PII privacy audit PASSED (0 leaks).");

    // 9. Compress into release-artifacts/PurrCam-Windows-v1.0.0.zip
    await fs.mkdir(RELEASE_DIR, { recursive: true });
    await fs.unlink(OUTPUT_ZIP).catch(() => {});

    console.log(`[package:win] Creating ${OUTPUT_ZIP}...`);
    await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-Command",
      `Compress-Archive -Path "${path.join(stageRoot, "*")}" -DestinationPath "${OUTPUT_ZIP}" -CompressionLevel Optimal -Force`,
    ]);

    const zipStat = await fs.stat(OUTPUT_ZIP);
    console.log(
      `[package:win] Release bundle ready: ${OUTPUT_ZIP} (${Math.round(zipStat.size / 1024)} KB)`
    );
  } finally {
    await fs.rm(stageRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("[package:win] Failed:", err);
  process.exit(1);
});
