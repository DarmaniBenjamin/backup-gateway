// Backup agent entry point.

import { loadConfig } from "./config.js";
import { openDatabase } from "./db.js";
import { createTracker } from "./tracker.js";
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
const db = openDatabase(config.dataDir);

const tracker = createTracker(config.watchDir, db, (change) => {
  const size = change.size != null ? ` (${formatSize(change.size)})` : "";
  const hash = change.sha256 ? `  sha256:${change.sha256.slice(0, 12)}…` : "";
  log.info(`${change.type.padEnd(8)} ${change.relPath}${size}${hash}`);
});

// Process one path at a time, in order, so checks never overlap
let queue = Promise.resolve();
function enqueue(task) {
  queue = queue.then(task).catch((err) => log.error("Error while checking changes", err));
  return queue;
}

// 1) Start watching first so nothing is missed during the scan
const watcher = startWatcher(config.watchDir, (absPath) => enqueue(() => tracker.inspect(absPath)));

// 2) Full scan: compare everything on disk with the database
enqueue(async () => {
  log.info("Scanning for changes made while the agent was off...");
  const started = Date.now();
  await tracker.fullScan();
  log.info(
    `Scan done in ${((Date.now() - started) / 1000).toFixed(1)}s — ` +
      `${db.countFiles()} files tracked, ${db.countPending()} changes waiting to send`
  );
});

// Shut down cleanly on Ctrl+C or when the system stops the service
async function shutdown(signal) {
  log.info(`Received ${signal}, shutting down...`);
  await watcher.close();
  await queue;
  db.close();
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));