// Lockdown on the server itself (see ../admin/lockdown.js): for when there's no recovery key, or
// it's lost. Usage: sudo npm run lockdown -- status | on | off

import { loadConfig } from "../config.js";
import { openDatabase } from "../db.js";
import { openAdminStore } from "../admin/admin-store.js";

const what = (process.argv[2] ?? "status").toLowerCase();
const config = loadConfig();
openDatabase(config.dataDir).close();
const store = openAdminStore(config.dataDir);
const s = store.getSetting("lockdown") ?? { on: false };

if (what === "on") {
  store.setSetting("lockdown", { on: true, since: new Date().toISOString(), reason: "turned on at the server", by: "server console" });
  store.audit("server console", "lockdown.on", { reason: "turned on at the server" }, null);
  console.log("Lockdown is on. Nothing can be changed or deleted from the web UI.");
} else if (what === "off") {
  store.setSetting("lockdown", { on: false });
  store.audit("server console", "lockdown.off", null, null);
  console.log("Lockdown is off.");
} else {
  console.log(s.on ? `Lockdown is on since ${s.since}: ${s.reason}` : "Lockdown is off.");
}
store.close();
