// Overview: is everything being backed up? Answers that in one sentence at the top, then shows
// each device, storage use, the last integrity check and recent restore jobs.

import { Link } from "react-router";
import { usePolling } from "../usePolling.js";
import { formatDateTime, formatSize, timeAgo } from "../format.js";
import StatusBadge from "../components/StatusBadge.jsx";
import LoadState from "../components/LoadState.jsx";

function Headline({ data }) {
  const { total, online, frozen } = data.devices;
  const offline = total - online;
  const lastBackup = data.deviceList.map((d) => d.lastBackupAt).filter(Boolean).sort().pop();
  const plural = (n, one, many) => (n === 1 ? one : many);

  // Most urgent first: a frozen device (possible attack) > files held for review > offline devices
  let text;
  let tone = "text-fg";
  if (total === 0) text = "No devices yet.";
  else if (frozen > 0) {
    tone = "text-alert";
    text = `${frozen} ${plural(frozen, "device is", "devices are")} frozen.`;
  } else if (data.quarantined > 0) {
    tone = "text-series-quarantine";
    text = `${data.quarantined} ${plural(data.quarantined, "file is", "files are")} waiting for review.`;
  } else if (offline === 0) text = total === 1 ? "Your device is online." : `All ${total} devices are online.`;
  else {
    tone = "text-alert";
    text = offline === 1 ? `1 of ${total} devices is offline.` : `${offline} of ${total} devices are offline.`;
  }

  const link = "text-signal underline-offset-2 hover:underline";
  return (
    <div className="mb-10">
      <h1 className={`text-3xl font-semibold tracking-tight sm:text-4xl ${tone}`}>{text}</h1>
      <p className="mt-3 text-dim">
        {total === 0 ? (
          <>
            Add your first device from the <Link to="/devices" className={link}>Devices</Link> page.
          </>
        ) : frozen > 0 || data.quarantined > 0 ? (
          <>
            {frozen > 0
              ? "Suspicious changes were caught and held back. Your good versions are safe and can be restored. "
              : "The quarantine engine held back suspicious changes. "}
            <Link to="/quarantine" className={link}>Review the quarantine</Link>
            {offline > 0 && `. ${offline} of ${total} devices ${plural(offline, "is", "are")} offline`}.
          </>
        ) : (
          <>
            Last backup {timeAgo(lastBackup)}.{" "}
            {data.pendingChanges > 0
              ? `${data.pendingChanges} change${data.pendingChanges === 1 ? " is" : "s are"} waiting to be sent.`
              : "Nothing is waiting to be sent."}
          </>
        )}
      </p>
    </div>
  );
}

function Section({ title, link, children }) {
  return (
    <section className="rounded-lg border border-edge bg-surface">
      <div className="flex items-center justify-between border-b border-edge px-5 py-3">
        <h2 className="text-sm font-medium">{title}</h2>
        {link}
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
}

function Storage({ storage, files, versions }) {
  const { originalBytes, storedBytes } = storage;
  const saved = originalBytes > 0 ? Math.max(0, 1 - storedBytes / originalBytes) : 0;
  return (
    <Section title="Storage">
      <p className="text-2xl font-semibold">{formatSize(storedBytes)}</p>
      <p className="mt-1 text-sm text-dim">
        stored for {formatSize(originalBytes)} of unique data
      </p>
      <div className="mt-4 h-2 overflow-hidden rounded-full bg-raised" aria-hidden="true">
        <div className="h-full rounded-full bg-good" style={{ width: `${Math.max(2, (1 - saved) * 100)}%` }} />
      </div>
      <p className="mt-2 text-sm text-dim">
        {saved > 0.005 ? `${Math.round(saved * 100)}% saved by compression and deduplication.` : "Nothing compressible yet."}
      </p>
      <dl className="mt-5 grid grid-cols-2 gap-4 border-t border-edge pt-4 text-sm">
        <div>
          <dt className="text-dim">Files</dt>
          <dd className="mt-0.5 text-fg">{files.toLocaleString()}</dd>
        </div>
        <div>
          <dt className="text-dim">Versions kept</dt>
          <dd className="mt-0.5 text-fg">{versions.toLocaleString()}</dd>
        </div>
      </dl>
    </Section>
  );
}

function Integrity({ lastVerify }) {
  let body;
  if (!lastVerify) {
    body = <p className="text-sm text-dim">No integrity check has been run yet.</p>;
  } else if (lastVerify.damaged === 0) {
    body = (
      <p className="text-sm">
        <span className="text-good">All {lastVerify.checked.toLocaleString()} chunks are readable.</span>{" "}
        <span className="text-dim">Checked {timeAgo(lastVerify.checkedAt)}.</span>
      </p>
    );
  } else {
    body = (
      <p className="text-sm">
        <span className="text-alert">
          {lastVerify.damaged} of {lastVerify.checked.toLocaleString()} chunks were damaged.
        </span>{" "}
        <span className="text-dim">Checked {timeAgo(lastVerify.checkedAt)}.</span>
      </p>
    );
  }
  return (
    <Section
      title="Integrity"
      link={<Link to="/integrity" className="text-sm text-signal hover:underline">Run a check</Link>}
    >
      {body}
    </Section>
  );
}

const JOB_STATUS = {
  queued: "text-dim",
  running: "text-signal",
  done: "text-good",
  failed: "text-alert",
  cancelled: "text-dim",
};

function RecentJobs({ jobs }) {
  return (
    <Section title="Recent restores" link={<Link to="/jobs" className="text-sm text-signal hover:underline">All jobs</Link>}>
      {jobs.length === 0 ? (
        <p className="text-sm text-dim">No restores yet.</p>
      ) : (
        <ul className="space-y-3">
          {jobs.map((j) => (
            <li key={j.id} className="text-sm">
              <p className="truncate text-fg" title={j.label}>
                {j.label}
              </p>
              <p className="mt-0.5 text-dim">
                <span className={JOB_STATUS[j.status]}>{j.status}</span> on {j.device}, {timeAgo(j.createdAt)}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function DeviceRows({ devices }) {
  return (
    <Section
      title="Devices"
      link={<Link to="/devices" className="text-sm text-signal hover:underline">Manage</Link>}
    >
      {devices.length === 0 ? (
        <p className="text-sm text-dim">No devices enrolled.</p>
      ) : (
        <ul className="-my-3 divide-y divide-edge">
          {devices.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 py-3">
              <div className="min-w-0">
                <p className="truncate font-medium">{d.name}</p>
                <p className="truncate text-sm text-dim">{d.client}</p>
              </div>
              <div className="flex items-center gap-6 text-sm">
                <span className="text-dim" title={formatDateTime(d.lastBackupAt)}>
                  {d.lastBackupAt ? `Backed up ${timeAgo(d.lastBackupAt)}` : "No backups yet"}
                </span>
                <StatusBadge status={d.status} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

export default function Overview() {
  const { data, error, loading, reload } = usePolling("/overview", 15000);
  if (!data) return <LoadState loading={loading} error={error} onRetry={reload} />;

  return (
    <div className="mx-auto max-w-6xl">
      <Headline data={data} />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <DeviceRows devices={data.deviceList} />
        </div>
        <div className="space-y-6">
          <Storage storage={data.storage} files={data.files} versions={data.versions} />
          <Integrity lastVerify={data.lastVerify} />
          <RecentJobs jobs={data.recentJobs} />
        </div>
      </div>
    </div>
  );
}