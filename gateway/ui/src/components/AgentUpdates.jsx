// Agent updates: the on/off switch and a summary on the Devices page, a version line per device,
// and the agent card on each device's page (update now, hold, or set up the updater once).

import { useState } from "react";
import { ArrowUpCircle, Check, CircleAlert, Copy, LoaderCircle, PauseCircle, RefreshCw, Wrench } from "lucide-react";
import { api } from "../api.js";
import { usePolling } from "../usePolling.js";
import { timeAgo } from "../format.js";
import Modal from "./Modal.jsx";
import { primaryButton, secondaryButton } from "./buttons.js";

export function useUpdates() {
  return usePolling("/updates", 10000);
}

// What a device's agent is doing, in a few words
export function updateLine(u, gatewayVersion) {
  if (!u?.version) return { text: "agent version unknown", tone: "text-dim" };
  if (u.state === "current") return { text: `agent ${u.version}`, tone: "text-dim", icon: Check };
  if (!u.capable) return { text: `agent ${u.version} · needs updater setup`, tone: "text-warn", icon: Wrench };
  if (u.hold) return { text: `agent ${u.version} · held (${gatewayVersion} available)`, tone: "text-dim", icon: PauseCircle };
  if (u.state === "failed") return { text: `agent ${u.version} · update failed`, tone: "text-alert", icon: CircleAlert };
  if (["offered", "downloading", "staged", "applying"].includes(u.state)) return { text: `agent ${u.version} · updating to ${gatewayVersion}`, tone: "text-secure", icon: RefreshCw, spin: true };
  return { text: `agent ${u.version} · ${gatewayVersion} available`, tone: "text-secure", icon: ArrowUpCircle };
}

export function UpdateLine({ u, gatewayVersion }) {
  const l = updateLine(u, gatewayVersion);
  const Icon = l.icon;
  return (
    <span className={`inline-flex items-center gap-1 text-xs ${l.tone}`}>
      {Icon && <Icon size={12} className={l.spin ? "animate-spin motion-reduce:animate-none" : ""} aria-hidden="true" />}
      {l.text}
    </span>
  );
}

function Switch({ on, onChange, busy, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={busy}
      onClick={() => onChange(!on)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors ${on ? "border-signal bg-signal" : "border-edge bg-raised"}`}
    >
      <span className={`inline-block h-4 w-4 rounded-full bg-fg transition-transform ${on ? "translate-x-6" : "translate-x-1"}`} />
    </button>
  );
}

// The strip at the top of the Devices page
export function UpdatesBar({ data, reload }) {
  const [busy, setBusy] = useState(false);
  if (!data?.version) return null;
  const list = data.devices;
  const current = list.filter((d) => d.state === "current").length;
  const updating = list.filter((d) => ["offered", "downloading", "staged", "applying"].includes(d.state)).length;
  const needSetup = list.filter((d) => d.state !== "current" && !d.capable).length;
  const failed = list.filter((d) => d.state === "failed").length;
  async function toggle(on) {
    setBusy(true);
    try {
      await api.post("/updates/policy", { auto: on });
      reload();
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="glass mb-8 flex flex-col gap-4 rounded-lg border border-edge px-5 py-4 md:flex-row md:items-center md:justify-between">
      <div className="text-sm">
        <p className="text-fg">
          This gateway has agent <span className="font-mono">{data.version}</span>
        </p>
        <p className="mt-0.5 text-dim">
          {current} of {list.length} device{list.length === 1 ? "" : "s"} up to date
          {updating ? ` · ${updating} updating` : ""}
          {failed ? ` · ${failed} failed (kept their version)` : ""}
          {needSetup ? ` · ${needSetup} need the updater set up once (on their page)` : ""}
        </p>
      </div>
      <label className="flex items-center gap-3 text-sm">
        <span>
          <span className="block text-fg">Automatic updates</span>
          <span className="block text-xs text-dim">{data.auto ? "A few devices at a time, each checked after" : "Only when you click Update now"}</span>
        </span>
        <Switch on={data.auto} busy={busy} onChange={toggle} label="Automatic agent updates" />
      </label>
    </section>
  );
}

function CommandBox({ label, command }) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <p className="mb-1.5 text-xs text-dim">{label}</p>
      <div className="flex items-stretch gap-2">
        <code className="min-w-0 flex-1 break-all rounded-md border border-edge bg-night px-3 py-2 font-mono text-xs text-fg">{command}</code>
        <button
          type="button"
          className={`${secondaryButton} h-auto px-3`}
          onClick={async () => {
            await navigator.clipboard.writeText(command).catch(() => {});
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          aria-label="Copy"
        >
          {copied ? <Check size={15} className="text-good" /> : <Copy size={15} />}
        </button>
      </div>
    </div>
  );
}

function SetupUpdater({ deviceId, deviceName, platform, onClose }) {
  const [kind, setKind] = useState(platform ?? "linux");
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function make() {
    setBusy(true);
    setError("");
    try {
      setResult(await api.post(`/devices/${deviceId}/updater-link`, { platform: kind }));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={`Turn on automatic updates for ${deviceName}`} onClose={onClose} wide>
      <div className="space-y-4 text-sm">
        <p className="text-dim">
          This agent was installed before it could update itself. Run one command on the device, once: it installs the current
          agent with its updater, and keeps the device&rsquo;s identity, folders and settings. After that, updates arrive by themselves.
        </p>
        {!result ? (
          <>
            <div className="flex flex-wrap gap-2" role="group" aria-label="Kind of device">
              {[
                ["linux", "Linux"],
                ["synology", "Synology"],
                ["windows", "Windows"],
              ].map(([id, label]) => (
                <button key={id} type="button" aria-pressed={kind === id} onClick={() => setKind(id)} className={`rounded-md border px-3 py-1.5 ${kind === id ? "border-signal bg-signal/10 text-fg" : "border-edge text-dim hover:text-fg"}`}>
                  {label}
                </button>
              ))}
            </div>
            <button type="button" className={primaryButton} disabled={busy} onClick={make}>
              {busy && <LoaderCircle size={16} className="animate-spin" />}
              Make the command
            </button>
          </>
        ) : (
          <>
            {result.commands.map((c) => (
              <CommandBox key={c.id} label={c.label} command={c.command} />
            ))}
            <p className="text-xs text-dim">Works for an hour. {result.platform === "windows" ? "Run it as Administrator." : "It asks for the device's admin password (sudo)."}</p>
          </>
        )}
        {error && <p className="text-alert">{error}</p>}
      </div>
    </Modal>
  );
}

// The agent card on a device's page
export function DeviceAgent({ deviceId, deviceName }) {
  const { data, reload } = useUpdates();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [setup, setSetup] = useState(false);
  const u = data?.devices.find((d) => d.id === deviceId);
  if (!data || !u) return null;

  async function act(action) {
    setBusy(action);
    setError("");
    try {
      await api.post(`/devices/${deviceId}/update`, { action });
      reload();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  }
  const updating = ["offered", "downloading", "staged", "applying"].includes(u.state);
  const stateText = {
    offered: "Offered to the device…",
    downloading: "Downloading and checking the signed package…",
    staged: "Downloaded; the updater is installing it…",
    applying: "Installing; the agent restarts in a moment…",
  }[u.state];

  return (
    <section className="mb-10">
      <h2 className="mb-3 font-medium">Agent</h2>
      <div className="glass flex flex-col gap-4 rounded-lg border border-edge px-5 py-4 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0 text-sm">
          <p className="text-fg">
            Version <span className="font-mono">{u.version ?? "unknown"}</span>
            {u.state === "current" ? <span className="ml-2 text-good">up to date</span> : <span className="ml-2 text-dim">({data.version} available)</span>}
          </p>
          <p className="mt-0.5 text-dim">
            {u.state === "current"
              ? "Newer agents install by themselves when this gateway gets them."
              : !u.capable
                ? "This agent can't update itself yet: set up its updater once."
                : updating
                  ? stateText
                  : u.state === "failed"
                    ? `Last try ${timeAgo(u.changedAt)} failed: ${u.message}`
                    : u.hold
                      ? "Held at this version: it won't update until you resume."
                      : data.auto
                        ? "It updates on its own shortly."
                        : "Automatic updates are off: click Update now."}
          </p>
          {error && <p className="mt-1 text-alert">{error}</p>}
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {u.state !== "current" && !u.capable && (
            <button type="button" className={primaryButton} onClick={() => setSetup(true)}>
              <Wrench size={15} />
              Turn on automatic updates
            </button>
          )}
          {u.state !== "current" && u.capable && (
            <button type="button" className={primaryButton} disabled={!!busy || updating} onClick={() => act("now")}>
              {busy === "now" ? <LoaderCircle size={15} className="animate-spin" /> : <ArrowUpCircle size={15} />}
              {u.state === "failed" ? "Try again" : "Update now"}
            </button>
          )}
          {u.capable && (
            <button type="button" className={secondaryButton} disabled={!!busy} onClick={() => act(u.hold ? "resume" : "hold")}>
              {u.hold ? "Allow updates" : "Hold at this version"}
            </button>
          )}
        </div>
      </div>
      {setup && <SetupUpdater deviceId={deviceId} deviceName={deviceName} platform={u.installPlatform} onClose={() => setSetup(false)} />}
    </section>
  );
}
