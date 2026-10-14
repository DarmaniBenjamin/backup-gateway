// Backup gateway entry point. Starts two separate servers:
//   1. Agent API  (GATEWAY_PORT, default 8080)       — agents connect here
//   2. Admin UI   (GATEWAY_ADMIN_PORT, default 8090) — you log in here; keep it private

import fs from "node:fs";
import { loadConfig } from "./config.js";
import { openDatabase } from "./db.js";
import { loadOrCreateGatewayKeys, loadOrCreateUpdateKey } from "./keys.js";
import { createUpdates } from "./updates.js";
import { createStorage } from "./storage.js";
import { createServer } from "./server.js";
import { createGuard } from "./guard.js";
import { createBroker } from "./broker.js";
import { buildAgentPackage } from "./agent-package.js";
import { createInstalls } from "./installs.js";
import { createCopies } from "./cloud/copies.js";
import { createScanner } from "./scanner.js";
import { createSecurity } from "./security.js";
import { createNotify } from "./notify/notify.js";
import { createHealth } from "./health.js";
import { createRemovals } from "./removals.js";
import { createAddress } from "./address.js";
import { openAdminStore } from "./admin/admin-store.js";
import { createAdminServer } from "./admin/admin-server.js";
import { log } from "./logger.js";

let config;
try {
  config = loadConfig();
} catch (err) {
  log.error(err.message);
  process.exit(1);
}

const db = openDatabase(config.dataDir);
const keys = loadOrCreateGatewayKeys(config.dataDir);
const storage = createStorage(config.dataDir);
const store = openAdminStore(config.dataDir);

// Antivirus (ClamAV) and the security record behind the Security page
const scanner = createScanner();
const security = createSecurity({ db, dataDir: config.dataDir, keys, storage, scanner });
const guard = createGuard({ db, config, security });
const broker = createBroker();
let agentPackage = null;
try {
  agentPackage = buildAgentPackage(config.agentDir);
} catch (err) {
  log.warn(`Could not pack the agent for one-line installs: ${err.message}`);
}
if (!agentPackage) log.warn(`Agent folder not found at ${config.agentDir}: one-line installs are off (set GATEWAY_AGENT_DIR)`);
const windowsSetup = fs.existsSync(config.windowsSetupPath) ? fs.readFileSync(config.windowsSetupPath) : null;
if (!windowsSetup) log.warn(`Windows setup program not found at ${config.windowsSetupPath}: Windows devices get the command only`);
const updateKey = loadOrCreateUpdateKey(config.dataDir);
const installs = createInstalls({ config, store, agentPackage, windowsSetup, updateKey });
// Automatic agent updates: devices on an older agent are offered this gateway's version
const updates = createUpdates({ db, dataDir: config.dataDir, agentPackage, updateKey, security });
// Uninstalling agents from the web UI (signed with the same update key)
const removals = createRemovals({ db, dataDir: config.dataDir, updateKey, updates, security, broker, store });
// The gateway's address on the internet and its certificate (Domain & SSL page: Caddy or a Cloudflare Tunnel)
const address = createAddress({ dataDir: config.dataDir, config, security });
// The web UI is also reached through the agent port: by IP until the domain works, then only by
// https://<domain> (see server.js). adminServer is made below; this is only called later.
const webUi = (req, res, ip) => adminServer.handle(req, res, ip);
const server = createServer({ db, keys, storage, guard, broker, installs, security, scanner, updates, agentPackage, removals, address, webUi });
// Off-site copies: the failsafe (everything) and each device's own (see cloud/copies.js)
const copies = createCopies({ db, dataDir: config.dataDir, storage, security });
// Alerts by phone push, email or webhook, and the checks for devices offline and disk space
const notify = createNotify({ db, dataDir: config.dataDir, security });
const health = createHealth({ db, dataDir: config.dataDir, security, settings: notify.settings, skipDevice: removals.inProgress });
const adminServer = createAdminServer({ db, store, keys, storage, config, broker, installs, copies, security, scanner, updates, notify, health, removals, address });
copies.start();
notify.start();
security.start({ pendingCleared: () => copies.syncNow() });
health.start();
address.start();
const removalTimer = setInterval(() => removals.tick(), 30_000);
removalTimer.unref();
// Removed devices deleted for good N days after they were removed, if that's on (Devices page)
removals.start({ copies, dataDir: config.dataDir });
setTimeout(() => removals.autoDeleteTick(), 60_000).unref();
setInterval(() => removals.autoDeleteTick(), 60 * 60_000).unref();

function onListenError(name, port) {
  return (err) => {
    if (err.code === "EADDRINUSE") {
      log.error(`${name} port ${port} is already in use — is another gateway already running?`);
    } else {
      log.error(`${name} server error`, err);
    }
    process.exit(1);
  };
}
server.on("error", onListenError("Agent API", config.port));
adminServer.on("error", onListenError("Admin UI", config.adminPort));

server.listen(config.port, config.host, () => {
  log.info(`Agent API listening on http://${config.host}:${config.port}`);
  log.info(`${db.listDevices().length} device(s) enrolled`);
  if (agentPackage) log.info(`Agent ${agentPackage.version} ready for one-line installs`);
});
adminServer.listen(config.adminPort, config.adminHost, () => {
  log.info(`Admin UI listening on http://${config.adminHost}:${config.adminPort}`);
  if (store.countAdmins() === 0) {
    log.warn('No admin account yet. Create one with: npm run create-admin -- YOUR_USERNAME');
  }
});

function shutdown(signal) {
  log.info(`Received ${signal}, shutting down...`);
  copies.stop();
  security.stop();
  notify.stop();
  health.stop();
  clearInterval(removalTimer);
  adminServer.close();
  server.close(() => {
    db.close();
    store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));