// Restore: pick a device, look at its backup activity, choose a moment in time, browse the
// files as they were at that moment, and restore a file, a folder or everything.

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { History } from "lucide-react";
import { api } from "../api.js";
import { usePolling } from "../usePolling.js";
import { formatDateTime, formatSize } from "../format.js";
import PageHeader from "../components/PageHeader.jsx";
import LoadState from "../components/LoadState.jsx";
import ActivityChart from "../components/ActivityChart.jsx";
import FileBrowser from "../components/FileBrowser.jsx";
import VersionsModal from "../components/VersionsModal.jsx";
import RestoreDialog from "../components/RestoreDialog.jsx";
import { primaryButton } from "../components/buttons.js";

const RANGES = [
  { key: "6h", label: "6 hours", hours: 6, bucket: 5 },
  { key: "24h", label: "24 hours", hours: 24, bucket: 15 },
  { key: "7d", label: "7 days", hours: 168, bucket: 120 },
  { key: "30d", label: "30 days", hours: 720, bucket: 720 },
];

// <input type="datetime-local"> works in local time without a time zone
function toLocalInput(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const TYPE_STYLE = { added: "text-series-change", changed: "text-series-change", deleted: "text-series-delete" };

export default function Restore() {
  const [params, setParams] = useSearchParams();
  const { data: devices, error: devicesError, loading: devicesLoading } = usePolling("/devices", 30000);

  const deviceId = params.get("device") || devices?.[0]?.id || "";
  const path = params.get("path") || "";
  const at = params.get("at") || null;
  const rangeKey = params.get("range") || "24h";
  const range = RANGES.find((r) => r.key === rangeKey) ?? RANGES[1];

  const [activity, setActivity] = useState(null);
  const [activityError, setActivityError] = useState("");
  const [versionsFor, setVersionsFor] = useState(null);
  const [restoreRequest, setRestoreRequest] = useState(null);

  function update(changes) {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(changes)) {
      if (v == null || v === "") next.delete(k);
      else next.set(k, v);
    }
    setParams(next, { replace: true });
  }

  useEffect(() => {
    if (!deviceId) return;
    setActivity(null);
    setActivityError("");
    api
      .get(`/devices/${deviceId}/activity?hours=${range.hours}&bucket=${range.bucket}`)
      .then(setActivity)
      .catch((err) => setActivityError(err.message));
  }, [deviceId, range.hours, range.bucket]);

  const device = useMemo(() => devices?.find((d) => d.id === deviceId), [devices, deviceId]);

  if (!devices) return <LoadState loading={devicesLoading} error={devicesError} />;
  if (devices.length === 0) {
    return (
      <div className="mx-auto max-w-6xl">
        <PageHeader title="Restore">No devices are enrolled yet, so there is nothing to restore.</PageHeader>
      </div>
    );
  }

  const restoreFolderLabel = path ? "Restore this folder" : "Restore all files";

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader title="Restore">Bring back a file, a folder or a whole device, from any point in time.</PageHeader>

      <div className="mb-8 max-w-sm">
        <label htmlFor="device" className="mb-1.5 block text-sm text-dim">
          Device
        </label>
        <select
          id="device"
          value={deviceId}
          onChange={(e) => update({ device: e.target.value, path: "", at: "" })}
          className="h-11 w-full rounded-md border border-edge bg-raised px-3 text-base text-fg focus:border-signal focus:outline-none sm:text-sm"
        >
          {devices.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name} ({d.client})
            </option>
          ))}
        </select>
      </div>

      {/* 1. Activity: find the moment to go back to */}
      <section className="mb-8 rounded-lg border border-edge bg-surface p-5">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-medium">Backup activity</h2>
            <p className="text-sm text-dim">A sudden tall bar is unusual. Click just before it to restore files from that moment.</p>
          </div>
          <div className="flex rounded-md border border-edge p-0.5" role="group" aria-label="Time range">
            {RANGES.map((r) => (
              <button
                key={r.key}
                type="button"
                aria-pressed={r.key === range.key}
                onClick={() => update({ range: r.key })}
                className={`h-8 rounded px-3 text-sm ${r.key === range.key ? "bg-raised text-fg" : "text-dim hover:text-fg"}`}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>

        {!activity ? (
          <LoadState loading={!activityError} error={activityError} />
        ) : (
          <ActivityChart
            buckets={activity.buckets}
            bucketMinutes={activity.bucketMinutes}
            selectedAt={at}
            onSelect={(iso) => update({ at: iso })}
          />
        )}

        <div className="mt-6 flex flex-col gap-3 border-t border-edge pt-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-sm text-dim">Restore point</p>
            <p className={`mt-0.5 text-lg font-medium ${at ? "text-signal" : "text-fg"}`}>
              {at ? formatDateTime(at) : "Latest backup"}
            </p>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-sm text-dim">
              <span className="mb-1 block">Exact time</span>
              <input
                type="datetime-local"
                value={toLocalInput(at)}
                onChange={(e) => update({ at: e.target.value ? new Date(e.target.value).toISOString() : "" })}
                className="h-10 rounded-md border border-edge bg-raised px-3 text-base text-fg [color-scheme:dark] focus:border-signal focus:outline-none sm:text-sm"
              />
            </label>
            {at && (
              <button type="button" onClick={() => update({ at: "" })} className="h-10 rounded-md px-3 text-sm text-dim hover:bg-raised hover:text-fg">
                Use latest
              </button>
            )}
          </div>
        </div>
      </section>

      {/* 2. Files as they were at the restore point */}
      <section className="mb-8">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="font-medium">Files {at ? `as of ${formatDateTime(at)}` : "in the latest backup"}</h2>
            <p className="text-sm text-dim">{device ? `${device.name}, ${device.client}` : ""}</p>
          </div>
          <button
            type="button"
            className={primaryButton}
            onClick={() => setRestoreRequest({ device: deviceId, path, at })}
          >
            <History size={16} aria-hidden="true" />
            {restoreFolderLabel}
          </button>
        </div>
        <FileBrowser
          deviceId={deviceId}
          at={at}
          path={path}
          onOpenFolder={(p) => update({ path: p })}
          onShowVersions={(p) => setVersionsFor(p)}
        />
      </section>

      {/* 3. Recent changes: the same activity as a readable list */}
      {activity && activity.recent.length > 0 && (
        <section>
          <h2 className="mb-3 font-medium">Recent changes</h2>
          <div className="overflow-x-auto rounded-lg border border-edge">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-edge text-xs text-dim">
                <tr>
                  <th className="px-4 py-2 font-normal">Backed up</th>
                  <th className="px-4 py-2 font-normal">File</th>
                  <th className="px-4 py-2 font-normal">Change</th>
                  <th className="px-4 py-2 text-right font-normal">Size</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-edge">
                {activity.recent.slice(0, 25).map((r) => (
                  <tr key={`${r.path}-${r.versionNo}`}>
                    <td className="whitespace-nowrap px-4 py-2 text-dim">{formatDateTime(r.at)}</td>
                    <td className="max-w-xs truncate px-4 py-2 font-mono text-xs">{r.path}</td>
                    <td className={`px-4 py-2 ${TYPE_STYLE[r.type]}`}>
                      {r.type} (v{r.versionNo})
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-right text-dim">{r.type === "deleted" ? "" : formatSize(r.size)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {versionsFor && (
        <VersionsModal
          deviceId={deviceId}
          path={versionsFor}
          onClose={() => setVersionsFor(null)}
          onRestore={(version) => {
            setVersionsFor(null);
            setRestoreRequest({ device: deviceId, path: versionsFor, version });
          }}
        />
      )}
      {restoreRequest && <RestoreDialog request={restoreRequest} devices={devices} onClose={() => setRestoreRequest(null)} />}
    </div>
  );
}