// Background behaviour for one device: priority, upload speed limits by time of day, pausing on
// battery or hotspot, pausing by hand, and live vs scheduled change detection.

import { useEffect, useState } from "react";
import { api } from "../api.js";
import { timeAgo } from "../format.js";
import { inputClass, primaryButton, secondaryButton } from "./buttons.js";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const INTERVALS = [
  [15, "15 minutes"],
  [30, "30 minutes"],
  [60, "1 hour"],
  [120, "2 hours"],
  [240, "4 hours"],
  [720, "12 hours"],
  [1440, "24 hours"],
];

function Switch({ checked, onChange, label, hint }) {
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div className="min-w-0">
        <p className="text-sm text-fg">{label}</p>
        {hint && <p className="mt-0.5 text-sm text-dim">{hint}</p>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={`relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors ${checked ? "bg-signal" : "bg-raised ring-1 ring-edge"}`}
      >
        <span
          className={`absolute left-0 top-0.5 h-5 w-5 rounded-full bg-fg transition-transform ${checked ? "translate-x-5.5" : "translate-x-0.5"}`}
          aria-hidden="true"
        />
      </button>
    </div>
  );
}

function SpeedInput({ id, label, value, onChange }) {
  return (
    <label htmlFor={id} className="block">
      <span className="text-sm text-dim">{label}</span>
      <div className="mt-1 flex items-center gap-2">
        <div className="w-36">
          <input
            id={id}
            type="number"
            min="0.1"
            step="0.1"
            inputMode="decimal"
            placeholder="Unlimited"
            value={value ?? ""}
            onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
            className={inputClass}
          />
        </div>
        <span className="text-sm text-dim">Mbps</span>
      </div>
    </label>
  );
}

// One line about what the agent is doing right now
function LiveStatus({ status, live }) {
  if (!live || !status) return <p className="text-sm text-dim">The device will report its status when it&rsquo;s connected.</p>;
  let text;
  let tone = "text-good";
  if (status.paused) {
    text = `Paused: ${status.paused}`;
    tone = "text-warn";
  } else if (status.limitMbps) {
    text = `Uploading at up to ${status.limitMbps} Mbps (${status.workHours ? "work hours" : "outside work hours"})`;
  } else {
    text = `Uploading at full speed (${status.workHours ? "work hours" : "outside work hours"})`;
  }
  return (
    <div className="space-y-1 text-sm">
      <p className={tone}>{text}</p>
      <p className="text-dim">
        {status.scanMode === "scheduled" ? "Scheduled scans" : "Live change detection"}
        {status.lastScanAt && `, last full scan ${timeAgo(status.lastScanAt)}`}
        {status.onBattery === true && " · on battery"}
        {status.metered === true && " · metered connection"}
      </p>
      {status.watchLimitHit && (
        <p className="text-warn">
          This device couldn&rsquo;t watch all its files live, so it switched to a full scan every 15 minutes. Choose a
          scheduled scan below, or raise the system&rsquo;s watch limit.
        </p>
      )}
    </div>
  );
}

export default function DeviceSettings({ deviceId, settings, status, live, disabled, onSaved }) {
  const [form, setForm] = useState(settings);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  // Pick up the saved settings when the page refreshes, unless there are unsaved edits
  const [base, setBase] = useState(settings);
  useEffect(() => {
    if (JSON.stringify(settings) !== JSON.stringify(base)) {
      setForm((f) => (JSON.stringify(f) === JSON.stringify(base) ? settings : f));
      setBase(settings);
    }
  }, [settings, base]);

  const dirty = JSON.stringify(form) !== JSON.stringify(base);
  const set = (key, value) => {
    setMessage("");
    setForm((f) => ({ ...f, [key]: value }));
  };
  const setHours = (key, value) => set("workHours", { ...form.workHours, [key]: value });
  const toggleDay = (d) =>
    setHours("days", form.workHours.days.includes(d) ? form.workHours.days.filter((x) => x !== d) : [...form.workHours.days, d].sort());

  async function save() {
    setSaving(true);
    setError("");
    try {
      const { settings: saved } = await api.post(`/devices/${deviceId}/settings`, { settings: form });
      setForm(saved);
      setBase(saved);
      setMessage(live ? "Saved. The device applies it within seconds." : "Saved. The device applies it when it reconnects.");
      onSaved?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="mb-10">
      <h2 className="font-medium">Background behaviour</h2>
      <p className="mb-3 mt-1 max-w-2xl text-sm text-dim">
        How hard this device may work, and when. Restores are never slowed down or paused.
      </p>
      <div className="panel-cut rounded-lg border border-edge bg-surface">
        <div className="border-b border-edge px-5 py-4">
          <LiveStatus status={status} live={live} />
        </div>

        <fieldset disabled={disabled} className="divide-y divide-edge px-5 disabled:opacity-60">
          <div>
            <Switch
              label="Pause all backups"
              hint="Changes are still tracked and sent when you turn this off. Useful during a big file move."
              checked={form.paused}
              onChange={(v) => set("paused", v)}
            />
            <Switch
              label="Run at low priority"
              hint="Backups always give way to whatever the user is doing."
              checked={form.lowPriority}
              onChange={(v) => set("lowPriority", v)}
            />
            <Switch
              label="Pause on battery power"
              hint="For laptops. Desktops and NAS devices aren't affected."
              checked={form.pauseOnBattery}
              onChange={(v) => set("pauseOnBattery", v)}
            />
            <Switch
              label="Pause on a metered connection"
              hint="Phone hotspot or mobile data. Detected on Windows and Linux."
              checked={form.pauseOnMetered}
              onChange={(v) => set("pauseOnMetered", v)}
            />
          </div>

          <div className="py-4">
            <p className="text-sm text-fg">Upload speed</p>
            <p className="mt-0.5 text-sm text-dim">Keeps the office internet usable. Leave empty for unlimited.</p>
            <div className="mt-3 flex flex-wrap gap-x-8 gap-y-4">
              <SpeedInput id="work-limit" label="During work hours" value={form.workLimitMbps} onChange={(v) => set("workLimitMbps", v)} />
              <SpeedInput id="off-limit" label="Outside work hours" value={form.offHoursLimitMbps} onChange={(v) => set("offHoursLimitMbps", v)} />
            </div>
            <div className="mt-5">
              <p className="text-sm text-dim">Work hours, in the device&rsquo;s own time zone</p>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <div className="w-36">
                  <input
                    type="time"
                    aria-label="Work hours start"
                    value={form.workHours.start}
                    onChange={(e) => setHours("start", e.target.value)}
                    className={`${inputClass} [color-scheme:dark]`}
                  />
                </div>
                <span className="text-sm text-dim">to</span>
                <div className="w-36">
                  <input
                    type="time"
                    aria-label="Work hours end"
                    value={form.workHours.end}
                    onChange={(e) => setHours("end", e.target.value)}
                    className={`${inputClass} [color-scheme:dark]`}
                  />
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5" role="group" aria-label="Work days">
                {DAYS.map((name, d) => {
                  const on = form.workHours.days.includes(d);
                  return (
                    <button
                      key={name}
                      type="button"
                      aria-pressed={on}
                      onClick={() => toggleDay(d)}
                      className={`h-9 w-12 rounded-md border text-sm ${on ? "border-signal bg-signal/15 text-fg" : "border-edge text-dim hover:text-fg"}`}
                    >
                      {name}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="py-4">
            <p className="text-sm text-fg">Change detection</p>
            <div className="mt-2 space-y-2 text-sm">
              <label className="flex cursor-pointer items-start gap-3">
                <input
                  type="radio"
                  name="scanMode"
                  className="mt-1 accent-signal"
                  checked={form.scanMode === "live"}
                  onChange={() => set("scanMode", "live")}
                />
                <span>
                  <span className="text-fg">Live</span>
                  <span className="block text-dim">Changes are backed up within seconds. Best for PCs and normal shares.</span>
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-3">
                <input
                  type="radio"
                  name="scanMode"
                  className="mt-1 accent-signal"
                  checked={form.scanMode === "scheduled"}
                  onChange={() => set("scanMode", "scheduled")}
                />
                <span>
                  <span className="text-fg">Scheduled scan</span>
                  <span className="block text-dim">
                    Checks everything at a fixed interval. Lighter for very large NAS shares (hundreds of thousands of files).
                  </span>
                </span>
              </label>
              {form.scanMode === "scheduled" && (
                <label className="ml-7 flex items-center gap-2">
                  <span className="text-dim">Every</span>
                  <div className="w-40">
                    <select
                      value={form.scanIntervalMinutes}
                      onChange={(e) => set("scanIntervalMinutes", Number(e.target.value))}
                      aria-label="Scan interval"
                      className={inputClass}
                    >
                      {INTERVALS.map(([v, label]) => (
                        <option key={v} value={v}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </div>
                </label>
              )}
            </div>
          </div>
        </fieldset>

        <div className="flex flex-wrap items-center justify-end gap-3 border-t border-edge px-5 py-4">
          {error && <p className="mr-auto text-sm text-alert">{error}</p>}
          {!error && message && <p className="mr-auto text-sm text-good">{message}</p>}
          {dirty && (
            <button type="button" className={secondaryButton} onClick={() => setForm(base)} disabled={saving}>
              Undo changes
            </button>
          )}
          <button type="button" className={primaryButton} onClick={save} disabled={disabled || !dirty || saving}>
            {saving ? "Saving" : "Save"}
          </button>
        </div>
      </div>
    </section>
  );
}
