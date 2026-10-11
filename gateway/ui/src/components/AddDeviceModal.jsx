// Adds a device. Pick the client and the kind of device, fill in what it may back up, and get
// ONE command to paste on the device: it downloads the agent from this gateway, checks it,
// installs it as a background service and connects — no code or settings to type in.
// The command (and the one-time enrollment code inside it) is shown once and works once.

import { useState } from "react";
import { Check, Copy, HardDrive, KeyRound, Laptop, LoaderCircle, Monitor, Server, TriangleAlert } from "lucide-react";
import { api } from "../api.js";
import { formatDateTime } from "../format.js";
import Modal from "./Modal.jsx";
import { inputClass, primaryButton, secondaryButton } from "./buttons.js";

const PLATFORMS = [
  { id: "linux", label: "Linux PC or server", note: "Ubuntu, Debian, Fedora, Arch… with systemd", icon: Server },
  { id: "windows", label: "Windows PC", note: "Coming soon", icon: Monitor, soon: true },
  { id: "mac", label: "Mac", note: "Coming soon", icon: Laptop, soon: true },
  { id: "synology", label: "Synology NAS", note: "Coming soon", icon: HardDrive, soon: true },
  { id: "manual", label: "Just the code", note: "Set the agent up by hand", icon: KeyRound },
];

function CopyBox({ id, text, label, large = false }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard not allowed (e.g. not on a secure address) — select the text so it can be copied by hand
      const range = document.createRange();
      range.selectNodeContents(document.getElementById(id));
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(range);
    }
  }
  return (
    <div className="flex items-start gap-2">
      <pre
        id={id}
        className={`min-w-0 flex-1 whitespace-pre-wrap break-all rounded-md border border-edge bg-night px-3 py-2.5 font-mono text-fg ${
          large ? "text-lg tracking-wider sm:text-xl" : "text-xs leading-relaxed"
        }`}
      >
        {text}
      </pre>
      <button type="button" onClick={copy} className={`${secondaryButton} shrink-0`} aria-label={label}>
        {copied ? <Check size={16} className="text-good" /> : <Copy size={16} />}
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

function Field({ id, label, hint, children }) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm text-dim">
        {label}
      </label>
      {children}
      {hint && <p className="mt-1.5 text-xs text-dim">{hint}</p>}
    </div>
  );
}

function Result({ result, onClose }) {
  const { install } = result;
  return (
    <Modal
      title={install ? "Install command ready" : "Enrollment code"}
      onClose={onClose}
      wide
      footer={
        <button type="button" className={primaryButton} onClick={onClose}>
          Done
        </button>
      }
    >
      <p className="text-sm text-dim">
        For <span className="text-fg">{result.clientName}</span>. Works once, until {formatDateTime(result.expiresAt)}.
      </p>

      {install ? (
        <>
          <h3 className="mt-5 font-display text-sm font-semibold text-fg">Paste this in a terminal on the new device</h3>
          <div className="mt-2">
            <CopyBox id="install-command" text={install.command} label="Copy install command" />
          </div>
          <p className="mt-3 text-sm text-dim">
            It asks for the device&rsquo;s password (sudo), then downloads the agent from this gateway, checks it, installs it as a
            background service that starts with the computer, and connects. The device shows up here within a minute.
          </p>
          {install.localOnly && (
            <p className="mt-3 flex gap-2 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn">
              <TriangleAlert size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
              <span>
                The gateway only accepts agents from this computer right now, so this command only works here. For other devices,
                set <span className="font-mono">GATEWAY_HOST=0.0.0.0</span> and{" "}
                <span className="font-mono">GATEWAY_PUBLIC_URL</span> in the gateway&rsquo;s .env, restart it, and create a new
                command.
              </span>
            </p>
          )}
          <details className="mt-5 text-sm">
            <summary className="cursor-pointer text-dim hover:text-fg">Set it up by hand instead</summary>
            <p className="mt-2 text-dim">Put this line in the agent&rsquo;s .env file, then start the agent:</p>
            <div className="mt-2">
              <CopyBox id="enroll-line" text={`AGENT_ENROLL_CODE=${result.code}`} label="Copy code line" />
            </div>
          </details>
        </>
      ) : (
        <>
          <div className="mt-4">
            <CopyBox id="enroll-code" text={result.code} label="Copy code" large />
          </div>
          <p className="mt-4 text-sm text-dim">Put this line in the agent&rsquo;s .env file, then start the agent:</p>
          <div className="mt-2">
            <CopyBox id="enroll-line" text={`AGENT_ENROLL_CODE=${result.code}`} label="Copy code line" />
          </div>
        </>
      )}
      <p className="mt-5 text-sm text-dim">This won&rsquo;t be shown again. If you lose it, just create a new one.</p>
    </Modal>
  );
}

export default function AddDeviceModal({ clients, onClose }) {
  const [clientName, setClientName] = useState("");
  const [platform, setPlatform] = useState("linux");
  const [allowed, setAllowed] = useState("/home");
  const [deviceName, setDeviceName] = useState("");
  const [watch, setWatch] = useState("");
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleCreate(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const body = { clientName: clientName.trim() };
      if (platform !== "manual") Object.assign(body, { platform, allowed, deviceName, watch });
      setResult(await api.post("/enrollment-codes", body));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (result) return <Result result={result} onClose={onClose} />;

  const canCreate = clientName.trim() && (platform === "manual" || allowed.trim());
  return (
    <Modal
      title="Add a device"
      onClose={onClose}
      wide
      footer={
        <>
          <button type="button" className={secondaryButton} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="add-device" className={primaryButton} disabled={busy || !canCreate}>
            {busy && <LoaderCircle size={16} className="animate-spin" />}
            {platform === "manual" ? "Create code" : "Create install command"}
          </button>
        </>
      }
    >
      <form id="add-device" onSubmit={handleCreate} className="space-y-5">
        <Field id="client-name" label="Client" hint="Pick an existing client to add another device to them.">
          <input
            id="client-name"
            list="known-clients"
            autoComplete="off"
            placeholder="e.g. Law Firm"
            value={clientName}
            onChange={(e) => setClientName(e.target.value)}
            className={inputClass}
          />
          <datalist id="known-clients">
            {clients.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </Field>

        <fieldset>
          <legend className="mb-1.5 text-sm text-dim">Kind of device</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {PLATFORMS.map((p) => {
              const selected = platform === p.id;
              const Icon = p.icon;
              return (
                <label
                  key={p.id}
                  className={`flex items-center gap-3 rounded-md border px-3 py-2.5 has-focus-visible:ring-2 has-focus-visible:ring-signal ${
                    p.soon
                      ? "cursor-not-allowed border-edge opacity-50"
                      : selected
                        ? "cursor-pointer border-signal bg-signal/10"
                        : "cursor-pointer border-edge hover:bg-raised"
                  }`}
                >
                  <input
                    type="radio"
                    name="platform"
                    value={p.id}
                    checked={selected}
                    disabled={p.soon}
                    onChange={() => setPlatform(p.id)}
                    className="sr-only"
                  />
                  <Icon size={20} className={selected ? "text-signal" : "text-dim"} aria-hidden="true" />
                  <span className="min-w-0">
                    <span className="block text-sm text-fg">{p.label}</span>
                    <span className="block text-xs text-dim">{p.note}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>

        {platform === "linux" && (
          <>
            <Field
              id="allowed"
              label="Allowed folders"
              hint={
                <>
                  The only folders the gateway may ever back up or browse on this device, separated by{" "}
                  <span className="font-mono text-fg">;</span> — e.g.{" "}
                  <span className="font-mono text-fg">/home;/srv/shared</span>. They&rsquo;re locked in on the device itself.
                </>
              }
            >
              <input
                id="allowed"
                autoComplete="off"
                spellCheck={false}
                value={allowed}
                onChange={(e) => setAllowed(e.target.value)}
                className={`${inputClass} font-mono`}
              />
            </Field>
            <div className="grid gap-5 sm:grid-cols-2">
              <Field id="device-name" label="Device name (optional)" hint="Empty = the computer's own name.">
                <input
                  id="device-name"
                  autoComplete="off"
                  placeholder="e.g. reception-pc"
                  value={deviceName}
                  onChange={(e) => setDeviceName(e.target.value)}
                  className={inputClass}
                />
              </Field>
              <Field id="watch" label="Start backing up (optional)" hint="A folder inside the allowed ones. Add more later.">
                <input
                  id="watch"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="e.g. /home/anna/Documents"
                  value={watch}
                  onChange={(e) => setWatch(e.target.value)}
                  className={`${inputClass} font-mono`}
                />
              </Field>
            </div>
          </>
        )}

        {error && (
          <p role="alert" className="rounded-md border border-alert/40 bg-alert/10 px-3 py-2 text-sm text-alert">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}
