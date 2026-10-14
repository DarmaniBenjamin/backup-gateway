// Turns off two-factor login for an admin who lost their phone and their recovery codes. Only on
// the server itself. Usage: sudo npm run reset-2fa -- USERNAME

import { loadConfig } from "../config.js";
import { openDatabase } from "../db.js";
import { openAdminStore } from "../admin/admin-store.js";

const username = (process.argv[2] ?? "").trim();
if (!username) {
  console.error("Usage: npm run reset-2fa -- USERNAME");
  process.exit(1);
}
const config = loadConfig();
openDatabase(config.dataDir).close();
const store = openAdminStore(config.dataDir);
const admin = store.adminByName(username);
if (!admin) {
  console.error(`No admin called "${username}".`);
  process.exit(1);
}
store.setTwoFactor(admin.id, null, null);
store.audit("server console", "2fa.reset", { username: admin.username }, null);
console.log(`Two-factor login is off for ${admin.username}. Sign in with the password, then turn it on again.`);
store.close();
