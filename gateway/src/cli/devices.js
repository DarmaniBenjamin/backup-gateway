// Lists enrolled devices and when they were last seen.
// Usage: npm run devices

import { loadConfig } from "../config.js";
import { openDatabase } from "../db.js";

const db = openDatabase(loadConfig().dataDir);
const devices = db.listDevices();
db.close();

if (devices.length === 0) {
  console.log("No devices enrolled yet.");
  process.exit(0);
}

function ago(iso) {
  if (!iso) return "never";
  const s = Math.round((Date.now() - new Date(iso)) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

console.table(
  devices.map((d) => ({
    client: d.client_name,
    device: d.device_name,
    id: d.id,
    status: d.status,
    "last seen": ago(d.last_seen_at),
    files: d.files_tracked ?? "-",
    pending: d.pending_changes ?? "-",
    version: d.agent_version ?? "-",
  }))
);