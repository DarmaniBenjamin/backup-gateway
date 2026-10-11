// Devices, grouped by client. Shows connection status, backup activity and storage per device,
// and lets you create an enrollment code for a new device.

import { useMemo, useState } from "react";
import { Link } from "react-router";
import { Plus } from "lucide-react";
import { usePolling } from "../usePolling.js";
import { formatDateTime, formatSize, timeAgo } from "../format.js";
import PageHeader from "../components/PageHeader.jsx";
import StatusBadge from "../components/StatusBadge.jsx";
import LoadState from "../components/LoadState.jsx";
import AddDeviceModal from "../components/AddDeviceModal.jsx";
import { primaryButton } from "../components/buttons.js";

function Field({ label, children, title }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-dim md:sr-only">{label}</dt>
      <dd className="mt-0.5 truncate text-sm text-fg" title={title}>
        {children}
      </dd>
    </div>
  );
}

function DeviceRow({ d }) {
  return (
    <li className="grid gap-4 px-5 py-4 md:grid-cols-[minmax(0,1.4fr)_repeat(5,minmax(0,1fr))] md:items-center">
      <div className="flex items-start justify-between gap-3 md:block">
        <div className="min-w-0">
          <Link to={`/devices/${d.id}`} className="block truncate font-medium hover:text-signal" title="Backup folders">
            {d.name}
          </Link>
          <p className="truncate font-mono text-xs text-dim" title="Device ID">
            {d.id}
          </p>
        </div>
        <div className="md:hidden">
          <StatusBadge status={d.status} />
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4 md:contents">
        <div className="hidden md:block">
          <StatusBadge status={d.status} />
          <p className="mt-0.5 text-xs text-dim" title={formatDateTime(d.lastSeenAt)}>
            seen {timeAgo(d.lastSeenAt)}
          </p>
          {d.pausedReason && d.status === "online" && (
            <p className="mt-0.5 text-xs text-signal" title={`Backups paused: ${d.pausedReason}`}>
              Paused
            </p>
          )}
        </div>
        <Field label="Last backup" title={formatDateTime(d.lastBackupAt)}>
          {d.lastBackupAt ? timeAgo(d.lastBackupAt) : "No backups yet"}
        </Field>
        <Field label="Files">
          {(d.filesTracked ?? 0).toLocaleString()}
          {d.pendingChanges > 0 && <span className="ml-2 text-signal">{d.pendingChanges} waiting</span>}
        </Field>
        <Field label="Versions">{d.versions.toLocaleString()}</Field>
        <Field label="Stored" title={`${formatSize(d.originalBytes)} of unique data`}>
          {formatSize(d.storedBytes)}
        </Field>
      </dl>
      {d.status === "frozen" && (
        <p className="text-sm text-alert md:col-span-6">
          Frozen {timeAgo(d.frozenAt)}: {d.frozenReason}.{" "}
          <Link to="/quarantine" className="text-signal underline-offset-2 hover:underline">
            Review and unfreeze
          </Link>
        </p>
      )}
      {!d.encryptionReady && (
        <p className="text-sm text-signal md:col-span-6">
          Waiting for this device to finish setting up encryption. Start its agent.
        </p>
      )}
    </li>
  );
}

export default function Devices() {
  const { data, error, loading, reload } = usePolling("/devices", 15000);
  const [adding, setAdding] = useState(false);

  const groups = useMemo(() => {
    const map = new Map();
    for (const d of data ?? []) {
      if (!map.has(d.client)) map.set(d.client, []);
      map.get(d.client).push(d);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [data]);

  const addButton = (
    <button type="button" className={primaryButton} onClick={() => setAdding(true)}>
      <Plus size={16} aria-hidden="true" />
      Add device
    </button>
  );

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader title="Devices" action={addButton}>
        {data && `${data.length} device${data.length === 1 ? "" : "s"} across ${groups.length} client${groups.length === 1 ? "" : "s"}.`}
      </PageHeader>

      {!data ? (
        <LoadState loading={loading} error={error} onRetry={reload} />
      ) : data.length === 0 ? (
        <div className="rounded-lg border border-dashed border-edge px-6 py-12 text-center">
          <p className="font-medium">No devices yet</p>
          <p className="mx-auto mt-1 max-w-sm text-sm text-dim">
            Create an enrollment code, then start the agent on the client&rsquo;s NAS or PC with that code.
          </p>
          <div className="mt-5">{addButton}</div>
        </div>
      ) : (
        <div className="space-y-8">
          {groups.map(([client, devices]) => (
            <section key={client}>
              <h2 className="mb-3 text-lg font-medium">{client}</h2>
              <div className="overflow-hidden rounded-lg border border-edge bg-surface">
                <div className="hidden border-b border-edge px-5 py-2 text-xs text-dim md:grid md:grid-cols-[minmax(0,1.4fr)_repeat(5,minmax(0,1fr))]">
                  <span>Device</span>
                  <span>Status</span>
                  <span>Last backup</span>
                  <span>Files</span>
                  <span>Versions</span>
                  <span>Stored</span>
                </div>
                <ul className="divide-y divide-edge">
                  {devices.map((d) => (
                    <DeviceRow key={d.id} d={d} />
                  ))}
                </ul>
              </div>
            </section>
          ))}
        </div>
      )}

      {adding && (
        <AddDeviceModal
          clients={groups.map(([c]) => c)}
          onClose={() => {
            setAdding(false);
            reload();
          }}
        />
      )}
    </div>
  );
}