// Loads the gateway's settings from environment variables (.env file).

import fs from "node:fs";
import path from "node:path";

function portSetting(name, fallback) {
  const port = Number(process.env[name] || fallback);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} must be a number between 1 and 65535 (got "${process.env[name]}")`);
  }
  return port;
}

export function loadConfig() {
  const dataDir = path.resolve(process.env.GATEWAY_DATA_DIR?.trim() || "./data");
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });

  const config = {
    // Agent API — the only part that will ever be reachable from client sites (through the relay)
    host: process.env.GATEWAY_HOST?.trim() || "127.0.0.1",
    port: portSetting("GATEWAY_PORT", 8080),

    // Admin web UI + API — for you only. Keep it on 127.0.0.1 or a management VLAN, never the internet.
    adminHost: process.env.GATEWAY_ADMIN_HOST?.trim() || "127.0.0.1",
    adminPort: portSetting("GATEWAY_ADMIN_PORT", 8090),

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