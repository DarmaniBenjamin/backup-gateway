// Backup gateway entry point. Starts two separate servers:
//   1. Agent API  (GATEWAY_PORT, default 8080)       — agents connect here
//   2. Admin UI   (GATEWAY_ADMIN_PORT, default 8090) — you log in here; keep it private

import { loadConfig } from "./config.js";
import { openDatabase } from "./db.js";
import { loadOrCreateGatewayKeys } from "./keys.js";
import { createStorage } from "./storage.js";
import { createServer } from "./server.js";
import { createGuard } from "./guard.js";
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

const guard = createGuard({ db, config });
const server = createServer({ db, keys, storage, guard });
const adminServer = createAdminServer({ db, store, keys, storage, config });

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
});
adminServer.listen(config.adminPort, config.adminHost, () => {
  log.info(`Admin UI listening on http://${config.adminHost}:${config.adminPort}`);
  if (store.countAdmins() === 0) {
    log.warn('No admin account yet. Create one with: npm run create-admin -- YOUR_USERNAME');
  }
});

function shutdown(signal) {
  log.info(`Received ${signal}, shutting down...`);
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