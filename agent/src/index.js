// Backup agent entry point.

import { loadConfig } from "./config.js";
import { startWatcher } from "./watcher.js";
import { log } from "./logger.js";

function formatSize(bytes) {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

let config;
try {
  config = loadConfig();
} catch (err) {
  log.error(err.message);
  process.exit(1);
}

log.info(`Backup agent starting on device "${config.deviceName}"`);

const watcher = startWatcher(config.watchDir, (event) => {
  const size = event.size != null ? ` (${formatSize(event.size)})` : "";
  log.info(`${event.type.padEnd(14)} ${event.relativePath}${size}`);
});

// Shut down cleanly on Ctrl+C or when the system stops the service
async function shutdown(signal) {
  log.info(`Received ${signal}, shutting down...`);
  await watcher.close();
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));