// Backup agent entry point.

import fs from "node:fs";
import { loadConfig } from "./config.js";
import { openDatabase } from "./db.js";
import { createTracker } from "./tracker.js";
import { startWatcher } from "./watcher.js";
import { connectToGateway } from "./connection.js";
import { createUploader } from "./uploader.js";
import { createRestorer } from "./restorer.js";
import { createFolderManager } from "./folders.js";
import { createPolicy } from "./policy.js";
import { createSnapshots } from "./snapshot.js";
import { createLock } from "./lock.js";
import { createDsmExport } from "./dsm-export.js";
import { createUpdater } from "./updater.js";
import { log } from "./logger.js";

const { version } = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));

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

log.info(`Backup agent v${version} starting on device "${config.deviceName}"`);
const db = openDatabase(config.dataDir);

// Windows: files locked by the program using them are read from a shadow copy of the drive
const snapshots = createSnapshots({ dataDir: config.dataDir });
await snapshots.cleanupLeftovers().catch((err) => log.warn(`Shadow copy cleanup: ${err.message}`));

let uploader = null;

const tracker = createTracker(db, (change) => {
  const size = change.size != null ? ` (${formatSize(change.size)})` : "";
  const hash = change.sha256 ? `  sha256:${change.sha256.slice(0, 12)}…` : "";
  log.info(`${change.type.padEnd(8)} ${change.relPath}${size}${hash}`);
  uploader?.trigger();
}, {
  snapshots,
  skipPaths: [config.dataDir, ...(process.env.AGENT_LOG_FILE?.trim() ? [process.env.AGENT_LOG_FILE.trim()] : [])],
  systemPaths: process.platform === "linux" ? ["/proc", "/sys", "/dev", "/run", "/tmp", "/var/tmp", "/lost+found"] : [],
});

// Process one path at a time, in order, so checks never overlap
let queue = Promise.resolve();
function enqueue(task) {
  queue = queue.then(task).catch((err) => log.error("Error while checking changes", err));
  return queue;
}

// 1) Watch the backup folders, and scan each one fully (catches changes made while the agent
//    was off). The folders saved locally are used, so this works even without the gateway.
const policy = createPolicy({ onChange: () => uploader?.trigger() });
const watcher = startWatcher(
  tracker.isExcluded,
  (absPath) => enqueue(() => tracker.inspect(absPath)),
  () => folders.watchLimitReached()
);
// Once chosen, the backup folders can be locked on this device with a key (see lock.js)
const lock = createLock({ db, current: () => db.listFolders() });
const folders = createFolderManager({ config, db, tracker, watcher, enqueue, policy, lock });
log.info(
  config.fullAccess
    ? `Full access: the whole device can be browsed and backed up (${config.allowedPaths.join(", ")})`
    : `Allowed areas on this device: ${config.allowedPaths.join(", ")}`
);
await folders.init();

// Synology: export the DSM settings once a day, so they can be backed up too
const dsmExport = createDsmExport();
dsmExport.start();

// Self-update: newer agents offered by the gateway are installed by the updater (see updater.js)
const updater = createUpdater({ dataDir: config.dataDir, version });
enqueue(() => {
  log.info(`${db.countFiles()} files tracked, ${db.countPending()} changes waiting to send`);
  uploader?.trigger();
});

// 2) Connect to the gateway (enroll the first time, then heartbeats)
let connection = null;
try {
  connection = await connectToGateway(config, () => ({
    agentVersion: version,
    filesTracked: db.countFiles(),
    pendingChanges: db.countPending(),
    folders: folders.report(),
    background: { ...policy.status(), ...folders.scanStatus(), lock: lock.status(), fullAccess: config.fullAccess, dsmExport: dsmExport.status(), update: updater.status() },
  }));
} catch (err) {
  log.error(err.message);
  log.error("Fix the problem above and restart the agent. Backups are still being tracked locally.");
}

// 3) Get the folder list from the gateway, then start sending changes and carrying out jobs.
//    Sending waits for the first folder sync, so the gateway always knows the folders first.
if (connection) {
  folders.attach(connection);
  connection.onFoldersVersion((v) => folders.checkVersion(v));
  connection.onBrowse((request) => folders.answerBrowse(request));
  connection.onUpdate((offer, ctx) => updater.handle(offer, ctx));
  connection.onOnline(() => updater.alive()); // a waiting updater knows this version came up fine
  folders.whenSynced(() => {
    uploader = createUploader({ db, tracker, connection, policy, snapshots });
    uploader.trigger();
  });
  await folders.sync();

  const restorer = createRestorer({ db, connection, tracker });
  connection.onCommand((command) => restorer.handle(command));
  connection.heartbeatNow(); // check for waiting jobs right away instead of in 30 seconds
  connection.startLiveLink();
}

// Shut down cleanly on Ctrl+C or when the system stops the service
async function shutdown(signal) {
  log.info(`Received ${signal}, shutting down...`);
  uploader?.stop();
  policy.stop();
  connection?.stop();
  await watcher.close();
  await queue;
  await snapshots.closeAll().catch(() => {});
  db.close();
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));