// How the agent behaves in the background, set per device from the web UI:
//   - low priority: backups always give way to whatever the user is doing
//   - upload speed limits, with different limits during and outside work hours
//   - pause on battery power, and on metered connections (phone hotspot, mobile data)
//   - pause all backups by hand
// Work hours are in this device's own local time. Restores are never slowed down or paused.

import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { log } from "./logger.js";

const CHECK_MS = 60_000;

export const DEFAULT_SETTINGS = {
  lowPriority: true,
  workLimitMbps: null,     // null = unlimited
  offHoursLimitMbps: null,
  workHours: { start: "08:00", end: "17:00", days: [1, 2, 3, 4, 5] }, // 0 = Sunday
  pauseOnBattery: true,
  pauseOnMetered: true,
  scanMode: "live",        // "live" = instant, "scheduled" = scan every scanIntervalMinutes
  scanIntervalMinutes: 60,
  paused: false,
};

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 15_000, windowsHide: true }, (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

// true = on battery, false = plugged in, null = no battery / can't tell (desktops, NAS)
async function detectOnBattery() {
  if (process.platform === "linux") {
    const base = "/sys/class/power_supply";
    let names;
    try {
      names = await fs.readdir(base);
    } catch {
      return null;
    }
    let hasBattery = false;
    for (const name of names) {
      const read = (f) => fs.readFile(path.join(base, name, f), "utf8").then((s) => s.trim()).catch(() => "");
      const type = await read("type");
      if (type === "Battery") hasBattery = true;
      if ((type === "Mains" || type === "USB") && (await read("online")) === "1") return false;
    }
    return hasBattery ? true : null;
  }
  if (process.platform === "darwin") {
    const out = await run("pmset", ["-g", "batt"]);
    if (!out) return null;
    if (out.includes("'Battery Power'")) return true;
    if (out.includes("'AC Power'")) return false;
    return null;
  }
  if (process.platform === "win32") {
    const out = await run("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      "(Get-CimInstance -ClassName Win32_Battery | Select-Object -First 1).BatteryStatus",
    ]);
    const status = Number(out?.trim());
    if (!out?.trim() || !Number.isFinite(status)) return null;
    return status === 1; // 1 = discharging
  }
  return null;
}

// true = metered (hotspot / mobile data), false = normal, null = can't tell
async function detectMetered() {
  if (process.platform === "linux") {
    const out = await run("nmcli", ["-t", "-f", "GENERAL.STATE,GENERAL.METERED", "device", "show"]);
    if (!out) return null;
    const lines = out.split("\n");
    let connected = false;
    let result = false;
    for (const line of lines) {
      if (line.startsWith("GENERAL.STATE:")) connected = line.includes("(connected)");
      if (connected && line.startsWith("GENERAL.METERED:") && line.slice(16).startsWith("yes")) result = true;
    }
    return result;
  }
  if (process.platform === "win32") {
    const out = await run("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      "[void][Windows.Networking.Connectivity.NetworkInformation,Windows.Networking.Connectivity,ContentType=WindowsRuntime];" +
        "$p=[Windows.Networking.Connectivity.NetworkInformation]::GetInternetConnectionProfile();" +
        "if($p){$p.GetConnectionCost().NetworkCostType}",
    ]);
    const cost = out?.trim();
    if (!cost) return null;
    return cost === "Fixed" || cost === "Variable";
  }
  return null; // macOS has no simple way to ask
}

function minutesOf(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

export function createPolicy({ onChange }) {
  let settings = { ...DEFAULT_SETTINGS };
  let onBattery = null;
  let metered = null;
  let lastBlock = undefined;
  let nextSendAt = 0;
  let timer = null;

  function inWorkHours(now = new Date()) {
    const { start, end, days } = settings.workHours;
    const minute = now.getHours() * 60 + now.getMinutes();
    const [s, e] = [minutesOf(start), minutesOf(end)];
    // A shift that crosses midnight (e.g. 22:00-06:00) counts from the day it started
    if (s <= e) return days.includes(now.getDay()) && minute >= s && minute < e;
    if (minute >= s) return days.includes(now.getDay());
    return minute < e && days.includes((now.getDay() + 6) % 7);
  }

  function limitMbps() {
    return inWorkHours() ? settings.workLimitMbps : settings.offHoursLimitMbps;
  }

  // Why uploads are paused right now, or null if they may run
  function blockReason() {
    if (settings.paused) return "turned off in the web UI";
    if (settings.pauseOnBattery && onBattery === true) return "on battery power";
    if (settings.pauseOnMetered && metered === true) return "on a metered connection (hotspot or mobile data)";
    return null;
  }

  async function check() {
    if (settings.pauseOnBattery) onBattery = await detectOnBattery();
    if (settings.pauseOnMetered) metered = await detectMetered();
    const block = blockReason();
    if (block !== lastBlock) {
      if (block) log.info(`Backups paused: ${block}. Changes are still tracked and will be sent later.`);
      else if (lastBlock) log.info("Backups resumed");
      lastBlock = block;
      onChange?.();
    }
  }

  function applyPriority() {
    try {
      os.setPriority(0, settings.lowPriority ? 10 : 0); // 10 = "below normal" on Windows too
    } catch (err) {
      // Raising priority again needs admin rights on Linux/Mac; it returns to normal on restart
      log.debug(`Could not change process priority: ${err.message}`);
    }
  }

  return {
    apply(next) {
      const before = JSON.stringify(settings);
      settings = { ...DEFAULT_SETTINGS, ...(next ?? {}) };
      if (before === JSON.stringify(settings) && timer) return;
      applyPriority();
      const limit = (v) => (v ? `${v} Mbps` : "unlimited");
      log.info(
        `Background settings: ${settings.lowPriority ? "low priority" : "normal priority"}, upload ` +
          `${limit(settings.workLimitMbps)} in work hours / ${limit(settings.offHoursLimitMbps)} outside, ` +
          `${settings.scanMode === "live" ? "live change detection" : `scan every ${settings.scanIntervalMinutes} min`}`
      );
      clearInterval(timer);
      timer = setInterval(check, CHECK_MS);
      timer.unref();
      check();
    },
    get: () => settings,
    blockReason,

    // Waits as long as needed so uploads stay under the current speed limit (on average)
    async throttle(bytes) {
      const mbps = limitMbps();
      if (!mbps) return;
      const bytesPerMs = (mbps * 1_000_000) / 8 / 1000;
      const now = Date.now();
      const start = Math.max(now, nextSendAt);
      nextSendAt = start + bytes / bytesPerMs;
      if (start > now) await new Promise((r) => setTimeout(r, start - now));
    },

    status: () => ({
      paused: blockReason(),
      limitMbps: limitMbps() ?? null,
      workHours: inWorkHours(),
      onBattery,
      metered,
      lowPriority: settings.lowPriority,
    }),
    stop: () => clearInterval(timer),
  };
}
