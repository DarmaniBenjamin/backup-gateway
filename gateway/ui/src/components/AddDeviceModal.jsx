// Adds a device. Pick the client and the kind of device, fill in what it may back up, and get
// ONE command to paste on the device: it downloads the agent from this gateway, checks it,
// installs it as a background service and connects — no code or settings to type in.
// The command (and the one-time enrollment code inside it) is shown once and works once.

import { useState } from "react";
import { Check, Copy, Download, HardDrive, KeyRound, Laptop, LoaderCircle, Monitor, Server, TriangleAlert } from "lucide-react";
import { api } from "../api.js";
import { formatDateTime } from "../format.js";
import Modal from "./Modal.jsx";
import { inputClass, primaryButton, secondaryButton } from "./buttons.js";

const PLATFORMS = [
  { id: "linux", label: "Linux PC or server", note: "Ubuntu, Debian, Fedora, Arch… with systemd", icon: Server },
  { id: "windows", label: "Windows PC or server", note: "Windows 10/11, Server 2016+", icon: Monitor },
  { id: "mac", label: "Mac", note: "Coming soon", icon: Laptop, soon: true },
  { id: "synology", label: "Synology NAS", note: "DSM 7 or newer, over SSH", icon: HardDrive },
  { id: "manual", label: "Just the code", note: "Set the agent up by hand", icon: KeyRound },
];

// Folder examples for each kind of device
const EXAMPLES = {
  linux: { allowed: "/home", allowedMany: "/home;/srv/shared", watch: "/home/anna/Documents" },
  windows: { allowed: "C:\\Users", allowedMany: "C:\\Users;D:\\Shared", watch: "C:\\Users\\Anna\\Documents" },
  synology: { allowed: "/volume1/Clients", allowedMany: "/volume1/Clients;/volume1/homes", watch: "/volume1/Clients/Accounts" },
};

// What to do with the command, for each kind of device
const HOW_TO = {
  windows:
    "Open PowerShell or Command Prompt as Administrator (right-click > Run as administrator) and paste. It downloads the agent from this gateway, checks it, installs it as a background task that starts with Windows, and connects.",
  synology:
    "On the NAS, turn on SSH (Control Panel > Terminal & SNMP > Enable SSH service), then connect with an administrator account (e.g. ssh admin@192.168.1.20) and paste. It asks for that account\u2019s password (sudo), then downloads the agent from this gateway, checks it, installs it as a service that starts with the NAS, and connects. You can turn SSH off again afterwards.",
  linux:
    "It asks for the device\u2019s password (sudo), then downloads the agent from this gateway, checks it, installs it as a background service that starts with the computer, and connects.",
};

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
          {install.setupUrl && (
            <>
              <h3 className="mt-5 font-display text-sm font-semibold text-fg">Easiest: the setup program</h3>
              <p className="mt-1 text-sm text-dim">
                Download it and put it on the new PC (or open the link below in a browser on that PC), then double-click{" "}
                <span className="font-mono text-fg">BackupAgentSetup.exe</span> and allow it to make changes.
              </p>
              <a href={install.setupUrl} className={`${primaryButton} mt-3 w-full sm:w-auto`} download="BackupAgentSetup.exe">
                <Download size={16} aria-hidden="true" />
                Download BackupAgentSetup.exe
              </a>
              <p className="mb-1 mt-3 text-xs text-dim">Download link for the new PC</p>
              <CopyBox id="setup-url" text={install.setupUrl} label="Copy download link" />
              <p className="mt-2 text-xs text-dim">
                Windows may say it &ldquo;protected your PC&rdquo; because the program isn&rsquo;t code-signed yet: click More info, then
                Run anyway.
              </p>
            </>
          )}
          <h3 className="mt-5 font-display text-sm font-semibold text-fg">
            {install.platform === "windows"
              ? install.setupUrl
                ? "Or paste one command"
                : "Paste one command on the new PC"
              : install.platform === "synology"
                ? "Paste this in an SSH session on the NAS"
                : "Paste this in a terminal on the new device"}
          </h3>
          {install.commands.map((c) => (
            <div key={c.id} className="mt-2">
              {install.commands.length > 1 && <p className="mb-1 text-xs text-dim">{c.label}</p>}
              <CopyBox id={`cmd-${c.id}`} text={c.command} label={`Copy ${c.label} command`} />
            </div>
          ))}
          <p className="mt-3 text-sm text-dim">
            {HOW_TO[install.platform] ?? HOW_TO.linux}{" "}
            The device shows up here within a minute.
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
  const [allowed, setAllowed] = useState(EXAMPLES.linux.allowed);
  const examples = EXAMPLES[platform];

  // Switching between Linux and Windows swaps the example folders, unless they were changed
  function choosePlatform(id) {
    const defaults = Object.values(EXAMPLES).map((e) => e.allowed);
    if (EXAMPLES[id] && defaults.includes(allowed)) setAllowed(EXAMPLES[id].allowed);
    setPlatform(id);
  }
  const [fullAccess, setFullAccess] = useState(false);
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
      if (platform !== "manual") Object.assign(body, { platform, allowed, fullAccess, deviceName, watch });
      setResult(await api.post("/enrollment-codes", body));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (result) return <Result result={result} onClose={onClose} />;

  const canCreate = clientName.trim() && (platform === "manual" || fullAccess || allowed.trim());
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
                    onChange={() => choosePlatform(p.id)}
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

        {examples && (
          <>
            <label className="flex cursor-pointer gap-3 rounded-md border border-edge bg-raised/40 px-4 py-3">
              <input
                type="checkbox"
                checked={fullAccess}
                onChange={(e) => setFullAccess(e.target.checked)}
                className="mt-1 size-4 shrink-0 accent-signal"
              />
              <span className="text-sm">
                <span className="font-medium text-fg">Full access</span>
                <span className="mt-0.5 block text-dim">
                  See every folder on this device, hidden and system ones too, back up anything and restore anywhere. Once
                  you&rsquo;ve chosen the folders, lock them with a key so they can&rsquo;t be changed without it. This can only
                  be set here, when the device is installed.
                </span>
              </span>
            </label>
            {!fullAccess && (
              <Field
                id="allowed"
                label="Allowed folders"
                hint={
                  <>
                    The only folders the gateway may ever back up or browse on this device, separated by{" "}
                    <span className="font-mono text-fg">;</span> — e.g.{" "}
                    <span className="font-mono text-fg">{examples.allowedMany}</span>. They&rsquo;re locked in on the device itself.
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
            )}
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
              <Field
                id="watch"
                label="Start backing up (optional)"
                hint={fullAccess ? "Any folder on the device. Add more later." : "A folder inside the allowed ones. Add more later."}
              >
                <input
                  id="watch"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={`e.g. ${examples.watch}`}
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
