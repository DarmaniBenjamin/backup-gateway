// Off-site copy: connect cloud storage with Object Lock (Backblaze B2, Wasabi, Amazon S3...),
// see what's been sent, and keep the recovery key that can rebuild this gateway from it.

import { useState } from "react";
import {
  Check, Cloud, CloudOff, Copy, Download, KeyRound, LoaderCircle, Lock, Pause, Play, RefreshCw, ShieldCheck, TriangleAlert,
} from "lucide-react";
import { api } from "../api.js";
import { usePolling } from "../usePolling.js";
import { formatDateTime, formatSize, timeAgo } from "../format.js";
import PageHeader from "../components/PageHeader.jsx";
import LoadState from "../components/LoadState.jsx";
import Modal from "../components/Modal.jsx";
import { inputClass, primaryButton, secondaryButton } from "../components/buttons.js";

const PROVIDERS = [
  { id: "b2", label: "Backblaze B2", note: "Recommended", endpoint: "https://s3.us-west-004.backblazeb2.com" },
  { id: "wasabi", label: "Wasabi", note: "S3-compatible", endpoint: "https://s3.us-east-1.wasabisys.com" },
  { id: "aws", label: "Amazon S3", note: "S3-compatible", endpoint: "https://s3.us-east-1.amazonaws.com" },
  { id: "s3", label: "Other S3-compatible", note: "With Object Lock", endpoint: "https://storage.example.com" },
  { id: "gdrive", label: "Google Drive", note: "Can't lock backups", soon: true },
];

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
        and put <span className="font-mono text-fg">https://</span> in front of it below.
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

function SetupForm({ onConnected }) {
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
        onConnected(await api.post("/cloud/connect", { settings: settings() }));
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
          <legend className="mb-1.5 text-sm text-dim">Where to keep the off-site copy</legend>
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

        <Field id="endpoint" label="Endpoint" hint={provider === "b2" ? "Shown on the bucket's page in Backblaze, with https:// in front." : "The S3 endpoint address for the bucket's region."}>
          <input id="endpoint" className={`${inputClass} font-mono`} placeholder={p.endpoint} spellCheck={false} autoComplete="off" value={form.endpoint} onChange={set("endpoint")} />
        </Field>
        <Field id="bucket" label="Bucket name">
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

function RecoveryKeyDialog({ result, onDone }) {
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

function ReplaceKeyDialog({ status, onClose, onDone }) {
  const [keyId, setKeyId] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save() {
    setBusy(true);
    setError("");
    try {
      await api.post("/cloud/key", { keyId, secret });
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

function DisconnectDialog({ status, onClose, onDone }) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function go() {
    setBusy(true);
    setError("");
    try {
      await api.post("/cloud/disconnect", { bucket: typed });
      onDone();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Stop off-site backups?"
      onClose={onClose}
      footer={
        <>
          <button type="button" className={secondaryButton} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={primaryButton} disabled={busy || typed !== status.bucket} onClick={go}>
            Stop off-site backups
          </button>
        </>
      }
    >
      <div className="space-y-4 text-sm">
        <p>
          New backups will stay on this gateway only. Nothing in the bucket is deleted: what&rsquo;s there stays locked until its
          lock ends, and can still be recovered with the recovery key.
        </p>
        <Field id="confirm-bucket" label={`Type the bucket name (${status.bucket}) to confirm`}>
          <input id="confirm-bucket" className={`${inputClass} font-mono`} autoComplete="off" spellCheck={false} value={typed} onChange={(e) => setTyped(e.target.value)} />
        </Field>
        {error && <p className="text-alert">{error}</p>}
      </div>
    </Modal>
  );
}

function Stat({ label, value, sub }) {
  return (
    <div className="glass rounded-lg border border-edge px-4 py-3">
      <p className="text-xs text-dim">{label}</p>
      <p className="mt-1 font-display text-lg font-semibold text-fg">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-dim">{sub}</p>}
    </div>
  );
}

function Connected({ s, reload }) {
  const [dialog, setDialog] = useState(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  async function act(kind, fn) {
    setBusy(kind);
    setError("");
    try {
      await fn();
      reload();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  }

  let headline;
  if (s.paused) headline = { icon: Pause, tone: "text-warn", border: "border-warn/40", title: "Paused", text: "Nothing is being sent off-site until you resume." };
  else if (s.lastError) headline = { icon: CloudOff, tone: "text-alert", border: "border-alert/40", title: "Can't reach the cloud storage", text: `${s.lastError.message} Retrying automatically.` };
  else if (s.running && s.current) {
    const progress = s.current.total ? ` — ${s.current.done.toLocaleString()} of ${s.current.total.toLocaleString()}` : "";
    headline = { icon: RefreshCw, tone: "text-secure", border: "border-secure/40", title: `${s.current.action}${progress}`, text: "Sending encrypted data off-site.", spin: true };
  } else if (s.pending?.chunks) headline = { icon: RefreshCw, tone: "text-secure", border: "border-secure/40", title: `${s.pending.chunks.toLocaleString()} waiting to upload`, text: "They'll go up in the next minute." };
  else if (!s.lastSuccessAt) headline = { icon: LoaderCircle, tone: "text-dim", border: "border-edge", title: "Starting", text: "The first upload starts in a few seconds.", spin: true };
  else headline = { icon: ShieldCheck, tone: "text-good", border: "border-good/40", title: "Up to date", text: `Everything is off-site and locked. Checked ${timeAgo(s.lastSuccessAt)}.` };
  const Icon = headline.icon;

  return (
    <div className="space-y-8">
      <section className={`glass flex flex-col gap-4 rounded-lg border ${headline.border} p-5 sm:flex-row sm:items-center sm:justify-between`}>
        <div className="flex items-start gap-3">
          <Icon size={22} className={`mt-0.5 shrink-0 ${headline.tone} ${headline.spin ? "animate-spin" : ""}`} aria-hidden="true" />
          <div>
            <p className={`font-display text-lg font-semibold ${headline.tone}`}>{headline.title}</p>
            <p className="mt-0.5 text-sm text-dim">{headline.text}</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={secondaryButton} disabled={!!busy || s.paused} onClick={() => act("sync", () => api.post("/cloud/sync"))}>
            <RefreshCw size={16} className={busy === "sync" ? "animate-spin" : ""} />
            Check now
          </button>
          <button type="button" className={secondaryButton} disabled={!!busy} onClick={() => act("pause", () => api.post("/cloud/pause", { paused: !s.paused }))}>
            {s.paused ? <Play size={16} /> : <Pause size={16} />}
            {s.paused ? "Resume" : "Pause"}
          </button>
        </div>
      </section>
      {error && <p className="text-sm text-alert">{error}</p>}

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Off-site" value={formatSize(s.uploaded.bytes)} sub={`${s.uploaded.chunks.toLocaleString()} encrypted chunks`} />
        <Stat label="Waiting" value={s.pending ? formatSize(s.pending.bytes) : "—"} sub={s.pending ? `${s.pending.chunks.toLocaleString()} chunks` : "Not checked yet"} />
        <Stat
          label="Locked for"
          value={`${s.retentionDays} day${s.retentionDays === 1 ? "" : "s"}`}
          sub={s.lockMode === "COMPLIANCE" ? "Compliance: nobody can delete" : "Governance"}
        />
        <Stat
          label="Recovery catalog"
          value={s.lastCatalog ? timeAgo(s.lastCatalog.at) : "Not yet"}
          sub={s.lastCatalog ? `${formatSize(s.lastCatalog.size)}, locked until ${formatDateTime(s.lastCatalog.lockedUntil)}` : "Uploads after the first data"}
        />
      </section>

      <div className="grid gap-8 lg:grid-cols-2">
        <section className="min-w-0">
          <h2 className="mb-3 font-medium">Storage</h2>
          <dl className="glass grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2.5 rounded-lg border border-edge p-5 text-sm">
            <dt className="text-dim">Provider</dt>
            <dd>{s.providerLabel}</dd>
            <dt className="text-dim">Bucket</dt>
            <dd className="break-all font-mono">{s.bucket}</dd>
            <dt className="text-dim">Endpoint</dt>
            <dd className="break-all font-mono">{s.endpoint}</dd>
            <dt className="text-dim">Key ID</dt>
            <dd className="break-all font-mono">{s.keyId}</dd>
            <dt className="text-dim">Connected</dt>
            <dd>
              {formatDateTime(s.connectedAt)} by {s.connectedBy}
            </dd>
          </dl>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className={secondaryButton} onClick={() => setDialog("key")}>
              <KeyRound size={16} />
              Replace access key
            </button>
            <button type="button" className={secondaryButton} onClick={() => setDialog("disconnect")}>
              Stop off-site backups
            </button>
          </div>
        </section>

        <section className="min-w-0">
          <h2 className="mb-3 flex items-center gap-2 font-medium">
            <Lock size={16} className="text-secure" aria-hidden="true" />
            If this gateway is ever lost
          </h2>
          <div className="glass space-y-3 rounded-lg border border-edge p-5 text-sm text-dim">
            <p>
              Set up a new gateway from the project, then rebuild everything from the cloud with the recovery key (fingerprint{" "}
              <span className="font-mono text-fg">{s.recoveryFingerprint}</span>) and a key for the bucket:
            </p>
            <pre className="overflow-x-auto rounded-md border border-edge bg-night px-3 py-2 font-mono text-xs text-fg">
              {`cd gateway\nnpm run recover -- --endpoint ${s.endpoint} \\\n  --bucket ${s.bucket} --key-id YOUR-KEY-ID --to ./data`}
            </pre>
            <p>It asks for the application key and the recovery key, then downloads and checks every backup.</p>
          </div>
        </section>
      </div>

      {dialog === "key" && <ReplaceKeyDialog status={s} onClose={() => setDialog(null)} onDone={() => (setDialog(null), reload())} />}
      {dialog === "disconnect" && <DisconnectDialog status={s} onClose={() => setDialog(null)} onDone={() => (setDialog(null), reload())} />}
    </div>
  );
}

export default function Offsite() {
  const { data, error, loading, reload } = usePolling("/cloud", 4000);
  const [connected, setConnected] = useState(null); // recovery key result, shown once

  return (
    <div className="w-full">
      <PageHeader title="Off-site">
        A second copy of every backup in the cloud, locked so nobody can delete it — not ransomware, not a stolen password.
      </PageHeader>
      {!data ? (
        <LoadState loading={loading} error={error} onRetry={reload} />
      ) : data.connected ? (
        <Connected s={data} reload={reload} />
      ) : (
        <SetupForm
          onConnected={(result) => {
            setConnected(result);
            reload();
          }}
        />
      )}
      {connected && <RecoveryKeyDialog result={connected} onDone={() => setConnected(null)} />}
    </div>
  );
}
