// Backup gateway entry point.

import { loadConfig } from "./config.js";
import { openDatabase } from "./db.js";
import { loadOrCreateGatewayKeys } from "./keys.js";
import { createStorage } from "./storage.js";
import { createServer } from "./server.js";
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
const server = createServer({ db, keys, storage });

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    log.error(`Port ${config.port} is already in use — is another gateway already running?`);
  } else {
    log.error("Server error", err);
  }
  process.exit(1);
});

server.listen(config.port, config.host, () => {
  log.info(`Gateway listening on http://${config.host}:${config.port}`);
  log.info(`${db.listDevices().length} device(s) enrolled`);
});

function shutdown(signal) {
  log.info(`Received ${signal}, shutting down...`);
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));