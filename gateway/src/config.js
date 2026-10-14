// Loads the gateway's settings from environment variables (.env file).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function portSetting(name, fallback) {
  const port = Number(process.env[name] || fallback);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} must be a number between 1 and 65535 (got "${process.env[name]}")`);
  }
  return port;
}

function publicUrlSetting() {
  const value = process.env.GATEWAY_PUBLIC_URL?.trim().replace(/\/+$/, "");
  if (!value) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`GATEWAY_PUBLIC_URL is not a valid address: ${value}`);
  }
  if (!["http:", "https:"].includes(url.protocol) || /[\s"'`$\\;]/.test(value)) {
    throw new Error(`GATEWAY_PUBLIC_URL must look like http://192.168.1.10:8080 (got ${value})`);
  }
  return value;
}

export function loadConfig() {
  const dataDir = path.resolve(process.env.GATEWAY_DATA_DIR?.trim() || "./data");
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });

  const config = {
    // Agent API, what devices connect to. Default: every network address of this computer, so devices
    // on its networks can reach it with nothing set up, plus Caddy or a Cloudflare Tunnel on this
    // computer for devices elsewhere. Every request is signed by an enrolled device (auth.js); only
    // enrollment and the one-time install links work without that.
    host: process.env.GATEWAY_HOST?.trim() || "0.0.0.0",
    port: portSetting("GATEWAY_PORT", 8080),

    // Admin web UI + API — for you only. Keep it on 127.0.0.1 or a management VLAN, never the internet.
    adminHost: process.env.GATEWAY_ADMIN_HOST?.trim() || "127.0.0.1",
    adminPort: portSetting("GATEWAY_ADMIN_PORT", 8090),

    // Normally empty: devices are given this computer's own addresses, and the domain from the
    // Domain & SSL page once it works (address.js). Set it to force one address for every install.
    publicUrl: publicUrlSetting(),

    // The agent's folder (code + installers), packed for one-line installs. Default: ../agent
    agentDir: path.resolve(
      process.env.GATEWAY_AGENT_DIR?.trim() || path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "agent")
    ),

    // The Windows setup program offered for download when a Windows device is added. A built copy
    // comes with the gateway (setup-exe/); "npm run build-windows-setup" rebuilds it from setup.c.
    windowsSetupPath: path.resolve(
      process.env.GATEWAY_WINDOWS_SETUP?.trim() ||
        path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "setup-exe", "BackupAgentSetup.exe")
    ),

    dataDir,
    codeTtlMinutes: Number(process.env.GATEWAY_CODE_TTL_MINUTES || 60),

    // Quarantine engine: freeze a device when this many suspicious files (or deletions)
    // arrive within the window. While frozen, every change from it is quarantined.
    freezeWindowMinutes: Number(process.env.GATEWAY_FREEZE_WINDOW_MINUTES || 10),
    freezeSuspiciousFiles: Number(process.env.GATEWAY_FREEZE_SUSPICIOUS_FILES || 5),
    freezeDeletedFiles: Number(process.env.GATEWAY_FREEZE_DELETED_FILES || 100),
  };

  if (config.adminPort === config.port) {
    throw new Error("GATEWAY_ADMIN_PORT must be different from GATEWAY_PORT.");
  }
  return config;
}