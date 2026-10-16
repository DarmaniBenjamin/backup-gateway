// Device health reports (src/device-health.js) turned into alerts, and their category (notify.js)
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../src/db.js";
import { createDeviceHealth, cleanHealth } from "../src/device-health.js";
import { categoryOf } from "../src/notify/notify.js";

const device = { id: "dev_1", device_name: "FRONT-DESK", client_name: "Acme" };

function setup() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bg-health-"));
  openDatabase(dataDir).close();
  // A real gateway already has a device_health table (health.js, the offline checks): it must not clash
  const raw = new DatabaseSync(path.join(dataDir, "gateway.db"));
  raw.exec("CREATE TABLE device_health (device_id TEXT PRIMARY KEY, offline_since TEXT NOT NULL, notified_at TEXT NOT NULL)");
  raw.close();
  const events = [];
  const health = createDeviceHealth({ dataDir, security: { event: (severity, kind, title, opts) => events.push({ severity, kind, title, ...opts }) } });
  return { health, events, cleanup: () => fs.rmSync(dataDir, { recursive: true, force: true }) };
}

const pulledPlug = { id: 1, kind: "unexpected-shutdown", severity: "critical", title: "Shut down without warning (power loss, cable pulled, or the system froze), then started again", at: "2026-10-16T08:00:00Z" };

test("a pulled plug is one critical alert (the helpdesk makes a ticket), sent once", (t) => {
  const s = setup();
  t.after(s.cleanup);
  const ack = s.health.report(device, { problems: [], events: [pulledPlug] });
  assert.equal(ack, 1, "the agent is told it arrived");
  assert.equal(s.events.length, 1);
  assert.equal(s.events[0].severity, "critical");
  assert.equal(s.events[0].kind, "health.unexpected-shutdown");
  assert.equal(s.events[0].deviceId, "dev_1");
  assert.match(s.events[0].title, /^FRONT-DESK \(Acme\): Shut down without warning/);
  // The agent sends it again before it hears back: not a second alert
  s.health.report(device, { problems: [], events: [pulledPlug] });
  assert.equal(s.events.length, 1);
});

test("a problem: alert when it appears, again only if it gets worse, back to normal when it's gone", (t) => {
  const s = setup();
  t.after(s.cleanup);
  const low = { id: "disk-low-c", severity: "high", title: "C: is 92% full" };
  s.health.report(device, { problems: [low], events: [] });
  s.health.report(device, { problems: [low], events: [] });
  assert.equal(s.events.length, 1, "the same problem again is not a new alert");
  s.health.report(device, { problems: [{ ...low, severity: "critical", title: "C: is 97% full" }], events: [] });
  assert.equal(s.events.length, 2);
  assert.equal(s.events[1].severity, "critical");
  s.health.report(device, { problems: [], events: [] });
  const back = s.events[2];
  assert.equal(back.kind, "health.disk-low-c", "the same kind, so the helpdesk resolves the same alert");
  assert.equal(back.detail.recovers, true);
  assert.equal(back.detail.problemSeverity, "critical");
});

test("what a device sends is cleaned: odd ids, severities and sizes are dropped", () => {
  const h = cleanHealth({
    problems: [{ id: "../evil", severity: "high", title: "x" }, { id: "ok-one", severity: "nope", title: "x" }, { id: "fine", severity: "low", title: "a".repeat(1000) }],
    events: [{ id: -1, kind: "x", severity: "high", title: "x" }, { id: 2, kind: "crash", severity: "critical", title: "Crashed\u0000 (blue screen)" }],
  });
  assert.deepEqual(h.problems.map((p) => p.id), ["fine"]);
  assert.equal(h.problems[0].title.length, 300);
  assert.deepEqual(h.events.map((e) => e.kind), ["crash"]);
  assert.doesNotMatch(h.events[0].title, /\u0000/);
});

test("health events have their own alert category", () => {
  assert.equal(categoryOf("health.unexpected-shutdown"), "health");
  assert.equal(categoryOf("health.disk-low-c"), "health");
  assert.equal(categoryOf("device.offline"), "offline");
});

test("an agent that just restarted (nothing checked yet) doesn't clear its problems", (t) => {
  const s = setup();
  t.after(s.cleanup);
  const low = { id: "disk-low", severity: "high", title: "Disk almost full: / 8 GB free (3 %)" };
  s.health.report(device, { problems: [low], events: [] });
  s.health.report(device, { problems: null, events: [] }); // first heartbeat after a restart
  assert.equal(s.events.length, 1, "no false 'back to normal'");
  s.health.report(device, { problems: [low], events: [] }); // its first check: still there
  assert.equal(s.events.length, 1, "and no second alert for the same problem");
  assert.equal(s.health.view("dev_1").problems.length, 1);
});
