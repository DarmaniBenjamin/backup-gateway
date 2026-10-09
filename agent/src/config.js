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

  return {
    watchDir,
    deviceName: process.env.AGENT_DEVICE_NAME?.trim() || os.hostname(),
  };
}