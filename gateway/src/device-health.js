// Device health, as reported by each agent with its heartbeat (agent/src/health.js): shutdowns,
// crashes, updates, disks, RAID, antivirus... Turned into security events, so they show on the
// Security page and go out as alerts (category "Device health"); the helpdesk keeps them all on its
// Alerts page, and critical ones (an improper shutdown, a failing disk) make a ticket.
//
//   problems  what's wrong now, with every heartbeat: an alert when one appears or gets worse,
//             "back to normal" when it's gone (which resolves it in the helpdesk)
//   events    what happened: each one once, then the agent is told it arrived (healthAck)
//
// Event kinds are "health.<what>", e.g. health.unexpected-shutdown, health.disk-low.

import { DatabaseSync } from "node:sqlite";
import path from "node:path";

const SEVERITIES = ["info", "low", "medium", "high", "critical"];
const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const text = (v, max) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max) : "");
const iso = (v) => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);
const num = (v) => (Number.isFinite(v) ? v : null);

// What an agent sent, made safe: anything odd is dropped, not trusted
export function cleanHealth(raw) {
  if (!raw || typeof raw !== "object") return null;
  // null: the agent hasn't checked yet since it started (keep what was known)
  const problems = !Array.isArray(raw.problems) ? null : raw.problems
    .slice(0, 20)
    .map((p) => ({ id: String(p?.id ?? ""), severity: SEVERITIES.includes(p?.severity) ? p.severity : null, title: text(p?.title, 300) }))
    .filter((p) => ID.test(p.id) && p.severity && p.title);
  const events = (Array.isArray(raw.events) ? raw.events : [])
    .slice(-20)
    .map((e) => ({
      id: Number.isSafeInteger(e?.id) && e.id > 0 ? e.id : null,
      kind: String(e?.kind ?? ""),
      severity: SEVERITIES.includes(e?.severity) ? e.severity : null,
      title: text(e?.title, 300),
      detail: text(e?.detail, 900) || null,
      at: iso(e?.at),
    }))
    .filter((e) => e.id && ID.test(e.kind) && e.severity && e.title);
  const f = raw.facts && typeof raw.facts === "object" ? raw.facts : {};
  const facts = {
    os: text(f.os, 120) || null,
    cpu: num(f.cpu),
    mem: num(f.mem),
    bootedAt: iso(f.bootedAt),
    checkedAt: iso(f.checkedAt),
    disks: (Array.isArray(f.disks) ? f.disks : []).slice(0, 26).map((d) => ({ name: text(d?.name, 60), total: num(d?.total), free: num(d?.free) })).filter((d) => d.name && d.total),
  };
  return { problems: problems && [...new Map(problems.map((p) => [p.id, p])).values()], events, facts };
}

export function createDeviceHealth({ dataDir, security }) {
  const conn = new DatabaseSync(path.join(dataDir, "gateway.db"));
  conn.exec(`
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS device_condition (
      device_id     TEXT PRIMARY KEY,
      problems      TEXT NOT NULL DEFAULT '[]',
      facts         TEXT,
      last_event_id INTEGER NOT NULL DEFAULT 0,
      updated_at    TEXT NOT NULL
    );
  `);
  const q = {
    get: conn.prepare("SELECT * FROM device_condition WHERE device_id = ?"),
    save: conn.prepare(`INSERT INTO device_condition (device_id, problems, facts, last_event_id, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(device_id) DO UPDATE SET problems = excluded.problems, facts = excluded.facts, last_event_id = excluded.last_event_id, updated_at = excluded.updated_at`),
    forget: conn.prepare("DELETE FROM device_condition WHERE device_id = ?"),
  };
  const who = (d) => `${d.device_name} (${d.client_name})`;
  const rank = (s) => SEVERITIES.indexOf(s);

  return {
    // A heartbeat's health report. Returns the last event id it has, for the agent (healthAck).
    report(device, raw) {
      const h = cleanHealth(raw);
      const row = q.get.get(device.id);
      const before = row ? JSON.parse(row.problems) : [];
      let lastId = row?.last_event_id ?? 0;
      if (!h) return lastId;

      // Something that happened: once each
      for (const e of h.events) {
        if (e.id <= lastId) continue;
        security.event(e.severity, `health.${e.kind}`, `${who(device)}: ${e.title}`, {
          deviceId: device.id,
          detail: { ...(e.detail ? { detail: e.detail } : {}), at: e.at },
        });
        lastId = Math.max(lastId, e.id);
      }
      // An agent that started over (reinstalled): its numbers start again from 1
      if (h.events.length && Math.max(...h.events.map((e) => e.id)) < lastId && !h.events.some((e) => e.id === lastId)) {
        lastId = Math.max(...h.events.map((e) => e.id));
      }

      // Not checked yet since the agent started: keep the problems as they were
      if (!h.problems) {
        q.save.run(device.id, JSON.stringify(before), JSON.stringify(h.facts), lastId, new Date().toISOString());
        return lastId;
      }
      // What's wrong now: new, or worse than before
      for (const p of h.problems) {
        const old = before.find((b) => b.id === p.id);
        if (!old || rank(p.severity) > rank(old.severity)) {
          security.event(p.severity, `health.${p.id}`, `${who(device)}: ${p.title}`, { deviceId: device.id, detail: { problem: p.id } });
        }
      }
      // Gone: back to normal (resolves it in the helpdesk too)
      for (const b of before) {
        if (!h.problems.some((p) => p.id === b.id)) {
          security.event("info", `health.${b.id}`, `${who(device)}: back to normal (was: ${b.title})`, {
            deviceId: device.id,
            // problemSeverity: "back to normal" goes wherever the problem went (notify.js)
            detail: { problem: b.id, recovers: true, problemSeverity: b.severity },
          });
        }
      }
      q.save.run(device.id, JSON.stringify(h.problems), JSON.stringify(h.facts), lastId, new Date().toISOString());
      return lastId;
    },

    // For the device's page
    view(deviceId) {
      const row = q.get.get(deviceId);
      if (!row) return null;
      return { problems: JSON.parse(row.problems), facts: row.facts ? JSON.parse(row.facts) : null, updatedAt: row.updated_at };
    },

    forget: (deviceId) => q.forget.run(deviceId),
  };
}
