// Prints the one-time setup link for the web UI by IP, before the gateway has its domain
// (see ../setup-key.js). Usage: sudo npm run setup-link

import { loadConfig } from "../config.js";
import { loadOrCreateSetupKey } from "../setup-key.js";
import { lanAddresses } from "../installs.js";

const config = loadConfig();
const key = loadOrCreateSetupKey(config.dataDir);
const ips = lanAddresses().filter((a) => !a.virtual).map((a) => a.address);
console.log("\nOpen the web UI with this link (port 80 through Caddy, or the agent port):\n");
for (const ip of ips.length ? ips : ["<this server's IP>"]) {
  console.log(`    http://${ip}/?setup=${key}`);
  console.log(`    http://${ip}:${config.port}/?setup=${key}`);
}
console.log("\nKeep it private: before the domain is set up, it's what opens the web UI.\n");
