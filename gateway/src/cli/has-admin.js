// Says whether the web UI has an admin account yet (used by deploy/install.sh).
// Prints the number of admins; exits 0 if there's at least one, 1 if there are none.
//
// Usage: node --env-file-if-exists=.env src/cli/has-admin.js

import { loadConfig } from "../config.js";
import { openDatabase } from "../db.js";
import { openAdminStore } from "../admin/admin-store.js";

const config = loadConfig();
openDatabase(config.dataDir).close(); // creates all tables on a brand-new install
const store = openAdminStore(config.dataDir);
const n = store.countAdmins();
store.close();
console.log(n);
process.exit(n > 0 ? 0 : 1);
