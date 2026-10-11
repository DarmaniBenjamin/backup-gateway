// Automatic agent updates. The gateway always carries one agent version (the agent/ folder next
// to it, packed at start). Devices running an older agent are offered it on their heartbeat:
//
//   1. the offer is encrypted for that device, and says which version, with a manifest (the
//      package's SHA-256 and size) signed by the gateway's update key (keys.js)
//   2. the agent downloads the package over its signed link and checks it, then asks its updater
//   3. the updater (a separate root/SYSTEM job set up by the installer, outside the agent's reach)
//      checks the signature again against the key the installer gave it, installs the new version
//      beside the old one, swaps them, and starts the agent. If the new agent doesn't come back
//      within a couple of minutes, it puts the old version back.
//
// Updates go out at most a few at a time. Each device can be held at its version, or updated now.
// Agents installed before 0.15 have no updater: their page offers a one-time command to add it.

import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { log } from "./logger.js";

const AT_ONCE = 5;
const BUSY = ["offered", "downloading", "staged", "applying"];
const STUCK_MS = 30 * 60_000; // an update that hasn't moved for this long is counted as failed
const RETRY_AFTER_MS = 12 * 3600_000; // after a failure, try again automatically only after this

export function newerVersion(a, b) {
  const p = (v) => String(v ?? "0").split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : 0));
  const [x, y] = [p(a), p(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return false;
}

export function createUpdates({ db, dataDir, agentPackage, updateKey, security }) {
  const conn = new DatabaseSync(path.join(dataDir, "gateway.db"));
  conn.exec(`
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS agent_updates (
      device_id      TEXT PRIMARY KEY,
      hold           INTEGER NOT NULL DEFAULT 0,
      requested_at   TEXT,     -- "update now", even with automatic updates off
      state          TEXT,     -- offered / downloading / staged / applying / done / failed
      target         TEXT,     -- the version being installed
      from_version   TEXT,
      message        TEXT,
      changed_at     TEXT,
      failed_at      TEXT
    );
    CREATE TABLE IF NOT EXISTS update_meta (
      name  TEXT PRIMARY KEY,
      value TEXT
    );
  `);
  const q = {
    get: conn.prepare("SELECT * FROM agent_updates WHERE device_id = ?"),
    all: conn.prepare("SELECT * FROM agent_updates"),
    ensure: conn.prepare("INSERT OR IGNORE INTO agent_updates (device_id) VALUES (?)"),
    setState: conn.prepare("UPDATE agent_updates SET state = ?, target = ?, from_version = COALESCE(?, from_version), message = ?, changed_at = ? WHERE device_id = ?"),
    failed: conn.prepare("UPDATE agent_updates SET state = 'failed', message = ?, changed_at = ?, failed_at = ?, requested_at = NULL WHERE device_id = ?"),
    done: conn.prepare("UPDATE agent_updates SET state = 'done', message = NULL, changed_at = ?, requested_at = NULL, failed_at = NULL WHERE device_id = ?"),
    hold: conn.prepare("UPDATE agent_updates SET hold = ? WHERE device_id = ?"),
    request: conn.prepare("UPDATE agent_updates SET requested_at = ?, failed_at = NULL WHERE device_id = ?"),
    busy: conn.prepare(`SELECT COUNT(*) AS n FROM agent_updates WHERE state IN (${BUSY.map(() => "?").join(",")}) AND changed_at >= ?`),
    getMeta: conn.prepare("SELECT value FROM update_meta WHERE name = ?"),
    setMeta: conn.prepare("INSERT OR REPLACE INTO update_meta (name, value) VALUES (?, ?)"),
  };
  const now = () => new Date().toISOString();
  const row = (id) => (q.ensure.run(id), q.get.get(id));

  // The signed description of the package. The updater checks this exact text.
  const manifest = agentPackage
    ? JSON.stringify({
        format: "backup-agent-update",
        version: agentPackage.version,
        tar: { sha256: agentPackage.sha256, size: agentPackage.tarGz.length },
        zip: { sha256: agentPackage.zipSha256, size: agentPackage.zip.length },
        createdAt: now(),
      })
    : null;
  const signature = manifest ? updateKey.sign(manifest) : null;

  const auto = () => q.getMeta.get("auto")?.value !== "0";

  function deviceName(device) {
    return `${device.device_name} (${device.client_name})`;
  }

  return {
    version: agentPackage?.version ?? null,
    auto,
    setAuto: (on) => q.setMeta.run("auto", on ? "1" : "0"),

    // The update offer for a heartbeat, or null. `status` is what the agent reported (cleaned).
    offerFor(device, reportedVersion, status) {
      if (!manifest || !reportedVersion || !newerVersion(agentPackage.version, reportedVersion)) return null;
      if (!status?.update?.capable) return null;
      const r = row(device.id);
      const asked = !!r.requested_at;
      if (!asked && (r.hold || !auto())) return null;
      if (!asked && r.failed_at && r.target === agentPackage.version && Date.now() - Date.parse(r.failed_at) < RETRY_AFTER_MS) return null;
      const mine = BUSY.includes(r.state) && r.target === agentPackage.version;
      if (!mine && q.busy.get(...BUSY, new Date(Date.now() - STUCK_MS).toISOString()).n >= AT_ONCE) return null; // its turn comes
      if (!mine) {
        q.setState.run("offered", agentPackage.version, reportedVersion, null, now(), device.id);
        security?.event("info", "agent.update-offered", `Updating ${deviceName(device)} from agent ${reportedVersion} to ${agentPackage.version}`, { deviceId: device.id, detail: { from: reportedVersion, to: agentPackage.version } });
      } else if (Date.now() - Date.parse(r.changed_at) > STUCK_MS) {
        q.failed.run("The update didn't finish in time.", now(), now(), device.id);
        return null;
      }
      return { version: agentPackage.version, manifest, signature, publicKey: updateKey.publicKeyB64 };
    },

    // What the agent says about the update, on every heartbeat
    report(device, previousVersion, reportedVersion, status) {
      const r = q.get.get(device.id);
      if (!r || !r.target) return;
      const u = status?.update;
      // Came back on the new version: done
      if (reportedVersion === r.target && r.state !== "done") {
        q.done.run(now(), device.id);
        log.info(`${deviceName(device)} updated its agent to ${reportedVersion}`);
        security?.event("info", "agent.updated", `${deviceName(device)} is now on agent ${reportedVersion}`, { deviceId: device.id, detail: { from: r.from_version ?? previousVersion, to: reportedVersion } });
        return;
      }
      if (!u || r.state === "done") return;
      if (u.state === "failed" && u.version === r.target && r.state !== "failed") {
        q.failed.run(u.error ?? "The update failed.", now(), now(), device.id);
        log.warn(`${deviceName(device)}: agent update to ${r.target} failed: ${u.error}`);
        security?.event("medium", "agent.update-failed", `Agent update on ${deviceName(device)} to ${r.target} failed: ${u.error ?? "unknown error"}`, { deviceId: device.id, detail: { to: r.target, error: u.error } });
        db.addAlert(device.id, "update", `The agent on ${device.device_name} couldn't update to ${r.target}: ${u.error ?? "unknown error"}.${/kept /.test(u.error ?? "") ? "" : ` It kept running ${reportedVersion}.`}`);
        return;
      }
      if (["downloading", "staged", "applying"].includes(u.state) && u.version === r.target && u.state !== r.state) {
        q.setState.run(u.state, r.target, null, null, now(), device.id);
      }
    },

    setHold(deviceId, hold) {
      row(deviceId);
      q.hold.run(hold ? 1 : 0, deviceId);
    },
    requestNow(deviceId) {
      row(deviceId);
      q.request.run(now(), deviceId);
    },

    // For the web UI
    list(devices, broker) {
      const rows = new Map(q.all.all().map((r) => [r.device_id, r]));
      return devices
        .filter((d) => d.status === "active")
        .map((d) => {
          let status = null;
          try {
            status = d.agent_status ? JSON.parse(d.agent_status) : null;
          } catch {
            status = null;
          }
          const r = rows.get(d.id) ?? {};
          const behind = agentPackage && d.agent_version ? newerVersion(agentPackage.version, d.agent_version) : false;
          return {
            id: d.id,
            name: d.device_name,
            client: d.client_name,
            platform: d.platform,
            version: d.agent_version,
            live: broker.isLive(d.id),
            capable: !!status?.update?.capable,
            behind,
            hold: !!r.hold,
            requested: !!r.requested_at,
            state: behind ? (r.target === agentPackage.version ? r.state ?? null : null) : "current",
            message: r.message ?? null,
            changedAt: r.changed_at ?? null,
          };
        });
    },
  };
}
