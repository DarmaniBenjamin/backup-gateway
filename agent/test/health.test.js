// Device health (src/health.js)
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bootEvent, diskProblem, raidProblems, windowsEvents, createHealth } from "../src/health.js";

const GB = 1024 ** 3;

test("power cut or cable pulled: critical; a proper restart: info; same boot: nothing", () => {
  assert.equal(bootEvent({ bootId: "b2", previousBootId: "b1", cleanStop: false }).severity, "critical");
  assert.equal(bootEvent({ bootId: "b2", previousBootId: "b1", cleanStop: false }).kind, "unexpected-shutdown");
  assert.equal(bootEvent({ bootId: "b2", previousBootId: "b1", cleanStop: true }).kind, "restarted");
  assert.equal(bootEvent({ bootId: "b1", previousBootId: "b1", cleanStop: false }), null, "the agent restarting isn't the device restarting");
  assert.equal(bootEvent({ bootId: "b1", previousBootId: undefined, cleanStop: false }), null, "first run after install");
});

test("disks: below 10 % free is high, below 3 % critical, small or healthy ones ignored", () => {
  assert.equal(diskProblem([{ name: "C:", total: 500 * GB, free: 200 * GB }]), null);
  assert.equal(diskProblem([{ name: "C:", total: 500 * GB, free: 40 * GB }]).severity, "high");
  assert.equal(diskProblem([{ name: "/volume1", total: 4000 * GB, free: 80 * GB }]).severity, "critical");
  assert.equal(diskProblem([{ name: "/boot", total: 0.5 * GB, free: 0.01 * GB }]), null, "tiny partitions aren't counted");
  assert.match(diskProblem([{ name: "C:", total: 500 * GB, free: 40 * GB }]).title, /C: 40 GB free \(8 %\)/);
});

test("RAID: a missing disk is critical, a rebuild is medium, healthy is nothing", () => {
  const healthy = "md2 : active raid1 sda5[0] sdb5[1]\n      3896291584 blocks super 1.2 [2/2] [UU]\n";
  const degraded = "md2 : active raid1 sda5[0]\n      3896291584 blocks super 1.2 [2/1] [U_]\n";
  const rebuilding = "md2 : active raid1 sdb5[2] sda5[0]\n      3896291584 blocks super 1.2 [2/2] [UU]\n      [=>...]  recovery = 7.5% (2900/38962) finish=300min\n";
  assert.deepEqual(raidProblems(healthy), []);
  assert.equal(raidProblems(degraded)[0].severity, "critical");
  assert.match(raidProblems(degraded)[0].title, /1 of 2 disks missing/);
  assert.equal(raidProblems(rebuilding)[0].id, "raid-rebuilding");
});

test("Windows records: blue screen and power loss are critical, update failures high", () => {
  const power = windowsEvents([{ id: 41, provider: "Microsoft-Windows-Kernel-Power", msg: "The system has rebooted without cleanly shutting down first." }]);
  assert.equal(power[0].kind, "unexpected-shutdown");
  assert.equal(power[0].severity, "critical");
  const bsod = windowsEvents([
    { id: 41, provider: "Microsoft-Windows-Kernel-Power" },
    { id: 1001, provider: "Microsoft-Windows-WER-SystemErrorReporting", msg: "The computer has rebooted from a bugcheck." },
  ]);
  assert.deepEqual(bsod.map((e) => e.kind), ["crash"], "a blue screen is reported as a crash, once");
  const upd = windowsEvents([{ id: 20, provider: "Microsoft-Windows-WindowsUpdateClient", msg: "Installation Failure: KB5034441" }]);
  assert.equal(upd[0].kind, "update-failed");
  assert.equal(upd[0].severity, "high");
});

test("events wait until the gateway has them, and survive a restart of the agent", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "health-"));
  const h = createHealth({ dataDir: dir });
  await h.check();
  const before = h.report().events.length;
  // A power cut: the state file says a different boot, and no clean stop
  const state = JSON.parse(fs.readFileSync(path.join(dir, "health-state.json"), "utf8"));
  if (process.platform === "linux") {
    fs.writeFileSync(path.join(dir, "health-state.json"), JSON.stringify({ ...state, bootId: "an-earlier-boot", cleanStop: false }));
    const again = createHealth({ dataDir: dir });
    await again.check();
    const events = again.report().events;
    assert.equal(events.length, before + 1);
    assert.equal(events.at(-1).kind, "unexpected-shutdown");
    again.ack(events.at(-1).id);
    assert.equal(again.report().events.length, before);
    // A clean stop, then the same boot: nothing new
    again.markCleanStop();
    const third = createHealth({ dataDir: dir });
    await third.check();
    assert.equal(third.report().events.length, before);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a real check on this computer reports disks, CPU and memory", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "health-"));
  const h = createHealth({ dataDir: dir });
  await h.check();
  const r = h.report();
  assert.ok(Array.isArray(r.problems));
  assert.ok(Number.isInteger(r.facts.mem));
  if (process.platform === "linux") assert.ok(r.facts.disks.length > 0);
  fs.rmSync(dir, { recursive: true, force: true });
});
