// Backup gateway entry point.

import { loadConfig } from "./config.js";
import { openDatabase } from "./db.js";
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
const server = createServer(db);

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