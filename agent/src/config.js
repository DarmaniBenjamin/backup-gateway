// Loads and checks the agent's settings from environment variables (.env file).

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

function required(name) {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Missing setting ${name}. Copy .env.example to .env and fill it in.`);
  }
  return value.trim();
}

export function loadConfig() {
  const watchDir = path.resolve(required("AGENT_WATCH_DIR"));

  if (!fs.existsSync(watchDir)) {
    throw new Error(`Watch folder does not exist: ${watchDir}`);
  }
  if (!fs.statSync(watchDir).isDirectory()) {
    throw new Error(`Watch path is not a folder: ${watchDir}`);
  }

  // Where the agent keeps its own database. Must NOT be inside the watched folder.
  const dataDir = path.resolve(process.env.AGENT_DATA_DIR?.trim() || "./data");
  const relative = path.relative(watchDir, dataDir);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    throw new Error("AGENT_DATA_DIR must not be inside AGENT_WATCH_DIR.");
  }
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });

  const gatewayUrl = required("AGENT_GATEWAY_URL").replace(/\/+$/, "");
  try {
    new URL(gatewayUrl);
  } catch {
    throw new Error(`AGENT_GATEWAY_URL is not a valid URL: ${gatewayUrl}`);
  }

  return {
    watchDir,
    dataDir,
    gatewayUrl,
    enrollCode: process.env.AGENT_ENROLL_CODE?.trim() || null,
    deviceName: process.env.AGENT_DEVICE_NAME?.trim() || os.hostname(),
  };
}