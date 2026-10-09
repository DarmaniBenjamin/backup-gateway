// Integrity check: decrypts every stored chunk and confirms it still matches its fingerprint.
// Finds damage from failing disks or tampering BEFORE you need a restore.
// Bad chunks are removed, so if that data is ever backed up again it gets uploaded fresh.
// Used by both the command line (npm run verify) and the web UI.

import { chunkId, open } from "./crypto-box.js";

export function runVerify({ db, keys, storage }) {
  const report = { checkedAt: new Date().toISOString(), checked: 0, damaged: 0, devices: [] };

  for (const device of db.listDevices()) {
    const k = keys.forDevice(device);
    if (!k) continue;

    // Every chunk referenced by any version of any file on this device
    const usedBy = new Map(); // chunk ID -> list of "file vN"
    for (const v of db.versionsUnder(device.id, "")) {
      if (!v.chunk_ids) continue;
      for (const id of JSON.parse(v.chunk_ids)) {
        if (!usedBy.has(id)) usedBy.set(id, []);
        usedBy.get(id).push(`${v.rel_path} v${v.version_no}`);
      }
    }

    const problems = [];
    for (const id of usedBy.keys()) {
      report.checked++;
      try {
        const plaintext = open(k.encKey, storage.readChunk(device.id, id), `chunk:${id}`);
        if (chunkId(k.idKey, plaintext) !== id) throw new Error("fingerprint mismatch");
      } catch (err) {
        problems.push({ chunk: id, reason: err.code === "ENOENT" ? "missing" : "damaged", affects: usedBy.get(id) });
        storage.deleteChunk(device.id, id);
        db.removeChunk(device.id, id);
      }
    }

    report.damaged += problems.length;
    report.devices.push({
      id: device.id,
      name: device.device_name,
      client: device.client_name,
      chunks: usedBy.size,
      problems,
    });
  }
  return report;
}