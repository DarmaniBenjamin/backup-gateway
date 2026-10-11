// Uninstalling an agent from the web UI, for when a client stops the service.
//
//   1. You click Uninstall. If the device is offline, it waits: the order goes out the next time
//      the device checks in, however long that takes.
//   2. The order travels like an update offer: encrypted for that device, and signed with the
//      gateway's update key. The device's updater (root on Linux and Synology, SYSTEM on Windows)
//      checks that signature with its own copy of the key, and that the order names this device,
//      then removes the agent: its service, program, identity, keys and settings. The client's own
//      files are never touched.
//   3. The agent confirms before it hands over. Once it goes quiet, the device is marked removed
//      (revoked: it can never connect again with those keys). Its backups stay on the gateway, and
//      can still be restored to another device.
//
// A device with its folder lock on refuses until it's unlocked with its key (the lock exists so a
// hacked gateway can't quietly stop a device's backups, and uninstalling would do exactly that).
// Agents older than 0.16 update first (automatically), then uninstall.

import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { newerVersion } from "./updates.js";
import { log } from "./logger.js";

export const UNINSTALL_FROM = "0.16.0";
const QUIET_MS = 5 * 60_000; // no check-in for this long after confirming = uninstalled
const STUCK_MS = 30 * 60_000; // still checking in this long after confirming = it failed

export function createRemovals({ db, dataDir, updateKey, updates, security, broker }) {
  const conn = new DatabaseSync(path.join(dataDir, "gateway.db"));
  conn.exec(`
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS device_removals (
      device_id     TEXT PRIMARY KEY,
      state         TEXT NOT NULL,   -- waiting / refused / uninstalling / done / failed
      requested_at  TEXT NOT NULL,
      requested_by  TEXT,
      delivered_at  TEXT,
      confirmed_at  TEXT,
      finished_at   TEXT,
      message       TEXT
    );
  `);
  const q = {
    get: conn.prepare("SELECT * FROM device_removals WHERE device_id = ?"),
    all: conn.prepare("SELECT * FROM device_removals"),
    upsert: conn.prepare(`
      INSERT INTO device_removals (device_id, state, requested_at, requested_by) VALUES (?, 'waiting', ?, ?)
      ON CONFLICT (device_id) DO UPDATE SET state = 'waiting', requested_at = excluded.requested_at, requested_by = excluded.requested_by,
        delivered_at = NULL, confirmed_at = NULL, finished_at = NULL, message = NULL`),
    set: conn.prepare("UPDATE device_removals SET state = ?, message = ? WHERE device_id = ?"),
    delivered: conn.prepare("UPDATE device_removals SET delivered_at = ? WHERE device_id = ?"),
    confirmed: conn.prepare("UPDATE device_removals SET state = 'uninstalling', confirmed_at = ?, message = NULL WHERE device_id = ?"),
    finished: conn.prepare("UPDATE device_removals SET state = ?, finished_at = ?, message = ? WHERE device_id = ?"),
    remove: conn.prepare("DELETE FROM device_removals WHERE device_id = ?"),
    revoke: conn.prepare("UPDATE devices SET status = 'revoked' WHERE id = ?"),
  };
  const now = () => new Date().toISOString();
  const who = (d) => `${d.device_name} (${d.client_name})`;
  const statusOf = (d) => {
    try {
      return d.agent_status ? JSON.parse(d.agent_status) : null;
    } catch {
      return null;
    }
  };

  // Can this agent uninstall itself, now or after updating?
  function readiness(d) {
    const st = statusOf(d);
    if (!st?.update?.capable) return { ok: false, reason: "no-updater" };
    if (newerVersion(UNINSTALL_FROM, d.agent_version)) return { ok: true, updateFirst: true };
    return { ok: true };
  }

  function finish(d, state, message) {
    q.finished.run(state, now(), message, d.id);
    if (state === "done") {
      q.revoke.run(d.id);
      log.info(`${who(d)}: agent uninstalled; the device is removed`);
      security?.event("info", "agent.uninstalled", `The agent was uninstalled from ${who(d)}. Its backups stay on the gateway.`, { deviceId: d.id });
    } else {
      log.warn(`${who(d)}: uninstall failed: ${message}`);
      security?.event("medium", "agent.uninstall-failed", `Uninstalling the agent from ${who(d)} failed: ${message}`, { deviceId: d.id, detail: { error: message } });
      db.addAlert(d.id, "uninstall", `The agent on ${d.device_name} couldn't uninstall itself: ${message}`);
    }
  }

  return {
    readiness,
    get: (deviceId) => q.get.get(deviceId) ?? null,
    inProgress: (deviceId) => ["waiting", "refused", "uninstalling"].includes(q.get.get(deviceId)?.state),

    request(d, by) {
      const r = readiness(d);
      if (!r.ok) return r;
      q.upsert.run(d.id, now(), by);
      if (r.updateFirst) updates.requestNow(d.id); // gets the agent that knows how to uninstall
      log.info(`${by} asked to uninstall the agent from ${who(d)}`);
      security?.event("medium", "agent.uninstall-requested", `${by} asked to uninstall the agent from ${who(d)}`, { deviceId: d.id, detail: { by } });
      broker.wake(d.id);
      return { ok: true, updateFirst: !!r.updateFirst };
    },

    cancel(d) {
      const r = q.get.get(d.id);
      if (!r || !["waiting", "refused", "failed"].includes(r.state)) return false;
      q.remove.run(d.id);
      return true;
    },

    // Removed without uninstalling (the computer is gone or broken): it can't connect again
    forget(d, by) {
      q.revoke.run(d.id);
      q.remove.run(d.id);
      log.info(`${by} removed ${who(d)} without uninstalling`);
      security?.event("medium", "agent.removed", `${by} removed ${who(d)} from the gateway (without uninstalling)`, { deviceId: d.id, detail: { by } });
    },

    // On a heartbeat: the signed order, if this device should uninstall now
    orderFor(d) {
      const r = q.get.get(d.id);
      if (!r || !["waiting", "refused"].includes(r.state)) return null;
      if (newerVersion(UNINSTALL_FROM, d.agent_version)) return null; // it updates first
      if (!r.delivered_at) q.delivered.run(now(), d.id);
      const order = JSON.stringify({ format: "backup-agent-uninstall", id: r.requested_at, deviceId: d.id, issuedAt: now(), by: r.requested_by });
      return { order, signature: updateKey.sign(order), publicKey: updateKey.publicKeyB64 };
    },

    // What the agent says on its heartbeat
    report(d, status) {
      const r = q.get.get(d.id);
      if (!r || !["waiting", "refused", "uninstalling"].includes(r.state)) return;
      const u = status?.uninstall;
      if (!u || u.order !== r.requested_at) return; // about an earlier request
      if (u.state === "uninstalling" && r.state !== "uninstalling") {
        q.confirmed.run(now(), d.id);
        log.info(`${who(d)} is uninstalling its agent`);
      } else if (u.state === "refused" && r.state === "waiting") {
        q.set.run("refused", u.error, d.id);
        log.info(`${who(d)} refused to uninstall: ${u.error}`);
      } else if (u.state === "failed") {
        finish(d, "failed", u.error ?? "unknown error");
      }
    },

    // Every minute: an agent that confirmed and then went quiet has uninstalled
    tick() {
      for (const r of q.all.all()) {
        if (r.state !== "uninstalling") continue;
        const d = db.getDevice(r.device_id);
        if (!d) continue;
        const confirmed = Date.parse(r.confirmed_at);
        const lastSeen = d.last_seen_at ? Date.parse(d.last_seen_at) : 0;
        if (Date.now() - lastSeen > QUIET_MS && Date.now() - confirmed > QUIET_MS) finish(d, "done", null);
        else if (Date.now() - confirmed > STUCK_MS) finish(d, "failed", "the agent was still running 30 minutes after it started uninstalling");
      }
    },
  };
}
