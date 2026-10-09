// Loads the gateway's settings from environment variables (.env file).

import fs from "node:fs";
import path from "node:path";

export function loadConfig() {
  const dataDir = path.resolve(process.env.GATEWAY_DATA_DIR?.trim() || "./data");
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });

  const port = Number(process.env.GATEWAY_PORT || 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`GATEWAY_PORT must be a number between 1 and 65535 (got "${process.env.GATEWAY_PORT}")`);
  }

  return {
    host: process.env.GATEWAY_HOST?.trim() || "127.0.0.1",
    port,
    dataDir,
    codeTtlMinutes: Number(process.env.GATEWAY_CODE_TTL_MINUTES || 60),
  };
}