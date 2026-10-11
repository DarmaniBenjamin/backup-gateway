// Watches for problems nothing else reports, and turns them into security events (so they show on
// the Security page and go out as alerts):
//   - a device that hasn't checked in for a while (Alerts page setting, 24 hours by default), and
//     when it's back
//   - the gateway's disk running out of space (below 10 % free by default), and when it's fine again
// Checks start 5 minutes after the gateway starts, so devices have time to reconnect first.

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { log } from "./logger.js";

const EVERY_MS = 60_000;
const DISK_EVERY_MS = 10 * 60_000;
const GRACE_MS = 5 * 60_000;
const BACK_WITHIN_MS = 5 * 60_000;

export function duration(ms) {
  const h = ms / 3600e3;
  if (h < 1) return `${Math.max(1, Math.round(ms / 60e3))} minutes`;
  if (h < 48) return `${Math.round(h)} hour${Math.round(h) === 1 ? "" : "s"}`;
  return `${Math.round(h / 24)} days`;
}
const gb = (bytes) => `${(bytes / 1024 ** 3).toFixed(bytes < 10 * 1024 ** 3 ? 1 : 0)} GB`;

export function createHealth({ db, dataDir, security, settings, skipDevice = () => false, startedAt = Date.now() }) {
  const conn = new DatabaseSync(path.join(dataDir, "gateway.db"));
  conn.exec(`
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS device_health (
      device_id     TEXT PRIMARY KEY,
      offline_since TEXT NOT NULL,   -- its last check-in when the offline alert went out
      notified_at   TEXT NOT NULL
    );
  `);
  const q = {
    all: conn.prepare("SELECT * FROM device_health"),
    add: conn.prepare("INSERT OR REPLACE INTO device_health (device_id, offline_since, notified_at) VALUES (?, ?, ?)"),
    remove: conn.prepare("DELETE FROM device_health WHERE device_id = ?"),
    getMeta: conn.prepare("SELECT value FROM notify_meta WHERE name = ?"),
    setMeta: conn.prepare("INSERT OR REPLACE INTO notify_meta (name, value) VALUES (?, ?)"),
  };
  const who = (d) => `${d.device_name} (${d.client_name})`;

  function checkDevices() {
    if (Date.now() - startedAt < GRACE_MS) return;
    const limitMs = settings().offlineHours * 3600e3;
    const flagged = new Map(q.all.all().map((r) => [r.device_id, r]));
    for (const d of db.listDevices()) {
      const f = flagged.get(d.id);
      if (d.status !== "active" || !d.last_seen_at || skipDevice(d.id)) {
        if (f) q.remove.run(d.id);
        continue;
      }
      const silent = Date.now() - Date.parse(d.last_seen_at);
      if (!f && silent > limitMs) {
        q.add.run(d.id, d.last_seen_at, new Date().toISOString());
        log.warn(`${who(d)} hasn't checked in for ${duration(silent)}`);
        security.event("high", "device.offline", `${who(d)} hasn't checked in for ${duration(silent)}`, {
          deviceId: d.id, detail: { lastSeenAt: d.last_seen_at, lastSeenIp: d.last_seen_ip, offlineHours: settings().offlineHours },
        });
      } else if (f && silent < BACK_WITHIN_MS) {
        q.remove.run(d.id);
        const away = Date.parse(d.last_seen_at) - Date.parse(f.offline_since);
        log.info(`${who(d)} is back online`);
        security.event("info", "device.online", `${who(d)} is back online after ${duration(away)}`, {
          deviceId: d.id, detail: { recovers: true, problemSeverity: "high", offlineSince: f.offline_since },
        });
      }
    }
  }

  function checkDisk() {
    let st;
    try {
      st = fs.statfsSync(dataDir);
    } catch (err) {
      log.warn(`Couldn't check the gateway's free disk space: ${err.message}`);
      return null;
    }
    const total = st.blocks * st.bsize;
    const free = st.bavail * st.bsize;
    const pct = total ? (free / total) * 100 : 100;
    const limit = settings().diskPercent;
    const flaggedAs = q.getMeta.get("disk_low")?.value;
    const flagged = flaggedAs === "high" || flaggedAs === "critical";
    if (!flagged && pct < limit) {
      q.setMeta.run("disk_low", pct < 3 ? "critical" : "high");
      log.error(`Gateway disk almost full: ${gb(free)} free (${pct.toFixed(1)} %)`);
      security.event(pct < 3 ? "critical" : "high", "gateway.disk-low", `The gateway's disk is almost full: ${gb(free)} free (${pct.toFixed(1)} %)`, {
        detail: { freeBytes: free, totalBytes: total, freePercent: Math.round(pct * 10) / 10, limitPercent: limit, dataDir },
      });
    } else if (flagged && pct >= limit + 2) {
      q.setMeta.run("disk_low", "");
      security.event("info", "gateway.disk-ok", `The gateway's disk has room again: ${gb(free)} free (${pct.toFixed(1)} %)`, {
        detail: { recovers: true, problemSeverity: flaggedAs, freeBytes: free, totalBytes: total, freePercent: Math.round(pct * 10) / 10 },
      });
    }
    return { freeBytes: free, totalBytes: total, freePercent: Math.round(pct * 10) / 10 };
  }

  let timers = [];
  let disk = null;
  return {
    checkDevices,
    checkDisk: () => (disk = checkDisk()),
    disk: () => disk,
    offline: () => q.all.all().map((r) => r.device_id),
    start() {
      disk = checkDisk();
      timers = [
        setInterval(() => {
          try {
            checkDevices();
          } catch (err) {
            log.error("Device health check failed", err);
          }
        }, EVERY_MS),
        setInterval(() => (disk = checkDisk() ?? disk), DISK_EVERY_MS),
      ];
      for (const t of timers) t.unref();
    },
    stop() {
      for (const t of timers) clearInterval(t);
    },
  };
}
