// Overview: is every device protected? A status card with the donut answers that at a glance,
// tiles give the key numbers, every device has its own card with 24 hours of activity, and the
// right column shows live events (alerts, restores, integrity checks) and storage.

import { Link, useOutletContext } from "react-router";
import { LockKeyhole } from "lucide-react";
import { usePolling } from "../usePolling.js";
import { formatDateTime, formatSize, timeAgo } from "../format.js";
import LoadState from "../components/LoadState.jsx";
import StatusDonut from "../components/StatusDonut.jsx";

// What a device's state means for protection, and its colour
const STATES = {
  protected: { label: "Protected", color: "var(--color-good)", text: "text-good" },
  paused: { label: "Paused", color: "var(--color-warn)", text: "text-warn" },
  frozen: { label: "Frozen", color: "var(--color-alert)", text: "text-alert" },
  offline: { label: "Offline", color: "var(--color-alert)", text: "text-alert" },
  never: { label: "Never connected", color: "var(--color-dim)", text: "text-dim" },
};

function stateOf(d) {
  if (d.status === "frozen") return "frozen";
  if (d.status === "offline") return "offline";
  if (d.status === "never-seen" || d.status === "revoked") return "never";
  if (d.pausedReason) return "paused";
  return "protected";
}

const plural = (n, one, many) => (n === 1 ? one : many);
const link = "text-signal underline-offset-2 hover:underline";

function StatusCard({ data, counts }) {
  const { total, frozen } = data.devices;
  const offline = counts.offline;
  const lastBackup = data.deviceList.map((d) => d.lastBackupAt).filter(Boolean).sort().pop();

  // Most urgent first: a frozen device (possible attack) > files held for review > offline > all good
  let text;
  let tone = "text-fg";
  if (total === 0) text = "No devices yet";
  else if (frozen > 0) {
    tone = "text-alert";
    text = `${frozen} ${plural(frozen, "device needs", "devices need")} you`;
  } else if (data.quarantined > 0) {
    tone = "text-warn";
    text = `${data.quarantined} ${plural(data.quarantined, "file is", "files are")} waiting for review`;
  } else if (offline > 0) {
    tone = "text-alert";
    text = `${offline} of ${total} ${plural(total, "device is", "devices are")} offline`;
  } else {
    tone = "text-good";
    text = total === 1 ? "Your device is protected" : `All ${total} devices are protected`;
  }

  let detail;
  if (total === 0) {
    detail = (
      <>
        Add your first device from the <Link to="/devices" className={link}>Devices</Link> page.
      </>
    );
  } else if (frozen > 0 || data.quarantined > 0) {
    detail = (
      <>
        {frozen > 0
          ? "Suspicious changes were caught and held back. Your good versions are safe and can be restored. "
          : "The quarantine engine held back suspicious changes. "}
        <Link to="/quarantine" className={link}>Review the quarantine</Link>.
      </>
    );
  } else {
    detail = (
      <>
        Last backup {timeAgo(lastBackup)}.{" "}
        {data.pendingChanges > 0
          ? `${data.pendingChanges} ${plural(data.pendingChanges, "change is", "changes are")} waiting to be sent.`
          : "Nothing is waiting to be sent."}
      </>
    );
  }

  const parts = Object.entries(STATES).map(([key, s]) => ({ key, value: counts[key], color: s.color, label: s.label }));

  return (
    <section className="glass flex flex-col gap-6 rounded-lg border border-edge p-6 sm:flex-row sm:items-center sm:justify-between sm:p-7">
      <div className="min-w-0">
        <h1 className={`text-3xl font-semibold sm:text-[34px] sm:leading-tight ${tone}`}>{text}</h1>
        <p className="mt-2 max-w-xl text-dim">{detail}</p>
        <ul className="mt-5 flex flex-wrap gap-x-5 gap-y-2 text-sm">
          {parts
            .filter((p) => p.value > 0)
            .map((p) => (
              <li key={p.key} className="flex items-center gap-2 text-dim">
                <span className="h-2.5 w-2.5 rounded-sm" style={{ background: p.color }} aria-hidden="true" />
                {p.label}
                <span className="font-semibold text-fg tabular-nums">{p.value}</span>
              </li>
            ))}
        </ul>
      </div>
      {total > 0 && <StatusDonut parts={parts} />}
    </section>
  );
}

function Tile({ value, label, tone = "text-fg", to }) {
  const body = (
    <>
      <p className={`font-display text-2xl font-semibold tabular-nums ${tone}`}>{value}</p>
      <p className="mt-1 text-sm text-dim">{label}</p>
    </>
  );
  const cls = "glass block rounded-lg border border-edge px-5 py-4";
  return to ? (
    <Link to={to} className={`${cls} hover:border-signal/40`}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

function Tiles({ data, counts }) {
  const v = data.lastVerify;
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Tile value={`${counts.protected}/${data.devices.total}`} label="Devices protected" tone="text-good" to="/devices" />
      <Tile
        value={data.quarantined.toLocaleString()}
        label="Files in quarantine"
        tone={data.quarantined ? "text-warn" : "text-fg"}
        to="/quarantine"
      />
      <Tile value={formatSize(data.storage.storedBytes)} label="Encrypted and stored" tone="text-secure" />
      <Tile
        value={!v ? "Not run" : v.damaged ? `${v.damaged} damaged` : "100%"}
        label={v ? `Chunks verified ${timeAgo(v.checkedAt)}` : "Integrity check"}
        tone={!v ? "text-dim" : v.damaged ? "text-alert" : "text-good"}
        to="/integrity"
      />
    </div>
  );
}

function DeviceCard({ d }) {
  const state = STATES[stateOf(d)];
  const max = Math.max(1, ...d.activity.map((a) => a.ok + a.held));
  return (
    <Link
      to={`/devices/${d.id}`}
      className="glass group relative block overflow-hidden rounded-lg border border-edge p-4 pl-5 hover:border-signal/40"
    >
      <span className="absolute inset-y-0 left-0 w-1" style={{ background: state.color }} aria-hidden="true" />
      <p className="truncate font-display font-semibold group-hover:text-signal">{d.name}</p>
      <p className="truncate text-xs text-dim">{d.client}</p>
      <p className={`mt-2.5 flex items-center gap-2 text-xs ${state.text}`}>
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: state.color }} aria-hidden="true" />
        {state.label}
        {d.pausedReason && stateOf(d) === "paused" && <span className="truncate text-dim">· {d.pausedReason}</span>}
      </p>
      {/* 24 hours of changes in 2-hour slots: amber where changes were held back */}
      <div className="mt-3 flex h-9 items-end gap-0.5" aria-label="Changes in the last 24 hours" role="img">
        {d.activity.map((a, i) => (
          <div key={i} className="flex h-full flex-1 flex-col justify-end gap-px">
            {a.held > 0 && <span className="rounded-[1px] bg-warn/70" style={{ height: `${(a.held / max) * 100}%` }} />}
            <span
              className="rounded-[1px]"
              style={{ height: `${Math.max(a.ok ? 6 : 3, (a.ok / max) * 100)}%`, background: state.color, opacity: a.ok ? 0.45 : 0.12 }}
            />
          </div>
        ))}
      </div>
      <div className="mt-2.5 flex justify-between text-xs text-dim">
        <span title={formatDateTime(d.lastBackupAt)}>{d.lastBackupAt ? timeAgo(d.lastBackupAt) : "No backups yet"}</span>
        <span>{(d.filesTracked ?? 0).toLocaleString()} files</span>
      </div>
    </Link>
  );
}

// Alerts, restores and integrity checks, newest first
function LiveEvents({ alerts, jobs, lastVerify }) {
  const events = [];
  for (const a of alerts ?? []) {
    events.push({
      at: a.createdAt,
      color: a.kind === "frozen" ? "var(--color-alert)" : "var(--color-warn)",
      text: a.message,
      dim: !!a.acknowledgedAt,
    });
  }
  for (const j of jobs) {
    const color = { done: "var(--color-good)", failed: "var(--color-alert)" }[j.status] ?? "var(--color-signal)";
    const what = j.status === "done" ? `Restore #${j.id} finished: ${j.result?.restored ?? j.fileCount} files` : `Restore #${j.id} ${j.status}`;
    events.push({ at: j.finishedAt ?? j.createdAt, color, text: `${what} on ${j.device}` });
  }
  if (lastVerify) {
    events.push({
      at: lastVerify.checkedAt,
      color: lastVerify.damaged ? "var(--color-alert)" : "var(--color-secure)",
      text: lastVerify.damaged
        ? `Integrity check: ${lastVerify.damaged} damaged chunks`
        : `Integrity check: ${lastVerify.checked.toLocaleString()} chunks verified`,
    });
  }
  events.sort((a, b) => new Date(b.at) - new Date(a.at));

  return (
    <section className="glass rounded-lg border border-edge p-5">
      <h2 className="font-semibold">Live events</h2>
      {events.length === 0 ? (
        <p className="mt-3 text-sm text-dim">Nothing has happened yet.</p>
      ) : (
        <ul className="mt-2 divide-y divide-edge">
          {events.slice(0, 8).map((e, i) => (
            <li key={i} className={`flex gap-3 py-3 text-sm ${e.dim ? "opacity-60" : ""}`}>
              <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full" style={{ background: e.color }} aria-hidden="true" />
              <div className="min-w-0">
                <p className="text-fg">{e.text}</p>
                <p className="text-xs text-dim" title={formatDateTime(e.at)}>
                  {timeAgo(e.at)}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Storage({ storage, files, versions }) {
  const { originalBytes, storedBytes } = storage;
  const saved = originalBytes > 0 ? Math.max(0, 1 - storedBytes / originalBytes) : 0;
  return (
    <section className="glass rounded-lg border border-edge p-5">
      <h2 className="font-semibold">Storage</h2>
      <p className="mt-3 font-display text-2xl font-semibold">{formatSize(storedBytes)}</p>
      <p className="text-sm text-dim">stored for {formatSize(originalBytes)} of unique data</p>
      <div className="mt-4 h-2 overflow-hidden rounded-full bg-raised" aria-hidden="true">
        <div
          className="h-full rounded-full bg-linear-to-r from-signal to-secure"
          style={{ width: `${Math.max(2, (1 - saved) * 100)}%` }}
        />
      </div>
      <p className="mt-2 text-sm text-dim">
        {saved > 0.005 ? `${Math.round(saved * 100)}% saved by compression and deduplication.` : "Nothing compressible yet."}
      </p>
      <p className="mt-3 flex items-center gap-2 text-sm text-secure">
        <LockKeyhole size={14} aria-hidden="true" />
        Encrypted on the device with AES-256-GCM
      </p>
      <dl className="mt-4 grid grid-cols-2 gap-4 border-t border-edge pt-4 text-sm">
        <div>
          <dt className="text-dim">Files</dt>
          <dd className="mt-0.5 font-semibold">{files.toLocaleString()}</dd>
        </div>
        <div>
          <dt className="text-dim">Versions kept</dt>
          <dd className="mt-0.5 font-semibold">{versions.toLocaleString()}</dd>
        </div>
      </dl>
    </section>
  );
}

export default function Overview() {
  const { alerts } = useOutletContext();
  const { data, error, loading, reload } = usePolling("/overview", 15000);
  if (!data) return <LoadState loading={loading} error={error} onRetry={reload} />;

  const counts = { protected: 0, paused: 0, frozen: 0, offline: 0, never: 0 };
  for (const d of data.deviceList) counts[stateOf(d)]++;

  // Most urgent devices first
  const order = ["frozen", "offline", "paused", "protected", "never"];
  const devices = [...data.deviceList].sort((a, b) => order.indexOf(stateOf(a)) - order.indexOf(stateOf(b)));

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
      <div className="min-w-0 space-y-6">
        <StatusCard data={data} counts={counts} />
        <Tiles data={data} counts={counts} />
        <section>
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="font-semibold">Devices</h2>
            <Link to="/devices" className="text-sm text-signal hover:underline">
              Manage devices
            </Link>
          </div>
          {devices.length === 0 ? (
            <p className="text-sm text-dim">No devices enrolled.</p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {devices.map((d) => (
                <DeviceCard key={d.id} d={d} />
              ))}
            </div>
          )}
        </section>
      </div>
      <aside className="space-y-6">
        <LiveEvents alerts={alerts} jobs={data.recentJobs} lastVerify={data.lastVerify} />
        <Storage storage={data.storage} files={data.files} versions={data.versions} />
      </aside>
    </div>
  );
}
