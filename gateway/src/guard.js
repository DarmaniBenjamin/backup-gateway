// The quarantine engine's decision maker. For every new file version it decides:
//   - "ok"          → becomes the file's latest version as normal
//   - "quarantined" → stored as evidence but NEVER used as the latest version or for restores,
//                     until an admin releases it
// It also freezes a whole device when an attack looks underway: too many suspicious files,
// or a mass deletion, in a short time. While frozen, everything from that device is quarantined.

import { REASON_TEXT } from "./inspect.js";
import { log } from "./logger.js";

export function createGuard({ db, config }) {
  const windowMs = config.freezeWindowMinutes * 60 * 1000;

  function alertOnce(device, kind, message) {
    // Don't flood: one open alert of each kind per device per window
    const since = new Date(Date.now() - windowMs).toISOString();
    if (!db.hasRecentOpenAlert(device.id, kind, since)) db.addAlert(device.id, kind, message);
  }

  function freeze(device, reason) {
    if (db.freezeDevice(device.id, reason)) {
      log.error(`FROZEN ${device.device_name} (${device.client_name}): ${reason}`);
      db.addAlert(device.id, "frozen", `${device.device_name} was frozen: ${reason}. New changes are quarantined until you review them.`);
    }
  }

  return {
    /**
     * device   the device record (fresh from the database)
     * version  { relPath, type, reasons[], sameAsLastGood }
     *          reasons come from inspectFile (empty for deletions); sameAsLastGood is true when the
     *          content is byte-for-byte the file's last good version (e.g. it was just restored)
     * Returns { status, reasons } to store with the version.
     */
    decide(device, version) {
      const reasons = [...(version.reasons ?? [])];

      // Identical to the last good version: provably not damage (this is what a restore writes back)
      if (version.sameAsLastGood && reasons.length === 0) return { status: "ok", reasons };

      // Already frozen: hold everything back until an admin has looked
      if (device.frozen_at) {
        if (!reasons.length) reasons.push("device-frozen");
        return { status: "quarantined", reasons };
      }

      // Count within the window, but never from before the device was last unfrozen
      const windowStart = Date.now() - windowMs;
      const unfrozen = device.unfrozen_at ? new Date(device.unfrozen_at).getTime() : 0;
      const since = new Date(Math.max(windowStart, unfrozen)).toISOString();
      const recent = db.countSince(device.id, since);

      // Mass deletion: freeze and quarantine the deletions so files stay restorable as "latest"
      if (version.type === "deleted" && recent.deleted + 1 >= config.freezeDeletedFiles) {
        freeze(device, `${recent.deleted + 1} files deleted within ${config.freezeWindowMinutes} minutes`);
        const pulledBack = db.quarantineDeletesSince(device.id, since);
        log.warn(`${device.device_name}: ${pulledBack + 1} deletions quarantined, the files stay restorable`);
        return { status: "quarantined", reasons: ["mass-delete"] };
      }

      if (reasons.length === 0) return { status: "ok", reasons };

      // Suspicious file
      const suspicious = recent.suspicious + 1;
      log.warn(`${device.device_name}: quarantined ${version.relPath} (${reasons.map((r) => REASON_TEXT[r] ?? r).join("; ")})`);
      if (suspicious >= config.freezeSuspiciousFiles) {
        freeze(device, `${suspicious} suspicious files within ${config.freezeWindowMinutes} minutes, possible ransomware`);
      } else {
        alertOnce(device, "quarantine", `Suspicious files from ${device.device_name} were quarantined.`);
      }
      return { status: "quarantined", reasons };
    },
  };
}