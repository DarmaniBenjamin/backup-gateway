// Uninstalling an agent from the web UI, for when a client stops the service.
//
//   1. You click Uninstall. If the device is offline, it waits: the order goes out the next time
//      the device checks in, however long that takes.
//   2. The order travels like an update offer: encrypted for that device, and signed with the
//      gateway's update key. The device's updater (root on Linux and Synology, SYSTEM on Windows)
//      checks that signature with its own copy of the key, and that the order names this device,
//      then removes the agent: its service, program, identity, keys and settings. The client's own
//      files are never touched.
//   3. The agent confirms before it hands over, and the updater tells the gateway when it's done
//      (signed with the device's key). The device is then marked removed (revoked: it can never
//      connect again with those keys). If that last message doesn't arrive, a device that confirmed
//      and then went quiet for 2 minutes counts as removed.
//   4. Its backups stay on the gateway and can still be restored to another device, until you
//      delete the device for good (purge): then its backups and history here are deleted too.
//      Or automatically: with "Delete removed devices' backups after N days" on (Devices page), a
//      removed device is deleted for good N days after it was removed, unless you chose to keep
//      it. An alert goes out 3 days before. Off-site copies aren't deleted from the cloud (see purge).
//
// A device with its folder lock on refuses until it's unlocked with its key (the lock exists so a
// hacked gateway can't quietly stop a device's backups, and uninstalling would do exactly that).
// Agents older than 0.16 update first (automatically), then uninstall.

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { newerVersion } from "./updates.js";
import { log } from "./logger.js";

export const UNINSTALL_FROM = "0.16.0";
const QUIET_MS = 2 * 60_000; // no check-in for this long after confirming = uninstalled
const STUCK_MS = 30 * 60_000; // still checking in this long after confirming = it failed
const DAY_MS = 24 * 60 * 60_000;
const WARN_MS = 3 * DAY_MS; // the alert before an automatic delete
export const AUTO_DELETE_DAYS = [0, 7, 14, 30, 60, 90, 180, 365]; // 0 = never

export function createRemovals({ db, dataDir, updateKey, updates, security, broker, store = null }) {
  const conn = new DatabaseSync(path.join(dataDir, "gateway.db"));
  conn.exec(`
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS device_removals (
      device_id     TEXT PRIMARY KEY,
      state         TEXT NOT NULL,   -- waiting / refused / uninstalling / done / failed / forgotten
      requested_at  TEXT NOT NULL,
      requested_by  TEXT,
      delivered_at  TEXT,
      confirmed_at  TEXT,
      finished_at   TEXT,
      message       TEXT
    );
    CREATE TABLE IF NOT EXISTS removal_meta (name TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  // Automatic deletes: "keep" = never delete this one automatically; warned_at = the alert went out
  const cols = conn.prepare("PRAGMA table_info(device_removals)").all().map((c) => c.name);
  if (!cols.includes("keep")) conn.exec("ALTER TABLE device_removals ADD COLUMN keep INTEGER NOT NULL DEFAULT 0");
  if (!cols.includes("warned_at")) conn.exec("ALTER TABLE device_removals ADD COLUMN warned_at TEXT");
  const q = {
    get: conn.prepare("SELECT * FROM device_removals WHERE device_id = ?"),
    all: conn.prepare("SELECT * FROM device_removals"),
    upsert: conn.prepare(`
      INSERT INTO device_removals (device_id, state, requested_at, requested_by) VALUES (?, 'waiting', ?, ?)
      ON CONFLICT (device_id) DO UPDATE SET state = 'waiting', requested_at = excluded.requested_at, requested_by = excluded.requested_by,
        delivered_at = NULL, confirmed_at = NULL, finished_at = NULL, message = NULL, keep = 0, warned_at = NULL`),
    set: conn.prepare("UPDATE device_removals SET state = ?, message = ? WHERE device_id = ?"),
    delivered: conn.prepare("UPDATE device_removals SET delivered_at = ? WHERE device_id = ?"),
    confirmed: conn.prepare("UPDATE device_removals SET state = 'uninstalling', confirmed_at = ?, message = NULL WHERE device_id = ?"),
    finished: conn.prepare("UPDATE device_removals SET state = ?, finished_at = ?, message = ? WHERE device_id = ?"),
    remove: conn.prepare("DELETE FROM device_removals WHERE device_id = ?"),
    revoke: conn.prepare("UPDATE devices SET status = 'revoked' WHERE id = ?"),
    forgotten: conn.prepare(`
      INSERT INTO device_removals (device_id, state, requested_at, requested_by, finished_at) VALUES (?, 'forgotten', ?, ?, ?)
      ON CONFLICT (device_id) DO UPDATE SET state = 'forgotten', requested_at = excluded.requested_at, requested_by = excluded.requested_by,
        finished_at = excluded.finished_at, message = NULL, keep = 0, warned_at = NULL`),
    keep: conn.prepare("UPDATE device_removals SET keep = ?, warned_at = NULL WHERE device_id = ?"),
    warned: conn.prepare("UPDATE device_removals SET warned_at = ? WHERE device_id = ?"),
    getMeta: conn.prepare("SELECT value FROM removal_meta WHERE name = ?"),
    setMeta: conn.prepare("INSERT OR REPLACE INTO removal_meta (name, value) VALUES (?, ?)"),
  };
  // Deleting for good needs the off-site copies (to disconnect the device's own): set by start()
  let purgeWith = null;
  let deleting = false;
  const autoDeleteDays = () => {
    const n = Number(q.getMeta.get("auto_delete_days")?.value ?? 0);
    return AUTO_DELETE_DAYS.includes(n) ? n : 0;
  };
  // When a removed device's backups go by themselves (null = they don't)
  function deleteAt(r) {
    const days = autoDeleteDays();
    if (!days || !r || r.keep || !["done", "forgotten"].includes(r.state) || !r.finished_at) return null;
    return new Date(Date.parse(r.finished_at) + days * DAY_MS).toISOString();
  }
  const table = (name) => !!conn.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
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

  const api = {
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
      q.forgotten.run(d.id, now(), by, now());
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

    // The updater's last message, once it has uninstalled the agent (or couldn't)
    goodbye(d, { ok, order, error }) {
      const r = q.get.get(d.id);
      if (!r || !["waiting", "refused", "uninstalling"].includes(r.state) || order !== r.requested_at) return;
      if (ok) finish(d, "done", null);
      else finish(d, "failed", error ?? "unknown error");
    },

    // Deletes a removed device for good: its backups on this gateway, versions, jobs, alerts and
    // settings. What's already in an off-site copy isn't deleted from there (the gateway never
    // deletes off-site: S3 locks run out and the bucket's lifecycle rule clears them; a Google
    // Drive folder you delete yourself). Its own off-site copies are disconnected.
    async purge(d, { copies, dataDir: dir }) {
      if (d.status === "active") throw new Error("Only a removed device can be deleted.");
      for (const c of copies.forDevice(d.id)) copies.disconnect(c.id);
      const destIds = conn.prepare("SELECT id FROM offsite_destinations WHERE device_id = ?").all(d.id).map((x) => x.id);
      const steps = [
        ["chunk_totals", "DELETE FROM chunk_totals WHERE device_id = ?"],
        ["chunks", "DELETE FROM chunks WHERE device_id = ?"],
        ["version_totals", "DELETE FROM version_totals WHERE device_id = ?"],
        ["file_versions", "DELETE FROM file_versions WHERE device_id = ?"],
        ["commands", "DELETE FROM commands WHERE device_id = ?"],
        ["alerts", "DELETE FROM alerts WHERE device_id = ?"],
        ["device_folders", "DELETE FROM device_folders WHERE device_id = ?"],
        ["agent_updates", "DELETE FROM agent_updates WHERE device_id = ?"],
        ["device_health", "DELETE FROM device_health WHERE device_id = ?"],
        ["offsite_objects", "DELETE FROM offsite_objects WHERE device_id = ?"],
        ["offsite_destinations", "DELETE FROM offsite_destinations WHERE device_id = ?"],
        ["device_removals", "DELETE FROM device_removals WHERE device_id = ?"],
        ["devices", "DELETE FROM devices WHERE id = ?"],
      ];
      conn.exec("BEGIN IMMEDIATE");
      try {
        for (const [t, sql] of steps) if (table(t)) conn.prepare(sql).run(d.id);
        for (const id of destIds) {
          for (const t of ["offsite_objects", "offsite_packs", "offsite_catalogs", "offsite_drive_folders"]) {
            if (table(t)) conn.prepare(`DELETE FROM ${t} WHERE dest_id = ?`).run(id);
          }
        }
        conn.exec("COMMIT");
      } catch (err) {
        conn.exec("ROLLBACK");
        throw err;
      }
      // The encrypted chunks on disk (can take a while for a big device: done in the background)
      if (/^dev_[A-Za-z0-9_-]+$/.test(d.id)) {
        fs.promises.rm(path.join(dir, "devices", d.id), { recursive: true, force: true })
          .then(() => log.info(`${who(d)}: its stored backups were deleted`))
          .catch((err) => log.error(`Deleting the stored backups of ${who(d)} failed: ${err.message}`));
      }
      log.info(`${who(d)} was deleted for good`);
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

    // ---- Deleting removed devices automatically ----

    autoDelete() {
      return { days: autoDeleteDays(), choices: AUTO_DELETE_DAYS };
    },

    setAutoDelete(days, by) {
      if (!AUTO_DELETE_DAYS.includes(days)) throw new Error("Pick one of the choices.");
      q.setMeta.run("auto_delete_days", String(days));
      log.info(days ? `${by} set removed devices to be deleted ${days} days after they're removed` : `${by} turned off deleting removed devices automatically`);
    },

    // When this removed device is deleted by itself, and whether it's kept
    autoDeleteOf(deviceId) {
      const r = q.get.get(deviceId);
      return { at: deleteAt(r), keep: !!r?.keep, days: autoDeleteDays() };
    },

    keep(d, keep, by) {
      const r = q.get.get(d.id);
      if (!r || !["done", "forgotten"].includes(r.state)) return false;
      q.keep.run(keep ? 1 : 0, d.id);
      log.info(`${by} ${keep ? "kept" : "stopped keeping"} the backups of ${who(d)}`);
      return true;
    },

    // Called once at start, with what deleting for good needs
    start({ copies, dataDir: dir }) {
      purgeWith = { copies, dataDir: dir };
    },

    // Every hour: the alert 3 days before, then the delete
    async autoDeleteTick() {
      if (!purgeWith || deleting || !autoDeleteDays()) return;
      deleting = true;
      try {
        for (const r of q.all.all()) {
          const at = deleteAt(r);
          if (!at) continue;
          const d = db.getDevice(r.device_id);
          if (!d || d.status === "active") continue;
          const when = Date.parse(at);
          if (Date.now() >= when) {
            const stored = db.storageStats().find((x) => x.device_id === d.id)?.stored ?? 0;
            await api.purge(d, purgeWith);
            store?.audit("gateway", "device.deleted", { device: d.device_name, client: d.client_name, storedBytes: stored, automatic: true }, null);
            security?.event("info", "agent.deleted", `${who(d)} and its backups were deleted, ${autoDeleteDays()} days after it was removed`, {
              detail: { device: d.device_name, client: d.client_name, storedBytes: stored },
            });
          } else if (!r.warned_at && Date.now() >= when - WARN_MS) {
            q.warned.run(new Date().toISOString(), d.id);
            const day = new Date(when).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
            security?.event("medium", "agent.delete-soon", `The backups of ${who(d)} will be deleted on ${day}. To keep them, open the device and choose Keep its backups.`, {
              deviceId: d.id,
              detail: { deleteAt: at },
            });
          }
        }
      } catch (err) {
        log.error(`Deleting removed devices automatically failed: ${err.message}`);
      } finally {
        deleting = false;
      }
    },
  };
  return api;
}
