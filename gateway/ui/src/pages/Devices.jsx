// Devices, grouped by client. Shows connection status, backup activity and storage per device,
// and lets you create an enrollment code for a new device. Removed devices (uninstalled, or cut
// off) are listed apart at the bottom, where they can be deleted for good, by hand or by
// themselves some days after they were removed.

import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { ChevronDown, Plus, Trash2 } from "lucide-react";
import { usePolling } from "../usePolling.js";
import { formatDateTime, formatSize, timeAgo } from "../format.js";
import PageHeader from "../components/PageHeader.jsx";
import StatusBadge from "../components/StatusBadge.jsx";
import LoadState from "../components/LoadState.jsx";
import AddDeviceModal from "../components/AddDeviceModal.jsx";
import { UpdateLine, UpdatesBar, useUpdates } from "../components/AgentUpdates.jsx";
import { Confirm, DeleteText } from "../components/DeviceService.jsx";
import { inputClass, primaryButton, secondaryButton } from "../components/buttons.js";
import { api } from "../api.js";

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

function DeviceRow({ d, update, gatewayVersion }) {
  return (
    <li className="grid gap-4 px-5 py-4 md:grid-cols-[minmax(0,1.4fr)_repeat(5,minmax(0,1fr))] md:items-center">
      <div className="flex items-start justify-between gap-3 md:block">
        <div className="min-w-0">
          <Link to={`/devices/${d.id}`} className="-my-1.5 block truncate py-1.5 font-medium hover:text-signal" title="Backup folders">
            {d.name}
          </Link>
          <p className="truncate font-mono text-xs text-secure/70" title="Device ID">
            {d.id}
          </p>
          {update && (
            <p className="mt-0.5 truncate">
              <UpdateLine u={update} gatewayVersion={gatewayVersion} />
            </p>
          )}
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
            <p className="mt-0.5 text-xs text-warn" title={`Backups paused: ${d.pausedReason}`}>
              Paused
            </p>
          )}
        </div>
        <Field label="Last backup" title={formatDateTime(d.lastBackupAt)}>
          {d.lastBackupAt ? timeAgo(d.lastBackupAt) : "No backups yet"}
        </Field>
        <Field label="Files">
          {(d.filesTracked ?? 0).toLocaleString()}
          {d.pendingChanges > 0 && <span className="ml-2 text-warn">{d.pendingChanges} waiting</span>}
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
        <p className="text-sm text-warn md:col-span-6">
          Waiting for this device to finish setting up encryption. Start its agent.
        </p>
      )}
    </li>
  );
}

const dayText = (iso) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
const daysLabel = (n) => (n === 0 ? "Never" : n % 365 === 0 ? `${n / 365} year${n === 365 ? "" : "s"} after it's removed` : `${n} days after it's removed`);

// What happens to a removed device's backups, in a few words
export function autoDeleteText(a) {
  if (!a?.days) return null;
  if (a.keep) return "kept: not deleted automatically";
  return a.at ? `deleted automatically on ${dayText(a.at)}` : null;
}

// Removed devices' backups deleted by themselves after some days (or never)
function AutoDeleteSetting({ onChanged }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    api.get("/removed-devices/auto-delete").then(setData, (err) => setError(err.message));
  }, []);
  if (!data) return error ? <p className="px-5 py-3 text-sm text-warn">{error}</p> : null;
  return (
    <div className="flex flex-col gap-2 border-b border-edge px-5 py-3 text-sm md:flex-row md:items-center md:justify-between">
      <label htmlFor="auto-delete" className="text-dim">
        Delete a removed device and its backups
      </label>
      <div className="w-full md:w-64">
        <select
          id="auto-delete"
          className={inputClass}
          value={data.days}
          disabled={saving}
          onChange={async (e) => {
            setSaving(true);
            setError("");
            try {
              setData(await api.post("/removed-devices/auto-delete", { days: Number(e.target.value) }));
              onChanged();
            } catch (err) {
              setError(err.message);
            } finally {
              setSaving(false);
            }
          }}
        >
          {data.choices.map((n) => (
            <option key={n} value={n}>
              {daysLabel(n)}
            </option>
          ))}
        </select>
      </div>
      {error && <p className="text-warn">{error}</p>}
    </div>
  );
}

// Removed devices: out of the way, still restorable until deleted for good
function RemovedDevices({ devices, reload }) {
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState(null);
  return (
    <section>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex items-center gap-2 text-sm text-dim hover:text-fg"
      >
        <ChevronDown size={16} className={`transition-transform ${open ? "" : "-rotate-90"}`} aria-hidden="true" />
        {devices.length} removed device{devices.length === 1 ? "" : "s"}
      </button>
      {open && (
        <div className="mt-3 overflow-hidden rounded-lg border border-edge">
          <p className="border-b border-edge px-5 py-3 text-sm text-dim">
            They can&rsquo;t connect any more. Their backups can be restored to another device until they&rsquo;re deleted for good: by you, or
            by themselves after the number of days below (an alert goes out 3 days before). Copies already in the cloud stay until their lock
            runs out.
          </p>
          <AutoDeleteSetting onChanged={reload} />
          <ul className="divide-y divide-edge">
            {devices.map((d) => (
              <li key={d.id} className="flex flex-col gap-3 px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0 text-sm">
                  <Link to={`/devices/${d.id}`} className="-my-2 inline-block py-2 text-fg hover:text-signal hover:underline">
                    {d.name}
                  </Link>
                  <p className="text-xs text-dim">
                    {d.client}, {d.uninstalled ? "agent uninstalled" : "removed"}
                    {d.removedAt ? ` ${timeAgo(d.removedAt)}` : ""}, {formatSize(d.storedBytes)} of backups kept
                  </p>
                  {autoDeleteText(d.autoDelete) && (
                    <p className={`text-xs ${d.autoDelete.keep ? "text-dim" : "text-warn"}`}>Backups {autoDeleteText(d.autoDelete)}</p>
                  )}
                </div>
                <button type="button" className={`${secondaryButton} h-9 px-3`} onClick={() => setDeleting(d)}>
                  <Trash2 size={14} />
                  Delete for good
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {deleting && (
        <Confirm
          deviceName={deleting.name}
          title={`Delete ${deleting.name} for good?`}
          action="Delete device and backups"
          path={`/devices/${deleting.id}/delete`}
          onClose={() => setDeleting(null)}
          onDone={() => {
            setDeleting(null);
            reload();
          }}
        >
          <DeleteText storedBytes={deleting.storedBytes} />
        </Confirm>
      )}
    </section>
  );
}

export default function Devices() {
  const { data, error, loading, reload } = usePolling("/devices", 15000);
  const [adding, setAdding] = useState(false);
  const { data: updates, reload: reloadUpdates } = useUpdates();
  const updateOf = useMemo(() => new Map((updates?.devices ?? []).map((u) => [u.id, u])), [updates]);

  const active = useMemo(() => (data ?? []).filter((d) => d.status !== "revoked"), [data]);
  const removed = useMemo(() => (data ?? []).filter((d) => d.status === "revoked"), [data]);
  const groups = useMemo(() => {
    const map = new Map();
    for (const d of active) {
      if (!map.has(d.client)) map.set(d.client, []);
      map.get(d.client).push(d);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [active]);

  const addButton = (
    <button type="button" className={primaryButton} onClick={() => setAdding(true)}>
      <Plus size={16} aria-hidden="true" />
      Add device
    </button>
  );

  return (
    <div className="w-full">
      <PageHeader title="Devices" action={addButton}>
        {data && `${active.length} device${active.length === 1 ? "" : "s"} across ${groups.length} client${groups.length === 1 ? "" : "s"}.`}
      </PageHeader>

      {!data ? (
        <LoadState loading={loading} error={error} onRetry={reload} />
      ) : active.length === 0 && removed.length === 0 ? (
        <div className="rounded-lg border border-dashed border-edge px-6 py-12 text-center">
          <p className="font-medium">No devices yet</p>
          <p className="mx-auto mt-1 max-w-sm text-sm text-dim">
            Click Add device, pick the kind of device, and paste the one command it gives you on that device.
          </p>
          <div className="mt-5">{addButton}</div>
        </div>
      ) : (
        <div className="space-y-8">
          <UpdatesBar data={updates} reload={reloadUpdates} />
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
                    <DeviceRow key={d.id} d={d} update={updateOf.get(d.id)} gatewayVersion={updates?.version} />
                  ))}
                </ul>
              </div>
            </section>
          ))}
          {removed.length > 0 && <RemovedDevices devices={removed} reload={reload} />}
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