// Alerts: where security events and problems are sent (phone push through ntfy, email, or a
// webhook for Slack, Discord or your own systems), what each place gets, and what's been sent.

import { useState } from "react";
import {
  BellRing, Check, CircleCheck, CircleX, Copy, LoaderCircle, Mail, Pencil, Plus, Send, Shuffle, Smartphone, Trash2,
  Webhook,
} from "lucide-react";
import { api } from "../api.js";
import { usePolling } from "../usePolling.js";
import { formatDateTime, formatSize, timeAgo } from "../format.js";
import PageHeader from "../components/PageHeader.jsx";
import LoadState from "../components/LoadState.jsx";
import Modal from "../components/Modal.jsx";
import { inputClass, primaryButton, secondaryButton } from "../components/buttons.js";

const KIND = {
  push: { label: "Phone push", icon: Smartphone, blurb: "A notification on your phone, through the free ntfy app." },
  email: { label: "Email", icon: Mail, blurb: "Through Gmail, Microsoft 365 or any mail server." },
  webhook: { label: "Webhook", icon: Webhook, blurb: "Slack, Discord, or your own systems like a helpdesk." },
};
const MIN_LABEL = {
  critical: "Critical only",
  high: "High and critical",
  medium: "Medium and above",
  low: "Low and above",
  info: "Every severity",
};
const selectClass = `${inputClass} pr-8`;

function Switch({ on, onChange, busy, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={busy}
      onClick={() => onChange(!on)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors before:absolute before:-inset-3 before:content-[''] ${on ? "border-signal bg-signal" : "border-edge bg-raised"}`}
    >
      <span className={`inline-block h-4 w-4 rounded-full bg-fg transition-transform ${on ? "translate-x-6" : "translate-x-1"}`} />
    </button>
  );
}

function Field({ label, hint, children }) {
  return (
    <label className="block text-sm">
      <span className="mb-1.5 block text-fg">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-dim">{hint}</span>}
    </label>
  );
}

function CopyButton({ text }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={`${secondaryButton} h-11 px-3`}
      aria-label="Copy"
      onClick={async () => {
        await navigator.clipboard.writeText(text).catch(() => {});
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
    >
      {done ? <Check size={15} className="text-good" /> : <Copy size={15} />}
    </button>
  );
}

// ---- Add or change a channel -----------------------------------------------------------------

function blank(kind, choices, suggestedTopic) {
  const base = { kind, name: "", minSeverity: "high", categories: choices.categories.map((c) => c.id) };
  if (kind === "push") return { ...base, settings: { server: "https://ntfy.sh", topic: suggestedTopic, token: "" } };
  if (kind === "email") return { ...base, settings: { host: "", port: 587, security: "starttls", username: "", password: "", from: "", fromName: "Backup gateway", to: "" } };
  return { ...base, settings: { format: "json", url: "", secret: "" } };
}

function fromSaved(c) {
  const s = c.settings;
  const settings =
    c.kind === "push"
      ? { server: s.server, topic: s.topic, token: "" }
      : c.kind === "email"
        ? { ...s, password: "" }
        : { format: s.format, url: "", secret: "" };
  return { kind: c.kind, name: c.name, minSeverity: c.minSeverity, categories: c.categories, settings };
}

const EMAIL_PRESETS = [
  { id: "gmail", label: "Gmail / Google Workspace", host: "smtp.gmail.com", port: 587, security: "starttls", note: "Use an app password (Google account > Security > 2-Step Verification > App passwords), not your normal password." },
  { id: "m365", label: "Microsoft 365", host: "smtp.office365.com", port: 587, security: "starttls", note: "The mailbox needs SMTP AUTH turned on in the Microsoft 365 admin center (Users > Mail > Manage email apps)." },
  { id: "other", label: "Other", note: "" },
];

function PushFields({ s, set, saved }) {
  return (
    <div className="space-y-4">
      <ol className="space-y-2 rounded-md border border-edge bg-raised/50 p-4 text-sm text-dim">
        <li><span className="text-fg">1.</span> Install the free <span className="text-fg">ntfy</span> app on your phone (App Store or Google Play).</li>
        <li><span className="text-fg">2.</span> In the app, tap <span className="text-fg">+</span>, and subscribe to the topic below. Keep it secret: anyone with the name can read these alerts.</li>
        <li><span className="text-fg">3.</span> Click <span className="text-fg">Send test</span> here. It should pop up on your phone in a few seconds.</li>
      </ol>
      <Field label="Topic">
        <div className="flex gap-2">
          <input className={`${inputClass} font-mono`} value={s.topic} onChange={(e) => set({ topic: e.target.value })} spellCheck={false} />
          <CopyButton text={s.topic} />
        </div>
      </Field>
      <Field label="ntfy server" hint="Leave as ntfy.sh unless you run your own ntfy server.">
        <input className={inputClass} value={s.server} onChange={(e) => set({ server: e.target.value })} spellCheck={false} />
      </Field>
      <Field label="Access token (optional)" hint={saved?.settings.hasToken ? "A token is saved. Leave empty to keep it." : "Only for a protected topic on your own server or a paid ntfy.sh plan."}>
        <input className={inputClass} type="password" autoComplete="off" value={s.token} onChange={(e) => set({ token: e.target.value })} />
      </Field>
    </div>
  );
}

function EmailFields({ s, set, saved }) {
  const preset = EMAIL_PRESETS.find((p) => p.host === s.host) ?? EMAIL_PRESETS[2];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2" role="group" aria-label="Mail provider">
        {EMAIL_PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            aria-pressed={preset.id === p.id}
            onClick={() => p.host ? set({ host: p.host, port: p.port, security: p.security }) : set({ host: "" })}
            className={`rounded-md border px-3 py-1.5 text-sm ${preset.id === p.id ? "border-signal bg-signal/10 text-fg" : "border-edge text-dim hover:text-fg"}`}
          >
            {p.label}
          </button>
        ))}
      </div>
      {preset.note && <p className="text-xs text-dim">{preset.note}</p>}
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_100px_150px]">
        <Field label="Mail server">
          <input className={inputClass} value={s.host} onChange={(e) => set({ host: e.target.value })} placeholder="smtp.example.com" spellCheck={false} />
        </Field>
        <Field label="Port">
          <input className={inputClass} inputMode="numeric" value={s.port} onChange={(e) => set({ port: e.target.value.replace(/\D/g, "") })} />
        </Field>
        <Field label="Encryption">
          <select className={selectClass} value={s.security} onChange={(e) => set({ security: e.target.value })}>
            <option value="starttls">STARTTLS</option>
            <option value="tls">SSL/TLS</option>
            <option value="none">None</option>
          </select>
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Username">
          <input className={inputClass} value={s.username} onChange={(e) => set({ username: e.target.value })} autoComplete="off" spellCheck={false} />
        </Field>
        <Field label="Password" hint={saved?.settings.hasPassword ? "Saved. Leave empty to keep it." : null}>
          <input className={inputClass} type="password" autoComplete="new-password" value={s.password} onChange={(e) => set({ password: e.target.value })} />
        </Field>
        <Field label="From address">
          <input className={inputClass} type="email" value={s.from} onChange={(e) => set({ from: e.target.value })} placeholder="alerts@yourcompany.com" />
        </Field>
        <Field label="From name">
          <input className={inputClass} value={s.fromName} onChange={(e) => set({ fromName: e.target.value })} />
        </Field>
      </div>
      <Field label="Send to" hint="One or more addresses, separated by commas.">
        <input className={inputClass} value={s.to} onChange={(e) => set({ to: e.target.value })} placeholder="you@yourcompany.com" />
      </Field>
    </div>
  );
}

function WebhookFields({ s, set, saved }) {
  const randomSecret = () => {
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    set({ secret: Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("") });
  };
  return (
    <div className="space-y-4">
      <Field label="Send as">
        <select className={selectClass} value={s.format} onChange={(e) => set({ format: e.target.value })}>
          <option value="json">JSON, for Uplink or your own systems</option>
          <option value="slack">Slack message</option>
          <option value="discord">Discord message</option>
        </select>
      </Field>
      {s.format === "json" && (
        <p className="rounded-md border border-edge bg-raised/50 p-3 text-sm text-dim">
          <span className="text-fg">Uplink:</span> in Uplink, open Integrations, turn on Backup alerts, and copy its address and secret into the
          two boxes below (Uplink needs both). Each alert then becomes a ticket for that client, and &ldquo;back to normal&rdquo; resolves it.
        </p>
      )}
      <Field label="Webhook address" hint={saved ? `Saved: ${saved.settings.urlHint}. Leave empty to keep it.` : "It's treated like a password: never shown again after saving."}>
        <input className={inputClass} value={s.url} onChange={(e) => set({ url: e.target.value })} placeholder="https://" spellCheck={false} />
      </Field>
      {s.format === "json" && (
        <Field
          label="Signing secret (optional)"
          hint={
            saved?.settings.hasSecret
              ? "A secret is saved. Leave empty to keep it."
              : "Each request then carries X-Gateway-Signature: sha256=HMAC of \"timestamp.body\", with X-Gateway-Timestamp, so your system can check it came from here."
          }
        >
          <div className="flex gap-2">
            <input className={`${inputClass} font-mono`} type="text" autoComplete="off" value={s.secret} onChange={(e) => set({ secret: e.target.value })} spellCheck={false} />
            <button type="button" className={`${secondaryButton} h-11 px-3`} onClick={randomSecret} aria-label="Make a random secret" title="Make a random secret">
              <Shuffle size={15} />
            </button>
            {s.secret && <CopyButton text={s.secret} />}
          </div>
        </Field>
      )}
    </div>
  );
}

function ChannelDialog({ initial, saved, choices, onClose, onSaved }) {
  const [c, setC] = useState(initial);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [tested, setTested] = useState(false);
  const set = (patch) => setC((x) => ({ ...x, settings: { ...x.settings, ...patch } }));
  const toggleCat = (id) => setC((x) => ({ ...x, categories: x.categories.includes(id) ? x.categories.filter((y) => y !== id) : [...x.categories, id] }));
  const Fields = { push: PushFields, email: EmailFields, webhook: WebhookFields }[c.kind];

  async function run(kind, fn) {
    setBusy(kind);
    setError("");
    setTested(false);
    try {
      await fn();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  }
  const test = () => run("test", async () => {
    await api.post("/notify/test", { id: saved?.id ?? null, channel: c });
    setTested(true);
  });
  const save = () => run("save", async () => {
    await api.post(saved ? `/notify/channels/${saved.id}` : "/notify/channels", c);
    onSaved();
  });

  return (
    <Modal
      title={`${saved ? "Change" : "Add"} ${KIND[c.kind].label.toLowerCase()} alerts`}
      onClose={onClose}
      wide
      footer={
        <>
          <button type="button" className={secondaryButton} onClick={test} disabled={!!busy}>
            {busy === "test" ? <LoaderCircle size={15} className="animate-spin" /> : <Send size={15} />}
            Send test
          </button>
          <button type="button" className={primaryButton} onClick={save} disabled={!!busy}>
            {busy === "save" && <LoaderCircle size={15} className="animate-spin" />}
            Save
          </button>
        </>
      }
    >
      <div className="space-y-6">
        <Fields s={c.settings} set={set} saved={saved} />

        <div className="space-y-4 border-t border-edge pt-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name">
              <input className={inputClass} value={c.name} onChange={(e) => setC({ ...c, name: e.target.value })} placeholder={KIND[c.kind].label} />
            </Field>
            <Field label="Send">
              <select className={selectClass} value={c.minSeverity} onChange={(e) => setC({ ...c, minSeverity: e.target.value })}>
                {[...choices.severities].reverse().map((s) => (
                  <option key={s} value={s}>{MIN_LABEL[s]}</option>
                ))}
              </select>
            </Field>
          </div>
          <fieldset>
            <legend className="mb-2 text-sm text-fg">About</legend>
            <div className="grid gap-x-4 gap-y-2 sm:grid-cols-2">
              {choices.categories.map((cat) => (
                <label key={cat.id} className="flex items-start gap-2.5 text-sm text-dim">
                  <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[var(--color-signal)]" checked={c.categories.includes(cat.id)} onChange={() => toggleCat(cat.id)} />
                  <span>{cat.label}</span>
                </label>
              ))}
            </div>
            <p className="mt-2 text-xs text-dim">&ldquo;Back to normal&rdquo; messages, like a device back online, go wherever their problem went.</p>
          </fieldset>
        </div>
        {tested && (
          <p className="flex items-center gap-2 text-sm text-good" role="status">
            <CircleCheck size={16} aria-hidden="true" />
            Test sent. Check that it arrived.
          </p>
        )}
        {error && <p className="text-sm text-alert" role="alert">{error}</p>}
      </div>
    </Modal>
  );
}

// ---- The list --------------------------------------------------------------------------------

function ChannelRow({ c, choices, onEdit, reload }) {
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState(null);
  const Icon = KIND[c.kind].icon;
  async function act(kind, fn) {
    setBusy(kind);
    setMsg(null);
    try {
      await fn();
      reload();
    } catch (err) {
      setMsg({ ok: false, text: err.message });
    } finally {
      setBusy("");
    }
  }
  const cats = c.categories.length === choices.categories.length ? "every kind of event" : `${c.categories.length} of ${choices.categories.length} kinds of events`;
  return (
    <li className="px-5 py-4">
      <div className="flex flex-col gap-4 md:flex-row md:items-center">
        <div className="flex min-w-0 flex-1 items-start gap-3.5">
          <span className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-edge ${c.enabled ? "text-signal" : "text-dim"}`}>
            <Icon size={17} aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <p className={c.enabled ? "text-fg" : "text-dim"}>{c.name}</p>
            <p className="truncate text-sm text-dim">{c.summary}</p>
            <p className="mt-0.5 text-xs text-dim">
              {MIN_LABEL[c.minSeverity]}, {cats}.{" "}
              {c.lastError ? (
                <span className="text-alert">Failing {timeAgo(c.lastErrorAt)}: {c.lastError}</span>
              ) : c.lastSentAt ? (
                <span title={formatDateTime(c.lastSentAt)}>Last sent {timeAgo(c.lastSentAt)}.</span>
              ) : (
                "Nothing sent yet."
              )}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <button type="button" className={`${secondaryButton} h-9 px-3`} disabled={!!busy} onClick={() => act("test", async () => {
            await api.post(`/notify/channels/${c.id}/test`);
            setMsg({ ok: true, text: "Test sent." });
          })}>
            {busy === "test" ? <LoaderCircle size={14} className="animate-spin" /> : <Send size={14} />}
            Test
          </button>
          <button type="button" className={`${secondaryButton} h-9 px-3`} onClick={() => onEdit(c)} aria-label={`Change ${c.name}`}>
            <Pencil size={14} />
          </button>
          <button type="button" className={`${secondaryButton} h-9 px-3`} disabled={!!busy} aria-label={`Remove ${c.name}`} onClick={() => {
            if (window.confirm(`Stop sending alerts to "${c.name}" and remove it?`)) act("remove", () => api.post(`/notify/channels/${c.id}/remove`));
          }}>
            <Trash2 size={14} />
          </button>
          <Switch on={c.enabled} busy={!!busy} label={`Send alerts to ${c.name}`} onChange={(on) => act("enable", () => api.post(`/notify/channels/${c.id}/enabled`, { enabled: on }))} />
        </div>
      </div>
      {msg && <p className={`mt-2 text-sm ${msg.ok ? "text-good" : "text-alert"}`}>{msg.text}</p>}
    </li>
  );
}

function KindPicker({ onPick }) {
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {Object.entries(KIND).map(([id, k]) => (
        <button key={id} type="button" onClick={() => onPick(id)} className="group rounded-lg border border-edge bg-surface p-4 text-left hover:border-signal/60 hover:bg-raised">
          <k.icon size={20} className="text-signal" aria-hidden="true" />
          <p className="mt-3 font-medium text-fg">{k.label}</p>
          <p className="mt-1 text-sm text-dim">{k.blurb}</p>
        </button>
      ))}
    </div>
  );
}

function WatchSettings({ data, reload }) {
  const [s, setS] = useState(data.settings);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const changed = JSON.stringify(s) !== JSON.stringify(data.settings);
  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      await api.post("/notify/settings", { ...s, offlineHours: Number(s.offlineHours), diskPercent: Number(s.diskPercent) });
      setMsg({ ok: true, text: "Saved." });
      reload();
    } catch (err) {
      setMsg({ ok: false, text: err.message });
    } finally {
      setBusy(false);
    }
  }
  const disk = data.disk;
  return (
    <section className="glass rounded-lg border border-edge p-5">
      <h2 className="font-medium">Watch for</h2>
      <p className="mt-1 text-sm text-dim">Problems nothing else reports. They show on the Security page and go out as alerts.</p>
      <div className="mt-5 space-y-4">
        <Field label="Device offline after (hours)" hint={data.offlineDevices ? `${data.offlineDevices} device(s) are past this now.` : "No device is past this now."}>
          <input className={inputClass} inputMode="numeric" value={s.offlineHours} onChange={(e) => setS({ ...s, offlineHours: e.target.value.replace(/\D/g, "") })} />
        </Field>
        <Field
          label="Gateway disk space warning below (%)"
          hint={disk ? `Now ${formatSize(disk.freeBytes)} free of ${formatSize(disk.totalBytes)} (${disk.freePercent} %).` : null}
        >
          <input className={inputClass} inputMode="numeric" value={s.diskPercent} onChange={(e) => setS({ ...s, diskPercent: e.target.value.replace(/\D/g, "") })} />
        </Field>
        <Field label="Gateway name in alerts" hint="So you know which gateway it's about, if you run more than one.">
          <input className={inputClass} value={s.gatewayName} onChange={(e) => setS({ ...s, gatewayName: e.target.value })} />
        </Field>
      </div>
      <div className="mt-5 flex items-center gap-3">
        <button type="button" className={primaryButton} disabled={!changed || busy} onClick={save}>
          Save
        </button>
        {msg && <p className={`text-sm ${msg.ok ? "text-good" : "text-alert"}`}>{msg.text}</p>}
      </div>
    </section>
  );
}

function SentLog({ log }) {
  return (
    <section className="glass rounded-lg border border-edge">
      <h2 className="border-b border-edge px-5 py-4 font-medium">Recently sent</h2>
      {log.length === 0 ? (
        <p className="px-5 py-8 text-center text-sm text-dim">Nothing sent yet.</p>
      ) : (
        <ol className="max-h-[420px] divide-y divide-edge overflow-y-auto">
          {log.map((l) => (
            <li key={l.id} className="flex items-start gap-3 px-5 py-3 text-sm">
              {l.ok ? <CircleCheck size={16} className="mt-0.5 shrink-0 text-good" aria-label="Sent" /> : <CircleX size={16} className="mt-0.5 shrink-0 text-alert" aria-label="Failed" />}
              <div className="min-w-0 flex-1">
                <p className="truncate text-fg" title={l.title}>{l.title}</p>
                <p className="text-xs text-dim">
                  <span title={formatDateTime(l.at)}>{timeAgo(l.at)}</span> to {l.channel}
                  {l.events > 1 ? `, ${l.events} events in one message` : ""}
                </p>
                {l.error && <p className="mt-0.5 text-xs text-alert">{l.error}</p>}
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export default function Alerts() {
  const { data, error, loading, reload } = usePolling("/notify", 10000);
  const [dialog, setDialog] = useState(null); // { initial, saved }
  const [picking, setPicking] = useState(false);

  const add = (kind) => {
    setPicking(false);
    setDialog({ initial: blank(kind, data.choices, data.suggestedTopic), saved: null });
  };

  return (
    <div className="w-full">
      <PageHeader
        title="Alerts"
        action={
          data?.channels.length > 0 && (
            <button type="button" className={primaryButton} onClick={() => setPicking(true)}>
              <Plus size={16} />
              Add a place to send alerts
            </button>
          )
        }
      >
        Malware, ransomware signs, devices going quiet, off-site copies failing: get told on your phone, by email, or in your helpdesk.
      </PageHeader>

      {!data ? (
        <LoadState loading={loading} error={error} onRetry={reload} />
      ) : (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
          <div className="min-w-0 space-y-6">
            {data.channels.length === 0 ? (
              <section className="glass rounded-lg border border-edge p-6">
                <div className="flex items-center gap-3">
                  <BellRing size={20} className="text-signal" aria-hidden="true" />
                  <h2 className="font-medium">Nothing is sent anywhere yet</h2>
                </div>
                <p className="mt-1 text-sm text-dim">Pick where alerts should go. You can add more than one, each with its own rules.</p>
                <div className="mt-5">
                  <KindPicker onPick={add} />
                </div>
              </section>
            ) : (
              <section className="glass rounded-lg border border-edge">
                <h2 className="border-b border-edge px-5 py-4 font-medium">Where alerts go</h2>
                <ul className="divide-y divide-edge">
                  {data.channels.map((c) => (
                    <ChannelRow key={c.id} c={c} choices={data.choices} reload={reload} onEdit={(x) => setDialog({ initial: fromSaved(x), saved: x })} />
                  ))}
                </ul>
              </section>
            )}
            <SentLog log={data.log} />
          </div>
          <div className="space-y-6">
            <WatchSettings key={JSON.stringify(data.settings)} data={data} reload={reload} />
            <section className="rounded-lg border border-edge p-5 text-sm text-dim">
              <p className="flex items-center gap-2 text-fg">
                <BellRing size={15} aria-hidden="true" />
                How alerts are sent
              </p>
              <p className="mt-2">
                Events close together go out as one message, so an attack is one alert, not hundreds. Each place gets at most 20 messages an hour,
                and a failed send is tried again 3 times; if it still fails, it shows at the top of every page here.
              </p>
            </section>
          </div>
        </div>
      )}

      {picking && (
        <Modal title="Add a place to send alerts" onClose={() => setPicking(false)} wide>
          <KindPicker onPick={add} />
        </Modal>
      )}
      {dialog && (
        <ChannelDialog
          initial={dialog.initial}
          saved={dialog.saved}
          choices={data.choices}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            reload();
          }}
        />
      )}
    </div>
  );
}
