// Loads and checks the agent's settings from environment variables (.env file).

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { log } from "./logger.js";

function required(name) {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Missing setting ${name}. Copy .env.example to .env and fill it in.`);
  }
  return value.trim();
}

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function loadConfig() {
  // The first folder to back up. Only used the very first time; after that, folders are
  // managed from the web UI. Optional: a device can start with no folders.
  const watchDirSetting = process.env.AGENT_WATCH_DIR?.trim();
  const watchDir = watchDirSetting ? path.resolve(watchDirSetting) : null;
  // (stat, not existsSync: existsSync ignores the read-anything right the Linux service runs with)
  if (watchDir && !fs.statSync(watchDir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`AGENT_WATCH_DIR is not an existing folder: ${watchDir}`);
  }

  // Allowed areas: the ONLY places the gateway may back up or browse on this device.
  // Set here, on the device itself, so even a compromised gateway can't reach anything else.
  // Several paths are separated with ";". Default: the watch folder, or the user's home folder.
  const allowedSetting = process.env.AGENT_ALLOWED_PATHS?.trim();
  const allowedRaw = allowedSetting
    ? allowedSetting.split(";").map((p) => p.trim()).filter(Boolean)
    : [watchDir ?? os.homedir()];
  const allowedPaths = [];
  for (const p of allowedRaw) {
    const resolved = path.resolve(p);
    try {
      allowedPaths.push(fs.realpathSync(resolved));
    } catch {
      log.warn(`Allowed area does not exist and is skipped: ${resolved}`);
    }
  }
  if (allowedPaths.length === 0) {
    throw new Error("None of the folders in AGENT_ALLOWED_PATHS exist. Set at least one existing folder.");
  }
  if (watchDir && !allowedPaths.some((a) => isInside(fs.realpathSync(watchDir), a))) {
    throw new Error("AGENT_WATCH_DIR must be inside one of the AGENT_ALLOWED_PATHS.");
  }

  // Where the agent keeps its own database and keys. Never backed up itself.
  const dataDir = path.resolve(process.env.AGENT_DATA_DIR?.trim() || "./data");
  if (watchDir && isInside(dataDir, watchDir)) {
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
    allowedPaths,
    dataDir: fs.realpathSync(dataDir),
    gatewayUrl,
    enrollCode: process.env.AGENT_ENROLL_CODE?.trim() || null,
    deviceName: process.env.AGENT_DEVICE_NAME?.trim() || os.hostname(),
  };
}
