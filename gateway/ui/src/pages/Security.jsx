// Security: what the antivirus (ClamAV) and the ransomware checks are seeing, live.
//   - posture: are things clear, is something being watched, or was a threat found
//   - numbers for the chosen time range, and a timeline of scans with the events under it
//   - top detections and devices ranked by risk
//   - the live event feed (filter, search, click an event for its details)
//   - the antivirus engine: status, signatures, rescans

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import {
  Activity, AlertOctagon, AlertTriangle, Bug, CircleDot, Info, Pause, Play, Radar, RefreshCw, Search, ShieldAlert,
  ShieldCheck, ShieldQuestion, Snowflake, Square, X,
} from "lucide-react";
import { api } from "../api.js";
import { usePolling } from "../usePolling.js";
import { formatDateTime, formatSize, timeAgo } from "../format.js";
import PageHeader from "../components/PageHeader.jsx";
import LoadState from "../components/LoadState.jsx";
import { secondaryButton } from "../components/buttons.js";

const filterInput = "h-8 rounded-md border border-edge bg-raised px-2.5 text-sm text-fg placeholder:text-dim/60 focus:border-signal focus:outline-none";

const SEV = {
  critical: { label: "Critical", icon: AlertOctagon, text: "text-sev-critical", bg: "bg-sev-critical", ring: "border-sev-critical/50 bg-sev-critical/10" },
  high: { label: "High", icon: AlertTriangle, text: "text-sev-high", bg: "bg-sev-high", ring: "border-sev-high/50 bg-sev-high/10" },
  medium: { label: "Medium", icon: CircleDot, text: "text-sev-medium", bg: "bg-sev-medium", ring: "border-sev-medium/40 bg-sev-medium/10" },
  low: { label: "Low", icon: Info, text: "text-sev-low", bg: "bg-sev-low", ring: "border-sev-low/40 bg-sev-low/10" },
  info: { label: "Info", icon: Info, text: "text-dim", bg: "bg-dim", ring: "border-edge bg-raised" },
};
const SEV_ORDER = ["critical", "high", "medium", "low", "info"];
const RANGES = [
  ["24h", "24 hours"],
  ["7d", "7 days"],
  ["30d", "30 days"],
];
const KIND_LABEL = {
  "malware.detected": "Malware",
  "ransomware.suspicious": "Ransomware signs",
  "ransomware.mass-delete": "Mass deletion",
  "device.frozen": "Device frozen",
  "device.unfrozen": "Device unfrozen",
  "quarantine.released": "Released",
  "quarantine.rejected": "Rejected",
  "engine.up": "Antivirus",
  "engine.down": "Antivirus",
  "engine.missing": "Antivirus",
  "engine.signatures": "Signatures",
  "scan.backlog": "Scan",
  "scan.rescan": "Rescan",
  "scan.requested": "Rescan",
  "admin.login-failed": "Login",
  "admin.login-blocked": "Login",
  "agent.update-offered": "Agent update",
  "agent.updated": "Agent update",
  "agent.update-failed": "Agent update",
};
const LEVEL = {
  critical: { label: "Critical", cls: "border-sev-critical/50 bg-sev-critical/10 text-sev-critical" },
  high: { label: "High", cls: "border-sev-high/50 bg-sev-high/10 text-sev-high" },
  elevated: { label: "Elevated", cls: "border-sev-medium/40 bg-sev-medium/10 text-sev-medium" },
  low: { label: "Low", cls: "border-edge bg-raised text-dim" },
};

function SevPill({ severity, compact = false }) {
  const s = SEV[severity] ?? SEV.info;
  const Icon = s.icon;
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${s.ring} ${s.text}`}>
      <Icon size={12} aria-hidden="true" />
      {!compact && s.label}
      {compact && <span className="sr-only">{s.label}</span>}
    </span>
  );
}

const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 100);

// ---- Posture: the one-line verdict at the top ------------------------------------------------

function Posture({ o }) {
  const critical = o.bySeverity.critical ?? 0;
  const high = o.bySeverity.high ?? 0;
  let p;
  if (o.frozen) p = { icon: Snowflake, tone: "text-sev-critical", edge: "border-sev-critical/50", title: `${o.frozen} device${o.frozen === 1 ? "" : "s"} frozen`, text: "An attack looked underway. New changes from it are held back until you review them." };
  else if (critical) p = { icon: ShieldAlert, tone: "text-sev-critical", edge: "border-sev-critical/50", title: `${critical} critical event${critical === 1 ? "" : "s"}`, text: "Threats were found and held back. Nothing infected was restored or sent off-site." };
  else if (high || o.quarantined) p = { icon: ShieldQuestion, tone: "text-sev-high", edge: "border-sev-high/40", title: "Needs a look", text: `${o.quarantined} file version${o.quarantined === 1 ? "" : "s"} waiting in quarantine${high ? `, ${high} high-severity event${high === 1 ? "" : "s"}` : ""}.` };
  else p = { icon: ShieldCheck, tone: "text-good", edge: "border-good/40", title: "All clear", text: "No threats found in this period. Every new file is checked as it arrives." };
  const Icon = p.icon;
  return (
    <section className={`glass flex flex-col gap-5 rounded-lg border ${p.edge} p-5 lg:flex-row lg:items-center lg:justify-between`}>
      <div className="flex items-start gap-4">
        <span className={`relative mt-0.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-full border ${p.edge} ${p.tone}`}>
          <Icon size={22} aria-hidden="true" />
        </span>
        <div>
          <p className={`font-display text-xl font-semibold ${p.tone}`}>{p.title}</p>
          <p className="mt-0.5 max-w-xl text-sm text-dim">{p.text}</p>
        </div>
      </div>
      <EngineChip engine={o.engine} work={o.work} />
    </section>
  );
}

function EngineChip({ engine, work }) {
  const up = engine.available;
  return (
    <div className="flex items-center gap-3 rounded-md border border-edge bg-raised px-4 py-2.5 text-sm">
      <span className="relative flex h-2.5 w-2.5" aria-hidden="true">
        {up && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-good opacity-60 motion-reduce:hidden" />}
        <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${up ? "bg-good" : engine.enabled ? "bg-sev-high" : "bg-dim"}`} />
      </span>
      <div>
        <p className="text-fg">
          {up ? `ClamAV ${engine.engine ?? ""} scanning` : engine.enabled ? "Antivirus not running" : "Antivirus turned off"}
        </p>
        <p className="text-xs text-dim">
          {work.running
            ? `${work.kind === "rescan" ? "Rescanning" : "Catching up"}: ${work.done.toLocaleString()} of ${work.total.toLocaleString()}`
            : up
              ? engine.signaturesDate
                ? `Signatures ${engine.signatures ?? ""} from ${timeAgo(engine.signaturesDate)}`
                : "Custom signatures"
              : "Ransomware checks still on"}
        </p>
      </div>
    </div>
  );
}

// ---- Numbers ---------------------------------------------------------------------------------

function Kpi({ label, value, sub, tone = "text-fg", icon: Icon }) {
  return (
    <div className="glass rounded-lg border border-edge px-4 py-3.5">
      <p className="flex items-center gap-1.5 text-xs text-dim">
        {Icon && <Icon size={13} aria-hidden="true" />}
        {label}
      </p>
      <p className={`mt-1.5 font-display text-2xl font-semibold tabular-nums ${tone}`}>{value}</p>
      {sub && <p className="mt-0.5 text-xs text-dim">{sub}</p>}
    </div>
  );
}

// ---- Timeline: scans per slot, with the events under them ---------------------------------------

function slotLabel(t, range) {
  const d = new Date(t.length === 10 ? `${t}T00:00:00Z` : `${t}:00:00Z`);
  if (range === "30d") return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  if (range === "7d") return `${d.toLocaleDateString(undefined, { weekday: "short", day: "numeric" })} ${d.toLocaleTimeString(undefined, { hour: "numeric" })}`;
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function Timeline({ data, range }) {
  const [hover, setHover] = useState(null);
  const H = 120;
  const LANE = 16;
  const lanes = ["critical", "high", "medium"];
  const n = data.length;
  const max = Math.max(4, ...data.map((b) => b.scanned));
  const nice = max <= 10 ? 10 : 10 ** Math.floor(Math.log10(max)) * Math.ceil(max / 10 ** Math.floor(Math.log10(max)));
  const slot = 10;
  const W = n * slot;
  const h = hover != null ? data[hover] : null;
  const ticks = [0, Math.floor(n / 2), n - 1];

  return (
    <div>
      <div className="flex gap-3">
        <div className="flex w-14 shrink-0 flex-col text-right text-xs text-dim">
          <div className="flex flex-col justify-between" style={{ height: H }}>
            <span className="tabular-nums">{nice.toLocaleString()}</span>
            <span>0</span>
          </div>
          {lanes.map((l) => (
            <span key={l} className="flex items-center justify-end text-[11px] leading-none" style={{ height: LANE }}>
              {SEV[l].label}
            </span>
          ))}
        </div>
        <div className="relative min-w-0 flex-1" onMouseLeave={() => setHover(null)}>
          <svg viewBox={`0 0 ${W} ${H + LANE * lanes.length}`} preserveAspectRatio="none" className="block w-full" style={{ height: H + LANE * lanes.length }} role="img" aria-label="Files scanned per time slot, with security events below">
            <line x1="0" x2={W} y1="0.5" y2="0.5" stroke="var(--color-edge)" strokeDasharray="2 3" vectorEffect="non-scaling-stroke" />
            <line x1="0" x2={W} y1={H - 0.5} y2={H - 0.5} stroke="var(--color-edge)" vectorEffect="non-scaling-stroke" />
            {data.map((b, i) => {
              const bh = b.scanned ? Math.max(2, (b.scanned / nice) * (H - 4)) : 0;
              return (
                <g key={b.t}>
                  {bh > 0 && <rect x={i * slot + 1} y={H - bh} width={slot - 2} height={bh} rx="2" fill="var(--color-series-scan)" opacity={hover == null || hover === i ? 1 : 0.5} />}
                  {lanes.map((l, li) => {
                    const c = b.events[l];
                    if (!c) return null;
                    const r = Math.min(4.2, 2 + Math.log2(c + 1));
                    return <ellipse key={l} cx={i * slot + slot / 2} cy={H + li * LANE + LANE / 2} rx={r} ry={r * (LANE / slot) * 0.75} fill={`var(--color-sev-${l})`} />;
                  })}
                  <rect x={i * slot} y="0" width={slot} height={H + LANE * lanes.length} fill="transparent" onMouseEnter={() => setHover(i)} />
                </g>
              );
            })}
          </svg>
          {h && (
            <div
              className="pointer-events-none absolute top-0 z-10 w-56 rounded-md border border-edge bg-solid px-3 py-2 text-xs shadow-xl"
              style={{ left: `${((hover + 0.5) / n) * 100}%`, transform: hover > n * 0.6 ? "translateX(calc(-100% - 8px))" : "translateX(8px)" }}
            >
              <p className="font-medium text-fg">{slotLabel(h.t, range)}</p>
              <p className="mt-1.5 flex justify-between text-dim">
                <span className="flex items-center gap-2"><span className="h-2 w-2 rounded-sm bg-series-scan" />Files scanned</span>
                <span className="text-fg tabular-nums">{h.scanned.toLocaleString()}</span>
              </p>
              <p className="mt-1 flex justify-between text-dim"><span>Malware found</span><span className="text-fg tabular-nums">{h.infected}</span></p>
              <p className="mt-1 flex justify-between text-dim"><span>Ransomware signs</span><span className="text-fg tabular-nums">{h.suspicious}</span></p>
              {SEV_ORDER.filter((s) => h.events[s]).map((s) => (
                <p key={s} className="mt-1 flex justify-between text-dim">
                  <span className="flex items-center gap-2"><span className={`h-2 w-2 rounded-full ${SEV[s].bg}`} />{SEV[s].label} events</span>
                  <span className="text-fg tabular-nums">{h.events[s]}</span>
                </p>
              ))}
            </div>
          )}
          <div className="relative mt-2 h-4 text-xs text-dim">
            {ticks.map((i) => (
              <span key={i} className="absolute whitespace-nowrap" style={{ left: `${(i / n) * 100}%`, transform: i === 0 ? "none" : i === n - 1 ? "translateX(-100%)" : "translateX(-50%)" }}>
                {slotLabel(data[i].t, range)}
              </span>
            ))}
          </div>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-dim">
        <span className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-sm bg-series-scan" aria-hidden="true" />Files scanned</span>
        {lanes.map((l) => (
          <span key={l} className="flex items-center gap-2"><span className={`h-2.5 w-2.5 rounded-full ${SEV[l].bg}`} aria-hidden="true" />{SEV[l].label} events</span>
        ))}
      </div>
    </div>
  );
}

// ---- Top detections and devices at risk ------------------------------------------------------

function TopDetections({ items }) {
  if (!items.length) {
    return <p className="flex items-center gap-2 py-6 text-sm text-dim"><ShieldCheck size={16} className="text-good" aria-hidden="true" />No malware found in this period.</p>;
  }
  const max = Math.max(...items.map((i) => i.n));
  return (
    <ol className="space-y-3">
      {items.map((x) => (
        <li key={x.signature}>
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="min-w-0 truncate font-mono text-fg" title={x.signature}>{x.signature}</span>
            <span className="shrink-0 tabular-nums text-dim">{x.n}</span>
          </div>
          <div className="mt-1 h-1.5 rounded-full bg-raised">
            <div className="h-1.5 rounded-full bg-sev-critical" style={{ width: `${(x.n / max) * 100}%` }} />
          </div>
          <p className="mt-0.5 text-xs text-dim">last {timeAgo(x.last)}</p>
        </li>
      ))}
    </ol>
  );
}

function DeviceRisk({ devices, onPick, picked }) {
  return (
    <ul className="divide-y divide-edge">
      {devices.map((d) => {
        const lv = LEVEL[d.level];
        return (
          <li key={d.id}>
            <button
              type="button"
              onClick={() => onPick(picked === d.id ? "" : d.id)}
              aria-pressed={picked === d.id}
              className={`flex w-full items-center gap-3 px-1 py-2.5 text-left hover:bg-raised ${picked === d.id ? "bg-raised" : ""}`}
            >
              <span className={`w-20 shrink-0 rounded-full border px-2 py-0.5 text-center text-xs font-medium ${lv.cls}`}>{lv.label}</span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 truncate text-sm text-fg">
                  {d.name}
                  {d.frozen && <Snowflake size={13} className="text-sev-critical" aria-label="frozen" />}
                </span>
                <span className="block truncate text-xs text-dim">
                  {d.client}
                  {d.malware ? ` · ${d.malware} malware` : ""}
                  {d.ransomware ? ` · ${d.ransomware} ransomware signs` : ""}
                  {d.quarantined ? ` · ${d.quarantined} held` : ""}
                </span>
              </span>
              <span className="hidden shrink-0 text-right text-xs text-dim sm:block">
                {d.lastScan ? `scanned ${timeAgo(d.lastScan)}` : "not scanned yet"}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

// ---- Live event feed -------------------------------------------------------------------------

function useEventFeed(filters, paused) {
  const [events, setEvents] = useState([]);
  const [error, setError] = useState("");
  const [fresh, setFresh] = useState(() => new Set());
  const latest = useRef(null);
  const key = JSON.stringify(filters);

  const qs = useCallback(
    (extra) => {
      const p = new URLSearchParams();
      if (filters.severity.length) p.set("severity", filters.severity.join(","));
      if (filters.kind) p.set("kind", filters.kind);
      if (filters.device) p.set("device", filters.device);
      if (filters.q) p.set("q", filters.q);
      for (const [k, v] of Object.entries(extra)) p.set(k, v);
      return p.toString();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );

  useEffect(() => {
    let alive = true;
    latest.current = null;
    setFresh(new Set());
    api
      .get(`/security/events?${qs({ limit: 150 })}`)
      .then((r) => {
        if (!alive) return;
        setEvents(r.events);
        latest.current = r.latestId;
        setError("");
      })
      .catch((err) => alive && setError(err.message));
    return () => {
      alive = false;
    };
  }, [qs]);

  useEffect(() => {
    if (paused) return;
    const timer = setInterval(async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const r = await api.get(`/security/events?${qs({ limit: 100, ...(latest.current ? { after: latest.current } : {}) })}`);
        if (!r.events.length) return;
        latest.current = r.latestId;
        setFresh(new Set(r.events.map((e) => e.id)));
        setEvents((old) => [...r.events, ...old].slice(0, 400));
      } catch (err) {
        setError(err.message);
      }
    }, 3000);
    return () => clearInterval(timer);
  }, [qs, paused]);

  return { events, error, fresh };
}

function EventFeed({ devices, device, setDevice, onOpen }) {
  const [severity, setSeverity] = useState([]);
  const [kind, setKind] = useState("");
  const [typed, setTyped] = useState("");
  const [q, setQ] = useState("");
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setQ(typed.trim()), 300);
    return () => clearTimeout(t);
  }, [typed]);
  const filters = useMemo(() => ({ severity, kind, device, q }), [severity, kind, device, q]);
  const { events, error, fresh } = useEventFeed(filters, paused);
  const toggle = (s) => setSeverity((list) => (list.includes(s) ? list.filter((x) => x !== s) : [...list, s]));

  return (
    <section className="glass rounded-lg border border-edge">
      <div className="space-y-3 border-b border-edge p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <h2 className="font-medium">Event feed</h2>
            <span className={`flex items-center gap-1.5 text-xs ${paused ? "text-dim" : "text-good"}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${paused ? "bg-dim" : "animate-pulse bg-good motion-reduce:animate-none"}`} aria-hidden="true" />
              {paused ? "Paused" : "Live"}
            </span>
          </div>
          <button type="button" className={`${secondaryButton} h-8 px-3`} onClick={() => setPaused((p) => !p)}>
            {paused ? <Play size={14} /> : <Pause size={14} />}
            {paused ? "Resume" : "Pause"}
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Severity">
            {SEV_ORDER.map((s) => {
              const on = severity.includes(s);
              const S = SEV[s];
              return (
                <button key={s} type="button" aria-pressed={on} onClick={() => toggle(s)} className={`inline-flex h-8 items-center gap-1 rounded-full border px-2.5 text-xs ${on ? `${S.ring} ${S.text}` : "border-edge text-dim hover:text-fg"}`}>
                  <S.icon size={12} aria-hidden="true" />
                  {S.label}
                </button>
              );
            })}
          </div>
          <select aria-label="Event type" className={filterInput} value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">All types</option>
            <option value="malware">Malware</option>
            <option value="ransomware">Ransomware signs</option>
            <option value="device">Frozen / unfrozen</option>
            <option value="quarantine">Quarantine decisions</option>
            <option value="engine">Antivirus engine</option>
            <option value="scan">Scans</option>
            <option value="admin">Logins</option>
            <option value="agent">Agent updates</option>
          </select>
          <select aria-label="Device" className={`${filterInput} max-w-44`} value={device} onChange={(e) => setDevice(e.target.value)}>
            <option value="">All devices</option>
            {devices.map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
          <label className="relative min-w-44 flex-1">
            <span className="sr-only">Search events</span>
            <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-dim" aria-hidden="true" />
            <input className={`${filterInput} w-full pl-8`} placeholder="Search file, signature, device…" value={typed} onChange={(e) => setTyped(e.target.value)} />
          </label>
        </div>
      </div>
      {error && <p className="px-4 py-3 text-sm text-alert">{error}</p>}
      {events.length === 0 ? (
        <p className="px-4 py-10 text-center text-sm text-dim">No events match. They appear here the moment something happens.</p>
      ) : (
        <ol className="max-h-[560px] divide-y divide-edge overflow-y-auto">
          {events.map((e) => (
            <li key={e.id} className={fresh.has(e.id) ? "animate-event-in" : ""}>
              <button type="button" onClick={() => onOpen(e.id)} className="grid w-full grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-1 px-4 py-2.5 text-left hover:bg-raised md:grid-cols-[88px_100px_minmax(0,1fr)_170px]">
                <span className="hidden font-mono text-xs leading-6 text-dim md:block" title={formatDateTime(e.at)}>
                  {new Date(e.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                </span>
                <span className="pt-0.5"><SevPill severity={e.severity} /></span>
                <span className="min-w-0">
                  <span className="block truncate text-sm text-fg">{e.title}</span>
                  <span className="block text-xs text-dim md:hidden">{timeAgo(e.at)}{e.device ? ` · ${e.device}` : ""}</span>
                </span>
                <span className="hidden min-w-0 text-right text-xs leading-6 text-dim md:block">
                  <span className="truncate">{e.device ? `${e.device} · ` : ""}</span>
                  <span className="font-mono">{KIND_LABEL[e.kind] ?? e.kind}</span>
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

// ---- One event, in a side panel ------------------------------------------------------------

function EventDrawer({ id, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    setData(null);
    api.get(`/security/events/${id}`).then(setData).catch((err) => setError(err.message));
  }, [id]);
  useEffect(() => {
    const esc = (e) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onClose]);
  const e = data?.event;
  const v = data?.version;
  const d = e?.detail ?? {};
  const rows = e
    ? [
        ["When", formatDateTime(e.at)],
        ["Device", e.device ? `${e.device} (${e.client})` : null],
        ["File", d.path ?? v?.path],
        ["Malware", d.signature ?? v?.signature],
        ["Size", d.size != null ? formatSize(d.size) : null],
        ["SHA-256", d.sha256 ?? v?.sha256],
        ["Randomness", d.entropy != null ? `${d.entropy} bits per byte` : null],
        ["Signs", v?.reasons?.length ? v.reasons.join("; ") : null],
        ["By", d.by],
        ["From address", d.ip],
        ["Reason", d.reason],
        ["Scanned", d.scanned != null ? `${d.scanned.toLocaleString()} file(s), ${d.infected ?? 0} infected` : null],
      ].filter(([, val]) => val != null && val !== "")
    : [];

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label="Event details">
      <button type="button" aria-label="Close" className="absolute inset-0 bg-black/50" onClick={onClose} />
      <aside className="relative flex h-full w-full max-w-md animate-drawer flex-col border-l border-edge bg-solid shadow-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-edge p-5">
          <div className="min-w-0">
            {e && <SevPill severity={e.severity} />}
            <h2 className="mt-2 break-words font-display text-lg font-semibold">{e?.title ?? "Loading…"}</h2>
            {e && <p className="mt-1 font-mono text-xs text-dim">{e.kind}</p>}
          </div>
          <button type="button" onClick={onClose} className="rounded-md p-1.5 text-dim hover:bg-raised hover:text-fg" aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-5">
          {error && <p className="text-sm text-alert">{error}</p>}
          <dl className="grid grid-cols-[110px_minmax(0,1fr)] gap-x-4 gap-y-2.5 text-sm">
            {rows.map(([k, val]) => (
              <div key={k} className="contents">
                <dt className="text-dim">{k}</dt>
                <dd className={`break-all ${k === "SHA-256" || k === "Malware" || k === "File" ? "font-mono text-xs leading-5" : ""} ${k === "Malware" ? "text-sev-critical" : "text-fg"}`}>{val}</dd>
              </div>
            ))}
          </dl>
          {v && (
            <div className="mt-6 rounded-md border border-edge p-4 text-sm">
              <p className="text-dim">That file version now</p>
              <p className="mt-1 text-fg">
                {v.status === "quarantined" ? "Held in quarantine: never restored or sent off-site." : v.status === "rejected" ? "Rejected: kept as evidence only." : "Released: treated as a good version."}
              </p>
              {v.status === "quarantined" && (
                <Link to="/quarantine" className="mt-3 inline-flex text-sm text-signal hover:underline">
                  Review it in Quarantine
                </Link>
              )}
            </div>
          )}
          {e?.deviceId && (
            <Link to={`/devices/${e.deviceId}`} className="mt-4 inline-flex text-sm text-signal hover:underline">
              Open {e.device}
            </Link>
          )}
        </div>
      </aside>
    </div>
  );
}

// ---- Antivirus engine ------------------------------------------------------------------------

function EnginePanel({ engine, work, reload }) {
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
  const progress = work.total ? Math.min(100, (work.done / work.total) * 100) : 0;
  return (
    <section className="glass rounded-lg border border-edge p-5">
      <h2 className="flex items-center gap-2 font-medium">
        <Radar size={17} className="text-dim" aria-hidden="true" />
        Antivirus engine
      </h2>
      {engine.available ? (
        <dl className="mt-4 grid grid-cols-[110px_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
          <dt className="text-dim">Engine</dt>
          <dd>ClamAV {engine.engine}</dd>
          <dt className="text-dim">Signatures</dt>
          <dd>{engine.signatures ? `${engine.signatures}${engine.signaturesDate ? `, ${formatDateTime(engine.signaturesDate)}` : ""}` : "Custom set"}</dd>
          <dt className="text-dim">Address</dt>
          <dd className="break-all font-mono text-xs leading-5">{engine.address}</dd>
          <dt className="text-dim">Checked</dt>
          <dd>{engine.checkedAt ? timeAgo(engine.checkedAt) : "—"}</dd>
        </dl>
      ) : (
        <div className="mt-3 space-y-3 text-sm text-dim">
          <p>
            {engine.enabled
              ? engine.error ?? "ClamAV isn't answering."
              : "Scanning is turned off (GATEWAY_CLAMAV=off)."}{" "}
            Until it's running, files are still checked for ransomware signs, and they're scanned for malware as soon as it is.
          </p>
          {engine.enabled && (
            <div className="rounded-md border border-edge bg-night/60 p-3 font-mono text-xs leading-6 text-fg">
              <p className="text-dim"># Arch / Omarchy</p>
              <p>sudo pacman -S clamav</p>
              <p>sudo freshclam</p>
              <p>sudo systemctl enable --now clamav-freshclam clamav-daemon</p>
              <p className="mt-2 text-dim"># Debian / Ubuntu</p>
              <p>sudo apt install clamav-daemon</p>
            </div>
          )}
        </div>
      )}

      {work.running && (
        <div className="mt-5">
          <div className="flex justify-between text-xs text-dim">
            <span>{work.kind === "rescan" ? `Rescanning (${work.reason})` : "Scanning backups not scanned yet"}</span>
            <span className="tabular-nums">{work.done.toLocaleString()} / {work.total.toLocaleString()}</span>
          </div>
          <div className="mt-1.5 h-1.5 rounded-full bg-raised" role="progressbar" aria-valuenow={Math.round(progress)} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-1.5 rounded-full bg-series-scan transition-[width]" style={{ width: `${progress}%` }} />
          </div>
          {work.found > 0 && <p className="mt-1.5 text-xs text-sev-critical">{work.found} infected so far</p>}
        </div>
      )}
      {!work.running && work.backlog > 0 && (
        <p className="mt-4 text-xs text-dim">{work.backlog.toLocaleString()} backed-up file(s) are waiting to be scanned.</p>
      )}

      <div className="mt-5 flex flex-wrap gap-2">
        <button type="button" className={secondaryButton} disabled={!!busy || !engine.available} onClick={() => act("7", () => api.post("/security/rescan", { days: 7 }))}>
          <RefreshCw size={15} className={busy === "7" ? "animate-spin" : ""} />
          Rescan last 7 days
        </button>
        <button type="button" className={secondaryButton} disabled={!!busy || !engine.available} onClick={() => act("all", () => api.post("/security/rescan", { days: 0 }))}>
          Rescan everything
        </button>
        {work.running ? (
          <button type="button" className={secondaryButton} disabled={!!busy} onClick={() => act("stop", () => api.post("/security/stop"))}>
            <Square size={14} />
            Stop
          </button>
        ) : (
          <button type="button" className={secondaryButton} disabled={!!busy} onClick={() => act("check", () => api.post("/security/check"))}>
            <Activity size={15} />
            Check engine
          </button>
        )}
      </div>
      {error && <p className="mt-3 text-sm text-alert">{error}</p>}
      <p className="mt-4 text-xs text-dim">
        New signatures trigger a rescan of the last 7 days automatically, to catch malware that was too new to recognise when it arrived.
      </p>
    </section>
  );
}

// ---- Page ------------------------------------------------------------------------------------

export default function Security() {
  const [range, setRange] = useState("24h");
  const [device, setDevice] = useState("");
  const [open, setOpen] = useState(null);
  const { data: o, error, loading, reload } = usePolling(`/security/overview?range=${range}`, 5000);

  return (
    <div className="w-full">
      <PageHeader
        title="Security"
        action={
          <div className="inline-flex rounded-md border border-edge p-1" role="group" aria-label="Time range">
            {RANGES.map(([id, label]) => (
              <button key={id} type="button" aria-pressed={range === id} onClick={() => setRange(id)} className={`whitespace-nowrap rounded px-3 py-1.5 text-sm ${range === id ? "bg-signal text-signal-ink" : "text-dim hover:text-fg"}`}>
                {label}
              </button>
            ))}
          </div>
        }
      >
        Every file is scanned for malware and checked for ransomware as it arrives. Anything caught is held back, never restored or sent off-site.
      </PageHeader>

      {!o ? (
        <LoadState loading={loading} error={error} onRetry={reload} />
      ) : (
        <div className="space-y-6">
          <Posture o={o} />

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <Kpi icon={Radar} label="Files scanned" value={o.totals.scanned.toLocaleString()} sub={formatSize(o.totals.bytes)} />
            <Kpi icon={Bug} label="Malware found" value={o.totals.infected} tone={o.totals.infected ? "text-sev-critical" : "text-fg"} sub={o.totals.infected ? "held in quarantine" : "none"} />
            <Kpi icon={ShieldAlert} label="Ransomware signs" value={o.totals.suspicious} tone={o.totals.suspicious ? "text-sev-high" : "text-fg"} sub={o.frozen ? `${o.frozen} device(s) frozen` : "no device frozen"} />
            <Kpi label="Waiting in quarantine" value={o.quarantined} tone={o.quarantined ? "text-warn" : "text-fg"} sub={<Link to="/quarantine" className="hover:text-fg hover:underline">review</Link>} />
            <Kpi
              label="Scan coverage"
              value={`${pct(o.coverage.scanned, o.coverage.total - o.coverage.tooBig)}%`}
              tone={o.coverage.unscanned ? "text-warn" : "text-good"}
              sub={o.coverage.unscanned ? `${o.coverage.unscanned.toLocaleString()} not scanned yet` : `of ${o.coverage.total.toLocaleString()} new versions`}
            />
          </div>

          <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
            <section className="glass rounded-lg border border-edge p-5">
              <div className="mb-4 flex items-baseline justify-between gap-3">
                <h2 className="font-medium">Scans and events</h2>
                <span className="text-xs text-dim">{o.totals.events.toLocaleString()} event(s)</span>
              </div>
              <Timeline data={o.timeline} range={range} />
            </section>
            <section className="glass rounded-lg border border-edge p-5">
              <h2 className="mb-4 font-medium">Top detections</h2>
              <TopDetections items={o.topSignatures} />
            </section>
          </div>

          <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
            <EventFeed devices={o.devices} device={device} setDevice={setDevice} onOpen={setOpen} />
            <div className="space-y-6">
              <section className="glass rounded-lg border border-edge p-5">
                <h2 className="mb-2 font-medium">Devices by risk</h2>
                <p className="mb-2 text-xs text-dim">Click one to show only its events.</p>
                <DeviceRisk devices={o.devices} picked={device} onPick={setDevice} />
              </section>
              <EnginePanel engine={o.engine} work={o.work} reload={reload} />
            </div>
          </div>
        </div>
      )}
      {open && <EventDrawer id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
