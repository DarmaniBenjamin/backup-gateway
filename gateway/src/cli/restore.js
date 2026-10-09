// Creates a restore job. The agent picks it up on its next heartbeat (within 30 seconds).
//
// Usage:
//   npm run restore -- --device dev-laptop --path big.bin --version 1
//   npm run restore -- --device dev-laptop --path invoices --at "2026-10-09 14:00"
//   npm run restore -- --device dev-laptop                      (everything, latest versions)
//   npm run restore -- --device old-nas --to new-nas            (restore onto a different device)
//   add --mode overwrite to put files back in their original place (default: copy into _Restored)

import { parseArgs } from "node:util";
import { loadConfig } from "../config.js";
import { openDatabase } from "../db.js";
import { prepareRestore, RestoreError } from "../restore-plan.js";

const { values: args } = parseArgs({
  options: {
    device: { type: "string" },
    to: { type: "string" },
    path: { type: "string", default: "" },
    version: { type: "string" },
    at: { type: "string" },
    mode: { type: "string", default: "copy" },
  },
});

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

const db = openDatabase(loadConfig().dataDir);
let plan;
try {
  plan = prepareRestore(db, args, { create: true });
} catch (err) {
  if (!(err instanceof RestoreError)) throw err;
  console.error(`\n${err.message}\n`);
  console.error('Example: npm run restore -- --device dev-laptop --path big.bin --version 1\n');
  process.exit(1);
} finally {
  db.close();
}

console.log(`\nRestore job #${plan.jobId} created: ${plan.label}`);
console.log(`Target device: ${plan.target.name} (${plan.target.client})   Mode: ${plan.mode}`);
console.log(`${plan.fileCount} file(s), ${formatSize(plan.totalSize)}:\n`);
console.table(
  plan.files.slice(0, 25).map((f) => ({
    file: f.relPath,
    version: f.versionNo,
    size: formatSize(f.size),
    "backed up": new Date(f.backedUpAt).toLocaleString(),
  }))
);
if (plan.fileCount > 25) console.log(`...and ${plan.fileCount - 25} more.`);
console.log(
  plan.mode === "copy"
    ? "\nFiles will be restored into a _Restored folder — originals are not touched."
    : "\nFiles will be put back in their ORIGINAL locations, replacing what's there now."
);
console.log('The agent picks this up within 30 seconds. Check progress with "npm run jobs".\n');