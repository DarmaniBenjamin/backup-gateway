// Background settings for each device: how hard the agent may work and when.
// Edited in the web UI and delivered to the agent together with its folder list.

export const DEFAULT_SETTINGS = {
  lowPriority: true,
  workLimitMbps: null,     // upload speed limit during work hours, null = unlimited
  offHoursLimitMbps: null, // outside work hours
  workHours: { start: "08:00", end: "17:00", days: [1, 2, 3, 4, 5] }, // device's local time, 0 = Sunday
  pauseOnBattery: true,
  pauseOnMetered: true,
  scanMode: "live",        // "live" or "scheduled"
  scanIntervalMinutes: 60,
  paused: false,
};

export const SCAN_INTERVALS = [15, 30, 60, 120, 240, 720, 1440];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export class SettingsError extends Error {}

function speed(value, label) {
  if (value === null || value === undefined || value === "" || value === 0) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0.1 || n > 10_000) throw new SettingsError(`${label} must be between 0.1 and 10000 Mbps, or empty for unlimited.`);
  return Math.round(n * 10) / 10;
}

// Checks settings from the web UI and fills in anything missing with the defaults
export function cleanSettings(input) {
  const s = { ...DEFAULT_SETTINGS, ...(input ?? {}) };
  const wh = { ...DEFAULT_SETTINGS.workHours, ...(s.workHours ?? {}) };
  if (!TIME_RE.test(wh.start) || !TIME_RE.test(wh.end)) throw new SettingsError("Work hours must look like 08:00.");
  if (wh.start === wh.end) throw new SettingsError("Work hours must start and end at different times.");
  const days = [...new Set(Array.isArray(wh.days) ? wh.days : [])].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort();
  if (!["live", "scheduled"].includes(s.scanMode)) throw new SettingsError("Unknown change detection mode.");
  if (!SCAN_INTERVALS.includes(Number(s.scanIntervalMinutes))) throw new SettingsError("Pick one of the scan intervals offered.");

  return {
    lowPriority: !!s.lowPriority,
    workLimitMbps: speed(s.workLimitMbps, "The work-hours limit"),
    offHoursLimitMbps: speed(s.offHoursLimitMbps, "The outside-work-hours limit"),
    workHours: { start: wh.start, end: wh.end, days },
    pauseOnBattery: !!s.pauseOnBattery,
    pauseOnMetered: !!s.pauseOnMetered,
    scanMode: s.scanMode,
    scanIntervalMinutes: Number(s.scanIntervalMinutes),
    paused: !!s.paused,
  };
}

export function settingsOf(device) {
  try {
    return cleanSettings(device.settings ? JSON.parse(device.settings) : null);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

// What the agent reports about itself: paused or not, current limit, battery, scan mode
export function cleanAgentStatus(s) {
  if (!s || typeof s !== "object") return null;
  const text = (v) => (typeof v === "string" ? v.slice(0, 200) : null);
  const bool = (v) => (typeof v === "boolean" ? v : null);
  return {
    paused: text(s.paused),
    limitMbps: Number.isFinite(s.limitMbps) ? s.limitMbps : null,
    workHours: bool(s.workHours),
    onBattery: bool(s.onBattery),
    metered: bool(s.metered),
    lowPriority: bool(s.lowPriority),
    scanMode: s.scanMode === "scheduled" ? "scheduled" : "live",
    watchLimitHit: bool(s.watchLimitHit),
    lastScanAt: text(s.lastScanAt),
  };
}
