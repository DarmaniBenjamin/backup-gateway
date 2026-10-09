// Lists recent jobs (restores) and how they went.
// Usage: npm run jobs

import { loadConfig } from "../config.js";
import { openDatabase } from "../db.js";

const db = openDatabase(loadConfig().dataDir);
const jobs = db.listCommands(20);
db.close();

if (jobs.length === 0) {
  console.log("No jobs yet.");
  process.exit(0);
}

console.table(
  jobs.map((j) => {
    const payload = JSON.parse(j.payload);
    const result = j.result ? JSON.parse(j.result) : null;
    return {
      job: j.id,
      device: `${j.device_name} (${j.client_name})`,
      what: payload.label,
      mode: payload.mode,
      status: j.status,
      restored: result ? result.restored : "-",
      failed: result ? result.failed : "-",
      created: new Date(j.created_at).toLocaleString(),
    };
  })
);

for (const j of jobs) {
  const result = j.result ? JSON.parse(j.result) : null;
  if (result?.errors?.length) {
    console.log(`\nJob #${j.id} errors:`);
    for (const e of result.errors) console.log(`  - ${e}`);
  }
}