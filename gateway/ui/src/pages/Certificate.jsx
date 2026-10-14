// Domain & SSL: the gateway's domain with its https certificate (see gateway/src/address.js). Two
// ways: a server with its own public IP (Caddy gets a free Let's Encrypt certificate), or a machine
// on site with a Cloudflare Tunnel (no port to open). The steps fill in green as they pass: domain
// added, A record points here, SSL certificate, done. Then the web UI is at https://<domain> (with a
// link to open it), opening it by IP is blocked, and devices move to the domain by themselves.

import { useEffect, useRef, useState } from "react";
import { Check, CircleCheck, Cloud, Copy, ExternalLink, Globe, LoaderCircle, Lock, RefreshCw, Server, ShieldCheck, Trash2, TriangleAlert } from "lucide-react";
import { api } from "../api.js";
import { formatDateTime, timeAgo } from "../format.js";
import PageHeader from "../components/PageHeader.jsx";
import LoadState from "../components/LoadState.jsx";
import Modal from "../components/Modal.jsx";
import { inputClass, primaryButton, secondaryButton } from "../components/buttons.js";

// "backup" for backup.example.com, "@" for example.com (two-part endings like .co.uk too)
function hostPart(name) {
  const parts = name.split(".");
  const suffix = /\.(co|com|net|org|gov|edu|ac)\.[a-z]{2}$/.test(name) ? 2 : 1;
  const extra = parts.length - (suffix + 1);
  return extra > 0 ? parts.slice(0, extra).join(".") : "@";
}

function CopyValue({ value, label, mono = true }) {
  const [done, setDone] = useState(false);
  return (
    <span className="flex min-w-0 items-center justify-between gap-2">
      <span className={`truncate ${mono ? "font-mono" : ""} text-fg`}>{value}</span>
      <button
        type="button"
        aria-label={`Copy ${label}`}
        title={`Copy ${label}`}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-dim hover:bg-raised hover:text-fg"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setDone(true);
            setTimeout(() => setDone(false), 1500);
          } catch {
            window.prompt(`Copy the ${label}:`, value);
          }
        }}
      >
        {done ? <Check size={15} className="text-good" /> : <Copy size={15} />}
      </button>
    </span>
  );
}

// The steps, filled in as they happen; the one being worked on shimmers
function Steps({ steps }) {
  const current = steps.findIndex((s) => !s.done);
  return (
    <ol className="grid grid-cols-2 gap-x-3 gap-y-4 sm:grid-cols-4" aria-label="Progress">
      {steps.map((s, i) => (
        <li key={s.id} className="flex min-w-0 flex-col gap-2">
          <span className="relative h-1.5 overflow-hidden rounded-full bg-raised">
            <span
              className={`absolute inset-y-0 left-0 rounded-full transition-[width] duration-700 ease-out ${s.done ? "w-full bg-good" : i === current ? "w-1/3 bg-signal motion-safe:animate-pulse" : "w-0"}`}
            />
          </span>
          <span className={`flex items-center gap-1.5 text-xs ${s.done ? "font-medium text-good" : i === current ? "text-fg" : "text-dim"}`}>
            {s.done ? (
              <CircleCheck size={14} className="shrink-0" aria-hidden="true" />
            ) : i === current ? (
              <LoaderCircle size={14} className="shrink-0 motion-safe:animate-spin" aria-hidden="true" />
            ) : (
              <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border border-current text-[9px]">{i + 1}</span>
            )}
            <span className="min-w-0 leading-tight [word-spacing:0.15em]">{s.label}</span>
            <span className="sr-only">{s.done ? "(done)" : i === current ? "(in progress)" : "(to do)"}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

function Note({ tone = "dim", children }) {
  const tones = {
    dim: "border-edge bg-raised/40 text-dim",
    warn: "border-warn/40 bg-warn/10 text-warn",
    good: "border-good/40 bg-good/10 text-good",
  };
  const Icon = tone === "good" ? CircleCheck : TriangleAlert;
  return (
    <div className={`flex gap-2.5 rounded-md border px-4 py-3 text-sm ${tones[tone]}`}>
      {tone !== "dim" && <Icon size={16} className="mt-0.5 shrink-0" aria-hidden="true" />}
      <div className="min-w-0 space-y-1">{children}</div>
    </div>
  );
}

function DnsRecord({ domain, ip }) {
  return (
    <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] items-center gap-x-3 gap-y-1 rounded-md border border-edge bg-raised/40 px-4 py-3 text-sm">
      <span className="text-xs text-dim">Type</span>
      <span className="font-mono text-fg">A</span>
      <span className="text-xs text-dim">Name / Host</span>
      <CopyValue value={hostPart(domain)} label="name" />
      <span className="text-xs text-dim">Value</span>
      {ip ? <CopyValue value={ip} label="IP address" /> : <span className="text-dim">this server&rsquo;s public IP (finding it…)</span>}
    </div>
  );
}

// ---------- Before it's set up: pick a way, fill it in ----------

function Choice({ icon: Icon, title, children, selected, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={`glass flex w-full items-start gap-3 rounded-lg border p-5 text-left transition-colors ${selected ? "border-signal bg-signal/10" : "border-edge hover:bg-raised"}`}
    >
      <Icon size={20} className={`mt-0.5 shrink-0 ${selected ? "text-signal" : "text-dim"}`} aria-hidden="true" />
      <span className="min-w-0">
        <span className="block font-medium text-fg">{title}</span>
        <span className="mt-1 block text-sm text-dim">{children}</span>
      </span>
    </button>
  );
}

function CaddyForm({ data, onDone }) {
  const [domain, setDomain] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const clean = domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  return (
    <form
      className="space-y-5"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        try {
          onDone(await api.post("/address/caddy", { domain, email }));
        } catch (err) {
          setError(err.message);
          setBusy(false);
        }
      }}
    >
      <div className="rounded-md border border-edge bg-raised/40 px-4 py-3 text-sm">
        <p className="text-xs text-dim">This server&rsquo;s public IP</p>
        {data.serverIp ? <CopyValue value={data.serverIp} label="IP address" /> : <p className="text-dim">Couldn&rsquo;t find it. Check this server can reach the internet.</p>}
      </div>
      <label className="block text-sm">
        <span className="mb-1.5 block text-fg">The address devices will use</span>
        <input className={inputClass} value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="backup.yourcompany.com" autoCapitalize="none" spellCheck={false} required />
      </label>
      {clean.includes(".") && (
        <div className="space-y-2 text-sm">
          <p className="text-dim">
            At the company your domain is with, open its <span className="text-fg">DNS</span> settings and add this record (Cloudflare: leave the cloud grey, DNS only):
          </p>
          <DnsRecord domain={clean} ip={data.serverIp} />
        </div>
      )}
      <label className="block text-sm">
        <span className="mb-1.5 block text-fg">Your email (optional)</span>
        <input className={inputClass} type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@protonic.com" />
        <span className="mt-1 block text-xs text-dim">Let&rsquo;s Encrypt only writes if something&rsquo;s wrong with the certificate.</span>
      </label>
      {error && <Note tone="warn">{error}</Note>}
      <button type="submit" className={`${primaryButton} w-full sm:w-auto`} disabled={busy}>
        {busy ? <LoaderCircle size={16} className="animate-spin" /> : <Lock size={16} />}
        Get certificate
      </button>
    </form>
  );
}

function TunnelForm({ data, onDone }) {
  const [domain, setDomain] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <form
      className="space-y-5"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        try {
          onDone(await api.post("/address/tunnel", { domain, token }));
        } catch (err) {
          setError(err.message);
          setBusy(false);
        }
      }}
    >
      <ol className="space-y-3 text-sm text-dim">
        <li className="flex gap-3">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-raised text-xs text-fg">1</span>
          <span>
            In the Cloudflare dashboard, open <span className="text-fg">Zero Trust &gt; Networks &gt; Tunnels</span>, choose{" "}
            <span className="text-fg">Create a tunnel</span>, then <span className="text-fg">Cloudflared</span>, and give it a name.
          </span>
        </li>
        <li className="flex gap-3">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-raised text-xs text-fg">2</span>
          <span>Copy the install command it shows (any system). The token is in it: paste the whole command below, it&rsquo;s picked out.</span>
        </li>
        <li className="flex gap-3">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-raised text-xs text-fg">3</span>
          <span className="min-w-0 flex-1">
            Under <span className="text-fg">Public hostname</span>, pick the address (e.g. backup + yourcompany.com), with service type{" "}
            <span className="text-fg">HTTP</span> and this URL:
            <span className="mt-1.5 block rounded-md border border-edge bg-raised/40 px-3 py-1.5">
              <CopyValue value={`localhost:${data.agentPort}`} label="URL" />
            </span>
          </span>
        </li>
      </ol>
      <label className="block text-sm">
        <span className="mb-1.5 block text-fg">The public hostname you set</span>
        <input className={inputClass} value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="backup.yourcompany.com" autoCapitalize="none" spellCheck={false} required />
      </label>
      <label className="block text-sm">
        <span className="mb-1.5 block text-fg">Tunnel token (or the whole install command)</span>
        <input className={`${inputClass} font-mono`} type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder="eyJ…" required />
        <span className="mt-1 block text-xs text-dim">Kept on this gateway only. It&rsquo;s never shown again.</span>
      </label>
      {!data.tunnel.installed && <Note tone="warn">cloudflared isn&rsquo;t installed on this computer yet. Run deploy/install.sh again and choose online.</Note>}
      {error && <Note tone="warn">{error}</Note>}
      <button type="submit" className={`${primaryButton} w-full sm:w-auto`} disabled={busy}>
        {busy ? <LoaderCircle size={16} className="animate-spin" /> : <Cloud size={16} />}
        Connect
      </button>
    </form>
  );
}

// ---------- Once it's set up: where it's at ----------

const BADGE = {
  live: { label: "Secure, in use", cls: "border-good/40 bg-good/10 text-good", icon: Lock },
  working: { label: "Setting up", cls: "border-signal/40 bg-signal/10 text-signal", icon: LoaderCircle },
  problem: { label: "Needs attention", cls: "border-warn/40 bg-warn/10 text-warn", icon: TriangleAlert },
};

function whatsNext(data) {
  const step = data.steps.find((s) => !s.done)?.id;
  if (data.mode === "caddy") {
    if (data.caddy.foreign) return { tone: "warn", text: "Caddy on this computer is now used by something else, so the gateway left it alone. Use a Cloudflare Tunnel instead." };
    if (!data.caddy.reachable) return { tone: "warn", text: "Caddy isn't answering on this computer. Check it's running: systemctl status caddy" };
    if (data.caddy.error) return { tone: "warn", text: `Caddy didn't take the settings: ${data.caddy.error}` };
    if (step === "dns") return { tone: "dim", dns: true };
    if (step === "certificate")
      return {
        tone: "dim",
        text: `DNS is right. Caddy is getting the certificate from Let's Encrypt, usually within a minute. Ports 80 and 443 must be open in your cloud provider's firewall.${data.certificate?.problem ? ` (${data.certificate.problem})` : ""}`,
      };
    if (step === "live") return { tone: "warn", text: `The certificate works, but https://${data.domain} doesn't reach this gateway yet. Check the DNS record points at this server.` };
  } else {
    if (data.tunnel.error) return { tone: "warn", text: `Cloudflare said: ${data.tunnel.error}. Copy the token again from the dashboard.` };
    if (step === "tunnel") return { tone: "dim", text: "Starting the tunnel and connecting to Cloudflare…" };
    if (step === "certificate")
      return {
        tone: "dim",
        text: `The tunnel is connected. Waiting for ${data.domain} to answer over https: check the public hostname is set on this tunnel in Cloudflare.${data.certificate?.problem ? ` (${data.certificate.problem})` : ""}`,
      };
    if (step === "live")
      return { tone: "warn", text: `https://${data.domain} answers, but not with this gateway. In Cloudflare, set the public hostname's service to HTTP and localhost:${data.agentPort}.` };
  }
  return null;
}

function Status({ data, reload, checking }) {
  const [removing, setRemoving] = useState(false);
  const next = whatsNext(data);
  const badge = data.live ? BADGE.live : next?.tone === "warn" ? BADGE.problem : BADGE.working;
  const BadgeIcon = badge.icon;
  return (
    <section className="glass rounded-lg border border-edge">
      <div className="flex flex-col gap-3 border-b border-edge px-5 py-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="flex items-center gap-2 break-all text-lg font-medium">
            {data.live && <Lock size={17} className="shrink-0 text-good" aria-hidden="true" />}
            {data.domain}
          </p>
          <p className="text-sm text-dim">
            {data.mode === "caddy" ? "This server, with Caddy and a Let's Encrypt certificate" : `Cloudflare Tunnel ${data.tunnelId?.slice(0, 8) ?? ""}`}
            {data.since && `, set up ${timeAgo(new Date(data.since).toISOString())}`}
          </p>
        </div>
        <span className={`inline-flex shrink-0 items-center gap-1.5 self-start rounded-full border px-2.5 py-1 text-xs font-medium ${badge.cls}`}>
          <BadgeIcon size={13} className={badge === BADGE.working ? "motion-safe:animate-spin" : ""} aria-hidden="true" />
          {badge.label}
        </span>
      </div>

      <div className="space-y-5 px-5 py-5">
        <Steps steps={data.steps} />

        {data.live ? (
          <div className="space-y-4">
            <Note tone="good">
              <p>
                Secure and in use.
                {data.certificate?.issuer &&
                  ` Certificate from ${data.certificate.issuer}${data.certificate.expiresAt ? `, renewed by itself before ${formatDateTime(new Date(data.certificate.expiresAt).toISOString())}` : ""}.`}
              </p>
            </Note>
            {data.webUiUrl && (
              <div className="rounded-lg border border-edge bg-raised/40 p-4">
                <p className="text-sm text-dim">This web UI is now at</p>
                <a
                  href={data.webUiUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`${primaryButton} mt-3 w-full justify-center break-all sm:w-auto`}
                >
                  <ExternalLink size={16} className="shrink-0" aria-hidden="true" />
                  Open {data.domain}
                </a>
                <p className="mt-2 text-xs text-dim">Opens in a new tab. Bookmark it and use it from now on.</p>
              </div>
            )}
            <ul className="space-y-2 text-sm text-dim">
              <li className="flex gap-2">
                <ShieldCheck size={16} className="mt-0.5 shrink-0 text-good" aria-hidden="true" />
                <span>Opening this gateway by its IP address in a browser is blocked: it&rsquo;s only used over https now.</span>
              </li>
              <li className="flex gap-2">
                <ShieldCheck size={16} className="mt-0.5 shrink-0 text-good" aria-hidden="true" />
                <span>
                  New devices are installed with <span className="break-all font-mono text-fg">https://{data.domain}</span>, and devices already installed
                  move to it by themselves. They can still connect by IP if the domain ever has a problem.
                </span>
              </li>
            </ul>
          </div>
        ) : next?.dns ? (
          <div className="space-y-2 text-sm">
            <p className="text-dim">At the company your domain is with, add this DNS record. It can take a few minutes to show up.</p>
            <DnsRecord domain={data.domain} ip={data.serverIp} />
            {data.found.length > 0 && (
              <p className="text-xs text-dim">
                Right now it points to: <span className="font-mono">{data.found.map((f) => `${f.type} ${f.value}`).join(", ")}</span>
              </p>
            )}
          </div>
        ) : (
          next && <Note tone={next.tone}>{next.text}</Note>
        )}

        {!data.trustProxy && (
          <Note tone="warn">
            This gateway is still set up for one network only. Run <span className="break-all font-mono">sudo bash deploy/install.sh</span> again and choose
            online, so the domain works and devices&rsquo; real addresses show up in the logs.
          </Note>
        )}

        <div className="flex flex-col gap-3 border-t border-edge pt-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-dim">{data.checkedAt
              ? `Checked ${timeAgo(new Date(data.checkedAt).toISOString())}${data.live ? "" : ", and again every 10 seconds"}`
              : "Checking now"}</p>
          <div className="grid grid-cols-2 gap-2 sm:flex">
            <button type="button" className={secondaryButton} onClick={reload} disabled={checking}>
              <RefreshCw size={15} className={checking ? "motion-safe:animate-spin" : ""} />
              Check now
            </button>
            <button type="button" className={secondaryButton} onClick={() => setRemoving(true)}>
              <Trash2 size={15} />
              Remove
            </button>
          </div>
        </div>
      </div>

      {removing && (
        <Modal
          title={`Stop using ${data.domain}?`}
          onClose={() => setRemoving(false)}
          footer={
            <>
              <button type="button" className={secondaryButton} onClick={() => setRemoving(false)}>
                Cancel
              </button>
              <button
                type="button"
                className={`${primaryButton} bg-alert text-night`}
                onClick={async () => {
                  await api.post("/address/remove");
                  setRemoving(false);
                  reload();
                }}
              >
                Stop using it
              </button>
            </>
          }
        >
          <p className="text-sm text-dim">
            {data.mode === "caddy" ? "Caddy stops answering for it" : "The tunnel is stopped"}, and new install links go back to{" "}
            {data.envUrl ?? "this computer's own address"}. Devices installed with <span className="font-mono">https://{data.domain}</span> can&rsquo;t reach
            the gateway until it&rsquo;s set up again.
          </p>
        </Modal>
      )}
    </section>
  );
}

export default function Certificate() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);
  const [way, setWay] = useState(null);
  const timer = useRef(null);

  const load = async (check = false) => {
    setChecking(check);
    try {
      setData(await (check ? api.post("/address/check") : api.get("/address")));
      setError("");
    } catch (err) {
      setError(err.message);
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  // While it's being set up, look again every 10 seconds; once it works, every minute
  useEffect(() => {
    clearTimeout(timer.current);
    if (!data?.mode) return undefined;
    timer.current = setTimeout(() => load(!data.live), data.live ? 60_000 : 10_000);
    return () => clearTimeout(timer.current);
  }, [data]);

  return (
    <div className="w-full">
      <PageHeader title="Domain & SSL certificate">
        Give the gateway a domain with a free SSL certificate. Once it&rsquo;s done, this web UI and your devices use it over https, and opening the
        gateway by its IP address is blocked.
      </PageHeader>

      {!data ? (
        <LoadState loading={!error} error={error} onRetry={() => load()} />
      ) : data.mode ? (
        <div className="max-w-3xl">
          <Status data={data} reload={() => load(true)} checking={checking} />
        </div>
      ) : (
        <div className="max-w-3xl space-y-6">
          <Note>
            <p>
              {data.publicUrl ? (
                <>
                  Right now devices are installed with <span className="break-all font-mono text-fg">{data.publicUrl}</span>, without https.
                </>
              ) : (
                "Right now devices and this web UI use the gateway's IP address, without https."
              )}{" "}
              Add a domain to make it secure.
            </p>
          </Note>
          <div className="grid gap-4 sm:grid-cols-2">
            <Choice icon={Server} title="This server has its own IP" selected={way === "caddy"} onClick={() => setWay("caddy")}>
              A cloud server (Linode…). Point your domain at it, and a free certificate is made and renewed by itself.
            </Choice>
            <Choice icon={Cloud} title="On site, with a Cloudflare Tunnel" selected={way === "tunnel"} onClick={() => setWay("tunnel")}>
              A machine at the office. No port to open on the router. Needs a domain on Cloudflare.
            </Choice>
          </div>
          {way && (
            <section className="glass rounded-lg border border-edge p-5">
              <h2 className="mb-4 flex items-center gap-2 font-medium">
                <Globe size={17} className="text-signal" aria-hidden="true" />
                {way === "caddy" ? "Your domain and certificate" : "Connect the tunnel"}
              </h2>
              {way === "caddy" ? <CaddyForm data={data} onDone={setData} /> : <TunnelForm data={data} onDone={setData} />}
            </section>
          )}
        </div>
      )}
    </div>
  );
}
