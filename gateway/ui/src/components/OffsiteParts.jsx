// Pieces of the off-site screens, shared by the Off-site page (the failsafe copy) and each device's
// page (that device's own copies): the bucket form, the Google Drive sign-in, a copy's status card,
// and the recovery key dialog.

import { useEffect, useState } from "react";
import { Link } from "react-router";
import {
  Check, Cloud, CloudOff, Copy, Download, ExternalLink, Folder, FolderOpen, FolderPlus, HardDrive, KeyRound, LoaderCircle, LogIn, Pause, Play,
  RefreshCw, ShieldCheck,
} from "lucide-react";
import { api } from "../api.js";
import { formatDateTime, formatSize, timeAgo } from "../format.js";
import Modal from "./Modal.jsx";
import { inputClass, primaryButton, secondaryButton } from "./buttons.js";

const PROVIDERS = [
  { id: "b2", label: "Backblaze B2", note: "Recommended", endpoint: "s3.us-west-004.backblazeb2.com" },
  { id: "wasabi", label: "Wasabi", note: "S3-compatible", endpoint: "https://s3.us-east-1.wasabisys.com" },
  { id: "aws", label: "Amazon S3", note: "S3-compatible", endpoint: "https://s3.us-east-1.amazonaws.com" },
  { id: "s3", label: "Other S3-compatible", note: "With Object Lock", endpoint: "https://storage.example.com" },
];

export function Field({ id, label, hint, children }) {
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

function B2Steps() {
  return (
    <ol className="list-decimal space-y-2 pl-5 text-sm text-dim marker:text-dim">
      <li>
        In Backblaze, <span className="text-fg">Buckets → Create a Bucket</span>: private, and set{" "}
        <span className="text-fg">Object Lock</span> to <span className="text-fg">Enable</span>. (Encryption can stay off: the
        gateway encrypts everything itself.)
      </li>
      <li>
        Copy the bucket&rsquo;s <span className="text-fg">Endpoint</span>, e.g. <span className="font-mono text-fg">s3.us-west-004.backblazeb2.com</span>,
        into the Endpoint box.
      </li>
      <li>
        <span className="text-fg">Application Keys → Add a New Application Key</span>: allow access to{" "}
        <span className="text-fg">this bucket only</span>, type <span className="text-fg">Read and Write</span>. Copy the
        keyID and applicationKey (Backblaze shows the applicationKey only once).
      </li>
      <li>
        Leave the bucket&rsquo;s lifecycle setting on <span className="text-fg">Keep all versions</span>.
      </li>
    </ol>
  );
}

export function S3Form({ deviceId = null, onConnected }) {
  const [provider, setProvider] = useState("b2");
  const [form, setForm] = useState({ endpoint: "", bucket: "", keyId: "", secret: "", lockMode: "COMPLIANCE", retentionDays: 30 });
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState(null); // { ok, text }
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const settings = () => ({ ...form, provider, retentionDays: Number(form.retentionDays) });
  const ready = form.endpoint && form.bucket && form.keyId && form.secret && Number(form.retentionDays) >= 1;
  const p = PROVIDERS.find((x) => x.id === provider);

  async function run(kind) {
    setBusy(kind);
    setMessage(null);
    try {
      if (kind === "test") {
        await api.post("/cloud/test", { settings: settings() });
        setMessage({ ok: true, text: "It works: the key is right, Object Lock is on, and a locked test file uploaded." });
      } else {
        onConnected(await api.post("/cloud/connect", { settings: settings(), ...(deviceId ? { deviceId } : {}) }));
      }
    } catch (err) {
      setMessage({ ok: false, text: err.message });
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_360px]">
      <form
        className="glass space-y-5 rounded-lg border border-edge p-5 sm:p-6"
        onSubmit={(e) => {
          e.preventDefault();
          run("connect");
        }}
      >
        <fieldset>
          <legend className="mb-1.5 text-sm text-dim">Storage</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {PROVIDERS.map((x) => (
              <label
                key={x.id}
                className={`flex items-center gap-3 rounded-md border px-3 py-2.5 has-focus-visible:ring-2 has-focus-visible:ring-signal ${
                  x.soon
                    ? "cursor-not-allowed border-edge opacity-50"
                    : provider === x.id
                      ? "cursor-pointer border-signal bg-signal/10"
                      : "cursor-pointer border-edge hover:bg-raised"
                }`}
              >
                <input
                  type="radio"
                  name="provider"
                  className="sr-only"
                  checked={provider === x.id}
                  disabled={x.soon}
                  onChange={() => setProvider(x.id)}
                />
                <Cloud size={18} className={provider === x.id ? "text-signal" : "text-dim"} aria-hidden="true" />
                <span>
                  <span className="block text-sm text-fg">{x.label}</span>
                  <span className="block text-xs text-dim">{x.note}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <Field id="endpoint" label="Endpoint" hint={provider === "b2" ? "Shown on the bucket's page in Backblaze, e.g. s3.us-west-004.backblazeb2.com" : "The S3 endpoint address for the bucket's region."}>
          <input id="endpoint" className={`${inputClass} font-mono`} placeholder={p.endpoint} spellCheck={false} autoComplete="off" value={form.endpoint} onChange={set("endpoint")} />
        </Field>
        <Field id="bucket" label="Bucket name" hint={provider === "b2" ? "Exactly as shown at the top of the bucket in Backblaze (the name, not the Bucket ID)." : "Exactly as shown in the storage service."}>
          <input id="bucket" className={`${inputClass} font-mono`} placeholder="e.g. protonic-backups" spellCheck={false} autoComplete="off" value={form.bucket} onChange={set("bucket")} />
        </Field>
        <div className="grid gap-5 sm:grid-cols-2">
          <Field id="key-id" label={provider === "b2" ? "keyID" : "Access key ID"}>
            <input id="key-id" className={`${inputClass} font-mono`} spellCheck={false} autoComplete="off" value={form.keyId} onChange={set("keyId")} />
          </Field>
          <Field id="secret" label={provider === "b2" ? "applicationKey" : "Secret access key"}>
            <input id="secret" type="password" className={`${inputClass} font-mono`} autoComplete="new-password" value={form.secret} onChange={set("secret")} />
          </Field>
        </div>
        <div className="grid gap-5 sm:grid-cols-2">
          <Field
            id="lock-mode"
            label="Lock type"
            hint={
              form.lockMode === "COMPLIANCE"
                ? "Nobody can delete a backup before its lock ends — not even the account owner."
                : "The account owner can remove a lock with special permission; the gateway's key can't."
            }
          >
            <select id="lock-mode" className={inputClass} value={form.lockMode} onChange={set("lockMode")}>
              <option value="COMPLIANCE">Compliance (strongest)</option>
              <option value="GOVERNANCE">Governance</option>
            </select>
          </Field>
          <Field id="days" label="Lock each backup for (days)" hint="Backups still in use are re-locked before this runs out.">
            <input id="days" type="number" min="1" max="3650" className={inputClass} value={form.retentionDays} onChange={set("retentionDays")} />
          </Field>
        </div>

        {message && (
          <p
            role={message.ok ? "status" : "alert"}
            className={`rounded-md border px-3 py-2 text-sm ${message.ok ? "border-good/40 bg-good/10 text-good" : "border-alert/40 bg-alert/10 text-alert"}`}
          >
            {message.text}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className={secondaryButton} disabled={!ready || !!busy} onClick={() => run("test")}>
            {busy === "test" && <LoaderCircle size={16} className="animate-spin" />}
            Test connection
          </button>
          <button type="submit" className={primaryButton} disabled={!ready || !!busy}>
            {busy === "connect" && <LoaderCircle size={16} className="animate-spin" />}
            Connect
          </button>
        </div>
      </form>

      <aside className="space-y-5">
        <section className="glass rounded-lg border border-edge p-5">
          <h2 className="font-display text-sm font-semibold">{provider === "b2" ? "Setting up Backblaze" : "What the bucket needs"}</h2>
          <div className="mt-3">
            {provider === "b2" ? (
              <B2Steps />
            ) : (
              <p className="text-sm text-dim">
                A private bucket with Object Lock turned on, and a key for that bucket that can list, read and write files and
                set retention. It doesn&rsquo;t need to delete anything.
              </p>
            )}
          </div>
        </section>
        <section className="rounded-lg border border-edge p-5 text-sm text-dim">
          <h2 className="flex items-center gap-2 font-display text-sm font-semibold text-fg">
            <ShieldCheck size={16} className="text-good" aria-hidden="true" />
            What gets sent
          </h2>
          <p className="mt-2">
            Only data that&rsquo;s already encrypted on this gateway, so the provider never sees a file name or its contents.
            Quarantined files are never sent.
          </p>
        </section>
      </aside>
    </div>
  );
}

export function RecoveryKeyDialog({ result, onDone }) {
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);
  const text =
    `Backup gateway recovery key (fingerprint ${result.fingerprint})\n\n${result.recoveryKey}\n\n` +
    "Keep this somewhere safe and away from the gateway. With it and the bucket's access key, the whole gateway\n" +
    "can be rebuilt from the cloud (npm run recover). Without it, the off-site copy can't be read by anyone.\n";

  async function copy() {
    try {
      await navigator.clipboard.writeText(result.recoveryKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      const range = document.createRange();
      range.selectNodeContents(document.getElementById("recovery-key"));
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(range);
    }
  }
  function download() {
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `gateway-recovery-key-${result.fingerprint}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Modal
      title="Save your recovery key"
      onClose={() => saved && onDone()}
      wide
      footer={
        <button type="button" className={primaryButton} disabled={!saved} onClick={onDone}>
          Done
        </button>
      }
    >
      <div className="space-y-4 text-sm">
        <p>
          Off-site backups are connected. This key is the only way to rebuild the gateway from the cloud if it&rsquo;s ever lost,
          stolen or wiped. <span className="text-fg">It&rsquo;s shown once and isn&rsquo;t stored on the gateway.</span>
        </p>
        <pre
          id="recovery-key"
          className="whitespace-pre-wrap break-all rounded-md border border-secure/40 bg-night px-4 py-3 font-mono text-base leading-relaxed tracking-wide text-secure"
        >
          {result.recoveryKey}
        </pre>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={secondaryButton} onClick={copy}>
            {copied ? <Check size={16} className="text-good" /> : <Copy size={16} />}
            {copied ? "Copied" : "Copy"}
          </button>
          <button type="button" className={secondaryButton} onClick={download}>
            <Download size={16} />
            Download as a text file
          </button>
        </div>
        <p className="text-dim">
          Put it in a password manager or print it, and keep it away from this computer. Fingerprint:{" "}
          <span className="font-mono text-fg">{result.fingerprint}</span>.
        </p>
        <label className="flex items-start gap-3 rounded-md border border-edge bg-raised px-3 py-3">
          <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 accent-signal" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
          <span>I&rsquo;ve stored the recovery key somewhere safe, away from this gateway.</span>
        </label>
      </div>
    </Modal>
  );
}

export function ReplaceKeyDialog({ status, onClose, onDone }) {
  const [keyId, setKeyId] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save() {
    setBusy(true);
    setError("");
    try {
      await api.post(`/cloud/${status.id}/key`, { keyId, secret });
      onDone();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Replace the access key"
      onClose={onClose}
      footer={
        <>
          <button type="button" className={secondaryButton} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={primaryButton} disabled={busy || !keyId || !secret} onClick={save}>
            {busy && <LoaderCircle size={16} className="animate-spin" />}
            Test and save
          </button>
        </>
      }
    >
      <div className="space-y-4 text-sm">
        <p className="text-dim">For when the key was changed or might have leaked. Same bucket ({status.bucket}), new key.</p>
        <Field id="new-key-id" label="Key ID">
          <input id="new-key-id" className={`${inputClass} font-mono`} autoComplete="off" spellCheck={false} value={keyId} onChange={(e) => setKeyId(e.target.value)} />
        </Field>
        <Field id="new-secret" label="Secret / application key">
          <input id="new-secret" type="password" className={`${inputClass} font-mono`} autoComplete="new-password" value={secret} onChange={(e) => setSecret(e.target.value)} />
        </Field>
        {error && <p className="text-alert">{error}</p>}
      </div>
    </Modal>
  );
}

export function DisconnectDialog({ status, onClose, onDone }) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const name = status.kind === "s3" ? status.bucket : status.email;
  async function go() {
    setBusy(true);
    setError("");
    try {
      await api.post(`/cloud/${status.id}/disconnect`, { confirm: typed });
      onDone();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }
  return (
    <Modal
      title={status.failsafe ? "Stop the failsafe copy?" : "Stop this off-site copy?"}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={secondaryButton} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={primaryButton} disabled={busy || typed.toLowerCase() !== String(name).toLowerCase()} onClick={go}>
            Stop sending
          </button>
        </>
      }
    >
      <div className="space-y-4 text-sm">
        <p>
          New backups stop going here. Nothing already there is deleted
          {status.kind === "s3" ? ": it stays locked until its lock ends" : ""}, and it can still be recovered with the recovery key.
        </p>
        <Field id="confirm-copy" label={`Type ${status.kind === "s3" ? "the bucket name" : "the Google account"} (${name}) to confirm`}>
          <input id="confirm-copy" className={`${inputClass} font-mono`} autoComplete="off" spellCheck={false} value={typed} onChange={(e) => setTyped(e.target.value)} />
        </Field>
        {error && <p className="text-alert">{error}</p>}
      </div>
    </Modal>
  );
}

export function Stat({ label, value, sub }) {
  return (
    <div className="glass rounded-lg border border-edge px-4 py-3">
      <p className="text-xs text-dim">{label}</p>
      <p className="mt-1 font-display text-lg font-semibold text-fg">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-dim">{sub}</p>}
    </div>
  );
}


// The Google sign-in setup, made once in Google Cloud. After that, adding a Google Drive anywhere
// is just "Sign in with Google" and choosing the folder.
export function GoogleSetup({ google, onSaved }) {
  const [form, setForm] = useState({
    clientId: google?.clientId ?? "",
    clientSecret: "",
    apiKey: google?.apiKey ?? "",
    projectNumber: google?.projectNumber ?? "",
  });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const secretKept = google?.configured && form.clientId.trim() === google.clientId;

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      await api.post("/cloud/google", form);
      setForm((f) => ({ ...f, clientSecret: "" }));
      setMessage({ ok: true, text: "Saved. Adding a Google Drive is now just signing in." });
      onSaved?.();
    } catch (err) {
      setMessage({ ok: false, text: err.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
      <form onSubmit={save} className="glass space-y-4 rounded-lg border border-edge p-5">
        <Field id="g-client" label="OAuth client ID" hint="Ends with .apps.googleusercontent.com">
          <input id="g-client" className={`${inputClass} font-mono`} autoComplete="off" spellCheck={false} value={form.clientId} onChange={set("clientId")} />
        </Field>
        <Field id="g-secret" label="Client secret" hint={secretKept ? "Saved on the gateway. Leave empty to keep it." : undefined}>
          <input id="g-secret" type="password" className={`${inputClass} font-mono`} autoComplete="new-password" value={form.clientSecret} onChange={set("clientSecret")} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="g-key" label="API key" hint="For choosing folders already in the Drive.">
            <input id="g-key" className={`${inputClass} font-mono`} autoComplete="off" spellCheck={false} placeholder="AIza…" value={form.apiKey} onChange={set("apiKey")} />
          </Field>
          <Field id="g-project" label="Project number" hint="Digits, from the project's dashboard.">
            <input id="g-project" inputMode="numeric" className={`${inputClass} font-mono`} autoComplete="off" spellCheck={false} value={form.projectNumber} onChange={set("projectNumber")} />
          </Field>
        </div>
        {message && (
          <p role={message.ok ? "status" : "alert"} className={`rounded-md border px-3 py-2 text-sm ${message.ok ? "border-good/40 bg-good/10 text-good" : "border-alert/40 bg-alert/10 text-alert"}`}>
            {message.text}
          </p>
        )}
        <div className="flex justify-end">
          <button type="submit" className={primaryButton} disabled={busy || !form.clientId.trim() || (!form.clientSecret.trim() && !secretKept)}>
            {busy && <LoaderCircle size={16} className="animate-spin" />}
            Save
          </button>
        </div>
      </form>
      <aside className="self-start rounded-lg border border-edge p-5 text-sm text-dim">
        <h3 className="font-display text-sm font-semibold text-fg">In Google Cloud (once, about 10 minutes)</h3>
        <ol className="mt-3 list-decimal space-y-2 pl-5 marker:text-dim">
          <li>
            At <span className="text-fg">console.cloud.google.com</span>, make a project, e.g. &ldquo;Protonic Backup Gateway&rdquo;.
          </li>
          <li>
            <span className="text-fg">APIs &amp; Services → Library</span>: turn on the <span className="text-fg">Google Drive API</span> and the{" "}
            <span className="text-fg">Google Picker API</span>.
          </li>
          <li>
            <span className="text-fg">Google Auth Platform</span>: External; app name and your email. Then under{" "}
            <span className="text-fg">Audience</span>, click <span className="text-fg">Publish app</span>. (Left in &ldquo;Testing&rdquo;,
            Google signs the gateway out every 7 days.)
          </li>
          <li>
            <span className="text-fg">Clients → Create client</span>, type <span className="text-fg">Desktop app</span>. Copy the client ID
            and secret.
          </li>
          <li>
            <span className="text-fg">APIs &amp; Services → Credentials → Create credentials → API key</span>. Restrict it to the Google
            Picker API, and copy it.
          </li>
          <li>
            The <span className="text-fg">project number</span> is on the project&rsquo;s dashboard (Project info), next to the project ID.
          </li>
        </ol>
        <p className="mt-3">
          The gateway only ever asks to see the files it makes and the folders you pick, nothing else in the Google account.
        </p>
      </aside>
    </div>
  );
}

// Adding a Google Drive (or signing in again): the button that goes to Google's sign-in page.
// Google then sends the browser back here, to choose the folder.
export function DriveSignIn({ deviceId = null, resign = null, google }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function go() {
    setBusy(true);
    setError("");
    try {
      const { url } = await api.post("/cloud/drive/start", { ...(deviceId ? { deviceId } : {}), ...(resign ? { resign } : {}) });
      window.location.assign(url); // Google's sign-in page; it sends the browser back here after
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  if (!google?.configured) {
    return (
      <p className="rounded-md border border-warn/40 bg-warn/10 px-4 py-3 text-sm text-warn">
        Google sign-in isn&rsquo;t set up on this gateway yet. It&rsquo;s done once, under{" "}
        <Link to="/offsite#google-setup" className="underline">
          Off-site → Google sign-in setup
        </Link>
        .
      </p>
    );
  }
  return (
    <div className="space-y-3">
      <button type="button" className={primaryButton} disabled={busy} onClick={go}>
        {busy ? <LoaderCircle size={16} className="animate-spin" /> : <LogIn size={16} />}
        Sign in with Google
      </button>
      {error && (
        <p role="alert" className="text-sm text-alert">
          {error}
        </p>
      )}
      <p className="text-xs text-dim">
        {resign
          ? "Sign in with the same Google account as before."
          : "Then choose where in that Drive the backups go: a new folder, or one that's already there."}{" "}
        Do this in a browser on the gateway computer (the 127.0.0.1 address): Google sends you back there.
      </p>
    </div>
  );
}

// Opens Google's folder picker in its own small window and waits for the folder chosen there
function pickFolder(pendingId) {
  return new Promise((resolve, reject) => {
    const win = window.open(`/google-picker.html#${encodeURIComponent(pendingId)}`, "bg-google-picker", "width=900,height=650");
    if (!win) return reject(new Error("The browser blocked the Google window. Allow pop-ups for this page and try again."));
    const done = (fn) => {
      window.removeEventListener("message", onMessage);
      clearInterval(timer);
      fn();
    };
    function onMessage(e) {
      if (e.origin !== window.location.origin || e.data?.source !== "bg-google-picker") return;
      if (e.data.folder) done(() => resolve(e.data.folder));
      else if (e.data.cancelled) done(() => resolve(null));
      else if (e.data.error) done(() => reject(new Error(e.data.error)));
    }
    window.addEventListener("message", onMessage);
    const timer = setInterval(() => win.closed && done(() => resolve(null)), 700);
  });
}

// After signing in to Google: where in that Drive the backups go
export function DriveFolderChooser({ pendingId, onDone, onClose }) {
  const [info, setInfo] = useState(null);
  const [error, setError] = useState("");
  const [mode, setMode] = useState("new");
  const [name, setName] = useState("");
  const [parent, setParent] = useState(null); // { id, name } or null = My Drive
  const [existing, setExisting] = useState(null);
  const [busy, setBusy] = useState("");

  useEffect(() => {
    api
      .get(`/cloud/drive/pending/${encodeURIComponent(pendingId)}`)
      .then((r) => {
        setInfo(r);
        setName(r.defaultName);
      })
      .catch((err) => setError(err.message));
  }, [pendingId]);

  async function pick(kind) {
    setError("");
    setBusy(`pick-${kind}`);
    try {
      const folder = await pickFolder(pendingId);
      if (folder) (kind === "parent" ? setParent : setExisting)(folder);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  }

  async function finish() {
    setError("");
    setBusy("finish");
    try {
      const body = mode === "existing" ? { folderId: existing.id } : { name, ...(parent ? { parentId: parent.id } : {}) };
      onDone(await api.post(`/cloud/drive/pending/${encodeURIComponent(pendingId)}/finish`, body));
    } catch (err) {
      setError(err.message);
      setBusy("");
    }
  }

  function cancel() {
    api.post(`/cloud/drive/pending/${encodeURIComponent(pendingId)}/cancel`).catch(() => {});
    onClose();
  }

  const ready = info && !busy && (mode === "existing" ? !!existing : !!name.trim());
  const option = (id, title, sub) => (
    <label
      className={`flex cursor-pointer items-start gap-3 rounded-md border px-4 py-3 has-focus-visible:ring-2 has-focus-visible:ring-signal ${
        mode === id ? "border-signal bg-signal/10" : "border-edge hover:bg-raised"
      } ${id === "existing" && !info?.picker ? "cursor-not-allowed opacity-60" : ""}`}
    >
      <input type="radio" name="drive-folder-mode" className="sr-only" checked={mode === id} disabled={id === "existing" && !info?.picker} onChange={() => setMode(id)} />
      {id === "new" ? <FolderPlus size={18} className="mt-0.5 shrink-0 text-signal" aria-hidden="true" /> : <FolderOpen size={18} className="mt-0.5 shrink-0 text-signal" aria-hidden="true" />}
      <span>
        <span className="block text-sm text-fg">{title}</span>
        <span className="block text-xs text-dim">{sub}</span>
      </span>
    </label>
  );

  return (
    <Modal
      title="Choose the Google Drive folder"
      onClose={cancel}
      wide
      footer={
        <>
          <button type="button" className={secondaryButton} onClick={cancel}>
            Cancel
          </button>
          <button type="button" className={primaryButton} disabled={!ready} onClick={finish}>
            {busy === "finish" && <LoaderCircle size={16} className="animate-spin" />}
            {mode === "new" ? "Create folder and connect" : "Use this folder"}
          </button>
        </>
      }
    >
      {!info ? (
        error ? <p className="text-sm text-alert">{error}</p> : <p className="text-sm text-dim">Loading…</p>
      ) : (
        <div className="space-y-4 text-sm">
          <p className="text-dim">
            Signed in as <span className="font-mono text-fg">{info.email}</span>. Where should the backups go?
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            {option("new", "Make a new folder", "In My Drive, or inside a folder you choose.")}
            {option("existing", "Use a folder that's already there", info.picker ? "Pick it in Google Drive." : "Needs the API key and project number in Google sign-in setup.")}
          </div>

          {mode === "new" ? (
            <div className="space-y-3 rounded-md border border-edge p-4">
              <Field id="drive-folder-name" label="Folder name">
                <input id="drive-folder-name" className={inputClass} autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} />
              </Field>
              <div>
                <p className="mb-1.5 text-sm text-dim">Inside</p>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="inline-flex items-center gap-2 rounded-md border border-edge bg-raised px-3 py-1.5 text-fg">
                    <Folder size={16} className="text-dim" aria-hidden="true" />
                    {parent ? parent.name : "My Drive"}
                  </span>
                  {info.picker && (
                    <button type="button" className={secondaryButton} disabled={!!busy} onClick={() => pick("parent")}>
                      {busy === "pick-parent" && <LoaderCircle size={16} className="animate-spin" />}
                      Choose another place
                    </button>
                  )}
                  {parent && (
                    <button type="button" className="text-sm text-dim underline hover:text-fg" onClick={() => setParent(null)}>
                      Back to My Drive
                    </button>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-3 rounded-md border border-edge p-4">
              {existing ? (
                <span className="inline-flex items-center gap-2 text-fg">
                  <FolderOpen size={16} className="text-signal" aria-hidden="true" />
                  {existing.name}
                </span>
              ) : (
                <span className="text-dim">No folder chosen yet.</span>
              )}
              <button type="button" className={secondaryButton} disabled={!!busy} onClick={() => pick("existing")}>
                {busy === "pick-existing" && <LoaderCircle size={16} className="animate-spin" />}
                {existing ? "Choose a different folder" : "Choose folder in Google Drive"}
              </button>
            </div>
          )}
          <p className="text-xs text-dim">
            The gateway puts its own <span className="font-mono">packs</span> and <span className="font-mono">catalogs</span> folders inside.
            Everything in them is encrypted. Don&rsquo;t move or rename them.
          </p>
          {error && (
            <p role="alert" className="rounded-md border border-alert/40 bg-alert/10 px-3 py-2 text-alert">
              {error}
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}

function headlineFor(s) {
  if (s.paused) return { icon: Pause, tone: "text-warn", border: "border-warn/40", title: "Paused", text: "Nothing is being sent here until you resume." };
  if (s.lastError) return { icon: CloudOff, tone: "text-alert", border: "border-alert/40", title: "Can't send right now", text: `${s.lastError.message} Retrying automatically.` };
  if (s.running && s.current) {
    const progress = s.current.total ? ` — ${s.current.done.toLocaleString()} of ${s.current.total.toLocaleString()}` : "";
    return { icon: RefreshCw, tone: "text-secure", border: "border-secure/40", title: `${s.current.action}${progress}`, text: "Sending encrypted data.", spin: true };
  }
  if (s.pending?.chunks) return { icon: RefreshCw, tone: "text-secure", border: "border-secure/40", title: `${s.pending.chunks.toLocaleString()} waiting to upload`, text: "They go up in the next minute." };
  if (!s.lastSuccessAt && s.uploaded.chunks > 0) {
    return { icon: LoaderCircle, tone: "text-dim", border: "border-edge", title: "Checking", text: `The gateway restarted; it checks this copy again in a few seconds.${s.lastCatalog ? ` Last catalog sent ${timeAgo(s.lastCatalog.at)}.` : ""}`, spin: true };
  }
  if (!s.lastSuccessAt) return { icon: LoaderCircle, tone: "text-dim", border: "border-edge", title: "Starting", text: "The first upload starts in a few seconds.", spin: true };
  return {
    icon: ShieldCheck, tone: "text-good", border: "border-good/40", title: "Up to date",
    text: `${s.kind === "s3" ? "Everything is there and locked" : "Everything is there"}. Checked ${timeAgo(s.lastSuccessAt)}.`,
  };
}

// One off-site copy: where it is, how it's doing, and what you can do with it
export function CopyCard({ s, google, onChanged }) {
  const [dialog, setDialog] = useState(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const h = headlineFor(s);
  const Icon = h.icon;
  const Kind = s.kind === "s3" ? HardDrive : Cloud;

  async function act(kind, fn) {
    setBusy(kind);
    setError("");
    try {
      await fn();
      onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  }
  const done = () => {
    setDialog(null);
    onChanged();
  };

  return (
    <section className={`glass rounded-lg border ${h.border} p-5`}>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <Kind size={20} className="mt-0.5 shrink-0 text-dim" aria-hidden="true" />
          <div className="min-w-0">
            <p className="font-medium text-fg">
              {s.kind === "s3" ? s.providerLabel : "Google Drive"}{" "}
              <span className="break-all font-mono text-sm text-dim">{s.kind === "s3" ? s.bucket : s.email}</span>
            </p>
            {s.kind === "drive" && s.folderId && (
              <a
                href={`https://drive.google.com/drive/folders/${encodeURIComponent(s.folderId)}`}
                target="_blank"
                rel="noreferrer noopener"
                className="mt-0.5 inline-flex items-center gap-1.5 text-sm text-dim hover:text-signal"
              >
                <Folder size={14} aria-hidden="true" />
                {s.folderName ?? "Its folder"}
                <ExternalLink size={12} aria-hidden="true" />
              </a>
            )}
            <p className={`mt-1 flex items-center gap-2 text-sm ${h.tone}`}>
              <Icon size={16} className={`shrink-0 ${h.spin ? "animate-spin" : ""}`} aria-hidden="true" />
              {h.title}
            </p>
            <p className="mt-0.5 text-sm text-dim">{h.text}</p>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <button type="button" className={s.failsafe ? primaryButton : secondaryButton} disabled={!!busy || s.paused} onClick={() => act("sync", () => api.post(`/cloud/${s.id}/sync`))}>
            <RefreshCw size={16} className={busy === "sync" ? "animate-spin" : ""} />
            {s.failsafe ? "Back up everything now" : "Check now"}
          </button>
          <button type="button" className={secondaryButton} disabled={!!busy} onClick={() => act("pause", () => api.post(`/cloud/${s.id}/pause`, { paused: !s.paused }))}>
            {s.paused ? <Play size={16} /> : <Pause size={16} />}
            {s.paused ? "Resume" : "Pause"}
          </button>
        </div>
      </div>
      {error && <p className="mt-3 text-sm text-alert">{error}</p>}

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <Stat label="Sent" value={formatSize(s.uploaded.bytes)} sub={`${s.uploaded.chunks.toLocaleString()} encrypted chunks`} />
        <Stat
          label={s.kind === "s3" ? "Locked for" : "Locks"}
          value={s.kind === "s3" ? `${s.retentionDays} day${s.retentionDays === 1 ? "" : "s"}` : "None"}
          sub={s.kind === "s3" ? (s.lockMode === "COMPLIANCE" ? "Compliance: nobody can delete" : "Governance") : "Google Drive can't lock files"}
        />
        <Stat
          label="Recovery catalog"
          value={s.lastCatalog ? timeAgo(s.lastCatalog.at) : "Not yet"}
          sub={s.lastCatalog ? formatSize(s.lastCatalog.size) : "Goes up after the first data"}
        />
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        <span className="text-dim">
          Connected {formatDateTime(s.connectedAt)} by {s.connectedBy}
        </span>
        <span className="flex flex-wrap gap-2 sm:ml-auto">
          {s.kind === "s3" ? (
            <button type="button" className={secondaryButton} onClick={() => setDialog("key")}>
              <KeyRound size={16} />
              Replace access key
            </button>
          ) : (
            <button type="button" className={secondaryButton} onClick={() => setDialog("resign")}>
              <LogIn size={16} />
              Sign in again
            </button>
          )}
          <button type="button" className={secondaryButton} onClick={() => setDialog("disconnect")}>
            Stop sending here
          </button>
        </span>
      </div>

      {dialog === "key" && <ReplaceKeyDialog status={s} onClose={() => setDialog(null)} onDone={done} />}
      {dialog === "disconnect" && <DisconnectDialog status={s} onClose={() => setDialog(null)} onDone={done} />}
      {dialog === "resign" && (
        <Modal title={`Sign in to Google Drive again (${s.email})`} onClose={() => setDialog(null)} wide>
          <DriveSignIn resign={s.id} google={google} />
        </Modal>
      )}
    </section>
  );
}

// After Google sends the browser back: ?drive_choose=<id> (choose the folder next),
// ?drive=signed-in, or ?drive_error=...
export function useDriveReturn() {
  const [state] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    let note = null;
    if (params.get("drive_error")) note = { ok: false, text: params.get("drive_error") };
    else if (params.get("drive") === "signed-in") note = { ok: true, text: "Signed in to Google Drive again. Uploads carry on." };
    const choose = params.get("drive_choose");
    if (note || choose) window.history.replaceState(null, "", window.location.pathname);
    return { note, choose };
  });
  return state;
}

// Choosing the folder after a Google sign-in, then showing the recovery key if it was the first copy
export function DriveReturn({ choose, onChanged }) {
  const [pending, setPending] = useState(choose);
  const [keyShown, setKeyShown] = useState(null);
  const [note, setNote] = useState(null);
  return (
    <>
      <Note note={note} />
      {pending && (
        <DriveFolderChooser
          pendingId={pending}
          onClose={() => setPending(null)}
          onDone={(result) => {
            setPending(null);
            setNote({ ok: true, text: `Google Drive connected: backups go to “${result.folderName}” in ${result.email}. The first upload starts in a few seconds.` });
            if (result.recoveryKey) setKeyShown(result);
            onChanged();
          }}
        />
      )}
      {keyShown && <RecoveryKeyDialog result={keyShown} onDone={() => setKeyShown(null)} />}
    </>
  );
}

export function Note({ note }) {
  if (!note) return null;
  return (
    <p
      role={note.ok ? "status" : "alert"}
      className={`mb-6 rounded-md border px-4 py-3 text-sm ${note.ok ? "border-good/40 bg-good/10 text-good" : "border-alert/40 bg-alert/10 text-alert"}`}
    >
      {note.text}
    </p>
  );
}
