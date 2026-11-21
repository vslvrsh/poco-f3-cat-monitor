import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class ServerLogBuffer {
  readonly maxLines: number;
  private readonly lines: string[] = [];

  constructor(maxLines = 500) {
    this.maxLines = Math.max(20, maxLines);
  }

  append(message: string): void {
    if (!message || !message.trim()) return;
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
    const ss = String(now.getSeconds()).padStart(2, "0");
    const stamp = `[${hh}:${mm}:${ss}]`;

    for (const rawLine of message.split(/\r?\n/)) {
      const trimmed = rawLine.trim();
      if (!trimmed) continue;
      const formatted = /^\[\d{2}:\d{2}:\d{2}\]/.test(trimmed)
        ? trimmed
        : `${stamp} ${trimmed}`;
      this.lines.push(formatted);
    }

    if (this.lines.length > this.maxLines) {
      this.lines.splice(0, this.lines.length - this.maxLines);
    }
  }

  getLines(limit = 120): string[] {
    const clamped = Math.max(1, Math.min(this.maxLines, Math.floor(limit) || 120));
    return this.lines.slice(-clamped);
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p);
    return st.isFile();
  } catch {
    return false;
  }
}

export async function findAdbBinary(): Promise<string | null> {
  const envSdk =
    process.env.ANDROID_HOME?.trim() || process.env.ANDROID_SDK_ROOT?.trim();
  const candidates: string[] = [];

  if (envSdk) {
    candidates.push(
      path.join(
        envSdk,
        "platform-tools",
        process.platform === "win32" ? "adb.exe" : "adb"
      )
    );
  }

  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    candidates.push(
      path.join(
        process.env.LOCALAPPDATA,
        "Android",
        "Sdk",
        "platform-tools",
        "adb.exe"
      )
    );
  }

  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      return candidate;
    }
  }

  try {
    const cmd = process.platform === "win32" ? "where.exe" : "which";
    const { stdout } = await execFileAsync(cmd, ["adb"], { timeout: 3000 });
    const first = stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    if (first && (await fileExists(first))) {
      return first;
    }
  } catch {
    // ignore
  }

  return null;
}

const SAFE_ADB_SERIAL_RE = /^[A-Za-z0-9._:-]+$/;

export async function runAdbReverse(
  port: number,
  logBuffer?: ServerLogBuffer
): Promise<{ ok: boolean; output: string }> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    const msg = "Invalid port number for adb reverse.";
    logBuffer?.append(`[ADB] ${msg}`);
    return { ok: false, output: msg };
  }

  const adb = await findAdbBinary();
  if (!adb) {
    const msg =
      "adb executable not found in PATH or Android SDK platform-tools.";
    logBuffer?.append(`[ADB] ${msg}`);
    return { ok: false, output: msg };
  }

  try {
    const { stdout: devicesOut } = await execFileAsync(adb, ["devices"], {
      timeout: 4000,
    });
    const serials: string[] = [];
    for (const line of devicesOut.split(/\r?\n/)) {
      const match = /^(\S+)\s+device\s*$/.exec(line.trim());
      if (match && SAFE_ADB_SERIAL_RE.test(match[1])) {
        serials.push(match[1]);
      }
    }

    if (serials.length === 0) {
      const msg = "No authorized Android devices connected via ADB.";
      logBuffer?.append(`[ADB] ${msg}`);
      return { ok: false, output: msg };
    }

    const succeeded: string[] = [];
    const errors: string[] = [];

    for (const serial of serials) {
      try {
        await execFileAsync(
          adb,
          ["-s", serial, "reverse", `tcp:${port}`, `tcp:${port}`],
          { timeout: 5000 }
        );
        succeeded.push(serial);
      } catch (err) {
        const msg =
          err instanceof Error
            ? ((err as { stderr?: string }).stderr || err.message).trim()
            : String(err);
        errors.push(`${serial}: ${msg}`);
      }
    }

    if (succeeded.length > 0) {
      const output = `USB tunnel active on ${succeeded.join(", ")}: adb reverse tcp:${port} tcp:${port} -> ws://127.0.0.1:${port}/ws`;
      logBuffer?.append(`[ADB] ${output}`);
      return { ok: true, output };
    }

    const failMsg = errors.join("; ") || "adb reverse command failed";
    logBuffer?.append(`[ADB] Error: ${failMsg}`);
    return { ok: false, output: failMsg };
  } catch (err) {
    const rawMsg =
      err instanceof Error
        ? ((err as { stderr?: string; stdout?: string }).stderr ||
            (err as { stdout?: string }).stdout ||
            err.message)
        : String(err);
    const clean = String(rawMsg).trim() || "adb reverse command failed";
    logBuffer?.append(`[ADB] Error: ${clean}`);
    return { ok: false, output: clean };
  }
}
