// Lists every stored file version, plus storage used per device.
// Usage: npm run versions

import { loadConfig } from "../config.js";
import { openDatabase } from "../db.js";

const db = openDatabase(loadConfig().dataDir);
const versions = db.listVersions();
const stats = db.storageStats();
const devices = db.listDevices();
db.close();

function formatSize(bytes) {
  if (bytes == null) return "-";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

if (versions.length === 0) {
  console.log("No file versions stored yet.");
} else {
  console.table(
    versions.map((v) => ({
      client: v.client_name,
      device: v.device_name,
      file: v.rel_path,
      version: v.version_no,
      type: v.type,
      size: formatSize(v.size),
      chunks: v.chunk_ids ? JSON.parse(v.chunk_ids).length : "-",
      sha256: v.sha256 ? `${v.sha256.slice(0, 12)}…` : "-",
      received: new Date(v.received_at).toLocaleString(),
    }))
  );
}

if (stats.length) {
  console.log("\nStorage used (after deduplication, compression and encryption):");
  console.table(
    stats.map((s) => {
      const d = devices.find((x) => x.id === s.device_id);
      return {
        device: d ? `${d.device_name} (${d.client_name})` : s.device_id,
        "unique chunks": s.chunks,
        "original size": formatSize(s.plain),
        "stored size": formatSize(s.stored),
      };
    })
  );
}