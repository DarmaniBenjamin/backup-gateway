// Integrity check from the command line.
// Usage: npm run verify

import { loadConfig } from "../config.js";
import { openDatabase } from "../db.js";
import { loadOrCreateGatewayKeys } from "../keys.js";
import { createStorage } from "../storage.js";
import { runVerify } from "../verify.js";

const config = loadConfig();
const db = openDatabase(config.dataDir);
const report = runVerify({ db, keys: loadOrCreateGatewayKeys(config.dataDir), storage: createStorage(config.dataDir) });
db.close();

for (const d of report.devices) {
  const name = `${d.name} (${d.client})`;
  if (d.problems.length === 0) {
    console.log(`✔ ${name}: all ${d.chunks} chunks OK`);
    continue;
  }
  console.log(`✘ ${name}: ${d.problems.length} of ${d.chunks} chunks bad`);
  for (const p of d.problems) console.log(`   chunk ${p.chunk.slice(0, 12)}… ${p.reason} — affects: ${p.affects.join(", ")}`);
}

console.log(`\nChecked ${report.checked} chunk(s). ${report.damaged === 0 ? "No problems found." : `${report.damaged} problem(s) found.`}`);
if (report.damaged > 0) {
  console.log("The bad chunks were removed. Those versions can't be restored from this gateway, but");
  console.log("if the same data is backed up again, it will be uploaded fresh.");
  process.exitCode = 1;
}