// Device health: notices when the device isn't well, besides backing it up. Every few minutes it
// checks, and the results ride along with the heartbeat to the gateway (connection.js), which turns
// them into alerts (Security page, phone, and the helpdesk's Alerts page; critical ones make a ticket).
//
// Two kinds of finding:
//   problems  something wrong right now (a disk almost full, a restart needed): sent with every
//             heartbeat; the gateway raises an alert when one appears and "back to normal" when it goes
//   events    something that happened (it shut down without warning, an update failed): sent until the
//             gateway confirms it has them, then dropped
//
// What's checked:
//   all          restarted, and whether it shut down properly first; disks filling up; CPU or memory
//                flat out for 15 minutes
//   Windows      crashes (blue screens), power loss and improper shutdowns (Windows' own records),
//                Windows Update failures and restarts pending, drive health, Defender (off, threats)
//   Linux        restart needed after updates, failed system services, RAID (mdadm)
//   Synology     RAID (every DSM volume), drive health (SMART)
// It only reads system health information, never the content of files.

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "./logger.js";

const CHECK_MS = process.platform === "win32" ? 10 * 60_000 : 5 * 60_000;
const SMART_MS = 60 * 60_000;
const BUSY_CHECKS = 3; // CPU or memory flat out this many checks in a row (about 15 minutes)
const MAX_EVENTS = 50;
const IS_SYNOLOGY = process.platform === "linux" && fs.existsSync("/etc.defaults/VERSION") && fs.existsSync("/etc/synoinfo.conf");
const REAL_FS = new Set(["ext2", "ext3", "ext4", "xfs", "btrfs", "zfs", "f2fs", "vfat", "exfat", "ntfs", "ntfs3", "fuseblk", "reiserfs", "jfs"]);
const SKIP_MOUNTS = /^\/(proc|sys|dev|run|snap|var\/lib\/docker|boot\/efi)(\/|$)/;

const run = (cmd, args, timeout = 60_000) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve(err && !stdout ? null : String(stdout)));
  });

const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 100) : null);
const gb = (bytes) => `${(bytes / 1024 ** 3).toFixed(bytes < 10 * 1024 ** 3 ? 1 : 0)} GB`;
const readText = (file) => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
};

// ---- Pieces that don't need the device (also tested on their own) ----------------------------------

// Disks below 10 % free (critical below 3 %): one problem listing them all
export function diskProblem(disks) {
  const low = disks.filter((d) => d.total >= 1024 ** 3 && d.free / d.total < 0.1);
  if (!low.length) return null;
  const worst = Math.min(...low.map((d) => d.free / d.total));
  return {
    id: "disk-low",
    severity: worst < 0.03 ? "critical" : "high",
    title: `Disk almost full: ${low.map((d) => `${d.name} ${gb(d.free)} free (${pct(d.free, d.total)} %)`).join(", ")}`,
  };
}

// Linux software RAID (and every Synology volume): degraded or rebuilding
export function raidProblems(mdstat) {
  if (!mdstat) return [];
  const out = [];
  const lines = mdstat.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const head = lines[i].match(/^(md\d+)\s*:\s*active\s+(\S+)/);
    if (!head) continue;
    const status = lines[i + 1] ?? "";
    const progress = lines.slice(i + 1, i + 4).join(" ");
    const disks = status.match(/\[([U_]+)\]/)?.[1];
    if (disks?.includes("_")) {
      const missing = [...disks].filter((c) => c === "_").length;
      out.push({ id: "raid-degraded", severity: "critical", title: `Disk array ${head[1]} (${head[2]}) is degraded: ${missing} of ${disks.length} disks missing or failed` });
    } else if (/\b(recovery|resync|reshape)\s*=/.test(progress)) {
      const done = progress.match(/=\s*([\d.]+%)/)?.[1] ?? "";
      out.push({ id: "raid-rebuilding", severity: "medium", title: `Disk array ${head[1]} is rebuilding ${done}`.trim() });
    }
  }
  // One of each: the worst array decides
  return [out.find((p) => p.id === "raid-degraded"), out.find((p) => p.id === "raid-rebuilding")].filter(Boolean);
}

// What a reboot looked like, from the boot ID and whether the agent was stopped properly before
export function bootEvent({ bootId, previousBootId, cleanStop }) {
  if (!previousBootId || !bootId || bootId === previousBootId) return null;
  return cleanStop
    ? { kind: "restarted", severity: "info", title: "Restarted" }
    : { kind: "unexpected-shutdown", severity: "critical", title: "Shut down without warning (power loss, cable pulled, or the system froze), then started again" };
}

// Windows' own records, from health-windows.ps1, as events
export function windowsEvents(records) {
  const out = [];
  const crash = records.filter((r) => r.id === 1001 && /bugcheck|WER-SystemErrorReporting/i.test(r.provider ?? ""));
  const powerLoss = records.filter((r) => r.id === 41 || r.id === 6008);
  if (crash.length) out.push({ kind: "crash", severity: "critical", title: "Crashed (blue screen) and restarted", detail: crash[0].msg, at: crash[0].at });
  else if (powerLoss.length) out.push({ kind: "unexpected-shutdown", severity: "critical", title: "Shut down without warning (power loss, cable pulled, or the system froze), then started again", detail: powerLoss[0].msg, at: powerLoss[0].at });
  const failed = records.filter((r) => r.id === 20 && /WindowsUpdateClient/i.test(r.provider ?? ""));
  if (failed.length) out.push({ kind: "update-failed", severity: "high", title: `Windows Update failed to install ${failed.length === 1 ? "an update" : `${failed.length} updates`}`, detail: failed.map((r) => r.msg).join("\n").slice(0, 900), at: failed[0].at });
  const started = records.filter((r) => r.id === 43 && /WindowsUpdateClient/i.test(r.provider ?? ""));
  if (started.length) out.push({ kind: "updating", severity: "info", title: "Windows is installing updates", detail: started.map((r) => r.msg).join("\n").slice(0, 900), at: started[0].at });
  return out;
}

// ---- The monitor -------------------------------------------------------------------------------------

export function createHealth({ dataDir, deviceName = os.hostname() }) {
  const file = path.join(dataDir, "health-state.json");
  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    state = {};
  }
  state.events ??= [];
  state.nextId ??= 1;
  const save = () => {
    try {
      fs.writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
    } catch (err) {
      log.warn(`Health: couldn't save its state (${err.message})`);
    }
  };

  let problems = [];
  let checked = false; // until the first check is done, "no problems" isn't known (see report)
  let facts = {};
  let busy = 0;
  let lastCpu = os.cpus().map((c) => c.times);
  let lastSmart = 0;
  let smartProblem = null;
  let timer = null;

  function addEvent(e) {
    state.events.push({ id: state.nextId++, at: e.at ?? new Date().toISOString(), kind: e.kind, severity: e.severity, title: e.title, detail: e.detail ?? null });
    if (state.events.length > MAX_EVENTS) state.events.splice(0, state.events.length - MAX_EVENTS);
    log.info(`Health: ${e.title}`);
    save();
  }

  // CPU in use since the last check, across all cores (0-100)
  function cpuBusy() {
    const now = os.cpus().map((c) => c.times);
    let busyTime = 0;
    let total = 0;
    now.forEach((t, i) => {
      const p = lastCpu[i] ?? { user: 0, nice: 0, sys: 0, irq: 0, idle: 0 };
      const d = { user: t.user - p.user, nice: t.nice - p.nice, sys: t.sys - p.sys, irq: t.irq - p.irq, idle: t.idle - p.idle };
      busyTime += d.user + d.nice + d.sys + d.irq;
      total += d.user + d.nice + d.sys + d.irq + d.idle;
    });
    lastCpu = now;
    return pct(busyTime, total);
  }

  function memoryUsed() {
    const info = readText("/proc/meminfo");
    const avail = info ? Number(info.match(/MemAvailable:\s+(\d+)/)?.[1]) * 1024 : os.freemem();
    return pct(os.totalmem() - avail, os.totalmem());
  }

  function busyProblem(cpu, mem) {
    busy = cpu >= 95 || mem >= 95 ? busy + 1 : 0;
    if (busy < BUSY_CHECKS) return null;
    const what = [cpu >= 95 ? `CPU at ${cpu} %` : null, mem >= 95 ? `memory at ${mem} %` : null].filter(Boolean).join(" and ");
    return { id: "overloaded", severity: "medium", title: `Struggling: ${what} for 15 minutes or more` };
  }

  function linuxDisks() {
    const mounts = readText("/proc/mounts") ?? "";
    const seen = new Set();
    const disks = [];
    for (const line of mounts.split("\n")) {
      const [dev, mount, type] = line.split(" ");
      if (!dev || !REAL_FS.has(type) || SKIP_MOUNTS.test(mount) || seen.has(dev)) continue;
      if (IS_SYNOLOGY && !/^\/volume\d+$/.test(mount)) continue; // DSM's own partitions aren't the user's concern
      seen.add(dev);
      try {
        const s = fs.statfsSync(mount);
        disks.push({ name: mount, total: s.blocks * s.bsize, free: s.bavail * s.bsize });
      } catch {
        // gone, or not readable
      }
    }
    return disks;
  }

  async function smartCheck() {
    if (Date.now() - lastSmart < SMART_MS) return smartProblem;
    lastSmart = Date.now();
    const scan = await run("smartctl", ["--scan"], 20_000);
    if (!scan) return (smartProblem = null); // not installed, or no rights
    const failing = [];
    for (const dev of scan.split("\n").map((l) => l.split(" ")[0]).filter((d) => d.startsWith("/dev/"))) {
      const out = await run("smartctl", ["-H", dev], 20_000);
      if (out && /FAILED|FAILING_NOW|not PASSED/i.test(out) && !/PASSED|\bOK\b/.test(out)) failing.push(dev);
    }
    smartProblem = failing.length ? { id: "disk-failing", severity: "critical", title: `Disk failing its health check: ${failing.join(", ")}. Replace it soon.` } : null;
    return smartProblem;
  }

  async function checkLinux() {
    const found = [];
    // Restarted, and how
    const bootId = (readText("/proc/sys/kernel/random/boot_id") ?? "").trim();
    const boot = bootEvent({ bootId, previousBootId: state.bootId, cleanStop: state.cleanStop });
    if (boot) addEvent(boot);
    if (bootId && (bootId !== state.bootId || state.cleanStop)) {
      state.bootId = bootId;
      state.cleanStop = false;
      save();
    }
    const disks = linuxDisks();
    found.push(diskProblem(disks));
    found.push(...raidProblems(readText("/proc/mdstat")));
    if (IS_SYNOLOGY) found.push(await smartCheck());
    else {
      if (fs.existsSync("/var/run/reboot-required")) {
        const pkgs = (readText("/var/run/reboot-required.pkgs") ?? "").split("\n").filter(Boolean);
        found.push({ id: "restart-needed", severity: "low", title: `Needs a restart to finish installing updates${pkgs.length ? ` (${pkgs.slice(0, 5).join(", ")})` : ""}` });
      }
      const failed = await run("systemctl", ["list-units", "--state=failed", "--no-legend", "--plain", "--type=service"], 15_000);
      const units = (failed ?? "").split("\n").map((l) => l.trim().split(/\s+/)[0]).filter((u) => u && u.endsWith(".service"));
      if (units.length) found.push({ id: "services-failed", severity: "medium", title: `${units.length === 1 ? "A system service has" : `${units.length} system services have`} stopped with an error: ${units.slice(0, 6).join(", ")}` });
    }
    // On a Synology: its DSM version, so the gateway knows it's a NAS (no desktop to share)
    const dsm = IS_SYNOLOGY ? readText("/etc.defaults/VERSION") : null;
    const dsmVersion = dsm ? [dsm.match(/^productversion="?([^"\n]+)/m)?.[1], dsm.match(/^buildnumber="?([^"\n]+)/m)?.[1]].filter(Boolean).join("-") : null;
    facts = {
      ...facts,
      ...(dsm ? { os: `Synology DSM ${dsmVersion || ""}`.trim() } : {}),
      disks: disks.map((d) => ({ name: d.name, total: d.total, free: d.free })),
      bootedAt: new Date(Date.now() - os.uptime() * 1000).toISOString(),
    };
    return found;
  }

  async function checkWindows() {
    const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "health-windows.ps1");
    const since = state.lastEventScan ?? new Date().toISOString(); // first run: from now, not the whole history
    const out = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-Since", since], 120_000);
    let r;
    try {
      r = JSON.parse(out ?? "");
    } catch {
      log.warn("Health: the Windows check gave no answer");
      return problems; // keep what was known
    }
    // Restarted: Windows' own records say whether it was clean
    const records = Array.isArray(r.events) ? r.events : r.events ? [r.events] : [];
    const recorded = windowsEvents(records);
    if (state.lastBoot && r.lastBoot && r.lastBoot !== state.lastBoot && !recorded.some((e) => e.kind === "crash" || e.kind === "unexpected-shutdown")) {
      addEvent({ kind: "restarted", severity: "info", title: "Restarted" });
    }
    for (const e of recorded) addEvent(e);
    state.lastBoot = r.lastBoot ?? state.lastBoot;
    state.lastEventScan = r.now ?? new Date().toISOString();
    save();

    const found = [];
    const disks = (Array.isArray(r.disks) ? r.disks : r.disks ? [r.disks] : []).map((d) => ({ name: d.name, total: Number(d.size), free: Number(d.free) }));
    found.push(diskProblem(disks));
    const physical = Array.isArray(r.physical) ? r.physical : r.physical ? [r.physical] : [];
    const bad = physical.filter((p) => p.health && !/^healthy$/i.test(p.health));
    if (bad.length) found.push({ id: "disk-failing", severity: "critical", title: `Disk health: ${bad.map((p) => `${p.name} is ${p.health}`).join(", ")}. Replace it soon.` });
    if (r.rebootPending) found.push({ id: "restart-needed", severity: "low", title: "Needs a restart to finish installing Windows updates" });
    if (r.defender && r.defender.mode === "Normal") {
      if (r.defender.realTime === false || r.defender.antivirus === false) found.push({ id: "antivirus-off", severity: "high", title: "Microsoft Defender's real-time protection is turned off" });
    }
    const threats = Array.isArray(r.threats) ? r.threats : r.threats ? [r.threats] : [];
    if (threats.length) addEvent({ kind: "threat-found", severity: "critical", title: `Microsoft Defender found ${threats.length === 1 ? "a threat" : `${threats.length} threats`}`, detail: threats.map((t) => t.name).filter(Boolean).join(", ").slice(0, 900) });
    facts = { ...facts, disks, bootedAt: r.lastBoot ?? null, os: r.os ?? null };
    return found;
  }

  async function check() {
    try {
      const found = process.platform === "win32" ? await checkWindows() : process.platform === "linux" ? await checkLinux() : [];
      const cpu = cpuBusy();
      const mem = memoryUsed();
      found.push(busyProblem(cpu, mem));
      problems = found.filter(Boolean);
      checked = true;
      facts = { ...facts, cpu, mem, os: facts.os ?? `${os.type()} ${os.release()}`, name: deviceName, hostname: os.hostname(), checkedAt: new Date().toISOString() };
    } catch (err) {
      log.warn(`Health check failed: ${err.message}`);
    }
  }

  return {
    start() {
      check();
      timer = setInterval(check, CHECK_MS);
      timer.unref();
    },
    stop() {
      clearInterval(timer);
    },
    // The service is being stopped properly (shutdown, restart, update): not a power loss
    markCleanStop() {
      state.cleanStop = true;
      try {
        fs.writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
      } catch {
        // nothing more to do while stopping
      }
    },
    // What goes with the heartbeat
    // problems: null until the first check after starting, so the gateway keeps what it knew
    // instead of taking "nothing checked yet" for "everything fixed"
    report: () => ({ problems: checked ? problems : null, events: state.events.slice(-20), facts }),
    // The gateway has these events: drop them
    ack(lastId) {
      if (!Number.isInteger(lastId)) return;
      const before = state.events.length;
      state.events = state.events.filter((e) => e.id > lastId);
      if (state.events.length !== before) save();
    },
    check, // for the tests
  };
}
